/**
 * Discord スラッシュコマンド登録スクリプト（ESM）
 *
 * 使い方:
 *   node scripts/register-commands.js
 *
 * 必要な環境変数:
 *   DISCORD_BOT_TOKEN / DISCORD_APPLICATION_ID
 *   DISCORD_GUILD_ID（任意）… 指定するとそのサーバーへ即時登録（テスト向け）。
 *                            未指定はグローバル登録（反映に最大1時間）
 */
import 'dotenv/config';

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const APP_ID = process.env.DISCORD_APPLICATION_ID;

if (!BOT_TOKEN || !APP_ID) {
  console.error('❌ 環境変数 DISCORD_BOT_TOKEN と DISCORD_APPLICATION_ID を設定してください');
  process.exit(1);
}

// Discord option type: 4 = INTEGER, 6 = USER
const commands = [
  {
    name: 'recruit',
    description: '募集メッセージを送信します (管理者用)',
    default_member_permissions: '8',
  },
  {
    name: 'assign',
    description: '最新開催回に番号を割り当てます (管理者用)',
    default_member_permissions: '8',
  },
  {
    name: 'pause',
    description: 'メンバーを区分ごとに「休止中」に設定します (管理者用)',
    default_member_permissions: '8',
    options: [
      { name: 'user', description: '休止中にするメンバー', type: 6, required: true },
      { name: 'segment_id', description: '対象の区分ID（未指定で所属が1つなら自動選択）', type: 4, required: false },
    ],
  },
  {
    name: 'resume',
    description: 'メンバーの区分ごとの「休止中」を解除します (管理者用)',
    default_member_permissions: '8',
    options: [
      { name: 'user', description: '休止中を解除するメンバー', type: 6, required: true },
      { name: 'segment_id', description: '対象の区分ID（未指定で所属が1つなら自動選択）', type: 4, required: false },
    ],
  },
  {
    name: 'members',
    description: 'メンバー一覧を表示します (管理者用)',
    default_member_permissions: '8',
    options: [{ name: 'segment_id', description: '対象の区分ID（未指定で全メンバー）', type: 4, required: false }],
  },
];

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
    'User-Agent': 'DiscordBot (https://github.com/discord-event-bot, 7.0.0)',
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
