import type { Env } from '../env';
import type { Member, EventStatusBuckets, MentionMode, Segment } from '../db/types';
import { setDmChannelId } from '../db/members';
import pkg from '../../package.json';
import { cutText } from '../lib/text';

export const API = 'https://discord.com/api/v10';
/** Discord API への User-Agent（バージョンは package.json から取得）。コマンド登録でも共用。 */
export const USER_AGENT = `DiscordBot (https://github.com/taki98029/discord-event-bot, ${pkg.version})`;

type MessagePayload = { content: string; components?: unknown[]; allowed_mentions?: unknown };

/** Discord メッセージ content の文字上限。合成後はこれを超えないようにする（ADR 0010）。 */
export const DISCORD_CONTENT_LIMIT = 2000;

export function mentionUser(userId: string): string {
  return `<@${userId}>`;
}

/**
 * 回答の表示ラベル（保存値・custom_id は不変）。旧 oneoff（日程調整）の「可/不可/未確定」表記は
 * oneoff 廃止（2026-08-23・ADR 0025）で撤去し、常に 参加/不参加/未定。
 */
export interface AnswerLabels {
  participate: string;
  absent: string;
  undecided: string;
}
export function answerLabels(): AnswerLabels {
  return { participate: '参加', absent: '不参加', undecided: '未定' };
}

/**
 * 出欠回答ボタン（可否/状況確認）。custom_id は {action}_{occurrenceId} で固定（保存値も不変）。
 * includeStatus=false で状況確認ボタンを省く。
 */
export function createButtonComponents(occurrenceId: number, includeStatus = true): unknown[] {
  const L = answerLabels();
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
  // 上限を超えるときは本文（足りなければ見出し）を削り、メンションと日時・締切の行（tail）は必ず残す。
  // 末尾を切ると日時の行が消えていた（postMessage の切り詰めは末尾から削る）
  let t = title;
  let b = body?.trim() ?? '';
  const build = () => `${prefix}**${t}**\n\n${b ? `${b}\n\n` : ''}${tail}`;
  let over = build().length - DISCORD_CONTENT_LIMIT;
  if (over > 0 && b) {
    b = b.length > over + 1 ? cutText(b, b.length - over - 1) + '…' : '';
    over = build().length - DISCORD_CONTENT_LIMIT;
  }
  if (over > 0) t = cutText(t, Math.max(1, t.length - over - 1)) + '…';
  return build();
}

export { cutText };

/** 保存値（参加/不参加/未定・null=未回答）を「絵文字＋表示ラベル」に変換する。 */
function answerEmojiLabel(status: string | null, L: AnswerLabels): string {
  if (status === '参加') return `⭕ ${L.participate}`;
  if (status === '不参加') return `❌ ${L.absent}`;
  if (status === '未定') return `❓ ${L.undecided}`;
  return '⚠️ 未回答';
}

/**
 * 状況確認メッセージ。title は日付（または 'YYYY/MM/DD (曜) HH:MM〜' 等の表示ラベル）。
 * myAnswer を渡すと（null=未回答含む）先頭に「あなたの回答」行を出す。undefined なら省略（従来表示）。
 * 名前一覧は subtext（-#）で小さく表示し、人数が多いときの視覚ノイズを抑える。
 */
export function buildStatusMessage(title: string, s: EventStatusBuckets, myAnswer?: string | null): string {
  const L = answerLabels();
  const mine = myAnswer === undefined ? '' : `👤 あなたの回答: **${answerEmojiLabel(myAnswer, L)}**\n\n`;
  // Discord の返答は 2000 字まで。超えるときは各欄の名前を先頭から減らして「ほか N 名」にする（人数の見出しは常に全数）
  // ponytail: 上限を段階的に下げて組み直すだけ（最大 6 回）
  const build = (cap: number) => {
    const fmt = (users: string[]) =>
      `-# ${users.length === 0 ? '(なし)' : users.slice(0, cap).join('、') + (users.length > cap ? ` ほか${users.length - cap}名` : '')}`;
    return (
      `📅 **${title} の参加状況**\n\n` +
      mine +
      `⭕ **${L.participate} (${s.参加.length}名)**\n${fmt(s.参加)}\n\n` +
      `❌ **${L.absent} (${s.不参加.length}名)**\n${fmt(s.不参加)}\n\n` +
      `❓ **${L.undecided} (${s.未定.length}名)**\n${fmt(s.未定)}\n\n` +
      `⚠️ **未回答 (${s.未回答.length}名)**\n${fmt(s.未回答)}`
    );
  };
  for (const cap of [Infinity, 60, 30, 15, 5]) {
    const text = build(cap);
    if (text.length <= 2000) return text;
  }
  return build(0).slice(0, 2000);
}

/** 回答非公開のスケジュール（share_answers=0）の状況確認: 本人の回答だけを返す。 */
export function buildOwnAnswerMessage(title: string, myAnswer: string | null): string {
  return `📅 **${title} の参加状況**

👤 あなたの回答: **${answerEmojiLabel(myAnswer, answerLabels())}**

-# このイベントでは、ほかの人の回答は運営だけが確認できます。`;
}

/** Discord の 429（未送信が確実）。rateLimitAware で登録した env の送信だけが投げ、他の呼び出し元は従来どおり false。 */
export class DiscordRateLimited extends Error {}
const rateLimitAwareEnvs = new WeakSet<Env>();
// 送信の待ち時間の上限（日程調整の投稿と同じ 15 秒）。応答が 5 分以上遅れて成功すると、送信中の claim が掃除されて二重送信になるため。
const SEND_TIMEOUT_MS = 15_000;

/** cron のペース配信用: 429 を false ではなく DiscordRateLimited で返させる（claim を消して次ティックで再送するため）。 */
export function rateLimitAware(env: Env): Env {
  rateLimitAwareEnvs.add(env);
  return env;
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
    body = cutText(body, DISCORD_CONTENT_LIMIT - 1) + '…';
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
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (res.status === 429 && rateLimitAwareEnvs.has(env)) throw new DiscordRateLimited(`429 (channel=${channelId})`);
    if (!res.ok) {
      console.error(`Discord API error ${res.status}: ${await res.text()}`);
      return false;
    }
    return true;
  } catch (e) {
    if (e instanceof DiscordRateLimited) throw e;
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
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (res.status === 429 && rateLimitAwareEnvs.has(env)) throw new DiscordRateLimited('429 (create DM)');
    if (!res.ok) {
      console.error(`Failed to create DM: ${await res.text()}`);
      return null;
    }
    const data = (await res.json()) as { id: string };
    return data.id;
  } catch (e) {
    if (e instanceof DiscordRateLimited) throw e;
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
/** 区分に紐付けられるロールの 1 候補（ロールピッカー用） */
export interface RoleSummary {
  id: string;
  name: string;
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
const MOCK_ROLES: RoleSummary[] = [
  { id: '4001', name: 'キャスト' },
  { id: '4002', name: 'スタッフ' },
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

/**
 * bot を指定サーバーから退出させる（DELETE /users/@me/guilds/:id）。
 * ギルド登録したスラッシュコマンドも退出で自動的に消える。既に退出済み（404）は成功扱い。
 */
export async function leaveGuild(env: Env, guildId: string): Promise<void> {
  if (env.MOCK_DISCORD) return;
  const res = await fetch(`${API}/users/@me/guilds/${guildId}`, {
    method: 'DELETE',
    headers: botHeaders(env),
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`Discord leave guild ${res.status}: ${await res.text()}`);
  }
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
 * サーバーのロール一覧（GET /guilds/:id/roles・特権インテント不要）。区分のロールピッカー用。
 * @everyone ロール（id = guildId）はセンチネル文字列 '@everyone' で扱う設計（ADR 0009）のため
 * 一覧から除外する。表示はサーバーのロール階層に合わせ position 降順。
 */
export async function listGuildRoles(env: Env, guildId: string): Promise<RoleSummary[]> {
  if (env.MOCK_DISCORD) return MOCK_ROLES;
  const res = await fetch(`${API}/guilds/${guildId}/roles`, { headers: botHeaders(env) });
  if (!res.ok) throw new Error(`Discord roles ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as Array<{ id: string; name: string; position: number }>;
  return data
    .filter((r) => r.id !== guildId)
    .sort((a, b) => b.position - a.position)
    .map((r) => ({ id: r.id, name: r.name }));
}

/**
 * サーバーの参加メンバー一覧（GET /guilds/:id/members・**Server Members Intent 必須**・ADR 0006）。
 * 1000 件ごとにページングし、bot を除外。サーバー内ニック（nick）を表示名候補にする。
 * インテント未有効時は Discord が 403 を返すため throw する（呼び出し側でハンドリング）。
 */
export async function listGuildMembers(env: Env, guildId: string): Promise<GuildMemberSummary[]> {
  const out: GuildMemberSummary[] = [];
  let after = '0';
  // 上限 20 ページ（2 万件）で打ち切り（暴走防止）。
  for (let i = 0; i < 20; i++) {
    const page = await listGuildMemberPage(env, guildId, after);
    out.push(...page.members);
    after = page.after;
    if (page.done) break;
  }
  return out;
}

/** Bounded page for planning refresh. A partial page is never a complete audience. */
export async function listGuildMemberPage(env: Env, guildId: string, after = '0', limit = 1000) {
  if (env.MOCK_DISCORD) return { members: MOCK_MEMBERS, after: '0', done: true };
  const res = await fetch(`${API}/guilds/${guildId}/members?limit=${limit}&after=${after}`, {
    headers: botHeaders(env), signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Discord members ${res.status}`);
  const page = await res.json() as Array<{
    user?: { id: string; username?: string; global_name?: string | null; bot?: boolean };
    nick?: string | null; roles?: string[];
  }>;
  const members = page.filter((m) => m.user && !m.user.bot).map((m) => ({
    user_id: m.user!.id, user_name: m.user!.username ?? null,
    display_name: m.nick ?? m.user!.global_name ?? m.user!.username ?? null, roles: m.roles ?? [],
  }));
  return { members, after: page.at(-1)?.user?.id ?? after, done: page.length < limit };
}
