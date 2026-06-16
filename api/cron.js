/**
 * Vercel Cron Job Endpoint - 日次チェック
 * [PRD 4.2] 機能実行判定 (mainDailyCheck)
 */

const { getAllConfig, getAllMembers, getEventLog, getParticipationCount, getUndecidedUsers, checkQuotaStatus, getEventLogsForDate } = require('../lib/sheets');
const { formatDate, getTargetDate, getDaysUntilEvent, getJSTNow } = require('../lib/date-utils');
const { sendDiscordMessage, createButtonComponents, mentionUser, sendDirectMessage } = require('../lib/discord');

/**
 * Recruit_Mention設定からメンション文字列を生成
 * @param {string} mentionValue - Config値 (ロールID, @everyone, 空)
 * @returns {string} メンション文字列 (末尾に改行2つ付き、空の場合は空文字)
 */
function buildMentionPrefix(mentionValue) {
    if (!mentionValue || mentionValue.trim() === '') {
        return '';
    }
    if (mentionValue === '@everyone' || mentionValue === 'everyone') {
        return '@everyone\n\n';
    }
    // ロールIDとして扱う → <@&ROLE_ID> 形式
    return `<@&${mentionValue.trim()}>\n\n`;
}

/**
 * [PRD 4.2.1] 募集 (Recruitment)
 * 条件: daysUntilEvent == Recruit_DaysBefore
 */
async function sendRecruitment(targetDateStr, config) {
    const mentionPrefix = buildMentionPrefix(config.Recruit_Mention);

    const message = `${mentionPrefix}📅 **イベント募集開始!**\n\n` +
        `日時: **${targetDateStr} (${config.Event_DayOfWeek}) ${config.Event_StartTime}~**\n\n` +
        `参加状況を下のボタンで回答してください!`;

    const components = createButtonComponents(targetDateStr);

    const success = await sendDiscordMessage(message, components);
    if (success) {
        console.log('✅ [Recruitment] Message sent');
    } else {
        console.error('❌ [Recruitment] Failed to send message');
    }
}

/**
 * [PRD 4.2.2] 未回答リマインド (Unanswered Loop)
 * 条件: daysUntilEvent <= Remind_Start_Days かつ daysUntilEvent >= 0
 * 休止中メンバーは除外し、DMで個別送信
 */
async function sendUnansweredReminder(targetDateStr, daysUntil) {
    const members = await getAllMembers();
    const unanswered = [];

    // [Performance] N+1問題を解消: Event_Logを一括取得
    const eventLogs = await getEventLogsForDate(targetDateStr);

    // [PRD 4.2.2] Member_DB の全メンバーをループ
    for (const member of members) {
        // Statusが設定されているメンバーは除外 ('休止中'など)
        if (member.status) {
            continue;
        }

        // ログが存在しない場合のみ、リストに追加
        if (!eventLogs[member.userId]) {
            unanswered.push(member);
        }
    }

    if (unanswered.length === 0) {
        console.log('[Unanswered] All members have responded');
        return;
    }

    const dayText = daysUntil === 0 ? '今日' : `あと${daysUntil}日`;

    // 個別DMで送信 (本人のみ見える)
    // [Reliability] Rate Limit対策: Promise.allをやめて順次実行
    let sentCount = 0;
    for (const member of unanswered) {
        const message = `⏰ **リマインド: ${dayText}のイベント**\n\n` +
            `日時: **${targetDateStr}**\n\n` +
            `まだ回答されていません。下のボタンで参加状況を回答してください!`;

        const components = createButtonComponents(targetDateStr);
        const success = await sendDirectMessage(member.userId, message, components);
        if (success) {
            sentCount++;
        } else {
            console.error(`❌ [Unanswered] Failed to send DM to ${member.name}`);
        }

        // 少し待機 (レート制限回避)
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    // sentCount calculated in loop
    console.log(`✅ [Unanswered] DM sent to ${sentCount}/${unanswered.length} members`);
}

/**
 * [PRD 4.2.3] 未定者リマインド (Undecided One-shot)
 * 条件: daysUntilEvent == Remind_Undecided_Days
 * 休止中メンバーは除外し、DMで個別送信
 */
async function sendUndecidedReminder(targetDateStr) {
    // [PRD 4.2.3] Event_Log で targetDate の行のうち、Statusが 未定 のユーザーに通知
    const undecided = await getUndecidedUsers(targetDateStr);

    if (undecided.length === 0) {
        console.log('[Undecided] No undecided members');
        return;
    }

    // 休止中メンバーを除外
    const members = await getAllMembers();
    const inactiveUserIds = new Set(
        members.filter(m => m.status).map(m => m.userId)
    );
    const activeUndecided = undecided.filter(u => !inactiveUserIds.has(u.userId));

    if (activeUndecided.length === 0) {
        console.log('[Undecided] No active undecided members (all inactive)');
        return;
    }

    // 個別DMで送信 (本人のみ見える)
    // [Reliability] Rate Limit対策: 順次実行
    let sentCount = 0;
    for (const user of activeUndecided) {
        const message = `❓ **未定者へのリマインド**\n\n` +
            `日時: **${targetDateStr}**\n\n` +
            `現在「未定」で回答されています。下のボタンで参加/不参加を確定してください!`;

        const components = createButtonComponents(targetDateStr);
        const success = await sendDirectMessage(user.userId, message, components);
        if (success) {
            sentCount++;
        } else {
            console.error(`❌ [Undecided] Failed to send DM to ${user.name}`);
        }

        await new Promise(resolve => setTimeout(resolve, 500));
    }
    // sentCount calculated in loop
    console.log(`✅ [Undecided] DM sent to ${sentCount}/${activeUndecided.length} members`);
}

/**
 * [PRD 4.2.4] ノルマ確認 (Quota Check)
 * 条件: 募集開始時 (daysUntilEvent == Recruit_DaysBefore)
 */
async function checkQuota(config) {
    const intervalDays = Number(config.Quota_Interval_Days);

    if (!intervalDays) {
        console.log('[Quota] Interval days not set, skipping check');
        return;
    }

    // [PRD 4.2.4] 最終参加日から間隔以上空いているメンバーを特定
    const alertMembers = await checkQuotaStatus(intervalDays);

    if (alertMembers.length === 0) {
        console.log('[Quota] All members adhere to the interval');
        return;
    }

    console.log(`[Quota] Found ${alertMembers.length} members to alert. Sending DMs...`);


    let sentCount = 0;

    // [Reliability] Rate Limit対策
    for (const member of alertMembers) {
        const lastDateText = member.lastDateStr;
        const daysText = member.daysSinceLast === -1 ? '未参加' : `${member.daysSinceLast}日前`;

        const message = `📊 **参加間隔の確認**\n\n` +
            `こんにちは、**${member.name}** さん！\n` +
            `前回のイベント参加から少し時間が空いているようです（目安: ${intervalDays}日に1回）。\n\n` +
            `- 最終参加: **${lastDateText}** (${daysText})\n\n` +
            `次回のイベントへの参加をぜひご検討ください！お待ちしています✨`;

        const success = await sendDirectMessage(member.userId, message);
        if (success) {
            console.log(`✅ [Quota] DM sent to ${member.name}`);
            sentCount++;
        } else {
            console.error(`❌ [Quota] Failed to send DM to ${member.name} (IDs: ${member.userId})`);
        }

        await new Promise(resolve => setTimeout(resolve, 500));
    }
    // sentCount calculated in loop

    console.log(`✅ [Quota] Processed ${alertMembers.length} members. Sent: ${sentCount}, Failed: ${alertMembers.length - sentCount}`);
}

/**
 * [PRD 4.2] メイン日次チェック処理 (mainDailyCheck)
 */
async function mainDailyCheck() {
    console.log('=== mainDailyCheck START ===');

    // [PRD 4] 設定の外部化: Configシートから取得
    const config = await getAllConfig();

    // [PRD 4.1] ターゲット日付の特定
    const targetDate = getTargetDate({
        eventDayOfWeek: config.Event_DayOfWeek,
        eventStartTime: config.Event_StartTime
    });
    const targetDateStr = formatDate(targetDate);
    const daysUntil = getDaysUntilEvent(targetDate);

    console.log(`Target Event Date: ${targetDateStr}`);
    console.log(`Days Until Event: ${daysUntil}`);

    const recruitDays = Number(config.Recruit_DaysBefore);
    const remindStartDays = Number(config.Remind_Start_Days);
    const remindUndecidedDays = Number(config.Remind_Undecided_Days);

    // [PRD 4.2.1] 募集 (Recruitment) & [PRD 4.2.4] ノルマ確認 (Quota Check)
    // 募集開始と同時にノルマチェックも行う
    if (daysUntil === recruitDays) {
        console.log('>>> [PRD 4.2.1] Sending Recruitment');
        await sendRecruitment(targetDateStr, config);

        console.log('>>> [PRD 4.2.4] Checking Quota');
        await checkQuota(config);
    }

    // [PRD 4.2.2] 未回答リマインド (Unanswered Loop)
    if (daysUntil <= remindStartDays && daysUntil >= 0) {
        const now = getJSTNow();
        const [hours, minutes] = config.Event_StartTime.split(':').map(Number);

        // 当日リマインド (daysUntilEvent == 0) の特殊条件
        // 現在時刻が Event_StartTime より前であることを確認した上で送信
        if (daysUntil === 0) {
            const currentTimeInMinutes = now.getHours() * 60 + now.getMinutes();
            const eventTimeInMinutes = hours * 60 + minutes;

            if (currentTimeInMinutes < eventTimeInMinutes) {
                console.log('>>> [PRD 4.2.2] Sending Unanswered Reminder (Same Day)');
                await sendUnansweredReminder(targetDateStr, daysUntil);
            }
        } else {
            console.log('>>> [PRD 4.2.2] Sending Unanswered Reminder');
            await sendUnansweredReminder(targetDateStr, daysUntil);
        }
    }

    // [PRD 4.2.3] 未定者リマインド (Undecided One-shot)
    if (daysUntil === remindUndecidedDays) {
        console.log('>>> [PRD 4.2.3] Sending Undecided Reminder');
        await sendUndecidedReminder(targetDateStr);
    }



    console.log('=== mainDailyCheck END ===');
}

/**
 * Vercel Serverless Function - Cron Endpoint
 */
module.exports = async (req, res) => {
    console.log('[Cron] Request received:', req.method);

    const authHeader = req.headers['authorization'];
    const cronSecret = process.env.CRON_SECRET;

    // [Security] CRON_SECRET必須化
    if (!cronSecret) {
        console.error('[Cron] CRON_SECRET is not set in environment variables');
        return res.status(500).json({ error: 'Server configuration error' });
    }

    if (authHeader !== `Bearer ${cronSecret}`) {
        console.log('[Cron] Unauthorized request');
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        await mainDailyCheck();
        // 成功時はJSONレスポンスを返す
        return res.status(200).json({ success: true, message: 'Daily check completed' });
    } catch (error) {
        console.error('[Cron] Error:', error.message);
        console.error(error.stack);
        return res.status(500).json({ error: 'Internal server error', message: error.message });
    }
};
