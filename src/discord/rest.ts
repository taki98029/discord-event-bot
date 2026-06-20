import type { Env } from '../env';
import type { Member, EventStatusBuckets, MentionMode, NotificationType, Segment } from '../db/types';
import { setDmChannelId } from '../db/members';

const API = 'https://discord.com/api/v10';
/** Discord API への User-Agent（バージョンは package.json と同期）。コマンド登録でも共用。 */
export const USER_AGENT = 'DiscordBot (https://github.com/taki98029/discord-event-bot, 7.1.0)';

type MessagePayload = { content: string; components?: unknown[]; allowed_mentions?: unknown };

/** Discord メッセージ content の文字上限。合成後はこれを超えないようにする（ADR 0010）。 */
export const DISCORD_CONTENT_LIMIT = 2000;

export function mentionUser(userId: string): string {
  return `<@${userId}>`;
}

/** 回答の表示ラベル（保存値・custom_id は不変。単発=日程調整は「可/不可/未確定」表記）。 */
export interface AnswerLabels {
  participate: string;
  absent: string;
  undecided: string;
}
export function answerLabels(type: NotificationType): AnswerLabels {
  return type === 'oneoff'
    ? { participate: '可', absent: '不可', undecided: '未確定' }
    : { participate: '参加', absent: '不参加', undecided: '未定' };
}

/**
 * 出欠回答ボタン（可否/状況確認）。custom_id は {action}_{occurrenceId} で固定（保存値も不変）。
 * type で表示ラベルのみ切替（oneoff=可/不可/未確定）。includeStatus=false で状況確認ボタンを省く
 * （単発の複数候補は各スロットに状況確認を付けず、ヘッダの集約ボタンへ寄せるため）。
 */
export function createButtonComponents(
  occurrenceId: number,
  type: NotificationType = 'recurring',
  includeStatus = true,
): unknown[] {
  const L = answerLabels(type);
  const components: unknown[] = [
    { type: 2, style: 3, label: L.participate, custom_id: `participate_${occurrenceId}` },
    { type: 2, style: 4, label: L.absent, custom_id: `absent_${occurrenceId}` },
    { type: 2, style: 2, label: L.undecided, custom_id: `undecided_${occurrenceId}` },
  ];
  if (includeStatus) {
    components.push({ type: 2, style: 2, label: '📊 状況確認', custom_id: `status_${occurrenceId}` });
  }
  return [{ type: 1, components }];
}

/** 単発の複数候補募集ヘッダ用：全候補の状況をまとめて返す集約ボタン。custom_id は statusall_{notificationId}。 */
export function createStatusAllButton(notificationId: number): unknown[] {
  return [
    {
      type: 1,
      components: [
        { type: 2, style: 2, label: '📊 全候補の状況', custom_id: `statusall_${notificationId}` },
      ],
    },
  ];
}

/** バイネームメンションの既定文字予算。呼び出し側が本文長に応じて動的に下げる（ADR 0010）。 */
const MENTION_BUDGET = 1500;

/**
 * 投稿メッセージの @メンション接頭辞を mention_mode に従って組み立てる（ADR 0010）。
 * - 'none': 空文字（メンションなし）
 * - 'role': Segment の mention_role_id をロールメンション。'@everyone' はそのまま、他は `<@&id>`。
 * - 'members': memberIds を `<@id>` で個別列挙。budget を超える分は「ほかN名」と省略（破綻回避）。
 *   budget は「接頭辞全体（末尾改行・省略表記込み）の上限字数」。呼び出し側が見出し/本文/日時の
 *   実長から `2000 −（それら）` を渡すことで、合成後の総量が Discord 上限に収まる。
 * いずれも末尾は改行2つ（接頭辞が空なら本文が先頭に来る）。
 */
export function buildMentionPrefix(
  segment: Segment | null,
  mode: MentionMode,
  memberIds: string[] = [],
  budget: number = MENTION_BUDGET,
): string {
  if (mode === 'none' || !segment) return '';
  if (mode === 'role') {
    if (!segment.mention_role_id) return '';
    if (segment.mention_role_id === '@everyone') return '@everyone\n\n';
    return `<@&${segment.mention_role_id}>\n\n`;
  }
  // 'members': バイネーム。budget 内に収め、超過は「ほかN名」で省略する。
  if (memberIds.length === 0) return '';
  // 「 ほかN名」＋末尾改行(\n\n)ぶんを予約し、接頭辞全体が budget を超えないようにする。
  const cap = budget - 16;
  const shown: string[] = [];
  let used = 0;
  for (const id of memberIds) {
    const tok = `<@${id}>`;
    const add = (shown.length ? 1 : 0) + tok.length; // 区切りスペースぶんも加味
    if (used + add > cap) break;
    shown.push(tok);
    used += add;
  }
  // 予算が無く 1 人も入らない場合はメンションを諦め、本文側を優先する（破綻回避）。
  if (shown.length === 0) return '';
  const omitted = memberIds.length - shown.length;
  const tail = omitted > 0 ? ` ほか${omitted}名` : '';
  return `${shown.join(' ')}${tail}\n\n`;
}

/**
 * チャンネル投稿の本文を合成する（ADR 0010）。
 * `{prefix}**{title}**\n\n{body?}\n\n{tail}` の形。body は空なら省略。
 * tail は日時行（募集/告知）や候補一覧（複数候補ヘッダ）など、システムが自動付加する後段。
 */
export function composePost(
  prefix: string,
  title: string,
  body: string | null,
  tail: string,
): string {
  let msg = `${prefix}**${title}**\n\n`;
  if (body && body.trim()) msg += `${body.trim()}\n\n`;
  msg += tail;
  return msg;
}

/**
 * 状況確認メッセージ。title は日付（または 'YYYY/MM/DD (曜) HH:MM〜' 等の表示ラベル）。
 * type で見出し・回答ラベルを切替（oneoff=調整状況・可/不可/未確定）。集計バケットのキー自体は不変。
 */
export function buildStatusMessage(
  title: string,
  s: EventStatusBuckets,
  type: NotificationType = 'recurring',
): string {
  const L = answerLabels(type);
  const head = type === 'oneoff' ? '調整状況' : '参加状況';
  const fmt = (users: string[]) => (users.length > 0 ? users.join(', ') : '(なし)');
  return (
    `📅 **${title} の${head}**\n\n` +
    `⭕ **${L.participate} (${s.参加.length}名)**\n${fmt(s.参加)}\n\n` +
    `❌ **${L.absent} (${s.不参加.length}名)**\n${fmt(s.不参加)}\n\n` +
    `❓ **${L.undecided} (${s.未定.length}名)**\n${fmt(s.未定)}\n\n` +
    `⚠️ **未回答 (${s.未回答.length}名)**\n${fmt(s.未回答)}`
  );
}

/**
 * 単発の複数候補の状況を 1 メッセージにまとめる（statusall ボタン用）。
 * Discord のメッセージ上限(2000字)に収まるよう、超えそうなら残りを「…ほか N 件」に要約する。
 */
export function buildAllStatusMessage(
  notificationName: string,
  rows: { label: string; buckets: EventStatusBuckets }[],
  type: NotificationType = 'recurring',
): string {
  const L = answerLabels(type);
  const MAX = 1900; // 2000 字制限に対する安全マージン
  let msg = `📊 **${notificationName} の候補別 状況**\n`;
  let shown = 0;
  for (const r of rows) {
    const line =
      `\n🗓️ **${r.label}**\n` +
      `　${L.participate} ${r.buckets.参加.length} / ${L.absent} ${r.buckets.不参加.length} / ` +
      `${L.undecided} ${r.buckets.未定.length} / 未回答 ${r.buckets.未回答.length}`;
    // 最低 1 件は必ず出す。以降は上限を超える行が来たら残数を要約して打ち切る。
    if (shown > 0 && msg.length + line.length > MAX) {
      msg += `\n\n…ほか ${rows.length - shown} 件（長いため省略）`;
      break;
    }
    msg += line;
    shown++;
  }
  return msg;
}

async function postMessage(
  env: Env,
  channelId: string,
  content: string,
  components: unknown[] | null,
  allowedMentions: unknown | null = null,
): Promise<boolean> {
  // 最終防衛: 動的予算で通常は収まるが、想定外経路で上限超過しても 400 で無音失敗しないよう切り詰める。
  let body = content;
  if (body.length > DISCORD_CONTENT_LIMIT) {
    console.warn(
      `[postMessage] content length ${body.length} > ${DISCORD_CONTENT_LIMIT}; truncating (channel=${channelId})`,
    );
    body = body.slice(0, DISCORD_CONTENT_LIMIT - 1) + '…';
  }
  const payload: MessagePayload = { content: body };
  if (components) payload.components = components;
  if (allowedMentions) payload.allowed_mentions = allowedMentions;

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

/**
 * チャンネルへ送信（旧 sendDiscordMessage）。channelId は必須（既定チャンネル廃止）。
 * allowedMentions を渡すと Discord 側の解析対象を絞れる（本文経由の意図しない一斉メンション抑止・ADR 0010）。
 */
export async function sendChannelMessage(
  env: Env,
  channelId: string,
  content: string,
  components: unknown[] | null = null,
  allowedMentions: unknown | null = null,
): Promise<boolean> {
  return postMessage(env, channelId, content, components, allowedMentions);
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
/** メンバーピッカーの 1 候補（サーバー内ニック付き・ADR 0006）。roles はロール同期用（ADR 0009） */
export interface GuildMemberSummary {
  user_id: string;
  user_name: string | null;
  display_name: string | null;
  /** このメンバーが保有する Discord ロールID（@everyone は含まれない） */
  roles: string[];
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
  { user_id: '3001', user_name: 'aoi', display_name: 'あおい', roles: ['4001'] },
  { user_id: '3002', user_name: 'kenta', display_name: 'けんた', roles: ['4001'] },
  { user_id: '3003', user_name: 'miki', display_name: 'みき', roles: [] },
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
      roles?: string[];
    }>;
    if (page.length === 0) break;
    for (const m of page) {
      if (!m.user || m.user.bot) continue;
      out.push({
        user_id: m.user.id,
        user_name: m.user.username ?? null,
        display_name: m.nick ?? m.user.global_name ?? m.user.username ?? null,
        roles: m.roles ?? [],
      });
    }
    after = page[page.length - 1].user?.id ?? after;
    if (page.length < 1000) break;
  }
  return out;
}
