import { afterEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import { blankPlan, DEFAULT_ANSWER_REMINDER, type Plan, type PlanData } from '../src/planning/model';
import { createPlan, getPlan, savePlan } from '../src/planning/store';
import { handlePlanningAdmin, editSettings } from '../src/planning/admin';
import { planningTick, answerReminderDue } from '../src/planning/cron';
import { deliverPending, deliveryStatement, slotPayload } from '../src/planning/delivery';
import { planningInteraction } from '../src/planning/interactions';
import { announcementText, DEFAULT_ANNOUNCEMENT_TEMPLATE } from '../src/planning/announcement';
import { candidateRange, parseCandidateLines, candidateLine } from '../ui/src/lib/planningCandidates';
import { planningCsv } from '../ui/src/lib/planningCsv';
import { failureNotificationKey } from '../src/discord/failureNotifications';
import { setConfig } from '../src/db/config';
import { unanswered } from '../src/planning/model';
import { handlePlanningAnswer } from '../src/planning/web-answer';
import { openWebAnswer, answerRequest } from './planning-web-client';
import { handleAdmin } from '../src/admin';

const db = env.DB;
const E = { ...env, MOCK_DISCORD: '1', DISCORD_BOT_TOKEN: 'dummy' } as unknown as Env;
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function data(): PlanData {
  return {
    ...blankPlan('絵本の平行世界'), standalone: true, state: 'open', segments: [1, 2],
    scheduleNames: { 1: 'かたりべ', 2: 'staff' }, channel: '111111', forum: '222222', answerOrigin: 'https://test.invalid',
    deadline: new Date(Date.now() + 86400000).toISOString(), answerReminder: { ...DEFAULT_ANSWER_REMINDER, time: '00:00' },
    people: [{ id: '300001', name: '本人', schedules: [1, 2] }, { id: '300002', name: '交代者', schedules: [1] }],
    candidates: [{ id: 'c1', date: '2099-12-31', time: '22:00', active: true }],
  };
}
async function command(p: Plan, action: string, body: object, targetEnv = E) {
  const path = `/planning/${p.id}/${action}`;
  return handlePlanningAdmin(new Request(`https://test.invalid/api/admin${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: p.version, ...body }),
  }), targetEnv, path);
}
function discordMock(failDM = false) {
  const calls: { path: string; method: string; body: any }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, method: init?.method ?? 'GET', body });
    if (path.endsWith('/users/@me/channels')) return Response.json({ id: 'dm-' + body.recipient_id });
    if (path.includes('/channels/dm-') && failDM) return Response.json({}, { status: 403 });
    if (path.endsWith('/threads')) return Response.json({ id: '888888', message: { id: '999999' } });
    return Response.json({ id: '999999', thread_metadata: { archived: false } });
  }));
  return calls;
}

it('ranges cross leap days and years, retain two times per day, deduplicate, and reject 201 candidates atomically', async () => {
  expect(candidateRange('2028-02-28', '2028-03-01', '21:00')).toHaveLength(3);
  const ranges = ['21:00', '22:00'].flatMap((t) => candidateRange('2099-12-01', '2100-03-10', t));
  expect(ranges).toHaveLength(200);
  const lines = ranges.map((c) => candidateLine(c, 2099)).join('\n');
  expect(parseCandidateLines(lines + '\n' + lines, 2099)).toHaveLength(200);
  expect(() => parseCandidateLines(lines + '\n2100/3/11', 2099)).toThrow('200');
  expect(() => candidateRange('2099-12-01', '2099-11-01', '')).toThrow();
  expect(() => candidateRange('2099-01-01', '2100-01-01', '')).toThrow('200');
  let p = await createPlan(db, 'guild', { ...data(), state: 'draft' });
  const result = await command(p, 'candidates', { candidates: ranges });
  expect(result.status).toBe(200);
  p = await result.json();
  expect((await command(p, 'candidates', { candidates: [...ranges, { date: '2100-03-11', time: '' }] })).status).toBe(400);
  expect((await getPlan(db, p.id)).version).toBe(p.version);
  const replacement = candidateRange('2101-01-01', '2101-07-19', '21:00');
  expect(replacement).toHaveLength(200);
  expect((await command(p, 'candidates', { candidates: replacement })).status).toBe(200);
  expect((await getPlan(db, p.id)).data.candidates).toHaveLength(400);
  expect((await getPlan(db, p.id)).data.candidates.find((c) => c.id === 'c1')?.active).toBe(false);
});

it('CSV is a BOM-prefixed horizontal answer table with groups, unanswered cells and safe quoted multiline text', () => {
  const d = data();
  d.people[0].name = '=1+1';
  d.candidates.push({ id: 'c2', date: '2100-01-01', time: '', active: true });
  d.answers['300001'] = { values: { c1: '未定', c2: '不可' }, comment: '@evil,"\n補足' };
  const csv = planningCsv(d);
  expect(csv.startsWith('\uFEFF"名前","区分","2099-12-31 22:00","2100-01-01 時刻未定","補足"\r\n')).toBe(true);
  expect(csv).toContain('"\'=1+1","かたりべ / staff","未定","不可","\'@evil,""\n補足"');
  expect(csv).toContain('"交代者","かたりべ","未回答","未回答",""');
});

it('deadline reminders use JST calendar days, configurable intervals and send time, and preserve legacy settings', () => {
  const d = { ...data(), deadline: '2026-10-04T14:59:00Z', answerReminder: { ...DEFAULT_ANSWER_REMINDER } };
  expect(answerReminderDue(d, Date.parse('2026-10-01T11:59:59Z'))).toBe(false);
  expect(answerReminderDue(d, Date.parse('2026-10-01T12:00:00Z'))).toBe(true);
  d.answerReminder.intervalDays = 2;
  expect(answerReminderDue(d, Date.parse('2026-10-02T12:00:00Z'))).toBe(false);
  expect(answerReminderDue(d, Date.parse('2026-10-03T12:00:00Z'))).toBe(true);
  expect(answerReminderDue(d, Date.parse(d.deadline))).toBe(false);
  const old = blankPlan('旧設定');
  editSettings(old, { name: '旧設定', channel: '111111', forum: '222222', remindDays: 5 });
  expect(old.remindDays).toBe(5);
  expect(old.answerReminder).toBeUndefined();
  expect(() => editSettings(old, { ...old, answerReminder: { ...DEFAULT_ANSWER_REMINDER, intervalDays: 0 } })).toThrow();
  expect(() => editSettings(old, { ...old, eventReminderHours: 169 })).toThrow();
});

it('queues one DM per incomplete person/day, supports initial access in DM, and stops completed or removed recipients', async () => {
  const calls = discordMock();
  const d = data();
  d.answers['300002'] = { values: { c1: '不可' }, comment: '' };
  const p = await createPlan(db, 'guild', d);
  const real = { ...E, MOCK_DISCORD: undefined };
  await planningTick(real);
  await planningTick(real);
  expect(calls.filter((c) => c.path.includes('/channels/dm-') && c.method === 'POST')).toHaveLength(1);
  const job = await db.prepare("SELECT * FROM planning_deliveries WHERE kind='answer-dm'").first<any>();
  expect(job.status).toBe('sent');
  expect(calls.find((c) => c.path.includes('/channels/dm-'))!.body.allowed_mentions).toEqual({ parse: [] });
  const reply = await planningInteraction({ type: 3, user: { id: '300001' }, data: { custom_id: `plan:open:${p.id}:0` } }, E, 'https://test.invalid');
  expect(reply.data.components[1].components[0].url).toContain('answer.html');
  const denied = await planningInteraction({ type: 3, guild_id: 'other', user: { id: '300001' }, data: { custom_id: `plan:open:${p.id}:0` } }, E, 'https://test.invalid');
  expect(JSON.stringify(denied)).toContain('対象者ではありません');
  await deliveryStatement(db, p, '1=1', 'completed', 'answer-dm', d.channel, { user: '300002' }).run();
  await deliveryStatement(db, p, '1=1', 'removed', 'answer-dm', d.channel, { user: 'not-a-participant' }).run();
  await deliverPending(real);
  expect(calls.filter((c) => c.path.includes('/channels/dm-') && c.method === 'POST')).toHaveLength(1);
  expect((await db.prepare("SELECT COUNT(*) AS n FROM planning_deliveries WHERE status='cancelled'").first<any>()).n).toBe(2);
});

it('DM rejection notifies the configured Bot failure channel once without a public reminder fallback', async () => {
  const calls = discordMock(true);
  const d = data();
  const p = await createPlan(db, 'guild', d);
  await setConfig(db, failureNotificationKey('guild'), JSON.stringify({ channel_id: '777777', mention_mode: 'none', mention_ids: [] }));
  await deliveryStatement(db, p, '1=1', 'failed-dm', 'answer-dm', d.channel, { user: '300001' }).run();
  await deliverPending({ ...E, MOCK_DISCORD: undefined });
  await deliverPending({ ...E, MOCK_DISCORD: undefined });
  expect((await db.prepare("SELECT status FROM planning_deliveries WHERE id='failed-dm'").first<any>()).status).toBe('failed');
  expect(calls.filter((c) => c.path.endsWith('/channels/777777/messages'))).toHaveLength(1);
  expect(calls.some((c) => c.path.endsWith('/channels/111111/messages'))).toBe(false);
});

it('announcement templates render grouped mentions and free text, enforce lengths, and deduplicate mention recipients', () => {
  const d = { ...data(), announcementTemplate: DEFAULT_ANNOUNCEMENT_TEMPLATE };
  const slot = { id: 'slot', candidate: 'c1', cancelled: false, gather: '21:45まで', note: '開場21:30\nリハーサル9/25 22:00', members: [
    { user: '300001', schedule: 1, status: '参加' as const, duty: '司会' },
    { user: '300001', schedule: 2, status: '参加' as const, duty: '' },
    { user: '300002', schedule: 1, status: '不参加' as const, duty: '' },
  ] };
  const rendered = announcementText(d, slot);
  expect(rendered).toContain('【かたりべ】\n<@300001> / 司会\n<@300002>（不参加）');
  expect(rendered).toContain('【staff】\n<@300001>');
  // 集合・連絡事項 are retired: old templates keep the tokens, which now render empty without leaving a gap.
  expect(announcementText({ ...d, announcementTemplate: 'A\n\n{{集合}}\n{{連絡事項}}\n\n{{名簿}}' }, slot)).not.toMatch(/21:45|開場|\n{3}/);
  expect(rendered).not.toContain('{{');
  const p = { id: 'p', guild_id: 'guild', version: 1, data: d };
  expect(slotPayload(p, slot, true).message.allowed_mentions.users).toEqual(['300001']);
  expect(slotPayload(p, slot, false).message.allowed_mentions.users).toEqual([]);
  expect(() => slotPayload({ ...p, data: { ...d, announcementTemplate: '{{名簿}}'.repeat(100) } }, slot, true)).toThrow('長すぎます');
  expect(() => editSettings(d, { ...d, announcementTemplate: '{{未知の項目}}' })).toThrow();
  // Saving drops the retired tokens and the blank lines they leave behind.
  const saved = structuredClone(d);
  editSettings(saved, { ...saved, announcementTemplate: 'お疲れ様です。\n\n{{名簿}}\n\n{{集合}}\n{{連絡事項}}\n\n欠席は連絡してください。' });
  expect(saved.announcementTemplate).toBe('お疲れ様です。\n\n{{名簿}}\n\n欠席は連絡してください。');
});

it('event reminders post once to the slot forum with @everyone and skip cancellations, unknown times and past starts', async () => {
  const calls = discordMock();
  const d = { ...data(), state: 'confirmed' as const, eventReminderHours: 2 };
  const start = new Date(Date.now() + 3600000 + 9 * 3600000).toISOString();
  d.candidates[0] = { ...d.candidates[0], date: start.slice(0, 10), time: start.slice(11, 16) };
  d.slots = [{ id: 'slot', candidate: 'c1', members: [{ user: '300001', schedule: 1, status: '参加', duty: '' }], gather: '', note: '', cancelled: false }];
  let p = await createPlan(db, 'guild', d);
  await db.prepare("INSERT INTO planning_deliveries(id,plan_id,kind,slot_id,channel_id,payload,status,thread_id,message_id,created_at,updated_at) VALUES('forum',?,'forum','slot','222222','{}','sent','888888','999999',?,?)")
    .bind(p.id, new Date().toISOString(), new Date().toISOString()).run();
  await deliveryStatement(db, p, '1=1', `event-reminder:${p.id}:slot`, 'event-reminder', d.forum, {}, 'slot').run();
  await planningTick({ ...E, MOCK_DISCORD: undefined });
  await planningTick({ ...E, MOCK_DISCORD: undefined });
  const posted = calls.filter((c) => c.path.endsWith('/channels/888888/messages') && c.method === 'POST');
  expect(posted).toHaveLength(1);
  // Rosters change by hand in Discord; @everyone in the thread reaches exactly its members.
  expect(posted[0].body.content.startsWith('@everyone')).toBe(true);
  expect(posted[0].body.allowed_mentions).toEqual({ parse: ['everyone'] });
  expect(calls.some((c) => c.path.includes('/thread-members/'))).toBe(false);
  for (const change of ['cancelled', 'unknown-time', 'past']) {
    const next = structuredClone(d);
    if (change === 'cancelled') next.slots[0].cancelled = true;
    if (change === 'unknown-time') next.candidates[0].time = '';
    if (change === 'past') next.candidates[0].date = '2000-01-01';
    await db.prepare('UPDATE planning_plans SET data=? WHERE id=?').bind(JSON.stringify(next), p.id).run();
    await deliveryStatement(db, p, '1=1', change, 'event-reminder', d.forum, {}, 'slot').run();
    await deliverPending({ ...E, MOCK_DISCORD: undefined });
    expect((await db.prepare('SELECT status FROM planning_deliveries WHERE id=?').bind(change).first<any>()).status).toBe('cancelled');
  }
  expect(calls.filter((c) => c.path.endsWith('/channels/888888/messages') && c.method === 'POST')).toHaveLength(1);
});

it('refreshes roles only on demand in bounded pages, preserves answers and selections, and revokes access only after a complete scan', async () => {
  await db.prepare("INSERT INTO segments(id,guild_id,name,uuid,mention_role_id) VALUES(1,'guild','かたりべ','cast','role1'),(2,'guild','staff','staff',NULL)").run();
  await db.prepare("INSERT INTO members(user_id,user_name) VALUES('300002','手動の対象者'),('100001','休止中')").run();
  await db.prepare("INSERT INTO segment_members(segment_id,user_id,status) VALUES(2,'300002',''),(1,'100001','休止中')").run();
  const d = { ...data(), autoAudience: true, answerReminder: { ...DEFAULT_ANSWER_REMINDER, enabled: false } };
  d.answers['300001'] = { values: { c1: '可' }, comment: '回答を保持' };
  d.slots = [{ id: 'selection', candidate: 'c1', cancelled: false, gather: '', note: '', members: [{ user: '300001', schedule: 1, status: '参加', duty: '' }] }];
  const p = await createPlan(db, 'guild', d);
  const session = await openWebAnswer(p, E, '300001');
  const fetches: string[] = [];
  const members = Array.from({ length: 500 }, (_, i) => ({ user: { id: String(100000 + i), username: `person${i}` }, roles: [1, 2, 401].includes(i) ? ['role1'] : [] }));
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    fetches.push(url.search);
    expect(url.searchParams.get('limit')).toBe('200');
    const after = Number(url.searchParams.get('after'));
    return Response.json(members.filter((m) => Number(m.user.id) > after).slice(0, 200));
  }));
  const real = { ...E, MOCK_DISCORD: undefined };
  await planningTick(real);
  expect(fetches).toHaveLength(0); // Old enabled settings no longer initiate a scan.
  let token: string | null = null;
  for (let i = 0; i < 3; i++) {
    const response = await command(p, 'audience-refresh', token ? { token } : {}, real);
    expect(response.status).toBe(200);
    const result: any = await response.json();
    token = result.token;
    if (i < 2) expect((await getPlan(db, p.id)).data.people).toEqual(d.people);
    else expect(result).toEqual({ token: null, added: 2, removed: 1, total: 3 });
    if (i === 0) {
      expect((await command(p, 'audience-refresh', {}, real)).status).toBe(409);
      expect((await command(p, 'audience-refresh', { token: 'not-the-current-page' }, real)).status).toBe(409);
      expect(fetches).toHaveLength(1);
    }
  }
  expect(fetches).toHaveLength(3);
  const refreshed = await getPlan(db, p.id);
  expect(refreshed.data.people.filter((p) => p.active).map((p) => p.id)).toEqual(['100002', '100401', '300002']);
  expect(refreshed.data.answers).toEqual(d.answers);
  expect(refreshed.data.slots).toEqual(d.slots);
  expect(unanswered(refreshed.data, '300001')).toEqual([]);
  expect((await handlePlanningAnswer(answerRequest(p.id, session.cookie), real)).status).toBe(403);
  expect(fetches).toHaveLength(3); // The normal answer path adds no Discord calls.
  const joined = await openWebAnswer(refreshed, E, '100401');
  expect(joined.snapshot.person.id).toBe('100401');
  await planningTick(real);
  expect(fetches).toHaveLength(3);
  const history = await db.prepare("SELECT before_data,after_data FROM planning_history WHERE kind='audience-refresh'").first<any>();
  expect(JSON.parse(history.before_data).people.find((p: any) => p.id === '300001').active).toBeUndefined();
  expect(JSON.parse(history.after_data).people.find((p: any) => p.id === '300001').active).toBe(false);
  expect(JSON.parse(history.after_data).answers).toBeUndefined(); // Unchanged answers are kept in the plan, not copied into every history row.
  for (let i = 0; i < 3; i++) {
    const response = await command(refreshed, 'audience-refresh', token ? { token } : {}, real);
    const result: any = await response.json();
    token = result.token;
    if (i === 2) expect(result).toEqual({ token: null, added: 0, removed: 0, total: 3 });
  }
  expect((await getPlan(db, p.id)).version).toBe(refreshed.version);
  expect((await db.prepare('SELECT COUNT(*) AS n FROM planning_history').first<any>()).n).toBe(1);
  await db.prepare("UPDATE planning_plans SET data=json_set(data,'$.state','confirmed'),audience_progress=NULL WHERE id=?").bind(p.id).run();
  expect((await command(refreshed, 'audience-refresh', {}, real)).status).toBe(400);
  expect((await getPlan(db, p.id)).data.slots).toEqual(d.slots);
});

it('failed or concurrent audience refresh never publishes partial members or overwrites an answer', async () => {
  await db.prepare("INSERT INTO segments(id,guild_id,name,uuid,mention_role_id) VALUES(1,'guild','役割','role','role1'),(2,'guild','手動','manual',NULL)").run();
  const p = await createPlan(db, 'guild', { ...data(), autoAudience: true });
  const real = { ...E, MOCK_DISCORD: undefined };
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  expect((await command(p, 'audience-refresh', {}, real)).status).toBe(400);
  expect((await getPlan(db, p.id)).data.people).toEqual(p.data.people);
  expect((await db.prepare('SELECT COUNT(*) AS n FROM planning_history').first<any>()).n).toBe(0);
  expect((await db.prepare('SELECT audience_progress FROM planning_plans WHERE id=?').bind(p.id).first<any>()).audience_progress).toBeNull();
  let answered = false;
  vi.stubGlobal('fetch', vi.fn(async () => {
    if (!answered) {
      await db.prepare("UPDATE planning_plans SET version=version+1,data=json_set(data,'$.answers.300001',json(?)) WHERE id=?")
        .bind(JSON.stringify({ values: { c1: '不可' }, comment: '同時に回答' }), p.id).run();
      answered = true;
    }
    return Response.json([]);
  }));
  const retry: any = await (await command(p, 'audience-refresh', {}, real)).json();
  expect(retry.token).toEqual(expect.any(String));
  const latest = await getPlan(db, p.id);
  expect(latest.data.people).toEqual(p.data.people);
  expect(latest.data.answers['300001'].comment).toBe('同時に回答');
  expect((await db.prepare('SELECT COUNT(*) AS n FROM planning_history').first<any>()).n).toBe(0);
  expect(await (await command(p, 'audience-refresh', { token: retry.token }, real)).json())
    .toEqual({ token: null, added: 0, removed: 2, total: 0 });
  expect((await getPlan(db, p.id)).data.answers['300001'].comment).toBe('同時に回答');
});

it('guards manual audience requests, rejects 201 members without a partial update, and recovers an abandoned scan', async () => {
  await db.prepare("INSERT INTO segments(id,guild_id,name,uuid,mention_role_id) VALUES(1,'guild','役割','role','role1'),(2,'guild','手動','manual',NULL)").run();
  const p = await createPlan(db, 'guild', data());
  const real = { ...E, MOCK_DISCORD: undefined };
  const members = Array.from({ length: 201 }, (_, i) => ({ user: { id: String(100000 + i) }, roles: ['role1'] }));
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const after = Number(new URL(String(input)).searchParams.get('after'));
    return Response.json(members.filter((m) => Number(m.user.id) > after).slice(0, 200));
  });
  vi.stubGlobal('fetch', fetcher);
  expect((await command(p, 'audience-refresh', { version: 999 }, real)).status).toBe(409);
  expect((await command(p, 'audience-refresh', { token: {} }, real)).status).toBe(400);
  const path = `/planning/${p.id}/audience-refresh`;
  expect((await handlePlanningAdmin(new Request('https://test.invalid' + path), real, path)).status).toBe(405);
  expect(fetcher).not.toHaveBeenCalled();
  const first: any = await (await command(p, 'audience-refresh', {}, real)).json();
  const over = await command(p, 'audience-refresh', { token: first.token }, real);
  expect(over.status).toBe(400);
  expect(await over.text()).toContain('200人');
  expect((await getPlan(db, p.id)).data).toEqual(p.data);
  members.splice(3);
  // A closed tab leaves only temporary progress; a later click starts a fresh scan.
  await db.prepare('UPDATE planning_plans SET audience_progress=? WHERE id=?')
    .bind(JSON.stringify({ token: 'abandoned', checked: Date.now() - 61000, people: [{ id: 'stale', name: '古い取得結果', schedules: [1] }] }), p.id).run();
  expect(await (await command(p, 'audience-refresh', {}, real)).json()).toEqual({ token: null, added: 3, removed: 2, total: 3 });
  expect((await getPlan(db, p.id)).data.people.some((u) => u.id === 'stale')).toBe(false);
  for (const change of [{ state: 'draft' }, { state: 'confirmed' }, { state: 'cancelled' }, { deadline: '2000-01-01T00:00:00Z' }, { standalone: false }]) {
    await db.prepare('UPDATE planning_plans SET data=? WHERE id=?').bind(JSON.stringify({ ...p.data, ...change }), p.id).run();
    expect((await command(p, 'audience-refresh', {}, real)).status).toBe(400);
  }
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it('stores 200 candidates × 200 participants with full comments and a participant edit within D1 row limits', async () => {
  const d = data();
  d.people = Array.from({ length: 200 }, (_, i) => ({ id: String(500000 + i), name: '名'.repeat(32), schedules: [1] }));
  d.candidates = Array.from({ length: 200 }, (_, i) => ({ id: `c${i + 1}`, date: '2099-10-01', time: '21:00', active: true }));
  d.answers = Object.fromEntries(d.people.map((u) => [u.id, { values: Object.fromEntries(d.candidates.map((c) => [c.id, '未定'])), comment: '補'.repeat(500) }]));
  d.answerVersions = Object.fromEntries(d.people.map((u) => [u.id, 2]));
  const p = await createPlan(db, 'guild', d);
  const next = structuredClone(p.data);
  next.answers['500000'].values.c1 = '可';
  const saved = await savePlan(db, p, next, 'admin-answer', '本人確認', '500000');
  expect(saved.data.answers['500199'].comment).toHaveLength(500);
  expect(saved.data.answers['500000'].values.c1).toBe('可');
  expect(saved.data.answerVersions?.['500000']).toBe(saved.version);
  const sizes = await db.prepare(`SELECT length(CAST(data AS BLOB)) AS planBytes,
    (SELECT length(CAST(before_data AS BLOB))+length(CAST(after_data AS BLOB)) FROM planning_history WHERE plan_id=p.id) AS historyBytes
    FROM planning_plans p WHERE id=?`).bind(p.id).first<any>();
  expect(sizes.planBytes).toBeLessThan(1800000);
  expect(sizes.historyBytes).toBeLessThan(2000000);
  const history = await db.prepare('SELECT before_data,after_data FROM planning_history WHERE plan_id=?').bind(p.id).first<any>();
  expect(Object.keys(JSON.parse(history.after_data).answers)).toEqual(['500000']);
  expect(JSON.parse(history.before_data).answers['500000'].values.c1).toBe('未定');
});

it('cron queues a relative reminder across midnight once and cancels expired jobs without a forum', async () => {
  const calls = discordMock();
  const d = { ...data(), state: 'confirmed' as const, eventReminderHours: 48 };
  d.candidates[0] = { ...d.candidates[0], date: new Date(Date.now() + 33 * 3600000).toISOString().slice(0, 10), time: '00:30' };
  d.slots = [{ id: 'slot', candidate: 'c1', members: [{ user: '300001', schedule: 1, status: '参加', duty: '' }], gather: '', note: '', cancelled: false }];
  const p = await createPlan(db, 'guild', d);
  await db.prepare("INSERT INTO planning_deliveries(id,plan_id,kind,slot_id,channel_id,payload,status,thread_id,message_id,created_at,updated_at) VALUES('forum',?,'forum','slot','222222','{}','sent','888888','999999',?,?)")
    .bind(p.id, new Date().toISOString(), new Date().toISOString()).run();
  await planningTick({ ...E, MOCK_DISCORD: undefined });
  await planningTick({ ...E, MOCK_DISCORD: undefined });
  expect(calls.filter((c) => c.path.endsWith('/channels/888888/messages') && c.method === 'POST')).toHaveLength(1);
  expect((await db.prepare("SELECT COUNT(*) AS n FROM planning_deliveries WHERE kind='event-reminder'").first<any>()).n).toBe(1);
  const past = structuredClone(d); past.candidates[0].date = '2000-01-01';
  const other = await createPlan(db, 'guild', past);
  await deliveryStatement(db, other, '1=1', 'expired-without-forum', 'event-reminder', d.forum, {}, 'slot').run();
  await planningTick(E);
  expect((await db.prepare("SELECT status FROM planning_deliveries WHERE id='expired-without-forum'").first<any>()).status).toBe('cancelled');
});

it('leaving a guild stops modern reminders and role refresh as well as legacy reminders', async () => {
  const p = await createPlan(db, '123456', { ...data(), autoAudience: true, eventReminderHours: 2 });
  const legacy = await createPlan(db, '123456', { ...data(), answerReminder: undefined, remindDays: 3 });
  const response = await handleAdmin(new Request('https://test.invalid/api/admin/guilds/123456/leave', {
    method: 'POST', headers: { Authorization: 'Bearer test-admin' },
  }), { ...E, ADMIN_TOKEN: 'test-admin' });
  expect(response.status).toBe(200);
  const stopped = await getPlan(db, p.id);
  expect(stopped.data.answerReminder?.enabled).toBe(false);
  expect(stopped.data.eventReminderHours).toBe(0);
  expect(stopped.data.autoAudience).toBe(false);
  expect((await getPlan(db, legacy.id)).data.answerReminder).toBeUndefined();
  expect((await getPlan(db, legacy.id)).data.remindDays).toBe(0);
  await planningTick(E);
  expect((await db.prepare('SELECT COUNT(*) AS n FROM planning_deliveries').first<any>()).n).toBe(0);
});

it('reminds the candidate creator daily at the send time from N days before the posting due date until the due date, without creating a draft', async () => {
  const calls = discordMock();
  const jstDate = (offsetDays: number) => new Date(Date.now() + 9 * 3600000 + offsetDays * 86400000).toISOString().slice(0, 10);
  const today = jstDate(0), due = jstDate(2);
  const cycle = (name: string, nextDate: string) => ({
    standalone: true, name, segments: [1], schedules: [], channel: '111111', forum: '222222', tag: '',
    rrule: `FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=${Number(nextDate.slice(8))}`, anchor: nextDate, time: '00:00',
    adminChannel: '333333', mentionMode: 'users', mentions: ['555555', 'role:444444'], taskReminderDays: 3, origin: 'https://test.invalid',
  });
  await db.prepare('INSERT INTO planning_cycles(id,guild_id,data,next_date,enabled) VALUES(?,?,?,?,1),(?,?,?,?,1)')
    .bind('soon', 'guild', JSON.stringify(cycle('近い期限', due)), due, 'later', 'guild', JSON.stringify(cycle('遠い期限', jstDate(9))), jstDate(9)).run();
  const real = { ...E, MOCK_DISCORD: undefined };
  const posts = () => calls.filter((c) => c.path.endsWith('/channels/333333/messages') && c.method === 'POST');
  await planningTick(real);
  await planningTick(real);
  expect(posts()).toHaveLength(1); // Only the cycle inside its reminder lead fires; two ticks on the same day post once.
  expect((await db.prepare('SELECT COUNT(*) AS n FROM planning_plans').first<any>()).n).toBe(0); // No draft is created.
  const rows = (await db.prepare('SELECT id,next_date,reminded_on FROM planning_cycles ORDER BY id').all<any>()).results;
  expect(rows).toEqual([{ id: 'later', next_date: jstDate(9), reminded_on: null }, { id: 'soon', next_date: due, reminded_on: today }]);
  const body = posts()[0].body;
  expect(body.content).toContain(`回答案内の投稿期限: ${due.replace(/-/g, '/')}`);
  expect(body.content.startsWith('<@555555> <@&444444>\n')).toBe(true); // People and roles mix; role ids carry the role: prefix.
  expect(body.content.endsWith('/admin#g/guild/planning')).toBe(true); // Links to the list: the operator creates the 日程調整 by hand.
  expect(body.allowed_mentions).toEqual({ parse: [], users: ['555555'], roles: ['444444'] });
  await db.prepare("UPDATE planning_cycles SET reminded_on='2000-01-01' WHERE id='soon'").run(); // Yesterday's reminder.
  await planningTick(real);
  expect(posts()).toHaveLength(2);
  await db.prepare("UPDATE planning_cycles SET task_status='complete',reminded_on='2000-01-01' WHERE id='soon'").run(); // The announcement was posted.
  await planningTick(real);
  expect(posts()).toHaveLength(2);
  await db.prepare("UPDATE planning_cycles SET next_date=? WHERE id='soon'").bind(jstDate(-1)).run(); // The due date passed.
  await planningTick(real);
  expect(await db.prepare("SELECT next_date,task_status,reminded_on FROM planning_cycles WHERE id='soon'").first<any>()).toEqual({ next_date: due, task_status: 'pending', reminded_on: today });
  expect(posts()).toHaveLength(3);
});

it('mentions the segment roles on the answer announcement when enabled, and drops them once the setting is off', async () => {
  await db.prepare("INSERT INTO segments(id,guild_id,name,uuid,mention_role_id) VALUES(1,'guild','かたりべ','cast','4001'),(2,'guild','全員','all','@everyone')").run();
  let p = await createPlan(db, 'guild', { ...data(), state: 'draft', announceMention: 'role', people: [] });
  expect((await command(p, 'publish', {})).status).toBe(200);
  p = await getPlan(db, p.id);
  expect(p.data.mentionRoles).toEqual(['4001', '@everyone']);
  const publish = JSON.parse((await db.prepare("SELECT payload FROM planning_deliveries WHERE plan_id=? AND kind='publish'").bind(p.id).first<any>()).payload);
  expect(publish.content.startsWith('@everyone <@&4001>\n絵本の平行世界\n')).toBe(true);
  expect(publish.allowed_mentions).toEqual({ parse: ['everyone'], roles: ['4001'] });
  await db.prepare("UPDATE planning_deliveries SET status='sent' WHERE plan_id=?").bind(p.id).run();
  p = await savePlan(db, p, { ...p.data, announceMention: 'none' }, 'settings');
  expect((await command(p, 'repost', {})).status).toBe(200);
  const repost = JSON.parse((await db.prepare("SELECT payload FROM planning_deliveries WHERE plan_id=? AND kind='repost'").bind(p.id).first<any>()).payload);
  expect(repost.content.startsWith('絵本の平行世界\n')).toBe(true);
  expect(repost.allowed_mentions).toEqual({ parse: [] });
  expect((await getPlan(db, p.id)).data.mentionRoles).toEqual([]);
  expect(() => editSettings(blankPlan('x'), { name: 'x', channel: '111111', forum: '222222', announceMention: 'all' })).toThrow();
});

it('posts one channel reminder per day mentioning the incomplete people when the reminder target is the channel', async () => {
  const calls = discordMock();
  const p = await createPlan(db, 'guild', { ...data(), answerReminder: { ...DEFAULT_ANSWER_REMINDER, time: '00:00', target: 'channel' } });
  const real = { ...E, MOCK_DISCORD: undefined };
  await planningTick(real);
  await planningTick(real);
  const rows = (await db.prepare('SELECT kind,channel_id,status FROM planning_deliveries WHERE plan_id=?').bind(p.id).all<any>()).results;
  expect(rows).toEqual([{ kind: 'reminder', channel_id: '111111', status: 'sent' }]);
  const post = calls.find((c) => c.path.includes('/channels/111111/messages') && c.method === 'POST')!;
  expect(post.body.content.startsWith('<@300001> <@300002>\n絵本の平行世界\n未回答の候補があります。')).toBe(true);
  expect(post.body.allowed_mentions).toEqual({ parse: [], users: ['300001', '300002'] });
  expect(calls.some((c) => c.path.includes('/users/@me/channels'))).toBe(false);
  expect(() => editSettings(blankPlan('x'), { name: 'x', channel: '111111', forum: '222222', answerReminder: { ...DEFAULT_ANSWER_REMINDER, target: 'mail' } })).toThrow();
});

it('a used personal link opened again from a remembered browser shows the answer page, but not without the browser memory', async () => {
  const p = await createPlan(db, 'guild', data());
  const session = await openWebAnswer(p, E, '300001');
  const again = await handlePlanningAnswer(answerRequest(p.id, session.cookie, { key: session.key }, '/exchange'), E);
  expect(again.status).toBe(200);
  expect(((await again.json()) as any).person.id).toBe('300001');
  expect(again.headers.get('Set-Cookie')).toBeNull();
  const fresh = await handlePlanningAnswer(answerRequest(p.id, '', { key: session.key }, '/exchange'), E);
  expect(fresh.status).toBe(401);
  expect(((await fresh.json()) as any).error).toContain('使用済み');
});

it("shares every respondent's answers on the answer page only when the plan allows it, and never their comments", async () => {
  const d = data();
  d.answers['300002'] = { values: { c1: '不可' }, comment: '秘密の補足' };
  let p = await createPlan(db, 'guild', d);
  let session = await openWebAnswer(p, E, '300001');
  expect(session.snapshot.others).toBeUndefined();
  p = await createPlan(db, 'guild', { ...d, shareAnswers: true });
  session = await openWebAnswer(p, E, '300001');
  expect(session.snapshot.others).toEqual([{ name: '本人', values: {} }, { name: '交代者', values: { c1: '不可' } }]);
  expect(JSON.stringify(session.snapshot)).not.toContain('秘密の補足');
  const saved = await handlePlanningAnswer(answerRequest(p.id, session.cookie, { version: session.snapshot.version, values: { c1: '可' }, comment: '' }), E);
  expect(saved.status).toBe(200);
  expect(((await saved.json()) as any).others[0]).toEqual({ name: '本人', values: { c1: '可' } });
  expect(() => editSettings(blankPlan('x'), { name: 'x', channel: '111111', forum: '222222', shareAnswers: 'yes' })).toThrow();
});
