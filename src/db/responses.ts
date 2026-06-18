import type { EventStatusBuckets, Member, Notification, QuotaAlert, Response } from './types';
import { resolveDisplayName } from './types';
import { getActiveSegmentMembers } from './segments';
import { getJSTNow } from '../lib/date';

/**
 * 回答の upsert（旧 upsertEventLog）。
 * 複合主キー (occurrence_id, user_id) を使い ON CONFLICT で 1 クエリに集約。
 */
export async function upsertResponse(
  db: D1Database,
  occurrenceId: number,
  userId: string,
  userName: string | null,
  status: string,
): Promise<void> {
  const ts = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO responses (occurrence_id, user_id, user_name, status, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(occurrence_id, user_id) DO UPDATE SET
         status = excluded.status,
         user_name = excluded.user_name,
         updated_at = excluded.updated_at`,
    )
    .bind(occurrenceId, userId, userName ?? null, status, ts)
    .run();
}

/** 開催回の回答を userId → 行 で取得（旧 getEventLogsForDate） */
export async function getResponsesForOccurrence(
  db: D1Database,
  occurrenceId: number,
): Promise<Record<string, { status: string }>> {
  const { results } = await db
    .prepare('SELECT user_id, status FROM responses WHERE occurrence_id = ?')
    .bind(occurrenceId)
    .all<{ user_id: string; status: string }>();
  const map: Record<string, { status: string }> = {};
  for (const r of results) map[r.user_id] = { status: r.status };
  return map;
}

/** 開催回の未定者を取得（旧 getUndecided） */
export async function getUndecidedForOccurrence(
  db: D1Database,
  occurrenceId: number,
): Promise<{ userId: string; name: string | null }[]> {
  const { results } = await db
    .prepare("SELECT user_id, user_name FROM responses WHERE occurrence_id = ? AND status = '未定'")
    .bind(occurrenceId)
    .all<{ user_id: string; user_name: string | null }>();
  return results.map((r) => ({ userId: r.user_id, name: r.user_name }));
}

/**
 * 開催回の出欠状況を集計（旧 getEventStatus）。
 * 母集団はその区分のアクティブメンバー（getActiveSegmentMembers）。回答なし=未回答。
 */
export async function getStatusBuckets(
  db: D1Database,
  occurrenceId: number,
  segmentId: number,
  /** 同一区分で複数回呼ぶ際に区分メンバーの再取得を避けるための事前取得結果（任意）。 */
  preloadedMembers?: Member[],
): Promise<EventStatusBuckets> {
  const members = preloadedMembers ?? (await getActiveSegmentMembers(db, segmentId));
  const responses = await getResponsesForOccurrence(db, occurrenceId);

  const result: EventStatusBuckets = { 参加: [], 不参加: [], 未定: [], 未回答: [] };

  for (const m of members) {
    const name = resolveDisplayName(m);
    const st = responses[m.user_id]?.status ?? '未回答';
    if (st === '参加' || st === '不参加' || st === '未定') {
      result[st].push(name);
    } else {
      result['未回答'].push(name);
    }
  }
  return result;
}

/**
 * ノルマ確認（旧 checkQuota）。n.quota_enabled かつ interval 設定時のみ対象。
 * 対象=Notification の Segment のアクティブメンバー。
 * 各人の「この Notification の occurrences における status='参加' の最大 occurrence_date」を求め、
 * interval を超過した者を返す。未参加者は除外（旧仕様）。
 */
export async function checkQuotaForNotification(
  db: D1Database,
  n: Notification,
  now: Date = getJSTNow(),
): Promise<QuotaAlert[]> {
  if (!n.quota_enabled || !n.quota_interval_days) return [];

  const members = await getActiveSegmentMembers(db, n.segment_id);

  // この Notification の occurrences における各人の「参加」最終日
  const { results } = await db
    .prepare(
      `SELECT r.user_id AS user_id, MAX(o.occurrence_date) AS last_date
         FROM responses r
         JOIN occurrences o ON o.id = r.occurrence_id
        WHERE o.notification_id = ? AND r.status = '参加'
        GROUP BY r.user_id`,
    )
    .bind(n.id)
    .all<{ user_id: string; last_date: string }>();
  const lastMap = new Map<string, string>();
  for (const r of results) lastMap.set(r.user_id, r.last_date);

  const today = new Date(now);
  today.setHours(0, 0, 0, 0);

  const alerts: QuotaAlert[] = [];
  for (const m of members) {
    const last = lastMap.get(m.user_id);
    if (!last) continue; // 未参加者は除外（旧仕様）

    const lastDate = new Date(last);
    lastDate.setHours(0, 0, 0, 0);
    const daysSince = Math.floor((today.getTime() - lastDate.getTime()) / 86_400_000);

    if (daysSince > n.quota_interval_days) {
      alerts.push({ ...m, daysSinceLast: daysSince, lastDateStr: last });
    }
  }
  return alerts;
}

/** 管理 UI: 直近の回答を取得（新しい順）。occurrences / notifications を JOIN */
export async function listRecentResponses(
  db: D1Database,
  limit = 200,
): Promise<
  Array<Response & { occurrence_date: string; occurrence_time: string; notification_name: string }>
> {
  const { results } = await db
    .prepare(
      `SELECT r.occurrence_id, r.user_id, r.user_name, r.status, r.updated_at,
              o.occurrence_date AS occurrence_date, o.start_time AS occurrence_time,
              n.name AS notification_name
         FROM responses r
         JOIN occurrences o ON o.id = r.occurrence_id
         JOIN notifications n ON n.id = o.notification_id
        ORDER BY o.occurrence_date DESC, o.start_time DESC, r.updated_at DESC
        LIMIT ?`,
    )
    .bind(limit)
    .all<
      Response & { occurrence_date: string; occurrence_time: string; notification_name: string }
    >();
  return results;
}
