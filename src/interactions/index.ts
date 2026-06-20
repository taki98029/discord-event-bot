import { verifyKey, InteractionType, InteractionResponseType } from 'discord-interactions';
import type { Env } from '../env';
import type { Notification } from '../db/types';
import { ensureMember, updateMemberDisplayName } from '../db/members';
import { getNotification, listNotificationsByChannel } from '../db/notifications';
import { getOccurrence, listScheduledOccurrences } from '../db/occurrences';
import {
  getSegment,
  getActiveSegmentMembers,
  addSegmentMember,
  listSegmentMembers,
} from '../db/segments';
import { upsertResponse, getStatusBuckets } from '../db/responses';
import { buildStatusMessage, buildAllStatusMessage } from '../discord/rest';
import { roleGateAllows } from '../discord/syncSegment';
import { formatOccurrenceLabel } from '../lib/date';
import { recruitNotificationNow } from '../cron/dailyCheck';

const EPHEMERAL = 64;

interface DiscordUser {
  id: string;
  username?: string;
  global_name?: string;
}

interface DiscordInteraction {
  type: number;
  data?: {
    name?: string;
    custom_id?: string;
    options?: { name: string; value: string | number; type: number }[];
    resolved?: {
      users?: Record<string, DiscordUser>;
      members?: Record<string, { nick?: string }>;
    };
  };
  guild_id?: string;
  channel_id?: string;
  member?: { user?: DiscordUser; nick?: string; roles?: string[] };
  user?: DiscordUser;
}

type InteractionResponse = {
  type: number;
  data?: { content: string; flags?: number };
};

function ephemeral(content: string): InteractionResponse {
  return { type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content, flags: EPHEMERAL } };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const STATUS_MAP: Record<string, string> = {
  participate: '参加',
  absent: '不参加',
  undecided: '未定',
};

/** POST /interactions のエントリ */
export async function handleInteraction(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const signature = request.headers.get('x-signature-ed25519');
  const timestamp = request.headers.get('x-signature-timestamp');
  const rawBody = await request.text();

  if (!signature || !timestamp) {
    return json({ error: 'Missing signature headers' }, 401);
  }

  const valid = await verifyKey(rawBody, signature, timestamp, env.DISCORD_PUBLIC_KEY);
  if (!valid) {
    return json({ error: 'Invalid request signature' }, 401);
  }

  const interaction = JSON.parse(rawBody) as DiscordInteraction;
  const origin = new URL(request.url).origin;

  // PING
  if (interaction.type === InteractionType.PING) {
    return json({ type: InteractionResponseType.PONG });
  }

  // スラッシュコマンド
  if (interaction.type === InteractionType.APPLICATION_COMMAND) {
    return json(await handleCommand(interaction, env, origin));
  }

  // ボタン
  if (interaction.type === InteractionType.MESSAGE_COMPONENT) {
    return json(await handleButton(interaction, env, ctx));
  }

  return json(ephemeral('このインタラクションはサポートされていません'));
}

async function handleCommand(
  interaction: DiscordInteraction,
  env: Env,
  origin: string,
): Promise<InteractionResponse> {
  const name = interaction.data?.name;

  try {
    switch (name) {
      case 'recruit':
        return await handleRecruit(interaction, env);

      case 'help':
        return handleHelp(origin);

      case 'manage':
        return handleManage(origin);

      default:
        return ephemeral('❌ 不明なコマンドです');
    }
  } catch (e) {
    console.error(`[Command] /${name} error:`, (e as Error).message);
    return ephemeral('❌ 処理に失敗しました。管理者に連絡してください。');
  }
}

/** チャンネルから Notification を解決（1チャンネル1通知前提） */
async function resolveNotification(
  db: D1Database,
  interaction: DiscordInteraction,
): Promise<Notification | InteractionResponse> {
  const channelId = interaction.channel_id;
  if (!channelId) return ephemeral('❌ チャンネルを特定できません。');
  const list = await listNotificationsByChannel(db, channelId);
  if (list.length === 0) return ephemeral('❌ このチャンネルに紐づく通知がありません。');
  if (list.length > 1) return ephemeral('❌ このチャンネルに複数の通知が紐づいています。管理UIで整理してください。');
  return list[0];
}

function isEphemeralResponse(v: unknown): v is InteractionResponse {
  // InteractionResponse.type は数値（InteractionResponseType）。Notification.type は
  // 'recurring'|'oneoff' の文字列なので、両者とも 'type' を持つ。数値型で確実に弁別する。
  return typeof v === 'object' && v !== null && typeof (v as { type?: unknown }).type === 'number';
}

/** /recruit — チャンネルの Notification を解決し、単発・複数候補日にも対応して募集投稿 */
async function handleRecruit(
  interaction: DiscordInteraction,
  env: Env,
): Promise<InteractionResponse> {
  const resolved = await resolveNotification(env.DB, interaction);
  if (isEphemeralResponse(resolved)) return resolved;
  const r = await recruitNotificationNow(env, resolved);
  return ephemeral((r.ok ? '✅ ' : '❌ ') + r.message);
}

/** /help — Bot 概要とコマンド一覧を ephemeral で返す */
function handleHelp(origin: string): InteractionResponse {
  const content = [
    '📖 **EventMasterBot — コマンド一覧**',
    '',
    '**誰でも使える**',
    '`/help` — このヘルプを表示',
    '',
    '**管理者用**',
    '`/recruit` — 募集メッセージを今すぐ送信',
    '`/manage` — 管理画面の URL を表示',
    '',
    '💡 出欠の **参加/不参加/未定** は募集メッセージのボタンから操作してください。',
    '💡 メンバー管理・割り当て・休止設定などの細かい操作は管理画面（`/manage`）で行います。',
    '',
    `🔗 管理画面: ${origin}/`,
  ].join('\n');
  return ephemeral(content);
}

/** /manage — 管理画面の URL を ephemeral で返す（管理者のみ） */
function handleManage(origin: string): InteractionResponse {
  const content = [
    '🔧 **管理画面**',
    '',
    `${origin}/`,
    '',
    'ブラウザで開いて **ADMIN_TOKEN** でログインしてください。',
  ].join('\n');
  return ephemeral(content);
}

async function handleButton(
  interaction: DiscordInteraction,
  env: Env,
  ctx: ExecutionContext,
): Promise<InteractionResponse> {
  const db = env.DB;
  const customId = interaction.data?.custom_id;
  const user = interaction.member?.user || interaction.user;
  if (!customId || !user) return ephemeral('❌ 不正なインタラクションです');

  const userId = user.id;
  const userName = user.username ?? '';
  const displayName = interaction.member?.nick || user.global_name || userName;

  // custom_id 形式: {action}_{occurrenceId}
  const sep = customId.lastIndexOf('_');
  const action = sep >= 0 ? customId.slice(0, sep) : customId;
  const occurrenceId = sep >= 0 ? Number(customId.slice(sep + 1)) : NaN;
  if (!Number.isInteger(occurrenceId)) return ephemeral('❌ 不正なインタラクションです');

  // 全候補の状況（単発の集約ボタン）: 末尾の数値は notificationId
  if (action === 'statusall') {
    try {
      const n = await getNotification(db, occurrenceId);
      if (!n) return ephemeral('❌ 対象の通知が見つかりません。');
      const occs = await listScheduledOccurrences(db, n.id);
      if (occs.length === 0) return ephemeral('まだ集計できる候補がありません。');
      // 区分メンバーは 1 回だけ取得して使い回し（候補ごとの再取得を避ける）。集計は並列実行。
      const members = await getActiveSegmentMembers(db, n.segment_id);
      const rows = await Promise.all(
        occs.map(async (o) => ({
          label: formatOccurrenceLabel(o.occurrence_date, o.start_time || n.start_time, n.duration_minutes),
          buckets: await getStatusBuckets(db, o.id, n.segment_id, members),
        })),
      );
      return ephemeral(buildAllStatusMessage(n.name, rows, n.type));
    } catch (e) {
      console.error('[Button] statusall error:', (e as Error).message);
      return ephemeral('❌ 状況確認に失敗しました。');
    }
  }

  // 状況確認（1スロット）
  if (action === 'status') {
    try {
      const occ = await getOccurrence(db, occurrenceId);
      if (!occ) return ephemeral('❌ 対象の開催回が見つかりません。');
      const n = await getNotification(db, occ.notification_id);
      if (!n) return ephemeral('❌ 対象の通知が見つかりません。');
      const buckets = await getStatusBuckets(db, occ.id, n.segment_id);
      const title = formatOccurrenceLabel(occ.occurrence_date, occ.start_time || n.start_time, n.duration_minutes);
      return ephemeral(buildStatusMessage(title, buckets, n.type));
    } catch (e) {
      console.error('[Button] status error:', (e as Error).message);
      return ephemeral('❌ 状況確認に失敗しました。');
    }
  }

  const status = STATUS_MAP[action];
  if (!status) return ephemeral('❌ 不明なアクションです');

  try {
    const occ = await getOccurrence(db, occurrenceId);
    if (!occ) return ephemeral('❌ 対象の開催回が見つかりません。');
    const n = await getNotification(db, occ.notification_id);
    if (!n) return ephemeral('❌ 対象の通知が見つかりません。');

    // ロール管理区分はロールゲートで判定（@everyone は全員可・ADR 0009）。
    // ギルド内ボタンは member.roles が同梱される（追加API不要）。DM のリマインド回答は member 不在の
    // ためロール判定をスキップし、後段の所属/休止チェックに委ねる（roleGateAllows）。
    const segment = await getSegment(db, n.segment_id);
    const memberRoles = interaction.member ? (interaction.member.roles ?? []) : undefined;
    if (segment && !roleGateAllows(segment.mention_role_id, memberRoles)) {
      return ephemeral('🚫 この区分の対象（指定ロールの保有者）ではないため、回答できません。');
    }

    // メンバーマスタへ自動登録（無ければ）
    await ensureMember(db, userId, userName, displayName).catch((e) =>
      console.error('[Button] ensureMember failed:', (e as Error).message),
    );

    // 区分への自動所属（既存なら no-op、status は維持）。ロール管理区分でも保有者なら整合する。
    await addSegmentMember(db, n.segment_id, userId);

    // 休止中なら回答拒否
    const memberships = await listSegmentMembers(db, n.segment_id);
    const mine = memberships.find((m) => m.user_id === userId);
    if (mine && mine.status) {
      return ephemeral(
        `⏸️ あなたはこの区分で現在「${mine.status}」のため、回答できません。\n管理者に管理画面（\`/manage\`）でステータスを解除してもらってください。`,
      );
    }

    await upsertResponse(db, occ.id, userId, userName, status);
    // 表示名の自動更新は返答に不要なので投げっぱなし
    ctx.waitUntil(
      updateMemberDisplayName(db, userId, displayName, userName).catch((e) =>
        console.error('[Button] update display name failed:', (e as Error).message),
      ),
    );
    return ephemeral(`✅ **${status}** で記録しました!`);
  } catch (e) {
    console.error('[Button] record failed:', (e as Error).message);
    return ephemeral('❌ 記録に失敗しました。管理者に連絡してください。');
  }
}
