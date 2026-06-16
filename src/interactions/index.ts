import { verifyKey, InteractionType, InteractionResponseType } from 'discord-interactions';
import type { Env } from '../env';
import { getAllConfig } from '../db/config';
import {
  getAllMembers,
  getMember,
  setMemberStatus,
  addMember,
  updateMemberDisplayName,
} from '../db/members';
import { upsertEventLog, getEventStatus } from '../db/eventLog';
import {
  sendChannelMessage,
  createButtonComponents,
  buildStatusMessage,
} from '../discord/rest';
import { getTargetDate, formatDate } from '../lib/date';

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
    options?: { name: string; value: string; type: number }[];
    resolved?: {
      users?: Record<string, DiscordUser>;
      members?: Record<string, { nick?: string }>;
    };
  };
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

  const resolvedTarget = (): { id: string; name: string } => {
    const id = interaction.data?.options?.[0]?.value as string;
    const u = interaction.data?.resolved?.users?.[id];
    return { id, name: u?.global_name || u?.username || id };
  };

  try {
    switch (name) {
      case 'recruit': {
        const config = await getAllConfig(db);
        const targetDate = getTargetDate({
          eventDayOfWeek: config.Event_DayOfWeek,
          eventStartTime: config.Event_StartTime,
        });
        const targetDateStr = formatDate(targetDate);
        const message =
          `📅 **イベント募集開始!**\n\n` +
          `日時: **${targetDateStr} (${config.Event_DayOfWeek}) ${config.Event_StartTime}~**\n\n` +
          `参加状況を下のボタンで回答してください!`;
        await sendChannelMessage(env, message, createButtonComponents(targetDateStr));
        return ephemeral(`✅ **${targetDateStr}** の募集メッセージを送信しました!`);
      }

      case 'pause': {
        const t = resolvedTarget();
        const found = await setMemberStatus(db, t.id, '休止中');
        return ephemeral(
          found
            ? `⏸️ **${t.name}** を休止中に設定しました。`
            : `❌ **${t.name}** はメンバーに登録されていません。`,
        );
      }

      case 'resume': {
        const t = resolvedTarget();
        const found = await setMemberStatus(db, t.id, '');
        return ephemeral(
          found
            ? `▶️ **${t.name}** の休止中を解除しました。`
            : `❌ **${t.name}** はメンバーに登録されていません。`,
        );
      }

      case 'members': {
        const members = await getAllMembers(db);
        if (members.length === 0) return ephemeral('📋 登録メンバーはいません。');
        let message = `📋 **メンバー一覧 (${members.length}名)**\n\n`;
        for (const m of members) {
          const icon = m.status ? '⏸️' : '🟢';
          const statusText = m.status || 'アクティブ';
          const name = m.display_name || m.user_name || m.user_id;
          message += `${icon} **${name}** (${m.user_name ?? ''}) - ${statusText}\n`;
        }
        return ephemeral(message);
      }

      case 'addmember': {
        const id = interaction.data?.options?.[0]?.value as string;
        const u = interaction.data?.resolved?.users?.[id];
        const userName = u?.username || '';
        const displayName =
          interaction.data?.resolved?.members?.[id]?.nick || u?.global_name || userName;
        const result = await addMember(db, id, userName, displayName);
        return ephemeral(
          result === 'exists'
            ? `⚠️ **${displayName}** は既に登録されています。`
            : `✅ **${displayName}** (${userName}) をメンバーに追加しました!`,
        );
      }

      default:
        return ephemeral('❌ 不明なコマンドです');
    }
  } catch (e) {
    console.error(`[Command] /${name} error:`, (e as Error).message);
    return ephemeral('❌ 処理に失敗しました。管理者に連絡してください。');
  }
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

  // custom_id 形式: {action}_{YYYY/MM/DD}
  const parts = customId.split('_');
  const action = parts[0];
  const eventDate = parts.slice(1).join('_');

  // 状況確認
  if (action === 'status') {
    try {
      const statusData = await getEventStatus(db, eventDate);
      return ephemeral(buildStatusMessage(eventDate, statusData));
    } catch (e) {
      console.error('[Button] status error:', (e as Error).message);
      return ephemeral('❌ 状況確認に失敗しました。');
    }
  }

  const status = STATUS_MAP[action];
  if (!status) return ephemeral('❌ 不明なアクションです');

  // 休止中メンバーは回答不可。未登録は自動登録。
  try {
    const member = await getMember(db, userId);
    if (member) {
      if (member.status) {
        return ephemeral(
          `⏸️ あなたは現在「${member.status}」のため、回答できません。\n管理者に \`/resume\` でステータスを解除してもらってください。`,
        );
      }
    } else {
      await addMember(db, userId, userName, displayName).catch((e) =>
        console.error('[Button] auto-register failed:', (e as Error).message),
      );
    }
  } catch (e) {
    // チェック失敗時は安全側に倒して回答を許可
    console.error('[Button] member check failed:', (e as Error).message);
  }

  try {
    await upsertEventLog(db, eventDate, userId, userName, status);
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
