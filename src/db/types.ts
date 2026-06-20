/**
 * D1 行・ドメイン型（Server[guild_id] ＞ Notification → Segment ＞ Occurrence）。
 * 用語の定義は docs/dev/CONTEXT.md、スキーマは migrations/0002 + 0003(guild_id) + 0004(Event 廃止) を参照。
 * 最上位スコープの Server は Discord API（bot の参加サーバー）から取得し DB には永続化しない（ADR 0004）。
 */

/** segments: 設定可能なメンバー区分（キャスト/スタッフ等） */
export interface Segment {
  id: number;
  guild_id: string;
  name: string;
  /** @メンション用 Discord ロールID / '@everyone' / null。設定時は「ロール管理区分」のメンバー源も兼ねる（ADR 0009） */
  mention_role_id: string | null;
  /** ロール管理区分のメンバーを Discord ロールから同期した最終時刻。null=未同期/手動区分（ADR 0009） */
  members_synced_at: string | null;
  created_at: string;
}

/** members: グローバルな人物マスタ。休止状態は SegmentMembership 側に持つ */
export interface Member {
  user_id: string;
  user_name: string | null;
  display_name: string | null;
  dm_channel_id: string | null;
  created_at: string;
}

/** segment_members: 所属（Member × Segment）＋区分ごとの休止状態 */
export interface SegmentMembership {
  segment_id: number;
  user_id: string;
  /** '' = アクティブ / '休止中' */
  status: string;
  joined_at: string;
}

/** Member に所属ステータスを合成した型（区分メンバー一覧用） */
export interface SegmentMember extends Member {
  /** その区分での所属ステータス。'' = アクティブ / '休止中' */
  status: string;
}

export type NotificationType = 'recurring' | 'oneoff';

/**
 * メンション方法（ADR 0010）。投稿が対象者をどう名指すか。
 * - 'none': メンションしない
 * - 'role': Segment のロール（または '@everyone'）をメンション（旧 mention_enabled=1 相当）
 * - 'members': Segment のアクティブ Member を `<@id>` で個別列挙（少人数向け・超過は「ほかN名」）
 */
export type MentionMode = 'none' | 'role' | 'members';

/** notifications: Server(guild_id) 配下の独立トラック */
export interface Notification {
  id: number;
  guild_id: string;
  segment_id: number;
  name: string;
  channel_id: string;
  type: NotificationType;
  /** recurring 用 RFC5545 RRULE 文字列 */
  rrule: string | null;
  /** oneoff 用 'YYYY/MM/DD' */
  one_off_date: string | null;
  /**
   * recurring の系列基準（隔週パリティ決定用の dtstart 起点・'YYYY/MM/DD'・null可）。
   * UI では「次回の開催日」候補として提示する（「基準日」表記は廃語・ADR 0007）。
   */
  anchor_date: string | null;
  /** 'HH:MM'（JST） */
  start_time: string;
  /**
   * 開催時間（分）。From-To 表示用。null / 0 以下=未設定で開始時刻のみ「HH:MM〜」表示。
   * 候補スロット共通の長さ（同一イベントの代替開始時刻のため）。
   */
  duration_minutes: number | null;
  recruit_days_before: number;
  remind_start_days: number;
  remind_undecided_days: number;
  /** 0/1 */
  quota_enabled: number;
  quota_interval_days: number | null;
  /** 0/1 */
  assignment_enabled: number;
  /**
   * @deprecated mention_mode へ移行（ADR 0010）。列は後方互換で残すが本体は参照しない。
   * 0/1 対象 Segment の Discord ロールへ @メンションするか
   */
  mention_enabled: number;
  /** メンション方法（ADR 0010）。'none' | 'role' | 'members' */
  mention_mode: MentionMode;
  /**
   * recurring が出欠回答を集めるか（0/1）。0=回答不要（通知のみ・ボタンなし）で、
   * 未回答/未定リマインド・ノルマ・番号割り当ては対象外。oneoff は常に 1（ADR 0010）。
   */
  requires_response: number;
  /** 投稿の見出し（必須・1 行）。チャンネルへの募集/告知投稿の1行目に **太字** で出る（ADR 0010）。 */
  message_title: string;
  /** 投稿本文（任意・複数行）。NULL/空なら省略。日時行とボタンはシステムが自動付加（ADR 0010）。 */
  message_body: string | null;
  /** 0/1 */
  active: number;
  /**
   * 単発・複数候補日で確定した開催回の id（occurrences.id）。NULL=未確定。
   * 確定すると当該回以外の候補は cancelled になり、cron はこの回のみを対象にする。
   */
  decided_occurrence_id: number | null;
  created_at: string;
}

/** 通知一覧表示用に集計列を付与した行（候補数・確定回の日時）。一覧クエリのみで返す。 */
export interface NotificationListItem extends Notification {
  /** status='scheduled' の occurrences 件数（単発の候補数。確定後は1） */
  candidate_count: number;
  /** decided_occurrence_id の開催日（未確定は null） */
  decided_date: string | null;
  /** decided_occurrence_id の開始時刻（未確定は null） */
  decided_time: string | null;
}

export type OccurrenceStatus = 'scheduled' | 'cancelled';

/** occurrences: Notification の 1 開催回（単発の複数候補では「日付＋時刻」のスロット1つ） */
export interface Occurrence {
  id: number;
  notification_id: number;
  /** 'YYYY/MM/DD'（JST・ゼロ埋めで辞書順=時系列順） */
  occurrence_date: string;
  /** 'HH:MM'（JST）。このスロットの開始時刻。空文字は通知の start_time で補完して表示 */
  start_time: string;
  status: OccurrenceStatus;
  created_at: string;
}

/** responses: 開催回への 1 Member の回答（旧 event_log） */
export interface Response {
  occurrence_id: number;
  user_id: string;
  user_name: string | null;
  /** 参加 / 不参加 / 未定 */
  status: string;
  updated_at: string;
}

/** assignments: 開催回ごとのユニークな割り当て番号 */
export interface Assignment {
  occurrence_id: number;
  user_id: string;
  number: number;
  assigned_at: string;
}

/** 出欠状況の集計結果（表示名の配列） */
export type EventStatusBuckets = {
  参加: string[];
  不参加: string[];
  未定: string[];
  未回答: string[];
};

/** ノルマ未達メンバー */
export interface QuotaAlert extends Member {
  daysSinceLast: number;
  lastDateStr: string;
}

/** 表示名を解決（display_name > user_name > user_id） */
export function resolveDisplayName(m: Member): string {
  return m.display_name || m.user_name || m.user_id;
}
