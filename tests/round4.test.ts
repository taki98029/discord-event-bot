// 2026-10-11 4 巡目: 3 巡目の修正（b523386・cb9e7e1）の回帰と、字数・中止・別サーバーまわりの疑い。
// 1〜3 巡目（oneoff-*・round3-regressions）の場面は繰り返さない。ヘルパーはそれらから写した。
// it.fails は確認済みの不具合（// 修正済み 2026-10-11: に理由）。直したら it に戻す。
// 「// 要判断:」の it は現状の挙動を記録したもので、仕様の判断待ち（直すなら期待値を変える）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import { handleAdmin } from '../src/admin';
import { handleInteraction } from '../src/interactions/index';
import { createSegment } from '../src/db/segments';
import { answerReminderDue } from '../src/planning/cron';
import { deliverPending } from '../src/planning/delivery';

const db = env.DB;
const E = { ...env, ADMIN_TOKEN: 'round4', MOCK_DISCORD: '1', DISCORD_BOT_TOKEN: 'dummy' } as Env;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const call = (method: string, path: string, body?: unknown) =>
  handleAdmin(
    new Request(`https://test.invalid/api/admin${path}`, {
      method,
      headers: { Authorization: 'Bearer round4', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    E,
  );

/** JST の壁時計で現在時刻を固定する */
const at = (date: string, hhmm: string) => {
  const [y, m, d] = date.split('/').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.UTC(y, m - 1, d, h - 9, mi));
};

async function segment(members: string[] = [], name = (id: string) => `名${id}`, role: string | null = null) {
  const s = await createSegment(db, { guild_id: '1001', name: `区分${Math.random()}`, mention_role_id: role });
  for (const id of members) {
    await db.batch([
      db.prepare('INSERT OR IGNORE INTO members(user_id,user_name,display_name) VALUES(?,?,?)').bind(id, `u${id}`, name(id)),
      db.prepare("INSERT INTO segment_members(segment_id,user_id,status) VALUES(?,?,'')").bind(s.id, id),
    ]);
  }
  return s;
}

async function template(segUuid: string, extra: Record<string, unknown>) {
  const res = await call('POST', '/notifications', {
    guild_id: '1001', segment_uuid: segUuid, name: '会', channel_id: '2001', message_title: '募集',
    start_time: '20:00', send_hour: 21, recruit_days_before: 7, remind_start_days: 3, remind_undecided_days: 1, ...extra,
  });
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
  return (await res.json()) as any;
}
async function occurrence(n: any, body: Record<string, unknown>) {
  const o = await call('POST', `/notifications/${n.uuid}/occurrences`, body);
  expect(o.status, JSON.stringify(await o.clone().json())).toBe(201);
  return (await o.json()) as any;
}

function captureSends() {
  const sent: { to: string; content: string }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      const b = JSON.parse(String(init?.body ?? '{}'));
      if (u.endsWith('/users/@me/channels')) return Response.json({ id: `dm-${b.recipient_id}` });
      const m = u.match(/\/channels\/([^/]+)\/messages/);
      if (m) sent.push({ to: m[1], content: b.content });
      return Response.json({ id: 'm' });
    }),
  );
  return { take: () => sent.splice(0) };
}

// ---- Discord ボタン（署名して公開入口を通す）----
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
let keyPair: Promise<{ pub: string; priv: CryptoKey }> | null = null;
const keys = () =>
  (keyPair ??= (async () => {
    const p = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    return { pub: hex(new Uint8Array((await crypto.subtle.exportKey('raw', p.publicKey)) as ArrayBuffer)), priv: p.privateKey };
  })());
async function press(customId: string, userId: string, guild: string | null = '1001') {
  const { pub, priv } = await keys();
  const user = { id: userId, username: `u${userId}` };
  const body = JSON.stringify({
    type: 3, application_id: 'app', token: 'tok', data: { custom_id: customId },
    ...(guild ? { guild_id: guild, member: { user, roles: [] } } : { user }),
  });
  const ts = '1700000000';
  const sig = hex(new Uint8Array(await crypto.subtle.sign('Ed25519', priv, new TextEncoder().encode(ts + body))));
  const tasks: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => tasks.push(p) } as unknown as ExecutionContext;
  let reply = '';
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).includes('/webhooks/')) reply = JSON.parse(String(init?.body ?? '{}')).content ?? '';
    return Response.json({ id: 'm' });
  }) as typeof fetch;
  try {
    await handleInteraction(
      new Request('https://test.invalid/interactions', { method: 'POST', headers: { 'x-signature-ed25519': sig, 'x-signature-timestamp': ts }, body }),
      { ...E, DISCORD_PUBLIC_KEY: pub } as Env,
      ctx,
    );
    while (tasks.length) await tasks.shift();
  } finally {
    globalThis.fetch = orig;
  }
  return reply;
}
const answer = (oid: number, uid: string, status: string) =>
  db.prepare("INSERT INTO responses(occurrence_id,user_id,user_name,status,updated_at) VALUES(?,?,?,?,'x')").bind(oid, uid, `u${uid}`, status).run();
const ids = (n: number, base: bigint) => Array.from({ length: n }, (_, i) => String(base + BigInt(i)));

// =============================================================================
describe('募集の本文: 開催回の補足（最大 500 字）を足すと 2000 字を超える（疑い 1）', () => {
  const LONG = { message_title: '見'.repeat(100), message_body: '本'.repeat(1500) };
  const DEADLINE_LINE = /\n回答締切: \*\*\d{4}\/\d\d\/\d\d \d\d:\d\d\*\*$/;

  // 修正済み 2026-10-11: composeChannelPost（src/cron/tick.ts:153）は本文の長さからメンションの予算だけを逆算し、見出し 100＋本文 1500＋補足 500＋日時行が
  // 2000 字を超えても何も削らない。最後に postMessage（src/discord/rest.ts:177）が末尾を切って「…」を付けるので、
  // 末尾にある日時・回答締切の行が募集から消える（ログに warn が出るだけで送信は成功扱い）。補足は登録時に 500 字で切るだけ（src/admin/index.ts:818）。
  it('定期の臨時回: 見出し 100・本文 1500・補足 500 でも日時と回答締切の行が残る', async () => {
    const s = await segment(['3001']);
    const n = await template(s.uuid, { ...LONG, rrule: 'FREQ=WEEKLY;BYDAY=SA', response_deadline_hours: 2 });
    at('2099/01/01', '10:00');
    const occ = await occurrence(n, { date: '2099/01/14', start_time: '20:00', note: '補'.repeat(500) });
    const cap = captureSends();
    expect((await call('POST', `/occurrences/${occ.uuid}/recruit`)).status).toBe(200);
    const [post] = cap.take();
    expect(post.content.length).toBeLessThanOrEqual(2000);
    expect(post.content).toMatch(DEADLINE_LINE);
  });

  // 修正済み 2026-10-11: 同じ原因（不定期の開催回）。ロールメンションの接頭辞（buildMentionPrefix の 'role'）は予算を見ないので、さらに長くなる。
  it('不定期の開催回・ロールメンション: 補足 500 でも日時と回答締切の行が残る', async () => {
    const s = await segment(['3001'], undefined, '123456789012345678');
    const n = await template(s.uuid, { ...LONG, rrule: null, mention_mode: 'role' });
    at('2099/01/01', '10:00');
    const occ = await occurrence(n, { date: '2099/01/14', start_time: '20:00', response_deadline_hours: 2, note: '補'.repeat(500) });
    const cap = captureSends();
    expect((await call('POST', `/occurrences/${occ.uuid}/recruit`)).status).toBe(200);
    const [post] = cap.take();
    expect(post.content).toMatch(DEADLINE_LINE);
  });
});

// =============================================================================
describe('メンバー配置の発表（疑い 2）', () => {
  async function oneoffWithGrouping(participants: string[]) {
    const s = await segment(participants);
    const n = await template(s.uuid, { type: 'oneoff', recruit_days_before: 3 });
    const occ = await occurrence(n, { date: '2099/01/10', start_time: '20:00' });
    for (const u of participants) await answer(occ.id, u, '参加');
    expect((await call('PUT', `/occurrences/${occ.uuid}/grouping`, { group_count: 2 })).status).toBe(200);
    return { n, occ };
  }

  // 修正済み 2026-10-11: 発表（src/admin/index.ts:1171-1216）は全員を 1 通に並べ、2000 字を超えると postMessage が末尾を切って「…」にする。
  // それでも ok:true を返し、画面には切れていない content を返すので、管理者は欠けた発表に気づけない（未割り当て・後ろのグループの人が載らない）。
  it('参加者 150 人の発表は欠けずに届くか、届かないなら失敗を返す', async () => {
    const { occ } = await oneoffWithGrouping(ids(150, 400000000000000000n));
    const cap = captureSends();
    const res = await call('POST', `/occurrences/${occ.uuid}/grouping/announce`, {});
    const body: any = await res.json();
    const posted = cap.take().map((p) => p.content).join('\n');
    expect(body.content.length).toBeGreaterThan(2000);
    expect(body.ok === false || posted.replace(/\s/g, '') === body.content.replace(/\s/g, '')).toBe(true);
  });

  // 修正済み 2026-10-11: 発表は開催回の状態を見ない。中止した回（単発の中止・定期の中止とも）でも配置をチャンネルに投稿する
  // （📣 は「中止された予定の募集・告知は投稿できません」で 400 にしている・src/admin/index.ts:965）。
  it('中止した回の配置は発表しない', async () => {
    const { occ } = await oneoffWithGrouping(['3101', '3102']);
    expect((await call('PUT', `/occurrences/${occ.uuid}`, { status: 'cancelled' })).status).toBe(200);
    const cap = captureSends();
    const res = await call('POST', `/occurrences/${occ.uuid}/grouping/announce`, {});
    expect(cap.take()).toEqual([]);
    expect(res.status).toBe(400);
  });
});

// =============================================================================
describe('📊 状況確認（疑い 3・buildStatusMessage の切り詰め）', () => {
  // BUG（軽微）: 回答ボタンは別サーバーからの押下を拒否する（src/interactions/index.ts:266）が、📊 の分岐（:231-249）はその判定より前で、
  // サーバーを照合しない。開催回 ID さえ合えば他サーバーの参加者名簿を返す。custom_id は Bot が付けるので実際に起きる経路は狭い。
  it('別サーバーで押された 📊 は拒否する', async () => {
    const s = await segment(['3201']);
    const n = await template(s.uuid, { type: 'oneoff', recruit_days_before: 3 });
    const occ = await occurrence(n, { date: '2099/01/10', start_time: '20:00' });
    expect(await press(`status_${occ.id}`, '3201', '9999')).toContain('見つかりません');
  });

  it('区分 400 人・名前 32 字（絵文字＝サロゲートペア）でも 2000 字以内で、見出しの人数は全数・末尾は「ほかN名」で切れない', async () => {
    const members = ids(400, 500000000000000000n);
    const s = await segment(members, () => '😀'.repeat(16));
    const n = await template(s.uuid, { type: 'oneoff', recruit_days_before: 3 });
    const occ = await occurrence(n, { date: '2099/01/10', start_time: '20:00' });
    for (const [i, u] of members.slice(0, 300).entries()) await answer(occ.id, u, ['参加', '不参加', '未定'][i % 3]);
    const reply = await press(`status_${occ.id}`, members[0]);
    expect(reply.length).toBeLessThanOrEqual(2000);
    expect(reply).toContain('参加 (100名)');
    expect(reply).toContain('未回答 (100名)');
    expect(reply).toMatch(/ほか\d+名$/);
    expect(reply).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/); // 絵文字を途中で割らない
  });
});

// =============================================================================
describe('中止からの再開の判定（b523386）を定期・告知で見る', () => {
  // 判断済み（2026-10-11）: 定期の再開は判定しない（b523386 より前と同じ）。再開してから締切までに 📣 で投稿できる
  it('定期: 締切が当日の送信時刻より前でも、当日朝に再開できる', async () => {
    const s = await segment(['3301']);
    const n = await template(s.uuid, { rrule: 'FREQ=WEEKLY;BYDAY=SA', response_deadline_hours: 3 });
    at('2099/01/01', '10:00');
    const occ = await occurrence(n, { date: '2099/01/10', start_time: '20:00', origin: 'rule' });
    expect((await call('PUT', `/occurrences/${occ.uuid}`, { status: 'cancelled' })).status).toBe(200);
    at('2099/01/10', '10:00');
    expect((await call('PUT', `/occurrences/${occ.uuid}`, { status: 'scheduled' })).status).toBe(200);
  });

  // 判断済み（2026-10-11）: 告知も登録と同じく判定する。投稿予定が開始後になる当日朝の再開は 400
  it('告知の単発: 開始後に投稿予定となる当日朝の再開は 400（登録と同じ）', async () => {
    const s = await segment(['3401']);
    const n = await template(s.uuid, { type: 'oneoff', recruit_days_before: 3, requires_response: false });
    at('2099/01/01', '10:00');
    const occ = await occurrence(n, { date: '2099/01/10', start_time: '20:00' });
    expect((await call('PUT', `/occurrences/${occ.uuid}`, { status: 'cancelled' })).status).toBe(200);
    at('2099/01/10', '10:00');
    expect((await call('PUT', `/occurrences/${occ.uuid}`, { status: 'scheduled' })).status).toBe(400);
  });
});

// =============================================================================
describe('日程調整: 「締切当日のみ」のずらし（cb9e7e1）の境界', () => {
  const plan = (deadline: string, intervalDays = 1) =>
    ({ state: 'open', deadline, answerReminder: { enabled: true, beforeDays: 0, intervalDays, time: '21:00', target: 'dm' } }) as any;
  const jst = (s: string) => Date.parse(s + '+09:00');

  it('締切が送信時刻ちょうどなら前日、1 分でも後なら当日に送る', () => {
    expect(answerReminderDue(plan('2099-09-01T21:00:00+09:00'), jst('2099-08-31T21:00:00'))).toBe(true);
    expect(answerReminderDue(plan('2099-09-01T21:00:00+09:00'), jst('2099-09-01T20:59:00'))).toBe(false);
    expect(answerReminderDue(plan('2099-09-01T21:01:00+09:00'), jst('2099-08-31T21:00:00'))).toBe(false);
    expect(answerReminderDue(plan('2099-09-01T21:01:00+09:00'), jst('2099-09-01T21:00:00'))).toBe(true);
  });
});

// =============================================================================
describe('日程調整: 確定後の中止と、投稿に失敗した開催枠（cb9e7e1）', () => {
  const G = '1001';
  async function ok(path: string, body?: object): Promise<any> {
    const r = await call(body ? 'POST' : 'GET', path, body);
    const j = await r.json();
    expect(r.status, JSON.stringify(j)).toBe(200);
    return j;
  }
  const deliveries = async (id: string, kind: string) =>
    (await db.prepare('SELECT * FROM planning_deliveries WHERE plan_id=? AND kind=? ORDER BY rowid').bind(id, kind).all<any>()).results;

  it('開催案内の投稿に失敗した枠: 中止の更新は失敗の解決まで待ち、再試行しても新しく投稿せず両方取り消す', async () => {
    const s = await segment(['3501']);
    let p = await ok('/planning', {
      guild_id: G, oneOff: true, name: '確定後に中止', channel: '111111', forum: '222222', tag: '', segments: [s.id],
      deadline: '2099-09-01T00:00:00Z', note: '', remindDays: 0, announceMention: 'none', shareAnswers: false, eventReminderHours: 0,
    });
    p = await ok(`/planning/${p.id}/candidates`, { version: p.version, candidates: [{ date: '2099-09-10', time: '19:00' }] });
    p = await ok(`/planning/${p.id}/publish`, { version: p.version });
    const c = p.data.candidates[0].id;
    const data = { ...p.data, answers: { '3501': { values: { [c]: '可' }, comment: '' } } };
    await db.prepare('UPDATE planning_plans SET data=? WHERE id=?').bind(JSON.stringify(data), p.id).run();
    p = await ok(`/planning/${p.id}`);
    p = await ok(`/planning/${p.id}/confirm-selection`, {
      version: p.version, reason: '',
      slots: [{ candidate: c, members: [{ user: '3501', schedule: s.id, status: '参加', duty: '' }] }],
    });
    const [first] = await deliveries(p.id, 'forum');
    await db.prepare("UPDATE planning_deliveries SET status='failed',error='Discord 403' WHERE id=?").bind(first.id).run();
    p = await ok(`/planning/${p.id}/cancel`, { version: p.version, reason: '中止' });
    await deliverPending(E, 10);
    expect((await deliveries(p.id, 'forum')).map((d) => d.status)).toEqual(['failed', 'pending']);
    p = await ok(`/planning/${p.id}/retry`, { version: p.version, delivery: first.id });
    await deliverPending(E, 10);
    await deliverPending(E, 10);
    expect((await deliveries(p.id, 'forum')).map((d) => d.status)).toEqual(['cancelled', 'cancelled']);
  });
});
