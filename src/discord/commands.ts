/**
 * スラッシュコマンド定義の単一ソースと、Discord への登録ヘルパ。
 * コマンド一覧は commands.json に置き、Worker（管理画面の「コマンド登録」ボタン）と
 * scripts/register-commands.js（CLI フォールバック）の両方が同じ定義を使う。
 */
import COMMAND_DEFINITIONS from './commands.json';
import { USER_AGENT } from './rest';

export { COMMAND_DEFINITIONS };

const API = 'https://discord.com/api/v10';

/**
 * スラッシュコマンドを Discord に一括登録（PUT で全置換）。
 * guildId 指定でそのサーバーへ即時登録、未指定でグローバル登録（反映に最大1時間）。
 */
export async function registerCommands(
  botToken: string,
  appId: string,
  guildId?: string | null,
): Promise<{ count: number; names: string[] }> {
  const url = guildId
    ? `${API}/applications/${appId}/guilds/${guildId}/commands`
    : `${API}/applications/${appId}/commands`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bot ${botToken}`,
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify(COMMAND_DEFINITIONS),
  });
  if (!res.ok) throw new Error(`Discord ${res.status}: ${await res.text()}`);
  const result = (await res.json()) as Array<{ name: string }>;
  return { count: result.length, names: result.map((c) => c.name) };
}
