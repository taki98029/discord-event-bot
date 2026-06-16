/**
 * Discord スラッシュコマンド登録スクリプト（ESM）
 *
 * 使い方:
 *   node scripts/register-commands.js
 *
 * 必要な環境変数（.env）:
 *   DISCORD_BOT_TOKEN / DISCORD_APPLICATION_ID
 *
 * ※ グローバルコマンドは反映に最大1時間かかる場合があります
 */
import 'dotenv/config';

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const APP_ID = process.env.DISCORD_APPLICATION_ID;

if (!BOT_TOKEN || !APP_ID) {
  console.error('❌ 環境変数 DISCORD_BOT_TOKEN と DISCORD_APPLICATION_ID を設定してください');
  process.exit(1);
}

const commands = [
  { name: 'recruit', description: '次回イベントの募集メッセージを手動で送信します (管理者用)', default_member_permissions: '8' },
  {
    name: 'pause',
    description: 'メンバーを「休止中」に設定します (管理者用)',
    default_member_permissions: '8',
    options: [{ name: 'user', description: '休止中にするメンバー', type: 6, required: true }],
  },
  {
    name: 'resume',
    description: 'メンバーの「休止中」を解除します (管理者用)',
    default_member_permissions: '8',
    options: [{ name: 'user', description: '休止中を解除するメンバー', type: 6, required: true }],
  },
  { name: 'members', description: 'メンバー一覧とステータスを表示します (管理者用)', default_member_permissions: '8' },
  {
    name: 'addmember',
    description: '新メンバーを追加します (管理者用)',
    default_member_permissions: '8',
    options: [{ name: 'user', description: '追加するメンバー', type: 6, required: true }],
  },
];

const url = `https://discord.com/api/v10/applications/${APP_ID}/commands`;
console.log(`📡 Registering ${commands.length} command(s)...`);

const response = await fetch(url, {
  method: 'PUT',
  headers: {
    Authorization: `Bot ${BOT_TOKEN}`,
    'Content-Type': 'application/json',
    'User-Agent': 'DiscordBot (ChoiemuEventBot)',
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
