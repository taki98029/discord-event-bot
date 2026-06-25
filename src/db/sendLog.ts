import type { SendLogKind, SendLogListItem } from './types';

/**
 * send_log: cron 駆動送信の記録（ADR 0013）。冪等台帳・ペースカーソル・可視化を兼ねる。
 * 毎分 cron のペース配信は「claim → 送信 → finish」で進める。UNIQUE(notification_id,
 * occurrence_id, user_id, kind, send_date) により毎分実行でも二重送信を防ぐ。
 * occurrence_id 既定 0＝開催回に紐づかない（ノルマ等）/ user_id 既定 ''＝チャンネル投稿。
 */
export interface SendKey {
  notification_id: number;
  occurrence_id?: number;
  user_id?: string;
  kind: SendLogKind;
  send_date: string;
}

/**
 * 送信を claim する。INSERT OR IGNORE で status='sending' 行を立て、新規に立てられたら true
 * （＝この送信は自分が担当する）。既に行があれば false（他ティックが claim 済み／送信済み）。
 * 予算を消費する前に呼び、true のときだけ実際に送信する。
 */
export async function claimSend(db: D1Database, k: SendKey): Promise<boolean> {
  const res = await db
    .prepare(
      `INSERT OR IGNORE INTO send_log
         (notification_id, occurrence_id, user_id, kind, send_date, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'sending', ?)`,
    )
    .bind(
      k.notification_id,
      k.occurrence_id ?? 0,
      k.user_id ?? '',
      k.kind,
      k.send_date,
      new Date().toISOString(),
    )
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/** claim 済み送信の結果を確定する（sent / failed）。 */
export async function finishSend(
  db: D1Database,
  k: SendKey,
  ok: boolean,
  error: string | null = null,
): Promise<void> {
  await db
    .prepare(
      `UPDATE send_log SET status = ?, error = ?
         WHERE notification_id = ? AND occurrence_id = ? AND user_id = ? AND kind = ? AND send_date = ?`,
    )
    .bind(
      ok ? 'sent' : 'failed',
      ok ? null : error,
      k.notification_id,
      k.occurrence_id ?? 0,
      k.user_id ?? '',
      k.kind,
      k.send_date,
    )
    .run();
}

/**
 * クラッシュ等で status='sending' のまま残った claim を回収する（ADR 0013）。
 * 指定時刻より前の 'sending' 行を削除し、次ティックで再送できるようにする（毎ティック先頭で呼ぶ）。
 */
export async function clearStaleClaims(db: D1Database, olderThanIso: string): Promise<void> {
  await db
    .prepare("DELETE FROM send_log WHERE status = 'sending' AND created_at < ?")
    .bind(olderThanIso)
    .run();
}

/** 指定キーが既に存在するか（claim 済み／送信済み）。テスト・推定用の読み取りヘルパ。 */
export async function isSendLogged(db: D1Database, k: SendKey): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 FROM send_log
        WHERE notification_id = ? AND occurrence_id = ? AND user_id = ? AND kind = ? AND send_date = ?`,
    )
    .bind(k.notification_id, k.occurrence_id ?? 0, k.user_id ?? '', k.kind, k.send_date)
    .first();
  return row != null;
}

/** 管理 UI: リマインド送信履歴を取得（新しい順）。notifications / occurrences を JOIN。 */
export async function listSendLog(
  db: D1Database,
  opts: { limit?: number; notificationId?: number } = {},
): Promise<SendLogListItem[]> {
  const limit = opts.limit ?? 300;
  const where = opts.notificationId ? 'WHERE s.notification_id = ?' : '';
  const stmt = db.prepare(
    `SELECT s.id, s.notification_id, s.occurrence_id, s.user_id, s.kind, s.send_date,
            s.status, s.error, s.created_at,
            n.name AS notification_name,
            (SELECT o.occurrence_date FROM occurrences o WHERE o.id = s.occurrence_id AND s.occurrence_id != 0) AS occurrence_date
       FROM send_log s
       JOIN notifications n ON n.id = s.notification_id
       ${where}
      ORDER BY s.created_at DESC
      LIMIT ?`,
  );
  const bound = opts.notificationId ? stmt.bind(opts.notificationId, limit) : stmt.bind(limit);
  const { results } = await bound.all<SendLogListItem>();
  return results;
}
