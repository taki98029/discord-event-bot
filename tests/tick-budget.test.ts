// 毎分 cron の 1 実行あたりの上限（Free: D1 50 クエリ・subrequest 50）を超えないこと（2026-10-03 リリース前レビュー R-02/R-03/R-06）。
import { afterEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import { handleAdmin } from '../src/admin';
import { createSegment } from '../src/db/segments';
import { getOrCreateOccurrence } from '../src/db/occurrences';
import { claimSend, finishSend } from '../src/db/sendLog';
import { countingD1, isPlanningMinute, runTick } from '../src/cron/tick';
import { formatDate, getJSTNow } from '../src/lib/date';

const db = env.DB;
afterEach(() => vi.unstubAllGlobals());
const E = { ...env, ADMIN_TOKEN: 'budget-test', MOCK_DISCORD: '1', DISCORD_BOT_TOKEN: 'dummy' } as Env;
const call = (method: string, path: string, body?: unknown, e: Env = E) =>
  handleAdmin(
    new Request(`https://test.invalid/api/admin${path}`, {
      method,
      headers: { Authorization: 'Bearer budget-test', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    e,
  );
const inDays = (d: number) => formatDate(new Date(Date.now() + d * 86400000));

/** 募集を投稿済みにした開催回を用意する（以降の工程＝リマインドが動く状態） */
async function postedOccurrence(n: { id: number }, days: number) {
  const occ = await getOrCreateOccurrence(db, n.id, inDays(days), '23:59', 'manual');
  const key = { notification_id: n.id, occurrence_id: occ.id, kind: 'recruit' as const, send_date: formatDate(getJSTNow()) };
  await claimSend(db, key);
  await finishSend(db, key, true);
  return occ;
}

it('45 人への DM リマインドを 1 実行 50 クエリ以内で配り、sending を残さず二重送信もしない', async () => {
  const s = await createSegment(db, { guild_id: '1001', name: '大所帯', mention_role_id: null });
  const body = { guild_id: '1001', segment_uuid: s.uuid, name: '大会', channel_id: '2001', message_title: '募集', rrule: null, start_time: '23:59', send_hour: 0, recruit_enabled: 0, remind_undecided_enabled: 0, remind_start_days: 7 };
  const n: any = await (await call('POST', '/notifications', body)).json();
  await postedOccurrence(n, 3);
  const ids = Array.from({ length: 45 }, (_, i) => String(7000 + i));
  await db.batch(
    ids.flatMap((id) => [
      db.prepare('INSERT INTO members(user_id,user_name,display_name) VALUES(?,?,?)').bind(id, id, id),
      db.prepare("INSERT INTO segment_members(segment_id,user_id,status) VALUES(?,?,'')").bind(n.segment_id, id),
    ]),
  );
  const dms: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const b = JSON.parse(String(init?.body ?? '{}'));
    if (String(url).endsWith('/users/@me/channels')) return Response.json({ id: `dm-${b.recipient_id}` });
    dms.push(String(url));
    return Response.json({ id: 'message' });
  }));
  for (let tick = 0; tick < 6; tick++) {
    const used = { n: 0 };
    await runTick({ ...E, DB: countingD1(db, used) });
    expect(-used.n).toBeLessThanOrEqual(50);
    const stuck = await db.prepare("SELECT COUNT(*) AS c FROM send_log WHERE status='sending'").first<{ c: number }>();
    expect(stuck!.c).toBe(0);
  }
  expect(dms).toHaveLength(45);
  expect(new Set(dms).size).toBe(45);
}, 60_000); // 送信の間隔 300ms × 45 通

it('メンバー一覧の取得に失敗しても、同じ実行の中で開催回ごとに取り直さない', async () => {
  const s = await createSegment(db, { guild_id: '1001', name: 'ロール区分', mention_role_id: '9001' });
  const body = { guild_id: '1001', segment_uuid: s.uuid, name: '週例', channel_id: '2001', message_title: '募集', rrule: null, start_time: '23:59', send_hour: 0, recruit_enabled: 0, remind_undecided_enabled: 0, remind_start_days: 7 };
  const n: any = await (await call('POST', '/notifications', body)).json();
  for (const d of [1, 2, 3, 4]) await postedOccurrence(n, d);
  const urls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
    urls.push(String(url));
    if (String(url).includes('/members')) return new Response('Missing Access', { status: 403 });
    return Response.json([]);
  }));
  const live = { ...E, MOCK_DISCORD: '' } as Env; // メンバー取得を実際の fetch（403）に通す
  await runTick(live);
  expect(urls.filter((u) => u.includes('/members'))).toHaveLength(1);
  await runTick(live); // 次の実行では取り直す（マーカーは立てていない）
  expect(urls.filter((u) => u.includes('/members'))).toHaveLength(2);
});

it('ロールで管理する区分が無いサーバーではメンバー一覧を取りに行かない', async () => {
  const s = await createSegment(db, { guild_id: '1001', name: '手動区分', mention_role_id: null });
  const body = { guild_id: '1001', segment_uuid: s.uuid, name: '手動', channel_id: '2001', message_title: '募集', rrule: null, start_time: '23:59', send_hour: 0, recruit_enabled: 0, remind_undecided_enabled: 0, remind_start_days: 7 };
  const n: any = await (await call('POST', '/notifications', body)).json();
  await postedOccurrence(n, 2);
  const urls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
    urls.push(String(url));
    return Response.json([]);
  }));
  await runTick({ ...E, MOCK_DISCORD: '' } as Env);
  expect(urls.filter((u) => u.includes('/members'))).toHaveLength(0);
});

it('cron は 1 本で、偶数分は日程調整・奇数分は出欠確認', () => {
  const t = Date.UTC(2026, 9, 3, 12, 0);
  expect(isPlanningMinute(t)).toBe(true);
  expect(isPlanningMinute(t + 60_000)).toBe(false);
  expect(isPlanningMinute(t + 120_000 + 59_999)).toBe(true);
});

// --- 再レビュー A2-02: 予算が毎回同じ場所で尽きても、何度か実行すれば全員・全件に届く ---

/** runTick を何回か実行する。ティック番号（2 分刻み）で巡回の開始位置が変わるため、Date だけを偽装して 2 分ずつ進める */
async function runTicks(times: number, e: Env) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.UTC(2026, 9, 3, 3, 1)); // JST 12:01（日付をまたがない）
  try {
    for (let i = 0; i < times; i++) {
      const used = { n: 0 };
      await runTick({ ...e, DB: countingD1(db, used) });
      expect(-used.n).toBeLessThan(50);
      vi.setSystemTime(Date.now() + 120_000);
    }
  } finally {
    vi.useRealTimers();
  }
}

it('ノルマの対象が 45 人でも、今日送った人を数え直さずに全員へ届く', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.UTC(2026, 9, 3, 3, 1));
  const s = await createSegment(db, { guild_id: '1001', name: 'ノルマ区分', mention_role_id: null });
  const body = { guild_id: '1001', segment_uuid: s.uuid, name: '定例', channel_id: '2001', message_title: '募集', rrule: null, start_time: '23:59', send_hour: 0, recruit_enabled: 0, remind_unanswered_enabled: 0, remind_undecided_enabled: 0, quota_enabled: 1, quota_interval_days: 7 };
  const n: any = await (await call('POST', '/notifications', body)).json();
  const past = await getOrCreateOccurrence(db, n.id, inDays(-10), '23:59', 'manual');
  await postedOccurrence(n, 3); // 今日募集を投稿した＝今日ノルマを送る日
  vi.useRealTimers();
  const ids = Array.from({ length: 45 }, (_, i) => String(8000 + i));
  await db.batch(
    ids.flatMap((id) => [
      db.prepare('INSERT INTO members(user_id,user_name,display_name) VALUES(?,?,?)').bind(id, id, id),
      db.prepare("INSERT INTO segment_members(segment_id,user_id,status) VALUES(?,?,'')").bind(n.segment_id, id),
      db.prepare("INSERT INTO responses(occurrence_id,user_id,user_name,status,updated_at) VALUES(?,?,?,'参加','')").bind(past.id, id, id),
    ]),
  );
  const dms: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const b = JSON.parse(String(init?.body ?? '{}'));
    if (String(url).endsWith('/users/@me/channels')) return Response.json({ id: `dm-${b.recipient_id}` });
    dms.push(String(url));
    return Response.json({ id: 'message' });
  }));
  await runTicks(12, E);
  expect(new Set(dms).size).toBe(45);
  expect(dms).toHaveLength(45);
}, 60_000);

it('募集済みの開催回が 35 件あっても、36 件目の募集がいずれ投稿される', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.UTC(2026, 9, 3, 3, 1));
  const s = await createSegment(db, { guild_id: '1001', name: '多回', mention_role_id: null });
  const body = { guild_id: '1001', segment_uuid: s.uuid, name: '連日', channel_id: '2001', message_title: '募集', rrule: null, start_time: '23:59', send_hour: 0, recruit_enabled: 1, recruit_days_before: 40, remind_start_days: 39, remind_undecided_enabled: 0 };
  const res = await call('POST', '/notifications', body);
  expect(res.status).toBeLessThan(300);
  const n: any = await res.json();
  for (let d = 1; d <= 35; d++) await postedOccurrence(n, d); // 未回答リマインドの照会が開催回ごとに D1 を使う
  const last = await getOrCreateOccurrence(db, n.id, inDays(36), '23:59', 'manual');
  vi.useRealTimers();
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ id: 'message' })));
  const recruited = () =>
    db.prepare("SELECT status FROM send_log WHERE occurrence_id = ? AND kind = 'recruit'").bind(last.id).first<{ status: string }>();
  await runTicks(40, E);
  expect((await recruited())?.status).toBe('sent');
}, 60_000);

// --- 再レビュー A2-03: ロール同期の差分は batch で書き、人数に比例して D1 を使わない ---

it.each([16, 120])('所属 0 人のロール区分へ %i 人を同期しても 1 実行の D1 は 50 未満（休止中は維持）', async (count) => {
  const s = await createSegment(db, { guild_id: '1001', name: 'ロール同期', mention_role_id: '9001' });
  const body = { guild_id: '1001', segment_uuid: s.uuid, name: '同期', channel_id: '2001', message_title: '募集', rrule: null, start_time: '23:59', send_hour: 0, recruit_enabled: 0, remind_unanswered_enabled: 0, remind_undecided_enabled: 0 };
  const n: any = await (await call('POST', '/notifications', body)).json();
  await postedOccurrence(n, 2);
  // 既存: ロールを持つ休止中の人（維持される）と、ロールを外れた人（除外される）
  await db.batch([
    db.prepare("INSERT INTO members(user_id,user_name) VALUES('9100','paused'),('9101','gone')"),
    db.prepare("INSERT INTO segment_members(segment_id,user_id,status) VALUES(?,'9100','休止中'),(?,'9101','')").bind(n.segment_id, n.segment_id),
  ]);
  const roleMembers = [
    ...Array.from({ length: count }, (_, i) => ({ user: { id: String(9200 + i), username: `u${i}` }, nick: null, roles: ['9001'] })),
    { user: { id: '9100', username: 'paused' }, nick: null, roles: ['9001'] },
  ];
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
    if (String(url).includes('/members')) return Response.json(roleMembers);
    return Response.json([]);
  }));
  const used = { n: 0 };
  await runTick({ ...E, MOCK_DISCORD: '', DB: countingD1(db, used) } as Env);
  expect(-used.n).toBeLessThan(50);
  const rows = (await db.prepare('SELECT user_id, status FROM segment_members WHERE segment_id = ?').bind(n.segment_id).all<{ user_id: string; status: string }>()).results;
  expect(rows).toHaveLength(count + 1);
  expect(rows.find((r) => r.user_id === '9100')?.status).toBe('休止中');
  expect(rows.some((r) => r.user_id === '9101')).toBe(false);
});
