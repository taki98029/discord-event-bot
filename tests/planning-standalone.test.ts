import { afterEach, describe, it, expect, vi } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import { handleAdmin } from '../src/admin';
import { getPlan } from '../src/planning/store';
import { planningTick } from '../src/planning/cron';
import { deliverPending } from '../src/planning/delivery';
import { openWebAnswer } from './planning-web-client';
import { candidateLine, parseCandidateLines } from '../ui/src/lib/planningCandidates';

const G = '12345678901';
const db = env.DB;
const E = () => ({ ...env, MOCK_DISCORD: '1', ADMIN_TOKEN: 'planning-test-token' }) as unknown as Env;
afterEach(() => vi.unstubAllGlobals());
async function request(path: string, body?: object) {
  return handleAdmin(
    new Request(`https://test.invalid/api/admin${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer planning-test-token', 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    }),
    E(),
  );
}
async function ok(path: string, body?: object): Promise<any> {
  const r = await request(path, body);
  const value: any = await r.json();
  expect(r.status, JSON.stringify(value)).toBe(200);
  return value;
}
async function profile() {
  await db
    .prepare(
      "INSERT INTO segments(id,guild_id,name,uuid) VALUES(8001,?,'キャスト','standalone-cast'),(8002,?,'スタッフ','standalone-staff')",
    )
    .bind(G, G)
    .run();
  for (let i = 1; i <= 5; i++) {
    await db
      .prepare('INSERT INTO members(user_id,user_name) VALUES(?,?)')
      .bind(`person${i}`, `回答者${i}`)
      .run();
    await db
      .prepare("INSERT INTO segment_members(segment_id,user_id,status) VALUES(8001,?,'')")
      .bind(`person${i}`)
      .run();
  }
  await db.prepare("INSERT INTO segment_members(segment_id,user_id,status) VALUES(8002,'person1','')").run();
  const data = {
    name: '営業日調整',
    segments: [8001, 8002],
    schedules: [],
    channel: '111111',
    forum: '222222',
    tag: '',
    remindDays: 3,
    rrule: 'FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=1',
    anchor: '2099-01-01',
    time: '21:00',
    adminChannel: '333333',
    mentionMode: 'users',
    mentions: ['555555'],
    retryDays: 3,
    origin: '',
  };
  const p = await ok('/planning/profiles', { guild_id: G, data, enabled: false });
  return { id: p.id, data };
}
async function plan(profileId: string) {
  return ok('/planning', {
    guild_id: G,
    profileId,
    name: '9月の日程調整',
    deadline: '2099-09-01T00:00:00Z',
    note: '',
  });
}
describe('independent date planning', () => {
  it('creates a one-off plan without a template and lets every setting change only while it is a draft', async () => {
    await profile(); // segments and members only; the template itself is not used
    const settings = { guild_id: G, oneOff: true, name: '単発の日程調整', segments: [8002], channel: '111111', forum: '222222', tag: '',
      deadline: '2099-09-01T00:00:00Z', note: '補足', remindDays: 0, announceMention: 'none', shareAnswers: true, eventReminderHours: 0,
      answerReminder: { enabled: true, beforeDays: 2, intervalDays: 1, time: '20:00', target: 'dm' } };
    let p = await ok('/planning', settings);
    expect([p.data.oneOff, p.data.standalone, p.data.profileId, p.data.segments]).toEqual([true, true, undefined, [8002]]);
    expect(p.data.people.map((x: any) => x.id)).toEqual(['person1']);
    expect(p.data.answerReminder.beforeDays).toBe(2);
    // Every setting, including the audience, can change before confirmation
    p = await ok(`/planning/${p.id}/settings`, { ...settings, version: p.version, segments: [8001], shareAnswers: false, answerReminder: { ...settings.answerReminder, beforeDays: 5 } });
    expect(p.data.segments).toEqual([8001]);
    expect(p.data.people).toHaveLength(5);
    expect([p.data.shareAnswers, p.data.answerReminder.beforeDays]).toEqual([false, 5]);
    expect((await request('/planning', { ...settings, segments: [] })).status).toBe(400);
    // After publication only the name and note change, as with a template-based plan; the rest needs cancel + duplicate
    p = await ok(`/planning/${p.id}/candidates`, { version: p.version, candidates: [{ date: '2099-09-10', time: '19:00' }] });
    p = await ok(`/planning/${p.id}/publish`, { version: p.version });
    p = await ok(`/planning/${p.id}/settings`, { ...settings, version: p.version, name: '改名', note: '補足2', segments: [8002], shareAnswers: true, channel: '333333' });
    expect([p.data.name, p.data.note, p.data.segments, p.data.shareAnswers, p.data.channel]).toEqual(['改名', '補足2', [8001], false, '111111']);
    expect(p.data.people).toHaveLength(5);
  });
  it('collects all current Discord roles before creation and publication without waiting for segment sync', async () => {
    const saved = await profile();
    await db.prepare("UPDATE segments SET mention_role_id='4001' WHERE id=8001").run();
    await db.prepare("INSERT INTO segments(id,guild_id,name,uuid,mention_role_id) VALUES(8003,?,'全員','standalone-all','@everyone')").bind(G).run();
    await db.prepare("UPDATE planning_cycles SET data=json_set(data,'$.segments',json('[8001,8002,8003]')) WHERE id=?").bind(saved.id).run();
    // Discord has 3001/3002 in role 4001; the database still only has unrelated manual members.
    let p = await plan(saved.id);
    expect(p.data.people.find((x: any) => x.id === '3001')?.schedules).toEqual([8001, 8003]);
    expect(p.data.people.some((x: any) => x.id === 'person2')).toBe(false);
    expect(p.data.people.find((x: any) => x.id === 'person1')?.schedules).toEqual([8002]);
    await db.prepare("UPDATE segments SET mention_role_id='4001' WHERE id=8002").run();
    await db.prepare("INSERT INTO members(user_id,user_name) VALUES('3002','kenta')").run();
    await db.prepare("INSERT INTO segment_members(segment_id,user_id,status) VALUES(8002,'3002','休止中')").run();
    p = await ok(`/planning/${p.id}/candidates`, { version: p.version, candidates: [{ date: '2099-09-10', time: '19:00' }] });
    p = await ok(`/planning/${p.id}/publish`, { version: p.version });
    expect(p.data.people.find((x: any) => x.id === '3001')?.schedules).toEqual([8001, 8002, 8003]);
    expect(p.data.people.find((x: any) => x.id === '3002')?.schedules).toEqual([8001, 8003]);
    expect(p.data.people.find((x: any) => x.id === '3003')?.schedules).toEqual([8003]);
    expect(p.data.people).toHaveLength(3);
    const next = await plan(saved.id);
    expect(next.data.people).toEqual(p.data.people);
    // Published answers retain their original audience when roles change later.
    await db.prepare("UPDATE segments SET mention_role_id='9999' WHERE id=8002").run();
    expect((await ok(`/planning/${p.id}`)).data.people).toEqual(p.data.people);
  });
  it('does not create an incomplete audience when Discord role retrieval fails', async () => {
    const saved = await profile();
    await db.prepare("UPDATE segments SET mention_role_id='4001' WHERE id=8002").run();
    const fetcher = vi.fn().mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetcher);
    const result = await handleAdmin(new Request('https://test.invalid/api/admin/planning', {
      method: 'POST', headers: { Authorization: 'Bearer planning-test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ guild_id: G, profileId: saved.id, name: '取得失敗', deadline: '2099-09-01T00:00:00Z', note: '' }),
    }), { ...E(), MOCK_DISCORD: undefined });
    expect(result.status).toBe(503);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM planning_plans').first<any>()).n).toBe(0);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM planning_deliveries').first<any>()).n).toBe(0);
  });
  it('creates from a saved profile without any schedule and keeps per-plan settings fixed', async () => {
    const saved = await profile();
    const p = await plan(saved.id);
    expect(p.data.standalone).toBe(true);
    expect(p.data.schedules).toEqual([]);
    expect(p.data.people).toHaveLength(5);
    expect(p.data.people.find((x: any) => x.id === 'person1').schedules).toEqual([8001, 8002]);
    expect(p.data.scheduleNames).toEqual({ '8001': 'キャスト', '8002': 'スタッフ' });
    await ok('/planning/profiles', {
      id: saved.id,
      guild_id: G,
      data: { ...saved.data, channel: '444444', remindDays: 5 },
      enabled: false,
    });
    const unchanged = await getPlan(db, p.id);
    expect(unchanged.data.channel).toBe('111111');
    const edited = await ok(`/planning/${p.id}/settings`, {
      version: p.version,
      name: p.data.name,
      deadline: p.data.deadline,
      note: '今回の補足',
      channel: '999999',
      segments: [999],
      schedules: [123],
      remindDays: 9,
    });
    expect(edited.data.channel).toBe('111111');
    expect(edited.data.remindDays).toBe(3);
    expect(edited.data.segments).toEqual([8001, 8002]);
    expect((await plan(saved.id)).data.channel).toBe('444444');
    expect((await request('/planning', { guild_id: G, name: '不正', schedules: [8001] })).status).toBe(400);
    expect(
      (await request('/planning', { guild_id: 'other', profileId: saved.id, name: '他サーバー' })).status,
    ).toBe(400);
    expect(
      (await request('/planning/profiles', { guild_id: 'other', data: saved.data, enabled: false })).status,
    ).toBe(400);
  });
  it('rejects date-only candidates, publishes timed ones, confirms one forum per slot without occurrences, and rejects roster edits', async () => {
    const saved = await profile();
    let p = await plan(saved.id);
    // Every candidate needs a start time (2026-09-23).
    expect((await request(`/planning/${p.id}/candidates`, { version: p.version, candidates: [{ date: '2099-09-10', time: '' }] })).status).toBe(400);
    p = await ok(`/planning/${p.id}/candidates`, {
      version: p.version,
      candidates: [
        { date: '2099-09-10', time: '18:00' },
        { date: '2099-09-10', time: '19:00' },
      ],
    });
    p = await ok(`/planning/${p.id}/publish`, { version: p.version });
    const screen = (await openWebAnswer(p, E(), 'person1')).snapshot;
    expect(JSON.stringify(screen)).toContain('2099/9/10(木) 18:00');
    expect(screen.candidates[0]).toMatchObject({ date: '2099-09-10', time: '18:00' });
    expect(JSON.stringify(screen)).toContain('2099/9/10(木) 19:00');
    for (const user of ['person1', 'person2', 'person3']) {
      p = await ok(`/planning/${p.id}/answer`, {
        version: p.version,
        user,
        values: Object.fromEntries(p.data.candidates.map((c: any) => [c.id, '可'])),
        reason: '回答確認',
      });
    }
    const slots = p.data.candidates.map((c: any) => ({
      candidate: c.id,
      members: [
        { user: 'person1', schedule: 8001, status: '参加', duty: '' },
        { user: 'person2', schedule: 8001, status: '参加', duty: '' },
        { user: 'person1', schedule: 8002, status: '参加', duty: '' },
      ],
      gather: '',
      note: '',
      cancelled: false,
    }));
    p = await ok(`/planning/${p.id}/confirm-selection`, { version: p.version, slots });
    for (const table of [
      'notifications',
      'occurrences',
      'planning_occurrences',
      'planning_roster',
      'responses',
    ])
      expect((await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<any>()).n).toBe(0);
    expect(
      (await db.prepare("SELECT COUNT(*) AS n FROM planning_deliveries WHERE kind='forum'").first<any>()).n,
    ).toBe(2);
    await deliverPending(E(), 10);
    const slot = p.data.slots[0];
    expect(
      (await request(`/planning/${p.id}/roster`, { version: p.version, slot: slot.id, members: [], reason: '交代' })).status,
    ).toBe(404);
    p = await ok(`/planning/${p.id}/cancel`, { version: p.version, reason: '全体中止' });
    expect(p.data.slots.every((s: any) => s.cancelled)).toBe(true);
  });
  it('advances a stale due date without creating a draft and completes the reminder when a plan from the template is published', async () => {
    const saved = await profile();
    await ok('/planning/profiles', {
      id: saved.id,
      guild_id: G,
      data: { ...saved.data, anchor: '2020-01-01' },
      enabled: true,
    });
    await db.prepare("UPDATE planning_cycles SET next_date='2020-01-01' WHERE id=?").bind(saved.id).run();
    await planningTick(E());
    const row = () => db.prepare('SELECT next_date,task_status FROM planning_cycles WHERE id=?').bind(saved.id).first<any>();
    expect((await row()).next_date > '2020-01-01').toBe(true);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM planning_plans').first<any>()).n).toBe(0);
    let p: any = await plan(saved.id);
    p = await ok(`/planning/${p.id}/candidates`, {
      version: p.version,
      candidates: [{ date: '2099-09-10', time: '19:00' }],
    });
    p = await ok(`/planning/${p.id}/publish`, { version: p.version });
    expect((await row()).task_status).toBe('pending');
    await deliverPending(E(), 10);
    expect((await row()).task_status).toBe('complete');
    expect((await db.prepare('SELECT COUNT(*) AS n FROM notifications').first<any>()).n).toBe(0);
  });
});
describe('calendar candidate text', () => {
  it('accepts date-only and time suffixes together, normalizes and deduplicates, and keeps year changes explicit', () => {
    expect(
      parseCandidateLines('9/11(金) 19:00〜\n9/24(木)\n2027/1/10(日) 9:00~\n2026-09-11 19:00', 2026),
    ).toEqual([
      { date: '2026-09-11', time: '19:00' },
      { date: '2026-09-24', time: '' },
      { date: '2027-01-10', time: '09:00' },
    ]);
    expect(candidateLine({ date: '2027-01-10', time: '' }, 2026)).toBe('2027/1/10(日)');
  });
  it('rejects invalid dates, times and unparsed text with a line number', () => {
    for (const line of ['2/30', '9/10 24:00', '9/10 19:00〜20:00', '9/10 junk'])
      expect(() => parseCandidateLines(`9/11\n${line}`, 2026)).toThrow('2行目');
  });
});
