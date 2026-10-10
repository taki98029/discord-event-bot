/**
 * D1 行・ドメイン型（Server[guild_id] ＞ Notification → Segment ＞ Occurrence）。
 * 用語の定義は docs/dev/CONTEXT.md、スキーマは migrations/0002 + 0003(guild_id) + 0004(Event 廃止) を参照。
 * 最上位スコープの Server は Discord API（bot の参加サーバー）から取得し DB には永続化しない（ADR 0004）。
 */

/** segments: 設定可能なメンバー区分（キャスト/スタッフ等） */
export interface Segment {
  id: number;
  /** URL／API 表面用の UUID（ADR 0016）。内部結合は id を使う */
  uuid: string;
  guild_id: string;
  name: string;
  /** @メンション用 Discord ロールID / '@everyone' / null。設定時は「ロール管理区分」のメンバー源も兼ねる（ADR 0009） */
  mention_role_id: string | null;
  /** ロール管理区分のメンバーを Discord ロールから同期した最終時刻。null=未同期/手動区分（ADR 0009） */
  members_synced_at: string | null;
  created_at: string;
}

/**
 * members: グローバルな人物マスタ。休止状態は SegmentMembership 側に持つ。
 * display_name はギルドごとに member_guild_profiles が優先され（ADR 0022）、
 * ギルドスコープのクエリでは COALESCE(gp.display_name, m.display_name) が入る。
 * members.display_name 自体はギルド不明時（DM 由来等）のフォールバック。
 */
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

/**
 * 旧 'oneoff'（単発・日程調整）は 2026-08-23 に廃止し不定期（rrule=NULL）へ吸収（migration 0023・ADR 0025）。
 * 2026-10-02 に 'oneoff' を「単発出欠確認」（rrule=NULL・開催回 1 件をテンプレートと同時に作る）の印として再利用。
 * 作成時に固定（PUT では変えない）。cron・Discord 側は不定期と同じに扱い、type では分岐しない。
 */
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
  /** URL／API 表面用の UUID（ADR 0016）。内部結合は id を使う */
  uuid: string;
  guild_id: string;
  segment_id: number;
  name: string;
  channel_id: string;
  type: NotificationType;
  /**
   * 繰り返しルール（RFC5545 RRULE のサブセット文法・src/lib/rruleGrammar.ts・正規化済み）。
   * **NULL = 不定期**（ルールなし。開催回は運用者が開催回タブで追加した行だけ）。
   */
  rrule: string | null;
  /**
   * 「次回の開催日」'YYYY/MM/DD'。間隔 ≥ 2（隔週・隔月・N 日おき等）の位相基準で、ルールの開催日でなければならない。
   * 間隔 1 と不定期では NULL（API が NULL に正規化）。評価の扱いは src/lib/recurrence.ts 冒頭を参照。
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
  /**
   * 配信の流れの工程スイッチ（0/1・ADR 0026）。0 でもその日数は保持する（ON に戻すと復帰）。
   * recruit_enabled=0: 募集/告知を自動投稿しない（📣 今すぐ募集で手動投稿。ノルマ督促も送られない）
   * remind_unanswered_enabled=0 / remind_undecided_enabled=0: そのリマインド DM を送らない
   */
  recruit_enabled: number;
  remind_unanswered_enabled: number;
  remind_undecided_enabled: number;
  /** 未回答・未定リマインドの送り先（1 スケジュールに 1 つ・C02 2026-09-20）。'dm'=本人へ DM / 'channel'=投稿チャンネルへ 1 日 1 投稿で該当メンバーを個別メンション */
  /** 未回答リマインドの送り先（0031 では両方共通・2026-09-23 に未定と分離） */
  remind_target: 'dm' | 'channel';
  /** 未定リマインドの送り先（0035） */
  remind_undecided_target: 'dm' | 'channel';
  /** 0/1。1=📊 状況確認で全員の回答を表示 / 0=押した本人の回答だけ（2026-09-23・日程調整 shareAnswers と対） */
  share_answers: number;
  /** 0/1 */
  quota_enabled: number;
  quota_interval_days: number | null;
  /** ノルマDMの本文。未設定・空は既定文面（差し込み項目は src/lib/quotaMessage.ts）。 */
  quota_message?: string | null;
  /** 0/1 */
  assignment_enabled: number;
  /** 0/1 グループ分け機能を有効にするか（ADR 0015） */
  grouping_enabled: number;
  /**
   * @deprecated mention_mode へ移行（ADR 0010）。列は後方互換で残すが本体は参照しない。
   * 0/1 対象 Segment の Discord ロールへ @メンションするか
   */
  mention_enabled: number;
  /** メンション方法（ADR 0010）。'none' | 'role' | 'members' */
  mention_mode: MentionMode;
  /**
   * 出欠回答を集めるか（0/1）。0=回答不要（告知のみ・ボタンなし）で、
   * 未回答/未定リマインド・ノルマ・番号割り当ては対象外（ADR 0010）。
   */
  requires_response: number;
  /** 投稿の見出し（必須・1 行）。チャンネルへの募集/告知投稿の1行目に **太字** で出る（ADR 0010）。 */
  message_title: string;
  /** 投稿本文（任意・複数行）。NULL/空なら省略。日時行とボタンはシステムが自動付加（ADR 0010）。 */
  message_body: string | null;
  /** 0/1 */
  active: number;
  /**
   * 回答締切（ADR 0014）。開催開始の N 時間前を「これ以降は変更しないで」の境界とする。
   * NULL=締切なし。締切後の Response 変更（未回答→回答含む）を検知して通知し、回答履歴で識別する。
   */
  response_deadline_hours: number | null;
  /** 締切後変更の通知先チャンネル（ADR 0014）。NULL=通知の channel_id にフォールバック。 */
  change_alert_channel_id: string | null;
  /** メンバー配置結果の投稿先チャンネル（マスター設定）。NULL=通知の channel_id にフォールバック。 */
  grouping_channel_id: string | null;
  /**
   * cron 駆動送信（募集/未回答・未定リマインド/ノルマ/締切告知）を JST の何時に送るか（0〜23・ADR 0013）。
   * 開催の start_time とは別物。既定 21（従来の cron 固定 21:00 踏襲）。
   */
  send_hour: number;
  created_at: string;
}

/** 一覧表示用に集計列を付与した行。一覧クエリのみで返す。 */
export interface NotificationListItem extends Notification {
  /** 今日以降で最も近い予定（scheduled）の開催回の日付 'YYYY/MM/DD'。無ければ null（不定期の「次回 M/D」表示用） */
  next_occurrence_date: string | null;
}

export type OccurrenceStatus = 'scheduled' | 'cancelled';

/**
 * 開催回の由来（migration 0023）。'rule'=RRULE から実体化（ロールフォワード・仮想行の実体化）／
 * 'manual'=運用者が追加（臨時回・不定期の開催回）。ルール変更時に自動削除されるのは rule の未投稿行だけ。
 */
export type OccurrenceOrigin = 'rule' | 'manual';

/** occurrences: Notification の 1 開催回（「日付＋開始時刻」のスロット1つ） */
export interface Occurrence {
  id: number;
  /** URL／API 表面用の UUID（ADR 0016）。内部結合は id を使う */
  uuid: string;
  notification_id: number;
  /** 'YYYY/MM/DD'（JST・ゼロ埋めで辞書順=時系列順） */
  occurrence_date: string;
  /** 'HH:MM'（JST）。このスロットの開始時刻。空文字は通知の start_time で補完して表示 */
  start_time: string;
  status: OccurrenceStatus;
  origin: OccurrenceOrigin;
  /** 補足メッセージ（臨時回のコラボ説明など）。募集の本文と日時行の間に差し込む。NULL=なし */
  note: string | null;
  /** この開催回の回答締切（開始の N 時間前）。NULL=雛形（notifications.response_deadline_hours）に従う。不定期で使う（ADR 0032） */
  response_deadline_hours: number | null;
  /** この開催回の開催時間（分）。NULL=雛形（notifications.duration_minutes）に従う。単発は開催回ごとに登録する（2026-09-23） */
  duration_minutes: number | null;
  /** 送信時刻と投稿の流れ（単発は開催回ごと・migration 0036）。NULL=雛形の保存値に従う。定期の臨時回は常に NULL */
  send_hour: number | null;
  recruit_enabled: number | null;
  recruit_days_before: number | null;
  remind_unanswered_enabled: number | null;
  remind_start_days: number | null;
  remind_undecided_enabled: number | null;
  remind_undecided_days: number | null;
  remind_target: 'dm' | 'channel' | null;
  remind_undecided_target: 'dm' | 'channel' | null;
  created_at: string;
}

/** 開催回ごとに上書きできる投稿の流れの項目（単発・migration 0036） */
export const OCCURRENCE_FLOW_KEYS = [
  'send_hour', 'recruit_enabled', 'recruit_days_before', 'remind_unanswered_enabled', 'remind_start_days',
  'remind_undecided_enabled', 'remind_undecided_days', 'remind_target', 'remind_undecided_target',
] as const;
export type OccurrenceFlowKey = (typeof OCCURRENCE_FLOW_KEYS)[number];
export type OccurrenceFlow = Pick<Notification, OccurrenceFlowKey>;

/**
 * 開催回に有効な送信時刻と投稿の流れ: 開催回の値があればそれ、無ければ雛形の値。cron・締切ガード・📣 の手動判定はこれを使う。
 * 返す形は Notification そのもの（id・channel_id などはそのまま）なので、n の代わりにそのまま渡せる。
 */
export function flowFor(n: Notification, occ: { [K in OccurrenceFlowKey]?: OccurrenceFlow[K] | null }): Notification {
  const out = { ...n };
  for (const k of OCCURRENCE_FLOW_KEYS) {
    const v = occ[k];
    if (v != null) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/** 開催回に有効な回答締切（時間前）。開催回の値があればそれ、無ければ雛形の値（ADR 0032）。 */
export function deadlineHoursFor(
  n: { response_deadline_hours: number | null },
  occ: { response_deadline_hours?: number | null },
): number | null {
  return occ.response_deadline_hours ?? n.response_deadline_hours;
}

/** 開催回に有効な開催時間（分）。開催回の値があればそれ、無ければ雛形の値。 */
export function durationFor(
  n: { duration_minutes: number | null },
  occ: { duration_minutes?: number | null },
): number | null {
  return occ.duration_minutes ?? n.duration_minutes;
}

/** responses: 開催回への 1 Member の回答（旧 event_log） */
export interface Response {
  occurrence_id: number;
  user_id: string;
  user_name: string | null;
  /** 参加 / 不参加 / 未定 */
  status: string;
  updated_at: string;
  /** 締切後に変更された回答か（0/1・ADR 0014）。回答履歴で「締切後変更」列として表示する。 */
  post_deadline_change: number;
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
export function resolveDisplayName(m: Pick<Member, 'display_name' | 'user_name' | 'user_id'>): string {
  return m.display_name || m.user_name || m.user_id;
}

// ponytail: (b) 既存の tick/admin に散らばる「回答不要」判定を 1 本化（ADR 0010）。
/** 回答不要（告知のみ）か。requires_response=0 のとき true。 */
export function isAnnounceOnly(n: Pick<Notification, 'requires_response'>): boolean {
  return !n.requires_response;
}

/**
 * send_log の送信種別（ADR 0013）。cron 駆動のペース配信のみが対象で、いずれも
 * 「(通知, 開催回, 宛先, 種別, 送信日) で 1 日 1 回」の冪等。締切後変更の即時通知（change_alert）は
 * interaction 時の処理で send_log には記録しない（responses.post_deadline_change が durable な記録）。
 */
export type SendLogKind =
  | 'recruit'
  | 'remind_unanswered'
  | 'remind_undecided'
  | 'quota'
  | 'deadline_notice';

/** send_log: cron 駆動送信の記録（冪等台帳 兼 ペースカーソル 兼 可視化・ADR 0013） */
export interface SendLog {
  id: number;
  notification_id: number;
  /** 開催回 id。0 = 開催回に紐づかない（ノルマ等） */
  occurrence_id: number;
  /** DM 宛先 user_id。'' = チャンネル投稿（個人宛なし） */
  user_id: string;
  kind: SendLogKind;
  /** 'YYYY/MM/DD'(JST)。同日冪等の鍵 */
  send_date: string;
  /** sent | failed */
  status: string;
  /** 失敗理由（DM 拒否等）。成功時 null */
  error: string | null;
  created_at: string;
}

/** リマインド送信履歴の一覧表示用（send_log に通知名/開催日を合成・admin 閲覧用） */
export interface SendLogListItem extends SendLog {
  notification_name: string;
  /** 通知の回答要否。UI が kind='recruit' の表示を「募集/告知」に分岐するために同送する */
  requires_response: number;
  /** 宛先の表示名（display_name > user_name）。members に無ければ null（UI は user_id 表示にフォールバック） */
  user_name: string | null;
  occurrence_date: string | null;
}

/**
 * グループ分け（Grouping）関連の型（ADR 0015）。
 * Occurrence 単位で 1 つ作成し、参加者を group_count 個の Group に分割する。
 */

/** ペア制約の方向 */
export type ConstraintDirection = 'together' | 'apart';
/** ペア制約の強度 */
export type ConstraintStrength = 'required' | 'preferred';

/** groupings: 1 Occurrence あたり 1 つ */
export interface Grouping {
  id: number;
  /** URL／API 表面用の UUID（ADR 0016） */
  uuid: string;
  occurrence_id: number;
  group_count: number;
  created_at: string;
  updated_at: string;
}

/** groups: グループ実体（表示順と名前を持つ） */
export interface Group {
  id: number;
  /** URL／API 表面用の UUID（ADR 0016） */
  uuid: string;
  grouping_id: number;
  group_index: number;
  name: string;
  /** 自動連番の開始番号（既定 1・ADR 0015 追補2拡張） */
  start_no: number;
}

/** group_members: グループへのメンバー所属 */
export interface GroupMember {
  group_id: number;
  user_id: string;
}

/** grouping_constraints: Notification 単位のペア制約 */
export interface GroupingConstraint {
  id: number;
  /** URL／API 表面用の UUID（ADR 0016） */
  uuid: string;
  notification_id: number;
  /** ペアは a < b で正規化して保存 */
  user_id_a: string;
  user_id_b: string;
  direction: ConstraintDirection;
  strength: ConstraintStrength;
  created_at: string;
}

/** API 応答用: Group + メンバー一覧（表示名付き） */
export interface GroupWithMembers {
  id: number;
  /** URL／API 表面用の UUID（ADR 0016）。クライアントの DOM data 属性キー・rename/move 等の参照キーに使う */
  uuid: string;
  group_index: number;
  name: string;
  /** 自動連番の開始番号（既定 1） */
  start_no: number;
  /** label: 行頭ラベルの上書き（開催回×メンバー単位・null=自動連番・ADR 0015 追補2） */
  members: { user_id: string; name: string; label: string | null }[];
}

/** API 応答用: Grouping の全体ビュー */
export interface GroupingView {
  grouping: Grouping | null;
  groups: GroupWithMembers[];
  /** 未割り当ての参加者（プール） */
  pool: { user_id: string; name: string }[];
  /** 保存後に「不参加」に変わった or 既存メンバーで未割り当てだが現在も「参加」のメンバー差分情報 */
  diff: {
    /** グループに入っているが現在は参加していないメンバー（保存時 vs 現在） */
    no_longer_participating: { user_id: string; name: string; group_id: number }[];
    /** 現在「参加」だがどのグループにも入っていない新規参加者 */
    newly_participating: { user_id: string; name: string }[];
  };
}

/** サーバー単位の送信失敗通知。config に JSON で保存する。 */
export type FailureNotificationSettings = {
  channel_id: string | null;
  mention_mode: 'none' | 'users' | 'roles';
  mention_ids: string[];
};
