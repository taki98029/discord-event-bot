/**
 * Discord スラッシュコマンド登録スクリプト（ESM・CLI フォールバック）
 *
 * 通常は管理画面の「コマンドを登録」ボタンで登録できます（ターミナル不要）。
 * このスクリプトは CLI で登録したい場合の代替手段です。
 *
 * 使い方:
 *   npm run register-commands           # = node --env-file=.env で .env を自動ロード
 *
 * 必要な環境変数（.env）:
 *   DISCORD_BOT_TOKEN / DISCORD_APPLICATION_ID
 *   DISCORD_GUILD_ID（任意）… 指定するとそのサーバーへ即時登録（テスト向け）。
 *                            未指定はグローバル登録（反映に最大1時間）
 *
 * コマンド定義は src/discord/commands.json を単一ソースとして共有する。
 */
// ponytail: (d) Node 20 標準 --env-file で .env 読込。dotenv devDep を排除。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const APP_ID = process.env.DISCORD_APPLICATION_ID;

if (!BOT_TOKEN || !APP_ID) {
  console.error('❌ 環境変数 DISCORD_BOT_TOKEN と DISCORD_APPLICATION_ID を設定してください');
  process.exit(1);
}

// 単一ソース: src/discord/commands.json
const commandsPath = fileURLToPath(new URL('../src/discord/commands.json', import.meta.url));
const commands = JSON.parse(readFileSync(commandsPath, 'utf8'));

const GUILD_ID = process.env.DISCORD_GUILD_ID;
const url = GUILD_ID
  ? `https://discord.com/api/v10/applications/${APP_ID}/guilds/${GUILD_ID}/commands`
  : `https://discord.com/api/v10/applications/${APP_ID}/commands`;
console.log(
  GUILD_ID
    ? `📡 Registering ${commands.length} command(s) to guild ${GUILD_ID} (即時反映)...`
    : `📡 Registering ${commands.length} command(s) globally (反映に最大1時間)...`,
);

const response = await fetch(url, {
  method: 'PUT',
  headers: {
    Authorization: `Bot ${BOT_TOKEN}`,
    'Content-Type': 'application/json',
    'User-Agent': 'DiscordBot (https://github.com/taki98029/discord-event-bot, 7.1.0)',
  },
  body: JSON.stringify(commands),
});

if (!response.ok) {
  console.error(`❌ Registration failed (${response.status}):`, await response.text());
  process.exit(1);
}

const result = await response.json();
console.log(`✅ Successfully registered ${result.length} command(s):`);
for (const cmd of result) console.log(`   - /${cmd.name}: ${cmd.description}`);
