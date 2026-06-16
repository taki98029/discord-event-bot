/**
 * Google Sheets API連携モジュール
 * サービスアカウント認証を使用
 */

const { google } = require('googleapis');
const { getJSTNow } = require('./date-utils');

// 認証クライアントをキャッシュ
let authClient = null;
let sheetsClient = null;

/**
 * Google Sheets API認証を初期化
 * @returns {Promise<google.auth.GoogleAuth>}
 */
async function getAuthClient() {
    if (authClient) {
        return authClient;
    }

    const serviceAccountJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (!serviceAccountJson) {
        throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON environment variable is not set');
    }

    const credentials = JSON.parse(serviceAccountJson);

    authClient = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });

    return authClient;
}

/**
 * Google Sheets APIクライアントを取得
 * @returns {Promise<google.sheets_v4.Sheets>}
 */
async function getSheetsClient() {
    if (sheetsClient) {
        return sheetsClient;
    }

    const auth = await getAuthClient();
    sheetsClient = google.sheets({ version: 'v4', auth });
    return sheetsClient;
}

/**
 * スプレッドシートIDを取得
 * @returns {string}
 */
function getSpreadsheetId() {
    const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;
    if (!spreadsheetId) {
        throw new Error('GOOGLE_SPREADSHEET_ID environment variable is not set');
    }
    return spreadsheetId;
}

/**
 * シートのデータを取得
 * @param {string} sheetName - シート名
 * @param {string} range - 範囲 (例: 'A:E')
 * @returns {Promise<Array<Array<any>>>}
 */
async function getSheetData(sheetName, range = '') {
    const sheets = await getSheetsClient();
    const spreadsheetId = getSpreadsheetId();
    const fullRange = range ? `${sheetName}!${range}` : sheetName;

    const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: fullRange
    });

    return response.data.values || [];
}

/**
 * Configシートから設定値を取得
 * @param {string} key - 設定キー
 * @returns {Promise<string>} 設定値
 */
async function getConfig(key) {
    const data = await getSheetData('Config', 'A:B');

    for (let i = 1; i < data.length; i++) {
        if (data[i][0] === key) {
            return data[i][1];
        }
    }

    throw new Error(`Config key not found: ${key}`);
}

/**
 * 全設定を一括取得
 * @returns {Promise<Object>} 設定オブジェクト
 */
async function getAllConfig() {
    const data = await getSheetData('Config', 'A:B');
    const config = {};

    for (let i = 1; i < data.length; i++) {
        if (data[i][0]) {
            config[data[i][0]] = data[i][1];
        }
    }

    return config;
}

/**
 * Member_DBから全メンバーを取得
 * @returns {Promise<Array<{name: string, userId: string, status: string, displayName: string}>>}
 */
async function getAllMembers() {
    const data = await getSheetData('Member_DB', 'A:D');
    const members = [];

    for (let i = 1; i < data.length; i++) {
        if (data[i][0] && data[i][1]) {
            members.push({
                name: data[i][0],
                userId: String(data[i][1]),
                status: data[i][2] || '', // C列: Status (休止中 etc)
                displayName: data[i][3] || data[i][0] // D列: 表示名 (未設定時はUser Nameを使用)
            });
        }
    }

    return members;
}

/**
 * 日付をフォーマット (シート用)
 * @param {Date|string} date
 * @returns {string}
 */
function formatDateForSheet(date) {
    if (typeof date === 'string') {
        return date;
    }
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}/${month}/${day}`;
}

/**
 * Event_Logから特定のイベント・ユーザーの記録を取得
 * @param {string} targetDate - イベント日付 (YYYY/MM/DD)
 * @param {string} userId - Discord User ID
 * @returns {Promise<{status: string, rowIndex: number}|null>}
 */
async function getEventLog(targetDate, userId) {
    const data = await getSheetData('Event_Log', 'A:E');

    for (let i = 1; i < data.length; i++) {
        const eventDate = formatDateForSheet(data[i][0]);
        const recordUserId = String(data[i][1]);

        if (eventDate === targetDate && recordUserId === userId) {
            return {
                status: data[i][3],
                rowIndex: i + 1
            };
        }
    }

    return null;
}

/**
 * 特定の日付のイベントログを一括取得 (N+1問題対策)
 * @param {string} targetDate - イベント日付 (YYYY/MM/DD)
 * @returns {Promise<Object>} userIdをキーとしたログMap {userId: {status, rowIndex}}
 */
async function getEventLogsForDate(targetDate) {
    const data = await getSheetData('Event_Log', 'A:E');
    const logs = {};

    for (let i = 1; i < data.length; i++) {
        const eventDate = formatDateForSheet(data[i][0]);
        const userId = String(data[i][1]);

        if (eventDate === targetDate) {
            logs[userId] = {
                status: data[i][3],
                rowIndex: i + 1
            };
        }
    }
    return logs;
}

/**
 * Event_Logにupsert (既存なら更新、なければ追加)
 * @param {string} date - イベント日付 (YYYY/MM/DD)
 * @param {string} userId - Discord User ID
 * @param {string} userName - ユーザー名
 * @param {string} status - ステータス (参加/不参加/未定)
 */
async function upsertEventLog(date, userId, userName, status) {
    const sheets = await getSheetsClient();
    const spreadsheetId = getSpreadsheetId();
    const timestamp = new Date().toISOString();

    const existing = await getEventLog(date, userId);

    if (existing) {
        // 更新
        await sheets.spreadsheets.values.update({
            spreadsheetId,
            range: `Event_Log!D${existing.rowIndex}:E${existing.rowIndex}`,
            valueInputOption: 'USER_ENTERED',
            requestBody: {
                values: [[status, timestamp]]
            }
        });
        console.log(`Updated: ${userName} - ${status}`);
    } else {
        // 新規追加
        await sheets.spreadsheets.values.append({
            spreadsheetId,
            range: 'Event_Log!A:E',
            valueInputOption: 'USER_ENTERED',
            requestBody: {
                values: [[date, userId, userName, status, timestamp]]
            }
        });
        console.log(`Inserted: ${userName} - ${status}`);
    }
}

/**
 * 特定期間のEvent_Logを集計
 * @param {Date} startDate - 開始日
 * @param {Date} endDate - 終了日
 * @returns {Promise<Object>} userId別の参加回数 {userId: count}
 */
async function getParticipationCount(startDate, endDate) {
    const data = await getSheetData('Event_Log', 'A:E');
    const counts = {};

    for (let i = 1; i < data.length; i++) {
        const eventDate = new Date(data[i][0]);
        const userId = String(data[i][1]);
        const status = data[i][3];

        if (eventDate >= startDate && eventDate <= endDate && status === '参加') {
            counts[userId] = (counts[userId] || 0) + 1;
        }
    }

    return counts;
}

/**
 * 特定イベント日の未定者を取得
 * @param {string} targetDate - イベント日付 (YYYY/MM/DD)
 * @returns {Promise<Array<{name: string, userId: string}>>}
 */
async function getUndecidedUsers(targetDate) {
    const data = await getSheetData('Event_Log', 'A:E');
    const undecided = [];

    for (let i = 1; i < data.length; i++) {
        const eventDate = formatDateForSheet(data[i][0]);
        const userId = String(data[i][1]);
        const userName = data[i][2];
        const status = data[i][3];

        if (eventDate === targetDate && status === '未定') {
            undecided.push({ name: userName, userId: userId });
        }
    }

    return undecided;
}

/**
 * 特定イベント日の参加状況を集計 (Status Check用)
 * @param {string} targetDate - イベント日付 (YYYY/MM/DD)
 * @returns {Promise<Object>} ステータスごとのユーザーリスト {参加: [], 不参加: [], 未定: [], 未回答: []}
 */
async function getEventStatus(targetDate) {
    const members = await getAllMembers();
    const data = await getSheetData('Event_Log', 'A:E');

    // ユーザーごとの最新ステータスを保持するマップ
    const userStatusMap = {};

    for (const member of members) {
        // Statusが設定されているメンバーは状況確認から除外
        if (member.status) continue;

        userStatusMap[member.userId] = {
            name: member.displayName, // 表示名を使用
            status: '未回答' // デフォルト
        };
    }

    // Event_Logを走査してステータスを上書き
    for (let i = 1; i < data.length; i++) {
        const eventDate = formatDateForSheet(data[i][0]);
        const userId = String(data[i][1]);
        const status = data[i][3];

        if (eventDate === targetDate && userStatusMap[userId]) {
            userStatusMap[userId].status = status;
        }
    }

    // 結果をグループ化
    const result = {
        '参加': [],
        '不参加': [],
        '未定': [],
        '未回答': []
    };

    for (const userId in userStatusMap) {
        const { name, status } = userStatusMap[userId];
        if (result[status]) {
            result[status].push(name);
        } else {
            // 万が一未知のステータスがあれば未回答扱いにはせず、新規キー作成防止のため未回答に入れるか無視するか
            // PRD定義外のステータスはありえない前提だが、安全策として未回答に入れる
            result['未回答'].push(name);
        }
    }

    return result;
}

/**
 * ノルマチェック用: 最終参加日からの経過日数を判定
 * [PRD 4.2.4] Quota Logic
 * @param {number} intervalDays - 許容される間隔日数
 * @returns {Promise<Array>} ノルマ未達メンバーのリスト [{name, userId, daysSinceLast, lastDateStr}]
 */
async function checkQuotaStatus(intervalDays) {
    const members = await getAllMembers();
    const data = await getSheetData('Event_Log', 'A:E');

    // ユーザーごとの最終参加日を保持 (nullなら未参加)
    const userLastDateMap = {};
    for (const member of members) {
        // [PRD 3.2] Statusが設定されているメンバーは除外
        if (member.status) {
            continue;
        }
        userLastDateMap[member.userId] = null;
    }

    // Event_Logを走査して「参加」の最新日付を特定
    for (let i = 1; i < data.length; i++) {
        const eventDateStr = formatDateForSheet(data[i][0]);
        const userId = String(data[i][1]);
        const status = data[i][3];

        if (status === '参加' && userLastDateMap.hasOwnProperty(userId)) {
            // 日付文字列をDateオブジェクトに変換して比較
            const currentDate = new Date(eventDateStr);
            const existingDate = userLastDateMap[userId];

            if (!existingDate || currentDate > existingDate) {
                userLastDateMap[userId] = currentDate;
            }
        }
    }

    const today = getJSTNow();
    // 時刻を00:00:00にリセットして日付のみで比較
    today.setHours(0, 0, 0, 0);

    const alertMembers = [];

    for (const member of members) {
        // [PRD 3.2] Statusが設定されているメンバーは除外
        if (member.status) {
            continue;
        }

        const lastDate = userLastDateMap[member.userId];

        let daysSince = -1; // 未参加フラグ

        if (lastDate) {
            // 経過日数を計算
            const diffTime = today - lastDate;
            daysSince = Math.floor(diffTime / (1000 * 60 * 60 * 24));
        }

        // 間隔日数を超えている場合のみ (未参加者は除外)
        if (daysSince !== -1 && daysSince > intervalDays) {
            alertMembers.push({
                ...member,
                daysSinceLast: daysSince,
                lastDateStr: lastDate ? formatDateForSheet(lastDate) : '未参加'
            });
        }
    }

    return alertMembers;
}

/**
 * Member_DBの表示名(D列)を更新 (未設定の場合のみ)
 * @param {string} userId - Discord User ID
 * @param {string} displayName - Discord表示名 (global_name or nick)
 * @param {string} userName - Discordユーザー名 (username)
 */
async function updateMemberDisplayName(userId, displayName, userName) {
    if (!displayName) return;

    const sheets = await getSheetsClient();
    const spreadsheetId = getSpreadsheetId();

    const data = await getSheetData('Member_DB', 'A:D');

    for (let i = 1; i < data.length; i++) {
        if (String(data[i][1]) === userId) {
            const currentDisplayName = data[i][3];
            const currentUserName = data[i][0];
            const rowIndex = i + 1; // 1-indexed

            // A列(User Name)が未設定 or 更新が必要な場合も更新
            const updates = {};

            // D列: Display Nameが未設定の場合のみ書き込み
            if (!currentDisplayName) {
                updates.displayName = displayName;
            }

            // A列: User Nameが未設定の場合のみ書き込み
            if (!currentUserName && userName) {
                updates.userName = userName;
            }

            if (Object.keys(updates).length > 0) {
                // D列だけ更新する場合
                if (updates.displayName) {
                    await sheets.spreadsheets.values.update({
                        spreadsheetId,
                        range: `Member_DB!D${rowIndex}`,
                        valueInputOption: 'USER_ENTERED',
                        requestBody: {
                            values: [[displayName]]
                        }
                    });
                    console.log(`[Sheets] Updated display name for ${userId}: ${displayName}`);
                }

                if (updates.userName) {
                    await sheets.spreadsheets.values.update({
                        spreadsheetId,
                        range: `Member_DB!A${rowIndex}`,
                        valueInputOption: 'USER_ENTERED',
                        requestBody: {
                            values: [[userName]]
                        }
                    });
                    console.log(`[Sheets] Updated user name for ${userId}: ${userName}`);
                }
            }
            return;
        }
    }
}

/**
 * Member_DBのステータス(C列)を更新
 * @param {string} userId - Discord User ID
 * @param {string} status - 新しいステータス (例: '休止中', '')
 * @returns {Promise<boolean>} 更新成功したかどうか
 */
async function setMemberStatus(userId, status) {
    const sheets = await getSheetsClient();
    const spreadsheetId = getSpreadsheetId();

    const data = await getSheetData('Member_DB', 'A:D');

    for (let i = 1; i < data.length; i++) {
        if (String(data[i][1]) === userId) {
            const rowIndex = i + 1; // 1-indexed
            await sheets.spreadsheets.values.update({
                spreadsheetId,
                range: `Member_DB!C${rowIndex}`,
                valueInputOption: 'USER_ENTERED',
                requestBody: {
                    values: [[status]]
                }
            });
            console.log(`[Sheets] Set status for ${userId}: "${status}"`);
            return true;
        }
    }
    return false; // メンバーが見つからなかった
}

/**
 * Member_DBに新メンバーを追加
 * @param {string} userId - Discord User ID
 * @param {string} userName - Discordユーザー名
 * @param {string} displayName - Discord表示名
 * @returns {Promise<string>} 'added' | 'exists'
 */
async function addMember(userId, userName, displayName) {
    const sheets = await getSheetsClient();
    const spreadsheetId = getSpreadsheetId();

    const data = await getSheetData('Member_DB', 'A:D');

    // 既存チェック
    for (let i = 1; i < data.length; i++) {
        if (String(data[i][1]) === userId) {
            return 'exists';
        }
    }

    // 新規追加
    await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: 'Member_DB!A:D',
        valueInputOption: 'USER_ENTERED',
        requestBody: {
            values: [[userName, userId, '', displayName || '']]
        }
    });
    console.log(`[Sheets] Added new member: ${displayName || userName} (${userId})`);
    return 'added';
}

module.exports = {
    getConfig,
    getAllConfig,
    getAllMembers,
    getEventLog,
    upsertEventLog,
    getParticipationCount,
    getUndecidedUsers,
    getEventStatus,
    checkQuotaStatus,
    updateMemberDisplayName,
    setMemberStatus,
    addMember,
    getEventLogsForDate
};
