// 単発出欠確認（notifications.type='oneoff'・rrule NULL・開催回 1 件）と他機能の組み合わせ（2 巡目）。
// 1 巡目（tests/oneoff-attendance-edge.test.ts）が扱わなかった、メンバー配置・ノルマ・出欠確認記録・締切後の変更通知・
// メンバー管理・中止の取り消し・📣・募集後のテンプレート編集・有効スイッチ・告知・日時の境界を見る。
// 仕様の根拠: docs/dev/CONTEXT.md・docs/dev/attendance-settings-matrix.md・docs/dev/late-occurrence-flow.html・ADR 0014/0015/0032。
// it.fails は実装の不具合を示すテスト（// 修正済み 2026-10-11: に理由）。直したら it に戻す。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import { handleAdmin } from '../src/admin';
import { handleInteraction } from '../src/interactions/index';
import { createSegment } from '../src/db/segments';
import { runTick } from '../src/cron/tick';

const db = env.DB;
const E = { ...env, ADMIN_TOKEN: 'oneoff-r2', MOCK_DISCORD: '1', DISCORD_BOT_TOKEN: 'dummy' } as Env;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const call = (method: string, path: string, body?: unknown) =>
  handleAdmin(
    new Request(`https://test.invalid/api/admin${path}`, {
      method,
      headers: { Authorization: 'Bearer oneoff-r2', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    E,
  );
const get = async (path: string) => (await call('GET', path)).json() as Promise<any>;

/** JST の壁時計で現在時刻を固定する（秒も指定できる） */
const at = (date: string, hhmm: string, sec = 0) => {
  const [y, m, d] = date.split('/').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  vi.setSystemTime(Date.UTC(y, m - 1, d, h - 9, mi, sec));
};
const fake = (date: string, hhmm: string) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  at(date, hhmm);
};

async function segment(guild = '1001', role: string | null = null, members: string[] = []) {
  const s = await createSegment(db, { guild_id: guild, name: `区分${Math.random()}`, mention_role_id: role });
  for (const id of members) {
    await db.batch([
      db.prepare('INSERT OR IGNORE INTO members(user_id,user_name,display_name) VALUES(?,?,?)').bind(id, `u${id}`, `名${id}`),
      db.prepare("INSERT INTO segment_members(segment_id,user_id,status) VALUES(?,?,'')").bind(s.id, id),
    ]);
  }
  return s;
}

const template = (segUuid: string, extra: Record<string, unknown> = {}) => ({
  guild_id: '1001',
  segment_uuid: segUuid,
  name: '単発会',
  channel_id: '2001',
  message_title: '募集',
  type: 'oneoff',
  start_time: '20:00',
  send_hour: 21,
  recruit_days_before: 3,
  remind_start_days: 3,
  remind_undecided_days: 1,
  ...extra,
});

/** 画面と同じ順で、テンプレート → 開催回 1 件を作る */
async function oneoff(
  extra: Record<string, unknown> = {},
  occBody: Record<string, unknown> = { date: '2026/10/06', start_time: '20:00' },
  members: string[] = ['3001'],
  seg?: { id: number; uuid: string },
) {
  const s = seg ?? (await segment('1001', null, members));
  const body = template(s.uuid, extra);
  const res = await call('POST', '/notifications', body);
  expect(res.status).toBe(201);
  const n: any = await res.json();
  const o = await call('POST', `/notifications/${n.uuid}/occurrences`, occBody);
  expect(o.status).toBe(201);
  return { s, body, n, occ: (await o.json()) as any };
}

const responseOf = (oid: number, uid: string) =>
  db.prepare('SELECT status, post_deadline_change FROM responses WHERE occurrence_id=? AND user_id=?').bind(oid, uid).first<any>();
const answer = (oid: number, uid: string, status: string) =>
  db.prepare("INSERT INTO responses(occurrence_id,user_id,user_name,status,updated_at) VALUES(?,?,?,?,'x')").bind(oid, uid, `u${uid}`, status).run();

// ---- Discord ボタン（署名して公開入口を通す）----
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
let keyPair: Promise<{ pub: string; priv: CryptoKey }> | null = null;
const keys = () =>
  (keyPair ??= (async () => {
    const p = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    return { pub: hex(new Uint8Array((await crypto.subtle.exportKey('raw', p.publicKey)) as ArrayBuffer)), priv: p.privateKey };
  })());

/** ボタンを押す。guild を渡せばサーバー内、null なら DM。返り値は ephemeral の返答と、その他の Discord 投稿 */
async function press(customId: string, userId: string, guild: string | null = '1001', roles: string[] = []) {
  const { pub, priv } = await keys();
  const user = { id: userId, username: `u${userId}` };
  const body = JSON.stringify({
    type: 3,
    application_id: 'app',
    token: 'tok',
    data: { custom_id: customId },
    ...(guild ? { guild_id: guild, member: { user, roles } } : { user }),
  });
  const ts = '1700000000';
  const sig = hex(new Uint8Array(await crypto.subtle.sign('Ed25519', priv, new TextEncoder().encode(ts + body))));
  const tasks: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => tasks.push(p) } as unknown as ExecutionContext;
  let reply = '';
  const posts: { url: string; content: string }[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const content = JSON.parse(String(init?.body ?? '{}')).content ?? '';
    if (String(url).includes('/webhooks/')) reply = content;
    else posts.push({ url: String(url), content });
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
  return { reply, posts };
}

// ---- 送信を記録する（cron と管理 API の両方）----
function captureSends() {
  const sent: { to: string; content: string; buttons: boolean }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      const b = JSON.parse(String(init?.body ?? '{}'));
      if (u.endsWith('/users/@me/channels')) return Response.json({ id: `dm-${b.recipient_id}` });
      const m = u.match(/\/channels\/([^/]+)\/messages/);
      if (m) sent.push({ to: m[1], content: b.content, buttons: Array.isArray(b.components) && b.components.length > 0 });
      return Response.json({ id: 'm' });
    }),
  );
  return { take: () => sent.splice(0).sort((a, b) => a.to.localeCompare(b.to)) };
}
const tick = async () => {
  await runTick(E);
  await runTick(E);
};
/** 指定の JST 時刻で cron を回し、送られたものを返す */
const stepper = (cap: ReturnType<typeof captureSends>) => async (d: string, t: string) => {
  at(d, t);
  await tick();
  return cap.take();
};

// =============================================================================
describe('メンバー配置（ADR 0015）', () => {
  it('参加者がプールに並び、配置発表は開催回の開始時刻・テンプレートの開催時間で、配置結果の投稿先に出る', async () => {
    const { n, body, occ } = await oneoff({}, { date: '2099/01/10', start_time: '20:00' }, ['3001', '3002', '3003']);
    for (const u of ['3001', '3002']) await press(`participate_${occ.id}`, u);
    await press(`absent_${occ.id}`, '3003');
    expect((await call('PUT', `/occurrences/${occ.uuid}/grouping`, { group_count: 2 })).status).toBe(200);
    const view = await get(`/occurrences/${occ.uuid}/grouping`);
    expect(view.pool.map((m: any) => m.user_id).sort()).toEqual(['3001', '3002']);
    expect(view.occurrence.start_time).toBe('20:00');
    // テンプレートの開始時刻を変えても（画面ではロック・API は受け付ける）発表は開催回の 20:00。開催時間はテンプレートの値
    expect((await call('PUT', `/notifications/${n.uuid}`, { ...body, start_time: '18:00', duration_minutes: 90 })).status).toBe(200);
    expect((await call('PUT', `/notifications/${n.uuid}/grouping-channel`, { channel_id: '2003' })).status).toBe(200);
    const cap = captureSends();
    const res = await call('POST', `/occurrences/${occ.uuid}/grouping/announce`, {});
    expect(res.status).toBe(200);
    const [post] = cap.take();
    expect(post.to).toBe('2003');
    expect(post.content).toContain('2099/01/10');
    expect(post.content).toContain('20:00〜21:30');
    expect(post.content).toContain('未割り当て (2名)');
  });

  it('休止中・区分から外した人は「参加」でも配置の候補に出さない（集計と同じ）', async () => {
    const { s, occ } = await oneoff({}, { date: '2099/01/10', start_time: '20:00' }, ['3001', '3002', '3003']);
    for (const u of ['3001', '3002', '3003']) await press(`participate_${occ.id}`, u);
    await db.prepare("UPDATE segment_members SET status='休止中' WHERE user_id='3002'").run();
    await db.prepare("DELETE FROM segment_members WHERE user_id='3003'").run();
    expect((await call('PUT', `/occurrences/${occ.uuid}/grouping`, { group_count: 2 })).status).toBe(200);
    const view = await get(`/occurrences/${occ.uuid}/grouping`);
    expect(view.pool.map((m: any) => m.user_id)).toEqual(['3001']);
    expect(s).toBeTruthy();
  });

  it('中止の取り消し（▶ 再開）は配置を残し、中止 → 同じ日時の再登録は配置を消す', async () => {
    const { n, occ } = await oneoff({}, { date: '2099/01/10', start_time: '20:00' }, ['3001']);
    await press(`participate_${occ.id}`, '3001');
    await call('PUT', `/occurrences/${occ.uuid}/grouping`, { group_count: 2 });
    await call('PUT', `/occurrences/${occ.uuid}`, { status: 'cancelled' });
    await call('PUT', `/occurrences/${occ.uuid}`, { status: 'scheduled' });
    expect((await get(`/occurrences/${occ.uuid}/grouping`)).grouping).not.toBeNull();
    await call('PUT', `/occurrences/${occ.uuid}`, { status: 'cancelled' });
    expect((await call('POST', `/notifications/${n.uuid}/occurrences`, { date: '2099/01/10', start_time: '20:00' })).status).toBe(201);
    const view = await get(`/occurrences/${occ.uuid}/grouping`);
    expect([view.grouping, view.pool]).toEqual([null, []]);
  });
});

// =============================================================================
describe('ノルマ', () => {
  // ノルマは「Schedule ごと」の参加間隔（CONTEXT.md Quota）。単発の開催回は 1 件だけなので、前回の参加が無く督促は出ない。
  // 単発の画面にはノルマの欄がある（attendance-settings-matrix）が、設定しても送られない＝報告の「未検証の疑い」を参照。
  it('単発でノルマをオンにしても、他のスケジュールの参加は数えず督促は送られない', async () => {
    fake('2026/10/03', '12:01');
    const s = await segment('1001', null, ['3001']);
    // 同じ区分の不定期で 30 日前に参加
    const irr: any = await (await call('POST', '/notifications', template(s.uuid, { type: undefined, rrule: null, name: '別' }))).json();
    const old: any = await (await call('POST', `/notifications/${irr.uuid}/occurrences`, { date: '2026/09/03', start_time: '20:00' })).json();
    await answer(old.id, '3001', '参加');
    await call('POST', `/notifications/${irr.uuid}/active`, { active: false });
    await oneoff({ quota_enabled: 1, quota_interval_days: 7 }, undefined, [], s);
    const cap = captureSends();
    const step = stepper(cap);
    const sent = await step('2026/10/03', '21:01');
    expect(sent.map((x) => x.to)).toEqual(['2001', 'dm-3001']); // 募集と未回答リマインドだけ（ノルマ無し）
    expect(sent[1].content).toContain('リマインド');
    expect(await db.prepare("SELECT COUNT(*) AS c FROM send_log WHERE kind='quota'").first('c')).toBe(0);
  });
});

// =============================================================================
describe('出欠確認記録（出勤レポート・回答履歴・送信履歴）', () => {
  it('出勤レポート: 開催日を過ぎた単発を数え、中止中・告知・未来の回は母数に入れない。休止中のメンバーは行に出ない', async () => {
    fake('2026/10/10', '12:00');
    const { s, n, body, occ } = await oneoff({}, { date: '2026/10/06', start_time: '20:00' }, ['3001', '3002']);
    const future = await oneoff({ name: '未来' }, { date: '2026/10/12', start_time: '20:00' }, [], s);
    await answer(occ.id, '3001', '参加');
    await answer(occ.id, '3002', '不参加');
    await answer(future.occ.id, '3001', '参加');
    const report = async () => {
      const rows: any[] = await get(`/reports/attendance?segment_uuid=${s.uuid}&from=2026-10-01`);
      return Object.fromEntries(rows.map((r) => [r.user_id, [r.attended, r.total]]));
    };
    expect(await report()).toEqual({ '3001': [1, 1], '3002': [0, 1] });
    // 単発で絞り込み
    const only: any[] = await get(`/reports/attendance?segment_uuid=${s.uuid}&notification_uuid=${future.n.uuid}&from=2026-10-01`);
    expect(only.find((r) => r.user_id === '3001')).toMatchObject({ attended: 0, total: 0 });
    await call('PUT', `/occurrences/${occ.uuid}`, { status: 'cancelled' });
    expect(await report()).toEqual({ '3001': [0, 0], '3002': [0, 0] });
    await call('PUT', `/occurrences/${occ.uuid}`, { status: 'scheduled' });
    expect(await report()).toEqual({ '3001': [1, 1], '3002': [0, 1] });
    await call('PUT', `/segments/${s.uuid}/members/3002`, { status: '休止中' });
    expect(await report()).toEqual({ '3001': [1, 1] });
    await call('PUT', `/notifications/${n.uuid}`, { ...body, requires_response: 0 });
    expect(await report()).toEqual({ '3001': [0, 0] });
  });

  it('回答履歴は開催回の開始時刻で出し、サーバーで絞り込める。送信履歴には単発の募集が開催日つきで残る', async () => {
    fake('2026/10/03', '12:01');
    const { n, body, occ } = await oneoff({ send_hour: 13 });
    await call('PUT', `/notifications/${n.uuid}`, { ...body, start_time: '18:00' });
    await press(`participate_${occ.id}`, '3001');
    await press(`absent_${occ.id}`, '3001');
    const rows: any[] = await get('/responses?guild_id=1001');
    expect(rows.map((r) => [r.status, r.occurrence_time, r.notification_name])).toEqual([
      ['不参加', '20:00', '単発会'],
      ['参加', '20:00', '単発会'],
    ]);
    expect(await get('/responses?guild_id=9999')).toEqual([]);
    const cap = captureSends();
    await stepper(cap)('2026/10/03', '13:01');
    const log: any[] = await get(`/send-log?notification_id=${n.id}`);
    expect(log.find((r) => r.kind === 'recruit')).toMatchObject({ status: 'sent', occurrence_date: '2026/10/06', notification_name: '単発会' });
  });
});

// =============================================================================
describe('締切後の変更通知（ADR 0014）', () => {
  it('締切ちょうどの回答から「締切後の変更」。同じ回答の押し直しは通知せず、初回回答は「新規回答」。変更通知チャンネルに出る', async () => {
    fake('2026/10/03', '12:01');
    const { occ } = await oneoff({ change_alert_channel_id: '2003' }, { date: '2026/10/06', start_time: '20:00', response_deadline_hours: 2 }, ['3001', '3002']);
    at('2026/10/06', '17:59', 59);
    expect((await press(`participate_${occ.id}`, '3001')).posts).toEqual([]);
    at('2026/10/06', '18:00');
    const late = await press(`participate_${occ.id}`, '3002');
    expect(late.posts).toHaveLength(1);
    expect(late.posts[0].url).toContain('/channels/2003/messages');
    expect(late.posts[0].content).toContain('で新規回答');
    expect(await responseOf(occ.id, '3002')).toEqual({ status: '参加', post_deadline_change: 1 });
    // 締切前の回答と同じ値の押し直しは変更ではない（印も立てない）
    expect((await press(`participate_${occ.id}`, '3001')).posts).toEqual([]);
    expect(await responseOf(occ.id, '3001')).toEqual({ status: '参加', post_deadline_change: 0 });
    const changed = await press(`absent_${occ.id}`, '3001');
    expect(changed.posts[0].content).toContain('→');
  });

  it('回答非公開で変更通知チャンネル未指定なら、投稿チャンネルではなく配信失敗の通知先へ（未設定なら送らない）', async () => {
    fake('2026/10/03', '12:01');
    const { occ } = await oneoff({ share_answers: 0 }, { date: '2026/10/06', start_time: '20:00', response_deadline_hours: 2 }, ['3001']);
    at('2026/10/06', '19:00');
    expect((await press(`participate_${occ.id}`, '3001')).posts).toEqual([]);
    await call('PUT', '/guilds/1001/failure-notification', { channel_id: '2002', mention_mode: 'none', mention_ids: [] });
    const r = await press(`absent_${occ.id}`, '3001');
    expect(r.posts.map((p) => p.url)).toEqual([expect.stringContaining('/channels/2002/messages')]);
  });
});

// =============================================================================
describe('メンバー管理（休止・所属解除・ロール同期）', () => {
  it('募集中に休止したメンバーにはリマインドを送らず集計からも外し、再開すると翌日から送る', async () => {
    fake('2026/10/03', '12:01');
    const { s, occ } = await oneoff({}, undefined, ['3001', '3002']);
    const cap = captureSends();
    const step = stepper(cap);
    expect((await step('2026/10/03', '21:01')).map((x) => x.to)).toEqual(['2001', 'dm-3001', 'dm-3002']);
    expect((await call('PUT', `/segments/${s.uuid}/members/3002`, { status: '休止中' })).status).toBe(200);
    expect((await get(`/occurrences/${occ.uuid}/status`)).未回答).toEqual(['名3001']);
    expect((await step('2026/10/04', '21:01')).map((x) => x.to)).toEqual(['dm-3001']);
    await call('PUT', `/segments/${s.uuid}/members/3002`, { status: '' });
    expect((await step('2026/10/05', '21:01')).map((x) => x.to)).toEqual(['dm-3001', 'dm-3002']);
  });

  it('区分から外したメンバー: DM のボタンは拒否、サーバー内のボタンは所属し直して記録（自動所属）', async () => {
    const { s, occ } = await oneoff({}, { date: '2099/01/10', start_time: '20:00' }, ['3001']);
    expect((await call('DELETE', `/segments/${s.uuid}/members/3001`)).status).toBe(200);
    expect((await press(`participate_${occ.id}`, '3001', null)).reply).toContain('対象メンバーではない');
    expect(await responseOf(occ.id, '3001')).toBeNull();
    expect((await press(`participate_${occ.id}`, '3001', '1001')).reply).toContain('記録しました');
    expect(await db.prepare("SELECT status FROM segment_members WHERE segment_id=? AND user_id='3001'").bind(s.id).first('status')).toBe('');
  });

  it('ロール管理区分: 送信時刻のロール同期でロールの無い人を外し、ロール保有者を加えてからリマインドする', async () => {
    fake('2026/10/03', '12:01');
    const s = await segment('1001', '4001', ['3001', '3003']); // 3003 はロール無し（MOCK_MEMBERS）
    await oneoff({ mention_mode: 'none' }, undefined, [], s);
    const cap = captureSends();
    const sent = await stepper(cap)('2026/10/03', '21:01');
    expect(sent.map((x) => x.to)).toEqual(['2001', 'dm-3001', 'dm-3002']);
    expect(await db.prepare("SELECT COUNT(*) AS c FROM segment_members WHERE segment_id=? AND user_id='3003'").bind(s.id).first('c')).toBe(0);
  });
});

// =============================================================================
describe('中止の取り消し（PUT status=scheduled）', () => {
  it('締切後に再開した単発は 📣 も自動募集もしない（中止 → 再登録が正規の手順）', async () => {
    fake('2026/10/01', '12:00');
    const { occ } = await oneoff({ remind_undecided_days: 2 }, { date: '2026/10/06', start_time: '20:00', response_deadline_hours: 24 });
    await call('PUT', `/occurrences/${occ.uuid}`, { status: 'cancelled' });
    at('2026/10/05', '21:00');
    expect((await call('PUT', `/occurrences/${occ.uuid}`, { status: 'scheduled' })).status).toBe(200);
    const cap = captureSends();
    expect((await call('POST', `/occurrences/${occ.uuid}/recruit`, {})).status).toBe(400);
    expect(await stepper(cap)('2026/10/05', '21:01')).toEqual([]);
  });

  // 修正済み 2026-10-11: src/admin/index.ts:999（PUT /occurrences/:uuid の status）と 894-905（テンプレート PUT の締切ガード・単発の順序ルール）—
  // テンプレートの PUT は中止中の回を判定から外し（occurrenceFlowError も単発のループも status !== 'scheduled' を飛ばす）、
  // 再開（▶ 再開＝PUT status:'scheduled'）は何も判定しない。中止 → 「募集は当日 8:00」に編集 → 再開 で、
  // 締切（前日 20:00）が募集より前の単発ができ、募集は一度も投稿されない（ADR 0032 の登録ガード・late-occurrence-flow シナリオ D の抜け道）。
  // 画面から到達可能（一覧の 🚫 中止 → ✏️ 編集 → ▶ 再開）。中。
  it('中止中に流れを変えてから再開しても、締切が募集より前の単発は作れない（PUT か再開のどちらかが 400）', async () => {
    fake('2026/10/01', '12:00');
    const { n, body, occ } = await oneoff({ remind_start_days: 2, remind_undecided_days: 2 }, { date: '2026/10/06', start_time: '20:00', response_deadline_hours: 24 });
    await call('PUT', `/occurrences/${occ.uuid}`, { status: 'cancelled' });
    const put = await call('PUT', `/notifications/${n.uuid}`, { ...body, recruit_days_before: 0, send_hour: 8, remind_unanswered_enabled: false, remind_undecided_enabled: false });
    const resume = await call('PUT', `/occurrences/${occ.uuid}`, { status: 'scheduled' });
    // 再開できた場合、締切（10/05 20:00）が先に来て、当日 8:00 の募集は出ない
    const cap = captureSends();
    expect(await stepper(cap)('2026/10/06', '08:01')).toEqual([]);
    expect(put.status === 400 || resume.status === 400).toBe(true);
  });
});

// =============================================================================
describe('📣 今すぐ募集', () => {
  it('締切の 1 秒前までは投稿でき、締切ちょうどからは 400（再投稿の force でも）', async () => {
    fake('2026/10/03', '12:01');
    const { occ } = await oneoff({}, { date: '2026/10/06', start_time: '20:00', response_deadline_hours: 2 });
    const cap = captureSends();
    at('2026/10/06', '17:59', 59);
    expect((await call('POST', `/occurrences/${occ.uuid}/recruit`, {})).status).toBe(200);
    expect((await call('POST', `/occurrences/${occ.uuid}/recruit`, {})).status).toBe(409);
    expect((await call('POST', `/occurrences/${occ.uuid}/recruit`, { force: true })).status).toBe(200);
    expect(cap.take().map((x) => x.to)).toEqual(['2001', '2001']);
    at('2026/10/06', '18:00');
    expect((await call('POST', `/occurrences/${occ.uuid}/recruit`, { force: true })).status).toBe(400);
    expect(cap.take()).toEqual([]);
  });

  it('再投稿（force）しても締切告知は 1 回、自動募集は重ねない', async () => {
    fake('2026/10/03', '12:01');
    const { occ } = await oneoff({}, { date: '2026/10/06', start_time: '20:00', response_deadline_hours: 2 });
    const cap = captureSends();
    const step = stepper(cap);
    expect((await step('2026/10/03', '21:01')).map((x) => x.to)).toEqual(['2001', 'dm-3001']);
    at('2026/10/04', '10:00');
    expect((await call('POST', `/occurrences/${occ.uuid}/recruit`, { force: true })).status).toBe(200);
    expect(cap.take().map((x) => x.to)).toEqual(['2001']);
    expect((await step('2026/10/04', '21:01')).map((x) => x.to)).toEqual(['dm-3001']);
    expect((await step('2026/10/06', '18:01')).map((x) => x.content)).toEqual([expect.stringContaining('回答を締め切りました')]);
    expect(await step('2026/10/06', '18:03')).toEqual([]);
  });

  it('無効（active=0）の単発も 📣 で投稿できるが、その後の自動送信（リマインド）は止まったまま', async () => {
    fake('2026/10/03', '12:01');
    const { n, occ } = await oneoff();
    await call('POST', `/notifications/${n.uuid}/active`, { active: false });
    const cap = captureSends();
    expect((await call('POST', `/occurrences/${occ.uuid}/recruit`, {})).status).toBe(200);
    expect(cap.take().map((x) => x.to)).toEqual(['2001']);
    expect(await stepper(cap)('2026/10/03', '21:01')).toEqual([]);
  });
});

// =============================================================================
describe('告知（出欠確認なし）の単発', () => {
  it('告知はボタン無しで投稿し、リマインド・締切は無い。📣 で締切を選ぶことはできない', async () => {
    fake('2026/10/03', '12:01');
    const { occ } = await oneoff({ requires_response: 0, recruit_enabled: 0 });
    expect((await call('POST', `/occurrences/${occ.uuid}/recruit`, { response_deadline_hours: 2 })).status).toBe(400);
    const cap = captureSends();
    expect((await call('POST', `/occurrences/${occ.uuid}/recruit`, {})).status).toBe(200);
    const [post] = cap.take();
    expect([post.to, post.buttons]).toEqual(['2001', false]);
    expect(post.content).not.toContain('回答締切');
    const step = stepper(cap);
    expect(await step('2026/10/03', '21:01')).toEqual([]);
    expect(await step('2026/10/05', '21:01')).toEqual([]);
  });
});

// =============================================================================
describe('募集後のテンプレート編集', () => {
  it('投稿チャンネルを変えると、以後のチャンネル宛てリマインドと締切告知は新しいチャンネルへ。古い投稿のボタンも使える', async () => {
    fake('2026/10/03', '12:01');
    const { n, body, occ } = await oneoff({ remind_target: 'channel', remind_undecided_days: 2 }, { date: '2026/10/06', start_time: '20:00', response_deadline_hours: 26 }, ['3001', '3002']);
    const cap = captureSends();
    const step = stepper(cap);
    expect((await step('2026/10/03', '21:01')).map((x) => x.to)).toEqual(['2001', '2001']);
    expect((await call('PUT', `/notifications/${n.uuid}`, { ...body, channel_id: '2002' })).status).toBe(200);
    expect((await press(`participate_${occ.id}`, '3001')).reply).toContain('記録しました');
    const remind = await step('2026/10/04', '21:01');
    expect(remind.map((x) => x.to)).toEqual(['2002']);
    expect(remind[0].content).toContain('<@3002>');
    expect(remind[0].content).not.toContain('<@3001>');
    expect((await step('2026/10/05', '18:01')).map((x) => [x.to, x.content.includes('回答を締め切りました')])).toEqual([['2002', true]]);
  });

  it('開催時間を変えると、開催回（NULL＝テンプレートに従う）のリマインドの表示に効く', async () => {
    fake('2026/10/03', '12:01');
    const { n, body } = await oneoff();
    const cap = captureSends();
    const step = stepper(cap);
    await step('2026/10/03', '21:01');
    await call('PUT', `/notifications/${n.uuid}`, { ...body, duration_minutes: 120 });
    const [dm] = await step('2026/10/04', '21:01');
    expect(dm.content).toContain('20:00〜22:00');
  });

  it('募集の投稿後に手動募集へ切り替えても（締切なし）、リマインドは続く', async () => {
    fake('2026/10/03', '12:01');
    const { n, body } = await oneoff();
    const cap = captureSends();
    const step = stepper(cap);
    await step('2026/10/03', '21:01');
    expect((await call('PUT', `/notifications/${n.uuid}`, { ...body, recruit_enabled: 0 })).status).toBe(200);
    expect((await step('2026/10/04', '21:01')).map((x) => x.to)).toEqual(['dm-3001']);
  });
});

// =============================================================================
describe('有効スイッチ', () => {
  it('無効の間はリマインドも締切告知も出さず回答は受け付け、有効に戻すと開始前なら締切告知を追いかけて出す', async () => {
    fake('2026/10/03', '12:01');
    const { n, occ } = await oneoff({}, { date: '2026/10/06', start_time: '20:00', response_deadline_hours: 2 }, ['3001', '3002']);
    const cap = captureSends();
    const step = stepper(cap);
    await step('2026/10/03', '21:01');
    await call('POST', `/notifications/${n.uuid}/active`, { active: false });
    expect(await step('2026/10/04', '21:01')).toEqual([]);
    expect((await press(`participate_${occ.id}`, '3001')).reply).toContain('記録しました');
    expect(await step('2026/10/06', '18:01')).toEqual([]);
    await call('POST', `/notifications/${n.uuid}/active`, { active: true });
    expect((await step('2026/10/06', '19:01')).map((x) => x.content)).toEqual([expect.stringContaining('回答を締め切りました')]);
  });
});

// =============================================================================
describe('日時の境界（JST）', () => {
  it('開始 00:00・締切 2 時間前: 締切は前日 22:00。前日に募集・リマインド・締切告知、当日は何も送らない', async () => {
    fake('2026/10/03', '12:01');
    await oneoff({ recruit_days_before: 1, remind_start_days: 1, remind_undecided_enabled: false }, { date: '2026/10/06', start_time: '00:00', response_deadline_hours: 2 });
    const cap = captureSends();
    const step = stepper(cap);
    expect(await step('2026/10/04', '21:01')).toEqual([]);
    const recruit = await step('2026/10/05', '21:01');
    expect(recruit.map((x) => x.to)).toEqual(['2001', 'dm-3001']);
    expect(recruit[0].content).toContain('回答締切: **2026/10/05 22:00**');
    expect(recruit[0].content).toContain('2026/10/06 (火) 00:00〜');
    expect((await step('2026/10/05', '22:01')).map((x) => x.content)).toEqual([expect.stringContaining('回答を締め切りました')]);
    expect(await step('2026/10/06', '00:01')).toEqual([]);
    expect(await step('2026/10/06', '21:01')).toEqual([]);
  });

  it('開始 00:00 で当日 0 時に募集する設定は E4 で 400、開始 23:59・送信 23 時の当日募集と開始ちょうどの締切は通る', async () => {
    fake('2026/10/03', '12:01');
    const s = await segment('1001', null, ['3001']);
    const bad: any = await (await call('POST', '/notifications', template(s.uuid, { send_hour: 0, recruit_days_before: 0, remind_start_days: 0, remind_undecided_enabled: false }))).json();
    expect((await call('POST', `/notifications/${bad.uuid}/occurrences`, { date: '2026/10/06', start_time: '00:00' })).status).toBe(400);
    await oneoff({ send_hour: 23, recruit_days_before: 0, remind_start_days: 0, remind_undecided_enabled: false }, { date: '2026/10/06', start_time: '23:59', response_deadline_hours: 0 }, [], s);
    const cap = captureSends();
    const step = stepper(cap);
    expect(await step('2026/10/06', '22:59')).toEqual([]);
    const recruit = await step('2026/10/06', '23:01');
    expect(recruit[0].content).toContain('回答締切: **2026/10/06 23:59**');
    expect(await step('2026/10/06', '23:57')).toEqual([]);
    expect((await step('2026/10/06', '23:59')).map((x) => x.content)).toEqual([expect.stringContaining('回答を締め切りました')]);
    expect(await step('2026/10/07', '00:01')).toEqual([]);
  });

  // 修正済み 2026-10-11: src/admin/index.ts:788-804（開催回 POST の登録ガード）— 締切なしの単発は「次に募集が投稿される時刻」（nextRecruitAt＝
  // 今日の送信時刻）が開始より後でも登録できる。E4 は「0 日前」の設定だけを見るので、募集 3 日前・送信 21 時の単発を
  // 当日 10 時に 20:00 開始で作ると、追いつきの募集が 21:00（開始後）になり cron の開始ゲート（tick.ts:581）で止まる＝
  // 募集もリマインドも一度も出ず、画面にも理由が出ない。late-occurrence-flow §4「当日登録の場合は、送信時刻が開始時刻より後に
  // なる設定は保存時に弾かれます（E4）」と食い違う。画面から到達可能（単発の作成で今日の夜を選ぶ・既定の送信時刻 21 時）。中。
  it('当日に作った単発で追いつきの募集が開始後になるなら、登録で 400（または開始前に募集を出す）', async () => {
    fake('2026/10/03', '10:00');
    const s = await segment('1001', null, ['3001']);
    const n: any = await (await call('POST', '/notifications', template(s.uuid))).json();
    const res = await call('POST', `/notifications/${n.uuid}/occurrences`, { date: '2026/10/03', start_time: '20:00' });
    const cap = captureSends();
    const step = stepper(cap);
    const sent = [...(await step('2026/10/03', '10:01')), ...(await step('2026/10/03', '19:59')), ...(await step('2026/10/03', '21:01'))];
    expect(sent).toEqual([]); // 実際に何も出ない（バグの症状）
    expect(res.status === 400 || sent.length > 0).toBe(true);
  });
});
