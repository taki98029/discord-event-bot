import type { Env } from '../env';

// ponytail: (d) discord-interactions の verifyKey と enum を Workers ネイティブの Web Crypto + const で置換。
// Cloudflare Workers (workerd) は crypto.subtle.importKey('raw', ..., { name: 'Ed25519' }, ...) と
// crypto.subtle.verify('Ed25519', ...) を 2023 年以降サポート済み。
const InteractionType = { PING: 1, APPLICATION_COMMAND: 2, MESSAGE_COMPONENT: 3 } as const;
const InteractionResponseType = { PONG: 1, CHANNEL_MESSAGE_WITH_SOURCE: 4 } as const;

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
import { getNotification, listNotificationsByChannel } from '../db/notifications';
import { getOccurrence, listScheduledOccurrences } from '../db/occurrences';
import {
  getSegment,
  getActiveSegmentMembers,
  addSegmentMember,
  listSegmentMembers,
} from '../db/segments';
import { upsertResponse, getResponseStatus, getStatusBuckets } from '../db/responses';
import { buildStatusMessage, buildAllStatusMessage, sendChannelMessage } from '../discord/rest';
import { roleGateAllows } from '../discord/syncSegment';
import { formatOccurrenceLabel, responseDeadline, getJSTNow } from '../lib/date';
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
      case 'notify':
        return await handleNotify(interaction, env);

      case 'help':
        return handleHelp();

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

/** Discord ボタン label の上限(80字)に合わせて長い通知名を省略する。 */
function truncateLabel(s: string, max = 80): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

/**
 * /notify — チャンネルに紐づく Notification を一覧化して ephemeral でボタン提示する。
 * ボタン押下時は handleButton の 'notifypick' 分岐で recruitNotificationNow を実行する。
 * 1件のときも統一して 1 ボタン出すことで、誤爆防止のクッションを兼ねる。
 */
async function handleNotify(
  interaction: DiscordInteraction,
  env: Env,
): Promise<InteractionResponse> {
  const channelId = interaction.channel_id;
  if (!channelId) return ephemeral('❌ チャンネルを特定できません。');
  const list = await listNotificationsByChannel(env.DB, channelId);
  if (list.length === 0) {
    return ephemeral('❌ このチャンネルに紐づく通知がありません。管理画面で作成してください。');
  }
  // Discord ボタン上限 5行 × 5個 = 25 件まで。超過分は省略表示する。
  const limit = 25;
  const shown = list.slice(0, limit);
  const omitted = list.length - shown.length;
  const rows: unknown[] = [];
  for (let i = 0; i < shown.length; i += 5) {
    rows.push({
      type: 1,
      components: shown.slice(i, i + 5).map((n) => ({
        type: 2,
        style: 2, // secondary (灰) — 即送信のため目立たせない誤爆対策
        label: truncateLabel(n.name),
        custom_id: `notifypick_${n.id}`,
      })),
    });
  }
  const note =
    omitted > 0 ? `\n…ほか ${omitted} 件は表示上限のため省略しています。` : '';
  return {
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      content: `📨 **送信する通知を選んでください**${note}`,
      flags: EPHEMERAL,
      components: rows,
    },
  };
}

/** /help — エンドユーザー向けの使い方ガイドを ephemeral で返す */
function handleHelp(): InteractionResponse {
  const content = [
    '📖 **EventMasterBot — 使い方ガイド**',
    '_バージョン v8.3.0_',
    '',
    'このサーバーで **イベントの告知と出欠集計** を行う Bot です。',
    'イベントの開催情報をチャンネルに自動で投稿し、あなたは **ボタンを押すだけ** で参加/不参加を伝えられます。',
    '出欠を取らない「お知らせ専用」の通知にも対応しているので、回答ボタンが無い投稿はそのままお知らせとしてご覧ください。',
    '未回答のまま放置すると、開催日が近づいたタイミングで DM にリマインドが届きます。',
    '',
    '━━━━━━━━━━━━━━━━━',
    '**■ 回答の仕方**',
    '',
    '募集メッセージの下のボタンを押すだけです。',
    '',
    '・**⭕ 参加** … 参加できる',
    '・**❌ 不参加** … 参加できない',
    '・**❓ 未定** … まだ分からない（あとで確定する想定）',
    '・**📊 状況確認** … 今みんなの回答状況を一覧表示（自分にだけ見えます）',
    '',
    '単発イベントの日程調整では、ラベルが **可 / 不可 / 未確定** に切り替わります。',
    '複数の候補日が同時に出ているときは、**都合のつく候補すべてに「可」を選べます**。',
    '',
    '━━━━━━━━━━━━━━━━━',
    '**■ よくある質問**',
    '',
    '**Q. 一度押した回答は変えられますか?**',
    '→ はい、何度でも押し直せます。最後に押した内容が記録されます。',
    '',
    '**Q. 自分の回答は他の人に見えますか?**',
    '→ はい。「📊 状況確認」ボタンで誰でも参加/不参加/未定/未回答の一覧を見られます。',
    '押した瞬間の **「✅ 参加 で記録しました!」** などの確認メッセージは自分にしか表示されません。',
    '',
    '**Q. 回答締切ってなんですか?**',
    '→ 募集メッセージに **回答締切: YYYY/MM/DD HH:MM** と書かれていれば、その時刻までの回答が想定されています。',
    '時刻が来るとチャンネルで「⏰ 回答を締め切りました」と告知されます。',
    '締切後も回答や変更はできますが、その場合は **主催者へ自動で通知が飛びます**(記録も残ります)。',
    '締切前に決めておくのが無難です。',
    '',
    '**Q. 「未定」と「不参加」の違いは?**',
    '→ **不参加** は「行かないと決めた」。**未定** は「行けるか分からない」。',
    '「未定」のまま日が近づくと、「そろそろ参加/不参加を確定してください」という DM が届くことがあります。',
    '',
    '**Q. DM が届いたんですが、これは何?**',
    '→ 3 種類のうちのどれかです。いずれも DM 内のボタンでそのまま回答できます。',
    '・**⏰ リマインド: ○日のイベント** … まだ未回答です。回答をお願いします。',
    '・**❓ 未定者へのリマインド** … 「未定」のままなので確定してほしい、という案内です。',
    '・**📊 参加間隔の確認** … 前回参加から間が空いている方への、次回参加検討の案内です。',
    '',
    '**Q. ボタンを押したら「対象ではない」「休止中」と言われました**',
    '→ **対象ではない**: その募集は特定のロール宛てで、あなたがそのロールを持っていません。主催者に相談してください。',
    '**休止中**: 主催者があなたを休止扱いに設定しています。解除も主催者側の操作です。',
    '',
    '**Q. ニックネームを変えたら反映されますか?**',
    '→ 次にボタンを押した時点で自動更新されます。特別な操作は不要です。',
    '',
    '**Q. 事前登録は必要ですか?**',
    '→ 不要です。初めて回答ボタンを押した瞬間に、自動でメンバー登録されます。',
    '',
    '━━━━━━━━━━━━━━━━━',
    '**■ 困ったときは**',
    '',
    '主催者(管理者)にご相談ください。',
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

  // /notify の通知選択（ボタン）: custom_id = notifypick_{notificationId}
  // ※ パース都合で変数名は occurrenceId だが、ここでの実体は notificationId
  if (action === 'notifypick') {
    const n = await getNotification(db, occurrenceId);
    if (!n) return ephemeral('❌ 対象の通知が見つかりません。');
    if (n.channel_id !== interaction.channel_id) {
      return ephemeral('❌ このチャンネル外の通知は送信できません。');
    }
    const r = await recruitNotificationNow(env, n);
    return ephemeral((r.ok ? '✅ ' : '❌ ') + r.message);
  }

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

    // 回答締切（ADR 0014）: 締切後の変更（未回答→回答の初回を含む）を検知し、印を残して管理者へ通知。
    const oldStatus = await getResponseStatus(db, occ.id, userId);
    const dl = responseDeadline(occ.occurrence_date, occ.start_time || n.start_time, n.response_deadline_hours);
    // 回答不要(announce-only)は締切対象外（response_deadline_hours も null だが二重で守る）。
    const postDeadlineChange =
      !!n.requires_response && dl != null && getJSTNow().getTime() >= dl.getTime() && status !== oldStatus;

    await upsertResponse(db, occ.id, userId, userName, status, postDeadlineChange);

    if (postDeadlineChange) {
      // 変更通知（メンションなし・change_alert_channel_id / 未指定は投稿チャンネル）。
      // 応答を遅らせないよう投げっぱなし（ctx.waitUntil）。
      const alertChannel = n.change_alert_channel_id || n.channel_id;
      const occLabel = formatOccurrenceLabel(
        occ.occurrence_date,
        occ.start_time || n.start_time,
        n.duration_minutes,
      );
      const verb = oldStatus ? `**${oldStatus}** → **${status}** に変更` : `**${status}** で新規回答`;
      const alert = `⚠️ **締切後の回答変更**\n${displayName} さんが ${verb}しました（開催: ${occLabel}）。`;
      ctx.waitUntil(
        sendChannelMessage(env, alertChannel, alert, null, { parse: [] }).catch((e) =>
          console.error('[Button] change alert failed:', (e as Error).message),
        ),
      );
    }

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
