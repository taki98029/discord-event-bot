import type { MentionMode, Notification, NotificationListItem, NotificationType } from './types';
import { listOccurrencesForNotification, setOccurrenceStatus } from './occurrences';
import { newUuid } from './uuid';

const COLS =
  'id, uuid, guild_id, segment_id, name, channel_id, type, rrule, one_off_date, anchor_date, start_time, ' +
  'duration_minutes, recruit_days_before, remind_start_days, remind_undecided_days, ' +
  'quota_enabled, quota_interval_days, assignment_enabled, grouping_enabled, mention_enabled, mention_mode, ' +
  'requires_response, message_title, message_body, active, ' +
  'response_deadline_hours, change_alert_channel_id, send_hour, ' +
  'decided_occurrence_id, created_at';

/** 一覧表示用の集計列（候補数・確定回の日時）。COLS に続けて付与する。 */
const LIST_EXTRA =
  `, (SELECT COUNT(*) FROM occurrences o WHERE o.notification_id = notifications.id AND o.status = 'scheduled') AS candidate_count` +
  `, (SELECT o.occurrence_date FROM occurrences o WHERE o.id = notifications.decided_occurrence_id) AS decided_date` +
  `, (SELECT o.start_time FROM occurrences o WHERE o.id = notifications.decided_occurrence_id) AS decided_time`;

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
  duration_minutes: number | null;
  recruit_days_before: number;
  remind_start_days: number;
  remind_undecided_days: number;
  quota_enabled: number;
  quota_interval_days: number | null;
  assignment_enabled: number;
  /** グループ分け機能を有効にするか（ADR 0015） */
  grouping_enabled: number;
  mention_mode: MentionMode;
  requires_response: number;
  message_title: string;
  message_body: string | null;
  active: number;
  /** 回答締切（開始の N 時間前・null=なし・ADR 0014） */
  response_deadline_hours: number | null;
  /** 締切後変更の通知先チャンネル（null=投稿チャンネルにフォールバック・ADR 0014） */
  change_alert_channel_id: string | null;
  /** cron 駆動送信を送る JST 時（0〜23・既定 21・ADR 0013） */
  send_hour: number;
}

/** 全 Notification 取得（作成順・一覧用の集計列付き） */
export async function listNotifications(db: D1Database): Promise<NotificationListItem[]> {
  const { results } = await db
    .prepare(`SELECT ${COLS}${LIST_EXTRA} FROM notifications ORDER BY created_at`)
    .all<NotificationListItem>();
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

/** UUID で Notification を取得（未登録なら null・ADR 0016） */
export async function getNotificationByUuid(
  db: D1Database,
  uuid: string,
): Promise<Notification | null> {
  const row = await db
    .prepare(`SELECT ${COLS} FROM notifications WHERE uuid = ?`)
    .bind(uuid)
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

/** Server(guild_id) 配下の Notification 一覧（一覧用の集計列付き） */
export async function listNotificationsByGuild(
  db: D1Database,
  guildId: string,
): Promise<NotificationListItem[]> {
  const { results } = await db
    .prepare(`SELECT ${COLS}${LIST_EXTRA} FROM notifications WHERE guild_id = ? ORDER BY created_at`)
    .bind(guildId)
    .all<NotificationListItem>();
  return results;
}

/** Notification 作成。採番後の行を返す */
export async function createNotification(
  db: D1Database,
  input: NotificationInput,
): Promise<Notification> {
  const uuid = newUuid();
  const res = await db
    .prepare(
      `INSERT INTO notifications (
         uuid, guild_id, segment_id, name, channel_id, type, rrule, one_off_date, anchor_date, start_time,
         duration_minutes, recruit_days_before, remind_start_days, remind_undecided_days,
         quota_enabled, quota_interval_days, assignment_enabled, grouping_enabled, mention_mode, requires_response,
         message_title, message_body, active,
         response_deadline_hours, change_alert_channel_id, send_hour
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      uuid,
      input.guild_id,
      input.segment_id,
      input.name,
      input.channel_id,
      input.type,
      input.rrule ?? null,
      input.one_off_date ?? null,
      input.anchor_date ?? null,
      input.start_time,
      input.duration_minutes ?? null,
      input.recruit_days_before,
      input.remind_start_days,
      input.remind_undecided_days,
      input.quota_enabled,
      input.quota_interval_days ?? null,
      input.assignment_enabled,
      input.grouping_enabled,
      input.mention_mode,
      input.requires_response,
      input.message_title,
      input.message_body ?? null,
      input.active,
      input.response_deadline_hours ?? null,
      input.change_alert_channel_id ?? null,
      input.send_hour,
    )
    .run();
  const id = res.meta.last_row_id as number;
  const row = await getNotification(db, id);
  // フォールバック（getNotification が null の異常系のみ）。deprecated な mention_enabled は
  // mention_mode から導出して Notification 型を満たす。
  return (
    row ?? {
      id,
      uuid,
      created_at: '',
      decided_occurrence_id: null,
      mention_enabled: input.mention_mode === 'role' ? 1 : 0,
      ...input,
    }
  );
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
         one_off_date = ?, anchor_date = ?, start_time = ?, duration_minutes = ?,
         recruit_days_before = ?, remind_start_days = ?,
         remind_undecided_days = ?, quota_enabled = ?, quota_interval_days = ?,
         assignment_enabled = ?, grouping_enabled = ?, mention_mode = ?, requires_response = ?,
         message_title = ?, message_body = ?, active = ?,
         response_deadline_hours = ?, change_alert_channel_id = ?, send_hour = ?
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
      patch.duration_minutes ?? null,
      patch.recruit_days_before,
      patch.remind_start_days,
      patch.remind_undecided_days,
      patch.quota_enabled,
      patch.quota_interval_days ?? null,
      patch.assignment_enabled,
      patch.grouping_enabled,
      patch.mention_mode,
      patch.requires_response,
      patch.message_title,
      patch.message_body ?? null,
      patch.active,
      patch.response_deadline_hours ?? null,
      patch.change_alert_channel_id ?? null,
      patch.send_hour,
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
 * Notification 削除。配下 occurrences と、その responses / assignments / groupings も削除する。
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
  // グループ分け関連のカスケード削除（ADR 0015）
  await db
    .prepare(
      `DELETE FROM group_members WHERE group_id IN (
         SELECT g.id FROM groups g
         JOIN groupings gp ON gp.id = g.grouping_id
         JOIN occurrences o ON o.id = gp.occurrence_id
         WHERE o.notification_id = ?
       )`,
    )
    .bind(id)
    .run();
  await db
    .prepare(
      `DELETE FROM groups WHERE grouping_id IN (
         SELECT gp.id FROM groupings gp
         JOIN occurrences o ON o.id = gp.occurrence_id
         WHERE o.notification_id = ?
       )`,
    )
    .bind(id)
    .run();
  await db
    .prepare(
      `DELETE FROM groupings WHERE occurrence_id IN (
         SELECT id FROM occurrences WHERE notification_id = ?
       )`,
    )
    .bind(id)
    .run();
  await db.prepare('DELETE FROM grouping_constraints WHERE notification_id = ?').bind(id).run();
  await db.prepare('DELETE FROM occurrences WHERE notification_id = ?').bind(id).run();

  const res = await db.prepare('DELETE FROM notifications WHERE id = ?').bind(id).run();
  return (res.meta.changes ?? 0) > 0;
}
