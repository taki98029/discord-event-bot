import type { MentionMode, Notification, NotificationListItem, NotificationType } from './types';
import { formatDate, getJSTNow } from '../lib/date';
import { newUuid } from './uuid';

// one_off_date / decided_occurrence_id 列は旧 oneoff 用（2026-08-23 廃止・migration 0023）。列は休眠残置・ここでは読まない。
const COLS =
  'id, uuid, guild_id, segment_id, name, channel_id, type, rrule, anchor_date, start_time, ' +
  'duration_minutes, recruit_days_before, remind_start_days, remind_undecided_days, ' +
  'recruit_enabled, remind_unanswered_enabled, remind_undecided_enabled, remind_target, remind_undecided_target, share_answers, ' +
  'quota_enabled, quota_interval_days, quota_message, assignment_enabled, grouping_enabled, mention_enabled, mention_mode, ' +
  'requires_response, message_title, message_body, active, ' +
  'response_deadline_hours, change_alert_channel_id, send_hour, ' +
  'grouping_channel_id, created_at';

/** 一覧表示用の集計列（今日以降の直近の予定回の日付）。COLS に続けて付与し、today('YYYY/MM/DD') を 1 つ bind する。 */
const LIST_EXTRA =
  `, (SELECT MIN(o.occurrence_date) FROM occurrences o` +
  ` WHERE o.notification_id = notifications.id AND o.status = 'scheduled' AND o.occurrence_date >= ?) AS next_occurrence_date`;

/** Notification 作成/更新の入力（数値フラグは 0/1） */
export interface NotificationInput {
  guild_id: string;
  segment_id: number;
  name: string;
  channel_id: string;
  type: NotificationType;
  /** 正規化済み RRULE（src/lib/rruleGrammar.ts）。null = 不定期 */
  rrule: string | null;
  /** 次回の開催日（間隔 ≥ 2 のみ・ルールの開催日であること）。それ以外は null */
  anchor_date: string | null;
  start_time: string;
  duration_minutes: number | null;
  recruit_days_before: number;
  remind_start_days: number;
  remind_undecided_days: number;
  /** 工程スイッチ 0/1（ADR 0026） */
  recruit_enabled: number;
  remind_unanswered_enabled: number;
  remind_undecided_enabled: number;
  /** 未回答・未定リマインドの送り先（省略 = 'dm'・C02） */
  remind_target?: 'dm' | 'channel';
  remind_undecided_target?: 'dm' | 'channel';
  /** 📊 状況確認で全員の回答を見せるか（省略 = 1・公開） */
  share_answers?: number;
  quota_enabled: number;
  quota_interval_days: number | null;
  quota_message?: string | null;
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

/** 全 Notification 取得（作成順・一覧用の集計列付き）。today は next_occurrence_date の基準日（JST） */
export async function listNotifications(
  db: D1Database,
  today: string = formatDate(getJSTNow()),
): Promise<NotificationListItem[]> {
  const { results } = await db
    .prepare(`SELECT ${COLS}${LIST_EXTRA} FROM notifications ORDER BY created_at`)
    .bind(today)
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

/**
 * Server(guild_id) 配下の Notification をすべて無効化する（論理削除）。
 * cron は active=1 しか処理しないため、これでそのサーバーへの送信・ロール同期が止まる。
 * データ（区分・回答履歴など）は保持され、再招待すればそのまま参照できる。
 * @returns 無効化した件数
 */
export async function deactivateNotificationsForGuild(
  db: D1Database,
  guildId: string,
): Promise<number> {
  const res = await db
    .prepare('UPDATE notifications SET active = 0 WHERE guild_id = ? AND active = 1')
    .bind(guildId)
    .run();
  return (res.meta.changes as number) ?? 0;
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

/** Server(guild_id) 配下の Notification 一覧（一覧用の集計列付き）。today は next_occurrence_date の基準日（JST） */
export async function listNotificationsByGuild(
  db: D1Database,
  guildId: string,
  today: string = formatDate(getJSTNow()),
): Promise<NotificationListItem[]> {
  const { results } = await db
    .prepare(`SELECT ${COLS}${LIST_EXTRA} FROM notifications WHERE guild_id = ? ORDER BY created_at`)
    .bind(today, guildId)
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
         uuid, guild_id, segment_id, name, channel_id, type, rrule, anchor_date, start_time,
         duration_minutes, recruit_days_before, remind_start_days, remind_undecided_days,
         recruit_enabled, remind_unanswered_enabled, remind_undecided_enabled, remind_target, remind_undecided_target, share_answers,
         quota_enabled, quota_interval_days, quota_message, assignment_enabled, grouping_enabled, mention_mode, requires_response,
         message_title, message_body, active,
         response_deadline_hours, change_alert_channel_id, send_hour
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      uuid,
      input.guild_id,
      input.segment_id,
      input.name,
      input.channel_id,
      input.type,
      input.rrule ?? null,
      input.anchor_date ?? null,
      input.start_time,
      input.duration_minutes ?? null,
      input.recruit_days_before,
      input.remind_start_days,
      input.remind_undecided_days,
      input.recruit_enabled,
      input.remind_unanswered_enabled,
      input.remind_undecided_enabled,
      input.remind_target ?? 'dm',
      input.remind_undecided_target ?? 'dm',
      input.share_answers ?? 1,
      input.quota_enabled,
      input.quota_interval_days ?? null,
      input.quota_message ?? null,
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
      grouping_channel_id: null,
      mention_enabled: input.mention_mode === 'role' ? 1 : 0,
      ...input,
      remind_target: input.remind_target ?? 'dm',
      remind_undecided_target: input.remind_undecided_target ?? 'dm',
      share_answers: input.share_answers ?? 1,
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
         anchor_date = ?, start_time = ?, duration_minutes = ?,
         recruit_days_before = ?, remind_start_days = ?,
         remind_undecided_days = ?, recruit_enabled = ?, remind_unanswered_enabled = ?,
         remind_undecided_enabled = ?, remind_target = ?, remind_undecided_target = ?, share_answers = ?, quota_enabled = ?, quota_interval_days = ?,
         quota_message = CASE WHEN ? THEN ? ELSE quota_message END,
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
      patch.anchor_date ?? null,
      patch.start_time,
      patch.duration_minutes ?? null,
      patch.recruit_days_before,
      patch.remind_start_days,
      patch.remind_undecided_days,
      patch.recruit_enabled,
      patch.remind_unanswered_enabled,
      patch.remind_undecided_enabled,
      patch.remind_target ?? 'dm',
      patch.remind_undecided_target ?? 'dm',
      patch.share_answers ?? 1,
      patch.quota_enabled,
      patch.quota_interval_days ?? null,
      patch.quota_message === undefined ? 0 : 1,
      patch.quota_message ?? null,
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
 * メンバー配置結果の投稿先チャンネルを設定する（NULL=通知の channel_id にフォールバック）。
 * 通知フォームとは独立した即時保存設定（メンバー配置設定ページ）のため専用 UPDATE にする。
 */
export async function setGroupingChannel(
  db: D1Database,
  id: number,
  channelId: string | null,
): Promise<boolean> {
  const res = await db
    .prepare('UPDATE notifications SET grouping_channel_id = ? WHERE id = ?')
    .bind(channelId, id)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/** 日程調整（planning_plans.data.schedules）で使用中か。使用中のテンプレートは削除できない */
export async function isNotificationInPlanning(db: D1Database, id: number): Promise<boolean> {
  return !!(await db.prepare("SELECT 1 FROM planning_plans p,json_each(p.data,'$.schedules') s WHERE s.value=? LIMIT 1").bind(id).first());
}

/**
 * Notification 削除。配下 occurrences と、その responses / groupings も削除する。
 * 削除した場合 true。
 */
export async function deleteNotification(db: D1Database, id: number): Promise<boolean> {
  if (await isNotificationInPlanning(db, id)) throw new Error('日程調整で使用中のテンプレートは削除できません。無効化してください。');
  // 途中で失敗して回答だけ消える等の中途半端を避けるため、1 つの batch（全部成功か全部取り消し）で消す
  const occs = 'SELECT id FROM occurrences WHERE notification_id = ?';
  const results = await db.batch([
    db.prepare(`DELETE FROM responses WHERE occurrence_id IN (${occs})`).bind(id),
    db.prepare(`DELETE FROM response_log WHERE occurrence_id IN (${occs})`).bind(id),
    // 送信履歴も消す（残すと履歴画面に出ない親なしの行が増え続けるだけ）
    db.prepare('DELETE FROM send_log WHERE notification_id = ?').bind(id),
    // グループ分け関連のカスケード削除（ADR 0015）
    db
      .prepare(
        `DELETE FROM group_members WHERE group_id IN (
           SELECT g.id FROM groups g JOIN groupings gp ON gp.id = g.grouping_id WHERE gp.occurrence_id IN (${occs})
         )`,
      )
      .bind(id),
    db.prepare(`DELETE FROM groups WHERE grouping_id IN (SELECT id FROM groupings WHERE occurrence_id IN (${occs}))`).bind(id),
    db.prepare(`DELETE FROM groupings WHERE occurrence_id IN (${occs})`).bind(id),
    db.prepare('DELETE FROM grouping_constraints WHERE notification_id = ?').bind(id),
    db.prepare('DELETE FROM occurrences WHERE notification_id = ?').bind(id),
    db.prepare('DELETE FROM notifications WHERE id = ?').bind(id),
  ]);
  const res = results[results.length - 1];
  return (res.meta.changes ?? 0) > 0;
}
