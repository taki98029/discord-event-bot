import type { EventLogRow, EventStatusBuckets, QuotaAlert } from './types';
import { resolveDisplayName } from './types';
import { getAllMembers } from './members';
import { getJSTNow } from '../lib/date';

/**
 * 出欠記録の upsert（旧 upsertEventLog）。
 * 複合主キー (event_date, user_id) を使い ON CONFLICT で 1 クエリに集約。
 */
export async function upsertEventLog(
  db: D1Database,
  date: string,
  userId: string,
  userName: string | null,
  status: string,
): Promise<void> {
  const ts = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO event_log (event_date, user_id, user_name, status, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(event_date, user_id) DO UPDATE SET
         status = excluded.status,
         user_name = excluded.user_name,
         updated_at = excluded.updated_at`,
    )
    .bind(date, userId, userName ?? null, status, ts)
    .run();
}

/** 特定日の出欠ログを userId → 行 で取得（旧 getEventLogsForDate） */
export async function getEventLogsForDate(
  db: D1Database,
  date: string,
): Promise<Record<string, { status: string }>> {
  const { results } = await db
    .prepare('SELECT user_id, status FROM event_log WHERE event_date = ?')
    .bind(date)
    .all<{ user_id: string; status: string }>();
  const map: Record<string, { status: string }> = {};
  for (const r of results) map[r.user_id] = { status: r.status };
  return map;
}

/** 特定日の未定者を取得（旧 getUndecidedUsers） */
export async function getUndecided(
  db: D1Database,
  date: string,
): Promise<{ userId: string; name: string | null }[]> {
  const { results } = await db
    .prepare("SELECT user_id, user_name FROM event_log WHERE event_date = ? AND status = '未定'")
    .bind(date)
    .all<{ user_id: string; user_name: string | null }>();
  return results.map((r) => ({ userId: r.user_id, name: r.user_name }));
}

/**
 * 特定日の出欠状況を集計（旧 getEventStatus）。
 * status が設定されたメンバー（休止中等）は除外。
 */
export async function getEventStatus(
  db: D1Database,
  date: string,
): Promise<EventStatusBuckets> {
  const members = await getAllMembers(db);
  const logs = await getEventLogsForDate(db, date);

  const result: EventStatusBuckets = { 参加: [], 不参加: [], 未定: [], 未回答: [] };

  for (const m of members) {
    if (m.status) continue; // 休止中等は除外
    const name = resolveDisplayName(m);
    const st = logs[m.user_id]?.status ?? '未回答';
    if (st === '参加' || st === '不参加' || st === '未定') {
      result[st].push(name);
    } else {
      result['未回答'].push(name);
    }
  }
  return result;
}

/**
 * ノルマ確認（旧 checkQuotaStatus）。
 * 「参加」最終日から intervalDays を超えて経過したアクティブメンバーを返す。未参加者は対象外。
 */
export async function checkQuota(
  db: D1Database,
  intervalDays: number,
  now: Date = getJSTNow(),
): Promise<QuotaAlert[]> {
  const members = await getAllMembers(db);

  const { results } = await db
    .prepare(
      "SELECT user_id, MAX(event_date) AS last_date FROM event_log WHERE status = '参加' GROUP BY user_id",
    )
    .all<{ user_id: string; last_date: string }>();
  const lastMap = new Map<string, string>();
  for (const r of results) lastMap.set(r.user_id, r.last_date);

  const today = new Date(now);
  today.setHours(0, 0, 0, 0);

  const alerts: QuotaAlert[] = [];
  for (const m of members) {
    if (m.status) continue;
    const last = lastMap.get(m.user_id);
    if (!last) continue; // 未参加者は除外（旧仕様）

    const lastDate = new Date(last);
    lastDate.setHours(0, 0, 0, 0);
    const daysSince = Math.floor((today.getTime() - lastDate.getTime()) / 86_400_000);

    if (daysSince > intervalDays) {
      alerts.push({ ...m, daysSinceLast: daysSince, lastDateStr: last });
    }
  }
  return alerts;
}

/** 管理 UI: 直近の出欠記録を取得（新しい順） */
export async function listRecentEventLogs(
  db: D1Database,
  limit = 200,
): Promise<EventLogRow[]> {
  const { results } = await db
    .prepare(
      'SELECT event_date, user_id, user_name, status, updated_at FROM event_log ORDER BY event_date DESC, updated_at DESC LIMIT ?',
    )
    .bind(limit)
    .all<EventLogRow>();
  return results;
}
