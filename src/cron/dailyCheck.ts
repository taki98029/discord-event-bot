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
import { nextOccurrenceDate } from '../lib/recurrence';
import { getDaysUntil, getJSTNow } from '../lib/date';
import {
  sendChannelMessage,
  sendDirectMessageCached,
  createButtonComponents,
  buildMentionPrefix,
} from '../discord/rest';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DM_INTERVAL_MS = 300;

/** 'YYYY/MM/DD' の曜日（JST 壁時計）。0=日 → '日' */
const WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'];
function weekdayLabel(dateStr: string): string {
  const [y, m, d] = dateStr.split('/').map(Number);
  return WEEKDAY_LABELS[new Date(y, m - 1, d).getDay()];
}

/** スロットの表示時刻（occ.start_time 優先・空なら通知の既定 start_time）。 */
function slotTime(occ: Occurrence, n: Notification): string {
  return occ.start_time || n.start_time;
}
/** 'YYYY/MM/DD (曜) HH:MM~' のスロット表示ラベル。 */
function slotLabel(occ: Occurrence, n: Notification): string {
  return `${occ.occurrence_date} (${weekdayLabel(occ.occurrence_date)}) ${slotTime(occ, n)}~`;
}

/** [PRD 4.2.1] 募集 */
async function sendRecruitment(
  env: Env,
  n: Notification,
  occ: Occurrence,
): Promise<void> {
  const segment = await getSegment(env.DB, n.segment_id);
  const prefix = segment ? buildMentionPrefix(segment, !!n.mention_enabled) : '';
  const message =
    `${prefix}📅 **イベント募集開始!**\n\n` +
    `日時: **${slotLabel(occ, n)}**\n\n` +
    `参加状況を下のボタンで回答してください!`;
  const ok = await sendChannelMessage(
    env,
    n.channel_id,
    message,
    createButtonComponents(occ.id),
  );
  console.log(ok ? `✅ [Recruitment] sent (n=${n.id})` : `❌ [Recruitment] failed (n=${n.id})`);
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
  const prefix = segment ? buildMentionPrefix(segment, !!n.mention_enabled) : '';
  const list = occs.map((o, i) => `${i + 1}. **${slotLabel(o, n)}**`).join('\n');
  const header =
    `${prefix}📅 **イベント候補日の出欠募集!**\n\n` +
    `下の各候補について、ボタンで回答してください（参加できる候補は複数選べます）。\n\n${list}`;
  await sendChannelMessage(env, n.channel_id, header);
  await sleep(DM_INTERVAL_MS);

  let sent = 0;
  for (const o of occs) {
    const msg = `🗓️ **${slotLabel(o, n)}** の出欠`;
    const ok = await sendChannelMessage(env, n.channel_id, msg, createButtonComponents(o.id));
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

  if (n.type === 'oneoff' && n.decided_occurrence_id == null) {
    const candidates = await listScheduledOccurrences(db, n.id);
    if (candidates.length > 1) {
      const sent = await sendCandidateRecruitment(env, n, candidates);
      return sent > 0
        ? { ok: true, message: `${candidates.length} 件の候補日について募集メッセージを送信しました!` }
        : { ok: false, message: '募集メッセージの送信に失敗しました。' };
    }
  }

  const target = nextOccurrenceDate(n);
  if (!target) {
    return { ok: false, message: '次回の開催日を特定できませんでした（rrule / 候補日を確認してください）。' };
  }
  const occ = await getOrCreateOccurrence(db, n.id, target, n.start_time);
  if (occ.status === 'cancelled') {
    return { ok: false, message: `**${target}** の開催回は中止扱いのため募集できません。` };
  }
  await sendRecruitment(env, n, occ);
  return { ok: true, message: `**${target}** の募集メッセージを送信しました!` };
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
      createButtonComponents(occ.id),
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
      createButtonComponents(occ.id),
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
      // 当日は開始時刻前のみ（現挙動を踏襲。cron が開始時刻と同時の場合は実質 no-op）
      const now = getJSTNow();
      const [h, m] = n.start_time.split(':').map(Number);
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

  // 募集 & ノルマ確認（募集開始日に同時実行）
  if (daysUntil === n.recruit_days_before) {
    const occ = await getOrCreateOccurrence(db, n.id, target, n.start_time);
    if (occ.status === 'cancelled') {
      console.log(`[n=${n.id}] occurrence cancelled, skip recruitment`);
    } else {
      await sendRecruitment(env, n, occ);
      if (n.quota_enabled) await checkQuotaAndNotify(env, n);
    }
  }

  // リマインド（同じ開催回を再取得）
  const occ = await getOrCreateOccurrence(db, n.id, target, n.start_time);
  await remindForOccurrence(env, n, occ, daysUntil);
}

/**
 * 単発・複数候補日。候補回（status='scheduled'）を母集合に、最早候補日が募集日に達したら一括募集、
 * リマインドは候補回ごとに自分の日付で判定する。確定済み(decided_occurrence_id)なら確定回のみ対象。
 */
async function processOneoffCandidates(env: Env, n: Notification): Promise<void> {
  const db = env.DB;

  // 対象候補回の決定（確定済みなら確定回のみ）
  let candidates: Occurrence[];
  if (n.decided_occurrence_id != null) {
    const occ = await getOccurrence(db, n.decided_occurrence_id);
    candidates = occ && occ.status === 'scheduled' ? [occ] : [];
  } else {
    candidates = await listScheduledOccurrences(db, n.id);
    // 後方互換: 候補回が未生成なら one_off_date から 1 回だけ生成して扱う
    if (candidates.length === 0 && n.one_off_date) {
      candidates = [await getOrCreateOccurrence(db, n.id, n.one_off_date, n.start_time)];
    }
  }
  if (candidates.length === 0) {
    console.log(`[n=${n.id}] oneoff: no candidate occurrences, skip`);
    return;
  }

  // 募集 & ノルマ: 最早候補日が recruit_days_before に達したら実行
  const earliest = candidates[0]; // listScheduledOccurrences は日付昇順
  const daysToEarliest = getDaysUntil(earliest.occurrence_date);
  console.log(`[n=${n.id}] oneoff candidates: ${candidates.length}, earliest in ${daysToEarliest}d`);
  if (daysToEarliest === n.recruit_days_before) {
    if (n.decided_occurrence_id == null && candidates.length > 1) {
      await sendCandidateRecruitment(env, n, candidates);
    } else {
      await sendRecruitment(env, n, candidates[0]);
    }
    if (n.quota_enabled) await checkQuotaAndNotify(env, n);
  }

  // リマインドは候補回ごとに自分の日付で判定
  for (const occ of candidates) {
    await remindForOccurrence(env, n, occ, getDaysUntil(occ.occurrence_date));
  }
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

  for (const n of notifications) {
    if (n.type === 'oneoff') {
      await processOneoffCandidates(env, n);
    } else {
      await processSingleOccurrence(env, n);
    }
  }

  console.log('=== mainDailyCheck END ===');
}
