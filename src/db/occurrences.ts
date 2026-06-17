import type { Occurrence, OccurrenceStatus } from './types';

const COLS = 'id, notification_id, occurrence_date, status, created_at';

/**
 * Occurrence を取得 or 生成。UNIQUE(notification_id, occurrence_date) で upsert。
 * 既存なら（cancelled でも）その行を返す。
 */
export async function getOrCreateOccurrence(
  db: D1Database,
  notificationId: number,
  dateStr: string,
): Promise<Occurrence> {
  const existing = await db
    .prepare(`SELECT ${COLS} FROM occurrences WHERE notification_id = ? AND occurrence_date = ?`)
    .bind(notificationId, dateStr)
    .first<Occurrence>();
  if (existing) return existing;

  const res = await db
    .prepare('INSERT INTO occurrences (notification_id, occurrence_date) VALUES (?, ?)')
    .bind(notificationId, dateStr)
    .run();
  const id = res.meta.last_row_id as number;
  const row = await db
    .prepare(`SELECT ${COLS} FROM occurrences WHERE id = ?`)
    .bind(id)
    .first<Occurrence>();
  return (
    row ?? {
      id,
      notification_id: notificationId,
      occurrence_date: dateStr,
      status: 'scheduled',
      created_at: '',
    }
  );
}

/** 単一 Occurrence 取得（未登録なら null） */
export async function getOccurrence(db: D1Database, id: number): Promise<Occurrence | null> {
  const row = await db
    .prepare(`SELECT ${COLS} FROM occurrences WHERE id = ?`)
    .bind(id)
    .first<Occurrence>();
  return row ?? null;
}

/** Notification の最新の予定回（occurrence_date 最大・status='scheduled'）。無ければ null */
export async function getLatestScheduledOccurrence(
  db: D1Database,
  notificationId: number,
): Promise<Occurrence | null> {
  const row = await db
    .prepare(
      `SELECT ${COLS} FROM occurrences
        WHERE notification_id = ? AND status = 'scheduled'
        ORDER BY occurrence_date DESC LIMIT 1`,
    )
    .bind(notificationId)
    .first<Occurrence>();
  return row ?? null;
}

/** 開催回ステータス更新（'scheduled' / 'cancelled'）。対象が無ければ false */
export async function setOccurrenceStatus(
  db: D1Database,
  id: number,
  status: OccurrenceStatus,
): Promise<boolean> {
  const res = await db
    .prepare('UPDATE occurrences SET status = ? WHERE id = ?')
    .bind(status, id)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/** 開催日を更新（リスケ）。対象が無ければ false */
export async function updateOccurrenceDate(
  db: D1Database,
  id: number,
  dateStr: string,
): Promise<boolean> {
  const res = await db
    .prepare('UPDATE occurrences SET occurrence_date = ? WHERE id = ?')
    .bind(dateStr, id)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/** Notification の開催回一覧（新しい順） */
export async function listOccurrencesForNotification(
  db: D1Database,
  notificationId: number,
  limit = 100,
): Promise<Occurrence[]> {
  const { results } = await db
    .prepare(
      `SELECT ${COLS} FROM occurrences
        WHERE notification_id = ?
        ORDER BY occurrence_date DESC LIMIT ?`,
    )
    .bind(notificationId, limit)
    .all<Occurrence>();
  return results;
}

/**
 * Notification の予定回（status='scheduled'）を日付昇順で返す。
 * 単発・複数候補日の「候補日の母集合」として募集・集計に使う。
 */
export async function listScheduledOccurrences(
  db: D1Database,
  notificationId: number,
): Promise<Occurrence[]> {
  const { results } = await db
    .prepare(
      `SELECT ${COLS} FROM occurrences
        WHERE notification_id = ? AND status = 'scheduled'
        ORDER BY occurrence_date ASC`,
    )
    .bind(notificationId)
    .all<Occurrence>();
  return results;
}

/**
 * 候補日集合に occurrences を揃える（単発の複数候補日用）。
 * - dates に在って未登録 → 作成。cancelled だった回は scheduled に復活。
 * - dates に無いのに scheduled な回 → cancelled にする（既存回答を失わないよう DELETE しない）。
 * recurring は遅延生成のため呼ばない（呼び出し側 admin が type='oneoff' に限定する）。
 * 返り値: 同期後の scheduled な occurrences（日付昇順）。
 */
export async function syncCandidateOccurrences(
  db: D1Database,
  notificationId: number,
  dates: string[],
): Promise<Occurrence[]> {
  const wanted = new Set(dates);
  const { results: existing } = await db
    .prepare(`SELECT ${COLS} FROM occurrences WHERE notification_id = ?`)
    .bind(notificationId)
    .all<Occurrence>();
  const byDate = new Map(existing.map((o) => [o.occurrence_date, o]));

  // 1. 欲しい候補日を確保（未登録は作成 / cancelled は復活）
  for (const d of wanted) {
    const cur = byDate.get(d);
    if (!cur) await getOrCreateOccurrence(db, notificationId, d);
    else if (cur.status === 'cancelled') await setOccurrenceStatus(db, cur.id, 'scheduled');
  }
  // 2. 候補から外れた scheduled 回は cancelled に
  for (const o of existing) {
    if (o.status === 'scheduled' && !wanted.has(o.occurrence_date)) {
      await setOccurrenceStatus(db, o.id, 'cancelled');
    }
  }
  return listScheduledOccurrences(db, notificationId);
}
