// 単発日程調整（oneOff）のエッジケース。挙動の根拠: src/planning/admin.ts のコメント・docs/dev/planning-settings-matrix.md・docs/dev/CONTEXT.md
import { afterEach, describe, it, expect, vi } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import { handleAdmin } from '../src/admin';
import { getPlan } from '../src/planning/store';
import { planningTick } from '../src/planning/cron';
import { deliverPending } from '../src/planning/delivery';
import { planningInteraction } from '../src/planning/interactions';
import { handlePlanningAnswer } from '../src/planning/web-answer';
import { openWebAnswer, answerRequest, ORIGIN } from './planning-web-client';

const G = '12345678901';
const OTHER = '98765432109';
const db = env.DB;
const E = () => ({ ...env, MOCK_DISCORD: '1', ADMIN_TOKEN: 'planning-test-token' }) as unknown as Env;
/** Real Discord code paths with a stubbed fetch: channels are looked up in `channels`. */
const LIVE = () => ({ ...E(), MOCK_DISCORD: undefined, DISCORD_BOT_TOKEN: 'dummy' }) as unknown as Env;
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

type Channel = { guild_id: string; type: number; flags?: number; available_tags?: { id: string }[] };
const CHANNELS: Record<string, Channel> = {
  '111111': { guild_id: G, type: 0 },
  '222222': { guild_id: G, type: 15 },
  '333333': { guild_id: G, type: 0 },
  '444444': { guild_id: OTHER, type: 0 },
  '555555': { guild_id: OTHER, type: 15 },
  '666666': { guild_id: G, type: 15, flags: 16, available_tags: [{ id: '777777' }] },
};
function discordStub() {
  const calls: { path: string; method: string; body: any }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname.replace(/^\/api\/v\d+/, '');
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, method, body });
    const ch = path.match(/^\/channels\/(\d+)$/);
    if (ch && method === 'GET') {
      const c = CHANNELS[ch[1]];
      return c ? Response.json({ id: ch[1], ...c }) : Response.json({ id: ch[1], thread_metadata: { archived: false } });
    }
    if (path.endsWith('/threads')) return Response.json({ id: '888888', message: { id: '999999' } });
    return Response.json({ id: '999999' });
  }));
  return calls;
}

async function request(path: string, body?: object, e: Env = E()) {
  return handleAdmin(
    new Request(`https://test.invalid/api/admin${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer planning-test-token', 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    }),
    e,
  );
}
async function ok(path: string, body?: object, e?: Env): Promise<any> {
  const r = await request(path, body, e);
  const value: any = await r.json();
  expect(r.status, JSON.stringify(value)).toBe(200);
  return value;
}
async function status(path: string, body?: object, e?: Env) {
  return (await request(path, body, e)).status;
}
const count = async (sql: string, ...args: unknown[]) =>
  (await db.prepare(sql).bind(...args).first<any>()).n as number;

async function seed() {
  await db.prepare(
    "INSERT INTO segments(id,guild_id,name,uuid) VALUES(8001,?,'キャスト','oneoff-cast'),(8002,?,'スタッフ','oneoff-staff'),(8003,?,'空','oneoff-empty'),(9001,?,'他サーバー','oneoff-other')",
  ).bind(G, G, G, OTHER).run();
  for (let i = 1; i <= 5; i++) {
    await db.prepare('INSERT INTO members(user_id,user_name) VALUES(?,?)').bind(`person${i}`, `回答者${i}`).run();
    await db.prepare("INSERT INTO segment_members(segment_id,user_id,status) VALUES(8001,?,'')").bind(`person${i}`).run();
  }
  await db.prepare("INSERT INTO members(user_id,user_name) VALUES('paused1','休止者'),('outsider','他サーバーの人')").run();
  await db.prepare(
    "INSERT INTO segment_members(segment_id,user_id,status) VALUES(8002,'person1',''),(8002,'paused1','休止中'),(9001,'outsider','')",
  ).run();
}
const SETTINGS = {
  guild_id: G, oneOff: true, name: '単発の日程調整', segments: [8001], channel: '111111', forum: '222222', tag: '',
  deadline: '2099-09-01T00:00:00Z', note: '補足', remindDays: 0, announceMention: 'none', shareAnswers: false, eventReminderHours: 2,
  answerReminder: { enabled: true, beforeDays: 2, intervalDays: 1, time: '20:00', target: 'dm' },
};
const create = (x: object = {}, e?: Env) => ok('/planning', { ...SETTINGS, ...x }, e);
const plans = () => count('SELECT COUNT(*) AS n FROM planning_plans');
async function published(x: object = {}, candidates = [{ date: '2099-09-10', time: '19:00' }, { date: '2099-09-11', time: '19:00' }]) {
  let p = await create(x);
  p = await ok(`/planning/${p.id}/candidates`, { version: p.version, candidates });
  return ok(`/planning/${p.id}/publish`, { version: p.version });
}
async function answerAll(p: any, users: string[], value = '可') {
  for (const user of users)
    p = await ok(`/planning/${p.id}/answer`, {
      version: p.version, user, values: Object.fromEntries(p.data.candidates.filter((c: any) => c.active).map((c: any) => [c.id, value])),
    });
  return p;
}
const slot = (candidate: string, users: string[], schedule = 8001) => ({
  candidate, members: users.map((user) => ({ user, schedule, status: '参加', duty: '' })), gather: '', note: '', cancelled: false,
});
/** Move a plan's deadline into the past without the API (the API refuses a past deadline at publish). */
async function expire(id: string) {
  await db.prepare("UPDATE planning_plans SET data=json_set(data,'$.deadline',?),version=version+1 WHERE id=?")
    .bind(new Date(Date.now() - 60000).toISOString(), id).run();
  return getPlan(db, id);
}
function interaction(p: any, user: string, guild: string | undefined = p.guild_id) {
  return planningInteraction(
    { type: 3, ...(guild ? { guild_id: guild, member: { user: { id: user } } } : { user: { id: user } }), data: { custom_id: `plan:open:${p.id}:0` } },
    E(), ORIGIN,
  );
}
const replyText = (r: any) => JSON.stringify(r.data.components);

describe('one-off creation validation', () => {
  it('rejects empty, missing, malformed, oversized and foreign segments without creating a row', async () => {
    await seed();
    for (const segments of [[], undefined, null, ['8001'], [0], [-1], [1.5], Array.from({ length: 11 }, (_, i) => 8001 + i), [8001, 9001], [9001], [424242]])
      expect(await status('/planning', { ...SETTINGS, segments }), JSON.stringify(segments)).toBe(400);
    // Segments of this guild requested under another guild id
    expect(await status('/planning', { ...SETTINGS, guild_id: OTHER })).toBe(400);
    expect(await plans()).toBe(0);
    // Duplicates collapse
    const p = await create({ segments: [8001, 8001] });
    expect(p.data.segments).toEqual([8001]);
  });

  it('rejects malformed channel and forum ids (mock Discord validates only the shape)', async () => {
    await seed();
    for (const x of [{ channel: '' }, { channel: 'abc' }, { channel: '1234' }, { channel: 111111 }, { forum: '' }, { forum: undefined }, { channel: undefined }])
      expect(await status('/planning', { ...SETTINGS, ...x }), JSON.stringify(x)).toBe(400);
    expect(await plans()).toBe(0);
  });

  it('rejects channels and forums of another guild, wrong channel types and missing/unknown forum tags', async () => {
    await seed();
    discordStub();
    for (const x of [
      { channel: '444444' }, // text channel of another guild
      { forum: '555555' }, // forum of another guild
      { channel: '222222' }, // a forum as the answer channel
      { forum: '111111' }, // a text channel as the forum
      { forum: '666666' }, // forum requires a tag
      { forum: '666666', tag: '123456' }, // tag not in the forum
    ])
      expect(await status('/planning', { ...SETTINGS, ...x }, LIVE()), JSON.stringify(x)).toBe(400);
    expect(await plans()).toBe(0);
    const p = await create({ forum: '666666', tag: '777777' }, LIVE());
    expect(p.data.tag).toBe('777777');
  });

  it('accepts a past or empty deadline for a draft but refuses to publish it until the draft is fixed', async () => {
    await seed();
    expect(await status('/planning', { ...SETTINGS, deadline: 'not a date' })).toBe(400);
    let p = await create({ deadline: '2000-01-01T00:00:00Z' });
    expect(p.data.state).toBe('draft');
    p = await ok(`/planning/${p.id}/candidates`, { version: p.version, candidates: [{ date: '2099-09-10', time: '19:00' }] });
    expect(await status(`/planning/${p.id}/publish`, { version: p.version })).toBe(400);
    p = await ok(`/planning/${p.id}/settings`, { ...SETTINGS, version: p.version, deadline: '2099-09-01T09:00:00+09:00' });
    expect(p.data.deadline).toBe('2099-09-01T00:00:00.000Z');
    p = await ok(`/planning/${p.id}/publish`, { version: p.version });
    expect(p.data.state).toBe('open');
    const empty = await create({ deadline: '' });
    const withCandidate = await ok(`/planning/${empty.id}/candidates`, { version: empty.version, candidates: [{ date: '2099-09-10', time: '19:00' }] });
    expect(await status(`/planning/${empty.id}/publish`, { version: withCandidate.version })).toBe(400);
  });

  it('bounds eventReminderHours to integers 0..168', async () => {
    await seed();
    for (const eventReminderHours of [-1, 169, 1.5, '2', null, true])
      expect(await status('/planning', { ...SETTINGS, eventReminderHours }), String(eventReminderHours)).toBe(400);
    for (const eventReminderHours of [0, 1, 168])
      expect((await create({ eventReminderHours })).data.eventReminderHours).toBe(eventReminderHours);
  });

  it('validates the answer reminder shape and normalizes the target', async () => {
    await seed();
    const base = SETTINGS.answerReminder;
    for (const answerReminder of [
      null, {}, 'on', { ...base, enabled: 'true' }, { ...base, beforeDays: 31 }, { ...base, beforeDays: -1 }, { ...base, beforeDays: 1.5 },
      { ...base, intervalDays: 0 }, { ...base, intervalDays: 31 }, { ...base, time: '24:00' }, { ...base, time: '9:00' }, { ...base, time: undefined },
      { ...base, target: 'email' },
    ])
      expect(await status('/planning', { ...SETTINGS, answerReminder }), JSON.stringify(answerReminder)).toBe(400);
    expect((await create({ answerReminder: { ...base, target: undefined } })).data.answerReminder.target).toBe('dm');
    expect((await create({ answerReminder: { ...base, target: 'channel', extra: 'x' } })).data.answerReminder)
      .toEqual({ enabled: true, beforeDays: 2, intervalDays: 1, time: '20:00', target: 'channel' });
  });

  it('rejects blank or oversized text and invalid communication choices', async () => {
    await seed();
    for (const x of [
      { name: '' }, { name: '   ' }, { name: undefined }, { name: 'x'.repeat(151) }, { note: 'x'.repeat(1001) },
      { announceMention: 'everyone' }, { shareAnswers: 'yes' }, { remindDays: 31 }, { remindDays: -1 }, { tag: 'x'.repeat(31) },
    ])
      expect(await status('/planning', { ...SETTINGS, ...x }), JSON.stringify(x)).toBe(400);
    expect(await plans()).toBe(0);
    expect((await create({ name: '  前後の空白  ' })).data.name).toBe('前後の空白');
  });

  it('uses the segment names current at publication, not those captured when the draft was created', async () => {
    await seed();
    let p = await create();
    await db.prepare("UPDATE segments SET name='キャスト（改）' WHERE id=8001").run();
    p = await ok(`/planning/${p.id}/candidates`, { version: p.version, candidates: [{ date: '2099-09-10', time: '19:00' }] });
    p = await ok(`/planning/${p.id}/publish`, { version: p.version });
    expect(p.data.scheduleNames['8001']).toBe('キャスト（改）');
  });
  it('ignores a profileId on a one-off and keeps the one-off markers', async () => {
    await seed();
    const p = await create({ profileId: 'some-profile', standalone: false, state: 'open', people: [{ id: 'x', name: 'x', schedules: [8001] }], answers: { x: {} } });
    expect([p.data.oneOff, p.data.standalone, p.data.profileId, p.data.profileName, p.data.state]).toEqual([true, true, undefined, undefined, 'draft']);
    expect(p.data.people.map((x: any) => x.id).sort()).toEqual(['person1', 'person2', 'person3', 'person4', 'person5']);
    expect(p.data.answers).toEqual({});
    expect(p.data.scheduleNames).toEqual({ '8001': 'キャスト' });
  });

  it('excludes paused members, merges people across segments and caps the audience at 200', async () => {
    await seed();
    const p = await create({ segments: [8001, 8002] });
    expect(p.data.people.find((x: any) => x.id === 'person1').schedules).toEqual([8001, 8002]);
    expect(p.data.people.some((x: any) => x.id === 'paused1')).toBe(false);
    await db.prepare("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<201) INSERT INTO members(user_id,user_name) SELECT 'bulk'||i,'bulk' FROM n").run();
    await db.prepare("INSERT INTO segment_members(segment_id,user_id,status) SELECT 8003,user_id,'' FROM members WHERE user_id LIKE 'bulk%'").run();
    expect(await status('/planning', { ...SETTINGS, segments: [8003] })).toBe(400);
  });

  it('creates a draft without anyone to ask but refuses to publish it, leaving no delivery', async () => {
    await seed();
    let p = await create({ segments: [8003] });
    expect(p.data.people).toEqual([]);
    p = await ok(`/planning/${p.id}/candidates`, { version: p.version, candidates: [{ date: '2099-09-10', time: '19:00' }] });
    const r = await request(`/planning/${p.id}/publish`, { version: p.version });
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error).toContain('回答対象者がいません');
    expect((await getPlan(db, p.id)).data.state).toBe('draft');
    expect(await count('SELECT COUNT(*) AS n FROM planning_deliveries')).toBe(0);
  });
});

describe('the UI create sequence: POST /planning → /candidates → /publish', () => {
  it('publishes once, records the origin and queues exactly one answer announcement', async () => {
    await seed();
    const p = await published();
    expect(p.data.state).toBe('open');
    expect(p.data.answerOrigin).toBe('https://test.invalid');
    expect(await count("SELECT COUNT(*) AS n FROM planning_deliveries WHERE plan_id=? AND kind='publish'", p.id)).toBe(1);
    expect(await status(`/planning/${p.id}/publish`, { version: p.version })).toBe(400);
    const kinds = (await db.prepare('SELECT kind FROM planning_history WHERE plan_id=? ORDER BY id').bind(p.id).all<any>()).results.map((x) => x.kind);
    expect(kinds).toEqual(['candidates', 'publish']);
  });

  it('keeps a consistent draft when a step fails and lets the operator retry with the current version', async () => {
    await seed();
    let p = await create();
    const created = p.version;
    // Step 2 fails (date-only candidate, duplicate, invalid date, too many)
    for (const candidates of [[{ date: '2099-09-10', time: '' }], [{ date: '2099-09-10', time: '19:00' }, { date: '2099-09-10', time: '19:00' }],
      [{ date: '2099-02-30', time: '19:00' }], [], 'x', Array.from({ length: 201 }, (_, i) => ({ date: `2099-01-01`, time: `${String(i % 24).padStart(2, '0')}:${String(Math.floor(i / 24)).padStart(2, '0')}` }))])
      expect(await status(`/planning/${p.id}/candidates`, { version: p.version, candidates }), JSON.stringify(candidates).slice(0, 80)).toBe(400);
    p = await ok(`/planning/${p.id}`);
    expect([p.version, p.data.candidates, p.data.state]).toEqual([created, [], 'draft']);
    // Publishing before any candidate exists is refused
    expect(await status(`/planning/${p.id}/publish`, { version: p.version })).toBe(400);
    p = await ok(`/planning/${p.id}/candidates`, { version: p.version, candidates: [{ date: '2099-09-10', time: '19:00' }] });
    // A stale version (e.g. the client kept the creation response) is a conflict, not a second publish
    expect(await status(`/planning/${p.id}/publish`, { version: created })).toBe(409);
    expect(await status(`/planning/${p.id}/publish`, {})).toBe(409);
    p = await ok(`/planning/${p.id}/publish`, { version: p.version });
    expect(p.data.state).toBe('open');
    expect(await count('SELECT COUNT(*) AS n FROM planning_deliveries WHERE plan_id=?', p.id)).toBe(1);
  });

  it('rereads the audience at publication (pauses and joins between creation and publication)', async () => {
    await seed();
    let p = await create();
    await db.prepare("UPDATE segment_members SET status='休止中' WHERE segment_id=8001 AND user_id='person5'").run();
    await db.prepare("INSERT INTO members(user_id,user_name) VALUES('late','後から')").run();
    await db.prepare("INSERT INTO segment_members(segment_id,user_id,status) VALUES(8001,'late','')").run();
    p = await ok(`/planning/${p.id}/candidates`, { version: p.version, candidates: [{ date: '2099-09-10', time: '19:00' }] });
    p = await ok(`/planning/${p.id}/publish`, { version: p.version });
    const ids = p.data.people.map((x: any) => x.id);
    expect(ids).toContain('late');
    expect(ids).not.toContain('person5');
  });

  it('a publish whose Discord channel check fails leaves the draft untouched', async () => {
    await seed();
    let p = await create();
    p = await ok(`/planning/${p.id}/candidates`, { version: p.version, candidates: [{ date: '2099-09-10', time: '19:00' }] });
    discordStub();
    CHANNELS['111111'].guild_id = OTHER; // the channel moved / is not visible in this guild any more
    try {
      expect(await status(`/planning/${p.id}/publish`, { version: p.version }, LIVE())).toBe(400);
    } finally {
      CHANNELS['111111'].guild_id = G;
    }
    expect((await getPlan(db, p.id)).version).toBe(p.version);
    expect(await count('SELECT COUNT(*) AS n FROM planning_deliveries')).toBe(0);
    expect((await ok(`/planning/${p.id}/publish`, { version: p.version }, LIVE())).data.state).toBe('open');
  });
});

describe('draft edits', () => {
  it('recollects people only when the segments change and rejects foreign segments atomically', async () => {
    await seed();
    let p = await create({ segments: [8001] });
    p = await ok(`/planning/${p.id}/settings`, { ...SETTINGS, version: p.version, segments: [8002] });
    expect(p.data.people.map((x: any) => x.id)).toEqual(['person1']);
    expect(p.data.scheduleNames).toEqual({ '8002': 'スタッフ' });
    const before = p;
    expect(await status(`/planning/${p.id}/settings`, { ...SETTINGS, version: p.version, segments: [9001], name: '変更' })).toBe(400);
    expect(await status(`/planning/${p.id}/settings`, { ...SETTINGS, version: p.version, segments: [] })).toBe(400);
    p = await ok(`/planning/${p.id}`);
    expect([p.version, p.data.name, p.data.segments]).toEqual([before.version, before.data.name, [8002]]);
    p = await ok(`/planning/${p.id}/settings`, { ...SETTINGS, version: p.version, segments: [8002, 8001] });
    expect(p.data.people).toHaveLength(5);
    expect(p.data.people.find((x: any) => x.id === 'person1').schedules.sort()).toEqual([8001, 8002]);
  });

  it('validates a changed channel against the plan guild, never the guild in the request body', async () => {
    await seed();
    discordStub();
    let p = await create({}, LIVE());
    for (const x of [{ channel: '444444', guild_id: OTHER }, { forum: '555555', guild_id: OTHER }, { channel: '222222' }, { forum: '666666' }])
      expect(await status(`/planning/${p.id}/settings`, { ...SETTINGS, ...x, version: p.version }, LIVE()), JSON.stringify(x)).toBe(400);
    p = await ok(`/planning/${p.id}/settings`, { ...SETTINGS, channel: '333333', guild_id: OTHER, version: p.version }, LIVE());
    expect([p.guild_id, p.data.channel]).toEqual([G, '333333']);
  });

  it('cannot turn a one-off into a template-based plan or inject template fields', async () => {
    await seed();
    let p = await create();
    p = await ok(`/planning/${p.id}/settings`, { ...SETTINGS, version: p.version, oneOff: false, profileId: 'p', schedules: [1], standalone: false });
    expect([p.data.oneOff, p.data.standalone, p.data.profileId, p.data.schedules]).toEqual([true, true, undefined, []]);
  });

  it('serializes concurrent edits by version', async () => {
    await seed();
    const p = await create();
    const [a, b] = await Promise.all([
      request(`/planning/${p.id}/settings`, { ...SETTINGS, version: p.version, name: 'A' }),
      request(`/planning/${p.id}/settings`, { ...SETTINGS, version: p.version, name: 'B' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await status(`/planning/${p.id}/settings`, { ...SETTINGS, version: p.version + 5 })).toBe(409);
    expect(await status(`/planning/${p.id}/settings`, { ...SETTINGS, version: String(p.version) })).toBe(409);
  });
});

describe('after publication', () => {
  it('changes only the name and note; every other field is ignored and the deadline is locked', async () => {
    await seed();
    let p = await published();
    const before = p.data;
    p = await ok(`/planning/${p.id}/settings`, {
      ...SETTINGS, version: p.version, name: '改名', note: '補足2', segments: [8002], channel: '333333', forum: '666666', tag: '777777',
      eventReminderHours: 0, shareAnswers: true, announceMention: 'role', answerReminder: { enabled: false, beforeDays: 0, intervalDays: 1, time: '01:00' },
      announcementTemplate: '別の本文',
    });
    expect([p.data.name, p.data.note]).toEqual(['改名', '補足2']);
    for (const k of ['segments', 'channel', 'forum', 'tag', 'eventReminderHours', 'shareAnswers', 'announceMention', 'answerReminder', 'announcementTemplate', 'people', 'deadline'])
      expect(p.data[k], k).toEqual(before[k]);
    // Same instant in another notation is not a change
    p = await ok(`/planning/${p.id}/settings`, { ...SETTINGS, version: p.version, name: '改名', deadline: '2099-09-01T09:00:00+09:00' });
    for (const deadline of ['2099-09-02T00:00:00Z', '', undefined])
      expect(await status(`/planning/${p.id}/settings`, { ...SETTINGS, version: p.version, deadline }), String(deadline)).toBe(400);
    expect((await getPlan(db, p.id)).data.deadline).toBe('2099-09-01T00:00:00.000Z');
  });

  it('still edits the name after the deadline passed, and refuses settings once confirmed or cancelled', async () => {
    await seed();
    let p = await published();
    p = await answerAll(p, ['person1']);
    p = await expire(p.id);
    p = await ok(`/planning/${p.id}/settings`, { ...SETTINGS, version: p.version, name: '締切後の改名', deadline: p.data.deadline });
    expect(p.data.name).toBe('締切後の改名');
    p = await ok(`/planning/${p.id}/confirm-selection`, { version: p.version, slots: [slot(p.data.candidates[0].id, ['person1'])] });
    expect(await status(`/planning/${p.id}/settings`, { ...SETTINGS, version: p.version, deadline: p.data.deadline })).toBe(400);
    p = await ok(`/planning/${p.id}/cancel`, { version: p.version });
    expect(await status(`/planning/${p.id}/settings`, { ...SETTINGS, version: p.version, deadline: p.data.deadline })).toBe(400);
  });

  it('candidate changes while open re-post, keep answers, drop selections of removed candidates and close at the deadline', async () => {
    await seed();
    let p = await published();
    const [c1, c2] = p.data.candidates.map((c: any) => c.id);
    p = await answerAll(p, ['person1', 'person2']);
    p = await ok(`/planning/${p.id}/selection`, { version: p.version, slots: [slot(c1, ['person1']), slot(c2, ['person2'])] });
    p = await ok(`/planning/${p.id}/candidates`, { version: p.version, candidates: [{ date: '2099-09-11', time: '19:00' }, { date: '2099-09-12', time: '20:00' }] });
    expect(p.data.candidates.filter((c: any) => c.active).map((c: any) => c.id)).toEqual([c2, 'c3']);
    expect(p.data.slots.map((s: any) => s.candidate)).toEqual([c2]);
    expect(p.data.answers.person1.values).toEqual({ [c1]: '可', [c2]: '可' });
    const job = await db.prepare("SELECT payload FROM planning_deliveries WHERE plan_id=? AND kind='candidates'").bind(p.id).first<any>();
    expect(JSON.parse(job.payload).content).toContain('追加1件');
    // An inactive candidate cannot be answered or selected
    expect(await status(`/planning/${p.id}/answer`, { version: p.version, user: 'person1', values: { [c1]: '不可' } })).toBe(400);
    expect(await status(`/planning/${p.id}/selection`, { version: p.version, slots: [slot(c1, ['person1'])] })).toBe(400);
    // Re-adding a removed date/time creates a new candidate (answers to the old id are not revived)
    p = await ok(`/planning/${p.id}/candidates`, { version: p.version, candidates: [{ date: '2099-09-10', time: '19:00' }] });
    expect(p.data.candidates.filter((c: any) => c.active).map((c: any) => c.id)).toEqual(['c4']);
    p = await expire(p.id);
    expect(await status(`/planning/${p.id}/candidates`, { version: p.version, candidates: [{ date: '2099-09-10', time: '19:00' }] })).toBe(400);
  });
});

describe('repost', () => {
  it('waits for the announcement to resolve, and is allowed only while open or confirmed', async () => {
    await seed();
    let draft = await create();
    expect(await status(`/planning/${draft.id}/repost`, { version: draft.version })).toBe(400);
    let p = await published();
    expect(await status(`/planning/${p.id}/repost`, { version: p.version })).toBe(409);
    await deliverPending(E(), 10);
    p = await ok(`/planning/${p.id}/repost`, { version: p.version });
    await deliverPending(E(), 10);
    p = await answerAll(p, ['person1']);
    p = await ok(`/planning/${p.id}/confirm-selection`, { version: p.version, slots: [slot(p.data.candidates[0].id, ['person1'])] });
    p = await ok(`/planning/${p.id}/repost`, { version: p.version });
    await deliverPending(E(), 10);
    p = await ok(`/planning/${p.id}/cancel`, { version: p.version });
    expect(await status(`/planning/${p.id}/repost`, { version: p.version })).toBe(400);
    draft = await ok(`/planning/${draft.id}/cancel`, { version: draft.version });
    expect(draft.data.state).toBe('cancelled');
  });
});

describe('answering via the Discord button', () => {
  it('issues a link only to current members of the plan guild, including via DM', async () => {
    await seed();
    const draft = await create();
    expect(replyText(await interaction(draft, 'person1'))).toContain('回答受付はまだ始まっていません');
    const p = await published({ segments: [8001, 8002] });
    expect(replyText(await interaction(p, 'person1'))).toContain('answer.html');
    expect(replyText(await interaction(p, 'person1', undefined))).toContain('answer.html'); // DM
    for (const [user, guild] of [['outsider', G], ['paused1', G], ['person1', OTHER], ['nobody', G]] as const)
      expect(replyText(await interaction(p, user, guild)), `${user}@${guild}`).toContain('この回答の対象者ではありません');
    // A member paused after publication keeps answering (the audience is a snapshot until 対象者を更新)
    await db.prepare("UPDATE segment_members SET status='休止中' WHERE user_id='person2'").run();
    expect(replyText(await interaction(p, 'person2'))).toContain('answer.html');
  });

  it('accepts web answers before the deadline only, while the admin can still answer by proxy', async () => {
    await seed();
    let p = await published();
    const s = await openWebAnswer(p, E(), 'person1');
    const values = Object.fromEntries(s.snapshot.candidates.map((c) => [c.id, '可']));
    let r = await handlePlanningAnswer(answerRequest(p.id, s.cookie, { version: s.snapshot.version, values, comment: '' }), E());
    expect(r.status).toBe(200);
    p = await expire(p.id);
    const again = await openWebAnswer(p, E(), 'person2');
    expect(again.snapshot.closed).toBe(true);
    r = await handlePlanningAnswer(answerRequest(p.id, again.cookie, { version: again.snapshot.version, values, comment: '' }), E());
    expect(r.status).toBe(409);
    p = await ok(`/planning/${p.id}/answer`, { version: p.version, user: 'person2', values, reason: '電話で受付' });
    expect(p.data.answers.person2.values).toEqual(values);
    for (const body of [{ user: 'outsider', values }, { user: 'person2', values: { c1: 'yes' } }, { user: 'person2', values: null }, { user: 'person2', values: { nope: '可' } }])
      expect(await status(`/planning/${p.id}/answer`, { version: p.version, ...body }), JSON.stringify(body)).toBe(400);
    // The answer reminder never fires after the deadline
    expect(await count("SELECT COUNT(*) AS n FROM planning_deliveries WHERE kind IN ('answer-dm','reminder')")).toBe(0);
  });

  it('a one-off with DM reminders queues one DM per unanswered person; the channel target posts mentions', async () => {
    await seed();
    const soon = new Date(Date.now() + 86400000).toISOString();
    let p = await published({ deadline: soon, answerReminder: { enabled: true, beforeDays: 3, intervalDays: 1, time: '00:00', target: 'dm' } });
    p = await answerAll(p, ['person1', 'person2']);
    await planningTick(E());
    const dms = (await db.prepare("SELECT payload FROM planning_deliveries WHERE kind='answer-dm' AND plan_id=?").bind(p.id).all<any>()).results.map((x) => JSON.parse(x.payload).user).sort();
    expect(dms).toEqual(['person3', 'person4', 'person5']);
    const q = await published({ deadline: soon, answerReminder: { enabled: true, beforeDays: 3, intervalDays: 1, time: '00:00', target: 'channel' } });
    await db.prepare("UPDATE planning_plans SET reminder_checked_at='9999' WHERE id=?").bind(p.id).run();
    await planningTick(E());
    const job = await db.prepare("SELECT payload FROM planning_deliveries WHERE kind='reminder' AND plan_id=?").bind(q.id).first<any>();
    expect(JSON.parse(job.payload).allowed_mentions.users).toHaveLength(5);
  });
});

describe('confirmation and forum posts', () => {
  it('validates selections strictly and confirms once, without creating occurrences', async () => {
    await seed();
    let p = await published({ segments: [8001, 8002] });
    const [c1, c2] = p.data.candidates.map((c: any) => c.id);
    p = await answerAll(p, ['person1', 'person2']);
    p = await ok(`/planning/${p.id}/answer`, { version: p.version, user: 'person3', values: { [c1]: '未定', [c2]: '不可' } });
    for (const slots of [
      [], undefined, [slot(c1, ['person3'])], // not 可
      [slot(c1, ['person1']), slot(c1, ['person2'])], // duplicate candidate
      [slot('c99', ['person1'])], // unknown candidate
      [slot(c1, ['person2'], 8002)], // person2 is not in staff
      [slot(c1, ['outsider'])], // not in the audience
      [{ ...slot(c1, ['person1']), members: [{ user: 'person1', schedule: 8001, status: '除外', duty: '' }] }], // nobody 参加
      [{ ...slot(c1, ['person1']), members: [{ user: 'person1', schedule: 8001, status: '参加', duty: '' }, { user: 'person1', schedule: 8001, status: '参加', duty: '' }] }],
      [{ ...slot(c1, ['person1']), members: [{ user: 'person1', schedule: 8001, status: '遅刻', duty: '' }] }],
    ])
      expect(await status(`/planning/${p.id}/confirm-selection`, { version: p.version, slots }), JSON.stringify(slots)).toBe(400);
    expect((await getPlan(db, p.id)).data.state).toBe('open');
    p = await ok(`/planning/${p.id}/confirm-selection`, {
      version: p.version,
      slots: [slot(c1, ['person1', 'person2']), { ...slot(c2, ['person1'], 8002), members: [{ user: 'person1', schedule: 8002, status: '参加', duty: '受付' }, { user: 'person3', schedule: 8001, status: '除外', duty: '' }] }],
    });
    expect(p.data.state).toBe('confirmed');
    expect(p.data.slots.map((s: any) => s.schedules)).toEqual([[8001], [8002, 8001]]);
    for (const table of ['occurrences', 'planning_occurrences', 'planning_roster', 'notifications'])
      expect(await count(`SELECT COUNT(*) AS n FROM ${table}`), table).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM planning_deliveries WHERE kind='forum' AND plan_id=?", p.id)).toBe(2);
    for (const action of ['confirm', 'confirm-selection', 'selection', 'candidates', 'answer'])
      expect(await status(`/planning/${p.id}/${action}`, { version: p.version, slots: [slot(c1, ['person1'])], candidates: [{ date: '2099-09-10', time: '19:00' }], user: 'person1', values: {} }), action).toBe(400);
  });

  it('a draft cannot be confirmed (no answers exist yet)', async () => {
    await seed();
    let p = await create();
    p = await ok(`/planning/${p.id}/candidates`, { version: p.version, candidates: [{ date: '2099-09-10', time: '19:00' }] });
    expect(await status(`/planning/${p.id}/confirm-selection`, { version: p.version, slots: [slot('c1', ['person1'])] })).toBe(400);
    expect(await status(`/planning/${p.id}/answer`, { version: p.version, user: 'person1', values: { c1: '可' } })).toBe(400);
  });

  it('confirm via a saved selection, then posts one forum thread per slot with the tag and only 参加 mentions', async () => {
    await seed();
    const calls = discordStub();
    let p = await published({ forum: '666666', tag: '777777' });
    const [c1] = p.data.candidates.map((c: any) => c.id);
    p = await answerAll(p, ['person1', 'person2']);
    p = await ok(`/planning/${p.id}/selection`, {
      version: p.version,
      slots: [{ ...slot(c1, ['person1']), members: [{ user: 'person1', schedule: 8001, status: '参加', duty: '' }, { user: 'person2', schedule: 8001, status: '未定', duty: '' }] }],
    });
    // The forum is checked against Discord at confirmation
    CHANNELS['666666'].guild_id = OTHER;
    try {
      expect(await status(`/planning/${p.id}/confirm`, { version: p.version }, LIVE())).toBe(400);
    } finally {
      CHANNELS['666666'].guild_id = G;
    }
    p = await ok(`/planning/${p.id}/confirm`, { version: p.version }, LIVE());
    await deliverPending(LIVE(), 10);
    const thread = calls.filter((c) => c.path === '/channels/666666/threads');
    expect(thread).toHaveLength(1);
    expect(thread[0].body.applied_tags).toEqual(['777777']);
    expect(thread[0].body.message.allowed_mentions.users).toEqual(['person1']);
  });
});

describe('event reminder (cron)', () => {
  async function confirmedSoon(hoursAhead: number, eventReminderHours: number) {
    const start = new Date(Date.now() + hoursAhead * 3600000 + 9 * 3600000).toISOString();
    let p = await published({ deadline: new Date(Date.now() + 600000).toISOString(), eventReminderHours }, [{ date: start.slice(0, 10), time: start.slice(11, 16) }]);
    p = await answerAll(p, ['person1']);
    return ok(`/planning/${p.id}/confirm-selection`, { version: p.version, slots: [slot(p.data.candidates[0].id, ['person1'])] });
  }
  const reminders = (id: string) => db.prepare("SELECT status FROM planning_deliveries WHERE kind='event-reminder' AND plan_id=?").bind(id).all<any>().then((r) => r.results.map((x) => x.status));

  it('posts once to the slot thread inside the window, and never outside it or when disabled', async () => {
    await seed();
    const calls = discordStub();
    const inside = await confirmedSoon(1, 2);
    const outside = await confirmedSoon(5, 2);
    const off = await confirmedSoon(1, 0);
    await deliverPending(LIVE(), 20); // forum threads
    for (let i = 0; i < 3; i++) await planningTick(LIVE());
    expect(await reminders(inside.id)).toEqual(['sent']);
    expect(await reminders(outside.id)).toEqual([]);
    expect(await reminders(off.id)).toEqual([]);
    const posts = calls.filter((c) => c.path === '/channels/888888/messages' && c.method === 'POST' && c.body.content?.includes('開催前リマインド'));
    expect(posts).toHaveLength(1);
  });

  it('a reminder queued before the forum thread exists waits for it, and is cancelled when the plan is cancelled', async () => {
    await seed();
    const calls = discordStub();
    let p = await confirmedSoon(1, 2);
    // Simulate a forum post that failed: no thread, so the reminder can only wait
    await db.prepare("UPDATE planning_deliveries SET status='failed',error='Discord 403' WHERE kind='forum' AND plan_id=?").bind(p.id).run();
    await planningTick(LIVE());
    expect(await reminders(p.id)).toEqual(['pending']);
    p = await ok(`/planning/${p.id}/cancel`, { version: p.version, reason: '中止' }, LIVE());
    expect(p.data.slots.every((s: any) => s.cancelled)).toBe(true);
    await planningTick(LIVE());
    expect(await reminders(p.id)).toEqual(['cancelled']);
    expect(calls.some((c) => c.body?.content?.includes('開催前リマインド'))).toBe(false);
    // Cron never re-queues a reminder for the cancelled plan
    await planningTick(LIVE());
    expect(await reminders(p.id)).toEqual(['cancelled']);
  });
});

describe('cancel at each state', () => {
  it('cancels drafts, open plans (dropping the pending announcement) and confirmed plans (without posting never-posted slots)', async () => {
    await seed();
    const calls = discordStub();
    const draft = await create({}, LIVE());
    expect((await ok(`/planning/${draft.id}/cancel`, { version: draft.version }, LIVE())).data.state).toBe('cancelled');
    let open = await published();
    open = await ok(`/planning/${open.id}/cancel`, { version: open.version });
    expect(await db.prepare("SELECT status FROM planning_deliveries WHERE plan_id=? AND kind='publish'").bind(open.id).first<any>()).toEqual({ status: 'cancelled' });
    expect(await status(`/planning/${open.id}/cancel`, { version: open.version })).toBe(400);
    // The answer page shows a cancelled, closed plan
    const s = await openWebAnswer(open, E(), 'person1');
    expect([s.snapshot.cancelled, s.snapshot.closed]).toEqual([true, true]);
    let confirmed = await published();
    confirmed = await answerAll(confirmed, ['person1']);
    confirmed = await ok(`/planning/${confirmed.id}/confirm-selection`, { version: confirmed.version, slots: [slot(confirmed.data.candidates[0].id, ['person1'])] });
    confirmed = await ok(`/planning/${confirmed.id}/cancel`, { version: confirmed.version });
    calls.length = 0;
    await deliverPending(LIVE(), 20);
    expect(calls.some((c) => c.path.endsWith('/threads'))).toBe(false);
    // Once posted, a cancellation edits the thread to 【中止】
    let posted = await published();
    posted = await answerAll(posted, ['person1']);
    posted = await ok(`/planning/${posted.id}/confirm-selection`, { version: posted.version, slots: [slot(posted.data.candidates[0].id, ['person1'])] });
    await deliverPending(LIVE(), 20);
    posted = await ok(`/planning/${posted.id}/cancel`, { version: posted.version });
    calls.length = 0;
    await deliverPending(LIVE(), 20);
    const edit = calls.find((c) => c.method === 'PATCH' && c.path === '/channels/888888/messages/999999');
    expect(edit?.body.content).toContain('【中止】');
  });
});

describe('listing and isolation', () => {
  it('lists one-off and template-based plans per guild, each marked so the UI can split them', async () => {
    await seed();
    const one = await create();
    const profile = await ok('/planning/profiles', { guild_id: G, enabled: false, data: { name: 'テンプレ', segments: [8001], channel: '111111', forum: '222222', tag: '', remindDays: 0, rrule: '', anchor: '', time: '21:00', adminChannel: '', mentionMode: 'users', mentions: [] } });
    const templ = await ok('/planning', { guild_id: G, profileId: profile.id, name: '定期', deadline: '2099-09-01T00:00:00Z', note: '' });
    const list = await ok(`/planning?guild_id=${G}`);
    expect(list.map((x: any) => [x.id, !!x.data.oneOff]).sort()).toEqual([[one.id, true], [templ.id, false]].sort());
    expect(await ok(`/planning?guild_id=${OTHER}`)).toEqual([]);
    // A one-off is never a template
    expect((await ok(`/planning/profiles?guild_id=${G}`)).map((x: any) => x.id)).toEqual([profile.id]);
    // A template-based plan keeps its template-only path even if the body claims oneOff on settings
    const t = await ok(`/planning/${templ.id}/settings`, { ...SETTINGS, version: templ.version, oneOff: true, segments: [8002], channel: '333333' });
    expect([t.data.oneOff, t.data.segments, t.data.channel]).toEqual([undefined, [8001], '111111']);
  });

  it('unknown plan ids and actions are 404; GET of history/deliveries works for a one-off', async () => {
    await seed();
    const p = await published();
    expect(await status('/planning/does-not-exist')).toBe(404);
    expect(await status('/planning/does-not-exist/settings', { version: 1 })).toBe(404);
    expect(await status(`/planning/${p.id}/explode`, { version: p.version })).toBe(404);
    expect(await status(`/planning/${p.id}/roster`, { version: p.version })).toBe(404);
    expect((await ok(`/planning/${p.id}/history`)).length).toBeGreaterThan(0);
    expect((await ok(`/planning/${p.id}/deliveries`))[0].guild_id).toBe(G);
  });
});

describe('more edges', () => {
  // 修正済み 2026-10-11: an unchanged candidate list saved while open still queues a 'candidates' re-post (「追加0件」) to the whole channel.
  // docs/dev/planning-settings-matrix.md ※5: 「受付中に変更すると、回答案内を再投稿します」 — only a change should re-post.
  it('saving the same candidates while open does not re-post the announcement', async () => {
    await seed();
    let p = await published();
    await deliverPending(E(), 10);
    p = await ok(`/planning/${p.id}/candidates`, { version: p.version, candidates: p.data.candidates.map((c: any) => ({ date: c.date, time: c.time })) });
    expect(await count("SELECT COUNT(*) AS n FROM planning_deliveries WHERE plan_id=? AND kind='candidates'", p.id)).toBe(0);
  });

  // 修正済み 2026-10-11 (copy): ids() is shared with template selection, so a one-off with >10 segments reports 「テンプレートの指定が不正です」
  // although a one-off has no template (CONTEXT.md 用語). The count check in collectSegmentPeople says 「回答対象の区分を1〜10件…」.
  it('too many segments on a one-off is reported in segment terms, not template terms', async () => {
    await seed();
    const r = await request('/planning', { ...SETTINGS, segments: Array.from({ length: 11 }, (_, i) => 8001 + i) });
    expect(((await r.json()) as any).error).not.toContain('テンプレート');
  });

  it('a Discord role lookup failure during a draft segment change leaves the draft unchanged (503)', async () => {
    await seed();
    let p = await create();
    await db.prepare("UPDATE segments SET mention_role_id='4001' WHERE id=8002").run();
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
      const path = new URL(String(url)).pathname.replace(/^\/api\/v\d+/, '');
      const ch = path.match(/^\/channels\/(\d+)$/);
      if (ch) return Response.json({ id: ch[1], ...CHANNELS[ch[1]] });
      return Response.json({}, { status: 500 });
    }));
    expect(await status(`/planning/${p.id}/settings`, { ...SETTINGS, version: p.version, segments: [8002] }, LIVE())).toBe(503);
    p = await getPlan(db, p.id);
    expect(p.data.segments).toEqual([8001]);
    expect(p.data.people).toHaveLength(5);
  });

  it('a segment used by a draft or open one-off cannot be deleted; after confirmation it can', async () => {
    await seed();
    const uuid = '00000000-0000-4000-8000-000000008001';
    await db.prepare('UPDATE segments SET uuid=? WHERE id=8001').bind(uuid).run();
    const del = () => handleAdmin(new Request(`https://test.invalid/api/admin/segments/${uuid}`, {
      method: 'DELETE', headers: { Authorization: 'Bearer planning-test-token' },
    }), E());
    let p = await create();
    expect((await del()).status).toBe(409);
    p = await ok(`/planning/${p.id}/candidates`, { version: p.version, candidates: [{ date: '2099-09-10', time: '19:00' }] });
    p = await ok(`/planning/${p.id}/publish`, { version: p.version });
    expect((await del()).status).toBe(409);
    p = await answerAll(p, ['person1']);
    p = await ok(`/planning/${p.id}/confirm-selection`, { version: p.version, slots: [slot(p.data.candidates[0].id, ['person1'])] });
    expect((await del()).status).toBe(200);
    // The confirmed plan keeps its segment name snapshot for the forum post
    expect((await getPlan(db, p.id)).data.scheduleNames).toEqual({ '8001': 'キャスト' });
  });
});
