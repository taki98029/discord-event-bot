import type { Env } from '../env';
import type { Config, Member } from '../db/types';
import { getAllConfig } from '../db/config';
import { getAllMembers } from '../db/members';
import { getEventLogsForDate, getUndecided, checkQuota } from '../db/eventLog';
import { sendChannelMessage, createButtonComponents, sendDirectMessageCached } from '../discord/rest';
import { getTargetDate, formatDate, getDaysUntilEvent, getJSTNow } from '../lib/date';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DM_INTERVAL_MS = 300;

/** Recruit_Mention からメンション接頭辞を生成（旧 buildMentionPrefix） */
function buildMentionPrefix(mentionValue: string | undefined): string {
  if (!mentionValue || mentionValue.trim() === '') return '';
  if (mentionValue === '@everyone' || mentionValue === 'everyone') return '@everyone\n\n';
  return `<@&${mentionValue.trim()}>\n\n`;
}

/** [PRD 4.2.1] 募集 */
async function sendRecruitment(env: Env, targetDateStr: string, config: Config): Promise<void> {
  const message =
    `${buildMentionPrefix(config.Recruit_Mention)}📅 **イベント募集開始!**\n\n` +
    `日時: **${targetDateStr} (${config.Event_DayOfWeek}) ${config.Event_StartTime}~**\n\n` +
    `参加状況を下のボタンで回答してください!`;
  const ok = await sendChannelMessage(env, message, createButtonComponents(targetDateStr));
  console.log(ok ? '✅ [Recruitment] sent' : '❌ [Recruitment] failed');
}

/** [PRD 4.2.2] 未回答リマインド（個別 DM） */
async function sendUnansweredReminder(
  env: Env,
  targetDateStr: string,
  daysUntil: number,
): Promise<void> {
  const db = env.DB;
  const members = await getAllMembers(db);
  const eventLogs = await getEventLogsForDate(db, targetDateStr);

  const unanswered = members.filter((m) => !m.status && !eventLogs[m.user_id]);
  if (unanswered.length === 0) {
    console.log('[Unanswered] all responded');
    return;
  }

  const dayText = daysUntil === 0 ? '今日' : `あと${daysUntil}日`;
  let sent = 0;
  for (const member of unanswered) {
    const message =
      `⏰ **リマインド: ${dayText}のイベント**\n\n` +
      `日時: **${targetDateStr}**\n\n` +
      `まだ回答されていません。下のボタンで参加状況を回答してください!`;
    const ok = await sendDirectMessageCached(env, db, member, message, createButtonComponents(targetDateStr));
    if (ok) sent++;
    else console.error(`❌ [Unanswered] DM failed: ${member.user_name}`);
    await sleep(DM_INTERVAL_MS);
  }
  console.log(`✅ [Unanswered] DM sent ${sent}/${unanswered.length}`);
}

/** [PRD 4.2.3] 未定者リマインド（個別 DM） */
async function sendUndecidedReminder(env: Env, targetDateStr: string): Promise<void> {
  const db = env.DB;
  const undecided = await getUndecided(db, targetDateStr);
  if (undecided.length === 0) {
    console.log('[Undecided] none');
    return;
  }

  const members = await getAllMembers(db);
  const byId = new Map(members.map((m) => [m.user_id, m]));

  // 休止中メンバーは除外。メンバー未登録のレアケースは合成オブジェクトで DM。
  const targets: Member[] = [];
  for (const u of undecided) {
    const m = byId.get(u.userId);
    if (m) {
      if (!m.status) targets.push(m);
    } else {
      targets.push({
        user_id: u.userId,
        user_name: u.name,
        status: '',
        display_name: u.name,
        dm_channel_id: null,
        created_at: '',
      });
    }
  }
  if (targets.length === 0) {
    console.log('[Undecided] no active targets');
    return;
  }

  let sent = 0;
  for (const member of targets) {
    const message =
      `❓ **未定者へのリマインド**\n\n` +
      `日時: **${targetDateStr}**\n\n` +
      `現在「未定」で回答されています。下のボタンで参加/不参加を確定してください!`;
    const ok = await sendDirectMessageCached(env, db, member, message, createButtonComponents(targetDateStr));
    if (ok) sent++;
    else console.error(`❌ [Undecided] DM failed: ${member.user_name}`);
    await sleep(DM_INTERVAL_MS);
  }
  console.log(`✅ [Undecided] DM sent ${sent}/${targets.length}`);
}

/** [PRD 4.2.4] ノルマ確認（個別 DM） */
async function checkQuotaAndNotify(env: Env, config: Config): Promise<void> {
  const db = env.DB;
  const intervalDays = Number(config.Quota_Interval_Days);
  if (!intervalDays) {
    console.log('[Quota] interval not set, skip');
    return;
  }

  const alerts = await checkQuota(db, intervalDays);
  if (alerts.length === 0) {
    console.log('[Quota] all within interval');
    return;
  }

  let sent = 0;
  for (const member of alerts) {
    const daysText = member.daysSinceLast === -1 ? '未参加' : `${member.daysSinceLast}日前`;
    const message =
      `📊 **参加間隔の確認**\n\n` +
      `こんにちは、**${member.display_name || member.user_name || member.user_id}** さん！\n` +
      `前回のイベント参加から少し時間が空いているようです（目安: ${intervalDays}日に1回）。\n\n` +
      `- 最終参加: **${member.lastDateStr}** (${daysText})\n\n` +
      `次回のイベントへの参加をぜひご検討ください！お待ちしています✨`;
    const ok = await sendDirectMessageCached(env, db, member, message);
    if (ok) sent++;
    else console.error(`❌ [Quota] DM failed: ${member.user_name}`);
    await sleep(DM_INTERVAL_MS);
  }
  console.log(`✅ [Quota] sent ${sent}/${alerts.length}`);
}

/** [PRD 4.2] 日次メインチェック（旧 mainDailyCheck） */
export async function mainDailyCheck(env: Env): Promise<void> {
  console.log('=== mainDailyCheck START ===');
  const config = await getAllConfig(env.DB);

  const targetDate = getTargetDate({
    eventDayOfWeek: config.Event_DayOfWeek,
    eventStartTime: config.Event_StartTime,
  });
  const targetDateStr = formatDate(targetDate);
  const daysUntil = getDaysUntilEvent(targetDate);
  console.log(`Target: ${targetDateStr}, daysUntil: ${daysUntil}`);

  const recruitDays = Number(config.Recruit_DaysBefore);
  const remindStartDays = Number(config.Remind_Start_Days);
  const remindUndecidedDays = Number(config.Remind_Undecided_Days);

  // 募集 & ノルマ確認（募集開始日に同時実行）
  if (daysUntil === recruitDays) {
    await sendRecruitment(env, targetDateStr, config);
    await checkQuotaAndNotify(env, config);
  }

  // 未回答リマインド
  if (daysUntil <= remindStartDays && daysUntil >= 0) {
    if (daysUntil === 0) {
      // 当日は開始時刻前のみ（現挙動を踏襲。cron が開始時刻と同時の場合は実質 no-op）
      const now = getJSTNow();
      const [h, m] = config.Event_StartTime.split(':').map(Number);
      if (now.getHours() * 60 + now.getMinutes() < h * 60 + m) {
        await sendUnansweredReminder(env, targetDateStr, daysUntil);
      }
    } else {
      await sendUnansweredReminder(env, targetDateStr, daysUntil);
    }
  }

  // 未定者リマインド
  if (daysUntil === remindUndecidedDays) {
    await sendUndecidedReminder(env, targetDateStr);
  }

  console.log('=== mainDailyCheck END ===');
}
