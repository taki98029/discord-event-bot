import type { Notification, NotificationType } from './types';
import { listOccurrencesForNotification, setOccurrenceStatus } from './occurrences';

const COLS =
  'id, guild_id, segment_id, name, channel_id, type, rrule, one_off_date, anchor_date, start_time, ' +
  'recruit_days_before, remind_start_days, remind_undecided_days, ' +
  'quota_enabled, quota_interval_days, assignment_enabled, mention_enabled, active, ' +
  'decided_occurrence_id, created_at';

/** Notification 作成/更新の入力（数値フラグは 0/1） */
export interface NotificationInput {
  guild_id: string;
  segment_id: number;
  name: string;
  channel_id: string;
  type: NotificationType;
  rrule: string | null;
  one_off_date: string | null;
  anchor_date: string | null;
  start_time: string;
  recruit_days_before: number;
  remind_start_days: number;
  remind_undecided_days: number;
  quota_enabled: number;
  quota_interval_days: number | null;
  assignment_enabled: number;
  mention_enabled: number;
  active: number;
}

/** 全 Notification 取得（作成順） */
export async function listNotifications(db: D1Database): Promise<Notification[]> {
  const { results } = await db
    .prepare(`SELECT ${COLS} FROM notifications ORDER BY created_at`)
    .all<Notification>();
  return results;
}

/** active=1 の Notification 取得（cron 用） */
export async function listActiveNotifications(db: D1Database): Promise<Notification[]> {
  const { results } = await db
    .prepare(`SELECT ${COLS} FROM notifications WHERE active = 1 ORDER BY created_at`)
    .all<Notification>();
  return results;
}

/** 単一 Notification 取得（未登録なら null） */
export async function getNotification(
  db: D1Database,
  id: number,
): Promise<Notification | null> {
  const row = await db
    .prepare(`SELECT ${COLS} FROM notifications WHERE id = ?`)
    .bind(id)
    .first<Notification>();
  return row ?? null;
}

/** チャンネルに紐づく active な Notification 一覧 */
export async function listNotificationsByChannel(
  db: D1Database,
  channelId: string,
): Promise<Notification[]> {
  const { results } = await db
    .prepare(`SELECT ${COLS} FROM notifications WHERE channel_id = ? AND active = 1 ORDER BY created_at`)
    .bind(channelId)
    .all<Notification>();
  return results;
}

/** Server(guild_id) 配下の Notification 一覧 */
export async function listNotificationsByGuild(
  db: D1Database,
  guildId: string,
): Promise<Notification[]> {
  const { results } = await db
    .prepare(`SELECT ${COLS} FROM notifications WHERE guild_id = ? ORDER BY created_at`)
    .bind(guildId)
    .all<Notification>();
  return results;
}

/** Notification 作成。採番後の行を返す */
export async function createNotification(
  db: D1Database,
  input: NotificationInput,
): Promise<Notification> {
  const res = await db
    .prepare(
      `INSERT INTO notifications (
         guild_id, segment_id, name, channel_id, type, rrule, one_off_date, anchor_date, start_time,
         recruit_days_before, remind_start_days, remind_undecided_days,
         quota_enabled, quota_interval_days, assignment_enabled, mention_enabled, active
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.guild_id,
      input.segment_id,
      input.name,
      input.channel_id,
      input.type,
      input.rrule ?? null,
      input.one_off_date ?? null,
      input.anchor_date ?? null,
      input.start_time,
      input.recruit_days_before,
      input.remind_start_days,
      input.remind_undecided_days,
      input.quota_enabled,
      input.quota_interval_days ?? null,
      input.assignment_enabled,
      input.mention_enabled,
      input.active,
    )
    .run();
  const id = res.meta.last_row_id as number;
  const row = await getNotification(db, id);
  return row ?? { id, created_at: '', decided_occurrence_id: null, ...input };
}

/** Notification 更新。対象が無ければ false */
export async function updateNotification(
  db: D1Database,
  id: number,
  patch: NotificationInput,
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE notifications SET
         guild_id = ?, segment_id = ?, name = ?, channel_id = ?, type = ?, rrule = ?,
         one_off_date = ?, anchor_date = ?, start_time = ?, recruit_days_before = ?, remind_start_days = ?,
         remind_undecided_days = ?, quota_enabled = ?, quota_interval_days = ?,
         assignment_enabled = ?, mention_enabled = ?, active = ?
       WHERE id = ?`,
    )
    .bind(
      patch.guild_id,
      patch.segment_id,
      patch.name,
      patch.channel_id,
      patch.type,
      patch.rrule ?? null,
      patch.one_off_date ?? null,
      patch.anchor_date ?? null,
      patch.start_time,
      patch.recruit_days_before,
      patch.remind_start_days,
      patch.remind_undecided_days,
      patch.quota_enabled,
      patch.quota_interval_days ?? null,
      patch.assignment_enabled,
      patch.mention_enabled,
      patch.active,
      id,
    )
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/**
 * 単発・複数候補日の確定回を設定/解除する（occurrences.id または NULL）。
 * 候補回の cancel/復活は呼び出し側（admin）で行う。対象通知が無ければ false。
 */
export async function setDecidedOccurrence(
  db: D1Database,
  notificationId: number,
  occurrenceId: number | null,
): Promise<boolean> {
  const res = await db
    .prepare('UPDATE notifications SET decided_occurrence_id = ? WHERE id = ?')
    .bind(occurrenceId, notificationId)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/**
 * 複数候補日の最終確定。指定回を scheduled に保ち、他の候補回（scheduled）を cancelled にして
 * decided_occurrence_id を設定する。回答は保全（occurrences/responses は消さない）。
 */
export async function decideOccurrence(
  db: D1Database,
  notificationId: number,
  occurrenceId: number,
): Promise<void> {
  await setOccurrenceStatus(db, occurrenceId, 'scheduled');
  const all = await listOccurrencesForNotification(db, notificationId, 1000);
  for (const o of all) {
    if (o.id !== occurrenceId && o.status === 'scheduled') {
      await setOccurrenceStatus(db, o.id, 'cancelled');
    }
  }
  await setDecidedOccurrence(db, notificationId, occurrenceId);
}

/** 確定解除。decided_occurrence_id を NULL に戻し、cancelled な候補回を scheduled に復活する。 */
export async function undecideNotification(
  db: D1Database,
  notificationId: number,
): Promise<void> {
  await setDecidedOccurrence(db, notificationId, null);
  const all = await listOccurrencesForNotification(db, notificationId, 1000);
  for (const o of all) {
    if (o.status === 'cancelled') await setOccurrenceStatus(db, o.id, 'scheduled');
  }
}

/**
 * Notification 削除。配下 occurrences と、その responses / assignments も削除する。
 * 削除した場合 true。
 */
export async function deleteNotification(db: D1Database, id: number): Promise<boolean> {
  await db
    .prepare(
      `DELETE FROM responses WHERE occurrence_id IN (
         SELECT id FROM occurrences WHERE notification_id = ?
       )`,
    )
    .bind(id)
    .run();
  await db
    .prepare(
      `DELETE FROM assignments WHERE occurrence_id IN (
         SELECT id FROM occurrences WHERE notification_id = ?
       )`,
    )
    .bind(id)
    .run();
  await db.prepare('DELETE FROM occurrences WHERE notification_id = ?').bind(id).run();

  const res = await db.prepare('DELETE FROM notifications WHERE id = ?').bind(id).run();
  return (res.meta.changes ?? 0) > 0;
}
