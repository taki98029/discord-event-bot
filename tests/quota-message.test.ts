import { afterEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import type { Notification } from '../src/db/types';
import { handleAdmin } from '../src/admin';
import { createSegment } from '../src/db/segments';
import { getOrCreateOccurrence } from '../src/db/occurrences';
import { claimSend, finishSend } from '../src/db/sendLog';
import { setConfig } from '../src/db/config';
import { runTick } from '../src/cron/tick';
import { formatDate, getJSTNow } from '../src/lib/date';
import { DEFAULT_QUOTA_MESSAGE, quotaMessage, quotaMessageError } from '../src/lib/quotaMessage';

const E = { ...env, ADMIN_TOKEN: 'quota-test', MOCK_DISCORD: '1', DISCORD_BOT_TOKEN: 'dummy' } as Env;
const db = env.DB;
const member = { user_id: '3001', user_name: 'global', display_name: 'あおい', lastDateStr: '2026/08/01', daysSinceLast: 37 };
const custom = '{{名前}}さん、こんにちは！\n{{サーバー名}}での前回参加は{{最終参加日}}（{{経過日数}}日前）。目安は{{参加間隔}}日です。';
afterEach(() => vi.unstubAllGlobals());

const call = (method: string, path: string, body?: unknown) => handleAdmin(new Request(`https://test.invalid/api/admin${path}`, {
  method, headers: { Authorization: 'Bearer quota-test', 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
}), E);
async function schedule() {
  const s = await createSegment(db, { guild_id: '1001', name: '対象者', mention_role_id: null });
  const body = { guild_id: '1001', segment_uuid: s.uuid, name: 'テスト会', channel_id: '2001', message_title: '募集', rrule: null,
    start_time: '23:59', send_hour: 0, recruit_enabled: 0, remind_unanswered_enabled: 0, remind_undecided_enabled: 0,
    quota_enabled: 1, quota_interval_days: 30, quota_message: custom };
  const res = await call('POST', '/notifications', body);
  expect(res.status).toBe(201);
  return { body, n: await res.json() as Notification };
}

it('keeps the default DM and resolves custom fields once, preserving line breaks and server nicknames', () => {
  const n = { quota_interval_days: 30 };
  const expected = '📊 **参加間隔の確認**（集い）\n\nこんにちは、**あおい** さん！\n' +
    '前回のイベント参加から少し時間が空いているようです（目安: 30日に1回）。\n\n' +
    '- 最終参加: **2026/08/01** (37日前)\n\n次回のイベントへの参加をぜひご検討ください！お待ちしています✨';
  expect(quotaMessage(n, member, '集い')).toBe(expected);
  expect(quotaMessage({ ...n, quota_message: ' ' }, member, '')).toBe(expected.replace('（集い）', ''));
  expect(quotaMessage({ ...n, quota_message: custom }, member, '集い')).toBe('あおいさん、こんにちは！\n集いでの前回参加は2026/08/01（37日前）。目安は30日です。');
  expect(quotaMessage({ ...n, quota_message: '{{名前}}' }, { ...member, display_name: '{{参加間隔}}' }, '集い')).toBe('{{参加間隔}}');
  expect(quotaMessageError(DEFAULT_QUOTA_MESSAGE)).toBeNull();
  expect(quotaMessageError('文'.repeat(1500))).toBeNull();
  for (const bad of ['文'.repeat(1501), '{{不明}}', '{{名前}}'.repeat(11), {}, 1]) expect(quotaMessageError(bad)).not.toBeNull();
  const emoji = quotaMessage({ ...n, quota_message: '{{サーバー名}}'.repeat(10) }, member, '😀'.repeat(100));
  expect(quotaMessageError('{{サーバー名}}'.repeat(10))).toBeNull();
  expect(emoji.length).toBe(2000);
  expect(Array.from(emoji)).toHaveLength(1000);
});

it('saves and reloads text, retains it while disabled and on old-client edits, rejects invalid text, and resets to default', async () => {
  const { n, body } = await schedule();
  const path = `/notifications/${n.uuid}`;
  expect((await (await call('GET', path)).json() as Notification).quota_message).toBe(custom);
  const updated = '変更後\n{{名前}}さん、またお待ちしています。';
  expect((await call('PUT', path, { ...body, quota_enabled: 0, quota_message: updated })).status).toBe(200);
  const { quota_message: omitted, ...oldClient } = body;
  expect(omitted).toBe(custom);
  expect((await call('PUT', path, oldClient)).status).toBe(200);
  expect((await (await call('GET', path)).json() as Notification).quota_message).toBe(updated);
  for (const bad of ['文'.repeat(1501), '{{知らない項目}}', '{{名前}}'.repeat(11), { text: '不正' }]) {
    expect((await call('PUT', path, { ...body, quota_message: bad })).status).toBe(400);
    expect((await call('POST', '/notifications', { ...body, quota_message: bad })).status).toBe(400);
  }
  expect((await (await call('GET', path)).json() as Notification).quota_message).toBe(updated);
  expect((await call('PUT', path, { ...body, quota_message: ' \n ' })).status).toBe(200);
  expect((await (await call('GET', path)).json() as Notification).quota_message).toBeNull();
});

it('cron sends the persisted custom quota DM after recruitment and retains send-log deduplication', async () => {
  const { n } = await schedule();
  const today = formatDate(getJSTNow());
  const upcoming = await getOrCreateOccurrence(db, n.id, formatDate(new Date(Date.now() + 3 * 86400000)), '23:59', 'manual');
  const past = await getOrCreateOccurrence(db, n.id, '2020/01/01', '21:00', 'manual');
  await db.batch([
    db.prepare("INSERT INTO members(user_id,user_name,display_name,dm_channel_id) VALUES('3001','global','あおい','dm-3001')"),
    db.prepare("INSERT INTO segment_members(segment_id,user_id,status) VALUES(?,'3001','')").bind(n.segment_id),
    db.prepare("INSERT INTO responses(occurrence_id,user_id,status,updated_at) VALUES(?,'3001','参加',?)").bind(past.id, new Date().toISOString()),
  ]);
  const key = { notification_id: n.id, occurrence_id: upcoming.id, kind: 'recruit' as const, send_date: today };
  await claimSend(db, key);
  await finishSend(db, key, true);
  await setConfig(db, 'guild_names', JSON.stringify({ day: today, names: { '1001': '集い' } }));
  const sent: { url: string; body: { content: string } }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return Response.json({ id: 'message' });
  }));
  await runTick(E);
  await runTick(E);
  expect(sent).toHaveLength(1);
  expect(sent[0].url).toContain('/channels/dm-3001/messages');
  expect(sent[0].body.content).toMatch(/^あおいさん、こんにちは！\n集いでの前回参加は2020\/01\/01（\d+日前）。目安は30日です。$/);
  expect((await db.prepare("SELECT status FROM send_log WHERE kind='quota'").first<{ status: string }>())?.status).toBe('sent');
});
