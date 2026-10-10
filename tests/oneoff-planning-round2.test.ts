// 単発日程調整（oneOff）の回答受付後〜確定・投稿・リマインドのエッジケース（第2弾）。
// 第1弾 tests/oneoff-planning-edge.test.ts と重複しない範囲。挙動の根拠: src/planning/*.ts のコメント・docs/dev/CONTEXT.md・docs/dev/planning-settings-matrix.md
// 確定後の名簿変更・開催枠単位の中止の画面/APIは 2026-09-23 に廃止（CONTEXT.md）。名簿の変更は Discord のフォーラムで手動。
import { afterEach, describe, it, expect, vi } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import { handleAdmin } from '../src/admin';
import { getPlan } from '../src/planning/store';
import { planningTick, answerReminderDue } from '../src/planning/cron';
import { deliverPending } from '../src/planning/delivery';
import { planningInteraction } from '../src/planning/interactions';
import { handlePlanningAnswer } from '../src/planning/web-answer';
import { planningDeadline } from '../src/planning/answer-view';
import { planningCsv } from '../ui/src/lib/planningCsv';
import { openWebAnswer, answerRequest, ORIGIN } from './planning-web-client';

const G = '12345678901';
const APP = '5550001';
const db = env.DB;
const E = () => ({ ...env, MOCK_DISCORD: '1', ADMIN_TOKEN: 'planning-test-token' }) as unknown as Env;
const LIVE = () => ({ ...E(), MOCK_DISCORD: undefined, DISCORD_BOT_TOKEN: 'dummy', DISCORD_APPLICATION_ID: APP }) as unknown as Env;
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

type Call = { path: string; method: string; body: any };
/**
 * Discord stub. Threads get distinct ids (thread id = starter message id, as on Discord).
 * `override` may answer a call first (return undefined to fall through).
 */
function discordStub(override?: (c: Call) => Response | undefined, archived = new Set<string>()) {
  const calls: Call[] = [];
  let next = 880001;
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname.replace(/^\/api\/v\d+/, '');
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const call = { path, method, body };
    calls.push(call);
    const r = override?.(call);
    if (r) return r;
    const ch = path.match(/^\/channels\/(\d+)$/);
    if (ch && method === 'GET') {
      if (ch[1] === '111111') return Response.json({ id: ch[1], guild_id: G, type: 0 });
      if (ch[1] === '222222') return Response.json({ id: ch[1], guild_id: G, type: 15 });
      return Response.json({ id: ch[1], guild_id: G, type: 11, parent_id: '222222', thread_metadata: { archived: archived.has(ch[1]) } });
    }
    if (path.endsWith('/threads') && method === 'POST') {
      const id = String(next++);
      return Response.json({ id, message: { id } });
    }
    if (path === '/users/@me/channels') return Response.json({ id: 'dm-' + body.recipient_id, type: 1 });
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
async function fail(path: string, body: object, e?: Env): Promise<{ status: number; error: string }> {
  const r = await request(path, body, e);
  return { status: r.status, error: ((await r.json()) as any).error };
}
const count = async (sql: string, ...args: unknown[]) =>
  (await db.prepare(sql).bind(...args).first<any>()).n as number;
const rows = async (sql: string, ...args: unknown[]) => (await db.prepare(sql).bind(...args).all<any>()).results;

async function seed() {
  await db.prepare(
    "INSERT INTO segments(id,guild_id,name,uuid) VALUES(8001,?,'キャスト','r2-cast'),(8002,?,'スタッフ','r2-staff')",
  ).bind(G, G).run();
  for (let i = 1; i <= 5; i++) {
    await db.prepare('INSERT INTO members(user_id,user_name) VALUES(?,?)').bind(`person${i}`, `回答者${i}`).run();
    await db.prepare("INSERT INTO segment_members(segment_id,user_id,status) VALUES(8001,?,'')").bind(`person${i}`).run();
  }
  await db.prepare("INSERT INTO segment_members(segment_id,user_id,status) VALUES(8002,'person1','')").run();
}
const SETTINGS = {
  guild_id: G, oneOff: true, name: '単発の日程調整', segments: [8001], channel: '111111', forum: '222222', tag: '',
  deadline: '2099-09-01T00:00:00Z', note: '補足', remindDays: 0, announceMention: 'none', shareAnswers: false, eventReminderHours: 2,
  answerReminder: { enabled: true, beforeDays: 2, intervalDays: 1, time: '20:00', target: 'dm' },
};
const create = (x: object = {}, e?: Env) => ok('/planning', { ...SETTINGS, ...x }, e);
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
/** A JST date/time `hours` from now, as a candidate. */
function jstIn(hours: number) {
  const s = new Date(Date.now() + hours * 3600000 + 9 * 3600000).toISOString();
  return { date: s.slice(0, 10), time: s.slice(11, 16) };
}
const soonDeadline = () => new Date(Date.now() + 600000).toISOString();
/** Published, answered and confirmed one-off whose slots start at the given hours from now. */
async function confirmedAt(hours: number[], x: object = {}) {
  let p = await published({ deadline: soonDeadline(), ...x }, hours.map(jstIn));
  p = await answerAll(p, ['person1']);
  return ok(`/planning/${p.id}/confirm-selection`, { version: p.version, slots: p.data.candidates.map((c: any) => slot(c.id, ['person1'])) });
}
const deliveries = (id: string, kind: string) =>
  rows('SELECT * FROM planning_deliveries WHERE plan_id=? AND kind=? ORDER BY rowid', id, kind);
const reminderPosts = (calls: Call[]) => calls.filter((c) => c.method === 'POST' && c.body?.content?.includes('開催前リマインド'));
function interaction(p: any, user: string) {
  return planningInteraction({ type: 3, guild_id: p.guild_id, member: { user: { id: user } }, data: { custom_id: `plan:open:${p.id}:0` } }, E(), ORIGIN);
}

describe('answers and proxy answers', () => {
  it('a proxy answer merges values, keeps the comment unless given, and is recorded with the respondent and reason', async () => {
    await seed();
    let p = await published();
    const [c1, c2] = p.data.candidates.map((c: any) => c.id);
    p = await ok(`/planning/${p.id}/answer`, { version: p.version, user: 'person1', values: { [c1]: '不可' }, reason: '電話で受付', comment: '遅れます' });
    p = await ok(`/planning/${p.id}/answer`, { version: p.version, user: 'person1', values: { [c2]: '可' } });
    expect(p.data.answers.person1).toEqual({ values: { [c1]: '不可', [c2]: '可' }, comment: '遅れます' });
    p = await ok(`/planning/${p.id}/answer`, { version: p.version, user: 'person1', values: {}, comment: '' });
    expect(p.data.answers.person1.comment).toBe('');
    // A stale proxy edit is a conflict
    expect((await fail(`/planning/${p.id}/answer`, { version: p.version - 1, user: 'person2', values: { [c1]: '可' } })).status).toBe(409);
    const history = await ok(`/planning/${p.id}/history`);
    const first = history.find((h: any) => h.reason === '電話で受付');
    expect([first.kind, first.user_id]).toEqual(['admin-answer', 'person1']);
    // History stores only the changed respondent's answers
    p = await ok(`/planning/${p.id}/answer`, { version: p.version, user: 'person2', values: { [c1]: '可' } });
    const latest = (await ok(`/planning/${p.id}/history`))[0];
    expect(Object.keys(JSON.parse(latest.after_data).answers)).toEqual(['person2']);
  });

  it('a proxy edit invalidates only that respondent\'s open answer form', async () => {
    await seed();
    let p = await published();
    const a = await openWebAnswer(p, E(), 'person1');
    const b = await openWebAnswer(p, E(), 'person2');
    const values = Object.fromEntries(a.snapshot.candidates.map((c) => [c.id, '可']));
    p = await ok(`/planning/${p.id}/answer`, { version: p.version, user: 'person1', values: { [p.data.candidates[0].id]: '不可' } });
    expect((await handlePlanningAnswer(answerRequest(p.id, a.cookie, { version: a.snapshot.version, values, comment: '' }), E())).status).toBe(409);
    expect((await handlePlanningAnswer(answerRequest(p.id, b.cookie, { version: b.snapshot.version, values, comment: '' }), E())).status).toBe(200);
    p = await getPlan(db, p.id);
    expect(p.data.answers.person1.values[p.data.candidates[0].id]).toBe('不可');
    expect(p.data.answers.person2.values).toEqual(values);
  });
});

describe('selection and confirmation with several slots', () => {
  it('keeps slot ids from a saved selection, confirms two slots and posts one thread per slot with that slot\'s 参加 mentions', async () => {
    await seed();
    const calls = discordStub();
    let p = await published({ segments: [8001, 8002] });
    const [c1, c2] = p.data.candidates.map((c: any) => c.id);
    p = await answerAll(p, ['person1', 'person2', 'person3']);
    p = await ok(`/planning/${p.id}/selection`, { version: p.version, slots: [slot(c1, ['person1', 'person2']), slot(c2, ['person3'])] });
    const ids = Object.fromEntries(p.data.slots.map((s: any) => [s.candidate, s.id]));
    p = await ok(`/planning/${p.id}/confirm-selection`, {
      version: p.version, reason: '人数優先',
      slots: [{ ...slot(c2, ['person3']), gather: '駅前' }, slot(c1, ['person1', 'person2'])],
    });
    expect(Object.fromEntries(p.data.slots.map((s: any) => [s.candidate, s.id]))).toEqual(ids);
    expect(p.data.slots[0].gather).toBe('駅前');
    await deliverPending(LIVE(), 10);
    const threads = calls.filter((c) => c.path === '/channels/222222/threads');
    expect(threads.map((t) => t.body.message.allowed_mentions.users)).toEqual([['person3'], ['person1', 'person2']]);
    const forum = await deliveries(p.id, 'forum');
    expect(forum.map((f) => f.status)).toEqual(['sent', 'sent']);
    expect(new Set(forum.map((f) => f.thread_id)).size).toBe(2);
    const history = await ok(`/planning/${p.id}/history`);
    expect(history[0]).toMatchObject({ kind: 'confirm', reason: '人数優先' });
  });

  it('a saved selection whose member later answered 不可 cannot be confirmed until reselected', async () => {
    await seed();
    let p = await published();
    const [c1] = p.data.candidates.map((c: any) => c.id);
    p = await answerAll(p, ['person1', 'person2']);
    p = await ok(`/planning/${p.id}/selection`, { version: p.version, slots: [slot(c1, ['person1', 'person2'])] });
    const s = await openWebAnswer(p, E(), 'person2');
    const values = Object.fromEntries(s.snapshot.candidates.map((c) => [c.id, '不可']));
    expect((await handlePlanningAnswer(answerRequest(p.id, s.cookie, { version: s.snapshot.version, values, comment: '' }), E())).status).toBe(200);
    p = await getPlan(db, p.id);
    const r = await fail(`/planning/${p.id}/confirm`, { version: p.version });
    expect(r.status).toBe(400);
    expect(r.error).toContain('〇以外');
    expect((await getPlan(db, p.id)).data.state).toBe('open');
    p = await ok(`/planning/${p.id}/confirm-selection`, { version: p.version, slots: [slot(c1, ['person1'])] });
    expect(p.data.state).toBe('confirmed');
  });

  it('pending answer DMs and channel reminders are dropped once the plan is confirmed or the person answered', async () => {
    await seed();
    let p = await published();
    await deliverPending(E(), 10);
    const stamp = new Date().toISOString();
    for (const user of ['person3', 'person4'])
      await db.prepare("INSERT INTO planning_deliveries(id,plan_id,kind,channel_id,payload,created_at,updated_at) VALUES(?,?,'answer-dm','111111',?,?,?)")
        .bind(`dm-${user}`, p.id, JSON.stringify({ user }), stamp, stamp).run();
    p = await answerAll(p, ['person1', 'person3']);
    await deliverPending(E(), 10);
    expect((await deliveries(p.id, 'answer-dm')).map((d) => [d.id, d.status])).toEqual([['dm-person3', 'cancelled'], ['dm-person4', 'sent']]);
    await db.prepare("INSERT INTO planning_deliveries(id,plan_id,kind,channel_id,payload,created_at,updated_at) VALUES('dm-late',?,'answer-dm','111111',?,?,?)")
      .bind(p.id, JSON.stringify({ user: 'person5' }), stamp, stamp).run();
    p = await ok(`/planning/${p.id}/confirm-selection`, { version: p.version, slots: [slot(p.data.candidates[0].id, ['person1'])] });
    await deliverPending(E(), 10);
    expect((await db.prepare("SELECT status FROM planning_deliveries WHERE id='dm-late'").first<any>()).status).toBe('cancelled');
  });
});

describe('forum post failure, retry and association', () => {
  it('a rejected forum post is retried by the admin, and the event reminder waits for the thread', async () => {
    await seed();
    let reject = true;
    const calls = discordStub((c) => (reject && c.path === '/channels/222222/threads' ? new Response('{}', { status: 403 }) : undefined));
    const p = await confirmedAt([1]);
    await deliverPending(LIVE(), 10);
    let [forum] = await deliveries(p.id, 'forum');
    expect([forum.status, forum.error]).toEqual(['failed', 'Discord 403']);
    await planningTick(LIVE());
    expect((await deliveries(p.id, 'event-reminder')).map((d) => d.status)).toEqual(['pending']);
    reject = false;
    const now = await getPlan(db, p.id);
    await ok(`/planning/${p.id}/retry`, { version: now.version, delivery: forum.id }, LIVE());
    await planningTick(LIVE()); // posts the forum thread; the reminder becomes eligible only after that
    await planningTick(LIVE());
    [forum] = await deliveries(p.id, 'forum');
    expect(forum.status).toBe('sent');
    const [reminder] = await deliveries(p.id, 'event-reminder');
    expect([reminder.status, reminder.channel_id]).toEqual(['sent', forum.thread_id]);
    expect(reminderPosts(calls).map((c) => c.path)).toEqual([`/channels/${forum.thread_id}/messages`]);
  });

  it('an unknown outcome is never retried blindly: retry is refused, a verified retry needs a reason, and stale sending becomes unknown', async () => {
    await seed();
    const calls = discordStub((c) => (c.path === '/channels/222222/threads' ? new Response('{}', { status: 502 }) : undefined));
    const p = await confirmedAt([30]);
    await deliverPending(LIVE(), 10);
    const [forum] = await deliveries(p.id, 'forum');
    expect(forum.status).toBe('unknown');
    const v = (await getPlan(db, p.id)).version;
    expect((await fail(`/planning/${p.id}/retry`, { version: v, delivery: forum.id })).status).toBe(400);
    expect((await fail(`/planning/${p.id}/retry-verified`, { version: v, delivery: forum.id, verified: true, reason: '  ' })).status).toBe(400);
    expect((await fail(`/planning/${p.id}/retry-verified`, { version: v, delivery: forum.id, verified: false, reason: '確認済' })).status).toBe(400);
    await ok(`/planning/${p.id}/retry-verified`, { version: v, delivery: forum.id, verified: true, reason: 'Discordで未投稿を確認' });
    expect((await deliveries(p.id, 'forum'))[0].status).toBe('pending');
    // A job stuck in 'sending' for over five minutes becomes unknown and is not sent again
    await db.prepare("UPDATE planning_deliveries SET status='sending',updated_at=? WHERE id=?").bind(new Date(Date.now() - 600000).toISOString(), forum.id).run();
    calls.length = 0;
    await deliverPending(LIVE(), 10);
    expect((await deliveries(p.id, 'forum'))[0]).toMatchObject({ status: 'unknown', error: '処理結果を確認してください' });
    expect(calls.some((c) => c.path.endsWith('/threads'))).toBe(false);
  });

  it('associates an unknown forum post only with a bot thread of this slot, then edits it and reminds in it', async () => {
    await seed();
    let foreignFooter = false;
    const calls = discordStub((c) => {
      if (c.path === '/channels/222222/threads') return new Response('{}', { status: 500 });
      if (c.path === '/channels/770001' && c.method === 'GET') return Response.json({ id: '770001', guild_id: G, type: 11, parent_id: '999998' });
      const m = c.path.match(/^\/channels\/(\d+)\/messages\/(\d+)$/);
      if (m && c.method === 'GET') {
        const slotId = foreignFooter ? 'other-slot' : slotOf;
        return Response.json({ id: m[2], author: { id: APP }, embeds: [{ footer: { text: `開催枠 ${slotId}` } }] });
      }
      return undefined;
    });
    let slotOf = '';
    let p = await confirmedAt([1]);
    slotOf = p.data.slots[0].id;
    await deliverPending(LIVE(), 10);
    const [forum] = await deliveries(p.id, 'forum');
    expect(forum.status).toBe('unknown');
    const v = p.version;
    // Thread in another forum, malformed ids, and a message of another slot are refused
    expect((await fail(`/planning/${p.id}/associate`, { version: v, delivery: forum.id, thread: '770001', message: '770001' }, LIVE())).status).toBe(400);
    expect((await fail(`/planning/${p.id}/associate`, { version: v, delivery: forum.id, thread: 'x', message: '880500' }, LIVE())).status).toBe(400);
    foreignFooter = true;
    expect((await fail(`/planning/${p.id}/associate`, { version: v, delivery: forum.id, thread: '880500', message: '880500' }, LIVE())).status).toBe(400);
    foreignFooter = false;
    p = await ok(`/planning/${p.id}/associate`, { version: v, delivery: forum.id, thread: '880500', message: '880500' }, LIVE());
    const jobs = await deliveries(p.id, 'forum');
    expect(jobs.map((j) => [j.status, j.thread_id])).toEqual([['sent', '880500'], ['pending', null]]);
    // Associating a resolved job again is refused
    expect((await fail(`/planning/${p.id}/associate`, { version: p.version, delivery: forum.id, thread: '880500', message: '880500' }, LIVE())).status).toBe(400);
    calls.length = 0;
    await planningTick(LIVE());
    await planningTick(LIVE());
    const edit = calls.find((c) => c.method === 'PATCH' && c.path === '/channels/880500/messages/880500');
    expect(edit?.body.content).toContain('開催案内');
    expect(edit?.body.allowed_mentions.users).toEqual([]); // the edit never pings again
    expect(calls.some((c) => c.path === '/channels/222222/threads')).toBe(false);
    expect(reminderPosts(calls).map((c) => c.path)).toEqual(['/channels/880500/messages']);
  });

  it('recreates a forum thread whose message was deleted (edit returned 404)', async () => {
    await seed();
    let deleted = false;
    const calls = discordStub((c) => {
      if (deleted && c.path === '/channels/880001/messages/880001') return new Response('{}', { status: 404 });
      return undefined;
    });
    let p = await confirmedAt([30]);
    await deliverPending(LIVE(), 10);
    const [first] = await deliveries(p.id, 'forum');
    // An edit (e.g. after associating) finds the message gone
    deleted = true;
    await db.prepare("INSERT INTO planning_deliveries(id,plan_id,kind,slot_id,channel_id,payload,created_at,updated_at) VALUES('edit-1',?,'forum',?,'222222','{}',?,?)")
      .bind(p.id, p.data.slots[0].id, new Date().toISOString(), new Date().toISOString()).run();
    await deliverPending(LIVE(), 10);
    const edit = (await deliveries(p.id, 'forum')).find((j) => j.id === 'edit-1');
    expect([edit.status, edit.error]).toEqual(['failed', 'Discord 404']);
    expect((await fail(`/planning/${p.id}/recreate`, { version: p.version, delivery: first.id, verified: true, reason: '削除' })).status).toBe(400);
    p = await ok(`/planning/${p.id}/recreate`, { version: p.version, delivery: 'edit-1', verified: true, reason: '削除を確認' }, LIVE());
    calls.length = 0;
    await deliverPending(LIVE(), 10);
    const post = calls.find((c) => c.path === '/channels/222222/threads');
    expect(post?.body.message.allowed_mentions.users).toEqual(['person1']);
    expect((await db.prepare("SELECT status,thread_id FROM planning_deliveries WHERE id='edit-1'").first<any>())).toEqual({ status: 'sent', thread_id: '880002' });
  });
});

describe('event reminder', () => {
  it('unarchives an archived thread before reminding, and a deleted thread fails without re-queueing', async () => {
    await seed();
    const archived = new Set(['880001']);
    let gone = false;
    const calls = discordStub((c) => (gone && c.path === '/channels/880002' ? new Response('{}', { status: 404 }) : undefined), archived);
    const a = await confirmedAt([1]);
    await deliverPending(LIVE(), 10);
    await planningTick(LIVE());
    const unarchive = calls.findIndex((c) => c.method === 'PATCH' && c.path === '/channels/880001' && c.body.archived === false);
    const post = calls.findIndex((c) => c.method === 'POST' && c.path === '/channels/880001/messages');
    expect(unarchive).toBeGreaterThan(-1);
    expect(post).toBeGreaterThan(unarchive);
    expect(calls[post].body.allowed_mentions).toEqual({ parse: ['everyone'] });
    expect((await deliveries(a.id, 'event-reminder')).map((d) => d.status)).toEqual(['sent']);

    const b = await confirmedAt([1]);
    await deliverPending(LIVE(), 10);
    gone = true;
    await planningTick(LIVE());
    await planningTick(LIVE());
    expect((await deliveries(b.id, 'event-reminder')).map((d) => [d.status, d.error])).toEqual([['failed', 'Discord 404']]);
  });

  it('a slot starting at 00:00 JST is reminded on the previous JST evening with the right date', async () => {
    await seed();
    const calls = discordStub();
    const jstNow = Date.now() + 9 * 3600000;
    const midnight = new Date(Math.floor(jstNow / 86400000) * 86400000 + 86400000).toISOString();
    const candidate = { date: midnight.slice(0, 10), time: '00:00' };
    const hoursLeft = (Date.parse(`${candidate.date}T00:00:00+09:00`) - Date.now()) / 3600000;
    let p = await published({ deadline: soonDeadline(), eventReminderHours: 24 }, [candidate]);
    p = await answerAll(p, ['person1']);
    p = await ok(`/planning/${p.id}/confirm-selection`, { version: p.version, slots: [slot(p.data.candidates[0].id, ['person1'])] });
    await deliverPending(LIVE(), 10);
    await planningTick(LIVE());
    expect(hoursLeft).toBeLessThanOrEqual(24);
    expect((await deliveries(p.id, 'event-reminder')).map((d) => d.status)).toEqual(['sent']);
    expect(reminderPosts(calls)[0].body.content).toContain(`開始: ${candidate.date} 00:00`);
  });

  it('several plans (one-off and template-based) get one reminder per due slot, queued one per tick, earliest first', async () => {
    await seed();
    discordStub();
    const a = await confirmedAt([1, 1.5]);
    const profile = await ok('/planning/profiles', {
      guild_id: G, enabled: false,
      data: { name: 'テンプレ', segments: [8001], channel: '111111', forum: '222222', tag: '', remindDays: 0, rrule: '', anchor: '', time: '21:00', adminChannel: '', mentionMode: 'users', mentions: [], eventReminderHours: 2 },
    });
    let t = await ok('/planning', { guild_id: G, profileId: profile.id, name: '定期', deadline: soonDeadline(), note: '' });
    t = await ok(`/planning/${t.id}/candidates`, { version: t.version, candidates: [jstIn(0.5)] });
    t = await ok(`/planning/${t.id}/publish`, { version: t.version });
    t = await answerAll(t, ['person2']);
    t = await ok(`/planning/${t.id}/confirm-selection`, { version: t.version, slots: [slot(t.data.candidates[0].id, ['person2'])] });
    const off = await confirmedAt([1], { eventReminderHours: 0 });
    await deliverPending(LIVE(), 20);
    await planningTick(LIVE());
    expect(await count("SELECT COUNT(*) AS n FROM planning_deliveries WHERE kind='event-reminder'")).toBe(1);
    for (let i = 0; i < 4; i++) await planningTick(LIVE());
    const queued = await rows("SELECT plan_id,slot_id,status FROM planning_deliveries WHERE kind='event-reminder' ORDER BY rowid");
    const slotsOfA = a.data.slots.map((s: any) => s.id);
    expect(queued.map((q) => [q.plan_id, q.slot_id, q.status])).toEqual([
      [t.id, t.data.slots[0].id, 'sent'], [a.id, slotsOfA[0], 'sent'], [a.id, slotsOfA[1], 'sent'],
    ]);
    expect(queued.some((q) => q.plan_id === off.id)).toBe(false);
  });
});

describe('answer reminders around the deadline (JST)', () => {
  const plan = (deadline: string, r: object) =>
    ({ state: 'open', deadline, answerReminder: { enabled: true, beforeDays: 1, intervalDays: 1, time: '20:00', target: 'dm', ...r } }) as any;
  const at = (jst: string) => Date.parse(jst + '+09:00');

  it('counts days by the deadline\'s JST date and sends from the send time', () => {
    const d = plan('2099-09-01T23:00:00+09:00', { beforeDays: 1 });
    expect(answerReminderDue(d, at('2099-08-31T19:59:00'))).toBe(false);
    expect(answerReminderDue(d, at('2099-08-31T20:00:00'))).toBe(true);
    expect(answerReminderDue(d, at('2099-08-30T23:00:00'))).toBe(false);
    expect(answerReminderDue(d, at('2099-09-01T20:00:00'))).toBe(true);
    expect(answerReminderDue(d, at('2099-09-01T23:00:00'))).toBe(false); // at the deadline
    const every2 = plan('2099-09-10T23:00:00+09:00', { beforeDays: 4, intervalDays: 2, time: '00:00' });
    expect(['06', '07', '08', '09', '10'].map((day) => answerReminderDue(every2, at(`2099-09-${day}T12:00:00`)))).toEqual([true, false, true, false, true]);
  });

  it('a midnight deadline is reminded on the previous evening when beforeDays ≥ 1', () => {
    const d = plan('2099-09-01T00:00:00+09:00', { beforeDays: 1 });
    expect(answerReminderDue(d, at('2099-08-31T20:00:00'))).toBe(true);
    expect(planningDeadline('2099-08-31T15:00:00.000Z')).toContain('9/1');
    expect(planningDeadline('2099-08-31T15:00:00.000Z')).toContain('00:00');
  });

  // 修正済み 2026-10-11（設定の組み合わせ）: UI は beforeDays=0 を「＝ 締切当日のみ」と表示する（ui/src/screens/Planning.tsx:2336）が、
  // 締切が送信時刻より前（典型: 00:00 締切）だと締切当日の送信時刻は締切後なので、催促は一度も送られない（警告もない）。
  it('beforeDays 0 ("締切当日のみ") still reminds once when the deadline is at 00:00 JST', () => {
    const d = plan('2099-09-01T00:00:00+09:00', { beforeDays: 0, time: '20:00' });
    const any = Array.from({ length: 48 }, (_, h) => Date.parse('2099-08-31T00:00:00+09:00') + h * 3600000)
      .some((s) => answerReminderDue(d, s));
    expect(any).toBe(true);
  });

  it('the cron visits one plan per tick, skips plans with reminders off, and never duplicates a day', async () => {
    await seed();
    const reminder = { enabled: true, beforeDays: 3, intervalDays: 1, time: '00:00', target: 'dm' };
    const deadline = new Date(Date.now() + 86400000).toISOString();
    const a = await published({ deadline, answerReminder: reminder });
    const b = await published({ deadline, answerReminder: reminder, name: 'B' });
    await published({ deadline, answerReminder: { ...reminder, enabled: false }, name: 'off' });
    const profile = await ok('/planning/profiles', {
      guild_id: G, enabled: false,
      data: { name: 'テンプレ', segments: [8001], channel: '111111', forum: '222222', tag: '', remindDays: 0, rrule: '', anchor: '', time: '21:00', adminChannel: '', mentionMode: 'users', mentions: [], answerReminder: reminder },
    });
    let t = await ok('/planning', { guild_id: G, profileId: profile.id, name: '定期', deadline, note: '' });
    t = await ok(`/planning/${t.id}/candidates`, { version: t.version, candidates: [{ date: '2099-09-10', time: '19:00' }] });
    t = await ok(`/planning/${t.id}/publish`, { version: t.version });
    const planned = () => rows("SELECT DISTINCT plan_id FROM planning_deliveries WHERE kind='answer-dm'").then((r) => r.map((x) => x.plan_id).sort());
    await planningTick(E());
    expect(await planned()).toHaveLength(1);
    await planningTick(E());
    await planningTick(E());
    expect(await planned()).toEqual([a.id, b.id, t.id].sort());
    const total = await count("SELECT COUNT(*) AS n FROM planning_deliveries WHERE kind='answer-dm'");
    expect(total).toBe(15);
    for (let i = 0; i < 3; i++) await planningTick(E());
    expect(await count("SELECT COUNT(*) AS n FROM planning_deliveries WHERE kind='answer-dm'")).toBe(total);
  });
});

describe('manual audience refresh on a one-off', () => {
  it('adds new members, retires removed ones (keeping their answers) and the rest of the flow follows the new audience', async () => {
    await seed();
    let p = await published({ deadline: new Date(Date.now() + 86400000).toISOString(), answerReminder: { enabled: true, beforeDays: 3, intervalDays: 1, time: '00:00', target: 'dm' } });
    const [c1] = p.data.candidates.map((c: any) => c.id);
    p = await answerAll(p, ['person1', 'person2']);
    p = await ok(`/planning/${p.id}/selection`, { version: p.version, slots: [slot(c1, ['person1', 'person2'])] });
    await db.prepare("UPDATE segment_members SET status='休止中' WHERE segment_id=8001 AND user_id='person2'").run();
    await db.prepare("INSERT INTO members(user_id,user_name) VALUES('late','後から')").run();
    await db.prepare("INSERT INTO segment_members(segment_id,user_id,status) VALUES(8001,'late','')").run();
    expect((await fail(`/planning/${p.id}/audience-refresh`, { version: p.version - 1 })).status).toBe(409);
    const result = await ok(`/planning/${p.id}/audience-refresh`, { version: p.version });
    expect(result).toMatchObject({ token: null, added: 1, removed: 1, total: 5 });
    p = await getPlan(db, p.id);
    expect(p.data.people.find((x: any) => x.id === 'person2').active).toBe(false);
    expect(p.data.people.find((x: any) => x.id === 'late').active).toBe(true);
    expect(p.data.answers.person2).toBeDefined();
    expect((await ok(`/planning/${p.id}/history`))[0]).toMatchObject({ kind: 'audience-refresh', user_id: null });
    // Removed: no button link, no proxy answer, not selectable, not in the CSV, no reminder
    expect(JSON.stringify((await interaction(p, 'person2')).data.components)).toContain('この回答の対象者ではありません');
    expect(JSON.stringify((await interaction(p, 'late')).data.components)).toContain('answer.html');
    expect((await fail(`/planning/${p.id}/answer`, { version: p.version, user: 'person2', values: { [c1]: '可' } })).status).toBe(400);
    expect((await fail(`/planning/${p.id}/confirm`, { version: p.version })).status).toBe(400);
    const csv = planningCsv(p.data);
    expect(csv).toContain('後から');
    expect(csv).not.toContain('回答者2');
    await planningTick(E());
    const dms = (await deliveries(p.id, 'answer-dm')).map((d) => JSON.parse(d.payload).user).sort();
    expect(dms).toEqual(['late', 'person3', 'person4', 'person5']);
  });

  it('is refused for drafts, after the deadline and after confirmation', async () => {
    await seed();
    const draft = await create();
    expect((await fail(`/planning/${draft.id}/audience-refresh`, { version: draft.version })).status).toBe(400);
    let p = await published();
    p = await answerAll(p, ['person1']);
    await db.prepare("UPDATE planning_plans SET data=json_set(data,'$.deadline',?),version=version+1 WHERE id=?").bind(new Date(Date.now() - 60000).toISOString(), p.id).run();
    p = await getPlan(db, p.id);
    expect((await fail(`/planning/${p.id}/audience-refresh`, { version: p.version })).status).toBe(400);
    p = await ok(`/planning/${p.id}/confirm-selection`, { version: p.version, slots: [slot(p.data.candidates[0].id, ['person1'])] });
    expect((await fail(`/planning/${p.id}/audience-refresh`, { version: p.version })).status).toBe(400);
  });
});

describe('history and CSV', () => {
  it('history lists the whole flow newest first, with the respondent of web answers', async () => {
    await seed();
    let p = await published();
    const s = await openWebAnswer(p, E(), 'person3');
    const values = Object.fromEntries(s.snapshot.candidates.map((c) => [c.id, '可']));
    expect((await handlePlanningAnswer(answerRequest(p.id, s.cookie, { version: s.snapshot.version, values, comment: 'よろしく' }), E())).status).toBe(200);
    p = await getPlan(db, p.id);
    p = await ok(`/planning/${p.id}/confirm-selection`, { version: p.version, slots: [slot(p.data.candidates[0].id, ['person3'])] });
    p = await ok(`/planning/${p.id}/cancel`, { version: p.version, reason: '雨天' });
    const history = await ok(`/planning/${p.id}/history`);
    expect(history.map((h: any) => h.kind)).toEqual(['cancel', 'confirm', 'participant-answer', 'publish', 'candidates']);
    expect(history[2].user_id).toBe('person3');
    expect(JSON.parse(history[2].after_data).answers).toEqual({ person3: { values, comment: 'よろしく' } });
    expect(history[0].reason).toBe('雨天');
  });

  it('the answer table CSV neutralizes formulas, quotes cells and uses segment names', async () => {
    await seed();
    await db.prepare("UPDATE members SET user_name='=HYPERLINK(\"x\")' WHERE user_id='person1'").run();
    let p = await published({ segments: [8001, 8002] });
    const [c1] = p.data.candidates.map((c: any) => c.id);
    p = await ok(`/planning/${p.id}/answer`, { version: p.version, user: 'person1', values: { [c1]: '可' }, comment: ' -1+2' });
    const lines = planningCsv(p.data).replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[0]).toBe('"名前","区分","2099-09-10 19:00","2099-09-11 19:00","補足"');
    expect(lines).toContain(`"'=HYPERLINK(""x"")","キャスト / スタッフ","可","未回答","'-1+2"`);
  });
});

describe('more delivery edges', () => {
  it('channel reminders split per 40 people and mention only those still unanswered at delivery', async () => {
    await seed();
    await db.prepare("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<40) INSERT INTO members(user_id,user_name) SELECT 'bulk'||i,'bulk' FROM n").run();
    await db.prepare("INSERT INTO segment_members(segment_id,user_id,status) SELECT 8001,user_id,'' FROM members WHERE user_id LIKE 'bulk%'").run();
    const tickCalls = discordStub();
    let p = await published({ deadline: new Date(Date.now() + 86400000).toISOString(), answerReminder: { enabled: true, beforeDays: 3, intervalDays: 1, time: '00:00', target: 'channel' } });
    await deliverPending(LIVE(), 10); // the announcement
    p = await answerAll(p, ['person1']);
    tickCalls.length = 0;
    await planningTick(LIVE());
    const jobs = await deliveries(p.id, 'reminder');
    expect(jobs.map((j) => JSON.parse(j.payload).allowed_mentions.users.length)).toEqual([40, 4]);
    const posts = tickCalls.filter((c) => c.path === '/channels/111111/messages' && c.method === 'POST');
    expect(posts.map((c) => c.body.allowed_mentions.users.length)).toEqual([40, 4]);
    expect(posts.flatMap((c) => c.body.allowed_mentions.users)).not.toContain('person1');
  });

  it('a channel reminder whose people all answered before delivery is cancelled, not posted', async () => {
    await seed();
    let p = await published({ deadline: new Date(Date.now() + 86400000).toISOString(), answerReminder: { enabled: true, beforeDays: 3, intervalDays: 1, time: '00:00', target: 'channel' } });
    await deliverPending(E(), 10);
    const stamp = new Date().toISOString();
    await db.prepare("INSERT INTO planning_deliveries(id,plan_id,kind,channel_id,payload,created_at,updated_at) VALUES('rem',?,'reminder','111111',?,?,?)")
      .bind(p.id, JSON.stringify({ allowed_mentions: { parse: [], users: ['person4', 'person5'] } }), stamp, stamp).run();
    p = await answerAll(p, ['person4', 'person5']);
    await deliverPending(E(), 10);
    expect((await db.prepare("SELECT status FROM planning_deliveries WHERE id='rem'").first<any>()).status).toBe('cancelled');
  });

  it('associates an answer DM only with the DM channel of that respondent', async () => {
    await seed();
    discordStub((c) => {
      if (c.path === '/channels/660001' && c.method === 'GET') return Response.json({ id: '660001', type: 1, recipients: [{ id: 'person2' }] });
      if (c.path === '/channels/660002' && c.method === 'GET') return Response.json({ id: '660002', type: 1, recipients: [{ id: 'person3' }] });
      if (/^\/channels\/66000\d\/messages\/\d+$/.test(c.path)) return Response.json({ id: '1', author: { id: APP } });
      return undefined;
    });
    const p = await published();
    const stamp = new Date().toISOString();
    await db.prepare("INSERT INTO planning_deliveries(id,plan_id,kind,channel_id,payload,status,error,created_at,updated_at) VALUES('dm',?,'answer-dm','111111',?,'unknown','Discord 500',?,?)")
      .bind(p.id, JSON.stringify({ user: 'person3' }), stamp, stamp).run();
    expect((await fail(`/planning/${p.id}/associate`, { version: p.version, delivery: 'dm', thread: '660001', message: '770001' }, LIVE())).status).toBe(400);
    await ok(`/planning/${p.id}/associate`, { version: p.version, delivery: 'dm', thread: '660002', message: '770001' }, LIVE());
    expect(await db.prepare("SELECT status,message_id,thread_id FROM planning_deliveries WHERE id='dm'").first<any>()).toEqual({ status: 'sent', message_id: '770001', thread_id: null });
  });

  // 修正済み 2026-10-11: deliverPending の「5分以上 sending → unknown」掃除（src/planning/delivery.ts:63-68）は失敗通知を出さない。
  // CONTEXT.md「日程調整の投稿処理で検出した失敗を管理者向けに知らせる。結果不明は失敗確定と区別して案内する」に反し、
  // Worker の中断（CPU/時間超過）で止まった投稿は、管理者が投稿状況を開くまで誰にも気づかれない。
  it('a job found stuck in sending (unknown outcome) is reported to the failure notification channel', async () => {
    await seed();
    await db.prepare('INSERT INTO config(key,value) VALUES(?,?)')
      .bind(`failure_notification:${G}`, JSON.stringify({ channel_id: '424242', mention_mode: 'none', mention_ids: [] })).run();
    const calls = discordStub();
    const p = await confirmedAt([30]);
    const [forum] = await deliveries(p.id, 'forum');
    await db.prepare("UPDATE planning_deliveries SET status='sending',updated_at=? WHERE id=?").bind(new Date(Date.now() - 600000).toISOString(), forum.id).run();
    await deliverPending(LIVE(), 10);
    expect((await deliveries(p.id, 'forum'))[0].status).toBe('unknown');
    expect(calls.some((c) => c.path === '/channels/424242/messages' && c.method === 'POST')).toBe(true);
  });

  it('control: a 5xx forum post (unknown) is reported to the failure notification channel', async () => {
    await seed();
    await db.prepare('INSERT INTO config(key,value) VALUES(?,?)')
      .bind(`failure_notification:${G}`, JSON.stringify({ channel_id: '424242', mention_mode: 'none', mention_ids: [] })).run();
    const calls = discordStub((c) => (c.path === '/channels/222222/threads' ? new Response('{}', { status: 502 }) : undefined));
    const p = await confirmedAt([30]);
    await deliverPending(LIVE(), 10);
    expect((await deliveries(p.id, 'forum'))[0].status).toBe('unknown');
    const notice = calls.find((c) => c.path === '/channels/424242/messages' && c.method === 'POST');
    expect(notice?.body.content).toContain('処理結果が不明');
  });
});
