/**
 * Discord API連携モジュール
 * Bot Token経由でメッセージ送信
 */

/**
 * ユーザーをメンション形式にする
 * @param {string} userId - Discord User ID
 * @returns {string} メンション文字列
 */
function mentionUser(userId) {
    return `<@${userId}>`;
}

/**
 * ボタンコンポーネントを作成
 * @param {string} eventDate - イベント日付 (YYYY/MM/DD)
 * @returns {Array} Discord Components配列
 */
function createButtonComponents(eventDate) {
    return [
        {
            type: 1, // Action Row
            components: [
                {
                    type: 2, // Button
                    style: 3, // Success (緑)
                    label: '参加',
                    custom_id: `participate_${eventDate}`
                },
                {
                    type: 2,
                    style: 4, // Danger (赤)
                    label: '不参加',
                    custom_id: `absent_${eventDate}`
                },
                {
                    type: 2,
                    style: 2, // Secondary (灰色)
                    label: '未定',
                    custom_id: `undecided_${eventDate}`
                },
                {
                    type: 2,
                    style: 2, // Secondary (灰色)
                    label: '📊 状況確認',
                    custom_id: `status_${eventDate}`
                }
            ]
        }
    ];
}

/**
 * [PRD 4.4] 状況確認メッセージを生成
 * @param {string} targetDate - イベント日付
 * @param {Object} statusData - getEventStatusの結果
 * @returns {string} フォーマットされたメッセージ
 */
function buildStatusMessage(targetDate, statusData) {
    const formatList = (users) => users.length > 0 ? users.join(', ') : '(なし)';

    return `📅 **${targetDate} の参加状況**\n\n` +
        `⭕ **参加 (${statusData['参加'].length}名)**\n` +
        `${formatList(statusData['参加'])}\n\n` +
        `❌ **不参加 (${statusData['不参加'].length}名)**\n` +
        `${formatList(statusData['不参加'])}\n\n` +
        `❓ **未定 (${statusData['未定'].length}名)**\n` +
        `${formatList(statusData['未定'])}\n\n` +
        `⚠️ **未回答 (${statusData['未回答'].length}名)**\n` +
        `${formatList(statusData['未回答'])}`;
}

/**
 * Discord APIでメッセージを送信
 * @param {string} content - メッセージ内容
 * @param {Array} components - ボタンコンポーネント (オプション)
 * @param {string} channelId - 送信先チャンネルID (指定がない場合は環境変数を使用)
 * @returns {Promise<boolean>} 成功/失敗
 */
async function sendDiscordMessage(content, components = null, targetChannelId = null) {
    const botToken = process.env.DISCORD_BOT_TOKEN;
    const channelId = targetChannelId || process.env.DISCORD_CHANNEL_ID;

    if (!botToken) {
        throw new Error('DISCORD_BOT_TOKEN environment variable is not set');
    }
    if (!channelId) {
        throw new Error('DISCORD_CHANNEL_ID environment variable is not set');
    }

    const payload = {
        content: content
    };

    if (components) {
        payload.components = components;
    }

    try {
        const response = await fetch(
            `https://discord.com/api/v10/channels/${channelId}/messages`,
            {
                method: 'POST',
                headers: {
                    'Authorization': `Bot ${botToken}`,
                    'Content-Type': 'application/json',
                    'User-Agent': 'DiscordBot (https://github.com/example, 1.0.0)'
                },
                body: JSON.stringify(payload)
            }
        );

        console.log(`Discord API Response: ${response.status}`);

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`Discord Error: ${errorText}`);
            return false;
        }

        return true;
    } catch (error) {
        console.error(`Discord send error: ${error.message}`);
        return false;
    }
}

/**
 * ダイレクトメッセージ(DM)チャンネルを作成
 * @param {string} userId - 送信先ユーザーID
 * @returns {Promise<string|null>} チャンネルID (失敗時はnull)
 */
async function createDM(userId) {
    const botToken = process.env.DISCORD_BOT_TOKEN;
    if (!botToken) return null;

    try {
        const response = await fetch('https://discord.com/api/v10/users/@me/channels', {
            method: 'POST',
            headers: {
                'Authorization': `Bot ${botToken}`,
                'Content-Type': 'application/json',
                'User-Agent': 'DiscordBot (ChoiemuEventBot)'
            },
            body: JSON.stringify({ recipient_id: userId })
        });

        if (!response.ok) {
            console.error(`Failed to create DM: ${await response.text()}`);
            return null;
        }

        const data = await response.json();
        return data.id;
    } catch (error) {
        console.error(`Create DM Error: ${error.message}`);
        return null;
    }
}

/**
 * 特定のユーザーにDMを送信
 * @param {string} userId - ユーザーID
 * @param {string} content - メッセージ内容
 * @param {Array} [components] - ボタン等のコンポーネント (オプション)
 * @returns {Promise<boolean>} 成功/失敗
 */
async function sendDirectMessage(userId, content, components = null) {
    const channelId = await createDM(userId);
    if (!channelId) return false;

    return await sendDiscordMessage(content, components, channelId);
}

module.exports = {
    mentionUser,
    createButtonComponents,
    sendDiscordMessage,
    buildStatusMessage,
    createDM,
    sendDirectMessage
};
