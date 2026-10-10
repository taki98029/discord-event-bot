import { planningDeferredResponse, respondToPlanningInteraction } from '../planning/answer-response';
import { plannedOccurrence } from '../planning/store';
import type { Env } from '../env';
import { getFailureNotificationSettings, notifyDeliveryFailure } from '../discord/failureNotifications';

// ponytail: (d) discord-interactions の verifyKey と enum を Workers ネイティブの Web Crypto + const で置換。
// Cloudflare Workers (workerd) は crypto.subtle.importKey('raw', ..., { name: 'Ed25519' }, ...) と
// crypto.subtle.verify('Ed25519', ...) を 2023 年以降サポート済み。
const InteractionType = { PING: 1, APPLICATION_COMMAND: 2, MESSAGE_COMPONENT: 3 } as const;
const InteractionResponseType = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
} as const;

const HEX_RE = /^[0-9a-f]+$/i;
function hexToBytes(hex: string): Uint8Array {
  if (hex.length === 0 || hex.length % 2 !== 0 || !HEX_RE.test(hex)) throw new Error('invalid hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Discord Interaction 署名（Ed25519）を Web Crypto で検証する。失敗・例外はすべて false 扱い。 */
export async function verifyEd25519(
  rawBody: string,
  signatureHex: string,
  timestamp: string,
  publicKeyHex: string,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      hexToBytes(publicKeyHex),
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    const data = new TextEncoder().encode(timestamp + rawBody);
    return await crypto.subtle.verify('Ed25519', key, hexToBytes(signatureHex), data);
  } catch {
    return false;
  }
}

import { ensureMember, updateMemberDisplayName } from '../db/members';
import { getNotification } from '../db/notifications';
import { getOccurrence } from '../db/occurrences';
import { getSegment, addSegmentMember, getSegmentMemberStatus } from '../db/segments';
import { upsertResponse, getResponseStatus, getStatusBuckets } from '../db/responses';
import { API, USER_AGENT, buildOwnAnswerMessage, buildStatusMessage, sendChannelMessage, answerLabels } from '../discord/rest';
import { roleGateAllows } from '../discord/syncSegment';
import { formatOccurrenceLabel, responseDeadline, getJSTNow } from '../lib/date';
import { deadlineHoursFor, durationFor, isAnnounceOnly } from '../db/types';

const EPHEMERAL = 64;

interface DiscordUser {
  id: string;
  username?: string;
  global_name?: string;
}

interface DiscordInteraction {
  type: number;
  /** deferred 応答後の PATCH @original（webhook 経路）に使う。全インタラクションに同梱される */
  application_id: string;
  token: string;
  data?: {
    name?: string;
    custom_id?: string;
    /** String Select で選ばれた値（custom_id で部品を判別する） */
    values?: string[];
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
  message?: { id?: string; flags?: number };
}

type InteractionResponse = {
  type: number;
  data?: { content: string; flags?: number; components?: unknown[] };
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

/**
 * deferred 応答の後から結果を書き込む（PATCH @original）。
 * webhook 経路のため Bot トークン不要（interaction token が認可を兼ねる）。
 * ephemeral フラグは deferred 応答側で確定済みのため content/components のみ送る。
 */
async function patchOriginal(
  interaction: DiscordInteraction,
  res: InteractionResponse,
): Promise<void> {
  const url = `${API}/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`;
  const r = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
    body: JSON.stringify({
      content: res.data?.content ?? '',
      components: res.data?.components ?? [],
    }),
  });
  if (!r.ok) {
    console.error('[Interaction] patch @original failed:', r.status, await r.text());
  }
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

  const valid = await verifyEd25519(rawBody, signature, timestamp, env.DISCORD_PUBLIC_KEY);
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
    return json(handleCommand(interaction, origin));
  }

  if ((interaction.type === 3 || interaction.type === 5) && interaction.data?.custom_id?.startsWith('plan:')) {
    ctx.waitUntil(respondToPlanningInteraction(interaction, env, origin));
    return json(planningDeferredResponse(interaction));
  }

  // ボタン: D1 直列クエリ＋遅延スパイクで Discord の 3 秒制限を超えることがあるため、
  // deferred (type 5・ephemeral) を即返しし、実処理は waitUntil で継続 → 結果を PATCH @original で書き込む。
  if (interaction.type === InteractionType.MESSAGE_COMPONENT) {
    ctx.waitUntil(
      handleButton(interaction, env, ctx)
        .catch((e) => {
          console.error('[Button] unhandled error:', (e as Error).message);
          return ephemeral('❌ 処理に失敗しました。もう一度お試しください。');
        })
        .then((res) => patchOriginal(interaction, res))
        .catch((e) => console.error('[Button] patch @original failed:', (e as Error).message)),
    );
    return json({
      type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
      data: { flags: EPHEMERAL },
    });
  }

  return json(ephemeral('このインタラクションはサポートされていません'));
}

/** スラッシュコマンドは /manage だけ（/help は 2026-09-23、/notify は 2026-10-03 に廃止。登録し直すまで残る旧コマンドは「不明」）。 */
function handleCommand(interaction: DiscordInteraction, origin: string): InteractionResponse {
  return interaction.data?.name === 'manage' ? handleManage(origin) : ephemeral('❌ 不明なコマンドです');
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

  if (await plannedOccurrence(db, occurrenceId)) return ephemeral('この日時の出欠変更は運営担当者へ個別に連絡してください。');

  // 旧 oneoff（日程調整）の「全候補の状況」集約ボタン（statusall）は oneoff 廃止（2026-08-23）で撤去。
  // 過去メッセージのボタンは下の「不明なアクション」に落ちる。

  // 状況確認（1スロット）
  if (action === 'status') {
    try {
      const occ = await getOccurrence(db, occurrenceId);
      if (!occ) return ephemeral('❌ 対象の出欠確認が見つかりません。');
      const n = await getNotification(db, occ.notification_id);
      if (!n || (interaction.guild_id && n.guild_id && interaction.guild_id !== n.guild_id)) return ephemeral('❌ 対象のテンプレートが見つかりません。');
      const title = formatOccurrenceLabel(occ.occurrence_date, occ.start_time || n.start_time, durationFor(n, occ));
      const mine = await getResponseStatus(db, occ.id, userId);
      // 非公開（share_answers=0）は押した本人の回答だけ。押した時点で判定するので投稿済みのボタンにも効く
      if (!n.share_answers) return ephemeral(buildOwnAnswerMessage(title, mine));
      const buckets = await getStatusBuckets(db, occ.id, n.segment_id);
      return ephemeral(buildStatusMessage(title, buckets, mine));
    } catch (e) {
      console.error('[Button] status error:', (e as Error).message);
      return ephemeral('❌ 状況確認に失敗しました。');
    }
  }

  const status = STATUS_MAP[action];
  if (!status) return ephemeral('❌ 不明なアクションです');

  try {
    const occ = await getOccurrence(db, occurrenceId);
    if (!occ) return ephemeral('❌ 対象の出欠確認が見つかりません。');
    // 中止（単発の候補落ち含む）の回は回答を受け付けない。
    if (occ.status === 'cancelled') {
      return ephemeral('⛔ この日時の開催は中止（または候補から除外）されたため、出欠を回答できません。');
    }
    const n = await getNotification(db, occ.notification_id);
    if (!n) return ephemeral('❌ 対象のテンプレートが見つかりません。');
    // 募集の投稿後にテンプレートを出欠確認なし（告知）に変えたら、古い投稿のボタンからの回答は受け付けない（A1-01）
    if (isAnnounceOnly(n)) return ephemeral('⛔ この出欠確認は現在、回答を受け付けていません（出欠確認なしに変更されました）。');
    // 別サーバーで押されたボタンは受け付けない（custom_id は開催回 ID だけなので多層防御）
    if (interaction.guild_id && n.guild_id && interaction.guild_id !== n.guild_id) return ephemeral('❌ 対象の出欠確認が見つかりません。');

    // ロール管理区分はロールゲートで判定（@everyone は全員可・ADR 0009）。
    // ギルド内ボタンは member.roles が同梱される（追加API不要）。DM のリマインド回答は member 不在の
    // ためロール判定をスキップし、後段の所属/休止チェックに委ねる（roleGateAllows）。
    const segment = await getSegment(db, n.segment_id);
    const memberRoles = interaction.member ? (interaction.member.roles ?? []) : undefined;
    if (segment && !roleGateAllows(segment.mention_role_id, memberRoles)) {
      return ephemeral('🚫 この募集の対象（指定ロールの保有者）ではないため、回答できません。');
    }

    // shortcut: DM の認可は同期済み所属を使う。即時失効が必要なら Discord の現在の所属・ロールを照会する。
    const myStatus = await getSegmentMemberStatus(db, n.segment_id, userId);
    if (!interaction.member && myStatus === null) {
      return ephemeral('🚫 現在この募集の対象メンバーではないため、回答できません。');
    }
    if (myStatus) {
      return ephemeral(
        `⏸️ あなたは現在「${myStatus}」に設定されているため、回答できません。\n解除はサーバーの管理者に依頼してください。`,
      );
    }

    // メンバーマスタへ自動登録（無ければ）
    await ensureMember(db, userId, userName, displayName).catch((e) =>
      console.error('[Button] ensureMember failed:', (e as Error).message),
    );

    // 自動所属はギルド内の回答だけ。古い DM から削除済みの所属を復活させない。
    if (interaction.member) {
      await addSegmentMember(db, { id: n.segment_id, guild_id: n.guild_id }, userId);
    }

    // 回答締切（ADR 0014）: 締切後の変更（未回答→回答の初回を含む）を検知し、印を残して管理者へ通知。
    const L = answerLabels();
    const shown = (s: string) =>
      ({ 参加: L.participate, 不参加: L.absent, 未定: L.undecided })[s] ?? s;
    const oldStatus = await getResponseStatus(db, occ.id, userId);
    const dl = responseDeadline(occ.occurrence_date, occ.start_time || n.start_time, deadlineHoursFor(n, occ));
    // 回答不要(announce-only)は締切対象外（response_deadline_hours も null だが二重で守る）。
    const postDeadlineChange =
      !!n.requires_response && dl != null && getJSTNow().getTime() >= dl.getTime() && status !== oldStatus;

    await upsertResponse(db, occ.id, userId, userName, status, postDeadlineChange);

    if (postDeadlineChange) {
      // 変更通知（メンションなし・change_alert_channel_id / 未指定は投稿チャンネル）。
      // 回答非公開（share_answers=0）で未指定なら、投稿チャンネルに名前と回答を出さず
      // 配信失敗の通知先へ回す（そちらも未設定なら送らない）。
      // 応答を遅らせないよう投げっぱなし（ctx.waitUntil）。
      const toFailureChannel = !n.share_answers && !n.change_alert_channel_id;
      const occLabel = formatOccurrenceLabel(
        occ.occurrence_date,
        occ.start_time || n.start_time,
        durationFor(n, occ),
      );
      const verb = oldStatus ? `**${shown(oldStatus)}** → **${shown(status)}** に変更` : `**${shown(status)}** で新規回答`;
      const alert = `⚠️ **締切後の回答変更**\n${displayName} さんが ${verb}しました（開催: ${occLabel}）。`;
      ctx.waitUntil(
        (toFailureChannel
          ? getFailureNotificationSettings(db, n.guild_id).then((s) => s.channel_id)
          : Promise.resolve(n.change_alert_channel_id || n.channel_id)
        ).then(async (alertChannel) => {
          if (!alertChannel) return;
          const ok = await sendChannelMessage(env, alertChannel, alert, null, { parse: [] });
          // 失敗通知の投稿先に送れなかったときは、同じ先へ失敗通知を重ねない。
          if (!ok && !toFailureChannel) await notifyDeliveryFailure(env, n.guild_id, `締切後の変更通知: ${n.name}\n投稿先: <#${alertChannel}>`);
        }).catch((e) =>
          console.error('[Button] change alert failed:', (e as Error).message),
        ),
      );
    }

    // 表示名の自動更新は返答に不要なので投げっぱなし。
    // ギルド内ボタンは interaction.guild_id 付き＝そのギルドの nick を最新化（DM 応答は guild 無し）。
    ctx.waitUntil(
      updateMemberDisplayName(db, userId, displayName, userName, interaction.guild_id ?? null).catch(
        (e) => console.error('[Button] update display name failed:', (e as Error).message),
      ),
    );
    return ephemeral(`✅ **${shown(status)}** で記録しました!`);
  } catch (e) {
    console.error('[Button] record failed:', (e as Error).message);
    return ephemeral('❌ 記録に失敗しました。管理者に連絡してください。');
  }
}
