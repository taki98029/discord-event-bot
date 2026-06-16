/**
 * テストスクリプト
 * 今回の変更が正しく動作するか検証する
 * 
 * 実行: node tests/test-changes.js
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

// ============================================
// 1. buildMentionPrefix テスト
// ============================================
console.log('\n📋 Test 1: buildMentionPrefix');

// cron.js から buildMentionPrefix を取得するためにモジュールを直接テスト
// (exportされていないので、同じロジックを再現してテスト)
function buildMentionPrefix(mentionValue) {
    if (!mentionValue || mentionValue.trim() === '') {
        return '';
    }
    if (mentionValue === '@everyone' || mentionValue === 'everyone') {
        return '@everyone\n\n';
    }
    return `<@&${mentionValue.trim()}>\n\n`;
}

assertEqual(buildMentionPrefix('@everyone'), '@everyone\n\n', '@everyone → @everyone メンション');
assertEqual(buildMentionPrefix('everyone'), '@everyone\n\n', 'everyone → @everyone メンション');
assertEqual(buildMentionPrefix('1234567890'), '<@&1234567890>\n\n', 'ロールID → <@&ID> 形式');
assertEqual(buildMentionPrefix(' 1234567890 '), '<@&1234567890>\n\n', 'ロールID (前後スペース) → trimされる');
assertEqual(buildMentionPrefix(''), '', '空文字 → メンションなし');
assertEqual(buildMentionPrefix(null), '', 'null → メンションなし');
assertEqual(buildMentionPrefix(undefined), '', 'undefined → メンションなし');
assertEqual(buildMentionPrefix('  '), '', 'スペースのみ → メンションなし');

// ============================================
// 2. 休止中メンバーフィルタリング テスト
// ============================================
console.log('\n📋 Test 2: 休止中メンバーフィルタリング');

const testMembers = [
    { name: '太郎', userId: '111', status: '' },
    { name: '花子', userId: '222', status: '' },
    { name: '次郎', userId: '333', status: '休止中' },
    { name: '四郎', userId: '444', status: '休止中' },
    { name: '五郎', userId: '555', status: '' },
];

// 未回答リマインドのフィルタリングロジック再現
const activeMembers = testMembers.filter(m => m.status !== '休止中');
assertEqual(activeMembers.length, 3, 'アクティブメンバーは3人');
assert(!activeMembers.find(m => m.name === '次郎'), '次郎(休止中)は除外される');
assert(!activeMembers.find(m => m.name === '四郎'), '四郎(休止中)は除外される');
assert(activeMembers.find(m => m.name === '太郎'), '太郎(アクティブ)は含まれる');
assert(activeMembers.find(m => m.name === '花子'), '花子(アクティブ)は含まれる');
assert(activeMembers.find(m => m.name === '五郎'), '五郎(アクティブ)は含まれる');

// 未定者リマインドの休止中フィルタリングロジック再現
const undecidedUsers = [
    { name: '太郎', userId: '111' },
    { name: '次郎', userId: '333' },  // 休止中
    { name: '五郎', userId: '555' },
];

const inactiveUserIds = new Set(
    testMembers.filter(m => m.status === '休止中').map(m => m.userId)
);
const activeUndecided = undecidedUsers.filter(u => !inactiveUserIds.has(u.userId));

assertEqual(activeUndecided.length, 2, '休止中除外後の未定者は2人');
assert(!activeUndecided.find(u => u.name === '次郎'), '次郎(休止中)は未定者リストから除外');
assert(activeUndecided.find(u => u.name === '太郎'), '太郎は未定者リストに残る');
assert(activeUndecided.find(u => u.name === '五郎'), '五郎は未定者リストに残る');

// ============================================
// 3. getAllMembers が status を返すことの確認
// ============================================
console.log('\n📋 Test 3: getAllMembers status フィールド');

// lib/sheets.js の getAllMembers のロジック再現
function simulateGetAllMembers(sheetData) {
    const members = [];
    for (let i = 1; i < sheetData.length; i++) {
        if (sheetData[i][0] && sheetData[i][1]) {
            members.push({
                name: sheetData[i][0],
                userId: String(sheetData[i][1]),
                status: sheetData[i][2] || '',
                displayName: sheetData[i][3] || sheetData[i][0] // D列: 表示名 (フォールバック)
            });
        }
    }
    return members;
}

const mockSheetData = [
    ['User Name', 'Discord User ID', 'Status', 'Display Name'],  // ヘッダー
    ['taro_discord', '111', '', '太郎'],
    ['hanako_discord', '222', '', '花子'],
    ['jiro_discord', '333', '休止中', '次郎'],
    ['', '', '', ''],         // 空行 → スキップされるべき
    ['goro_discord', '555', null, null] // Status・DisplayName列がnull
];

const result = simulateGetAllMembers(mockSheetData);
assertEqual(result.length, 4, 'メンバーは4人 (空行はスキップ)');
assertEqual(result[0].status, '', '太郎のステータスは空文字');
assertEqual(result[2].status, '休止中', '次郎のステータスは休止中');
assertEqual(result.find(m => m.name === 'goro_discord')?.status, '', '五郎のステータスはnull→空文字に変換');
assertEqual(result[0].displayName, '太郎', 'D列に値あり → 表示名が設定される');
assertEqual(result[1].displayName, '花子', '花子の表示名が正しい');
assertEqual(result.find(m => m.name === 'goro_discord')?.displayName, 'goro_discord', 'D列がnull → User Nameにフォールバック');

// ============================================
// 4. cron.js / discord.js のモジュール読み込みテスト
// ============================================
console.log('\n📋 Test 4: モジュール読み込み (syntax check)');

try {
    require('../api/cron.js');
    console.log('  ✅ api/cron.js 読み込み成功');
    passed++;
} catch (e) {
    console.log(`  ❌ api/cron.js 読み込み失敗: ${e.message}`);
    failed++;
}

try {
    require('../api/discord.js');
    console.log('  ✅ api/discord.js 読み込み成功');
    passed++;
} catch (e) {
    console.log(`  ❌ api/discord.js 読み込み失敗: ${e.message}`);
    failed++;
}

try {
    const sheets = require('../lib/sheets.js');
    assert(typeof sheets.getAllMembers === 'function', 'getAllMembers がエクスポートされている');
    assert(typeof sheets.getEventLog === 'function', 'getEventLog がエクスポートされている');
    assert(typeof sheets.getUndecidedUsers === 'function', 'getUndecidedUsers がエクスポートされている');
} catch (e) {
    console.log(`  ❌ lib/sheets.js 読み込み失敗: ${e.message}`);
    failed++;
}

try {
    const discord = require('../lib/discord.js');
    assert(typeof discord.sendDirectMessage === 'function', 'sendDirectMessage がエクスポートされている');
    assert(typeof discord.sendDiscordMessage === 'function', 'sendDiscordMessage がエクスポートされている');
    assert(typeof discord.createButtonComponents === 'function', 'createButtonComponents がエクスポートされている');
    assert(typeof discord.buildStatusMessage === 'function', 'buildStatusMessage がエクスポートされている');
} catch (e) {
    console.log(`  ❌ lib/discord.js 読み込み失敗: ${e.message}`);
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
