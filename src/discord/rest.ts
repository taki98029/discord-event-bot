import type { Env } from '../env';
import type { Member, EventStatusBuckets } from '../db/types';
import { setDmChannelId } from '../db/members';

const API = 'https://discord.com/api/v10';
const USER_AGENT = 'DiscordBot (https://github.com/choiemu/event-bot, 6.0.0)';

type MessagePayload = { content: string; components?: unknown[] };

export function mentionUser(userId: string): string {
  return `<@${userId}>`;
}

/** 出欠回答ボタン（参加/不参加/未定/状況確認） */
export function createButtonComponents(eventDate: string): unknown[] {
  return [
    {
      type: 1, // Action Row
      components: [
        { type: 2, style: 3, label: '参加', custom_id: `participate_${eventDate}` },
        { type: 2, style: 4, label: '不参加', custom_id: `absent_${eventDate}` },
        { type: 2, style: 2, label: '未定', custom_id: `undecided_${eventDate}` },
        { type: 2, style: 2, label: '📊 状況確認', custom_id: `status_${eventDate}` },
      ],
    },
  ];
}

/** 状況確認メッセージ（旧 buildStatusMessage） */
export function buildStatusMessage(targetDate: string, s: EventStatusBuckets): string {
  const fmt = (users: string[]) => (users.length > 0 ? users.join(', ') : '(なし)');
  return (
    `📅 **${targetDate} の参加状況**\n\n` +
    `⭕ **参加 (${s.参加.length}名)**\n${fmt(s.参加)}\n\n` +
    `❌ **不参加 (${s.不参加.length}名)**\n${fmt(s.不参加)}\n\n` +
    `❓ **未定 (${s.未定.length}名)**\n${fmt(s.未定)}\n\n` +
    `⚠️ **未回答 (${s.未回答.length}名)**\n${fmt(s.未回答)}`
  );
}

async function postMessage(
  env: Env,
  channelId: string,
  content: string,
  components: unknown[] | null,
): Promise<boolean> {
  const payload: MessagePayload = { content };
  if (components) payload.components = components;

  try {
    const res = await fetch(`${API}/channels/${channelId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error(`Discord API error ${res.status}: ${await res.text()}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error(`Discord send error: ${(e as Error).message}`);
    return false;
  }
}

/** チャンネルへ送信（旧 sendDiscordMessage）。channelId 省略時は既定チャンネル */
export async function sendChannelMessage(
  env: Env,
  content: string,
  components: unknown[] | null = null,
  channelId: string = env.DISCORD_CHANNEL_ID,
): Promise<boolean> {
  return postMessage(env, channelId, content, components);
}

/** DM チャンネルを作成して channelId を返す（旧 createDM） */
async function createDM(env: Env, userId: string): Promise<string | null> {
  try {
    const res = await fetch(`${API}/users/@me/channels`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify({ recipient_id: userId }),
    });
    if (!res.ok) {
      console.error(`Failed to create DM: ${await res.text()}`);
      return null;
    }
    const data = (await res.json()) as { id: string };
    return data.id;
  } catch (e) {
    console.error(`Create DM error: ${(e as Error).message}`);
    return null;
  }
}

/**
 * メンバーへ DM 送信。dm_channel_id があれば再利用し、無ければ作成してキャッシュ。
 * サブリクエスト数を削減する（旧 sendDirectMessage + キャッシュ）。
 */
export async function sendDirectMessageCached(
  env: Env,
  db: D1Database,
  member: Member,
  content: string,
  components: unknown[] | null = null,
): Promise<boolean> {
  let channelId = member.dm_channel_id;
  if (!channelId) {
    channelId = await createDM(env, member.user_id);
    if (!channelId) return false;
    await setDmChannelId(db, member.user_id, channelId).catch((e) =>
      console.error(`Failed to cache dm_channel_id: ${(e as Error).message}`),
    );
  }
  return postMessage(env, channelId, content, components);
}
