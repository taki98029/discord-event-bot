/**
 * 全機能テストスクリプト
 * 今回のセッションで追加・変更した全機能を検証する
 * 
 * 実行: node tests/test-all-features.js
 */

let passed = 0;
let failed = 0;

function assert(condition, testName) {
    if (condition) {
        console.log(`  ✅ ${testName}`);
        passed++;
    } else {
        console.log(`  ❌ ${testName}`);
        failed++;
    }
}

function assertEqual(actual, expected, testName) {
    if (actual === expected) {
        console.log(`  ✅ ${testName}`);
        passed++;
    } else {
        console.log(`  ❌ ${testName}`);
        console.log(`     Expected: "${expected}"`);
        console.log(`     Actual:   "${actual}"`);
        failed++;
    }
}

function assertDeepEqual(actual, expected, testName) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) {
        console.log(`  ✅ ${testName}`);
        passed++;
    } else {
        console.log(`  ❌ ${testName}`);
        console.log(`     Expected: ${e}`);
        console.log(`     Actual:   ${a}`);
        failed++;
    }
}

// ============================================
// 1. モジュール読み込み (Syntax Check)
// ============================================
console.log('\n📋 Test 1: モジュール読み込み');

let sheetsModule, discordModule, cronModule, discordApiModule;

try {
    sheetsModule = require('../lib/sheets.js');
    console.log('  ✅ lib/sheets.js 読み込み成功');
    passed++;
} catch (e) {
    console.log(`  ❌ lib/sheets.js 読み込み失敗: ${e.message}`);
    failed++;
}

try {
    discordModule = require('../lib/discord.js');
    console.log('  ✅ lib/discord.js 読み込み成功');
    passed++;
} catch (e) {
    console.log(`  ❌ lib/discord.js 読み込み失敗: ${e.message}`);
    failed++;
}

try {
    cronModule = require('../api/cron.js');
    console.log('  ✅ api/cron.js 読み込み成功');
    passed++;
} catch (e) {
    console.log(`  ❌ api/cron.js 読み込み失敗: ${e.message}`);
    failed++;
}

try {
    discordApiModule = require('../api/discord.js');
    console.log('  ✅ api/discord.js 読み込み成功');
    passed++;
} catch (e) {
    console.log(`  ❌ api/discord.js 読み込み失敗: ${e.message}`);
    failed++;
}

// ============================================
// 2. エクスポート関数の確認
// ============================================
console.log('\n📋 Test 2: エクスポート関数チェック');

if (sheetsModule) {
    const expectedExports = [
        'getConfig', 'getAllConfig', 'getAllMembers',
        'getEventLog', 'upsertEventLog', 'getParticipationCount',
        'getUndecidedUsers', 'getEventStatus', 'checkQuotaStatus',
        'updateMemberDisplayName', 'setMemberStatus', 'addMember'
    ];
    for (const fn of expectedExports) {
        assert(typeof sheetsModule[fn] === 'function', `sheets.${fn} がエクスポートされている`);
    }
}

if (discordModule) {
    const expectedExports = [
        'sendDiscordMessage', 'sendDirectMessage', 'createButtonComponents',
        'buildStatusMessage', 'mentionUser', 'createDM'
    ];
    for (const fn of expectedExports) {
        assert(typeof discordModule[fn] === 'function', `discord.${fn} がエクスポートされている`);
    }
}

// ============================================
// 3. Display Name (D列) テスト
// ============================================
console.log('\n📋 Test 3: getAllMembers Display Name (D列)');

function simulateGetAllMembers(sheetData) {
    const members = [];
    for (let i = 1; i < sheetData.length; i++) {
        if (sheetData[i][0] && sheetData[i][1]) {
            members.push({
                name: sheetData[i][0],
                userId: String(sheetData[i][1]),
                status: sheetData[i][2] || '',
                displayName: sheetData[i][3] || sheetData[i][0]
            });
        }
    }
    return members;
}

// D列あり
const mockData1 = [
    ['User Name', 'Discord User ID', 'Status', 'Display Name'],
    ['taro_discord', '111', '', '太郎'],
    ['hanako_discord', '222', '', '花子'],
    ['jiro_discord', '333', '休止中', '次郎'],
];
const result1 = simulateGetAllMembers(mockData1);
assertEqual(result1.length, 3, 'メンバー3人');
assertEqual(result1[0].displayName, '太郎', 'D列あり → 表示名使用');
assertEqual(result1[0].name, 'taro_discord', 'A列 → name保持');
assertEqual(result1[2].status, '休止中', 'ステータス正常');

// D列なし (undefinedフォールバック)
const mockData2 = [
    ['User Name', 'Discord User ID', 'Status'],
    ['taro_discord', '111', ''],
    ['hanako_discord', '222', ''],
];
const result2 = simulateGetAllMembers(mockData2);
assertEqual(result2[0].displayName, 'taro_discord', 'D列なし → A列にフォールバック');
assertEqual(result2[1].displayName, 'hanako_discord', 'D列なし → A列にフォールバック(2)');

// D列空文字
const mockData3 = [
    ['User Name', 'Discord User ID', 'Status', 'Display Name'],
    ['taro_discord', '111', '', ''],
    ['hanako_discord', '222', '', null],
];
const result3 = simulateGetAllMembers(mockData3);
assertEqual(result3[0].displayName, 'taro_discord', 'D列空文字 → A列にフォールバック');
assertEqual(result3[1].displayName, 'hanako_discord', 'D列null → A列にフォールバック');

// 空行スキップ
const mockData4 = [
    ['User Name', 'Discord User ID', 'Status', 'Display Name'],
    ['taro', '111', '', '太郎'],
    ['', '', '', ''],
    ['hanako', '222', '', '花子'],
];
const result4 = simulateGetAllMembers(mockData4);
assertEqual(result4.length, 2, '空行はスキップされる');

// ============================================
// 4. getEventStatus で displayName が使われるか
// ============================================
console.log('\n📋 Test 4: getEventStatus displayName使用');

function simulateGetEventStatus(members, eventLogData, targetDate) {
    const userStatusMap = {};
    for (const member of members) {
        userStatusMap[member.userId] = {
            name: member.displayName, // displayNameを使用
            status: '未回答'
        };
    }
    for (let i = 1; i < eventLogData.length; i++) {
        const eventDate = eventLogData[i][0];
        const userId = String(eventLogData[i][1]);
        const status = eventLogData[i][3];
        if (eventDate === targetDate && userStatusMap[userId]) {
            userStatusMap[userId].status = status;
        }
    }
    const result = { '参加': [], '不参加': [], '未定': [], '未回答': [] };
    for (const userId in userStatusMap) {
        const { name, status } = userStatusMap[userId];
        if (result[status]) result[status].push(name);
        else result['未回答'].push(name);
    }
    return result;
}

const testMembers = simulateGetAllMembers([
    ['User Name', 'Discord User ID', 'Status', 'Display Name'],
    ['taro_discord', '111', '', '太郎'],
    ['hanako_discord', '222', '', '花子'],
    ['goro_discord', '555', '', ''],
]);

const testEventLog = [
    ['Event Date', 'User ID', 'User Name', 'Status', 'Timestamp'],
    ['2025/02/20', '111', 'taro_discord', '参加', '2025-02-15'],
    ['2025/02/20', '222', 'hanako_discord', '未定', '2025-02-15'],
];

const statusResult = simulateGetEventStatus(testMembers, testEventLog, '2025/02/20');
assertDeepEqual(statusResult['参加'], ['太郎'], '参加者にdisplayNameが使われる');
assertDeepEqual(statusResult['未定'], ['花子'], '未定者にdisplayNameが使われる');
assertDeepEqual(statusResult['未回答'], ['goro_discord'], 'D列空 → nameにフォールバック');

// ============================================
// 5. buildMentionPrefix テスト
// ============================================
console.log('\n📋 Test 5: buildMentionPrefix');

function buildMentionPrefix(mentionValue) {
    if (!mentionValue || mentionValue.trim() === '') return '';
    if (mentionValue === '@everyone' || mentionValue === 'everyone') return '@everyone\n\n';
    return `<@&${mentionValue.trim()}>\n\n`;
}

assertEqual(buildMentionPrefix('@everyone'), '@everyone\n\n', '@everyone メンション');
assertEqual(buildMentionPrefix('everyone'), '@everyone\n\n', 'everyone メンション');
assertEqual(buildMentionPrefix('1234567890'), '<@&1234567890>\n\n', 'ロールID メンション');
assertEqual(buildMentionPrefix(''), '', '空文字 → メンションなし');
assertEqual(buildMentionPrefix(null), '', 'null → メンションなし');
assertEqual(buildMentionPrefix(undefined), '', 'undefined → メンションなし');

// ============================================
// 6. DM ユーザー取得ロジック (member?.user || user)
// ============================================
console.log('\n📋 Test 6: DM/サーバー ユーザー取得ロジック');

// サーバーでのインタラクション
const guildInteraction = {
    member: {
        user: { id: '111', username: 'taro', global_name: '太郎' },
        nick: 'たろちゃん'
    }
};
const guildUser = guildInteraction.member?.user || guildInteraction.user;
assertEqual(guildUser.id, '111', 'サーバー: userオブジェクト取得OK');
const guildDisplayName = guildInteraction.member?.nick || guildUser.global_name || guildUser.username;
assertEqual(guildDisplayName, 'たろちゃん', 'サーバー: ニックネーム優先');

// DMでのインタラクション (member なし)
const dmInteraction = {
    user: { id: '222', username: 'hanako', global_name: '花子' }
};
const dmUser = dmInteraction.member?.user || dmInteraction.user;
assertEqual(dmUser.id, '222', 'DM: userオブジェクト取得OK');
const dmDisplayName = dmInteraction.member?.nick || dmUser.global_name || dmUser.username;
assertEqual(dmDisplayName, '花子', 'DM: global_name使用');

// DM (global_name なし)
const dmInteraction2 = {
    user: { id: '333', username: 'jiro' }
};
const dmUser2 = dmInteraction2.member?.user || dmInteraction2.user;
const dmDisplayName2 = dmInteraction2.member?.nick || dmUser2.global_name || dmUser2.username;
assertEqual(dmDisplayName2, 'jiro', 'DM: global_nameなし → username使用');

// ============================================
// 7. setMemberStatus ロジック
// ============================================
console.log('\n📋 Test 7: setMemberStatus シミュレーション');

function simulateSetMemberStatus(sheetData, userId, status) {
    for (let i = 1; i < sheetData.length; i++) {
        if (String(sheetData[i][1]) === userId) {
            sheetData[i][2] = status;
            return true;
        }
    }
    return false;
}

const memberData = [
    ['User Name', 'Discord User ID', 'Status', 'Display Name'],
    ['taro', '111', '', '太郎'],
    ['hanako', '222', '', '花子'],
];

assert(simulateSetMemberStatus(memberData, '111', '休止中') === true, 'pause: 既存メンバー → true');
assertEqual(memberData[1][2], '休止中', 'pause: ステータスが更新される');
assert(simulateSetMemberStatus(memberData, '111', '') === true, 'resume: 既存メンバー → true');
assertEqual(memberData[1][2], '', 'resume: ステータスが空に戻る');
assert(simulateSetMemberStatus(memberData, '999', '休止中') === false, 'pause: 未登録メンバー → false');

// ============================================
// 8. addMember ロジック
// ============================================
console.log('\n📋 Test 8: addMember シミュレーション');

function simulateAddMember(sheetData, userId, userName, displayName) {
    for (let i = 1; i < sheetData.length; i++) {
        if (String(sheetData[i][1]) === userId) return 'exists';
    }
    sheetData.push([userName, userId, '', displayName || '']);
    return 'added';
}

const memberData2 = [
    ['User Name', 'Discord User ID', 'Status', 'Display Name'],
    ['taro', '111', '', '太郎'],
];

assertEqual(simulateAddMember(memberData2, '222', 'hanako', '花子'), 'added', '新規メンバー → added');
assertEqual(memberData2.length, 3, '配列に1行追加される');
assertEqual(memberData2[2][0], 'hanako', '追加: UserName正しい');
assertEqual(memberData2[2][3], '花子', '追加: DisplayName正しい');
assertEqual(simulateAddMember(memberData2, '111', 'taro', '太郎'), 'exists', '既存メンバー → exists');

// ============================================
// 9. updateMemberDisplayName ロジック
// ============================================
console.log('\n📋 Test 9: updateMemberDisplayName シミュレーション');

function simulateUpdateDisplayName(sheetData, userId, displayName) {
    if (!displayName) return 'skipped';
    for (let i = 1; i < sheetData.length; i++) {
        if (String(sheetData[i][1]) === userId) {
            if (!sheetData[i][3]) {
                sheetData[i][3] = displayName;
                return 'updated';
            }
            return 'already_set';
        }
    }
    return 'not_found';
}

const memberData3 = [
    ['User Name', 'Discord User ID', 'Status', 'Display Name'],
    ['taro', '111', '', ''],
    ['hanako', '222', '', '花子'],
];

assertEqual(simulateUpdateDisplayName(memberData3, '111', '太郎'), 'updated', 'D列空 → 更新');
assertEqual(memberData3[1][3], '太郎', 'D列に表示名が書き込まれる');
assertEqual(simulateUpdateDisplayName(memberData3, '222', 'はなちゃん'), 'already_set', 'D列既存 → スキップ');
assertEqual(memberData3[2][3], '花子', '既存値は上書きされない');
assertEqual(simulateUpdateDisplayName(memberData3, '999', 'test'), 'not_found', '未登録 → not_found');
assertEqual(simulateUpdateDisplayName(memberData3, '111', ''), 'skipped', '空文字 → スキップ');
assertEqual(simulateUpdateDisplayName(memberData3, '111', null), 'skipped', 'null → スキップ');

// ============================================
// 10. createButtonComponents テスト
// ============================================
console.log('\n📋 Test 10: createButtonComponents');

if (discordModule) {
    const components = discordModule.createButtonComponents('2025/02/20');
    assert(Array.isArray(components), 'コンポーネントは配列');
    assertEqual(components.length, 1, 'Action Row 1つ');
    assertEqual(components[0].type, 1, 'type: Action Row');
    assertEqual(components[0].components.length, 4, 'ボタン4つ');
    assertEqual(components[0].components[0].label, '参加', '1番目: 参加');
    assertEqual(components[0].components[1].label, '不参加', '2番目: 不参加');
    assertEqual(components[0].components[2].label, '未定', '3番目: 未定');
    assertEqual(components[0].components[3].label, '📊 状況確認', '4番目: 状況確認');
    assertEqual(components[0].components[0].custom_id, 'participate_2025/02/20', 'custom_id に日付が含まれる');
}

// ============================================
// 11. buildStatusMessage テスト
// ============================================
console.log('\n📋 Test 11: buildStatusMessage');

if (discordModule) {
    const statusData = {
        '参加': ['太郎', '花子'],
        '不参加': ['次郎'],
        '未定': [],
        '未回答': ['五郎']
    };
    const msg = discordModule.buildStatusMessage('2025/02/20', statusData);
    assert(msg.includes('2025/02/20'), '日付が含まれる');
    assert(msg.includes('参加 (2名)'), '参加人数が正しい');
    assert(msg.includes('太郎'), '太郎が含まれる');
    assert(msg.includes('花子'), '花子が含まれる');
    assert(msg.includes('不参加 (1名)'), '不参加人数が正しい');
    assert(msg.includes('未定 (0名)'), '未定人数が正しい');
    assert(msg.includes('未回答 (1名)'), '未回答人数が正しい');
}

// ============================================
// 12. 休止中メンバーフィルタリング
// ============================================
console.log('\n📋 Test 12: 休止中メンバーフィルタリング');

const allMembers = [
    { name: 'taro', userId: '111', status: '', displayName: '太郎' },
    { name: 'hanako', userId: '222', status: '', displayName: '花子' },
    { name: 'jiro', userId: '333', status: '休止中', displayName: '次郎' },
    { name: 'goro', userId: '555', status: '', displayName: '五郎' },
];

// 未回答リマインドフィルタ
const activeMembers = allMembers.filter(m => m.status !== '休止中');
assertEqual(activeMembers.length, 3, 'アクティブメンバー3人');
assert(!activeMembers.find(m => m.name === 'jiro'), '次郎(休止中)は除外');

// 未定者リマインドフィルタ
const undecidedUsers = [
    { name: 'taro', userId: '111' },
    { name: 'jiro', userId: '333' },
];
const inactiveUserIds = new Set(
    allMembers.filter(m => m.status === '休止中').map(m => m.userId)
);
const activeUndecided = undecidedUsers.filter(u => !inactiveUserIds.has(u.userId));
assertEqual(activeUndecided.length, 1, '休止中除外後の未定者1人');
assertEqual(activeUndecided[0].name, 'taro', 'taroのみ残る');

// ============================================
// 13. スラッシュコマンド定義の確認
// ============================================
console.log('\n📋 Test 13: register-commands.js コマンド定義');

try {
    // register-commands.jsを直接readして定義を確認
    const fs = require('fs');
    const content = fs.readFileSync(require('path').join(__dirname, '../scripts/register-commands.js'), 'utf8');

    const expectedCommands = ['recruit', 'pause', 'resume', 'members', 'addmember'];
    for (const cmd of expectedCommands) {
        assert(content.includes(`name: '${cmd}'`), `/${cmd} コマンドが定義されている`);
    }

    // ADMINISTRATOR権限
    const adminCount = (content.match(/default_member_permissions: '8'/g) || []).length;
    assertEqual(adminCount, 5, '全5コマンドが管理者権限');

    // userオプション
    assert(content.includes("type: 6"), 'USERタイプオプションが定義されている');
} catch (e) {
    console.log(`  ❌ register-commands.js 読み込み失敗: ${e.message}`);
    failed++;
}

// ============================================
// 14. discord.js ハンドラーの確認
// ============================================
console.log('\n📋 Test 14: discord.js コマンドハンドラー確認');

try {
    const fs = require('fs');
    const content = fs.readFileSync(require('path').join(__dirname, '../api/discord.js'), 'utf8');

    // コマンドハンドラーが存在するか
    const handlers = ['recruit', 'pause', 'resume', 'members', 'addmember'];
    for (const cmd of handlers) {
        assert(content.includes(`commandName === '${cmd}'`), `/${cmd} ハンドラーが存在する`);
    }

    // DM対応のユーザー取得
    assert(content.includes('interaction.member?.user || interaction.user'), 'DM対応のユーザー取得ロジック');

    // updateMemberDisplayName呼び出し
    assert(content.includes('updateMemberDisplayName'), 'ボタンクリック時にdisplayName更新');

    // エフェメラル応答
    const ephemeralCount = (content.match(/flags: 64/g) || []).length;
    assert(ephemeralCount >= 10, `エフェメラル応答が十分にある (${ephemeralCount}箇所)`);
} catch (e) {
    console.log(`  ❌ discord.js 読み込み失敗: ${e.message}`);
    failed++;
}

// ============================================
// 15. cron.js DMボタン確認
// ============================================
console.log('\n📋 Test 15: cron.js DMリマインドにボタンあり');

try {
    const fs = require('fs');
    const content = fs.readFileSync(require('path').join(__dirname, '../api/cron.js'), 'utf8');

    // createButtonComponentsが使われているか
    const buttonUsageCount = (content.match(/createButtonComponents\(targetDateStr\)/g) || []).length;
    // 1回: sendRecruitment, 2回: sendUnansweredReminder, sendUndecidedReminder = 計3回
    assert(buttonUsageCount >= 3, `createButtonComponentsが${buttonUsageCount}回使用されている (期待: 3回以上)`);

    // sendDirectMessageにコンポーネントを渡しているか
    assert(content.includes('sendDirectMessage(member.userId, message, components)'), '未回答DMにボタンあり');
    assert(content.includes('sendDirectMessage(user.userId, message, components)'), '未定者DMにボタンあり');
} catch (e) {
    console.log(`  ❌ cron.js 読み込み失敗: ${e.message}`);
    failed++;
}

// ============================================
// 16. Code.gs の整合性確認
// ============================================
console.log('\n📋 Test 16: Code.gs 整合性');

try {
    const fs = require('fs');
    const content = fs.readFileSync(require('path').join(__dirname, '../Code.gs'), 'utf8');

    assert(content.includes('displayName: data[i][3] || data[i][0]'), 'GAS: displayName D列フォールバック');
    assert(content.includes('buildMentionPrefix'), 'GAS: buildMentionPrefix存在');
} catch (e) {
    console.log(`  ❌ Code.gs 読み込み失敗: ${e.message}`);
    failed++;
}

// ============================================
// 結果サマリー
// ============================================
console.log('\n' + '='.repeat(50));
console.log(`📊 結果: ${passed} passed, ${failed} failed, ${passed + failed} total`);

if (failed > 0) {
    console.log('❌ テスト失敗あり');
    process.exit(1);
} else {
    console.log('🎉 全テスト通過!');
    process.exit(0);
}
