import { handlePlanningAdmin } from '../planning/admin';
import { plannedOccurrence } from '../planning/store';
import { quotaMessageError } from '../lib/quotaMessage';
import type { Env } from '../env';
import type { MentionMode, Notification, OccurrenceOrigin } from '../db/types';
import { deadlineHoursFor, durationFor, flowFor, isAnnounceOnly, OCCURRENCE_FLOW_KEYS, type OccurrenceFlow } from '../db/types';
import { listGuilds, listGuildChannels, listGuildMembers, listGuildRoles, leaveGuild } from '../discord/rest';
import {
  listSegments,
  getSegmentByUuid,
  createSegment,
  updateSegment,
  deleteSegment,
  countNotificationsForSegment,
  listSegmentMembers,
  addSegmentMember,
  setSegmentMemberStatus,
  removeSegmentMember,
  getActiveSegmentMembers,
} from '../db/segments';
import { syncSegmentFromRole, normalizeMentionRoleId } from '../discord/syncSegment';
import { getAllMembers, upsertMember, deleteMember } from '../db/members';
import {
  listNotifications,
  listNotificationsByGuild,
  deactivateNotificationsForGuild,
  getNotification,
  getNotificationByUuid,
  createNotification,
  updateNotification,
  deleteNotification,
  isNotificationInPlanning,
  setGroupingChannel,
  type NotificationInput,
} from '../db/notifications';
import {
  getOccurrence,
  getOccurrenceByUuid,
  resetCancelledOccurrence,
  getOrCreateOccurrence,
  setOccurrenceNote,
  setOccurrenceStatus,
  setOccurrenceDeadline,
  setOccurrenceDuration,
  setOccurrenceFlow,
  updateOccurrenceDate,
  listOccurrencesForNotification,
  pruneRuleOccurrences,
} from '../db/occurrences';
import { anchorMatchesRule, nextOccurrenceDates, type RecurrenceSpec } from '../lib/recurrence';
import { flowWarnings } from '../lib/flowRules';
import { formatRule, normalizeRule, parseRule } from '../lib/rruleGrammar';
import { getResponsesForOccurrence, getStatusBuckets, listRecentResponses } from '../db/responses';
import {
  getGroupingView,
  getConstraintByUuid,
  upsertGrouping,
  setGroupMembers,
  moveMemberToGroup,
  renameGroup,
  setGroupStartNo,
  deleteGrouping,
  listConstraints,
  upsertConstraint,
  deleteConstraint,
  autoAssign,
} from '../db/groupings';
import type { ConstraintDirection, ConstraintStrength, GroupingView } from '../db/types';
import { hasSentKind, listSendLog } from '../db/sendLog';
import { getAttendanceReport } from '../db/reports';
import { getAllConfig, setConfig, getSendBudget, OCC_ROLLFORWARD_KEY } from '../db/config';
import { DISCORD_CONTENT_LIMIT, sendChannelMessage } from '../discord/rest';
import { cutText } from '../lib/text';
import { recruitOccurrenceNow } from '../cron/tick';
import { formatDate, formatOccurrenceLabel, getJSTNow, nextRecruitAt, occurrenceDeadlineError, responseDeadline } from '../lib/date';
import { getSetupStatus, registerCommandsForEnv } from './setup';
import { channelFilterKey, parseChannelFilter, withEnabled } from '../discord/channelFilter';
import { failureNotificationKey, getFailureNotificationSettings, parseFailureNotificationSettings, notifyDeliveryFailure } from '../discord/failureNotifications';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** クエリの数値（不正・非数値・0以下なら既定値）。不正 limit でD1に NaN を渡し 500 になるのを防ぐ。 */
function parseLimit(raw: string | null, def: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
}

/** ボディの数値（''・null・非数値なら既定値）。NaN を .bind に渡して 500 になるのを防ぐ。 */
function num(v: unknown, def: number): number {
  if (v === '' || v == null) return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}
/** 0/1 フラグ。未指定（旧クライアント・省略）は def。 */
function flag(v: unknown, def: 0 | 1): 0 | 1 {
  return v == null ? def : v ? 1 : 0;
}

/** 定数時間比較（トークン照合） */
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

function authorized(request: Request, env: Env): boolean {
  const header = request.headers.get('authorization') || '';
  const prefix = 'Bearer ';
  if (!header.startsWith(prefix)) return false;
  const token = header.slice(prefix.length);
  return !!env.ADMIN_TOKEN && timingSafeEqual(token, env.ADMIN_TOKEN);
}

/** URL パスの UUID セグメント（8-4-4-4-12 ハイフン入り 16 進文字列・ADR 0016） */
const UUID_RE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** 盤面から送られてくる配置 1 グループ分（label は行頭ラベルの上書き・null=自動連番） */
export interface BoardAssignment {
  group_uuid?: string;
  members?: { user_id?: string; label?: string | null }[];
}

/** 行頭ラベルの末尾区切り（：/:）を除去する。区切りは保存値に持たせず表示時に一律付与する */
export function stripLabelSeparator(label: string): string {
  return label.replace(/[：:]+$/u, '');
}

/** BoardAssignment.members を正規化（user_id 必須・label は空文字を null に・末尾：除去・最大20字） */
export function normalizeBoardMembers(
  members: BoardAssignment['members'],
): { user_id: string; label: string | null }[] {
  return (Array.isArray(members) ? members : [])
    .filter((m) => m && typeof m.user_id === 'string' && m.user_id)
    .map((m) => {
      const raw = typeof m.label === 'string' ? cutText(stripLabelSeparator(m.label.trim()), 20) : '';
      return { user_id: m.user_id as string, label: raw || null };
    });
}

/**
 * メンバー配置投稿の 1 グループ分の行頭ラベル列（ADR 0015 追補2）。
 * label の上書きはそのまま、残りへ startNo 起点の連番を振る（上書きは連番を消費しない）。
 * 区切りの「：」は自動連番・上書きラベルとも表示時に一律付与する。
 */
export function memberLineLabels(
  members: { label?: string | null }[],
  startNo = 1,
): string[] {
  let n = startNo - 1;
  return members.map((m) => (m.label ? `${stripLabelSeparator(m.label)}：` : `${++n}：`));
}

/**
 * dry-run プレビュー用（ADR 0015 追補）: 盤面の現在状態（未保存の assignments / 未割り当て）を
 * GroupingView へ上書きする。名前は view 内の既知メンバー（未割り当て・保存済み groups）から
 * 解決し、未知の user_id はそのまま表示する。assignments に無い Group は保存済みのまま残す。
 */
export function applyBoardStateToView(
  view: GroupingView,
  assignments: BoardAssignment[],
  poolUserIds: string[],
): void {
  const nameOf = new Map<string, string>();
  for (const p of view.pool) nameOf.set(p.user_id, p.name);
  for (const g of view.groups) for (const m of g.members) nameOf.set(m.user_id, m.name);
  const byUuid = new Map(assignments.map((a) => [a.group_uuid, normalizeBoardMembers(a.members)]));
  for (const g of view.groups) {
    const ms = byUuid.get(g.uuid);
    if (ms) g.members = ms.map((m) => ({ ...m, name: nameOf.get(m.user_id) ?? m.user_id }));
  }
  view.pool = poolUserIds.map((uid) => ({ user_id: uid, name: nameOf.get(uid) ?? uid }));
}

/**
 * Notification の入力ボディを正規化（数値フラグは 0/1）。rrule/anchor_date は生値のまま入れ、
 * 文法検証・正規化は validateRecurrence で行う（呼び出し側が 400 判定）。
 */
function toNotificationInput(b: Record<string, unknown>): NotificationInput | null {
  const guild_id = typeof b.guild_id === 'string' ? b.guild_id : '';
  const segment_id = Number(b.segment_id);
  const name = typeof b.name === 'string' ? b.name : '';
  const channel_id = typeof b.channel_id === 'string' ? b.channel_id : '';
  if (!guild_id || !segment_id || !name || !channel_id) return null;
  // 回答不要(=告知のみ)は回答依存機能を無効化する。
  const requiresResponse = b.requires_response === undefined ? 1 : b.requires_response ? 1 : 0;
  const announceOnly = isAnnounceOnly({ requires_response: requiresResponse });
  return {
    guild_id,
    segment_id,
    name,
    channel_id,
    // 単発（oneoff）は繰り返しを持たない（不定期と同じ rrule NULL）
    type: b.type === 'oneoff' ? 'oneoff' : 'recurring',
    rrule: b.type === 'oneoff' || b.rrule == null || b.rrule === '' ? null : String(b.rrule),
    anchor_date: b.anchor_date == null || b.anchor_date === '' ? null : String(b.anchor_date),
    start_time: typeof b.start_time === 'string' && b.start_time ? b.start_time : '21:00',
    duration_minutes:
      (typeof b.duration_minutes !== 'number' && typeof b.duration_minutes !== 'string') ||
      b.duration_minutes === '' ||
      !Number.isFinite(Number(b.duration_minutes)) ||
      Number(b.duration_minutes) <= 0
        ? null
        : Math.floor(Number(b.duration_minutes)),
    recruit_days_before: num(b.recruit_days_before, 7),
    remind_start_days: num(b.remind_start_days, 3),
    // 負値は daysUntil と一致せず未定リマインドが無音化するため 0 以上にクランプ（0=当日）。
    remind_undecided_days: Math.max(0, num(b.remind_undecided_days, 1)),
    // 工程スイッチ（ADR 0026）。省略時は 1＝従来どおり自動で行う
    recruit_enabled: flag(b.recruit_enabled, 1),
    remind_unanswered_enabled: flag(b.remind_unanswered_enabled, 1),
    remind_undecided_enabled: flag(b.remind_undecided_enabled, 1),
    // 未回答・未定リマインドの送り先（C02・2026-09-20）。不正値・省略は 'dm'。
    remind_target: b.remind_target === 'channel' ? 'channel' : 'dm',
    remind_undecided_target: b.remind_undecided_target === 'channel' ? 'channel' : 'dm',
    // 📊 状況確認の公開（2026-09-23）。省略は公開＝従来どおり
    share_answers: flag(b.share_answers, 1),
    quota_enabled: b.quota_enabled ? 1 : 0,
    quota_message: b.quota_message === undefined ? undefined : typeof b.quota_message === 'string' ? b.quota_message.trim() || null : null,
    quota_interval_days:
      b.quota_interval_days == null ||
      b.quota_interval_days === '' ||
      !Number.isFinite(Number(b.quota_interval_days))
        ? null
        : Number(b.quota_interval_days),
    // 回答不要は番号割り当ても対象外。UI 表示と永続値を一致させ将来の発火経路追加時の事故も防ぐ。
    assignment_enabled: announceOnly ? 0 : b.assignment_enabled ? 1 : 0,
    // 回答不要はグループ分けも対象外（参加者が集計されないため）。
    grouping_enabled: announceOnly ? 0 : b.grouping_enabled ? 1 : 0,
    // メンション方法（ADR 0010）。不正値は 'role' に倒す。
    mention_mode: (b.mention_mode === 'none' || b.mention_mode === 'members' ? b.mention_mode : 'role') as MentionMode,
    requires_response: requiresResponse,
    // 見出し（必須・1行・最大100字）。改行は空白化。空かどうかは呼び出し側で 400 判定する。
    message_title: String(b.message_title ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 100),
    // 本文（任意・複数行・最大1500字）。空は null。
    message_body:
      b.message_body == null || String(b.message_body).trim() === ''
        ? null
        : String(b.message_body).trim().slice(0, 1500),
    active: b.active === undefined ? 1 : b.active ? 1 : 0,
    // ① 回答締切（ADR 0014）。announce-only は回答が無いので締切も無効（null）。
    //    開始の N 時間前。空/不正は null（締切なし）。0=開始時刻ちょうど。
    response_deadline_hours:
      announceOnly ||
      b.response_deadline_hours == null ||
      b.response_deadline_hours === '' ||
      !Number.isFinite(Number(b.response_deadline_hours))
        ? null
        : Math.max(0, Math.floor(Number(b.response_deadline_hours))),
    // ① 締切後変更の通知先チャンネル。空は null（投稿チャンネルにフォールバック）。
    change_alert_channel_id:
      typeof b.change_alert_channel_id === 'string' && b.change_alert_channel_id
        ? b.change_alert_channel_id
        : null,
    // ③ 送信時刻（JST 時・0〜23）。既定 21。
    send_hour: Math.min(23, Math.max(0, Math.floor(num(b.send_hour, 21)))),
  };
}

const RRULE_UNREADABLE = '繰り返し設定を読み取れません。設定し直してください。';
const ANCHOR_MISMATCH = '次回の開催日が繰り返しの設定と一致しません。';

/**
 * 繰り返し設定の検証と正規化（docs/dev/schedule-recurrence-redesign.md §5.1-5.2）。
 * - rrule: null＝不定期。文法外（UNTIL/COUNT・未知キー・BYDAY＋BYMONTHDAY 併存など）は拒否。受理した値は正規形に書き換える。
 * - anchor_date（次回の開催日）: 間隔 ≥ 2 のときだけ意味を持ち、与えられたらルールの開催日であること。
 *   間隔 1 と不定期では null に正規化する（評価で無視される値を残さない）。
 * @returns エラー文言（400 用）。OK なら null
 */
function validateRecurrence(input: NotificationInput): string | null {
  if (input.rrule === null) {
    input.anchor_date = null;
    return null;
  }
  const normalized = normalizeRule(input.rrule);
  if (!normalized) return RRULE_UNREADABLE;
  input.rrule = normalized;
  if (parseRule(normalized)!.interval === 1) {
    input.anchor_date = null;
    return null;
  }
  if (input.anchor_date && !anchorMatchesRule(normalized, input.anchor_date)) return ANCHOR_MISMATCH;
  return null;
}

/**
 * 配信の流れの検証（flow-settings-spec §3-4・2026-08-24／ADR 0032・2026-09-05）。
 * 定期: ①手動投稿は不可・順序ルール E1〜E6 違反は 400。
 * 不定期: 雛形の締切は持たない（締切は開催回ごと・正規化して NULL）。②③は自由（募集が手動なら E1/E2 は判定対象外）。
 */
function validateFlow(input: NotificationInput): string | null {
  if (input.rrule === null) {
    input.response_deadline_hours = null;
  } else if (!input.recruit_enabled) {
    return '定期のテンプレートでは「募集を投稿」を手動にできません（手動投稿は不定期でのみ選べます）。';
  }
  const issues = flowWarnings({
    requireResponse: !!input.requires_response,
    sendHour: input.send_hour,
    // 不定期は開始時刻を開催日時ごとに持つ（雛形に入力欄なし・2026-09-23）ので、当日×開始時刻の E4 は雛形では判定しない。
    // 単発も開始時刻と締切は開催回の値なので、開催回の POST とテンプレートの PUT で occurrenceFlowIssue により判定する（A5-02）
    startTime: input.rrule === null ? '23:59' : input.start_time,
    recruitDays: input.recruit_enabled ? input.recruit_days_before : null,
    remindStartDays: input.remind_unanswered_enabled ? input.remind_start_days : null,
    remindUndecidedDays: input.remind_undecided_enabled ? input.remind_undecided_days : null,
    deadlineHours: input.response_deadline_hours,
  });
  return issues.length ? `投稿の流れに保存できない設定があります: ${issues[0].head}。${issues[0].detail}` : null;
}

/**
 * 自動募集の時刻の登録ガード（登録と中止からの再開で共通）。締切が募集より前、または募集が開始以後になる
 * （当日に作って追いつきの募集が開始後になる＝何も送られない）なら理由文を返す。
 */
function recruitTimingError(eff: Notification, dateStr: string, timeStr: string, deadlineHours: number | null, now: Date): string | null {
  const recruitAt = eff.recruit_enabled ? nextRecruitAt(eff, dateStr, now) : now;
  const err = occurrenceDeadlineError({ dateStr, timeStr, deadlineHours, recruitAt });
  if (err) return err;
  // 開始済みの回の登録（記録だけ・cron は何も送らない）は通す。定期は募集を手動にできず、当日朝の臨時回や
  // 📣 前の実体化を止めてしまうので不定期・単発だけ（定期は従来どおり 📣 で手動投稿できる）
  const start = responseDeadline(dateStr, timeStr, 0);
  if (eff.rrule === null && eff.recruit_enabled && start && now.getTime() < start.getTime() && recruitAt.getTime() >= start.getTime()) {
    return `募集の投稿予定（${formatDate(recruitAt)} ${String(recruitAt.getHours()).padStart(2, '0')}:${String(recruitAt.getMinutes()).padStart(2, '0')}）が開始時刻より後になるため、募集もリマインドも送られません。送信時刻を早めるか、募集を手動にして「📣 今すぐ募集」で投稿してください。`;
  }
  return null;
}

/**
 * 開催回 1 件分の順序ルール E1〜E6（有効な流れ・開催回の開始時刻・締切で判定）。違反の文言、無ければ null。
 * 単発（type 'oneoff'）は開始時刻と締切を開催回に持つので、テンプレートの PUT と開催回の POST でこれを使う（A5-02）。
 */
function occurrenceFlowIssue(f: Notification, startTime: string, deadlineHours: number | null): string | null {
  const issues = flowWarnings({
    requireResponse: !isAnnounceOnly(f),
    sendHour: f.send_hour,
    startTime,
    recruitDays: f.recruit_enabled ? f.recruit_days_before : null,
    remindStartDays: f.remind_unanswered_enabled ? f.remind_start_days : null,
    remindUndecidedDays: f.remind_undecided_enabled ? f.remind_undecided_days : null,
    deadlineHours,
  });
  return issues.length ? `${issues[0].head}。${issues[0].detail}` : null;
}

/**
 * 指定したチャンネルがテンプレートのサーバーのものか（A3-02）。別サーバーのチャンネルがあればエラー文言。
 * Discord から一覧を取れないとき（ネットワーク・権限）は照合を省いて保存を通す: 画面のピッカーは同じ一覧から選ばせており、
 * 一時的な障害でテンプレートの保存全体を止める方が実害が大きいため。
 */
async function foreignChannelError(env: Env, guildId: string, ids: (string | null)[]): Promise<string | null> {
  const targets = ids.filter((id): id is string => !!id);
  if (!targets.length) return null;
  let known: Set<string>;
  try {
    known = new Set((await listGuildChannels(env, guildId)).map((c) => c.id));
  } catch {
    return null;
  }
  return targets.some((id) => !known.has(id)) ? 'チャンネルはテンプレートと同じサーバーのものを選んでください。' : null;
}

/**
 * 雛形の流れの変更で、締切を付けた開催回の締切が募集より前にならないか（単発・不定期・ADR 0032 の登録ガードを PUT でも）。
 * 対象は締切前で募集が未投稿の予定の回。流れを開催回側に持つ回は flowFor で雛形の変更の影響を受けないので、
 * 有効な流れが変わらない回は判定しない（変更の無い保存が締切間際の回で弾かれないように）。
 */
async function occurrenceFlowError(db: D1Database, n: Notification, input: NotificationInput): Promise<string | null> {
  if (n.rrule !== null) return null;
  const now = getJSTNow();
  const next = { ...n, ...input } as Notification;
  for (const occ of await listOccurrencesForNotification(db, n.id, 200)) {
    if (occ.status !== 'scheduled' || occ.response_deadline_hours == null) continue;
    const time = occ.start_time || n.start_time;
    const dl = responseDeadline(occ.occurrence_date, time, occ.response_deadline_hours);
    if (!dl || dl.getTime() <= now.getTime()) continue;
    const before = flowFor(n, occ);
    const after = flowFor(next, occ);
    if (before.recruit_enabled === after.recruit_enabled && before.recruit_days_before === after.recruit_days_before && before.send_hour === after.send_hour) continue;
    if (await hasSentKind(db, n.id, occ.id, 'recruit')) continue;
    if (!after.recruit_enabled) {
      return `${occ.occurrence_date} の出欠確認に回答締切を登録済みのため、募集を手動投稿にはできません（締切は自動募集が前提）。変えるときはその回を中止してください。`;
    }
    const err = occurrenceDeadlineError({ dateStr: occ.occurrence_date, timeStr: time, deadlineHours: occ.response_deadline_hours, recruitAt: nextRecruitAt(after, occ.occurrence_date, now) });
    if (err) return `${occ.occurrence_date} の出欠確認の${err}`;
  }
  return null;
}

/** 「ルールが変わったか」の比較キー（正規形 rrule・有効な anchor・start_time）。既存行の古い anchor の差は無視する。 */
function recurrenceKey(x: RecurrenceSpec): string {
  const rrule = normalizeRule(x.rrule);
  const model = rrule ? parseRule(rrule) : null;
  return JSON.stringify([rrule, model && model.interval >= 2 ? x.anchor_date ?? null : null, x.start_time]);
}

/**
 * 管理 API（/api/admin/*）。すべて ADMIN_TOKEN による Bearer 認証必須。すべて JSON。
 * - GET        /setup/status                  (シークレット有無・Interaction URL)
 * - POST       /setup/register-commands       ({guild_id?} スラッシュコマンド登録)
 * - GET        /guilds, /guilds/:id/channels, /guilds/:id/members, /guilds/:id/roles  (Discord 由来・読み取り専用。channels は enabled 付き)
 * - PUT        /guilds/:id/channel-filter     ({enabled: string[] | null} 投稿先の選択肢に出すチャンネル・null=全部)
 * - POST       /guilds/:id/leave              (通知を全無効化してから bot を退出＝管理対象から外す)
 * - GET/POST   /segments[?guild_id=],         PUT/DELETE /segments/:id
 * - GET        /segments/:id/members,         POST /segments/:id/members ({user_id,display_name?,user_name?})
 * - PUT/DELETE /segments/:id/members/:userId  ({status} for PUT)
 * - GET/POST   /members,                      DELETE /members/:userId
 * - GET/POST   /notifications[?guild_id=],    GET/PUT/DELETE /notifications/:id
 *              （rrule は文法検証＋正規化・null=不定期。PUT はルール変更時に未投稿のルール回を掃除し {ok,pruned,kept_posted}）
 * - POST       /notifications/preview-plan    ({rrule,anchor_date?,start_time,count?} → {dates,anchor_candidates,error?}・DB 非依存)
 * - GET        /notifications/:id/occurrences
 * - POST       /notifications/:id/occurrences ({date,start_time?,status?,note?,origin?} 日付指定で実体化・中止墓石/臨時回)
 * - GET        /notifications/:id/plan        (未実体化の未来開催日を RRULE から導出)
 * - PUT        /occurrences/:id               ({status|date})
 * - POST       /occurrences/:id/recruit       (単一開催回の即時募集・send_log 記録つき)
 * - GET        /occurrences/:id/responses,    GET /occurrences/:id/status (集計バケット)
 * - GET        /responses?limit=
 * - GET        /reports/attendance?segment_uuid=[&notification_uuid=&from=&to=]  (出勤レポート)
 * - GET        /send-log[?notification_id=&limit=]   (リマインド送信履歴・④可視化)
 * - GET/PUT    /config                                (送信予算など実行時設定・⑦)
 * - GET        /send-estimate[?guild_id=]             (推奨上限の推定・⑦)
 */
export async function handleAdmin(request: Request, env: Env): Promise<Response> {
  if (!authorized(request, env)) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/admin/, '') || '/';
  const method = request.method;
  const db = env.DB;

  try {
    if (path === '/planning' || path.startsWith('/planning/')) return handlePlanningAdmin(request, env, path);
    const planOcc = path.match(/^\/occurrences\/([^/]+)(?:\/(recruit))?$/);
    if (planOcc && method !== 'GET') {
      const target = await getOccurrenceByUuid(db, planOcc[1]);
      if (target && await plannedOccurrence(db, target.id)) return json({error:'開催計画の名簿・開催枠から変更してください'},409);
    }

    // ============ setup ウィザード ============
    if (path === '/setup/status' && method === 'GET') {
      return json(getSetupStatus(env, request));
    }
    if (path === '/setup/register-commands' && method === 'POST') {
      let guildId: string | null = null;
      try {
        const b = (await request.json()) as { guild_id?: string };
        guildId = b.guild_id || null;
      } catch {
        // ボディ無しは全体（グローバル）登録
      }
      try {
        const r = await registerCommandsForEnv(env, guildId);
        return json({ ok: true, ...r });
      } catch (e) {
        return json({ ok: false, error: (e as Error).message }, 400);
      }
    }

    // ============ guilds（Discord API 由来・読み取り専用）============
    if (path === '/guilds' && method === 'GET') {
      return json(await listGuilds(env));
    }
    const guildChannels = path.match(/^\/guilds\/(\d+)\/channels$/);
    if (guildChannels && method === 'GET') {
      return json(await withEnabled(db, guildChannels[1], await listGuildChannels(env, guildChannels[1])));
    }
    const channelFilter = path.match(/^\/guilds\/(\d+)\/channel-filter$/);
    if (channelFilter && method === 'PUT') {
      let enabled;
      try {
        enabled = parseChannelFilter(((await request.json()) as { enabled?: unknown }).enabled);
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : '設定が不正です' }, 400);
      }
      await setConfig(db, channelFilterKey(channelFilter[1]), JSON.stringify(enabled));
      return json({ enabled });
    }
    const guildMembers = path.match(/^\/guilds\/(\d+)\/members$/);
    if (guildMembers && method === 'GET') {
      return json(await listGuildMembers(env, guildMembers[1]));
    }
    const guildRoles = path.match(/^\/guilds\/(\d+)\/roles$/);
    if (guildRoles && method === 'GET') {
      return json(await listGuildRoles(env, guildRoles[1]));
    }
    const failureSettings = path.match(/^\/guilds\/(\d+)\/failure-notification$/);
    if (failureSettings) {
      const guildId = failureSettings[1];
      if (method === 'GET') return json(await getFailureNotificationSettings(db, guildId));
      if (method === 'PUT') {
        let settings;
        try {
          settings = parseFailureNotificationSettings(await request.json());
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : '設定が不正です' }, 400);
        }
        if (settings.channel_id && !(await listGuildChannels(env, guildId)).some((c) => c.id === settings.channel_id))
          return json({ error: '同じサーバーのテキストチャンネルを選択してください' }, 400);
        if (settings.mention_mode !== 'none') {
          const ids = settings.mention_mode === 'roles'
            ? (await listGuildRoles(env, guildId)).map((r) => r.id).filter((id) => id !== guildId)
            : (await listGuildMembers(env, guildId)).map((m) => m.user_id);
          if (settings.mention_ids.some((id) => !ids.includes(id)))
            return json({ error: '同じサーバーのユーザーまたはロールを選び直してください' }, 400);
        }
        await setConfig(db, failureNotificationKey(guildId), JSON.stringify(settings));
        return json(settings);
      }
    }
    // サーバーからの退出（＝管理対象から外す）。先に通知を無効化してから退出することで、
    // 退出後に cron が居ないサーバーへ送信を試みて Discord API エラーを出し続けるのを防ぐ。
    // データは論理削除（active=0）のみで保持し、再招待時はそのまま復元できる。
    const guildLeave = path.match(/^\/guilds\/(\d+)\/leave$/);
    if (guildLeave && method === 'POST') {
      const guildId = guildLeave[1];
      const deactivated = await deactivateNotificationsForGuild(db, guildId);
      await db.batch([
        db.prepare('UPDATE planning_cycles SET enabled=0 WHERE guild_id=?').bind(guildId),
        db.prepare("UPDATE planning_deliveries SET status='cancelled' WHERE status='pending' AND plan_id IN (SELECT id FROM planning_plans WHERE guild_id=?)").bind(guildId),
        db.prepare("UPDATE planning_plans SET data=json_set(CASE WHEN json_type(data,'$.answerReminder') IS NULL THEN data ELSE json_set(data,'$.answerReminder.enabled',json('false')) END,'$.remindDays',0,'$.eventReminderHours',0,'$.autoAudience',json('false')),version=version+1 WHERE guild_id=?").bind(guildId),
      ]);
      try {
        await leaveGuild(env, guildId);
      } catch (e) {
        // 無効化は済んでいるので、退出失敗は 502 で明示して手動キックを促す。
        return json({ ok: false, deactivated, error: (e as Error).message }, 502);
      }
      return json({ ok: true, deactivated });
    }

    // ============ segments ============
    if (path === '/segments') {
      if (method === 'GET') {
        const guildId = url.searchParams.get('guild_id') ?? undefined;
        return json(await listSegments(db, guildId));
      }
      if (method === 'POST') {
        const b = (await request.json()) as { guild_id?: string; name?: string; mention_role_id?: string | null };
        if (!b.guild_id) return json({ error: 'guild_id required' }, 400);
        if (!b.name) return json({ error: 'name required' }, 400);
        const roleId = normalizeMentionRoleId(b.mention_role_id, b.guild_id);
        if (roleId === undefined) {
          return json({ error: "ロール指定は '@everyone' またはロールID（数字）です。" }, 400);
        }
        return json(
          await createSegment(db, { guild_id: b.guild_id, name: b.name, mention_role_id: roleId }),
          201,
        );
      }
    }
    // /segments/:uuid/members/:userId
    const segMemberItem = path.match(new RegExp(`^/segments/(${UUID_RE})/members/(.+)$`));
    if (segMemberItem) {
      const seg = await getSegmentByUuid(db, segMemberItem[1]);
      if (!seg) return json({ error: 'Not found' }, 404);
      const userId = decodeURIComponent(segMemberItem[2]);
      if (method === 'PUT') {
        const b = (await request.json()) as { status?: string };
        if (b.status === undefined) return json({ error: 'status required' }, 400);
        // status は '' / '休止中' の2値固定。不正値は集計母集団からの静かな脱落を招くため弾く。
        if (b.status !== '' && b.status !== '休止中') {
          return json({ error: "status must be '' or '休止中'" }, 400);
        }
        const ok = await setSegmentMemberStatus(db, seg.id, userId, b.status);
        return json({ ok }, ok ? 200 : 404);
      }
      if (method === 'DELETE') {
        const ok = await removeSegmentMember(db, seg.id, userId);
        return json({ ok }, ok ? 200 : 404);
      }
    }
    // /segments/:uuid/members
    const segMembers = path.match(new RegExp(`^/segments/(${UUID_RE})/members$`));
    if (segMembers) {
      const seg = await getSegmentByUuid(db, segMembers[1]);
      if (!seg) return json({ error: 'Not found' }, 404);
      if (method === 'GET') return json(await listSegmentMembers(db, seg.id));
      if (method === 'POST') {
        const b = (await request.json()) as {
          user_id?: string;
          user_name?: string | null;
          display_name?: string | null;
        };
        if (!b.user_id) return json({ error: 'user_id required' }, 400);
        await addSegmentMember(db, seg, b.user_id, {
          user_name: b.user_name ?? null,
          display_name: b.display_name ?? null,
        });
        return json({ ok: true }, 201);
      }
    }
    // /segments/:uuid/sync-from-role （ロール管理区分を Discord ロールから手動同期・ADR 0009）
    const segSync = path.match(new RegExp(`^/segments/(${UUID_RE})/sync-from-role$`));
    if (segSync && method === 'POST') {
      const seg = await getSegmentByUuid(db, segSync[1]);
      if (!seg) return json({ error: 'Not found' }, 404);
      if (!seg.mention_role_id) {
        return json({ error: 'この区分はロール管理ではありません（ロール未設定）。' }, 400);
      }
      // 手動同期は確認ダイアログ経由のため allowEmpty=true（明示的に空にできる）。
      const r = await syncSegmentFromRole(env, seg, { allowEmpty: true });
      return json(r, r.ok ? 200 : 400);
    }
    // /segments/:uuid
    const segId = path.match(new RegExp(`^/segments/(${UUID_RE})$`));
    if (segId) {
      const seg = await getSegmentByUuid(db, segId[1]);
      if (!seg) return json({ error: 'Not found' }, 404);
      if (method === 'PUT') {
        const b = (await request.json()) as { name?: string; mention_role_id?: string | null };
        if (!b.name) return json({ error: 'name required' }, 400);
        const roleId = normalizeMentionRoleId(b.mention_role_id, seg.guild_id);
        if (roleId === undefined) {
          return json({ error: "ロール指定は '@everyone' またはロールID（数字）です。" }, 400);
        }
        const ok = await updateSegment(db, seg.id, {
          name: b.name,
          mention_role_id: roleId,
        });
        return json({ ok }, ok ? 200 : 404);
      }
      if (method === 'DELETE') {
        // 対象 Notification がある場合は削除させない（409）
        const count = await countNotificationsForSegment(db, seg.id);
        if (count > 0) {
          return json({ error: 'segment has notifications', count }, 409);
        }
        const planningUse = await db.prepare(`
          SELECT 1 FROM planning_cycles c,json_each(c.data,'$.segments') s
          WHERE json_extract(c.data,'$.standalone')=1 AND s.value=?
          UNION ALL
          SELECT 1 FROM planning_plans p,json_each(p.data,'$.segments') s
          WHERE json_extract(p.data,'$.standalone')=1
            AND json_extract(p.data,'$.state') IN ('draft','open') AND s.value=? LIMIT 1`)
          .bind(seg.id, seg.id).first();
        if (planningUse) return json({ error: '日程調整設定または進行中の日程調整で使用中の区分です。' }, 409);
        const ok = await deleteSegment(db, seg.id);
        return json({ ok }, ok ? 200 : 404);
      }
    }

    // ============ members ============
    if (path === '/members') {
      if (method === 'GET') return json(await getAllMembers(db));
      if (method === 'POST') {
        const m = (await request.json()) as {
          user_id?: string;
          user_name?: string | null;
          display_name?: string | null;
        };
        if (!m.user_id) return json({ error: 'user_id required' }, 400);
        await upsertMember(db, {
          user_id: m.user_id,
          user_name: m.user_name ?? null,
          display_name: m.display_name ?? null,
        });
        return json({ ok: true });
      }
    }
    const memberDelete = path.match(/^\/members\/(.+)$/);
    if (memberDelete && method === 'DELETE') {
      const ok = await deleteMember(db, decodeURIComponent(memberDelete[1]));
      return json({ ok }, ok ? 200 : 404);
    }

    // ============ notifications ============
    // body 内の segment_uuid → segment_id 解決（ADR 0016）。区分はテンプレートと同じサーバーのものに限る
    async function resolveSegmentUuid(body: Record<string, unknown>): Promise<string | null> {
      if (typeof body.segment_uuid !== 'string' || !body.segment_uuid) {
        return 'segment_uuid required';
      }
      const seg = await getSegmentByUuid(db, body.segment_uuid);
      if (!seg) return 'segment not found';
      if (seg.guild_id !== body.guild_id) return 'メンバー区分はテンプレートと同じサーバーのものを選んでください。';
      body.segment_id = seg.id;
      return null;
    }
    if (path === '/notifications') {
      if (method === 'GET') {
        const guildId = url.searchParams.get('guild_id');
        return json(guildId ? await listNotificationsByGuild(db, guildId) : await listNotifications(db));
      }
      if (method === 'POST') {
        const body = (await request.json()) as Record<string, unknown>;
        const err = await resolveSegmentUuid(body);
        if (err) return json({ error: err }, 400);
        const input = toNotificationInput(body);
        if (!input) return json({ error: 'Invalid body' }, 400);
        if (!input.message_title) return json({ error: '見出しは必須です。' }, 400);
        const qerr = quotaMessageError(body.quota_message);
        if (qerr) return json({ error: qerr }, 400);
        const rerr = validateRecurrence(input);
        if (rerr) return json({ error: rerr }, 400);
        const ferr = validateFlow(input);
        if (ferr) return json({ error: ferr }, 400);
        const cerr = await foreignChannelError(env, input.guild_id, [input.channel_id, input.change_alert_channel_id]);
        if (cerr) return json({ error: cerr }, 400);
        const created = await createNotification(db, input);
        // 次ティックの日次ロールフォワードで窓内のルール回を即時実体化させる（rrule 実体化は 1 日 1 回集約）。
        await setConfig(db, OCC_ROLLFORWARD_KEY, '');
        return json(created, 201);
      }
    }
    // 繰り返しプレビュー（DB 非依存）: フォームの「次の開催日」と「次回の開催日」候補を cron と同じ関数で計算する。
    if (path === '/notifications/preview-plan' && method === 'POST') {
      const b = (await request.json()) as { rrule?: unknown; anchor_date?: unknown; start_time?: unknown; count?: unknown };
      const rrule = typeof b.rrule === 'string' ? normalizeRule(b.rrule) : null;
      if (!rrule) return json({ dates: [], anchor_candidates: [], error: RRULE_UNREADABLE });
      const start_time = typeof b.start_time === 'string' && b.start_time ? b.start_time : '21:00';
      const anchor_date = typeof b.anchor_date === 'string' && b.anchor_date ? b.anchor_date : null;
      const count = Math.min(50, parseLimit(b.count == null ? null : String(b.count), 8));
      const model = parseRule(rrule)!;
      let anchor_candidates: string[] = [];
      if (model.interval >= 2) {
        // 候補＝位相を決める前の「ルールに当たる直近の日」。間隔 1 で評価し interval ×（1 周期あたりの回数）件。
        // ponytail: 第5週の無い月などで厳密な interval 周期ぶんより少し多く出ることがある（候補が増えるだけ）。
        const perCycle = Math.max(1, model.byday.length + model.bymonthday.length);
        const every: RecurrenceSpec = { rrule: formatRule({ ...model, interval: 1 }), anchor_date: null, start_time };
        anchor_candidates = nextOccurrenceDates(every, model.interval * perCycle);
        if (anchor_date && !anchorMatchesRule(rrule, anchor_date)) {
          return json({ dates: [], anchor_candidates, error: ANCHOR_MISMATCH });
        }
      }
      const spec: RecurrenceSpec = { rrule, anchor_date: model.interval >= 2 ? anchor_date : null, start_time };
      return json({ dates: nextOccurrenceDates(spec, count), anchor_candidates });
    }
    // /notifications/:uuid/occurrences
    const notifOccs = path.match(new RegExp(`^/notifications/(${UUID_RE})/occurrences$`));
    if (notifOccs && method === 'GET') {
      const n = await getNotificationByUuid(db, notifOccs[1]);
      if (!n) return json({ error: 'Not found' }, 404);
      const limit = parseLimit(url.searchParams.get('limit'), 100);
      return json(await listOccurrencesForNotification(db, n.id, limit));
    }
    // 開催回を日付指定で実体化する（配信予定の「配信しない」＝ cancelled で作成、臨時回=scheduled）。
    // UNIQUE(notification_id, date, start_time) 上の upsert なので二重作成しない。
    if (notifOccs && method === 'POST') {
      const n = await getNotificationByUuid(db, notifOccs[1]);
      if (!n) return json({ error: 'Not found' }, 404);
      const b = (await request.json()) as {
        date?: string;
        start_time?: string;
        status?: string;
        note?: string;
        origin?: string;
        response_deadline_hours?: number | string | null;
        duration_minutes?: number | string | null;
      } & Partial<Record<(typeof OCCURRENCE_FLOW_KEYS)[number], unknown>>;
      if (!isRealDate(b.date)) {
        return json({ error: 'date (YYYY/MM/DD) required' }, 400);
      }
      const status = b.status ?? 'scheduled';
      if (status !== 'scheduled' && status !== 'cancelled') {
        return json({ error: 'invalid status' }, 400);
      }
      const time = typeof b.start_time === 'string' ? b.start_time : n.start_time;
      // 不定期・単発の開催回は開始時刻が必須（テンプレートに開始時刻の欄が無い）
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time) && (n.rrule === null || time !== '')) {
        return json({ error: '開始時刻（HH:MM）を確認してください。' }, 400);
      }
      // 単発出欠確認の開催回は 1 件だけ（中止した回を含む）。同じ日時の登録し直しは既存行を使うので通す
      if (n.type === 'oneoff' && await db.prepare('SELECT 1 FROM occurrences WHERE notification_id=? AND NOT (occurrence_date=? AND start_time=?) LIMIT 1').bind(n.id, b.date, time).first()) {
        return json({ error: '単発出欠確認の開催日時は 1 件だけです。別の日時にするときは新しく作ってください。' }, 409);
      }
      // 送信時刻と投稿の流れ（単発だけ・migration 0036）。送られてきた項目で雛形の値を上書きし、その全体を開催回に保存する。
      // 定期の臨時回は雛形に従う（項目は無視）。
      let flow: OccurrenceFlow | null = null;
      // 単発はテンプレートの値に従う（開催回には持たない・A5-02）
      if (n.rrule === null && n.type !== 'oneoff' && OCCURRENCE_FLOW_KEYS.some((k) => b[k] !== undefined)) {
        const days = (v: unknown, d: number) => (v == null || v === '' || !Number.isFinite(Number(v)) ? d : Math.max(0, Math.floor(Number(v))));
        flow = {
          send_hour: Math.min(23, Math.max(0, days(b.send_hour, n.send_hour))),
          recruit_enabled: flag(b.recruit_enabled, n.recruit_enabled ? 1 : 0),
          recruit_days_before: days(b.recruit_days_before, n.recruit_days_before),
          remind_unanswered_enabled: flag(b.remind_unanswered_enabled, n.remind_unanswered_enabled ? 1 : 0),
          remind_start_days: days(b.remind_start_days, n.remind_start_days),
          remind_undecided_enabled: flag(b.remind_undecided_enabled, n.remind_undecided_enabled ? 1 : 0),
          remind_undecided_days: days(b.remind_undecided_days, n.remind_undecided_days),
          remind_target: b.remind_target === 'channel' ? 'channel' : b.remind_target === 'dm' ? 'dm' : n.remind_target,
          remind_undecided_target: b.remind_undecided_target === 'channel' ? 'channel' : b.remind_undecided_target === 'dm' ? 'dm' : n.remind_undecided_target,
        };
      }
      // 以降の募集・締切の判定は開催回の値で上書きした雛形で行う
      const eff = flow ? { ...n, ...flow } : n;
      const linked = await db.prepare('SELECT o.id FROM occurrences o JOIN planning_occurrences p ON p.occurrence_id=o.id WHERE o.notification_id=? AND o.occurrence_date=? AND o.start_time=?').bind(n.id,b.date,time).first();
      if(linked)return json({error:'開催計画から変更してください'},409);
      // 開催回の回答締切（ADR 0032）: 不定期×自動募集×出欠ありの開催回だけ登録時に付けられる。
      // 手動募集は 📣 の投稿時に選ぶ（登録時は持てない）。定期は雛形の締切に従う。
      const dlRaw = b.response_deadline_hours;
      const occDeadline = dlRaw == null || dlRaw === '' ? null : Math.max(0, Math.floor(Number(dlRaw)));
      if (occDeadline != null && !Number.isFinite(occDeadline)) return json({ error: '回答締切の時間が不正です。' }, 400);
      if (occDeadline != null) {
        if (n.rrule !== null) return json({ error: '定期のテンプレートの回答締切は、「定期出欠確認」の「テンプレート作成・編集」で設定した締切に従います。' }, 400);
        if (isAnnounceOnly(n)) return json({ error: '出欠確認なし（告知）の予定に回答締切は付けられません。' }, 400);
        if (!eff.recruit_enabled) return json({ error: '募集が手動投稿のテンプレートでは、回答締切は「📣 今すぐ募集」で投稿するときに選びます。' }, 400);
      }
      // 開催回の投稿の流れの順序ルール（E1〜E6）。雛形の validateFlow と同じ基準で、こちらは開始時刻も開催回の値で判定する。
      // 単発は流れの項目を送らない（テンプレートに従う）ので、項目が無くてもテンプレートの流れで判定する（A5-02）
      if (flow || n.type === 'oneoff') {
        const issue = occurrenceFlowIssue(eff, time, occDeadline);
        if (issue) return json({ error: `投稿の流れに登録できない設定があります: ${issue}` }, 400);
      }
      // 順序ルールの後に判定する（具体的な理由を先に出す）。登録ガード（不定期の開催回締切・定期の臨時回は雛形の締切）: 締切が「次に募集が投稿される時刻」より前なら保存不可。
      // 定期の臨時回にも同じガード（Q4・2026-09-05 裁定）。
      if (status === 'scheduled') {
        const err = recruitTimingError(eff, b.date, time, n.rrule === null ? occDeadline : n.response_deadline_hours, getJSTNow());
        if (err) return json({ error: err }, 400);
      }
      // 補足メッセージ（任意）。空白のみは「なし」に正規化し、message_body と同様に上限を切る。
      const note = typeof b.note === 'string' && b.note.trim() ? b.note.trim().slice(0, 500) : null;
      // origin: 'rule'=配信予定（RRULE 導出の仮想行）の実体化 / 'manual'（既定）=臨時回・不定期の開催回。
      // ルール変更時に自動削除されるのは rule の未投稿行だけ（§5.3）。
      // 不定期・単発に rule 行は無い（ルール変更で消されないように）
      const origin: OccurrenceOrigin = b.origin === 'rule' && n.rrule !== null ? 'rule' : 'manual';
      const before = await db.prepare('SELECT 1 FROM occurrences WHERE notification_id=? AND occurrence_date=? AND start_time=?').bind(n.id, b.date, time).first();
      let occ = await getOrCreateOccurrence(db, n.id, b.date, time, origin);
      let fresh = !before;
      // 中止した回の登録し直しは、新しく作った回と同じまっさらな状態から始める（回答・締切・投稿の記録を引き継がない・ADR 0032）
      if (occ.status === 'cancelled' && status === 'scheduled') {
        await resetCancelledOccurrence(db, occ.id);
        occ = (await getOccurrence(db, occ.id))!;
        fresh = true;
      }
      // 既存行（同日同時刻の再登録）の締切は変えない（締切を付けた開催回は変更不可・中止→再登録が正規の手順）。
      // 状態・補足を書く前に判定する（400 を返すのに中止回が scheduled に戻る事故防止・2026-09-24 レビュー #2）
      if (occDeadline != null && occ.response_deadline_hours != null && occ.response_deadline_hours !== occDeadline) {
        return json({ error: 'この出欠確認には既に回答締切が設定されています。変更するには中止して登録し直してください。' }, 400);
      }
      // 締切の無い既存の回へ後から締切を付けない（投稿済みの募集に締切が載らない・ADR 0032 決定 4）。単発は作成後は変えない
      if (occDeadline != null && occ.response_deadline_hours == null && !fresh &&
        (n.type === 'oneoff' || (await hasSentKind(db, n.id, occ.id, 'recruit')))) {
        return json({ error: '回答締切は後から付けられません。付けるときは中止して登録し直してください。' }, 400);
      }
      if (occ.status !== status) await setOccurrenceStatus(db, occ.id, status);
      if (note !== null) await setOccurrenceNote(db, occ.id, note);
      // 開催時間（分・任意）。空欄・0 以下は「指定なし」＝既存行の値を変えない（新規は NULL＝雛形に従う）。
      const duration = b.duration_minutes == null || b.duration_minutes === '' || !(Number(b.duration_minutes) > 0) ? null : Math.floor(Number(b.duration_minutes));
      if (duration !== null && n.type !== 'oneoff' && occ.duration_minutes !== duration) await setOccurrenceDuration(db, occ.id, duration);
      if (flow) await setOccurrenceFlow(db, occ.id, flow);
      if (occDeadline != null && occ.response_deadline_hours == null) await setOccurrenceDeadline(db, occ.id, occDeadline);
      return json({ ...occ, ...(flow ?? {}), status, note: note ?? occ.note, response_deadline_hours: occ.response_deadline_hours ?? occDeadline, duration_minutes: duration ?? occ.duration_minutes }, 201);
    }
    // 配信予定（未実体化の未来開催日）。RRULE から導出し、既に開催回が実体化済みの日付は除く。
    const notifPlan = path.match(new RegExp(`^/notifications/(${UUID_RE})/plan$`));
    if (notifPlan && method === 'GET') {
      const n = await getNotificationByUuid(db, notifPlan[1]);
      if (!n) return json({ error: 'Not found' }, 404);
      const count = parseLimit(url.searchParams.get('count'), 8);
      const dates = nextOccurrenceDates(n, count);
      const existing = await listOccurrencesForNotification(db, n.id, 200);
      const taken = new Set(existing.map((o) => o.occurrence_date));
      return json(
        dates.filter((d) => !taken.has(d)).map((d) => ({ occurrence_date: d, start_time: n.start_time })),
      );
    }
    // /notifications/:uuid/active  POST { active: boolean }
    // 設定一覧の「有効」スイッチ（C03・2026-09-20）。他の項目には触れず active だけを切り替える。
    const notifActive = path.match(new RegExp(`^/notifications/(${UUID_RE})/active$`));
    if (notifActive && method === 'POST') {
      const n = await getNotificationByUuid(db, notifActive[1]);
      if (!n) return json({ error: 'Not found' }, 404);
      const body = (await request.json()) as { active?: unknown };
      if (typeof body.active !== 'boolean') return json({ error: 'Invalid body' }, 400);
      await db.prepare('UPDATE notifications SET active=? WHERE id=?').bind(body.active ? 1 : 0, n.id).run();
      await setConfig(db, OCC_ROLLFORWARD_KEY, '');
      return json({ ok: true, active: body.active ? 1 : 0 });
    }

    // /notifications/:uuid
    const notifId = path.match(new RegExp(`^/notifications/(${UUID_RE})$`));
    if (notifId) {
      const n = await getNotificationByUuid(db, notifId[1]);
      if (!n) return json({ error: 'Not found' }, 404);
      if (method === 'GET') {
        return json(n);
      }
      if (method === 'PUT') {
        const body = (await request.json()) as Record<string, unknown>;
        // サーバーは作成時に固定（入力は無視）
        body.guild_id = n.guild_id;
        const err = await resolveSegmentUuid(body);
        if (err) return json({ error: err }, 400);
        const input = toNotificationInput(body);
        if (!input) return json({ error: 'Invalid body' }, 400);
        // 種別（単発・不定期・定期）は作成時に固定
        input.type = n.type;
        if (n.type === 'oneoff') input.rrule = null;
        if ((n.rrule === null) !== (input.rrule === null)) {
          return json({ error: '定期と不定期は作成後に切り替えられません。新しいテンプレートを作ってください。' }, 400);
        }
        if (!input.message_title) return json({ error: '見出しは必須です。' }, 400);
        const qerr = quotaMessageError(body.quota_message);
        if (qerr) return json({ error: qerr }, 400);
        const rerr = validateRecurrence(input);
        if (rerr) return json({ error: rerr }, 400);
        const ferr = validateFlow(input);
        if (ferr) return json({ error: ferr }, 400);
        const oerr = await occurrenceFlowError(db, n, input);
        if (oerr) return json({ error: oerr }, 400);
        if (n.type === 'oneoff') {
          const next = { ...n, ...input } as Notification;
          for (const occ of await listOccurrencesForNotification(db, n.id, 10)) {
            if (occ.status !== 'scheduled') continue;
            const f = flowFor(next, occ);
            // 手動募集の締切は 📣 の投稿時に決まるので判定に含めない（画面の判定と同じ）
            const issue = occurrenceFlowIssue(f, occ.start_time || next.start_time, f.recruit_enabled ? deadlineHoursFor(next, occ) : null);
            if (issue) return json({ error: `投稿の流れに保存できない設定があります: ${issue}` }, 400);
          }
        }
        // 変えたチャンネルだけ照合する（保存済みの値は作成時に照合済み。Discord 側で消えたチャンネルでも他の項目の保存は止めない）
        const cerr = await foreignChannelError(env, n.guild_id, [
          input.channel_id === n.channel_id ? null : input.channel_id,
          input.change_alert_channel_id === n.change_alert_channel_id ? null : input.change_alert_channel_id,
        ]);
        if (cerr) return json({ error: cerr }, 400);
        const ruleChanged = recurrenceKey(n) !== recurrenceKey(input);
        const ok = await updateNotification(db, n.id, input);
        if (!ok) return json({ ok }, 404);
        // ルール（rrule/anchor/start_time）が変わったら、何も起きていないルール回を掃除して
        // 次ティックに新ルールで実体化し直させる（投稿済み・回答あり・manual・墓石は保持＝§5.3）。
        const { pruned, kept_posted } = ruleChanged
          ? await pruneRuleOccurrences(db, n.id, formatDate(getJSTNow()))
          : { pruned: 0, kept_posted: 0 };
        await setConfig(db, OCC_ROLLFORWARD_KEY, '');
        return json({ ok, pruned, kept_posted });
      }
      if (method === 'DELETE') {
        if (await isNotificationInPlanning(db, n.id)) {
          return json({ error: '日程調整で使用中のテンプレートは削除できません。無効化してください。' }, 409);
        }
        const ok = await deleteNotification(db, n.id);
        return json({ ok }, ok ? 200 : 404);
      }
    }

    // ============ occurrences ============
    // /occurrences/:uuid/responses
    const occResponses = path.match(new RegExp(`^/occurrences/(${UUID_RE})/responses$`));
    if (occResponses && method === 'GET') {
      const occ = await getOccurrenceByUuid(db, occResponses[1]);
      if (!occ) return json({ error: 'Not found' }, 404);
      return json(await getResponsesForOccurrence(db, occ.id));
    }
    // /occurrences/:uuid/status
    const occStatus = path.match(new RegExp(`^/occurrences/(${UUID_RE})/status$`));
    if (occStatus && method === 'GET') {
      const occ = await getOccurrenceByUuid(db, occStatus[1]);
      if (!occ) return json({ error: 'Not found' }, 404);
      const n = await getNotification(db, occ.notification_id);
      if (!n) return json({ error: 'Not found' }, 404);
      // recruited: この開催回の募集/告知を投稿済みか（「開催回」タブの「募集済み/告知済み」表示用・M6）
      const buckets = await getStatusBuckets(db, occ.id, n.segment_id);
      return json({ ...buckets, recruited: await hasSentKind(db, n.id, occ.id, 'recruit') });
    }
    // /occurrences/:uuid/recruit （単一開催回の即時募集/告知＝管理画面「今すぐ募集」）
    // 実体は recruitOccurrenceNow（send_log 記録つき）。already_sent は 409 で返し、UI が force 再送を確認する。
    const occRecruit = path.match(new RegExp(`^/occurrences/(${UUID_RE})/recruit$`));
    if (occRecruit && method === 'POST') {
      const occ = await getOccurrenceByUuid(db, occRecruit[1]);
      if (!occ) return json({ error: 'Not found' }, 404);
      if (occ.status !== 'scheduled') return json({ error: '中止された予定の募集・告知は投稿できません。' }, 400);
      const n = await getNotification(db, occ.notification_id);
      if (!n) return json({ error: 'Not found' }, 404);
      // body は任意（{force?: true, response_deadline_hours?: number|null}）。force=送信済みでも再送する（UI の確認ダイアログ了承後のみ）。
      // response_deadline_hours: 不定期×手動募集×出欠ありで、投稿の瞬間に締切を選ぶ（ADR 0032）。設定済み・投稿済みなら変更不可。
      const b = (await request.json().catch(() => ({}))) as { force?: boolean; response_deadline_hours?: number | string | null };
      const now = getJSTNow();
      if (b.response_deadline_hours !== undefined) {
        const hours = b.response_deadline_hours == null || b.response_deadline_hours === '' ? null : Math.max(0, Math.floor(Number(b.response_deadline_hours)));
        if (hours != null && !Number.isFinite(hours)) return json({ error: '回答締切の時間が不正です。' }, 400);
        if (hours != null) {
          if (n.rrule !== null || flowFor(n, occ).recruit_enabled || isAnnounceOnly(n)) {
            return json({ error: '投稿時に回答締切を選べるのは、不定期で募集が手動投稿のテンプレートだけです。' }, 400);
          }
          if (occ.response_deadline_hours != null || (await hasSentKind(db, n.id, occ.id, 'recruit'))) {
            return json({ error: 'この出欠確認は投稿済み（または締切設定済み）のため、回答締切は変更できません。' }, 400);
          }
          const err = occurrenceDeadlineError({ dateStr: occ.occurrence_date, timeStr: occ.start_time || n.start_time, deadlineHours: hours, recruitAt: now, posting: true });
          if (err) return json({ error: err }, 400);
          await setOccurrenceDeadline(db, occ.id, hours);
          occ.response_deadline_hours = hours;
        }
      }
      // 締切を過ぎた回は投稿しない（cron の共通ルール 2 と同じ。中止→再登録が正規の手順）
      const dlNow = responseDeadline(occ.occurrence_date, occ.start_time || n.start_time, deadlineHoursFor(n, occ));
      if (dlNow && now.getTime() >= dlNow.getTime()) {
        return json({ error: '回答締切をすでに過ぎているため投稿できません。この回を中止して登録し直してください。' }, 400);
      }
      const r = await recruitOccurrenceNow(env, n, occ, { force: b.force === true });
      if (r === 'already_sent') return json({ error: 'この日時の募集・告知は既に投稿済み（または投稿中）です。' }, 409);
      return json({ ok: r === 'sent' }, r === 'sent' ? 200 : 400);
    }
    // /occurrences/:uuid ({status|date})
    const occId = path.match(new RegExp(`^/occurrences/(${UUID_RE})$`));
    if (occId && method === 'PUT') {
      const occ = await getOccurrenceByUuid(db, occId[1]);
      if (!occ) return json({ error: 'Not found' }, 404);
      const b = (await request.json()) as { status?: string; date?: string };
      if (b.status !== undefined) {
        if (b.status !== 'scheduled' && b.status !== 'cancelled') {
          return json({ error: 'invalid status' }, 400);
        }
        // 中止からの再開: 中止中は流れの変更ガードが飛ばすので、登録と同じ判定をし直す（募集を投稿済みなら不要）
        if (b.status === 'scheduled' && occ.status === 'cancelled') {
          const n = await getNotification(db, occ.notification_id);
          const time = occ.start_time || (n?.start_time ?? '');
          const until = n && (responseDeadline(occ.occurrence_date, time, deadlineHoursFor(n, occ)) ?? responseDeadline(occ.occurrence_date, time, 0));
          // 締切（無ければ開始）を過ぎた回の再開は記録のためだけなので判定しない（cron も 📣 も投稿しない）
          // 定期は対象外（募集を手動にできず、再開して 📣 で投稿する従来の手順を止めないため）。告知も登録と同じく判定する
          if (n && n.rrule === null && until && getJSTNow().getTime() < until.getTime() && !(await hasSentKind(db, n.id, occ.id, 'recruit'))) {
            const eff = flowFor(n, occ);
            const err = recruitTimingError(eff, occ.occurrence_date, time, deadlineHoursFor(n, occ), getJSTNow())
              ?? (n.type === 'oneoff' ? occurrenceFlowIssue(eff, time, deadlineHoursFor(n, occ)) : null);
            if (err) return json({ error: `再開できません: ${err}` }, 400);
          }
        }
        const ok = await setOccurrenceStatus(db, occ.id, b.status);
        return json({ ok }, ok ? 200 : 404);
      }
      if (b.date !== undefined) {
        if (!isRealDate(b.date)) return json({ error: 'date (YYYY/MM/DD) required' }, 400);
        // 単発出欠確認の開催日は作成後に変えない（画面の編集ロックと同じ・A3-03）
        if ((await getNotification(db, occ.notification_id))?.type === 'oneoff') {
          return json({ error: '単発出欠確認の開催日は作成後に変更できません。別の日にするときは新しく作ってください。' }, 400);
        }
        // 募集を投稿した開催回・回答締切を付けた開催回の日時は変更不可（投稿や締切が古くなる・ADR 0032）。中止→再登録で対応
        if (occ.response_deadline_hours != null || (await hasSentKind(db, occ.notification_id, occ.id, 'recruit'))) {
          return json({ error: '募集・告知の投稿後、または回答締切の設定後は開催日時を変更できません。中止して登録し直してください。' }, 400);
        }
        const ok = await updateOccurrenceDate(db, occ.id, b.date);
        return json({ ok }, ok ? 200 : 404);
      }
      return json({ error: 'status or date required' }, 400);
    }

    // ============ grouping（グループ分け・ADR 0015）============
    // /occurrences/:uuid/grouping
    const occGrouping = path.match(new RegExp(`^/occurrences/(${UUID_RE})/grouping$`));
    if (occGrouping) {
      const occ = await getOccurrenceByUuid(db, occGrouping[1]);
      if (!occ) return json({ error: 'Not found' }, 404);
      if (method === 'GET') {
        // どの開催回の配置か UI 見出しに出すため、開催回と通知の表示情報を同送する（M4）
        const n = await getNotification(db, occ.notification_id);
        return json({
          ...(await getGroupingView(db, occ.id)),
          occurrence: { occurrence_date: occ.occurrence_date, start_time: occ.start_time, duration_minutes: occ.duration_minutes },
          notification: n ? { name: n.name, start_time: n.start_time, duration_minutes: n.duration_minutes } : null,
        });
      }
      if (method === 'PUT') {
        const b = (await request.json()) as { group_count?: number };
        const gc = Number(b.group_count);
        if (!Number.isInteger(gc) || gc < 1 || gc > 100) {
          return json({ error: 'group_count must be 1..100' }, 400);
        }
        await upsertGrouping(db, occ.id, gc);
        return json(await getGroupingView(db, occ.id));
      }
      if (method === 'DELETE') {
        const ok = await deleteGrouping(db, occ.id);
        return json({ ok }, ok ? 200 : 404);
      }
    }
    // /occurrences/:uuid/grouping/members  PUT
    //   body: { assignments: [{group_uuid, members: [{user_id, label}]}] }（ADR 0015 追補2）
    const occGroupingMembers = path.match(new RegExp(`^/occurrences/(${UUID_RE})/grouping/members$`));
    if (occGroupingMembers && method === 'PUT') {
      const occ = await getOccurrenceByUuid(db, occGroupingMembers[1]);
      if (!occ) return json({ error: 'Not found' }, 404);
      const b = (await request.json()) as { assignments?: BoardAssignment[] };
      const assignments = Array.isArray(b.assignments) ? b.assignments : [];
      const view = await getGroupingView(db, occ.id);
      if (!view.grouping) return json({ error: 'grouping not initialized' }, 400);
      const normalized: { group_id: number; members: { user_id: string; label: string | null }[] }[] = [];
      // 所属の照合は取得済みのビューのグループ一覧で行う（グループごとに照会すると D1 50 回を超える・A3-01）
      const groupIdOf = new Map(view.groups.map((g) => [g.uuid, g.id]));
      for (const a of assignments) {
        const groupId = typeof a.group_uuid === 'string' ? groupIdOf.get(a.group_uuid) : undefined;
        if (groupId === undefined) continue; // 別の開催回のグループは無視
        normalized.push({ group_id: groupId, members: normalizeBoardMembers(a.members) });
      }
      await setGroupMembers(db, view.grouping.id, normalized);
      return json(await getGroupingView(db, occ.id));
    }
    // /occurrences/:uuid/grouping/move  PUT
    //   body: { user_id, to_group_uuid|null }
    const occGroupingMove = path.match(new RegExp(`^/occurrences/(${UUID_RE})/grouping/move$`));
    if (occGroupingMove && method === 'PUT') {
      const occ = await getOccurrenceByUuid(db, occGroupingMove[1]);
      if (!occ) return json({ error: 'Not found' }, 404);
      const b = (await request.json()) as { user_id?: string; to_group_uuid?: string | null };
      const userId = typeof b.user_id === 'string' ? b.user_id : '';
      if (!userId) return json({ error: 'user_id required' }, 400);
      const view = await getGroupingView(db, occ.id);
      if (!view.grouping) return json({ error: 'grouping not initialized' }, 400);
      let toGroupId: number | null = null;
      if (b.to_group_uuid != null) {
        const grp = view.groups.find((g) => g.uuid === b.to_group_uuid);
        if (!grp) return json({ error: 'group not found' }, 400);
        toGroupId = grp.id;
      }
      await moveMemberToGroup(db, view.grouping.id, userId, toGroupId);
      return json(await getGroupingView(db, occ.id));
    }
    // /occurrences/:uuid/grouping/rename  PUT
    //   body: { group_uuid, name }
    const occGroupingRename = path.match(new RegExp(`^/occurrences/(${UUID_RE})/grouping/rename$`));
    if (occGroupingRename && method === 'PUT') {
      const occ = await getOccurrenceByUuid(db, occGroupingRename[1]);
      if (!occ) return json({ error: 'Not found' }, 404);
      const b = (await request.json()) as { group_uuid?: string; name?: string; start_no?: unknown };
      const name = typeof b.name === 'string' ? cutText(b.name.trim(), 50) : '';
      // 自動連番の開始番号（任意・0以上の整数・ADR 0015 追補2拡張）
      const startNo =
        b.start_no === undefined || !Number.isFinite(Number(b.start_no))
          ? null
          : Math.max(0, Math.floor(Number(b.start_no)));
      if (typeof b.group_uuid !== 'string' || !b.group_uuid || (!name && startNo === null)) {
        return json({ error: 'group_uuid and name or start_no required' }, 400);
      }
      const view = await getGroupingView(db, occ.id);
      const grp = view.groups.find((g) => g.uuid === b.group_uuid);
      if (!grp) return json({ error: 'group not found' }, 404);
      let ok = true;
      if (name) ok = (await renameGroup(db, grp.id, name)) && ok;
      if (startNo !== null) ok = (await setGroupStartNo(db, grp.id, startNo)) && ok;
      return json({ ok }, ok ? 200 : 404);
    }
    // /occurrences/:uuid/grouping/auto-assign  POST
    // 追補(ADR 0015): 永続化しない dry-run。盤面の現在状態（未保存 assignments・任意）を
    // 受け取り、未配置の参加者の配置案 {proposals} を返す。クライアントが盤面に反映し
    // 「保存」で確定する。ボディ省略時は保存済み状態を盤面とみなす。
    const occGroupingAuto = path.match(new RegExp(`^/occurrences/(${UUID_RE})/grouping/auto-assign$`));
    if (occGroupingAuto && method === 'POST') {
      const occ = await getOccurrenceByUuid(db, occGroupingAuto[1]);
      if (!occ) return json({ error: 'occurrence not found' }, 404);
      const view = await getGroupingView(db, occ.id);
      if (!view.grouping) return json({ error: 'grouping not initialized' }, 400);
      const constraints = await listConstraints(db, occ.notification_id);
      const b = (await request.json().catch(() => ({}))) as { assignments?: BoardAssignment[] };
      const assignedIds = new Set<string>();
      if (Array.isArray(b.assignments)) {
        for (const a of b.assignments) for (const m of normalizeBoardMembers(a.members)) assignedIds.add(m.user_id);
      } else {
        for (const g of view.groups) for (const m of g.members) assignedIds.add(m.user_id);
      }
      // 現在の参加者（保存済みグループ内の不参加化メンバーは除く）のうち、盤面で未配置の者が対象
      const noLonger = new Set(view.diff.no_longer_participating.map((x) => x.user_id));
      const participantIds = [
        ...view.pool.map((m) => m.user_id),
        ...view.groups.flatMap((g) => g.members.map((m) => m.user_id).filter((u) => !noLonger.has(u))),
      ].filter((u) => !assignedIds.has(u));
      const groupIds = view.groups.map((g) => g.id);
      const result = autoAssign(participantIds, groupIds, constraints);
      const uuidOf = new Map(view.groups.map((g) => [g.id, g.uuid]));
      const proposals = Array.from(result.byGroupId.entries()).map(([group_id, user_ids]) => ({
        group_uuid: uuidOf.get(group_id),
        user_ids,
      }));
      return json({ proposals });
    }
    // /occurrences/:uuid/grouping/announce  POST
    const occGroupingAnnounce = path.match(new RegExp(`^/occurrences/(${UUID_RE})/grouping/announce$`));
    if (occGroupingAnnounce && method === 'POST') {
      const occ = await getOccurrenceByUuid(db, occGroupingAnnounce[1]);
      if (!occ) return json({ error: 'occurrence not found' }, 404);
      const n = await getNotification(db, occ.notification_id);
      if (!n) return json({ error: 'notification not found' }, 404);
      const view = await getGroupingView(db, occ.id);
      if (!view.grouping) return json({ error: 'grouping not initialized' }, 400);
      // 追補(ADR 0015): dry_run は盤面の現在状態（未保存）を同送でき、その内容で文面を生成する
      const dryRun = url.searchParams.get('dry_run') === '1';
      const b = (await request.json().catch(() => ({}))) as {
        assignments?: BoardAssignment[];
        pool_user_ids?: string[];
      };
      if (dryRun && Array.isArray(b.assignments)) {
        applyBoardStateToView(view, b.assignments, Array.isArray(b.pool_user_ids) ? b.pool_user_ids : []);
      }
      const lines: string[] = [];
      lines.push(
        `🧩 **メンバー配置** ${formatOccurrenceLabel(occ.occurrence_date, occ.start_time || n.start_time, durationFor(n, occ))}`,
      );
      lines.push('');
      for (const g of view.groups) {
        const labels = memberLineLabels(g.members, g.start_no ?? 1);
        const names = g.members
            .map((m, index) => `　${labels[index]}${m.name}`)
            .join('\n');

        lines.push(`**${g.name}** (${g.members.length}名):`);
        lines.push(names || '　—');
        lines.push(''); // ← グループ間に空行を追加
      }
      if (view.pool.length > 0) {
        lines.push('');
        lines.push(`未割り当て (${view.pool.length}名):\n${view.pool.map((m) => m.name).join('\n')}`);
      }
      const content = lines.join('\n');
      // ?dry_run=1: チャンネル送信せず content だけ返す（プレビュー用途）
      if (dryRun) {
        return json({ ok: true, content, dry_run: true });
      }
      // 中止した日時の配置は発表しない（📣 と同じ）
      if (occ.status === 'cancelled') return json({ error: '中止した日時の配置は発表できません。' }, 400);
      // 投稿先はマスター設定（grouping_channel_id・NULL なら募集チャンネル）に従う。
      // グループ名・表示名はユーザー由来文字列のため allowed_mentions={parse:[]} で一斉ピングを防ぐ（D8）。
      // 2000 字を超える配置は行の区切りで分けて順に投稿する（切り詰めると後ろのグループが載らなかった）
      const parts: string[] = [];
      for (const line of content.split('\n')) {
        const last = parts.length - 1;
        if (last >= 0 && parts[last].length + 1 + line.length <= DISCORD_CONTENT_LIMIT) parts[last] += '\n' + line;
        else parts.push(cutText(line, DISCORD_CONTENT_LIMIT));
      }
      // 区切りで余った空行だけの分は送らない（空の本文は Discord が拒む）
      const toSend = parts.filter((x) => x.trim());
      let sent = 0;
      while (sent < toSend.length && (await sendChannelMessage(env, n.grouping_channel_id ?? n.channel_id, toSend[sent], null, { parse: [] }))) sent++;
      const announced = sent === toSend.length;
      // 途中で失敗したら何通目まで載ったかを知らせる（再実行すると前半がもう一度投稿されるため、先に消してもらう）
      const progress = !announced && sent > 0 ? `${toSend.length}通中${sent}通まで投稿済みです。投稿し直す前に、投稿済みの分を Discord で削除してください。` : '';
      if (!announced) await notifyDeliveryFailure(env, n.guild_id, `配置発表: ${n.name}\n投稿先: <#${n.grouping_channel_id ?? n.channel_id}>${progress ? `\n${progress}` : ''}`);
      return json({ ok: announced, content, ...(progress ? { progress } : {}) });
    }

    // /notifications/:nuuid/grouping-channel  PUT  body: { channel_id: string|null }
    // メンバー配置結果の投稿先（マスター設定・即時保存）。null=募集チャンネルにフォールバック。
    const notifGroupingChannel = path.match(
      new RegExp(`^/notifications/(${UUID_RE})/grouping-channel$`),
    );
    if (notifGroupingChannel && method === 'PUT') {
      const n = await getNotificationByUuid(db, notifGroupingChannel[1]);
      if (!n) return json({ error: 'Not found' }, 404);
      const b = (await request.json().catch(() => ({}))) as { channel_id?: string | null };
      const channelId = typeof b.channel_id === 'string' && b.channel_id ? b.channel_id : null;
      const cerr = channelId === n.grouping_channel_id ? null : await foreignChannelError(env, n.guild_id, [channelId]);
      if (cerr) return json({ error: cerr }, 400);
      const ok = await setGroupingChannel(db, n.id, channelId);
      return json({ ok, channel_id: channelId }, ok ? 200 : 404);
    }

    // ============ constraints（ペア制約・Notification 単位・ADR 0015）============
    // /notifications/:nuuid/constraints
    const notifConstraints = path.match(new RegExp(`^/notifications/(${UUID_RE})/constraints$`));
    if (notifConstraints) {
      const n = await getNotificationByUuid(db, notifConstraints[1]);
      if (!n) return json({ error: 'Not found' }, 404);
      if (method === 'GET') {
        // 名前は 1 クエリで一緒に引く（制約の人数ぶん照会すると Free の D1 50 回/実行を超えうる）
        const name = (col: string) =>
          `(SELECT COALESCE(gp.display_name, m.display_name, m.user_name, m.user_id) FROM members m
             LEFT JOIN member_guild_profiles gp ON gp.user_id = m.user_id AND gp.guild_id = ?1 WHERE m.user_id = c.${col})`;
        const { results } = await db
          .prepare(
            `SELECT c.id, c.uuid, c.notification_id, c.user_id_a, c.user_id_b, c.direction, c.strength, c.created_at,
                    ${name('user_id_a')} AS user_a_name, ${name('user_id_b')} AS user_b_name
               FROM grouping_constraints c WHERE c.notification_id = ?2 ORDER BY c.id ASC`,
          )
          .bind(n.guild_id, n.id)
          .all();
        return json(results);
      }
      if (method === 'POST') {
        const b = (await request.json()) as {
          user_id_a?: string;
          user_id_b?: string;
          direction?: string;
          strength?: string;
        };
        const a = typeof b.user_id_a === 'string' ? b.user_id_a : '';
        const c = typeof b.user_id_b === 'string' ? b.user_id_b : '';
        if (!a || !c || a === c) return json({ error: 'distinct user_id_a/b required' }, 400);
        const dir: ConstraintDirection =
          b.direction === 'apart' ? 'apart' : 'together';
        const str: ConstraintStrength =
          b.strength === 'preferred' ? 'preferred' : 'required';
        const created = await upsertConstraint(db, n.id, a, c, dir, str);
        return json(created, 201);
      }
    }
    // /notifications/:nuuid/constraints/:cuuid  DELETE
    const constraintDelete = path.match(
      new RegExp(`^/notifications/(${UUID_RE})/constraints/(${UUID_RE})$`),
    );
    if (constraintDelete && method === 'DELETE') {
      const cst = await getConstraintByUuid(db, constraintDelete[2]);
      const owner = await getNotificationByUuid(db, constraintDelete[1]);
      if (!cst || !owner || cst.notification_id !== owner.id) return json({ ok: false }, 404);
      const ok = await deleteConstraint(db, cst.id);
      return json({ ok }, ok ? 200 : 404);
    }

    // ============ responses ============
    if (path === '/responses' && method === 'GET') {
      const limit = parseLimit(url.searchParams.get('limit'), 200);
      const guildId = url.searchParams.get('guild_id') || undefined;
      return json(await listRecentResponses(db, limit, guildId));
    }

    // ============ reports（出勤レポート）============
    if (path === '/reports/attendance' && method === 'GET') {
      const seg = await getSegmentByUuid(db, url.searchParams.get('segment_uuid') || '');
      if (!seg) return json({ error: 'segment not found' }, 404);
      // 通知単位の絞り込み（任意）。母集団は区分のまま、開催回だけをその通知に限定する。
      let notificationId: number | null = null;
      const nuuid = url.searchParams.get('notification_uuid');
      if (nuuid) {
        const n = await getNotificationByUuid(db, nuuid);
        if (!n || n.segment_id !== seg.id) {
          return json({ error: 'notification not found in segment' }, 404);
        }
        notificationId = n.id;
      }
      // 日付は 'YYYY-MM-DD'（UI の date input）/'YYYY/MM/DD' 両対応。不正は未指定扱い。
      const dateParam = (name: string): string | null => {
        const v = url.searchParams.get(name);
        return v && /^\d{4}[-/]\d{2}[-/]\d{2}$/.test(v) ? v.replace(/-/g, '/') : null;
      };
      return json(
        await getAttendanceReport(db, seg.id, {
          from: dateParam('from'),
          to: dateParam('to'),
          today: formatDate(getJSTNow()),
          notificationId,
        }),
      );
    }

    // ============ send-log（リマインド送信履歴・④可視化）============
    if (path === '/send-log' && method === 'GET') {
      const limit = parseLimit(url.searchParams.get('limit'), 300);
      const nid = url.searchParams.get('notification_id');
      const guildId = url.searchParams.get('guild_id') || undefined;
      return json(
        await listSendLog(db, {
          limit,
          notificationId: nid ? Number(nid) : undefined,
          guildId,
        }),
      );
    }

    // ============ config（送信予算など実行時設定・⑦）============
    if (path === '/config') {
      if (method === 'GET') return json(await getAllConfig(db));
      if (method === 'PUT') {
        const b = (await request.json()) as { key?: string; value?: string };
        if (!b.key || b.value == null) return json({ error: 'key and value required' }, 400);
        if (b.key.startsWith('failure_notification:')) return json({ error: '失敗通知はサーバーのBot設定から変更してください' }, 400);
        await setConfig(db, b.key, String(b.value));
        return json({ ok: true });
      }
    }

    // ============ send-estimate（推奨上限の推定・⑦）============
    if (path === '/send-estimate' && method === 'GET') {
      const guildId = url.searchParams.get('guild_id');
      const notifs = guildId
        ? await listNotificationsByGuild(db, guildId)
        : await listNotifications(db);
      const budget = await getSendBudget(db);
      const memberCache = new Map<number, number>();
      const perHour: Record<string, number> = {};
      for (const n of notifs) {
        if (!n.active) continue;
        let cnt = memberCache.get(n.segment_id);
        if (cnt == null) {
          cnt = (await getActiveSegmentMembers(db, n.segment_id)).length;
          memberCache.set(n.segment_id, cnt);
        }
        // ピーク = その通知が 1 日に投げうる最大送信数（全員未回答で DM）。回答不要(通知のみ)は募集1件。
        const peak = n.requires_response ? cnt : 1;
        perHour[String(n.send_hour)] = (perHour[String(n.send_hour)] ?? 0) + peak;
      }
      const dailyTotal = Object.values(perHour).reduce((a, b) => a + b, 0);
      const maxWindow = Object.values(perHour).reduce((a, b) => Math.max(a, b), 0);
      const hardCeiling = budget * 1440; // 毎分 cron × 予算 = 1 日のハード上限
      const recommendedDaily = Math.round(hardCeiling * 0.15); // 安全マージン込みの推奨日次
      const recommendedPerWindow = budget * 55; // 1 送信時刻を約 55 分以内に流し切れる量
      return json({
        budget,
        perHour,
        dailyTotal,
        maxWindow,
        hardCeiling,
        recommendedDaily,
        recommendedPerWindow,
        overDaily: dailyTotal > recommendedDaily,
        overWindow: maxWindow > recommendedPerWindow,
      });
    }

    return json({ error: 'Not found' }, 404);
  } catch (e) {
    // request.json() の解析失敗は入力の誤り（500 ではなく 400）
    if (e instanceof SyntaxError) return json({ error: 'リクエストの内容（JSON）を読み取れません。' }, 400);
    const message = (e as Error).message;
    if (message.includes('UNIQUE constraint failed')) return json({ error: '同じ内容のデータが既にあります（同じ開催日時など）。' }, 409);
    console.error('[Admin] error:', message);
    return json({ error: 'Internal error' }, 500);
  }
}

/** 'YYYY/MM/DD' 形式で、実在する日付か（2026/02/31 などは false） */
function isRealDate(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}\/\d{2}\/\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split('/').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}
