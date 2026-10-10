import { plannedOccurrence } from '../planning/store';
import { quotaMessage } from '../lib/quotaMessage';
import { notifyDeliveryFailure } from '../discord/failureNotifications';
import type { Env } from '../env';
import type { Notification, Occurrence, Segment } from '../db/types';
import { deadlineHoursFor, durationFor, flowFor, isAnnounceOnly } from '../db/types';
import { listActiveNotifications } from '../db/notifications';
import { getOrCreateOccurrence, listFutureOccurrencesAll } from '../db/occurrences';
import {
  checkQuotaForNotification,
  remainingUnansweredTargets,
  remainingUndecidedTargets,
} from '../db/responses';
import { getActiveSegmentMembers, getSegment, listSegments } from '../db/segments';
import {
  claimSend,
  finishSend,
  clearStaleClaims,
  hasSentKind,
  listChannelSends,
  reclaimFailedSend,
  reclaimSentSend,
  releaseClaim,
  type SendKey,
} from '../db/sendLog';
import {
  getAllConfig,
  setConfig,
  parseConfigInt,
  SEND_BUDGET_KEY,
  DEFAULT_SEND_BUDGET,
  OCC_ROLLFORWARD_KEY,
} from '../db/config';
import { syncSegmentFromRole } from '../discord/syncSegment';
import { occurrenceDatesBetween } from '../lib/recurrence';
import {
  getDaysUntil,
  getJSTNow,
  formatDate,
  formatOccurrenceLabel,
  responseDeadline,
} from '../lib/date';
import {
  sendChannelMessage,
  sendDirectMessageCached,
  createButtonComponents,
  buildMentionPrefix,
  composePost,
  listGuildMembers,
  listGuilds,
  answerLabels,
  DISCORD_CONTENT_LIMIT,
  DiscordRateLimited,
  rateLimitAware,
  type GuildMemberSummary,
} from '../discord/rest';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DM_INTERVAL_MS = 300;

/** 偶数分は日程調整（planningTick）、奇数分は出欠確認（runTick）の担当（src/index.ts）。scheduledTime は UTC ミリ秒だが分の偶奇は JST と同じ。 */
export const isPlanningMinute = (scheduledTime: number) => Math.floor(scheduledTime / 60_000) % 2 === 0;

// 1 ティックで使ってよい D1 クエリ数。Free は 1 実行 50 クエリが上限で、超えると以降のクエリが例外になり、
// 送信済みの finish が書けず sending のまま残る（5 分後に回収されて二重送信になる）。上限との差 10 は
// 「判定の照会は残りを確かめずに打つ」分の余裕。batch は 1 と数える（syncSegment の upsert と同じ前提）。
// ponytail: Paid（1000 クエリ）でも同じ値＝1 ティックの処理量は Free 基準。Paid で捌き切れなくなったら config 化する。
export const D1_BUDGET_PER_TICK = 40;
/** 送信 1 件に要る D1 クエリ（claim・finish・本文の区分/メンバー照会・DM チャンネル保存・失敗通知の設定読み） */
const D1_PER_TASK = 6;
/** 開催回 1 件の判定（投稿済み・締切告知・ノルマ・対象者の照会）を始めるのに要る残り */
const D1_PER_OCC = 10;
/** ロール同期を始めるのに要る残り（区分ごとの照会と差分の書き込み。ティック冒頭でないと走らせない） */
const D1_FOR_ROLESYNC = 30;

/** prepare/batch を数える D1 ラッパー。数えるだけで止めはしない（止めるのは各所の残り判定）。 */
export function countingD1(db: D1Database, left: { n: number }): D1Database {
  const RAW = Symbol('raw');
  const wrap = (st: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(st, {
      get(t, p) {
        if (p === RAW) return t;
        if (p === 'bind') return (...a: unknown[]) => wrap(t.bind(...a));
        const v = Reflect.get(t, p);
        if (p === 'first' || p === 'run' || p === 'all' || p === 'raw')
          return (...a: unknown[]) => {
            left.n--;
            return v.apply(t, a);
          };
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
  return new Proxy(db, {
    get(t, p) {
      if (p === 'prepare') return (sql: string) => wrap(t.prepare(sql));
      if (p === 'batch')
        return (stmts: D1PreparedStatement[]) => {
          left.n--;
          return t.batch(stmts.map((x) => (x as any)[RAW] ?? x));
        };
      const v = Reflect.get(t, p);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}

// 日次ロールフォワードで 1 ティックに rrule 評価する定期スケジュール（rrule あり）の最大件数。
// rrule は ~1ms/回（dtstart 整列後）× Workers Free の CPU 10ms 律速のため、1 ティックに
// 全件は回せない。kill されても次ティックが同じチャンクから再開する（マーカーで進捗管理）。
// ponytail: 8件/分＝定期 数百件で実体化完了に約1時間。その規模は Paid 前提で要再設計。
const ROLLFORWARD_CHUNK = 8;

/**
 * 投稿の @メンション接頭辞を mention_mode に従って解決する（ADR 0010）。
 * 'members' のときだけ区分のアクティブメンバーを取得して `<@id>` 列挙の材料にする。
 * budget はバイネーム接頭辞に割ける字数（呼び出し側が本文長から逆算して渡す）。
 */
async function mentionPrefixFor(
  env: Env,
  n: Notification,
  segment: Segment | null,
  budget?: number,
): Promise<string> {
  if (!segment || n.mention_mode === 'none') return '';
  let memberIds: string[] = [];
  if (n.mention_mode === 'members') {
    const members = await getActiveSegmentMembers(env.DB, n.segment_id);
    memberIds = members.map((m) => m.user_id);
  }
  return buildMentionPrefix(segment, n.mention_mode, memberIds, budget);
}

/**
 * Discord 側のメンション解析対象を mention_mode に絞る allowed_mentions を返す（ADR 0010）。
 * 本文(message_body)に書かれた @everyone 等で意図しない一斉メンションが飛ぶのを防ぐ。
 * - none: 何もメンションしない / role: ロール（@everyone は everyone）/ members: ユーザーのみ
 */
function allowedMentionsFor(n: Notification, segment: Segment | null): { parse: string[] } {
  if (n.mention_mode === 'none') return { parse: [] };
  if (n.mention_mode === 'members') return { parse: ['users'] };
  if (segment && segment.mention_role_id === '@everyone') return { parse: ['everyone'] };
  return { parse: ['roles'] };
}

/**
 * チャンネル投稿の本文を合成する（ADR 0010）。見出し/本文/日時(tail)の実長から
 * バイネームに割ける字数を逆算し、合成後が Discord の content 上限を超えないようにする。
 */
async function composeChannelPost(
  env: Env,
  n: Notification,
  segment: Segment | null,
  tail: string,
): Promise<string> {
  const restLen = composePost('', n.message_title, n.message_body, tail).length;
  const budget = Math.max(0, DISCORD_CONTENT_LIMIT - restLen);
  const prefix = await mentionPrefixFor(env, n, segment, budget);
  return composePost(prefix, n.message_title, n.message_body, tail);
}

/** スロットの表示時刻（occ.start_time 優先・空なら通知の既定 start_time）。 */
function slotTime(occ: Occurrence, n: Notification): string {
  return occ.start_time || n.start_time;
}
/** 'YYYY/MM/DD (曜) HH:MM〜HH:MM' のスロット表示ラベル（duration 未設定なら開放端「HH:MM〜」）。 */
function slotLabel(occ: Occurrence, n: Notification): string {
  return formatOccurrenceLabel(occ.occurrence_date, slotTime(occ, n), durationFor(n, occ));
}

/** 募集（回答締切が設定されていれば日時行に併記する・ADR 0014）。 */
export async function sendRecruitment(env: Env, n: Notification, occ: Occurrence): Promise<boolean> {
  const segment = await getSegment(env.DB, n.segment_id);
  const dl = responseDeadline(occ.occurrence_date, slotTime(occ, n), deadlineHoursFor(n, occ));
  const dateLine = dl
    ? `日時: **${slotLabel(occ, n)}**\n回答締切: **${formatDate(dl)} ${String(dl.getHours()).padStart(2, '0')}:${String(dl.getMinutes()).padStart(2, '0')}**`
    : `日時: **${slotLabel(occ, n)}**`;
  // 開催回の補足メッセージ（臨時回のコラボ説明など）は本文と日時行の間に差し込む。
  // tail に含めることで composeChannelPost の字数バジェットに自動で乗る。
  const tail = occ.note?.trim() ? `${occ.note.trim()}\n\n${dateLine}` : dateLine;
  // 見出し（必須）＋本文（任意）＋日時行（自動）。回答不要(announce-only)はボタンを付けない。
  const message = await composeChannelPost(env, n, segment, tail);
  const components = isAnnounceOnly(n) ? null : createButtonComponents(occ.id);
  const ok = await sendChannelMessage(env, n.channel_id, message, components, allowedMentionsFor(n, segment));
  console.log(ok ? `✅ [Recruitment] sent (n=${n.id})` : `❌ [Recruitment] failed (n=${n.id})`);
  return ok;
}

/** 「今すぐ募集/告知」の結果。already_sent = その開催回は送信済み（または送信中）で claim できなかった。 */
export type RecruitNowResult = 'sent' | 'already_sent' | 'failed';

/**
 * 開催回 1 件を今すぐ募集/告知する。管理画面「今すぐ募集」（POST /occurrences/:id/recruit）と
 * 唯一の経路（2026-08-23 集約。Discord の /notify も共用していたが 2026-10-03 に廃止。旧 recruitNotificationNow は
 * 「次回」を暗黙に選び send_log も書かなかったため、開催回タブの表示や cron の自動募集と食い違っていた）。
 * send_log に claim/finish を記録し、cron の窓内自動募集（hasSentKind 照合）・開催回タブの「投稿済み」と同じ真実を持つ。
 * - 新規 claim できなければ、失敗で終わった同日 claim を取り直す（当日中の手動リトライを許す）
 * - force=true は sent も取り直して再送する（UI の確認ダイアログ了承後のみ）
 * - sending（送信中）だけはどちらでも取り直せない＝並行実行の二重送信ガード
 */
export async function recruitOccurrenceNow(
  env: Env,
  n: Notification,
  occ: Occurrence,
  opts: { force?: boolean } = {},
): Promise<RecruitNowResult> {
  const db = env.DB;
  if (await plannedOccurrence(db, occ.id)) return 'failed';
  // 過去日に投稿済み（send_date 無視）でも force なしでは再送しない（日をまたいだ古い画面からの重複投稿防止・2026-09-24 レビュー #10）
  if (opts.force !== true && (await hasSentKind(db, n.id, occ.id, 'recruit'))) return 'already_sent';
  const key: SendKey = { notification_id: n.id, occurrence_id: occ.id, kind: 'recruit', send_date: formatDate(getJSTNow()) };
  const claimed =
    (await claimSend(db, key)) ||
    (await reclaimFailedSend(db, key)) ||
    (opts.force === true && (await reclaimSentSend(db, key)));
  if (!claimed) return 'already_sent';
  const ok = await sendRecruitment(env, n, occ);
  await finishSend(db, key, ok, ok ? null : 'manual send failed');
  if (!ok) await notifyDeliveryFailure(env, n.guild_id, `今すぐ${isAnnounceOnly(n) ? '告知' : '募集'}: ${n.name}\n開催日時: ${slotLabel(occ, n)}\n投稿先: <#${n.channel_id}>`);
  return ok ? 'sent' : 'failed';
}

// =============================================================================
// ペース配信エンジン（毎分 cron・ADR 0013）
//   送信時刻(send_hour)に達した通知の「今日の未送信分」を、1 ティック予算(send_budget_per_tick)
//   内で送る。残りは次ティックへ。send_log で (通知,開催回,宛先,種別,送信日) ごとに冪等化し、
//   毎分実行でも二重送信しない。subrequest 50/実行（Free）律速に対し予算で構造的に超えない。
// =============================================================================

/**
 * DM 見出しへのサーバー名付記。同じ Bot を複数サーバーで使うと同一メンバーへの DM が
 * 1 つのスレッドに混在してどのサーバーのイベントか判別できないため、見出しに付ける。
 * 名前未解決（同期前・不参加 guild）は付記を省略して従来表示に落とす。
 */
const guildSuffix = (guildName: string) => (guildName ? `（${guildName}）` : '');

/** 未回答リマインド DM 文面 */
function unansweredMessage(n: Notification, occ: Occurrence, daysUntil: number, guildName: string): string {
  const dayText = daysUntil === 0 ? '今日' : `あと${daysUntil}日`;
  const L = answerLabels();
  return (
    `⏰ **リマインド: ${dayText}のイベント**${guildSuffix(guildName)}\n\n` +
    `日時: **${slotLabel(occ, n)}**\n\n` +
    `まだ回答されていません。下のボタンで${L.participate}/${L.absent}を回答してください!`
  );
}

/** 未定者リマインド DM 文面 */
function undecidedMessage(n: Notification, occ: Occurrence, guildName: string): string {
  const L = answerLabels();
  return (
    `❓ **未定者へのリマインド**${guildSuffix(guildName)}\n\n` +
    `日時: **${slotLabel(occ, n)}**\n\n` +
    `現在「${L.undecided}」で回答されています。下のボタンで${L.participate}/${L.absent}を確定してください!`
  );
}

/** 未回答リマインドのチャンネル投稿文面（C02・2026-09-20）。個別メンションは呼び出し側が先頭に付ける */
function unansweredChannelMessage(n: Notification, occ: Occurrence, daysUntil: number): string {
  const dayText = daysUntil === 0 ? '今日' : `あと${daysUntil}日`;
  const L = answerLabels();
  return (
    `⏰ **リマインド: ${dayText}のイベント**（${n.name}）\n` +
    `日時: **${slotLabel(occ, n)}**\n` +
    `まだ回答されていません。下のボタンで${L.participate}/${L.absent}を回答してください!`
  );
}

/** 未定者リマインドのチャンネル投稿文面（C02・2026-09-20） */
function undecidedChannelMessage(n: Notification, occ: Occurrence): string {
  const L = answerLabels();
  return (
    `❓ **未定者へのリマインド**（${n.name}）\n` +
    `日時: **${slotLabel(occ, n)}**\n` +
    `現在「${L.undecided}」で回答されています。下のボタンで${L.participate}/${L.absent}を確定してください!`
  );
}

/**
 * リマインドの送り先が投稿チャンネルのとき（remind_target／remind_undecided_target='channel'・C02）: 該当メンバーを 40 人ずつ個別メンションし、
 * 1 日 1 回投稿する。1 通目は本文＋回答ボタン（send_log は user_id '' の日次キー）、2 通目以降はメンションだけ
 * （user_id 'chunk:<先頭の位置>'）。以前は 1 投稿に詰めて字数超過分を「ほかN名」に省略し、その人たちに通知が届かなかった。
 * ponytail: 区切りは位置で決めるので、同じ日の送り直しまでに回答した人がいると境目の人が 1 回飛ぶことがある（翌日に届く）。
 */
const CHANNEL_REMIND_LIMIT = 200;
const CHANNEL_REMIND_CHUNK = 40;
function channelReminderTasks(
  env: Env,
  n: Notification,
  occ: Occurrence,
  today: string,
  kind: 'remind_unanswered' | 'remind_undecided',
  targets: { user_id: string }[],
  body: string,
): SendTask[] {
  const tasks: SendTask[] = [];
  for (let i = 0; i < targets.length; i += CHANNEL_REMIND_CHUNK) {
    const mentions = targets.slice(i, i + CHANNEL_REMIND_CHUNK).map((m) => `<@${m.user_id}>`).join(' ');
    tasks.push({
      key: { notification_id: n.id, occurrence_id: occ.id, kind, send_date: today, ...(i ? { user_id: `chunk:${i}` } : {}) },
      run: () =>
        i
          ? sendChannelMessage(env, n.channel_id, mentions, null, { parse: ['users'] })
          : sendChannelMessage(env, n.channel_id, `${mentions}

${body}`, createButtonComponents(occ.id), { parse: ['users'] }),
    });
  }
  return tasks;
}

/** 回答締切の到来告知（メンバー向け・募集チャンネルへ追従投稿・ADR 0014） */
function deadlineNoticeMessage(n: Notification, occ: Occurrence): string {
  return (
    `⏰ **回答を締め切りました**（${slotLabel(occ, n)}）\n` +
    `以降に回答を変更すると、管理者に記録・通知されます。`
  );
}

interface TickCtx {
  env: Env;
  db: D1Database;
  now: Date; // getJSTNow()
  today: string; // 'YYYY/MM/DD'(JST)
  hour: number; // JST 時(0-23)
  budget: { n: number }; // 1 ティックの残り送信予算（subrequest 50 律速）
  d1: { n: number }; // 1 ティックの残り D1 クエリ数（D1 50 律速・countingD1 が数える）
  config: Record<string, string>; // ティック冒頭で一括読みした config（毎分の細切れ照会を避ける）
  chan: Map<string, { send_date: string; status: string }[]>; // ティック冒頭で一括読みしたチャンネル送信の記録（listChannelSends）
}

/** ティック冒頭の記録で、その開催回にこの種別のチャンネル送信が済んでいるか（hasSentKind と同じ判定・failed は数えない） */
const posted = (ctx: TickCtx, occId: number, kind: SendKey['kind']) =>
  (ctx.chan.get(`${occId}:${kind}`) ?? []).some((r) => r.status !== 'failed');

interface SendTask {
  key: SendKey;
  run: () => Promise<boolean>;
  /** 外部通信の回数（既定 1）。DM チャンネル未作成の初回 DM は作成＋投稿で 2 */
  cost?: number;
}

/** 送信をもう 1 件始められるか（送信予算と D1 の残りの両方） */
const room = (ctx: TickCtx) => ctx.budget.n > 0 && ctx.d1.n >= D1_PER_TASK;

/** DM 1 通の予算コスト。dm_channel_id 未キャッシュなら作成と投稿で subrequest を 2 回使う（2026-09-24 レビュー #4） */
const dmCost = (m: { dm_channel_id: string | null }) => (m.dm_channel_id ? 1 : 2);

/**
 * タスク群を予算内でドレインする。claim → 送信 → finish。
 * 既送信(claim=false)は予算を消費せずスキップ。予算切れで残りは次ティックへ繰り越す。
 * Discord の 429 は未送信が確実なので claim を消し、このティックの送信を打ち切る（次ティックで再送・失敗通知なし）。
 */
async function drainTasks(ctx: TickCtx, n: Notification, occ: Occurrence, tasks: SendTask[]): Promise<void> {
  const labels = { recruit: isAnnounceOnly(n) ? '告知' : '募集', deadline_notice: '締切告知', quota: 'ノルマ', remind_unanswered: '未回答リマインド', remind_undecided: '未定リマインド' };
  // 追加の投稿も予算に数える。最終タスク分の最大1件は既存の余裕枠で収まる。
  const report = async (text: string) => {
    if (await notifyDeliveryFailure(ctx.env, n.guild_id, `${text}\n開催日時: ${slotLabel(occ, n)}`)) ctx.budget.n--;
  };
  // DM の失敗は 1 回の呼び出し分をまとめて 1 件で知らせる（DM を閉じている人の数だけ毎日届くのを防ぐ・レビュー A7-02）
  const dmFailed: string[] = [];
  try {
    for (const t of tasks) {
      const cost = t.cost ?? 1;
      // まとめた失敗通知を最後に投稿する 1 回分は予算を残しておく
      if (ctx.budget.n < cost + (dmFailed.length ? 1 : 0) || ctx.d1.n < D1_PER_TASK) return;
      // ティック冒頭で同じキーの行が見えていれば claim は必ず弾かれる＝D1 を使わずに飛ばす
      if (!t.key.user_id && ctx.chan.get(`${t.key.occurrence_id}:${t.key.kind}`)?.some((r) => r.send_date === t.key.send_date)) continue;
      const claimed = await claimSend(ctx.db, t.key);
      if (!claimed) continue; // 他ティックが処理済み/処理中
      ctx.budget.n -= cost;
      let ok = false;
      try {
        ok = await t.run();
      } catch (e) {
        if (e instanceof DiscordRateLimited) {
          console.warn(`[Send] ${t.key.kind} rate limited: ${e.message}`);
          await releaseClaim(ctx.db, t.key);
          ctx.budget.n = 0;
          return;
        }
        console.error(`[Send] ${t.key.kind} threw: ${(e as Error).message}`);
        ok = false;
      }
      await finishSend(ctx.db, t.key, ok, ok ? null : 'send failed');
      if (!ok) {
        if (t.key.user_id && !t.key.user_id.startsWith('chunk:')) dmFailed.push(t.key.user_id);
        else await report(`${labels[t.key.kind]}: ${n.name}\n投稿先: <#${n.channel_id}>`);
      }
      await sleep(DM_INTERVAL_MS);
    }
  } finally {
    if (dmFailed.length) {
      const kind = tasks[0].key.kind;
      await report(`${labels[kind]}: ${n.name}\nDM が ${dmFailed.length} 人に届きませんでした: ${dmFailed.map((id) => `<@${id}>`).join(' ')}`);
    }
  }
}

/**
 * ロール管理区分を Discord ロールから同期する（1 日 1 回/ギルド・config マーカーで冪等・ADR 0009）。
 * 取得失敗時は同期せず既存維持（マーカーを立てず次ティックで再試行）。
 */
async function ensureRoleSync(ctx: TickCtx, guildId: string): Promise<void> {
  const markerKey = `rolesync:${guildId}`;
  // マーカーはティック冒頭の config スナップショットで判定（開催回ごとに呼ばれても照会を打たない）。
  // 'tried:<日付>' は「このティックで試して失敗した」印（永続化しない＝次ティックで再試行）。
  if (ctx.config[markerKey] === ctx.today || ctx.config[markerKey] === `tried:${ctx.today}`) return;
  if (ctx.d1.n < D1_FOR_ROLESYNC) return; // 後のティック（冒頭）でやる。マーカーは立てない
  const segs = (await listSegments(ctx.db, guildId)).filter((seg) => seg.mention_role_id);
  if (!segs.length) {
    // ロールで管理する区分が無いサーバーではメンバー一覧を取りに行かない
    await setConfig(ctx.db, markerKey, ctx.today);
    ctx.config[markerKey] = ctx.today;
    return;
  }
  // メンバー取得（ページング）の subrequest は成否にかかわらず保守的に予算から控除（大規模は Paid 前提）。
  ctx.budget.n = Math.max(0, ctx.budget.n - 5);
  let members: GuildMemberSummary[];
  try {
    members = await listGuildMembers(ctx.env, guildId);
  } catch (e) {
    console.error(`[SegmentSync] members fetch failed (guild=${guildId}): ${(e as Error).message}`);
    ctx.config[markerKey] = `tried:${ctx.today}`; // 同じティックの後続の開催回では取り直さない
    return;
  }
  for (const seg of segs) {
    try {
      const r = await syncSegmentFromRole(ctx.env, seg, { allowEmpty: false, members });
      console.log(`[SegmentSync] seg=${seg.id} ${r.ok ? `+${r.added}/-${r.removed}` : 'skip: ' + r.message}`);
    } catch (e) {
      console.error(`[SegmentSync] seg=${seg.id} failed: ${(e as Error).message}`);
    }
  }
  await setConfig(ctx.db, markerKey, ctx.today);
  ctx.config[markerKey] = ctx.today; // 同ティック内の後続呼び出しもスキップさせる
}

/**
 * DM 付記用のサーバー名を解決する（1 日 1 回 listGuilds → config 永続化・rolesync と同型）。
 * 毎ティック Discord API を叩かないよう、名前一覧は config の 1 キーに日付付き JSON で持ち、
 * 日付が変わった最初の DM 送信時だけ再同期する。取得失敗時は前回同期の名前を使い続ける
 * （day 未更新のため次ティックで自然リトライ）。未解決の guild は '' を返す。
 */
export const GUILD_NAMES_KEY = 'guild_names';
export async function resolveGuildName(ctx: TickCtx, guildId: string): Promise<string> {
  let cached: { day?: string; names?: Record<string, string> } = {};
  try {
    cached = JSON.parse(ctx.config[GUILD_NAMES_KEY] || '{}');
  } catch {}
  if (cached.day !== ctx.today && ctx.config[`${GUILD_NAMES_KEY}:tried`] !== ctx.today) {
    ctx.budget.n = Math.max(0, ctx.budget.n - 1); // listGuilds の subrequest を成否にかかわらず予算から控除
    try {
      const guilds = await listGuilds(ctx.env);
      const names: Record<string, string> = {};
      for (const g of guilds) names[g.id] = g.name;
      cached = { day: ctx.today, names };
      const json = JSON.stringify(cached);
      await setConfig(ctx.db, GUILD_NAMES_KEY, json);
      ctx.config[GUILD_NAMES_KEY] = json; // 同ティック内の後続解決はスナップショットから読む
    } catch (e) {
      console.error(`[GuildNames] fetch failed: ${(e as Error).message}`);
      // 同じティックの後続の開催回では取り直さない（永続化しない＝次ティックで再試行）
      ctx.config[`${GUILD_NAMES_KEY}:tried`] = ctx.today;
    }
  }
  return cached.names?.[guildId] || '';
}

/** 当日（daysUntil=0）なら開始時刻前だけ true。前日以前は常に true（②③の当日ガード・E4 の実行時版）。 */
export function beforeStartIfToday(n: Notification, occ: Occurrence, daysUntil: number, now: Date): boolean {
  if (daysUntil !== 0) return true;
  const [h, m] = slotTime(occ, n).split(':').map(Number);
  return now.getHours() * 60 + now.getMinutes() < (h || 0) * 60 + (m || 0);
}

/** 開催回の回答締切が到来しているか（ADR 0014・締切は開催回の値 ?? 雛形の値・ADR 0032）。 */
function deadlinePassed(n: Notification, occ: Occurrence, now: Date): boolean {
  const dl = responseDeadline(occ.occurrence_date, slotTime(occ, n), deadlineHoursFor(n, occ));
  return dl != null && now.getTime() >= dl.getTime();
}

// 締切告知の跨日デデュープは募集と同じ hasSentKind（send_date 無視・「開催回につき 1 回」）で行う。
// 旧方式（send_date=開催日で固定するキー・2026-07-04 事故対応）は撤去済み。hasSentKind は
// 旧キーで記録済みの行にもヒットするため、方式変更を跨いでも再送しない。send_date には実送信日を記録する。

/**
 * 通知が daysUntil 日後の開催回に対して何か送りうるか（安価な事前判定）。
 * ルール回の実体化判定と開催回ループの cheap-skip に使う（毎分実行の負荷を抑える）。
 * 募集は窓の途中で作られた臨時回にも出すため範囲判定（0..recruit_days_before）。
 */
export function inSendWindow(n: Notification, daysUntil: number): boolean {
  if (daysUntil < 0) return false;
  const announceOnly = isAnnounceOnly(n);
  const inRecruit = !!n.recruit_enabled && daysUntil <= n.recruit_days_before;
  // 募集が手動（recruit_enabled=0・不定期のみ）: ノルマ督促・②③・開催回ごとの締切告知はすべて「募集を投稿済みか」に
  // 連動するため、未来の回を常に窓に入れて drainOccurrence 側で send_log を照合する（未投稿なら即 return・ADR 0032）。
  const inManual = !announceOnly && !n.recruit_enabled;
  const inUnanswered = !announceOnly && !!n.remind_unanswered_enabled && daysUntil <= n.remind_start_days;
  const inUndecided = !announceOnly && !!n.remind_undecided_enabled && daysUntil <= n.remind_undecided_days;
  // 締切あり ⇒ 定期 ⇒ 募集自動（recruit_enabled=1）が DB の不変条件（migration 0025・admin 正規化）。
  // 締切告知の監視窓は募集窓に含まれる（E3 で締切は募集より後に限定済み）。
  const mayDeadline = !announceOnly && n.response_deadline_hours != null && daysUntil <= n.recruit_days_before;
  return inRecruit || inUnanswered || inUndecided || mayDeadline || inManual;
}

/** 送信窓の最遠日数（何日先の開催回まで何か送りうるか）。窓内実体化の範囲。OFF の工程は数えない。 */
export function maxWindowDays(n: Notification): number {
  const announceOnly = isAnnounceOnly(n);
  const recruit = n.recruit_enabled ? n.recruit_days_before : 0;
  const unanswered = !announceOnly && n.remind_unanswered_enabled ? n.remind_start_days : 0;
  const undecided = !announceOnly && n.remind_undecided_enabled ? n.remind_undecided_days : 0;
  return Math.max(0, recruit, unanswered, undecided);
}

/**
 * 日次ロールフォワードで実体化すべきルール日付（pure）。送信窓内の全ルール回のうち、同日付に行が
 * 1 つも無い（scheduled でも cancelled の墓石でもない）日付だけ。ADR 0023 追補の「未来分の事前作成は
 * しない」は「送信窓の外は作らない」と読み替える（docs/dev/schedule-recurrence-redesign.md §5.3）。
 */
export function ruleDatesToMaterialize(
  n: Notification,
  existingDates: Iterable<string>,
  now: Date = getJSTNow(),
): string[] {
  const taken = new Set(existingDates);
  return occurrenceDatesBetween(n, maxWindowDays(n), now).filter(
    (d) => !taken.has(d) && inSendWindow(n, getDaysUntil(d, now)),
  );
}

/**
 * 日次ロールフォワードの今ティックの処理範囲を決める（pure・マーカー形式の単一の解釈点）。
 * マーカー: 'YYYY/MM/DD'＝その日は完了 / 'YYYY/MM/DD:N'＝進行中（次は index N から）/
 * それ以外（別日・''・未設定）＝先頭から。完了済みなら null、未了なら [start,end) と
 * 処理後に書き戻す次マーカー（末尾まで達したら完了形）を返す。
 */
export function rollforwardWindow(
  marker: string | null | undefined,
  today: string,
  total: number,
  chunk: number,
): { start: number; end: number; next: string } | null {
  const [day, offset] = (marker ?? '').split(':');
  if (day === today && offset === undefined) return null; // 今日は完了済み
  const start = day === today ? Math.max(0, Math.min(Number(offset) || 0, total)) : 0;
  const end = Math.min(start + chunk, total);
  return { start, end, next: end >= total ? today : `${today}:${end}` };
}

/** 1 開催回の「今日の未送信分」をペース配信で処理する（送信本体）。 */
async function drainOccurrence(ctx: TickCtx, n: Notification, occ: Occurrence): Promise<void> {
  const { env, db, today, hour } = ctx;
  const announceOnly = isAnnounceOnly(n);
  const daysUntil = getDaysUntil(occ.occurrence_date);
  // この開催回の募集/告知を投稿済みか（開催回につき 1 回・send_date 無視）。締切告知・②③はすべて投稿済みが前提
  // （募集の無いチャンネルに「締め切りました」や催促 DM が出ない＝irregular-deadline-design 共通ルール 1・ADR 0032）。
  // 同じティックで募集を投稿した場合、②③は次ティック（1 分後）から。手動募集で未投稿なら何もすることが無い。
  const recruitPosted = posted(ctx, occ.id, 'recruit');
  if (!n.recruit_enabled && !recruitPosted) return;

  // --- (1) 締切告知（メンバー向け・締切時刻ゲート。send_hour に依存せず時刻ベースで独立発火・ADR 0014）---
  // 文面は固定（@メンションなし）だが、念のため allowed_mentions={parse:[]} で一切ピングしないことを保証。
  // deadlinePassed は締切〜開催日まで毎ティック true のため、posted（ティック冒頭の記録・hasSentKind と同じ判定）で「開催回につき 1 回」に抑える。
  // send_date=実送信日で記録。失敗（failed）は hasSentKind が数えないが、当日中は failed 行が
  // claim の UNIQUE キーを塞ぐため、再送は翌日以降（募集と同じ。開催日当日の失敗はリトライされない）。
  if (
    !announceOnly &&
    recruitPosted &&
    deadlinePassed(n, occ, ctx.now) &&
    !posted(ctx, occ.id, 'deadline_notice')
  ) {
    await drainTasks(ctx, n, occ, [
      {
        key: { notification_id: n.id, occurrence_id: occ.id, kind: 'deadline_notice', send_date: today },
        run: () => sendChannelMessage(env, n.channel_id, deadlineNoticeMessage(n, occ), null, { parse: [] }),
      },
    ]);
  }

  // 開始後は募集・ノルマ・リマインドを出さない（開始後に当日の回を作った・締切なし、のとき開催中に募集が出ていた）
  const start = responseDeadline(occ.occurrence_date, slotTime(occ, n), 0);
  if (start && ctx.now.getTime() >= start.getTime()) return;

  // 以降（募集・ノルマ・リマインド）は送信時刻ゲート。時刻未到達なら今ティックは送らない。
  if (hour < n.send_hour) return;

  // メンバー基準の送信（募集の 'members' メンション含む）の前にロール同期する（1 日 1 回/ギルドで冪等）。
  // announce-only のみのギルドでもロール管理区分が同期されるよう、announce-only 判定の前に呼ぶ。
  await ensureRoleSync(ctx, n.guild_id);

  // --- (2) 募集（チャンネル投稿）---
  // 窓判定（0..recruit_days_before）＋「開催回につき 1 回」（posted・send_date 無視）。
  // 窓の途中で作られた臨時回にも募集が出る。送信失敗（failed）は翌日以降に自然リトライされる。
  // recruit_enabled=0（手動投稿・ADR 0026）は自動では出さない（📣 今すぐ募集は recruitOccurrenceNow 経由で別）。
  // 締切を過ぎた回には募集を出さない（送信失敗のリトライが締切後に回るのを防ぐ＝共通ルール 2・ADR 0032。UI が理由を表示）。
  if (n.recruit_enabled && daysUntil <= n.recruit_days_before && !recruitPosted && !deadlinePassed(n, occ, ctx.now)) {
    await drainTasks(ctx, n, occ, [
      {
        key: { notification_id: n.id, occurrence_id: occ.id, kind: 'recruit', send_date: today },
        run: () => sendRecruitment(env, n, occ),
      },
    ]);
  }

  if (announceOnly) return; // 回答不要は以降（回答依存）対象外。

  // --- (3) ノルマ（「この開催回の募集を今日投稿した」日に送る・未送信分のみ）---
  // 基準は「募集 N 日前ちょうど」ではなく send_log の recruit（2026-09-05 変更）。自動募集の追いつき投稿でも、
  // 手動募集（📣）でも、投稿した日の送信時刻以降（投稿が送信時刻より後なら次ティック）に督促が出る。
  // ponytail: 日付をまたぐ直前（送信時刻より後の 23:5x）の投稿は当日中に捌けた分だけ＝翌日に持ち越さない。
  if (n.quota_enabled && n.quota_interval_days && room(ctx) && ctx.chan.get(`${occ.id}:recruit`)?.some((r) => r.status === 'sent' && r.send_date === today)) {
    const alerts = await checkQuotaForNotification(db, n);
    const guildName = await resolveGuildName(ctx, n.guild_id);
    await drainTasks(
      ctx,
      n,
      occ,
      alerts.map((member) => ({
        key: { notification_id: n.id, user_id: member.user_id, kind: 'quota' as const, send_date: today },
        run: () => sendDirectMessageCached(env, db, member, quotaMessage(n, member, guildName)),
        cost: dmCost(member),
      })),
    );
  }

  // --- (4) 未回答リマインド（0<=daysUntil<=remind_start_days・当日は開始時刻前のみ。OFF なら送らない）---
  // 締切が来たら催促も止める（B1・flow-settings-spec §4）。回答ボタン自体は締切後も押せる（ソフトロック・ADR 0014）。
  if (
    n.remind_unanswered_enabled &&
    recruitPosted &&
    daysUntil >= 0 &&
    daysUntil <= n.remind_start_days &&
    !deadlinePassed(n, occ, ctx.now) &&
    room(ctx)
  ) {
    if (beforeStartIfToday(n, occ, daysUntil, ctx.now)) {
      if (n.remind_target === 'channel') {
        const targets = await remainingUnansweredTargets(db, n.segment_id, occ.id, n.id, today, CHANNEL_REMIND_LIMIT);
        if (targets.length)
          await drainTasks(ctx, n, occ, channelReminderTasks(env, n, occ, today, 'remind_unanswered', targets, unansweredChannelMessage(n, occ, daysUntil)));
      } else {
        const targets = await remainingUnansweredTargets(db, n.segment_id, occ.id, n.id, today, ctx.budget.n);
        const guildName = await resolveGuildName(ctx, n.guild_id);
        await drainTasks(
          ctx,
          n,
          occ,
          targets.map((member) => ({
            key: { notification_id: n.id, occurrence_id: occ.id, user_id: member.user_id, kind: 'remind_unanswered' as const, send_date: today },
            run: () => sendDirectMessageCached(env, db, member, unansweredMessage(n, occ, daysUntil, guildName), createButtonComponents(occ.id)),
            cost: dmCost(member),
          })),
        );
      }
    }
  }

  // --- (5) 未定リマインド（0<=daysUntil<=remind_undecided_days の範囲・毎日。OFF なら送らない。締切後は送らない＝B1）---
  // 未回答リマインド (4) と同じ範囲判定＋日次デデュープ（2026-09-05 に「N 日前ちょうど 1 回」から変更）。
  // N 日前を過ぎてから追加された回（臨時回・不定期）にも登録日から出る（募集の追いつきと同じ）。
  // 当日は開始時刻前のみ（②と同じ・範囲化に伴い当日も判定対象になったため・2026-09-05）
  if (
    n.remind_undecided_enabled &&
    recruitPosted &&
    daysUntil >= 0 &&
    daysUntil <= n.remind_undecided_days &&
    beforeStartIfToday(n, occ, daysUntil, ctx.now) &&
    !deadlinePassed(n, occ, ctx.now) &&
    room(ctx)
  ) {
    if (n.remind_undecided_target === 'channel') {
      const targets = await remainingUndecidedTargets(db, n.segment_id, occ.id, n.id, today, CHANNEL_REMIND_LIMIT);
      if (targets.length)
        await drainTasks(ctx, n, occ, channelReminderTasks(env, n, occ, today, 'remind_undecided', targets, undecidedChannelMessage(n, occ)));
    } else {
      const targets = await remainingUndecidedTargets(db, n.segment_id, occ.id, n.id, today, ctx.budget.n);
      const guildName = await resolveGuildName(ctx, n.guild_id);
      await drainTasks(
        ctx,
        n,
        occ,
        targets.map((member) => ({
          key: { notification_id: n.id, occurrence_id: occ.id, user_id: member.user_id, kind: 'remind_undecided' as const, send_date: today },
          run: () => sendDirectMessageCached(env, db, member, undecidedMessage(n, occ, guildName), createButtonComponents(occ.id)),
          cost: dmCost(member),
        })),
      );
    }
  }
}

/**
 * cron ティック（ADR 0013 ペース配信）。送信時刻に達した通知の今日の未送信分を予算内で送る。
 * index.ts の scheduled ハンドラから奇数分に呼ばれる（偶数分は日程調整）。
 */
export async function runTick(rawEnv: Env): Promise<void> {
  const now = getJSTNow();
  // このティックの D1 クエリはすべて countingD1 を通して数える（送信本体が env.DB を使う分も含める）
  const d1 = { n: D1_BUDGET_PER_TICK };
  // 送信の 429 は DiscordRateLimited で受け取る（drainTasks が claim を消して打ち切る）
  const env: Env = rateLimitAware({ ...rawEnv, DB: countingD1(rawEnv.DB, d1) });
  // config（数行の key/value）はティック冒頭に一括読みし、送信予算・ロールフォワード・
  // ロール同期マーカーの細切れ照会を 1 クエリに畳む。
  const config = await getAllConfig(env.DB);
  const ctx: TickCtx = {
    env,
    db: env.DB,
    now,
    today: formatDate(now),
    hour: now.getHours(),
    budget: { n: parseConfigInt(config[SEND_BUDGET_KEY], DEFAULT_SEND_BUDGET) },
    d1,
    config,
    chan: new Map(),
  };
  // クラッシュ等で status='sending' のまま残った claim を回収（5分以上前）→ 再送可能にする。
  // 回収対象がそもそも「5分以上前」なので回収も 5 分粒度で足りる（毎分 DELETE を打たない）。
  if (now.getMinutes() % 5 === 0) {
    await clearStaleClaims(env.DB, new Date(Date.now() - 5 * 60_000).toISOString());
  }

  const notifications = await listActiveNotifications(env.DB);
  if (notifications.length === 0) return;

  // 未来の開催回（臨時回・中止の墓石を含む）を 1 クエリで一括取得して通知ごとに配る。
  // 通知ごとの個別照会を避け、毎分実行のクエリ数を通知数に比例させない。
  const futureByNotif = new Map<number, Occurrence[]>();
  const planned = new Set((await env.DB.prepare('SELECT occurrence_id FROM planning_occurrences').all<{occurrence_id:number}>()).results.map(r=>r.occurrence_id));
  for (const o of await listFutureOccurrencesAll(env.DB, ctx.today)) {
    if (planned.has(o.id)) continue;
    const arr = futureByNotif.get(o.notification_id);
    if (arr) arr.push(o);
    else futureByNotif.set(o.notification_id, [o]);
  }
  // 募集・締切告知の送信済み判定は開催回ごとに照会せず、ここで 1 回にまとめる（何もすることの無い開催回で D1 を使わない）。
  // 下の実体化で増えた開催回は記録が無い＝未送信なので、実体化の前に読んでよい。
  ctx.chan = await listChannelSends(env.DB, ctx.today);

  // 日次ロールフォワード: 定期スケジュール（rrule あり）の送信窓内の全ルール回を origin='rule' で実体化する
  // （1 日 1 巡）。rrule 評価は重く毎ティック全件は回せないため、1 ティック最大 ROLLFORWARD_CHUNK 件ずつ
  // 進め、マーカーに進捗を持たせる（kill・transient 失敗でも次ティックが続きから再開＝
  // 「マーカー未達で毎ティック全量リトライ→恒常超過」のスパイラルを構造的に防ぐ）。
  // 完了後のティックは実体化済み行を futureByNotif 経由で読むだけ＝rrule 評価ゼロ。
  // 通知の作成/編集時は admin 側がマーカーを '' にクリアし、次ティックから先頭をやり直す。
  // 不定期（rrule NULL）は評価対象外＝運用者が追加した行だけが futureByNotif に載る。
  const ruled = notifications.filter((n) => n.rrule);
  const rf = rollforwardWindow(ctx.config[OCC_ROLLFORWARD_KEY], ctx.today, ruled.length, ROLLFORWARD_CHUNK);
  if (rf) {
    ruled.sort((a, b) => a.id - b.id); // チャンクの跨ティック整合のため順序を固定
    let next = rf.next;
    rollforward: for (let i = rf.start; i < rf.end; i++) {
      const n = ruled[i];
      try {
        const existing = futureByNotif.get(n.id) ?? [];
        // 同日付に行がある（scheduled でも cancelled の墓石でも）日付は実体化しない。
        for (const d of ruleDatesToMaterialize(n, existing.map((o) => o.occurrence_date), now)) {
          // 実体化 1 件は最大 3 クエリ。送信の分を残して打ち切り、次ティックはこの通知から再開する
          // （作成済みの日付は飛ばすので進む）。
          if (d1.n < D1_PER_OCC + 3) {
            futureByNotif.set(n.id, existing);
            next = `${ctx.today}:${i}`;
            break rollforward;
          }
          existing.push(await getOrCreateOccurrence(env.DB, n.id, d, n.start_time, 'rule'));
        }
        futureByNotif.set(n.id, existing); // 同ティックの送信ループでも拾えるよう反映
      } catch (e) {
        // 1 件の失敗（D1 transient 等）で巡回全体を止めない。翌日/マーカークリアで自己回復。
        console.error(`[Rollforward] n=${n.id} failed: ${(e as Error).message}`);
      }
    }
    await setConfig(env.DB, OCC_ROLLFORWARD_KEY, next);
  }

  // 窓内の開催回を全スケジュール横断の 1 列に並べ、ティック番号で開始位置をローテートする（再レビュー A2-02）。
  // 予算切れで毎回同じ場所で止まっても、各開催回は列の長さ分のティックごとに先頭へ回り、先頭は必ず
  // D1_PER_OCC 以上の残りで処理される（実体化は D1_PER_OCC+3 を残して止まる）＝何度か実行すればいずれ全件に届く。
  // runTick は奇数分だけ動くので 2 分を 1 ティックと数える（1 分単位だと列の長さが偶数のとき先頭が奇数番目に偏る）。
  // ponytail: 先頭に回るのは 1 ティックに 1 件ずつ＝予算を超える件数があると最悪「件数×2 分」待つ。近い回の優先はしない。
  const queue: { n: Notification; occ: Occurrence }[] = [];
  for (const n of notifications) {
    for (const occ of futureByNotif.get(n.id) ?? []) {
      if (occ.status !== 'scheduled') continue;
      // 単発は送信時刻と投稿の流れを開催回ごとに持つ（migration 0036）。以降は開催回の値で上書きした雛形として扱う
      const eff = flowFor(n, occ);
      if (inSendWindow(eff, getDaysUntil(occ.occurrence_date))) queue.push({ n: eff, occ });
    }
  }
  if (!queue.length) return;
  queue.sort((a, b) =>
    (a.occ.occurrence_date + (a.occ.start_time || '')).localeCompare(b.occ.occurrence_date + (b.occ.start_time || '')),
  );
  const start = Math.floor(now.getTime() / 120_000) % queue.length;
  for (const { n, occ } of [...queue.slice(start), ...queue.slice(0, start)]) {
    if (ctx.budget.n <= 0 || ctx.d1.n < D1_PER_OCC) break;
    try {
      await drainOccurrence(ctx, n, occ);
    } catch (e) {
      console.error(`[Tick] n=${n.id} occ=${occ.id} failed: ${(e as Error).message}`);
    }
  }
}
