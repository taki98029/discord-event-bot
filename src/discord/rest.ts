import type { Env } from '../env';
import type { Member, EventStatusBuckets, Segment } from '../db/types';
import { setDmChannelId } from '../db/members';

const API = 'https://discord.com/api/v10';
/** Discord API への User-Agent（バージョンは package.json と同期）。コマンド登録でも共用。 */
export const USER_AGENT = 'DiscordBot (https://github.com/discord-event-bot, 7.0.0)';

type MessagePayload = { content: string; components?: unknown[] };

export function mentionUser(userId: string): string {
  return `<@${userId}>`;
}

/** 出欠回答ボタン（参加/不参加/未定/状況確認）。custom_id は {action}_{occurrenceId} */
export function createButtonComponents(occurrenceId: number): unknown[] {
  return [
    {
      type: 1, // Action Row
      components: [
        { type: 2, style: 3, label: '参加', custom_id: `participate_${occurrenceId}` },
        { type: 2, style: 4, label: '不参加', custom_id: `absent_${occurrenceId}` },
        { type: 2, style: 2, label: '未定', custom_id: `undecided_${occurrenceId}` },
        { type: 2, style: 2, label: '📊 状況確認', custom_id: `status_${occurrenceId}` },
      ],
    },
  ];
}

/**
 * 募集メッセージの @メンション接頭辞を組み立てる。
 * enabled かつ Segment に mention_role_id があれば、その指定でメンションを付ける。
 * '@everyone' はそのまま、それ以外はロールメンション `<@&id>` として展開する。
 */
export function buildMentionPrefix(segment: Segment, enabled: boolean): string {
  if (!enabled || !segment.mention_role_id) return '';
  if (segment.mention_role_id === '@everyone') return '@everyone\n\n';
  return `<@&${segment.mention_role_id}>\n\n`;
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

/** チャンネルへ送信（旧 sendDiscordMessage）。channelId は必須（既定チャンネル廃止） */
export async function sendChannelMessage(
  env: Env,
  channelId: string,
  content: string,
  components: unknown[] | null = null,
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

// =============================================================
// 管理 UI 用の Discord 読み取り（サーバー / チャンネル / メンバーのピッカー）
// すべて GET（読み取り専用）。MOCK_DISCORD 時はフィクスチャを返し外部へ出ない（ADR 0008）。
// =============================================================

/** bot が参加しているサーバー（最上位スコープ・ADR 0004） */
export interface GuildSummary {
  id: string;
  name: string;
  icon: string | null;
}
/** 投稿先に選べるテキストチャンネル */
export interface ChannelSummary {
  id: string;
  name: string;
}
/** メンバーピッカーの 1 候補（サーバー内ニック付き・ADR 0006） */
export interface GuildMemberSummary {
  user_id: string;
  user_name: string | null;
  display_name: string | null;
}

const MOCK_GUILDS: GuildSummary[] = [
  { id: '1001', name: '土曜サークル', icon: null },
  { id: '1002', name: '音楽部の集い', icon: null },
];
const MOCK_CHANNELS: ChannelSummary[] = [
  { id: '2001', name: '出欠' },
  { id: '2002', name: '雑談' },
  { id: '2003', name: 'スタッフ連絡' },
];
const MOCK_MEMBERS: GuildMemberSummary[] = [
  { user_id: '3001', user_name: 'aoi', display_name: 'あおい' },
  { user_id: '3002', user_name: 'kenta', display_name: 'けんた' },
  { user_id: '3003', user_name: 'miki', display_name: 'みき' },
];

function botHeaders(env: Env): HeadersInit {
  return { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, 'User-Agent': USER_AGENT };
}

/** bot の参加サーバー一覧（GET /users/@me/guilds・特権インテント不要） */
export async function listGuilds(env: Env): Promise<GuildSummary[]> {
  if (env.MOCK_DISCORD) return MOCK_GUILDS;
  const res = await fetch(`${API}/users/@me/guilds`, { headers: botHeaders(env) });
  if (!res.ok) throw new Error(`Discord guilds ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as Array<{ id: string; name: string; icon: string | null }>;
  return data.map((g) => ({ id: g.id, name: g.name, icon: g.icon ?? null }));
}

/** サーバーのテキストチャンネル一覧（GET /guilds/:id/channels・特権インテント不要） */
export async function listGuildChannels(env: Env, guildId: string): Promise<ChannelSummary[]> {
  if (env.MOCK_DISCORD) return MOCK_CHANNELS;
  const res = await fetch(`${API}/guilds/${guildId}/channels`, { headers: botHeaders(env) });
  if (!res.ok) throw new Error(`Discord channels ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as Array<{ id: string; name: string; type: number; position: number }>;
  // type 0 = GUILD_TEXT / 5 = GUILD_ANNOUNCEMENT。position 昇順で並べる。
  return data
    .filter((c) => c.type === 0 || c.type === 5)
    .sort((a, b) => a.position - b.position)
    .map((c) => ({ id: c.id, name: c.name }));
}

/**
 * サーバーの参加メンバー一覧（GET /guilds/:id/members・**Server Members Intent 必須**・ADR 0006）。
 * 1000 件ごとにページングし、bot を除外。サーバー内ニック（nick）を表示名候補にする。
 * インテント未有効時は Discord が 403 を返すため throw する（呼び出し側でハンドリング）。
 */
export async function listGuildMembers(env: Env, guildId: string): Promise<GuildMemberSummary[]> {
  if (env.MOCK_DISCORD) return MOCK_MEMBERS;
  const out: GuildMemberSummary[] = [];
  let after = '0';
  // 上限 20 ページ（2 万件）で打ち切り（暴走防止）。
  for (let i = 0; i < 20; i++) {
    const res = await fetch(`${API}/guilds/${guildId}/members?limit=1000&after=${after}`, {
      headers: botHeaders(env),
    });
    if (!res.ok) throw new Error(`Discord members ${res.status}: ${await res.text()}`);
    const page = (await res.json()) as Array<{
      user?: { id: string; username?: string; global_name?: string | null; bot?: boolean };
      nick?: string | null;
    }>;
    if (page.length === 0) break;
    for (const m of page) {
      if (!m.user || m.user.bot) continue;
      out.push({
        user_id: m.user.id,
        user_name: m.user.username ?? null,
        display_name: m.nick ?? m.user.global_name ?? m.user.username ?? null,
      });
    }
    after = page[page.length - 1].user?.id ?? after;
    if (page.length < 1000) break;
  }
  return out;
}
