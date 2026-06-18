import type { Env } from '../env';
import type { Member, Notification, Occurrence } from '../db/types';
import { resolveDisplayName } from '../db/types';
import { listActiveNotifications } from '../db/notifications';
import {
  getOccurrence,
  getOrCreateOccurrence,
  listScheduledOccurrences,
} from '../db/occurrences';
import {
  getResponsesForOccurrence,
  getUndecidedForOccurrence,
  checkQuotaForNotification,
} from '../db/responses';
import { getActiveSegmentMembers, getSegment } from '../db/segments';
import { syncSegmentFromRole } from '../discord/syncSegment';
import { nextOccurrenceDate } from '../lib/recurrence';
import { getDaysUntil, getJSTNow, formatOccurrenceLabel } from '../lib/date';
import {
  sendChannelMessage,
  sendDirectMessageCached,
  createButtonComponents,
  createStatusAllButton,
  buildMentionPrefix,
  composePost,
  listGuildMembers,
  DISCORD_CONTENT_LIMIT,
  type GuildMemberSummary,
} from '../discord/rest';
import type { Segment } from '../db/types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DM_INTERVAL_MS = 300;

/** 回答不要（通知のみ）か。recurring かつ requires_response=0 のとき true（ADR 0010）。 */
function isAnnounceOnly(n: Notification): boolean {
  return n.type === 'recurring' && !n.requires_response;
}

/**
 * 投稿の @メンション接頭辞を mention_mode に従って解決する（ADR 0010）。
 * 'members' のときだけ区分のアクティブメンバーを取得して `<@id>` 列挙の材料にする。
 * budget はバイネーム接頭辞に割ける字数（呼び出し側が本文長から逆算して渡す）。
 */
async function mentionPrefixFor(
  env: Env,
  n: Notification,
  segment: Segment | null,
  budget?: number,
): Promise<string> {
  if (!segment || n.mention_mode === 'none') return '';
  let memberIds: string[] = [];
  if (n.mention_mode === 'members') {
    const members = await getActiveSegmentMembers(env.DB, n.segment_id);
    memberIds = members.map((m) => m.user_id);
  }
  return buildMentionPrefix(segment, n.mention_mode, memberIds, budget);
}

/**
 * Discord 側のメンション解析対象を mention_mode に絞る allowed_mentions を返す（ADR 0010）。
 * 本文(message_body)に書かれた @everyone 等で意図しない一斉メンションが飛ぶのを防ぐ。
 * - none: 何もメンションしない / role: ロール（@everyone は everyone）/ members: ユーザーのみ
 */
function allowedMentionsFor(n: Notification, segment: Segment | null): { parse: string[] } {
  if (n.mention_mode === 'none') return { parse: [] };
  if (n.mention_mode === 'members') return { parse: ['users'] };
  if (segment && segment.mention_role_id === '@everyone') return { parse: ['everyone'] };
  return { parse: ['roles'] };
}

/**
 * チャンネル投稿の本文を合成する（ADR 0010）。見出し/本文/日時(tail)の実長から
 * バイネームに割ける字数を逆算し、合成後が Discord の content 上限を超えないようにする。
 */
async function composeChannelPost(
  env: Env,
  n: Notification,
  segment: Segment | null,
  tail: string,
): Promise<string> {
  const restLen = composePost('', n.message_title, n.message_body, tail).length;
  const budget = Math.max(0, DISCORD_CONTENT_LIMIT - restLen);
  const prefix = await mentionPrefixFor(env, n, segment, budget);
  return composePost(prefix, n.message_title, n.message_body, tail);
}

/** スロットの表示時刻（occ.start_time 優先・空なら通知の既定 start_time）。 */
function slotTime(occ: Occurrence, n: Notification): string {
  return occ.start_time || n.start_time;
}
/** 'YYYY/MM/DD (曜) HH:MM〜HH:MM' のスロット表示ラベル（duration 未設定なら開放端「HH:MM〜」）。 */
function slotLabel(occ: Occurrence, n: Notification): string {
  return formatOccurrenceLabel(occ.occurrence_date, slotTime(occ, n), n.duration_minutes);
}

/** [PRD 4.2.1] 募集 */
async function sendRecruitment(
  env: Env,
  n: Notification,
  occ: Occurrence,
): Promise<boolean> {
  const segment = await getSegment(env.DB, n.segment_id);
  // 見出し（必須）＋本文（任意）＋日時行（自動）。回答不要(announce-only)はボタンを付けない。
  const message = await composeChannelPost(env, n, segment, `日時: **${slotLabel(occ, n)}**`);
  const components = isAnnounceOnly(n) ? null : createButtonComponents(occ.id, n.type);
  const ok = await sendChannelMessage(env, n.channel_id, message, components, allowedMentionsFor(n, segment));
  console.log(ok ? `✅ [Recruitment] sent (n=${n.id})` : `❌ [Recruitment] failed (n=${n.id})`);
  return ok;
}

/**
 * [PRD 4.2.1] 単発・複数候補日の募集。候補日一覧のヘッダ（メンションはここで1回）に続けて、
 * 候補日ごとに 1 メッセージ（参加/不参加/未定/状況確認ボタン付き）を投稿する。
 * ボタン custom_id は {action}_{occurrenceId} で開催回単位なので回答ハンドラは無改修で機能する。
 * 募集 UI（/recruit・管理画面の「今すぐ募集」）からも再利用する。
 */
export async function sendCandidateRecruitment(
  env: Env,
  n: Notification,
  occs: Occurrence[],
): Promise<number> {
  if (occs.length === 0) return 0;
  const segment = await getSegment(env.DB, n.segment_id);
  const list = occs.map((o, i) => `${i + 1}. **${slotLabel(o, n)}**`).join('\n');
  // 見出し/本文（カスタム）に、候補投票の操作ガイド＋候補一覧をシステム後段として続ける。
  const guide =
    `下の各候補について、ボタンで回答してください（都合のつく候補すべてに「可」を選べます）。\n` +
    `全体の状況は下の「📊 全候補の状況」ボタンで確認できます。\n\n${list}`;
  const header = await composeChannelPost(env, n, segment, guide);
  // ヘッダに全候補の状況をまとめて返す集約ボタンを1つ付ける（各候補には状況確認を付けない）。
  const headerOk = await sendChannelMessage(
    env, n.channel_id, header, createStatusAllButton(n.id), allowedMentionsFor(n, segment),
  );
  if (!headerOk) console.error(`❌ [CandidateRecruitment] header failed (n=${n.id})`);
  await sleep(DM_INTERVAL_MS);

  let sent = 0;
  for (const o of occs) {
    const msg = `🗓️ **${slotLabel(o, n)}** の可否`;
    const ok = await sendChannelMessage(env, n.channel_id, msg, createButtonComponents(o.id, n.type, false));
    if (ok) sent++;
    else console.error(`❌ [CandidateRecruitment] failed (n=${n.id}, occ=${o.id})`);
    await sleep(DM_INTERVAL_MS); // チャンネル連投のレート制限対策
  }
  console.log(`✅ [CandidateRecruitment] sent ${sent}/${occs.length} (n=${n.id})`);
  return sent;
}

/**
 * 募集を即時実行する（スラッシュコマンド /recruit と管理画面「今すぐ募集」で共用）。
 * 単発・複数候補日（未確定）は候補回をまとめて募集、それ以外は次回開催回を 1 件募集する。
 */
export async function recruitNotificationNow(
  env: Env,
  n: Notification,
): Promise<{ ok: boolean; message: string }> {
  const db = env.DB;
  const segment = await getSegment(db, n.segment_id);
  if (!segment) return { ok: false, message: `対象の区分 #${n.segment_id} が見つかりません。` };

  // 単発: 確定済みは確定回を、未確定は候補回（複数なら一括／1件ならそれ）を募集する。
  // 確定済みで最早でないスロットを選んだ場合に nextOccurrenceDate(=one_off_date=最早)を掴んで
  // cancelled スロットで失敗する不具合を避けるため、確定回は id で直接対象にする。
  if (n.type === 'oneoff') {
    if (n.decided_occurrence_id != null) {
      const occ = await getOccurrence(db, n.decided_occurrence_id);
      if (!occ || occ.status !== 'scheduled') {
        return { ok: false, message: '確定した開催回が見つかりません（確定解除や削除の可能性）。' };
      }
      const sentOk = await sendRecruitment(env, n, occ);
      return sentOk
        ? { ok: true, message: `**${formatOccurrenceLabel(occ.occurrence_date, slotTime(occ, n), n.duration_minutes)}** の募集メッセージを送信しました!` }
        : { ok: false, message: '募集メッセージの送信に失敗しました（文字数超過や Discord エラーの可能性）。' };
    }
    const candidates = await listScheduledOccurrences(db, n.id);
    // 候補回が未生成の旧データは one_off_date から 1 件だけ補完
    if (candidates.length === 0 && n.one_off_date) {
      candidates.push(await getOrCreateOccurrence(db, n.id, n.one_off_date, n.start_time));
    }
    const live = candidates.filter((o) => o.status === 'scheduled');
    if (live.length === 0) return { ok: false, message: '募集できる候補日がありません。' };
    if (live.length > 1) {
      const sent = await sendCandidateRecruitment(env, n, live);
      return sent > 0
        ? { ok: true, message: `${live.length} 件の候補日について募集メッセージを送信しました!` }
        : { ok: false, message: '募集メッセージの送信に失敗しました。' };
    }
    const liveOk = await sendRecruitment(env, n, live[0]);
    return liveOk
      ? { ok: true, message: `**${formatOccurrenceLabel(live[0].occurrence_date, slotTime(live[0], n), n.duration_minutes)}** の募集メッセージを送信しました!` }
      : { ok: false, message: '募集メッセージの送信に失敗しました（文字数超過や Discord エラーの可能性）。' };
  }

  // recurring: 次回開催回を 1 件募集
  const target = nextOccurrenceDate(n);
  if (!target) {
    return { ok: false, message: '次回の開催日を特定できませんでした（rrule を確認してください）。' };
  }
  const occ = await getOrCreateOccurrence(db, n.id, target, n.start_time);
  if (occ.status === 'cancelled') {
    return { ok: false, message: `**${target}** の開催回は中止扱いのため募集できません。` };
  }
  const recurOk = await sendRecruitment(env, n, occ);
  return recurOk
    ? { ok: true, message: `**${formatOccurrenceLabel(occ.occurrence_date, slotTime(occ, n), n.duration_minutes)}** の募集メッセージを送信しました!` }
    : { ok: false, message: '募集メッセージの送信に失敗しました（文字数超過や Discord エラーの可能性）。' };
}

/** [PRD 4.2.4] ノルマ確認（個別 DM） */
async function checkQuotaAndNotify(env: Env, n: Notification): Promise<void> {
  const db = env.DB;
  const alerts = await checkQuotaForNotification(db, n);
  if (alerts.length === 0) {
    console.log(`[Quota] all within interval (n=${n.id})`);
    return;
  }

  let sent = 0;
  for (const member of alerts) {
    // checkQuotaForNotification は未参加者を除外して返すため daysSinceLast は常に正値。
    const daysText = `${member.daysSinceLast}日前`;
    const message =
      `📊 **参加間隔の確認**\n\n` +
      `こんにちは、**${resolveDisplayName(member)}** さん！\n` +
      `前回のイベント参加から少し時間が空いているようです（目安: ${n.quota_interval_days}日に1回）。\n\n` +
      `- 最終参加: **${member.lastDateStr}** (${daysText})\n\n` +
      `次回のイベントへの参加をぜひご検討ください！お待ちしています✨`;
    const ok = await sendDirectMessageCached(env, db, member, message);
    if (ok) sent++;
    else console.error(`❌ [Quota] DM failed: ${member.user_name}`);
    await sleep(DM_INTERVAL_MS);
  }
  console.log(`✅ [Quota] sent ${sent}/${alerts.length} (n=${n.id})`);
}

/** [PRD 4.2.2] 未回答リマインド（個別 DM）。対象=区分アクティブメンバー − 既回答 */
async function sendUnansweredReminder(
  env: Env,
  n: Notification,
  occ: Occurrence,
  daysUntil: number,
): Promise<void> {
  const db = env.DB;
  const members = await getActiveSegmentMembers(db, n.segment_id);
  const responses = await getResponsesForOccurrence(db, occ.id);

  const unanswered = members.filter((m) => !responses[m.user_id]);
  if (unanswered.length === 0) {
    console.log(`[Unanswered] all responded (n=${n.id})`);
    return;
  }

  const dayText = daysUntil === 0 ? '今日' : `あと${daysUntil}日`;
  let sent = 0;
  for (const member of unanswered) {
    const message =
      `⏰ **リマインド: ${dayText}のイベント**\n\n` +
      `日時: **${slotLabel(occ, n)}**\n\n` +
      `まだ回答されていません。下のボタンで参加状況を回答してください!`;
    const ok = await sendDirectMessageCached(
      env,
      db,
      member,
      message,
      createButtonComponents(occ.id, n.type),
    );
    if (ok) sent++;
    else console.error(`❌ [Unanswered] DM failed: ${member.user_name}`);
    await sleep(DM_INTERVAL_MS);
  }
  console.log(`✅ [Unanswered] DM sent ${sent}/${unanswered.length} (n=${n.id})`);
}

/** [PRD 4.2.3] 未定者リマインド（個別 DM）。休止者は除外 */
async function sendUndecidedReminder(
  env: Env,
  n: Notification,
  occ: Occurrence,
): Promise<void> {
  const db = env.DB;
  const undecided = await getUndecidedForOccurrence(db, occ.id);
  if (undecided.length === 0) {
    console.log(`[Undecided] none (n=${n.id})`);
    return;
  }

  // 休止者を除外するため、区分のアクティブメンバーを母集団とする。
  const activeMembers = await getActiveSegmentMembers(db, n.segment_id);
  const activeById = new Map(activeMembers.map((m) => [m.user_id, m]));

  const targets: Member[] = [];
  for (const u of undecided) {
    // 区分でアクティブな未定者のみ対象（休止・未所属はスキップ）
    const active = activeById.get(u.userId);
    if (active) targets.push(active);
  }
  if (targets.length === 0) {
    console.log(`[Undecided] no active targets (n=${n.id})`);
    return;
  }

  let sent = 0;
  for (const member of targets) {
    const message =
      `❓ **未定者へのリマインド**\n\n` +
      `日時: **${slotLabel(occ, n)}**\n\n` +
      `現在「未定」で回答されています。下のボタンで参加/不参加を確定してください!`;
    const ok = await sendDirectMessageCached(
      env,
      db,
      member,
      message,
      createButtonComponents(occ.id, n.type),
    );
    if (ok) sent++;
    else console.error(`❌ [Undecided] DM failed: ${member.user_name}`);
    await sleep(DM_INTERVAL_MS);
  }
  console.log(`✅ [Undecided] DM sent ${sent}/${targets.length} (n=${n.id})`);
}

/** 1 開催回に対する未回答/未定リマインドを daysUntil ゲートで実行する（recurring / oneoff 共通）。 */
async function remindForOccurrence(
  env: Env,
  n: Notification,
  occ: Occurrence,
  daysUntil: number,
): Promise<void> {
  if (occ.status === 'cancelled') return;

  // 未回答リマインド
  if (daysUntil >= 0 && daysUntil <= n.remind_start_days) {
    let proceed = true;
    if (daysUntil === 0) {
      // 当日は開始時刻前のみ。スロット固有時刻(slotTime)で判定する（同日複数時刻スロットを正しく扱う）。
      // cron が開始時刻と同時の場合は実質 no-op。
      const now = getJSTNow();
      const [h, m] = slotTime(occ, n).split(':').map(Number);
      proceed = now.getHours() * 60 + now.getMinutes() < h * 60 + m;
    }
    if (proceed) await sendUnansweredReminder(env, n, occ, daysUntil);
  }

  // 未定者リマインド
  if (daysUntil === n.remind_undecided_days) {
    await sendUndecidedReminder(env, n, occ);
  }
}

/** recurring / 単一候補 oneoff（従来挙動）。nextOccurrenceDate の 1 開催回を処理する。 */
async function processSingleOccurrence(env: Env, n: Notification): Promise<void> {
  const db = env.DB;
  const target = nextOccurrenceDate(n);
  if (!target) {
    console.log(`[n=${n.id}] no next occurrence, skip`);
    return;
  }
  const daysUntil = getDaysUntil(target);
  console.log(`[n=${n.id}] Target: ${target}, daysUntil: ${daysUntil}`);

  // 回答不要（通知のみ）は告知だけ。ノルマ・未回答/未定リマインドは回答前提のため対象外（ADR 0010）。
  const announceOnly = isAnnounceOnly(n);

  // 募集/告知 & ノルマ確認（募集開始日に同時実行）
  if (daysUntil === n.recruit_days_before) {
    const occ = await getOrCreateOccurrence(db, n.id, target, n.start_time);
    if (occ.status === 'cancelled') {
      console.log(`[n=${n.id}] occurrence cancelled, skip recruitment`);
    } else {
      await sendRecruitment(env, n, occ);
      if (!announceOnly && n.quota_enabled) await checkQuotaAndNotify(env, n);
    }
  }

  // リマインド（回答不要ならスキップ）。同じ開催回を再取得。
  if (!announceOnly) {
    const occ = await getOrCreateOccurrence(db, n.id, target, n.start_time);
    await remindForOccurrence(env, n, occ, daysUntil);
  }
}

/**
 * 単発・複数候補日。募集は管理画面／スラッシュコマンドからの手動送信に一本化したため、cron では
 * 自動募集を行わない（完全一致ゲートの取りこぼしや手動との二重投稿を避ける）。
 * cron はリマインドのみを候補回ごとに自分の日付で判定する。確定済み(decided_occurrence_id)なら確定回のみ対象。
 */
async function processOneoffCandidates(env: Env, n: Notification): Promise<void> {
  const db = env.DB;

  // リマインド対象の決定。単発の出席リマインドは「確定後の確定回のみ」を対象にする
  //（確定前に複数候補へ当日 DM が乱発するのを防ぐ）。募集は手動送信のため cron では送らない。
  let target: Occurrence | null = null;
  if (n.decided_occurrence_id != null) {
    const occ = await getOccurrence(db, n.decided_occurrence_id);
    target = occ && occ.status === 'scheduled' ? occ : null;
  } else {
    const scheduled = await listScheduledOccurrences(db, n.id);
    if (scheduled.length === 1) {
      target = scheduled[0]; // 候補が1つだけなら実質確定とみなしてリマインドする
    } else if (scheduled.length === 0 && n.one_off_date) {
      // 後方互換: 候補回未生成の旧データは one_off_date を 1 回だけ対象に
      target = await getOrCreateOccurrence(db, n.id, n.one_off_date, n.start_time);
    }
    // 複数候補（未確定）はリマインドを保留（確定後に送る）
  }

  if (!target || target.status !== 'scheduled') {
    console.log(`[n=${n.id}] oneoff: リマインド対象なし（未確定の複数候補 / 候補なし）, skip`);
    return;
  }

  await remindForOccurrence(env, n, target, getDaysUntil(target.occurrence_date));
}

/**
 * [PRD 4.2] 日次メインチェック。active な Notification をすべてループし、
 * recurring / 単一候補 oneoff は従来どおり、単発・複数候補日は候補回ごとに
 * 募集 & ノルマ / 未回答リマインド / 未定リマインドを判定・実行する。
 */
export async function mainDailyCheck(env: Env): Promise<void> {
  console.log('=== mainDailyCheck START ===');
  const notifications = await listActiveNotifications(env.DB);
  console.log(`Active notifications: ${notifications.length}`);

  // ロール管理区分を Discord ロールから同期してから処理する（ADR 0009）。
  // 有効通知が参照する区分のみ。ギルド単位でメンバーを1回だけ取得して使い回す（重複フェッチ回避）。
  // cron は無人化/取得失敗をスキップ（allowEmpty=false）。1区分の同期失敗で後続処理を止めない（try/catch）。
  const segmentIds = [...new Set(notifications.map((n) => n.segment_id))];
  const guildMembersCache = new Map<string, GuildMemberSummary[] | null>();
  for (const segId of segmentIds) {
    try {
      const seg = await getSegment(env.DB, segId);
      if (!seg || !seg.mention_role_id) continue;
      if (!guildMembersCache.has(seg.guild_id)) {
        try {
          guildMembersCache.set(seg.guild_id, await listGuildMembers(env, seg.guild_id));
        } catch (e) {
          console.error(`[SegmentSync] guild members fetch failed (guild=${seg.guild_id}): ${(e as Error).message}`);
          guildMembersCache.set(seg.guild_id, null);
        }
      }
      const members = guildMembersCache.get(seg.guild_id);
      if (!members) continue; // 取得失敗ギルドはスキップ（既存メンバーを維持）
      const r = await syncSegmentFromRole(env, seg, { allowEmpty: false, members });
      console.log(
        `[SegmentSync] seg=${segId} ${r.ok ? `+${r.added}/-${r.removed} (=${r.total})` : 'skip: ' + r.message}`,
      );
    } catch (e) {
      console.error(`[SegmentSync] seg=${segId} failed: ${(e as Error).message}`);
    }
  }

  for (const n of notifications) {
    if (n.type === 'oneoff') {
      await processOneoffCandidates(env, n);
    } else {
      await processSingleOccurrence(env, n);
    }
  }

  console.log('=== mainDailyCheck END ===');
}
