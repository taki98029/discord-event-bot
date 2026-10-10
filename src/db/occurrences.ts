import { OCCURRENCE_FLOW_KEYS, type Occurrence, type OccurrenceFlow, type OccurrenceOrigin, type OccurrenceStatus } from './types';
import { newUuid } from './uuid';

const COLS =
  'id, uuid, notification_id, occurrence_date, start_time, status, origin, note, response_deadline_hours, duration_minutes, ' +
  OCCURRENCE_FLOW_KEYS.join(', ') +
  ', created_at';

/**
 * Occurrence を取得 or 生成。UNIQUE(notification_id, occurrence_date, start_time) で upsert。
 * スロットの同一性は (notification_id, occurrence_date, start_time) で判定する。
 * 既存なら（cancelled でも・origin が違っても）その行を返す。
 * origin: 'rule'=RRULE から実体化（ロールフォワード・仮想行の実体化）／'manual'=運用者の追加（臨時回・不定期）。
 */
export async function getOrCreateOccurrence(
  db: D1Database,
  notificationId: number,
  dateStr: string,
  startTime: string,
  origin: OccurrenceOrigin = 'manual',
): Promise<Occurrence> {
  const existing = await db
    .prepare(
      `SELECT ${COLS} FROM occurrences
        WHERE notification_id = ? AND occurrence_date = ? AND start_time = ?`,
    )
    .bind(notificationId, dateStr, startTime)
    .first<Occurrence>();
  if (existing) return existing;

  const uuid = newUuid();
  const res = await db
    .prepare(
      'INSERT INTO occurrences (uuid, notification_id, occurrence_date, start_time, origin) VALUES (?, ?, ?, ?, ?)',
    )
    .bind(uuid, notificationId, dateStr, startTime, origin)
    .run();
  const id = res.meta.last_row_id as number;
  const row = await db
    .prepare(`SELECT ${COLS} FROM occurrences WHERE id = ?`)
    .bind(id)
    .first<Occurrence>();
  return (
    row ?? {
      id,
      uuid,
      notification_id: notificationId,
      occurrence_date: dateStr,
      start_time: startTime,
      status: 'scheduled',
      origin,
      note: null,
      response_deadline_hours: null,
      duration_minutes: null,
      send_hour: null,
      recruit_enabled: null,
      recruit_days_before: null,
      remind_unanswered_enabled: null,
      remind_start_days: null,
      remind_undecided_enabled: null,
      remind_undecided_days: null,
      remind_target: null,
      remind_undecided_target: null,
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

/** UUID で Occurrence を取得（未登録なら null・ADR 0016） */
export async function getOccurrenceByUuid(
  db: D1Database,
  uuid: string,
): Promise<Occurrence | null> {
  const row = await db
    .prepare(`SELECT ${COLS} FROM occurrences WHERE uuid = ?`)
    .bind(uuid)
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
        ORDER BY occurrence_date DESC, start_time DESC LIMIT 1`,
    )
    .bind(notificationId)
    .first<Occurrence>();
  return row ?? null;
}

/**
 * 中止した開催回を同じ日時で登録し直すとき、新しく作った回と同じ状態に戻す（ADR 0032「中止→登録し直し」・
 * 2026-10-03 リリース前レビュー R-04）。同じ日時の行は UNIQUE で 1 つなので行は使い回し、中身を消す:
 * 回答・送信の記録（募集を投稿し直すため）・メンバー配置・開催回ごとの締切／補足／開催時間／投稿の流れ。
 * 回答の変更履歴（response_log）は残す。状態（scheduled）は呼び出し側が書く。
 */
export async function resetCancelledOccurrence(db: D1Database, id: number): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM responses WHERE occurrence_id = ?').bind(id),
    db.prepare('DELETE FROM send_log WHERE occurrence_id = ?').bind(id),
    db.prepare('DELETE FROM group_members WHERE group_id IN (SELECT g.id FROM groups g JOIN groupings gp ON gp.id = g.grouping_id WHERE gp.occurrence_id = ?)').bind(id),
    db.prepare('DELETE FROM groups WHERE grouping_id IN (SELECT id FROM groupings WHERE occurrence_id = ?)').bind(id),
    db.prepare('DELETE FROM groupings WHERE occurrence_id = ?').bind(id),
    db
      .prepare(
        `UPDATE occurrences SET note = NULL, response_deadline_hours = NULL, duration_minutes = NULL, ${OCCURRENCE_FLOW_KEYS.map((k) => `${k} = NULL`).join(', ')} WHERE id = ?`,
      )
      .bind(id),
  ]);
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

/**
 * 今日以降の開催回を全通知ぶん一括取得する（両ステータス・日付昇順）。
 * 毎分 cron の対象決定用: 通知ごとの個別クエリを避け、1 ティック 1 クエリに抑える。
 */
export async function listFutureOccurrencesAll(
  db: D1Database,
  todayStr: string,
): Promise<Occurrence[]> {
  const { results } = await db
    .prepare(
      `SELECT ${COLS} FROM occurrences
        WHERE occurrence_date >= ?
        ORDER BY occurrence_date ASC, start_time ASC`,
    )
    .bind(todayStr)
    .all<Occurrence>();
  return results;
}

/** 補足メッセージを更新（NULL=なし）。対象が無ければ false */
export async function setOccurrenceNote(
  db: D1Database,
  id: number,
  note: string | null,
): Promise<boolean> {
  const res = await db
    .prepare('UPDATE occurrences SET note = ? WHERE id = ?')
    .bind(note, id)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/** 開催回の回答締切（開始の N 時間前・NULL=雛形に従う）を設定する（ADR 0032）。対象が無ければ false */
export async function setOccurrenceDeadline(db: D1Database, id: number, hours: number | null): Promise<boolean> {
  const res = await db
    .prepare('UPDATE occurrences SET response_deadline_hours = ? WHERE id = ?')
    .bind(hours, id)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/** 開催回の開催時間（分）を更新。null=雛形に従う。対象が無ければ false */
export async function setOccurrenceDuration(db: D1Database, id: number, minutes: number | null): Promise<boolean> {
  const res = await db.prepare('UPDATE occurrences SET duration_minutes = ? WHERE id = ?').bind(minutes, id).run();
  return (res.meta.changes ?? 0) > 0;
}

/** 開催回の送信時刻と投稿の流れを更新（単発・migration 0036）。対象が無ければ false */
export async function setOccurrenceFlow(db: D1Database, id: number, flow: OccurrenceFlow): Promise<boolean> {
  const res = await db
    .prepare(`UPDATE occurrences SET ${OCCURRENCE_FLOW_KEYS.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
    .bind(...OCCURRENCE_FLOW_KEYS.map((k) => flow[k]), id)
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
      `SELECT ${COLS}, (SELECT plan_id FROM planning_occurrences WHERE occurrence_id=occurrences.id) AS planning_id FROM occurrences
        WHERE notification_id = ?
        ORDER BY occurrence_date DESC, start_time DESC LIMIT ?`,
    )
    .bind(notificationId, limit)
    .all<Occurrence>();
  return results;
}

/**
 * ルール（rrule / anchor_date / start_time）変更時の掃除（docs/dev/schedule-recurrence-redesign.md §5.3）。
 * 今日以降の **origin='rule' かつ scheduled かつ「何も起きていない」行**（send_log に sending/sent なし・
 * 回答なし・メンバー配置なし）だけを DELETE する。投稿済み・回答あり・配置ありの rule 行、manual 行、
 * cancelled（墓石）、過去の行は保持。削除後に次ティックのロールフォワードが新ルールで再実体化する。
 * @returns pruned=削除件数 / kept_posted=保持した今日以降の scheduled な rule 行の件数（投稿済み等・UI 案内用）
 */
export async function pruneRuleOccurrences(
  db: D1Database,
  notificationId: number,
  todayStr: string,
): Promise<{ pruned: number; kept_posted: number }> {
  const res = await db
    .prepare(
      `DELETE FROM occurrences
        WHERE notification_id = ? AND origin = 'rule' AND status = 'scheduled' AND occurrence_date >= ?
          AND NOT EXISTS (SELECT 1 FROM send_log s WHERE s.occurrence_id = occurrences.id AND s.status IN ('sending', 'sent'))
          AND NOT EXISTS (SELECT 1 FROM responses r WHERE r.occurrence_id = occurrences.id)
          AND NOT EXISTS (SELECT 1 FROM groupings g WHERE g.occurrence_id = occurrences.id)`,
    )
    .bind(notificationId, todayStr)
    .run();
  const kept = await db
    .prepare(
      `SELECT COUNT(*) AS c FROM occurrences
        WHERE notification_id = ? AND origin = 'rule' AND status = 'scheduled' AND occurrence_date >= ?`,
    )
    .bind(notificationId, todayStr)
    .first<{ c: number }>();
  return { pruned: (res.meta.changes as number) ?? 0, kept_posted: kept?.c ?? 0 };
}
