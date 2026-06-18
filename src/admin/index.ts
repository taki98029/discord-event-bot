import type { Env } from '../env';
import type { NotificationType } from '../db/types';
import { listGuilds, listGuildChannels, listGuildMembers } from '../discord/rest';
import {
  listSegments,
  getSegment,
  createSegment,
  updateSegment,
  deleteSegment,
  countNotificationsForSegment,
  listSegmentMembers,
  addSegmentMember,
  setSegmentMemberStatus,
  removeSegmentMember,
} from '../db/segments';
import { syncSegmentFromRole } from '../discord/syncSegment';
import { getAllMembers, upsertMember, deleteMember } from '../db/members';
import {
  listNotifications,
  listNotificationsByGuild,
  getNotification,
  createNotification,
  updateNotification,
  deleteNotification,
  decideOccurrence,
  undecideNotification,
  type NotificationInput,
} from '../db/notifications';
import {
  getOccurrence,
  setOccurrenceStatus,
  updateOccurrenceDate,
  listOccurrencesForNotification,
  syncCandidateOccurrences,
  type CandidateSlot,
} from '../db/occurrences';
import { getResponsesForOccurrence, getStatusBuckets, listRecentResponses } from '../db/responses';
import { getAssignments, assignNumbers } from '../db/assignments';
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

/** Notification の入力ボディを正規化（数値フラグは 0/1） */
function toNotificationInput(b: Record<string, unknown>): NotificationInput | null {
  const guild_id = typeof b.guild_id === 'string' ? b.guild_id : '';
  const segment_id = Number(b.segment_id);
  const name = typeof b.name === 'string' ? b.name : '';
  const channel_id = typeof b.channel_id === 'string' ? b.channel_id : '';
  const type = (b.type === 'oneoff' ? 'oneoff' : 'recurring') as NotificationType;
  if (!guild_id || !segment_id || !name || !channel_id) return null;
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
    assignment_enabled: b.assignment_enabled ? 1 : 0,
    mention_enabled: b.mention_enabled ? 1 : 0,
    active: b.active === undefined ? 1 : b.active ? 1 : 0,
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
    // /segments/:id/members/:userId
    const segMemberItem = path.match(/^\/segments\/(\d+)\/members\/(.+)$/);
    if (segMemberItem) {
      const segmentId = Number(segMemberItem[1]);
      const userId = decodeURIComponent(segMemberItem[2]);
      if (method === 'PUT') {
        const b = (await request.json()) as { status?: string };
        if (b.status === undefined) return json({ error: 'status required' }, 400);
        // status は '' / '休止中' の2値固定。不正値は集計母集団からの静かな脱落を招くため弾く。
        if (b.status !== '' && b.status !== '休止中') {
          return json({ error: "status must be '' or '休止中'" }, 400);
        }
        const ok = await setSegmentMemberStatus(db, segmentId, userId, b.status);
        return json({ ok }, ok ? 200 : 404);
      }
      if (method === 'DELETE') {
        const ok = await removeSegmentMember(db, segmentId, userId);
        return json({ ok }, ok ? 200 : 404);
      }
    }
    // /segments/:id/members
    const segMembers = path.match(/^\/segments\/(\d+)\/members$/);
    if (segMembers) {
      const segmentId = Number(segMembers[1]);
      if (method === 'GET') return json(await listSegmentMembers(db, segmentId));
      if (method === 'POST') {
        const b = (await request.json()) as {
          user_id?: string;
          user_name?: string | null;
          display_name?: string | null;
        };
        if (!b.user_id) return json({ error: 'user_id required' }, 400);
        await addSegmentMember(db, segmentId, b.user_id, {
          user_name: b.user_name ?? null,
          display_name: b.display_name ?? null,
        });
        return json({ ok: true }, 201);
      }
    }
    // /segments/:id/sync-from-role （ロール管理区分を Discord ロールから手動同期・ADR 0009）
    const segSync = path.match(/^\/segments\/(\d+)\/sync-from-role$/);
    if (segSync && method === 'POST') {
      const seg = await getSegment(db, Number(segSync[1]));
      if (!seg) return json({ error: 'Not found' }, 404);
      if (!seg.mention_role_id) {
        return json({ error: 'この区分はロール管理ではありません（ロール未設定）。' }, 400);
      }
      // 手動同期は確認ダイアログ経由のため allowEmpty=true（明示的に空にできる）。
      const r = await syncSegmentFromRole(env, seg, { allowEmpty: true });
      return json(r, r.ok ? 200 : 400);
    }
    // /segments/:id
    const segId = path.match(/^\/segments\/(\d+)$/);
    if (segId) {
      const id = Number(segId[1]);
      if (method === 'PUT') {
        const b = (await request.json()) as { name?: string; mention_role_id?: string | null };
        if (!b.name) return json({ error: 'name required' }, 400);
        const ok = await updateSegment(db, id, {
          name: b.name,
          mention_role_id: b.mention_role_id ?? null,
        });
        return json({ ok }, ok ? 200 : 404);
      }
      if (method === 'DELETE') {
        // 対象 Notification がある場合は削除させない（409）
        const count = await countNotificationsForSegment(db, id);
        if (count > 0) {
          return json({ error: 'segment has notifications', count }, 409);
        }
        const ok = await deleteSegment(db, id);
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
    if (path === '/notifications') {
      if (method === 'GET') {
        const guildId = url.searchParams.get('guild_id');
        return json(guildId ? await listNotificationsByGuild(db, guildId) : await listNotifications(db));
      }
      if (method === 'POST') {
        const body = (await request.json()) as Record<string, unknown>;
        const input = toNotificationInput(body);
        if (!input) return json({ error: 'Invalid body' }, 400);
        // 繰り返しは曜日/第N曜ルール（rrule）必須。空だと nextOccurrenceDate が常に null で無音通知になる。
        if (input.type === 'recurring' && !input.rrule) {
          return json({ error: '繰り返しは曜日/第N曜ルールが必須です。' }, 400);
        }
        if (input.type === 'oneoff') {
          const slots = candidateSlotsOf(body, input.one_off_date, input.start_time);
          if (slots.length === 0) return json({ error: '単発は候補日時が必須です' }, 400);
          input.one_off_date = slots[0].date; // 最早スロットをスケジュール計算の基準に
          input.start_time = slots[0].time;
          const created = await createNotification(db, input);
          await syncCandidateOccurrences(db, created.id, slots);
          return json(created, 201);
        }
        return json(await createNotification(db, input), 201);
      }
    }
    // /notifications/:id/occurrences
    const notifOccs = path.match(/^\/notifications\/(\d+)\/occurrences$/);
    if (notifOccs && method === 'GET') {
      const id = Number(notifOccs[1]);
      const limit = parseLimit(url.searchParams.get('limit'), 100);
      return json(await listOccurrencesForNotification(db, id, limit));
    }
    // /notifications/:id/decide （複数候補日の最終確定）
    const notifDecide = path.match(/^\/notifications\/(\d+)\/decide$/);
    if (notifDecide && method === 'POST') {
      const nid = Number(notifDecide[1]);
      const b = (await request.json()) as { occurrence_id?: number };
      const occId = Number(b.occurrence_id);
      if (!Number.isInteger(occId)) return json({ error: 'occurrence_id required' }, 400);
      const n = await getNotification(db, nid);
      if (!n) return json({ error: 'Not found' }, 404);
      const occ = await getOccurrence(db, occId);
      if (!occ || occ.notification_id !== nid) {
        return json({ error: 'occurrence does not belong to notification' }, 400);
      }
      await decideOccurrence(db, nid, occId);
      // 確定アナウンス（投稿失敗は致命的でない）
      const announced = await sendChannelMessage(
        env,
        n.channel_id,
        `✅ **開催日が確定しました**\n\n**${occ.occurrence_date}** ${formatTimeRange(occ.start_time || n.start_time, n.duration_minutes)} に開催します！\n\n出欠が変わる場合は下のボタンで回答してください。`,
        createButtonComponents(occ.id, n.type),
      );
      return json({ ok: true, decided_occurrence_id: occId, announced });
    }
    // /notifications/:id/undecide （確定解除：落選候補を scheduled に戻す）
    const notifUndecide = path.match(/^\/notifications\/(\d+)\/undecide$/);
    if (notifUndecide && method === 'POST') {
      const nid = Number(notifUndecide[1]);
      const n = await getNotification(db, nid);
      if (!n) return json({ error: 'Not found' }, 404);
      await undecideNotification(db, nid);
      return json({ ok: true });
    }
    // /notifications/:id/recruit （管理画面から今すぐ募集を投稿）
    const notifRecruit = path.match(/^\/notifications\/(\d+)\/recruit$/);
    if (notifRecruit && method === 'POST') {
      const nid = Number(notifRecruit[1]);
      const n = await getNotification(db, nid);
      if (!n) return json({ error: 'Not found' }, 404);
      const r = await recruitNotificationNow(env, n);
      return json(r, r.ok ? 200 : 400);
    }
    // /notifications/:id
    const notifId = path.match(/^\/notifications\/(\d+)$/);
    if (notifId) {
      const id = Number(notifId[1]);
      if (method === 'GET') {
        const row = await getNotification(db, id);
        return row ? json(row) : json({ error: 'Not found' }, 404);
      }
      if (method === 'PUT') {
        const body = (await request.json()) as Record<string, unknown>;
        const input = toNotificationInput(body);
        if (!input) return json({ error: 'Invalid body' }, 400);
        // 繰り返しは曜日/第N曜ルール（rrule）必須。空だと nextOccurrenceDate が常に null で無音通知になる。
        if (input.type === 'recurring' && !input.rrule) {
          return json({ error: '繰り返しは曜日/第N曜ルールが必須です。' }, 400);
        }
        if (input.type === 'oneoff') {
          const slots = candidateSlotsOf(body, input.one_off_date, input.start_time);
          if (slots.length === 0) return json({ error: '単発は候補日時が必須です' }, 400);
          input.one_off_date = slots[0].date; // 最早スロットを基準に
          input.start_time = slots[0].time;
          const ok = await updateNotification(db, id, input);
          if (!ok) return json({ ok }, 404);
          // 確定済み（decided_occurrence_id 設定済み）は候補を再同期しない（落選回の復活を防ぐ）。
          const current = await getNotification(db, id);
          if (current && current.decided_occurrence_id == null) {
            await syncCandidateOccurrences(db, id, slots);
          }
          return json({ ok });
        }
        const ok = await updateNotification(db, id, input);
        return json({ ok }, ok ? 200 : 404);
      }
      if (method === 'DELETE') {
        const ok = await deleteNotification(db, id);
        return json({ ok }, ok ? 200 : 404);
      }
    }

    // ============ occurrences ============
    // /occurrences/:id/assign
    const occAssign = path.match(/^\/occurrences\/(\d+)\/assign$/);
    if (occAssign && method === 'POST') {
      const id = Number(occAssign[1]);
      return json(await assignNumbers(db, id));
    }
    // /occurrences/:id/responses
    const occResponses = path.match(/^\/occurrences\/(\d+)\/responses$/);
    if (occResponses && method === 'GET') {
      const id = Number(occResponses[1]);
      return json(await getResponsesForOccurrence(db, id));
    }
    // /occurrences/:id/status （候補日ごとの出欠集計バケット）
    const occStatus = path.match(/^\/occurrences\/(\d+)\/status$/);
    if (occStatus && method === 'GET') {
      const id = Number(occStatus[1]);
      const occ = await getOccurrence(db, id);
      if (!occ) return json({ error: 'Not found' }, 404);
      const n = await getNotification(db, occ.notification_id);
      if (!n) return json({ error: 'Not found' }, 404);
      return json(await getStatusBuckets(db, id, n.segment_id));
    }
    // /occurrences/:id/assignments
    const occAssignments = path.match(/^\/occurrences\/(\d+)\/assignments$/);
    if (occAssignments && method === 'GET') {
      const id = Number(occAssignments[1]);
      return json(await getAssignments(db, id));
    }
    // /occurrences/:id ({status|date})
    const occId = path.match(/^\/occurrences\/(\d+)$/);
    if (occId && method === 'PUT') {
      const id = Number(occId[1]);
      const b = (await request.json()) as { status?: string; date?: string };
      if (b.status !== undefined) {
        if (b.status !== 'scheduled' && b.status !== 'cancelled') {
          return json({ error: 'invalid status' }, 400);
        }
        const ok = await setOccurrenceStatus(db, id, b.status);
        return json({ ok }, ok ? 200 : 404);
      }
      if (b.date !== undefined) {
        if (!b.date) return json({ error: 'date required' }, 400);
        const ok = await updateOccurrenceDate(db, id, b.date);
        return json({ ok }, ok ? 200 : 404);
      }
      return json({ error: 'status or date required' }, 400);
    }

    // ============ responses ============
    if (path === '/responses' && method === 'GET') {
      const limit = parseLimit(url.searchParams.get('limit'), 200);
      return json(await listRecentResponses(db, limit));
    }

    return json({ error: 'Not found' }, 404);
  } catch (e) {
    console.error('[Admin] error:', (e as Error).message);
    return json({ error: 'Internal error' }, 500);
  }
}
