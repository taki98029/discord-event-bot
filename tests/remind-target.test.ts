import { afterEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import { handleAdmin } from '../src/admin';
import { createSegment } from '../src/db/segments';
import { getOrCreateOccurrence } from '../src/db/occurrences';
import { claimSend, finishSend } from '../src/db/sendLog';
import { runTick } from '../src/cron/tick';
import { formatDate, getJSTNow } from '../src/lib/date';

const E = { ...env, ADMIN_TOKEN: 'target-test', MOCK_DISCORD: '1', DISCORD_BOT_TOKEN: 'dummy' } as Env;
const db = env.DB;
afterEach(() => vi.unstubAllGlobals());
const call = (method: string, path: string, body?: unknown) =>
  handleAdmin(
    new Request(`https://test.invalid/api/admin${path}`, {
      method,
      headers: { Authorization: 'Bearer target-test', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    E,
  );

it('posts one channel reminder per day mentioning everyone unanswered when remind_target is channel', async () => {
  const s = await createSegment(db, { guild_id: '1001', name: '対象者', mention_role_id: null });
  const body = { guild_id: '1001', segment_uuid: s.uuid, name: 'テスト会', channel_id: '2001', message_title: '募集', rrule: null, start_time: '23:59', send_hour: 0, recruit_enabled: 0, remind_undecided_enabled: 0, remind_start_days: 7, remind_target: 'channel' };
  const res = await call('POST', '/notifications', body);
  expect(res.status).toBe(201);
  const n: any = await res.json();
  expect(n.remind_target).toBe('channel');
  const today = formatDate(getJSTNow());
  const upcoming = await getOrCreateOccurrence(db, n.id, formatDate(new Date(Date.now() + 3 * 86400000)), '23:59', 'manual');
  await db.batch([
    db.prepare("INSERT INTO members(user_id,user_name,display_name) VALUES('3001','a','あおい'),('3002','b','けんた')"),
    db.prepare("INSERT INTO segment_members(segment_id,user_id,status) VALUES(?,'3001',''),(?,'3002','')").bind(n.segment_id, n.segment_id),
  ]);
  const key = { notification_id: n.id, occurrence_id: upcoming.id, kind: 'recruit' as const, send_date: today };
  await claimSend(db, key);
  await finishSend(db, key, true);
  const sent: { url: string; body: any }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return Response.json({ id: 'message' });
  }));
  await runTick(E);
  await runTick(E);
  expect(sent).toHaveLength(1);
  expect(sent[0].url).toContain('/channels/2001/messages');
  expect(sent[0].body.content).toMatch(/^<@3001> <@3002>\n\n⏰ \*\*リマインド: あと\d日のイベント\*\*（テスト会）\n日時: /);
  expect(sent[0].body.allowed_mentions).toEqual({ parse: ['users'] });
  expect(sent[0].body.components).toBeTruthy();
  const log = (await db.prepare("SELECT user_id,kind,status FROM send_log WHERE kind='remind_unanswered'").all<any>()).results;
  expect(log).toEqual([{ user_id: '', kind: 'remind_unanswered', status: 'sent' }]);
  expect((await call('PUT', `/notifications/${n.uuid}`, { ...body, remind_target: 'dm' })).status).toBe(200);
  expect(((await (await call('GET', `/notifications/${n.uuid}`)).json()) as any).remind_target).toBe('dm');
  expect((await call('POST', '/notifications', { ...body, remind_target: 'mail' })).status).toBe(201);
  // 📊 状況確認の公開: 省略は公開（1）、false で非公開（0）
  expect(n.share_answers).toBe(1);
  expect((await call('PUT', `/notifications/${n.uuid}`, { ...body, share_answers: false })).status).toBe(200);
  expect(((await (await call('GET', `/notifications/${n.uuid}`)).json()) as any).share_answers).toBe(0);
});

it('splits the channel reminder into 40-person posts: body and buttons first, mentions only after', async () => {
  const s = await createSegment(db, { guild_id: '1001', name: '大所帯', mention_role_id: null });
  const body = { guild_id: '1001', segment_uuid: s.uuid, name: '大会', channel_id: '2001', message_title: '募集', rrule: null, start_time: '23:59', send_hour: 0, recruit_enabled: 0, remind_undecided_enabled: 0, remind_start_days: 7, remind_target: 'channel' };
  const n: any = await (await call('POST', '/notifications', body)).json();
  const today = formatDate(getJSTNow());
  const upcoming = await getOrCreateOccurrence(db, n.id, formatDate(new Date(Date.now() + 3 * 86400000)), '23:59', 'manual');
  const ids = Array.from({ length: 45 }, (_, i) => String(5000 + i));
  await db.batch(
    ids.flatMap((id) => [
      db.prepare("INSERT INTO members(user_id,user_name,display_name) VALUES(?,?,?)").bind(id, id, id),
      db.prepare("INSERT INTO segment_members(segment_id,user_id,status) VALUES(?,?,'')").bind(n.segment_id, id),
    ]),
  );
  const key = { notification_id: n.id, occurrence_id: upcoming.id, kind: 'recruit' as const, send_date: today };
  await claimSend(db, key);
  await finishSend(db, key, true);
  const sent: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)));
    return Response.json({ id: 'message' });
  }));
  await runTick(E);
  await runTick(E);
  expect(sent).toHaveLength(2);
  expect(sent[0].content.match(/<@\d+>/g)).toHaveLength(40);
  expect(sent[0].content).toContain('リマインド');
  expect(sent[0].components).toBeTruthy();
  expect(sent[1].content).toBe(ids.slice(40).map((id) => `<@${id}>`).join(' '));
  expect(sent[1].components).toBeUndefined();
  expect(sent[0].content).not.toContain('ほか');
  const log = (await db.prepare("SELECT user_id FROM send_log WHERE kind='remind_unanswered' AND notification_id=? ORDER BY user_id").bind(n.id).all<any>()).results;
  expect(log.map((r: any) => r.user_id)).toEqual(['', 'chunk:40']);
});

it('does not judge an irregular template by its hidden start time (E4 is per date)', async () => {
  const s = await createSegment(db, { guild_id: '1001', name: '単発', mention_role_id: null });
  // 当日 21 時送信 × 雛形の開始 09:00 は定期なら E4 で 400。単発は開始時刻を開催日時ごとに持つので保存できる
  const body = { guild_id: '1001', segment_uuid: s.uuid, name: '単発会', channel_id: '2001', message_title: '募集', start_time: '09:00', send_hour: 21, recruit_days_before: 3, remind_start_days: 0, remind_undecided_enabled: 0 };
  expect((await call('POST', '/notifications', { ...body, rrule: null })).status).toBe(201);
  expect((await call('POST', '/notifications', { ...body, rrule: 'FREQ=WEEKLY;BYDAY=SA' })).status).toBe(400);
});

it('keeps the duration per occurrence for an irregular schedule (template has none)', async () => {
  const s = await createSegment(db, { guild_id: '1001', name: '単発時間', mention_role_id: null });
  const body = { guild_id: '1001', segment_uuid: s.uuid, name: '時間会', channel_id: '2001', message_title: '募集', rrule: null, start_time: '23:59', send_hour: 0, recruit_enabled: 0, remind_undecided_enabled: 0, remind_start_days: 0 };
  const n: any = await (await call('POST', '/notifications', body)).json();
  expect(n.duration_minutes).toBeNull();
  const date = formatDate(new Date(Date.now() + 5 * 86400000));
  const res = await call('POST', `/notifications/${n.uuid}/occurrences`, { date, start_time: '20:00', duration_minutes: '90' });
  expect(res.status).toBe(201);
  const occ: any = await res.json();
  expect(occ.duration_minutes).toBe(90);
  // 空欄の再登録は既存の値を変えない
  expect(((await (await call('POST', `/notifications/${n.uuid}/occurrences`, { date, start_time: '20:00', duration_minutes: '' })).json()) as any).duration_minutes).toBe(90);
  const sent: { body: any }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ body: JSON.parse(String(init?.body)) });
    return Response.json({ id: 'message' });
  }));
  expect((await call('POST', `/occurrences/${occ.uuid}/recruit`, {})).status).toBe(200);
  expect(sent[0].body.content).toContain('20:00〜21:30');
});

it('sends the undecided reminder to the channel while the unanswered one stays DM', async () => {
  const s = await createSegment(db, { guild_id: '1001', name: '別送り先', mention_role_id: null });
  const body = { guild_id: '1001', segment_uuid: s.uuid, name: '分離会', channel_id: '2001', message_title: '募集', rrule: null, start_time: '23:59', send_hour: 0, recruit_enabled: 0, remind_start_days: 7, remind_undecided_days: 7, remind_target: 'dm', remind_undecided_target: 'channel' };
  const n: any = await (await call('POST', '/notifications', body)).json();
  expect([n.remind_target, n.remind_undecided_target]).toEqual(['dm', 'channel']);
  expect((await call('PUT', `/notifications/${n.uuid}`, { ...body, remind_undecided_target: 'dm' })).status).toBe(200);
  expect(((await (await call('GET', `/notifications/${n.uuid}`)).json()) as any).remind_undecided_target).toBe('dm');
  await call('PUT', `/notifications/${n.uuid}`, body);
  const today = formatDate(getJSTNow());
  const upcoming = await getOrCreateOccurrence(db, n.id, formatDate(new Date(Date.now() + 3 * 86400000)), '23:59', 'manual');
  await db.batch([
    db.prepare("INSERT INTO members(user_id,user_name,display_name) VALUES('3101','a','未回答'),('3102','b','未定')"),
    db.prepare("INSERT INTO segment_members(segment_id,user_id,status) VALUES(?,'3101',''),(?,'3102','')").bind(n.segment_id, n.segment_id),
    db.prepare("INSERT INTO responses(occurrence_id,user_id,user_name,status,updated_at) VALUES(?,'3102','b','未定','2026-01-01T00:00:00Z')").bind(upcoming.id),
  ]);
  const key = { notification_id: n.id, occurrence_id: upcoming.id, kind: 'recruit' as const, send_date: today };
  await claimSend(db, key);
  await finishSend(db, key, true);
  const sent: { url: string; body: any }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
    return Response.json({ id: 'message' });
  }));
  await runTick(E);
  const channel = sent.filter((x) => x.url.includes('/channels/2001/messages'));
  expect(channel).toHaveLength(1);
  expect(channel[0].body.content).toContain('未定者へのリマインド');
  expect(channel[0].body.content).toContain('<@3102>');
  const log = (await db.prepare("SELECT user_id,kind FROM send_log WHERE notification_id=? AND kind LIKE 'remind_%' ORDER BY kind").bind(n.id).all<any>()).results;
  expect(log).toEqual([{ user_id: '3101', kind: 'remind_unanswered' }, { user_id: '', kind: 'remind_undecided' }]);
});

it('keeps the send hour and posting flow per occurrence for an irregular template', async () => {
  const s = await createSegment(db, { guild_id: '1001', name: '流れ', mention_role_id: null });
  // テンプレートは手動募集・送信 5 時。開催回で「自動募集 7 日前・送信 0 時」に上書きする
  const body = { guild_id: '1001', segment_uuid: s.uuid, name: '流れ会', channel_id: '2001', message_title: '募集', rrule: null, start_time: '23:59', send_hour: 5, recruit_enabled: 0, remind_unanswered_enabled: 0, remind_undecided_enabled: 0 };
  const n: any = await (await call('POST', '/notifications', body)).json();
  const date = formatDate(new Date(Date.now() + 3 * 86400000));
  // 順序ルールは開催回でも判定する（未回答リマインドの開始が募集より前 → E1）
  const bad = await call('POST', `/notifications/${n.uuid}/occurrences`, { date, start_time: '20:00', send_hour: 0, recruit_enabled: 1, recruit_days_before: 7, remind_unanswered_enabled: 1, remind_start_days: 9 });
  expect(bad.status).toBe(400);
  const res = await call('POST', `/notifications/${n.uuid}/occurrences`, { date, start_time: '20:00', send_hour: 0, recruit_enabled: 1, recruit_days_before: 7, remind_unanswered_enabled: 0, remind_undecided_enabled: 0, remind_target: 'channel' });
  expect(res.status).toBe(201);
  const occ: any = await res.json();
  expect([occ.send_hour, occ.recruit_enabled, occ.recruit_days_before, occ.remind_target]).toEqual([0, 1, 7, 'channel']);
  const listed: any[] = await (await call('GET', `/notifications/${n.uuid}/occurrences`)).json();
  expect(listed.find((o) => o.uuid === occ.uuid).recruit_enabled).toBe(1);
  await db.prepare("INSERT INTO members(user_id,user_name,display_name) VALUES('3201','a','あ')").run();
  await db.prepare("INSERT INTO segment_members(segment_id,user_id,status) VALUES(?,'3201','')").bind(n.segment_id).run();
  const sent: { url: string }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
    sent.push({ url: String(url) });
    return Response.json({ id: 'message' });
  }));
  // テンプレートは手動募集だが、開催回の値（自動・0 時）で cron が募集を投稿する
  await runTick(E);
  expect(sent.some((x) => x.url.includes('/channels/2001/messages'))).toBe(true);
  const log = (await db.prepare("SELECT kind FROM send_log WHERE notification_id=? AND occurrence_id=?").bind(n.id, occ.id).all<any>()).results;
  expect(log.map((r: any) => r.kind)).toEqual(['recruit']);
});
