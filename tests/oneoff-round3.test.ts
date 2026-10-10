// 単発出欠確認（notifications.type='oneoff'）と単発日程調整（planning_plans.data.oneOff=true）の 3 巡目。
// 1・2 巡目（oneoff-attendance-edge / -round2・oneoff-planning-edge / -round2）が扱わなかった、
// Discord に送る本文の中身（日時ラベル・締切・メンション・字数）、旧データ、同時操作・冪等性、中止・削除の後始末を見る。
// 根拠: docs/dev/attendance-settings-matrix.md・docs/dev/CONTEXT.md・ADR 0010/0014/0032・src のコメント。
// it.fails は実装の不具合を示すテスト（// 修正済み 2026-10-11: に理由）。直したら it に戻す。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import { handleAdmin } from '../src/admin';
import { handleInteraction } from '../src/interactions/index';
import { createSegment } from '../src/db/segments';
import { runTick } from '../src/cron/tick';
import { planningTick } from '../src/planning/cron';
import { deliverPending } from '../src/planning/delivery';

const db = env.DB;
const E = { ...env, ADMIN_TOKEN: 'oneoff-r3', MOCK_DISCORD: '1', DISCORD_BOT_TOKEN: 'dummy' } as Env;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const call = (method: string, path: string, body?: unknown) =>
  handleAdmin(
    new Request(`https://test.invalid/api/admin${path}`, {
      method,
      headers: { Authorization: 'Bearer oneoff-r3', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    E,
  );

const at = (date: string, hhmm: string) => {
  const [y, m, d] = date.split('/').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  vi.setSystemTime(Date.UTC(y, m - 1, d, h - 9, mi));
};
const fake = (date: string, hhmm: string) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  at(date, hhmm);
};

async function segment(role: string | null = null, members: string[] = [], name = (id: string) => `名${id}`) {
  const s = await createSegment(db, { guild_id: '1001', name: `区分${Math.random()}`, mention_role_id: role });
  for (const id of members) {
    await db.batch([
      db.prepare('INSERT OR IGNORE INTO members(user_id,user_name,display_name) VALUES(?,?,?)').bind(id, `u${id}`, name(id)),
      db.prepare("INSERT INTO segment_members(segment_id,user_id,status) VALUES(?,?,'')").bind(s.id, id),
    ]);
  }
  return s;
}

/** 画面と同じ順で、テンプレート → 開催回 1 件を作る */
async function oneoff(
  extra: Record<string, unknown> = {},
  occBody: Record<string, unknown> = { date: '2026/10/06', start_time: '23:00', response_deadline_hours: 2 },
  seg?: { id: number; uuid: string },
) {
  const s = seg ?? (await segment(null, ['3001']));
  const res = await call('POST', '/notifications', {
    guild_id: '1001', segment_uuid: s.uuid, name: '単発会', channel_id: '2001', message_title: '募集', message_body: '本文',
    type: 'oneoff', start_time: '23:00', duration_minutes: 180, send_hour: 21, recruit_days_before: 3,
    remind_start_days: 3, remind_undecided_days: 1, mention_mode: 'none', ...extra,
  });
  expect(res.status).toBe(201);
  const n: any = await res.json();
  const o = await call('POST', `/notifications/${n.uuid}/occurrences`, occBody);
  expect(o.status, JSON.stringify(await o.clone().json())).toBe(201);
  return { s, n, occ: (await o.json()) as any };
}

/** Discord への送信を全部記録する（本文・allowed_mentions・ボタン） */
function captureSends() {
  const sent: { to: string; content: string; allowed: any; buttons: boolean }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      const b = JSON.parse(String(init?.body ?? '{}'));
      if (u.endsWith('/users/@me/channels')) return Response.json({ id: `dm-${b.recipient_id}` });
      const m = u.match(/\/channels\/([^/]+)\/messages/);
      if (m) sent.push({ to: m[1], content: b.content, allowed: b.allowed_mentions, buttons: Array.isArray(b.components) && b.components.length > 0 });
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

// =============================================================================
// 単発出欠確認
// =============================================================================
describe('単発出欠確認: Discord に送る本文', () => {
  it('📣 の募集: 曜日つきの日時・開催時間が日をまたぐと「翌」・回答締切の日時。メンション方法ごとに allowed_mentions を絞る', async () => {
    fake('2026/10/01', '12:00');
    const cases = [
      { mode: 'role', role: '4001', prefix: '<@&4001>\n\n', allowed: { parse: ['roles'] } },
      { mode: 'role', role: '@everyone', prefix: '@everyone\n\n', allowed: { parse: ['everyone'] } },
      { mode: 'role', role: null, prefix: '', allowed: { parse: ['roles'] } },
      { mode: 'none', role: '4001', prefix: '', allowed: { parse: [] } },
      { mode: 'members', role: null, prefix: '<@3001>\n\n', allowed: { parse: ['users'] } },
    ];
    for (const c of cases) {
      const s = await segment(c.role, ['3001']);
      const { occ } = await oneoff({ mention_mode: c.mode }, undefined, s);
      const cap = captureSends();
      expect((await call('POST', `/occurrences/${occ.uuid}/recruit`)).status).toBe(200);
      const [post] = cap.take();
      expect(post.to).toBe('2001');
      expect(post.buttons).toBe(true);
      expect(post.allowed).toEqual(c.allowed);
      expect(post.content).toBe(
        `${c.prefix}**募集**\n\n本文\n\n日時: **2026/10/06 (火) 23:00〜翌02:00**\n回答締切: **2026/10/06 21:00**`,
      );
    }
  });

  it('cron: 未回答リマインド DM・締切告知も同じ日時ラベル。締切告知は誰もメンションしない', async () => {
    fake('2026/10/03', '21:00');
    await oneoff({ mention_mode: 'role' }, undefined, await segment('@everyone', ['3001']));
    const cap = captureSends();
    const step = async (d: string, t: string) => {
      at(d, t);
      await runTick(E);
      await runTick(E);
      return cap.take();
    };
    const recruit = await step('2026/10/03', '21:00');
    expect(recruit.filter((x) => x.to === '2001').map((x) => x.content)).toEqual([expect.stringContaining('日時: **2026/10/06 (火) 23:00〜翌02:00**')]);
    const remind = await step('2026/10/05', '21:00');
    const dm = remind.find((x) => x.to === 'dm-3001')!;
    expect(dm.content).toBe(
      '⏰ **リマインド: あと1日のイベント**（土曜サークル）\n\n日時: **2026/10/06 (火) 23:00〜翌02:00**\n\nまだ回答されていません。下のボタンで参加/不参加を回答してください!',
    );
    const deadline = (await step('2026/10/06', '21:00')).filter((x) => x.to === '2001');
    expect(deadline).toEqual([
      {
        to: '2001',
        content: '⏰ **回答を締め切りました**（2026/10/06 (火) 23:00〜翌02:00）\n以降に回答を変更すると、管理者に記録・通知されます。',
        allowed: { parse: [] },
        buttons: false,
      },
    ]);
  });

  it('見出し 100 字・本文 1500 字・ロールメンションでも 2000 字に収まり、日時と締切の行が切れない', async () => {
    fake('2026/10/01', '12:00');
    const s = await segment('123456789012345678', ['3001']);
    const { occ } = await oneoff({ mention_mode: 'role', message_title: '見'.repeat(150), message_body: '本'.repeat(3000) }, undefined, s);
    const cap = captureSends();
    expect((await call('POST', `/occurrences/${occ.uuid}/recruit`)).status).toBe(200);
    const [post] = cap.take();
    expect(post.content.length).toBeLessThanOrEqual(2000);
    expect(post.content.endsWith('回答締切: **2026/10/06 21:00**')).toBe(true);
  });

  it('バイネーム（members）200 人でも 2000 字に収まり「ほかN名」で省略、日時の行は残る', async () => {
    fake('2026/10/01', '12:00');
    const ids = Array.from({ length: 200 }, (_, i) => String(100000000000000000n + BigInt(i)));
    const s = await segment(null, ids);
    const { occ } = await oneoff({ mention_mode: 'members', message_body: '本'.repeat(1500) }, undefined, s);
    const cap = captureSends();
    expect((await call('POST', `/occurrences/${occ.uuid}/recruit`)).status).toBe(200);
    const [post] = cap.take();
    expect(post.content.length).toBeLessThanOrEqual(2000);
    expect(post.content).toMatch(/ほか\d+名\n\n\*\*募集\*\*/);
    expect(post.content.endsWith('回答締切: **2026/10/06 21:00**')).toBe(true);
    expect(post.allowed).toEqual({ parse: ['users'] });
  });

  // 修正済み 2026-10-11: buildStatusMessage（src/discord/rest.ts:123）は名前を全員分つなげるだけで 2000 字の上限を見ない。
  // 📊 の返答は postMessage の切り詰めを通らず PATCH @original（src/interactions/index.ts:244→108）に直接渡るので、
  // 区分が大きいと Discord が 400 で拒否し、押した人には何も表示されない（「考え中…」のまま）。
  it('📊 状況確認: 区分が大きく（120 人・名前 20 字）ても返答は 2000 字以内', async () => {
    fake('2026/10/01', '12:00');
    const ids = Array.from({ length: 120 }, (_, i) => String(200000000000000000n + BigInt(i)));
    const s = await segment(null, ids, (id) => `メンバー表示名${id.slice(-13)}`);
    const { occ } = await oneoff({}, undefined, s);
    const reply = await press(`status_${occ.id}`, ids[0]);
    expect(reply).toContain('の参加状況');
    expect(reply.length).toBeLessThanOrEqual(2000);
  });

  it('回答非公開（share_answers=0）の 📊 は本人の回答だけで、他人の名前・人数を出さない', async () => {
    fake('2026/10/01', '12:00');
    const s = await segment(null, ['3001', '3002']);
    const { occ } = await oneoff({ share_answers: false }, undefined, s);
    await press(`participate_${occ.id}`, '3002');
    const reply = await press(`status_${occ.id}`, '3001');
    expect(reply).toContain('⚠️ 未回答');
    expect(reply).not.toContain('名3002');
    expect(reply).not.toMatch(/\d+名\)/);
  });
});

describe('単発出欠確認: 同時操作・冪等性', () => {
  it('📣 を同時に 2 回押しても投稿は 1 件（片方は 409）', async () => {
    fake('2026/10/01', '12:00');
    const { occ } = await oneoff();
    const cap = captureSends();
    const rs = await Promise.all([call('POST', `/occurrences/${occ.uuid}/recruit`), call('POST', `/occurrences/${occ.uuid}/recruit`)]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(cap.take().filter((x) => x.to === '2001')).toHaveLength(1);
  });

  it('同じ回答ボタンの連打は回答を 1 件に保つ（回答履歴 response_log は押した回数ぶん＝追記型の設計・migration 0022）', async () => {
    fake('2026/10/01', '12:00');
    const { occ } = await oneoff();
    for (let i = 0; i < 3; i++) await press(`participate_${occ.id}`, '3001');
    expect((await db.prepare('SELECT COUNT(*) n FROM responses WHERE occurrence_id=?').bind(occ.id).first<any>()).n).toBe(1);
    expect((await db.prepare('SELECT COUNT(*) n FROM response_log WHERE occurrence_id=?').bind(occ.id).first<any>()).n).toBe(3);
  });
});

describe('単発出欠確認: 旧データ（今日の修正より前に作られた行）', () => {
  it('開催回に流れ・開催時間が入った旧行は、cron も PUT の判定も開催回の値で動く（現状の記録・画面はテンプレートの値を出す）', async () => {
    fake('2026/10/03', '09:00');
    const { n, occ } = await oneoff({}, { date: '2026/10/06', start_time: '23:00' });
    // 06ec8ed より前の API は単発の開催回にも流れ・開催時間を保存できた
    await db.prepare('UPDATE occurrences SET send_hour=9, recruit_enabled=1, recruit_days_before=3, duration_minutes=30 WHERE id=?').bind(occ.id).run();
    const cap = captureSends();
    await runTick(E);
    await runTick(E);
    expect(cap.take().filter((x) => x.to === '2001').map((x) => x.content)).toEqual([expect.stringContaining('23:00〜23:30')]);
    // GET は開催回の値をそのまま返す（画面はこれを見れば食い違いに気づける）
    const [row] = (await (await call('GET', `/notifications/${n.uuid}/occurrences`)).json()) as any[];
    expect(row).toMatchObject({ send_hour: 9, duration_minutes: 30 });
  });

  it('開始時刻が空の旧開催回は、テンプレートの開始時刻で表示・判定し、中止の取り消しもできる', async () => {
    fake('2026/10/01', '12:00');
    const { n, occ } = await oneoff({}, { date: '2026/10/06', start_time: '23:00' });
    await db.prepare("UPDATE occurrences SET start_time='' WHERE id=?").bind(occ.id).run();
    const cap = captureSends();
    expect((await call('POST', `/occurrences/${occ.uuid}/recruit`)).status).toBe(200);
    expect(cap.take()[0].content).toContain('日時: **2026/10/06 (火) 23:00〜翌02:00**');
    expect((await call('PUT', `/occurrences/${occ.uuid}`, { status: 'cancelled' })).status).toBe(200);
    expect((await call('PUT', `/occurrences/${occ.uuid}`, { status: 'scheduled' })).status).toBe(200);
    // テンプレートの保存（流れの判定は開催回の開始時刻＝空ならテンプレートの値）も通る
    const put = await call('PUT', `/notifications/${n.uuid}`, {
      segment_uuid: (await db.prepare('SELECT uuid FROM segments WHERE id=?').bind(n.segment_id).first<any>()).uuid,
      name: '改名', channel_id: '2001', message_title: '募集', start_time: '23:00', send_hour: 21, recruit_days_before: 3,
      remind_start_days: 3, remind_undecided_days: 1,
    });
    expect(put.status).toBe(200);
  });
});

describe('単発出欠確認: 削除の後始末', () => {
  it('送信・回答の後に削除すると send_log・responses・response_log が消え、cron も古いボタンも何もしない', async () => {
    fake('2026/10/03', '21:00');
    const { n, occ } = await oneoff();
    const cap = captureSends();
    await runTick(E);
    await runTick(E);
    expect(cap.take().length).toBeGreaterThan(0);
    await press(`participate_${occ.id}`, '3001');
    expect((await call('DELETE', `/notifications/${n.uuid}`)).status).toBe(200);
    for (const t of ['send_log WHERE notification_id=?', 'responses WHERE occurrence_id=?', 'response_log WHERE occurrence_id=?', 'occurrences WHERE notification_id=?']) {
      const id = t.includes('notification_id') ? n.id : occ.id;
      expect((await db.prepare(`SELECT COUNT(*) n FROM ${t}`).bind(id).first<any>()).n, t).toBe(0);
    }
    at('2026/10/06', '21:00');
    await runTick(E);
    expect(cap.take()).toEqual([]);
    expect(await press(`participate_${occ.id}`, '3001')).toContain('見つかりません');
  });
});

// =============================================================================
// 単発日程調整
// =============================================================================
const G = '1001';
async function planReq(path: string, body?: object) {
  const r = await call(body ? 'POST' : 'GET', path, body);
  return { status: r.status, body: (await r.json()) as any };
}
async function ok(path: string, body?: object): Promise<any> {
  const r = await planReq(path, body);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
}
async function seedPeople(segId: number, n: number, prefix = 'p') {
  for (let i = 1; i <= n; i++) {
    const id = `${prefix}${i}`;
    await db.prepare('INSERT OR IGNORE INTO members(user_id,user_name) VALUES(?,?)').bind(id, `回答者${i}`).run();
    await db.prepare("INSERT INTO segment_members(segment_id,user_id,status) VALUES(?,?,'')").bind(segId, id).run();
  }
}
const SETTINGS = {
  guild_id: G, oneOff: true, name: '単発の日程調整', channel: '111111', forum: '222222', tag: '',
  deadline: '2099-09-01T00:00:00Z', note: '補足', remindDays: 0, announceMention: 'none', shareAnswers: false, eventReminderHours: 2,
  answerReminder: { enabled: true, beforeDays: 2, intervalDays: 1, time: '20:00', target: 'dm' },
};
async function published(segments: number[], x: object = {}, candidates = [{ date: '2099-09-10', time: '19:00' }]) {
  let p = await ok('/planning', { ...SETTINGS, segments, ...x });
  p = await ok(`/planning/${p.id}/candidates`, { version: p.version, candidates });
  return ok(`/planning/${p.id}/publish`, { version: p.version });
}
const deliveries = async (id: string, kind?: string) =>
  (await db.prepare(`SELECT * FROM planning_deliveries WHERE plan_id=? ${kind ? 'AND kind=?' : ''} ORDER BY rowid`).bind(id, ...(kind ? [kind] : [])).all<any>()).results;
/** 回答をまとめて書き込む（代理回答を人数分呼ぶ代わり） */
async function setAnswers(id: string, users: string[], value = '可') {
  const row = await db.prepare('SELECT data FROM planning_plans WHERE id=?').bind(id).first<any>();
  const data = JSON.parse(row.data);
  const active = data.candidates.filter((c: any) => c.active).map((c: any) => c.id);
  for (const u of users) data.answers[u] = { values: Object.fromEntries(active.map((c: string) => [c, value])), comment: '' };
  await db.prepare('UPDATE planning_plans SET data=? WHERE id=?').bind(JSON.stringify(data), id).run();
  return ok(`/planning/${id}`);
}

describe('単発日程調整: 回答案内の本文', () => {
  it('ロールメンション（ロール＋@everyone）・最長の名前と補足・候補 200 件でも 2000 字以内、締切は日本時間の曜日つき', async () => {
    const roleSeg = await segment('4001');
    const allSeg = await segment('@everyone');
    const cands = Array.from({ length: 200 }, (_, i) => ({ date: new Date(Date.UTC(2099, 8, 2 + i)).toISOString().slice(0, 10), time: '19:00' }));
    const p = await published([roleSeg.id, allSeg.id], { announceMention: 'role', name: '名'.repeat(150), note: '補'.repeat(1000) }, cands);
    const [job] = await deliveries(p.id, 'publish');
    const payload = JSON.parse(job.payload);
    expect(payload.content.startsWith('@everyone <@&4001>\n')).toBe(true);
    expect(payload.allowed_mentions).toEqual({ parse: ['everyone'], roles: ['4001'] });
    expect(payload.content).toContain('候補200件 · 回答締切 2099/9/1(火) 09:00（日本時間）');
    expect(payload.content).toContain('回答内容はあなたと運営だけが確認できます。');
    expect(payload.content.length).toBeLessThanOrEqual(2000);
  });

  it('メンションなし（none）は本文の @everyone 等の文字列でも誰も呼ばない', async () => {
    const seg = await segment('@everyone');
    const p = await published([seg.id], { announceMention: 'none', note: '@everyone @here <@&4001>' });
    const payload = JSON.parse((await deliveries(p.id, 'publish'))[0].payload);
    expect(payload.allowed_mentions).toEqual({ parse: [] });
    expect(payload.content.startsWith('単発の日程調整\n')).toBe(true);
  });
});

describe('単発日程調整: 同時操作・冪等性', () => {
  it('同じ版で公開を同時に 2 回送っても回答案内は 1 件（片方は 409）', async () => {
    const seg = await segment(null, ['3001']);
    let p = await ok('/planning', { ...SETTINGS, segments: [seg.id] });
    p = await ok(`/planning/${p.id}/candidates`, { version: p.version, candidates: [{ date: '2099-09-10', time: '19:00' }] });
    const rs = await Promise.all([planReq(`/planning/${p.id}/publish`, { version: p.version }), planReq(`/planning/${p.id}/publish`, { version: p.version })]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await deliveries(p.id, 'publish')).toHaveLength(1);
    // 公開済みを最新の版でもう一度公開しても増えない
    const now = await ok(`/planning/${p.id}`);
    expect((await planReq(`/planning/${p.id}/publish`, { version: now.version })).status).toBe(400);
    expect(await deliveries(p.id, 'publish')).toHaveLength(1);
  });

  it('二人の管理者: 古い版での名前変更・中止は 409 で、先の操作を上書きしない', async () => {
    const seg = await segment(null, ['3001']);
    const p = await published([seg.id]);
    await ok(`/planning/${p.id}/settings`, { version: p.version, name: 'A の名前', deadline: p.data.deadline, note: p.data.note });
    expect((await planReq(`/planning/${p.id}/settings`, { version: p.version, name: 'B の名前', deadline: p.data.deadline, note: p.data.note })).status).toBe(409);
    expect((await planReq(`/planning/${p.id}/cancel`, { version: p.version })).status).toBe(409);
    const now = await ok(`/planning/${p.id}`);
    expect(now.data).toMatchObject({ name: 'A の名前', state: 'open' });
  });
});

describe('単発日程調整: 中止の後始末', () => {
  // 修正済み 2026-10-11: 中止（src/planning/admin.ts:613-640）は選定済みの開催枠ごとに slotPayload を組み立てて「中止」のフォーラム投稿を積むが、
  // slotPayload（src/planning/delivery.ts:89）は参加 60 人超・本文 4096 字超で例外を投げる。選定の保存（selections・admin.ts:245・100 人まで）は
  // この上限を見ないので、受付中に 61 人以上を選定して保存した単発は中止できない（400「一つの開催枠の参加者は60人以内…」）。
  // 未投稿の開催枠のフォーラム投稿はどうせ配信時に取り消される（delivery.ts の !old && slot.cancelled）ので、中止を止める理由がない。
  it('受付中に 61 人を選定して保存した単発日程調整も中止できる', async () => {
    const seg = await segment();
    await seedPeople(seg.id, 61);
    const users = Array.from({ length: 61 }, (_, i) => `p${i + 1}`);
    let p = await published([seg.id]);
    p = await setAnswers(p.id, users);
    const c = p.data.candidates.find((x: any) => x.active).id;
    p = await ok(`/planning/${p.id}/selection`, {
      version: p.version,
      slots: [{ candidate: c, members: users.map((user) => ({ user, schedule: seg.id, status: '参加', duty: '' })) }],
    });
    const r = await planReq(`/planning/${p.id}/cancel`, { version: p.version, reason: '中止' });
    expect(r.body.error).toBeUndefined();
    expect(r.status).toBe(200);
    expect(r.body.data.state).toBe('cancelled');
  });

  it('中止後に失敗した回答案内を再試行しても配信時に取り消され、催促・開催前リマインドも積まれない', async () => {
    const seg = await segment(null, ['3001']);
    let p = await published([seg.id]);
    const [job] = await deliveries(p.id, 'publish');
    await db.prepare("UPDATE planning_deliveries SET status='failed',error='Discord 403' WHERE id=?").bind(job.id).run();
    p = await ok(`/planning/${p.id}/cancel`, { version: p.version, reason: '中止' });
    p = await ok(`/planning/${p.id}/retry`, { version: p.version, delivery: job.id });
    await deliverPending(E, 10);
    expect((await deliveries(p.id, 'publish'))[0]).toMatchObject({ status: 'cancelled' });
    // 中止後の cron は催促（answer-dm/reminder）を積まない
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2099-08-31T12:00:00Z'));
    await planningTick(E);
    expect((await deliveries(p.id)).map((d) => d.kind)).toEqual(['publish']);
  });
});

describe('単発日程調整: 旧データ（公開後も全設定を直せた頃に公開した単発）', () => {
  it('回答の途中で区分・ロールが変わった旧データ: 名前の変更・再投稿・催促・選定は今の対象者で動く', async () => {
    const seg = await segment('4001');
    let p = await published([seg.id], { announceMention: 'role' });
    // 旧ルールで公開後に対象を差し替えた形: もう対象でない 'gone' の回答が残り、mentionRoles は古いロール
    const row = await db.prepare('SELECT data FROM planning_plans WHERE id=?').bind(p.id).first<any>();
    const data = JSON.parse(row.data);
    const c = data.candidates.find((x: any) => x.active).id;
    data.answers.gone = { values: { [c]: '可' }, comment: '' };
    data.mentionRoles = ['999999'];
    await db.prepare('UPDATE planning_plans SET data=? WHERE id=?').bind(JSON.stringify(data), p.id).run();
    p = await ok(`/planning/${p.id}`);
    p = await ok(`/planning/${p.id}/settings`, { version: p.version, name: '改名', deadline: p.data.deadline, note: p.data.note });
    expect(p.data.name).toBe('改名');
    // 再投稿は今の区分のロールを読み直す
    await db.prepare("UPDATE planning_deliveries SET status='sent' WHERE plan_id=?").bind(p.id).run();
    p = await ok(`/planning/${p.id}/repost`, { version: p.version });
    expect(JSON.parse((await deliveries(p.id, 'repost'))[0].payload).allowed_mentions).toEqual({ parse: [], roles: ['4001'] });
    // 対象でない人は選定できない
    const bad = await planReq(`/planning/${p.id}/selection`, {
      version: p.version, slots: [{ candidate: c, members: [{ user: 'gone', schedule: seg.id, status: '参加', duty: '' }] }],
    });
    expect(bad.status).toBe(400);
    // 催促 DM は今の対象者（ロール保有者 3001/3002）の未回答者だけ
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2099-08-30T11:30:00Z')); // JST 08-30 20:30（締切 09-01 09:00 の 2 日前）
    await planningTick(E);
    const dms = (await deliveries(p.id, 'answer-dm')).map((d) => JSON.parse(d.payload).user).sort();
    expect(dms).toEqual(['3001', '3002']);
  });
});
