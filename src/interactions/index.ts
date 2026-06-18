import { verifyKey, InteractionType, InteractionResponseType } from 'discord-interactions';
import type { Env } from '../env';
import type { Notification } from '../db/types';
import { ensureMember, updateMemberDisplayName, getAllMembers } from '../db/members';
import { getNotification, listNotificationsByChannel } from '../db/notifications';
import { getOccurrence, getLatestScheduledOccurrence, listScheduledOccurrences } from '../db/occurrences';
import {
  getSegment,
  getActiveSegmentMembers,
  addSegmentMember,
  listSegmentMembers,
  listSegmentsForMember,
  setSegmentMemberStatus,
} from '../db/segments';
import { upsertResponse, getStatusBuckets } from '../db/responses';
import { assignNumbers } from '../db/assignments';
import { sendChannelMessage, buildStatusMessage, buildAllStatusMessage } from '../discord/rest';
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
  member?: { user?: DiscordUser; nick?: string };
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

/** スラッシュコマンドの option を名前で引く */
function getOption(
  interaction: DiscordInteraction,
  name: string,
): { name: string; value: string | number; type: number } | undefined {
  return interaction.data?.options?.find((o) => o.name === name);
}

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

  // PING
  if (interaction.type === InteractionType.PING) {
    return json({ type: InteractionResponseType.PONG });
  }

  // スラッシュコマンド
  if (interaction.type === InteractionType.APPLICATION_COMMAND) {
    return json(await handleCommand(interaction, env));
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
): Promise<InteractionResponse> {
  const db = env.DB;
  const name = interaction.data?.name;

  // user option（pause/resume の対象 User）を解決
  const resolveUserOption = (): { id: string; name: string } | null => {
    const opt = getOption(interaction, 'user');
    if (!opt) return null;
    const id = String(opt.value);
    const u = interaction.data?.resolved?.users?.[id];
    return { id, name: u?.global_name || u?.username || id };
  };

  try {
    switch (name) {
      case 'recruit':
        return await handleRecruit(interaction, env);

      case 'assign':
        return await handleAssign(interaction, env);

      case 'pause':
      case 'resume': {
        const target = resolveUserOption();
        if (!target) return ephemeral('❌ 対象ユーザーを指定してください。');
        return await handlePauseResume(db, interaction, target, name === 'pause');
      }

      case 'members':
        return await handleMembers(db, interaction);

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

/** /assign notification_id — 最新の予定回に assignNumbers し、結果を公開投稿＋実行者へ要約 */
async function handleAssign(
  interaction: DiscordInteraction,
  env: Env,
): Promise<InteractionResponse> {
  const db = env.DB;
  const resolved = await resolveNotification(db, interaction);
  if (isEphemeralResponse(resolved)) return resolved;
  const n = resolved;

  const occ = await getLatestScheduledOccurrence(db, n.id);
  if (!occ) return ephemeral('❌ 割り当て対象の開催回（予定）がありません。');

  const { assigned, all } = await assignNumbers(db, occ.id);

  // 結果一覧を Notification のチャンネルへ公開投稿（投稿可否を実行者に伝える）
  let postNote = '';
  if (all.length > 0) {
    let message = `🎲 **割り当て結果** (${occ.occurrence_date})\n\n`;
    message += all.map((a) => `#${a.number} ${a.name}`).join('\n');
    const posted = await sendChannelMessage(env, n.channel_id, message);
    if (!posted) {
      postNote = '\n⚠️ ただし結果のチャンネル投稿に失敗しました（Bot権限・channel_id を確認してください）。';
    }
  } else {
    postNote = '\n（参加者がいないため公開投稿はありません）';
  }

  // 実行者へは ephemeral で要約
  return ephemeral(
    `✅ **${occ.occurrence_date}** の番号割り当てを実行しました。\n` +
      `新規: ${assigned.length}名 / 合計: ${all.length}名` +
      postNote,
  );
}

/** /pause /resume — segment 指定 or 所属から自動選択して休止/解除 */
async function handlePauseResume(
  db: D1Database,
  interaction: DiscordInteraction,
  target: { id: string; name: string },
  pause: boolean,
): Promise<InteractionResponse> {
  const segOpt = getOption(interaction, 'segment_id');
  let segmentId: number;

  if (segOpt !== undefined) {
    segmentId = Number(segOpt.value);
    if (!Number.isInteger(segmentId)) return ephemeral('❌ segment_id が不正です。');
  } else {
    // 未指定: 所属区分が 1 つならそれ、複数なら区分指定を促す、0 なら未所属
    const segments = await listSegmentsForMember(db, target.id);
    if (segments.length === 0) {
      return ephemeral(`❌ **${target.name}** はどの区分にも所属していません。`);
    }
    if (segments.length > 1) {
      const list = segments.map((s) => `- #${s.id} ${s.name}`).join('\n');
      return ephemeral(
        `⚠️ **${target.name}** は複数の区分に所属しています。\`segment_id\` を指定してください。\n\n${list}`,
      );
    }
    segmentId = segments[0].id;
  }

  const status = pause ? '休止中' : '';
  const found = await setSegmentMemberStatus(db, segmentId, target.id, status);
  if (!found) {
    return ephemeral(`❌ **${target.name}** は区分 #${segmentId} に所属していません。`);
  }
  return pause
    ? ephemeral(`⏸️ **${target.name}** を区分 #${segmentId} で休止中に設定しました。`)
    : ephemeral(`▶️ **${target.name}** の区分 #${segmentId} の休止中を解除しました。`);
}

/** /members — segment 指定で区分メンバー一覧、未指定で全メンバー一覧（所属区分付き） */
async function handleMembers(
  db: D1Database,
  interaction: DiscordInteraction,
): Promise<InteractionResponse> {
  const segOpt = getOption(interaction, 'segment_id');

  if (segOpt !== undefined) {
    const segmentId = Number(segOpt.value);
    if (!Number.isInteger(segmentId)) return ephemeral('❌ segment_id が不正です。');
    const segment = await getSegment(db, segmentId);
    if (!segment) return ephemeral(`❌ 区分 #${segmentId} が見つかりません。`);

    const members = await listSegmentMembers(db, segmentId);
    if (members.length === 0) return ephemeral(`📋 区分 **${segment.name}** にメンバーはいません。`);

    let message = `📋 **${segment.name} のメンバー (${members.length}名)**\n\n`;
    for (const m of members) {
      const icon = m.status ? '⏸️' : '🟢';
      const statusText = m.status || 'アクティブ';
      const name = m.display_name || m.user_name || m.user_id;
      message += `${icon} **${name}** (${m.user_name ?? ''}) - ${statusText}\n`;
    }
    return ephemeral(message);
  }

  // 未指定: 全メンバー一覧（所属区分も表示）
  const members = await getAllMembers(db);
  if (members.length === 0) return ephemeral('📋 登録メンバーはいません。');

  let message = `📋 **全メンバー一覧 (${members.length}名)**\n\n`;
  for (const m of members) {
    const segments = await listSegmentsForMember(db, m.user_id);
    const name = m.display_name || m.user_name || m.user_id;
    const segText = segments.length > 0 ? segments.map((s) => s.name).join(', ') : '(所属なし)';
    message += `🟢 **${name}** (${m.user_name ?? ''}) - ${segText}\n`;
  }
  return ephemeral(message);
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

    // メンバーマスタへ自動登録（無ければ）
    await ensureMember(db, userId, userName, displayName).catch((e) =>
      console.error('[Button] ensureMember failed:', (e as Error).message),
    );

    // 区分への自動所属（既存なら no-op、status は維持）
    await addSegmentMember(db, n.segment_id, userId);

    // 休止中なら回答拒否
    const memberships = await listSegmentMembers(db, n.segment_id);
    const mine = memberships.find((m) => m.user_id === userId);
    if (mine && mine.status) {
      return ephemeral(
        `⏸️ あなたはこの区分で現在「${mine.status}」のため、回答できません。\n管理者に \`/resume\` でステータスを解除してもらってください。`,
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
