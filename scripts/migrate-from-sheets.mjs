/**
 * Google Sheets（旧 Vercel 勤怠システムのデータストア）→ 現行 D1 スキーマ への
 * 一度きりの移行 seed SQL ジェネレータ。
 *
 * 旧モデル: Config(KV) / Member_DB / Event_Log の「単一定例イベント」。
 * 現行モデル: Server(guild_id) ＞ Notification → Segment ＞ Occurrence → Response。
 *   旧は実質「1 サーバー・1 区分・1 通知」なので、本スクリプトは
 *     - Segment   1 件（id=1）
 *     - Notification 1 件（id=1, Config の運用設定を各列へ写像）
 *     - Member_DB → members（人物マスタ）＋ segment_members（区分所属＋休止状態）
 *     - Event_Log の各開催日 → occurrences（id=連番）、各行 → responses
 *   を生成する。複数区分／複数通知へ分けたい場合は、生成後の seed.sql を手で分割するか
 *   本スクリプトを拡張する（STATUS_MAP / パラメータを編集）。
 *
 * 重要（セキュリティ）:
 *   現行スキーマに config テーブルは無い。Config の Discord_Bot_Token / GAS_Auth_Token 等の
 *   シークレットは D1 ではなく Wrangler secret（wrangler secret put ...）へ入れる。
 *   本スクリプトはトークン類を seed.sql に一切出力しない。
 *   （Discord_Channel_ID だけは通知の投稿先 channel_id として使う＝ID であり秘密ではない。）
 *
 * 必要な移行パラメータ（旧データに無いので環境変数で与える）:
 *   MIGRATE_GUILD_ID          (必須) 移行先 Discord サーバー(Guild)の ID（Snowflake）
 *   MIGRATE_SEGMENT_NAME      (任意, 既定 'メンバー') 生成する区分名
 *   MIGRATE_NOTIFICATION_NAME (任意, 既定 '定例')     生成する通知名
 *   MIGRATE_CHANNEL_ID        (任意) 投稿先チャンネル ID。未指定なら Config の Discord_Channel_ID を使う
 *
 * 使い方:
 *   1) .env に GOOGLE_SERVICE_ACCOUNT_JSON / GOOGLE_SPREADSHEET_ID と上記 MIGRATE_* を設定
 *   2) node scripts/migrate-from-sheets.mjs
 *   3) 生成された scripts/seed.sql を**内容確認のうえ** D1 へ適用:
 *        ローカル: wrangler d1 execute choiemu-event-bot-db --local  --file=scripts/seed.sql
 *        本番    : wrangler d1 execute choiemu-event-bot-db --remote --file=scripts/seed.sql
 *      ※ 本番適用は CLAUDE.md によりユーザーの事前許可が必須。
 *
 * D1 へ直接書き込まず SQL ファイルを出力するだけなので安全（内容を確認してから適用できる）。
 * 生成される seed.sql はメンバーの Discord ID 等の個人情報を含むため .gitignore 済み（コミット禁止）。
 */
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { google } from 'googleapis';

const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;
const SA_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

if (!SPREADSHEET_ID || !SA_JSON) {
  console.error('❌ GOOGLE_SPREADSHEET_ID と GOOGLE_SERVICE_ACCOUNT_JSON を .env に設定してください');
  process.exit(1);
}

// --- 移行パラメータ（旧データに無いので環境変数で補う） ---
const GUILD_ID = process.env.MIGRATE_GUILD_ID;
const SEGMENT_NAME = process.env.MIGRATE_SEGMENT_NAME || 'メンバー';
const NOTIFICATION_NAME = process.env.MIGRATE_NOTIFICATION_NAME || '定例';
const CHANNEL_ID_OVERRIDE = process.env.MIGRATE_CHANNEL_ID || '';

if (!GUILD_ID) {
  console.error('❌ MIGRATE_GUILD_ID（移行先 Discord サーバーの ID）を環境変数で指定してください');
  process.exit(1);
}

/**
 * 旧 Member_DB.Status（自由文字列）→ 新 segment_members.status の写像。
 *   ''       … アクティブ（リマインド/ノルマ/集計の対象）
 *   '休止中' … 休止（対象外）
 *   null     … 区分に所属させない（退会扱い。members マスタには残すが segment_members には入れない）
 * ※ 旧 Status のセマンティクスは運用依存。'スタッフ' を別区分に分けたい等の要件があれば、
 *    ここを編集するか生成後の seed.sql を手で分割する。未知の値は安全側（'休止中'）に倒し、
 *    実行時にサマリ警告を出すので、適用前にこのマップを見直すこと。
 */
const STATUS_MAP = {
  '': '',
  休止中: '休止中',
  活動休止中: '休止中',
  回答不要: '休止中',
  スタッフ: '', // 1 区分へまとめる前提でアクティブ扱い。別区分にしたい場合は要編集。
  所属解消: null, // 退会: members には残すが区分には入れない
  退会: null,
};

const unknownStatuses = new Map(); // raw -> count（未知ステータスの集計・警告用）

/** 旧 Status → { value: ''|'休止中', include: bool }。include=false は区分に入れない */
function mapStatus(raw) {
  const key = (raw ?? '').toString().trim();
  if (Object.prototype.hasOwnProperty.call(STATUS_MAP, key)) {
    const mapped = STATUS_MAP[key];
    return mapped === null ? { value: '', include: false } : { value: mapped, include: true };
  }
  unknownStatuses.set(key, (unknownStatuses.get(key) ?? 0) + 1);
  return { value: '休止中', include: true }; // 未知は安全側（対象外）に倒す
}

/** 旧 Event_DayOfWeek（SUNDAY..SATURDAY） → RFC5545 曜日コード（SU..SA） */
const WEEKDAY_CODE = {
  SUNDAY: 'SU',
  MONDAY: 'MO',
  TUESDAY: 'TU',
  WEDNESDAY: 'WE',
  THURSDAY: 'TH',
  FRIDAY: 'FR',
  SATURDAY: 'SA',
};

let mentionWarning = null; // Recruit_Mention の形式が不明だった場合の警告用

/**
 * 旧 Config の Recruit_Mention を 新 segments.mention_role_id 形式へ正規化する。
 * アプリ(src/discord/rest.ts buildMentionPrefix)は '@everyone' か「素のロールID」を期待し、
 * 後者を `<@&id>` へ展開する。生のメンション文字列 `<@&123>` をそのまま入れると二重展開で壊れる。
 *   ''                 → null（メンションなし）
 *   '@everyone'/'everyone' → '@everyone'
 *   '<@&123>' / '123'  → '123'（素のロールID）
 *   それ以外           → そのまま返しつつ警告（要目視確認）
 */
function normalizeMention(raw) {
  const s = (raw ?? '').toString().trim();
  if (s === '') return null;
  if (s === '@everyone' || s === 'everyone') return '@everyone';
  const m = s.match(/^<@&(\d+)>$/);
  if (m) return m[1];
  if (/^\d+$/.test(s)) return s;
  mentionWarning = s;
  return s;
}

/** 文字列リテラル「外」にある整形用の \n \t \r エスケープ（2文字の \+n 等）を除去 */
function stripStructuralEscapes(s) {
  let out = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (esc) {
      out += ch;
      esc = false;
      continue;
    }
    if (ch === '\\') {
      if (inStr) {
        out += ch;
        esc = true;
        continue;
      }
      const next = s[i + 1];
      if (next === 'n' || next === 't' || next === 'r') {
        i++; // 整形用エスケープを破棄
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === '"') inStr = !inStr;
    out += ch;
  }
  return out;
}

/** 文字列リテラル「内」の実制御文字を JSON エスケープへ変換 */
function escapeControlInStrings(s) {
  let out = '';
  let inStr = false;
  let esc = false;
  for (const ch of s) {
    if (esc) {
      out += ch;
      esc = false;
      continue;
    }
    if (ch === '\\') {
      out += ch;
      esc = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      out += ch;
      continue;
    }
    if (inStr && (ch === '\n' || ch === '\r' || ch === '\t')) {
      out += ch === '\n' ? '\\n' : ch === '\r' ? '\\r' : '\\t';
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * サービスアカウント JSON をパース。.env の格納形式の差異（整形JSONの改行が \n として
 * エスケープ済み / 実改行で展開済み 等）を吸収する。失敗しても秘密鍵は出力しない。
 */
function parseServiceAccount(raw) {
  for (const fn of [(x) => x, stripStructuralEscapes, escapeControlInStrings]) {
    try {
      return JSON.parse(fn(raw));
    } catch {
      /* 次の戦略へ */
    }
  }
  throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON のパースに失敗しました（.env の形式を確認してください）');
}

const auth = new google.auth.GoogleAuth({
  credentials: parseServiceAccount(SA_JSON),
  scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
});
const sheets = google.sheets({ version: 'v4', auth });

async function read(range) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range });
  return res.data.values || [];
}

/** SQL 文字列リテラル化 */
function q(v) {
  return `'${String(v).replace(/'/g, "''")}'`;
}
/** 空/未指定は SQL NULL */
function qOrNull(v) {
  if (v === undefined || v === null || String(v).trim() === '') return 'NULL';
  return q(v);
}
/** 整数 or 既定値 */
function intOr(v, fallback) {
  const n = parseInt(String(v ?? '').trim(), 10);
  return Number.isFinite(n) ? n : fallback;
}
/** 整数 or NULL（nullable な数値列用） */
function intOrNull(v) {
  const s = String(v ?? '').trim();
  if (s === '') return 'NULL';
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? String(n) : 'NULL';
}

function fmtDate(v) {
  // 'YYYY/MM/DD' を維持（ゼロ埋め整形）
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}/${m}/${day}`;
}

async function main() {
  const MIGRATED_AT = new Date().toISOString();
  const lines = [];
  lines.push('-- discord-event-bot 移行データ（旧 Google Sheets → 現行 D1 スキーマ）');
  lines.push('-- 生成: scripts/migrate-from-sheets.mjs');
  lines.push(`-- 生成日時: ${MIGRATED_AT}`);
  lines.push(`-- 移行先 Server(guild_id): ${GUILD_ID}`);
  lines.push('-- ※ トークン等のシークレットは含めない（Wrangler secret で別途設定すること）');
  lines.push('');

  // --- Config（KV）を map 化 ---
  const configRows = await read('Config!A:B');
  const config = {};
  for (let i = 1; i < configRows.length; i++) {
    const [key, value] = configRows[i];
    if (key) config[String(key).trim()] = (value ?? '').toString();
  }

  // 投稿先チャンネル: 環境変数優先、無ければ Config の Discord_Channel_ID
  const channelId = (CHANNEL_ID_OVERRIDE || config['Discord_Channel_ID'] || '').trim();
  if (!channelId) {
    console.error(
      '❌ 投稿先チャンネルが特定できません。MIGRATE_CHANNEL_ID を指定するか Config に Discord_Channel_ID を用意してください',
    );
    process.exit(1);
  }

  // 開催曜日 → RRULE
  const dow = (config['Event_DayOfWeek'] || '').toString().trim().toUpperCase();
  const bycode = WEEKDAY_CODE[dow];
  if (!bycode) {
    console.error(
      `❌ Config の Event_DayOfWeek が不正です: ${JSON.stringify(config['Event_DayOfWeek'])}（SUNDAY..SATURDAY を想定）`,
    );
    process.exit(1);
  }
  const rrule = `FREQ=WEEKLY;BYDAY=${bycode}`;
  const startTime = (config['Event_StartTime'] || '21:00').toString().trim();
  const recruitDaysBefore = intOr(config['Recruit_DaysBefore'], 7);
  const remindStartDays = intOr(config['Remind_Start_Days'], 3);
  const remindUndecidedDays = intOr(config['Remind_Undecided_Days'], 1);
  const quotaIntervalRaw = intOrNull(config['Quota_Interval_Days']);
  const quotaEnabled = quotaIntervalRaw === 'NULL' ? 0 : 1;
  const recruitMention = (config['Recruit_Mention'] || '').toString().trim();
  const mentionRole = normalizeMention(recruitMention); // 素のロールID / '@everyone' / null
  const mentionEnabled = mentionRole ? 1 : 0;

  // --- segment（id=1） ---
  lines.push('-- segment（旧 Member_DB ＝ 単一区分）');
  lines.push(
    `INSERT OR REPLACE INTO segments (id, guild_id, name, mention_role_id, created_at) VALUES (` +
      `1, ${q(GUILD_ID)}, ${q(SEGMENT_NAME)}, ${qOrNull(mentionRole)}, ${q(MIGRATED_AT)});`,
  );
  lines.push('');

  // --- notification（id=1, 旧 Config を写像） ---
  lines.push('-- notification（旧 Config の単一定例設定を写像。type=recurring / weekly）');
  lines.push(
    `INSERT OR REPLACE INTO notifications (` +
      `id, guild_id, segment_id, name, channel_id, type, rrule, one_off_date, anchor_date, start_time, ` +
      `recruit_days_before, remind_start_days, remind_undecided_days, ` +
      `quota_enabled, quota_interval_days, assignment_enabled, mention_enabled, active, created_at) VALUES (` +
      `1, ${q(GUILD_ID)}, 1, ${q(NOTIFICATION_NAME)}, ${q(channelId)}, 'recurring', ${q(rrule)}, NULL, NULL, ${q(startTime)}, ` +
      `${recruitDaysBefore}, ${remindStartDays}, ${remindUndecidedDays}, ` +
      `${quotaEnabled}, ${quotaIntervalRaw}, 0, ${mentionEnabled}, 1, ${q(MIGRATED_AT)});`,
  );
  lines.push('');

  // --- members ＋ segment_members（A:user_name B:user_id C:status D:display_name） ---
  const memberRows = await read('Member_DB!A:D');
  lines.push('-- members（人物マスタ）');
  const memberLines = [];
  const segMemberLines = [];
  let memberCount = 0;
  let excludedCount = 0;
  let pausedCount = 0;
  for (let i = 1; i < memberRows.length; i++) {
    const [userName, userId, status, displayName] = memberRows[i];
    if (!userId) continue;
    memberCount++;
    memberLines.push(
      `INSERT INTO members (user_id, user_name, display_name, created_at) VALUES (` +
        `${q(String(userId))}, ${qOrNull(userName)}, ${qOrNull(displayName)}, ${q(MIGRATED_AT)}) ` +
        `ON CONFLICT(user_id) DO UPDATE SET user_name=excluded.user_name, display_name=excluded.display_name;`,
    );
    const m = mapStatus(status);
    if (!m.include) {
      excludedCount++;
      continue; // 退会等: 区分には入れない
    }
    if (m.value === '休止中') pausedCount++;
    segMemberLines.push(
      `INSERT INTO segment_members (segment_id, user_id, status, joined_at) VALUES (` +
        `1, ${q(String(userId))}, ${q(m.value)}, ${q(MIGRATED_AT)}) ` +
        `ON CONFLICT(segment_id, user_id) DO UPDATE SET status=excluded.status;`,
    );
  }
  lines.push(...memberLines);
  lines.push('');
  lines.push('-- segment_members（区分所属＋休止状態）');
  lines.push(...segMemberLines);
  lines.push('');

  // --- occurrences ＋ responses（A:date B:user_id C:user_name D:status E:timestamp） ---
  const logRows = await read('Event_Log!A:E');
  // 開催日 → occurrence id（昇順で 1..N を採番）
  const dateToOcc = new Map();
  const responseEntries = [];
  let skippedLogs = 0;
  for (let i = 1; i < logRows.length; i++) {
    const [date, userId, userName, status, ts] = logRows[i];
    if (!date || !userId || !status) {
      skippedLogs++;
      continue;
    }
    const d = fmtDate(date);
    if (!dateToOcc.has(d)) dateToOcc.set(d, 0); // 採番は後でまとめて
    responseEntries.push({
      date: d,
      userId: String(userId),
      userName,
      status: String(status).trim(),
      updatedAt: ts && String(ts).trim() ? String(ts) : MIGRATED_AT,
    });
  }
  // 日付昇順で occurrence id を確定
  const sortedDates = [...dateToOcc.keys()].sort();
  sortedDates.forEach((d, idx) => dateToOcc.set(d, idx + 1));

  lines.push('-- occurrences（旧 Event_Log の開催日を実体化。notification_id=1）');
  for (const d of sortedDates) {
    lines.push(
      `INSERT OR REPLACE INTO occurrences (id, notification_id, occurrence_date, status, created_at) VALUES (` +
        `${dateToOcc.get(d)}, 1, ${q(d)}, 'scheduled', ${q(MIGRATED_AT)});`,
    );
  }
  lines.push('');

  lines.push('-- responses（旧 Event_Log の各行。キーを (occurrence_id, user_id) へ変換）');
  let responseCount = 0;
  for (const r of responseEntries) {
    const occId = dateToOcc.get(r.date);
    if (!occId) continue;
    responseCount++;
    lines.push(
      `INSERT INTO responses (occurrence_id, user_id, user_name, status, updated_at) VALUES (` +
        `${occId}, ${q(r.userId)}, ${qOrNull(r.userName)}, ${q(r.status)}, ${q(r.updatedAt)}) ` +
        `ON CONFLICT(occurrence_id, user_id) DO UPDATE SET status=excluded.status, user_name=excluded.user_name, updated_at=excluded.updated_at;`,
    );
  }
  lines.push('');

  const out = 'scripts/seed.sql';
  writeFileSync(out, lines.join('\n') + '\n', 'utf8');

  console.log(`✅ 生成しました: ${out}`);
  console.log('');
  console.log('   [生成サマリ]');
  console.log(`   - segment: 1 件（name='${SEGMENT_NAME}', guild_id=${GUILD_ID}）`);
  console.log(
    `   - notification: 1 件（name='${NOTIFICATION_NAME}', rrule='${rrule}', start_time='${startTime}', channel_id='${channelId}'）`,
  );
  console.log(
    `   - members: ${memberCount} 名（アクティブ ${memberCount - excludedCount - pausedCount} / 休止 ${pausedCount} / 区分除外 ${excludedCount}）`,
  );
  console.log(`   - occurrences: ${sortedDates.length} 回 / responses: ${responseCount} 件（skip ${skippedLogs} 件）`);
  if (unknownStatuses.size > 0) {
    console.log('');
    console.log('   ⚠️ 未知の Member_DB.Status を検出（既定で「休止中」へ寄せています。STATUS_MAP を見直してください）:');
    for (const [raw, count] of unknownStatuses) console.log(`      - ${JSON.stringify(raw)}: ${count} 名`);
  }
  if (mentionWarning) {
    console.log('');
    console.log(`   ⚠️ Recruit_Mention の形式が不明です: ${JSON.stringify(mentionWarning)}`);
    console.log('      mention_role_id は「素のロールID」または「@everyone」を想定。生成後の seed.sql を確認してください。');
  }
  console.log('');
  console.log('   ⚠️ Discord/GAS のトークン類は seed.sql に含めていません。新システムのシークレットは');
  console.log('      wrangler secret put DISCORD_BOT_TOKEN 等で別途設定してください。');
  console.log('');
  console.log('次のコマンドで D1 に適用してください（内容確認のうえ）:');
  console.log('  wrangler d1 execute choiemu-event-bot-db --local  --file=scripts/seed.sql   # ローカル検証');
  console.log('  wrangler d1 execute choiemu-event-bot-db --remote --file=scripts/seed.sql   # 本番（要事前許可）');
}

main().catch((e) => {
  console.error('❌ Error:', e.message);
  process.exit(1);
});
