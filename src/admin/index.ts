import type { Env } from '../env';
import type { MentionMode, NotificationType } from '../db/types';
import { isAnnounceOnly } from '../db/types';
import { listGuilds, listGuildChannels, listGuildMembers } from '../discord/rest';
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
import { syncSegmentFromRole } from '../discord/syncSegment';
import { getAllMembers, upsertMember, deleteMember, getMember } from '../db/members';
import { resolveDisplayName } from '../db/types';
import {
  listNotifications,
  listNotificationsByGuild,
  getNotification,
  getNotificationByUuid,
  createNotification,
  updateNotification,
  deleteNotification,
  decideOccurrence,
  undecideNotification,
  type NotificationInput,
} from '../db/notifications';
import {
  getOccurrenceByUuid,
  setOccurrenceStatus,
  updateOccurrenceDate,
  listOccurrencesForNotification,
  syncCandidateOccurrences,
  type CandidateSlot,
} from '../db/occurrences';
import { getResponsesForOccurrence, getStatusBuckets, listRecentResponses } from '../db/responses';
import { getAssignments, assignNumbers, type AssignMode } from '../db/assignments';
import {
  getGroupingView,
  getGroupByUuid,
  getConstraintByUuid,
  upsertGrouping,
  setGroupMembers,
  moveMemberToGroup,
  renameGroup,
  deleteGrouping,
  listConstraints,
  upsertConstraint,
  deleteConstraint,
  autoAssign,
} from '../db/groupings';
import type { ConstraintDirection, ConstraintStrength } from '../db/types';
import { listSendLog } from '../db/sendLog';
import { getAllConfig, setConfig, getSendBudget } from '../db/config';
import { sendChannelMessage, createButtonComponents } from '../discord/rest';
import { recruitNotificationNow } from '../cron/dailyCheck';
import { formatTimeRange } from '../lib/date';
import { getSetupStatus, registerCommandsForEnv } from './setup';

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

/**
 * 単発(oneoff)の候補スロット（日付＋時刻）を正規化する。
 * body.candidate_slots（[{date,time}]・date は 'YYYY-MM-DD'/'YYYY/MM/DD'）を
 * 'YYYY/MM/DD'＋'HH:MM' に統一し、(date,time) で重複除去・昇順ソート。
 * 未指定なら後方互換で単一 (one_off_date, start_time) を 1 スロットとして使う。
 */
function candidateSlotsOf(
  b: Record<string, unknown>,
  fallbackDate: string | null,
  fallbackTime: string,
): CandidateSlot[] {
  const raw = Array.isArray(b.candidate_slots) ? (b.candidate_slots as unknown[]) : [];
  const seen = new Set<string>();
  const out: CandidateSlot[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const date = typeof rec.date === 'string' ? rec.date.replace(/-/g, '/').trim() : '';
    const time = typeof rec.time === 'string' ? rec.time.trim() : '';
    if (!date || !time) continue;
    const k = `${date} ${time}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ date, time });
  }
  out.sort((a, z) => (a.date === z.date ? a.time.localeCompare(z.time) : a.date.localeCompare(z.date)));
  if (out.length) return out;
  return fallbackDate ? [{ date: fallbackDate, time: fallbackTime || '21:00' }] : [];
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

/** Notification の入力ボディを正規化（数値フラグは 0/1） */
function toNotificationInput(b: Record<string, unknown>): NotificationInput | null {
  const guild_id = typeof b.guild_id === 'string' ? b.guild_id : '';
  const segment_id = Number(b.segment_id);
  const name = typeof b.name === 'string' ? b.name : '';
  const channel_id = typeof b.channel_id === 'string' ? b.channel_id : '';
  const type = (b.type === 'oneoff' ? 'oneoff' : 'recurring') as NotificationType;
  if (!guild_id || !segment_id || !name || !channel_id) return null;
  // 回答要否は recurring 専用。oneoff は常に回答あり（1）。回答不要(=通知のみ)は回答依存機能を無効化する。
  const requiresResponse =
    type === 'oneoff' ? 1 : b.requires_response === undefined ? 1 : b.requires_response ? 1 : 0;
  const announceOnly = isAnnounceOnly({ type, requires_response: requiresResponse });
  return {
    guild_id,
    segment_id,
    name,
    channel_id,
    type,
    rrule: b.rrule == null || b.rrule === '' ? null : String(b.rrule),
    one_off_date: b.one_off_date == null || b.one_off_date === '' ? null : String(b.one_off_date),
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
    // ノルマ（参加間隔の督促）は繰り返し開催のための概念。単発(oneoff)では無効に固定し、
    // cron 自動募集を廃止した単発でノルマDMが沈黙する不整合（旧挙動からの回帰）を防ぐ。
    quota_enabled: type === 'oneoff' ? 0 : b.quota_enabled ? 1 : 0,
    quota_interval_days:
      type === 'oneoff' ||
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

/**
 * 管理 API（/api/admin/*）。すべて ADMIN_TOKEN による Bearer 認証必須。すべて JSON。
 * - GET        /setup/status                  (シークレット有無・Interaction URL)
 * - POST       /setup/register-commands       ({guild_id?} スラッシュコマンド登録)
 * - GET        /guilds, /guilds/:id/channels, /guilds/:id/members  (Discord 由来・読み取り専用)
 * - GET/POST   /segments[?guild_id=],         PUT/DELETE /segments/:id
 * - GET        /segments/:id/members,         POST /segments/:id/members ({user_id,display_name?,user_name?})
 * - PUT/DELETE /segments/:id/members/:userId  ({status} for PUT)
 * - GET/POST   /members,                      DELETE /members/:userId
 * - GET/POST   /notifications[?guild_id=],    GET/PUT/DELETE /notifications/:id
 *              （POST/PUT で type='oneoff' は body.candidate_dates[] を候補回として同期）
 * - GET        /notifications/:id/occurrences
 * - POST       /notifications/:id/decide      ({occurrence_id} 最終確定・他候補を cancel)
 * - POST       /notifications/:id/undecide    (確定解除・落選候補を復活)
 * - POST       /notifications/:id/recruit     (今すぐ募集を投稿)
 * - PUT        /occurrences/:id               ({status|date})
 * - GET        /occurrences/:id/responses,    GET /occurrences/:id/status (集計バケット)
 * - GET        /occurrences/:id/assignments
 * - POST       /occurrences/:id/assign        (assignNumbers 実行)
 * - GET        /responses?limit=
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
      return json(await listGuildChannels(env, guildChannels[1]));
    }
    const guildMembers = path.match(/^\/guilds\/(\d+)\/members$/);
    if (guildMembers && method === 'GET') {
      return json(await listGuildMembers(env, guildMembers[1]));
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
        return json(
          await createSegment(db, { guild_id: b.guild_id, name: b.name, mention_role_id: b.mention_role_id ?? null }),
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
        await addSegmentMember(db, seg.id, b.user_id, {
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
        const ok = await updateSegment(db, seg.id, {
          name: b.name,
          mention_role_id: b.mention_role_id ?? null,
        });
        return json({ ok }, ok ? 200 : 404);
      }
      if (method === 'DELETE') {
        // 対象 Notification がある場合は削除させない（409）
        const count = await countNotificationsForSegment(db, seg.id);
        if (count > 0) {
          return json({ error: 'segment has notifications', count }, 409);
        }
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
    // body 内の segment_uuid → segment_id 解決（ADR 0016）
    async function resolveSegmentUuid(body: Record<string, unknown>): Promise<string | null> {
      if (typeof body.segment_uuid !== 'string' || !body.segment_uuid) {
        return 'segment_uuid required';
      }
      const seg = await getSegmentByUuid(db, body.segment_uuid);
      if (!seg) return 'segment not found';
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
        if (input.type === 'recurring' && !input.rrule) {
          return json({ error: '繰り返しは曜日/第N曜ルールが必須です。' }, 400);
        }
        if (input.type === 'oneoff') {
          const slots = candidateSlotsOf(body, input.one_off_date, input.start_time);
          if (slots.length === 0) return json({ error: '単発は候補日時が必須です' }, 400);
          input.one_off_date = slots[0].date;
          input.start_time = slots[0].time;
          const created = await createNotification(db, input);
          await syncCandidateOccurrences(db, created.id, slots);
          return json(created, 201);
        }
        return json(await createNotification(db, input), 201);
      }
    }
    // /notifications/:uuid/occurrences
    const notifOccs = path.match(new RegExp(`^/notifications/(${UUID_RE})/occurrences$`));
    if (notifOccs && method === 'GET') {
      const n = await getNotificationByUuid(db, notifOccs[1]);
      if (!n) return json({ error: 'Not found' }, 404);
      const limit = parseLimit(url.searchParams.get('limit'), 100);
      return json(await listOccurrencesForNotification(db, n.id, limit));
    }
    // /notifications/:uuid/decide （複数候補日の最終確定）
    const notifDecide = path.match(new RegExp(`^/notifications/(${UUID_RE})/decide$`));
    if (notifDecide && method === 'POST') {
      const n = await getNotificationByUuid(db, notifDecide[1]);
      if (!n) return json({ error: 'Not found' }, 404);
      const b = (await request.json()) as { occurrence_uuid?: string };
      if (typeof b.occurrence_uuid !== 'string' || !b.occurrence_uuid) {
        return json({ error: 'occurrence_uuid required' }, 400);
      }
      const occ = await getOccurrenceByUuid(db, b.occurrence_uuid);
      if (!occ || occ.notification_id !== n.id) {
        return json({ error: 'occurrence does not belong to notification' }, 400);
      }
      await decideOccurrence(db, n.id, occ.id);
      const announced = await sendChannelMessage(
        env,
        n.channel_id,
        `✅ **開催日が確定しました**\n\n**${occ.occurrence_date}** ${formatTimeRange(occ.start_time || n.start_time, n.duration_minutes)} に開催します！\n\n出欠が変わる場合は下のボタンで回答してください。`,
        createButtonComponents(occ.id, n.type),
      );
      return json({ ok: true, decided_occurrence_uuid: occ.uuid, announced });
    }
    // /notifications/:uuid/undecide
    const notifUndecide = path.match(new RegExp(`^/notifications/(${UUID_RE})/undecide$`));
    if (notifUndecide && method === 'POST') {
      const n = await getNotificationByUuid(db, notifUndecide[1]);
      if (!n) return json({ error: 'Not found' }, 404);
      await undecideNotification(db, n.id);
      return json({ ok: true });
    }
    // /notifications/:uuid/recruit
    const notifRecruit = path.match(new RegExp(`^/notifications/(${UUID_RE})/recruit$`));
    if (notifRecruit && method === 'POST') {
      const n = await getNotificationByUuid(db, notifRecruit[1]);
      if (!n) return json({ error: 'Not found' }, 404);
      const r = await recruitNotificationNow(env, n);
      return json(r, r.ok ? 200 : 400);
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
        const err = await resolveSegmentUuid(body);
        if (err) return json({ error: err }, 400);
        const input = toNotificationInput(body);
        if (!input) return json({ error: 'Invalid body' }, 400);
        if (!input.message_title) return json({ error: '見出しは必須です。' }, 400);
        if (input.type === 'recurring' && !input.rrule) {
          return json({ error: '繰り返しは曜日/第N曜ルールが必須です。' }, 400);
        }
        if (input.type === 'oneoff') {
          const slots = candidateSlotsOf(body, input.one_off_date, input.start_time);
          if (slots.length === 0) return json({ error: '単発は候補日時が必須です' }, 400);
          input.one_off_date = slots[0].date;
          input.start_time = slots[0].time;
          const ok = await updateNotification(db, n.id, input);
          if (!ok) return json({ ok }, 404);
          const current = await getNotification(db, n.id);
          if (current && current.decided_occurrence_id == null) {
            await syncCandidateOccurrences(db, n.id, slots);
          }
          return json({ ok });
        }
        const ok = await updateNotification(db, n.id, input);
        return json({ ok }, ok ? 200 : 404);
      }
      if (method === 'DELETE') {
        const ok = await deleteNotification(db, n.id);
        return json({ ok }, ok ? 200 : 404);
      }
    }

    // ============ occurrences ============
    // /occurrences/:uuid/assign  body: { mode: 'first-come' | 'random' }
    // ADR 0018: 既存番号は全クリアされ 1..N で振り直される。
    const occAssign = path.match(new RegExp(`^/occurrences/(${UUID_RE})/assign$`));
    if (occAssign && method === 'POST') {
      const occ = await getOccurrenceByUuid(db, occAssign[1]);
      if (!occ) return json({ error: 'Not found' }, 404);
      const b = (await request.json().catch(() => ({}))) as { mode?: string };
      const mode: AssignMode | null =
        b.mode === 'first-come' ? 'first-come' : b.mode === 'random' ? 'random' : null;
      if (!mode) return json({ error: "mode must be 'first-come' or 'random'" }, 400);
      return json(await assignNumbers(db, occ.id, mode));
    }
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
      return json(await getStatusBuckets(db, occ.id, n.segment_id));
    }
    // /occurrences/:uuid/assignments
    const occAssignments = path.match(new RegExp(`^/occurrences/(${UUID_RE})/assignments$`));
    if (occAssignments && method === 'GET') {
      const occ = await getOccurrenceByUuid(db, occAssignments[1]);
      if (!occ) return json({ error: 'Not found' }, 404);
      return json(await getAssignments(db, occ.id));
    }
    // /occurrences/:uuid/assignments/announce  POST  現在の番号割り当てをチャンネルへ投稿
    const occAssignmentsAnnounce = path.match(
      new RegExp(`^/occurrences/(${UUID_RE})/assignments/announce$`),
    );
    if (occAssignmentsAnnounce && method === 'POST') {
      const occ = await getOccurrenceByUuid(db, occAssignmentsAnnounce[1]);
      if (!occ) return json({ error: 'occurrence not found' }, 404);
      const n = await getNotification(db, occ.notification_id);
      if (!n) return json({ error: 'notification not found' }, 404);
      const list = await getAssignments(db, occ.id);
      if (list.length === 0) return json({ error: 'no assignments to announce' }, 400);
      const lines: string[] = [];
      lines.push(
        `🔢 **番号割り当て** ${occ.occurrence_date} ${formatTimeRange(occ.start_time || n.start_time, n.duration_minutes)}`,
      );
      lines.push('');
      for (const a of list) lines.push(`#${a.number} ${a.name}`);
      const announced = await sendChannelMessage(env, n.channel_id, lines.join('\n'));
      return json({ ok: announced, content: lines.join('\n') });
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
        const ok = await setOccurrenceStatus(db, occ.id, b.status);
        return json({ ok }, ok ? 200 : 404);
      }
      if (b.date !== undefined) {
        if (!b.date) return json({ error: 'date required' }, 400);
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
        return json(await getGroupingView(db, occ.id));
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
    //   body: { assignments: [{group_uuid, user_ids: []}] }
    const occGroupingMembers = path.match(new RegExp(`^/occurrences/(${UUID_RE})/grouping/members$`));
    if (occGroupingMembers && method === 'PUT') {
      const occ = await getOccurrenceByUuid(db, occGroupingMembers[1]);
      if (!occ) return json({ error: 'Not found' }, 404);
      const b = (await request.json()) as {
        assignments?: { group_uuid?: string; user_ids?: string[] }[];
      };
      const assignments = Array.isArray(b.assignments) ? b.assignments : [];
      const normalized: { group_id: number; user_ids: string[] }[] = [];
      for (const a of assignments) {
        if (typeof a.group_uuid !== 'string') continue;
        const grp = await getGroupByUuid(db, a.group_uuid);
        if (!grp) continue;
        const uids = Array.isArray(a.user_ids) ? a.user_ids.filter((u) => typeof u === 'string') : [];
        normalized.push({ group_id: grp.id, user_ids: uids });
      }
      const view = await getGroupingView(db, occ.id);
      if (!view.grouping) return json({ error: 'grouping not initialized' }, 400);
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
        const grp = await getGroupByUuid(db, b.to_group_uuid);
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
      const b = (await request.json()) as { group_uuid?: string; name?: string };
      const name = typeof b.name === 'string' ? b.name.trim().slice(0, 50) : '';
      if (typeof b.group_uuid !== 'string' || !b.group_uuid || !name) {
        return json({ error: 'group_uuid and name required' }, 400);
      }
      const grp = await getGroupByUuid(db, b.group_uuid);
      if (!grp) return json({ error: 'group not found' }, 404);
      const ok = await renameGroup(db, grp.id, name);
      return json({ ok }, ok ? 200 : 404);
    }
    // /occurrences/:uuid/grouping/auto-assign  POST
    const occGroupingAuto = path.match(new RegExp(`^/occurrences/(${UUID_RE})/grouping/auto-assign$`));
    if (occGroupingAuto && method === 'POST') {
      const occ = await getOccurrenceByUuid(db, occGroupingAuto[1]);
      if (!occ) return json({ error: 'occurrence not found' }, 404);
      const view = await getGroupingView(db, occ.id);
      if (!view.grouping) return json({ error: 'grouping not initialized' }, 400);
      const constraints = await listConstraints(db, occ.notification_id);
      // 未配置メンバーのみを自動配置対象とする
      const participantIds = view.pool.map((m) => m.user_id);
      const groupIds = view.groups.map((g) => g.id);
      const result = autoAssign(participantIds, groupIds, constraints);
      const assignments = Array.from(result.byGroupId.entries()).map(([group_id, user_ids]) => ({
        group_id,
        user_ids,
      }));
      await setGroupMembers(db, view.grouping.id, assignments, true);
      return json(await getGroupingView(db, occ.id));
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
      const lines: string[] = [];
      lines.push(
        `🧩 **グループ分け** ${occ.occurrence_date} ${formatTimeRange(occ.start_time || n.start_time, n.duration_minutes)}`,
      );
      lines.push('');
      for (const g of view.groups) {
        //const names = g.members.map((m) => `　${m.name}`).join('\n');
        //lines.push(`**${g.name}** (${g.members.length}名):\n　${names || '—'}`);
        const names = g.members
            .map((m, index) => `　${String(index + 1).padStart(2, ' ')}　${m.name}`)
            .join('\n');

        lines.push(`**${g.name}** (${g.members.length}名):`);
        lines.push(names || '　—');
        lines.push(''); // ← グループ間に空行を追加
      }
      if (view.pool.length > 0) {
        lines.push('');
        lines.push(`未割り当て (${view.pool.length}名):\n${view.pool.map((m) => m.name).join('\n')}`);
      }
      const announced = await sendChannelMessage(env, n.channel_id, lines.join('\n'));
      return json({ ok: announced, content: lines.join('\n') });
    }

    // ============ constraints（ペア制約・Notification 単位・ADR 0015）============
    // /notifications/:nuuid/constraints
    const notifConstraints = path.match(new RegExp(`^/notifications/(${UUID_RE})/constraints$`));
    if (notifConstraints) {
      const n = await getNotificationByUuid(db, notifConstraints[1]);
      if (!n) return json({ error: 'Not found' }, 404);
      if (method === 'GET') {
        const rows = await listConstraints(db, n.id);
        const cache = new Map<string, string | null>();
        const nameOf = async (uid: string): Promise<string | null> => {
          if (cache.has(uid)) return cache.get(uid) ?? null;
          const m = await getMember(db, uid);
          const name = m ? resolveDisplayName(m) : null;
          cache.set(uid, name);
          return name;
        };
        const enriched = await Promise.all(
          rows.map(async (c) => ({
            ...c,
            user_a_name: await nameOf(c.user_id_a),
            user_b_name: await nameOf(c.user_id_b),
          })),
        );
        return json(enriched);
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
      if (!cst) return json({ ok: false }, 404);
      const ok = await deleteConstraint(db, cst.id);
      return json({ ok }, ok ? 200 : 404);
    }

    // ============ responses ============
    if (path === '/responses' && method === 'GET') {
      const limit = parseLimit(url.searchParams.get('limit'), 200);
      const guildId = url.searchParams.get('guild_id') || undefined;
      return json(await listRecentResponses(db, limit, guildId));
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
    console.error('[Admin] error:', (e as Error).message);
    return json({ error: 'Internal error' }, 500);
  }
}
