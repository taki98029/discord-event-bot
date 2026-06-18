# 実装契約書（汎用リデザイン v7）

> **v8 改訂（重要）**: 本契約書は v7 スナップショット。以後の構造変更は ADR が上書きする — [0004 マルチサーバー](adr/0004-multi-server.md) / [0005 Event 廃止](adr/0005-drop-event-layer.md) / [0006 メンバー3層](adr/0006-member-three-layers.md) / [0007 管理画面リデザイン](adr/0007-admin-ui-redesign.md) / [0008 検証方針](adr/0008-verify-on-deployed-test-worker.md)。**Event 層は廃止**され階層は `Server(guild_id) ＞ Notification → Segment ＞ Occurrence`、`notifications.event_id` は `guild_id` に置換、UI は 2 層シェル＋各種ピッカーへ移行済み。本文中の Event / 単一テナント /「イベント」タブ / 基準日 等の旧記述は当該 ADR が優先する。

各モジュールが従う API・アルゴリズム・I/F の単一の真実。型は `src/db/types.ts`、スキーマは `migrations/0002`＋`0003`(guild_id)＋`0004`(Event 廃止)、用語は `CONTEXT.md`、背景は `docs/adr/*` を参照。

**不変条件**
- 言語=日本語固定 / 時刻=JST固定（`getJSTNow()` 基準）。マルチサーバー（テナント分離なし・単一 ADMIN_TOKEN・ADR 0004）。
- 応答ステータスは `参加` / `不参加` / `未定` の3値固定。
- 旧 Vercel 版（`api/` `lib/` `vercel.json`）には触れない。
- `env` から `DISCORD_CHANNEL_ID` は廃止済み（チャンネルは Notification ごと）。

---

## custom_id 形式（ボタン）
`{action}_{occurrenceId}`（例 `participate_42` / `status_42`）。action ∈ `participate|absent|undecided|status`。occurrenceId は整数。

## STATUS_MAP
`participate→参加`, `absent→不参加`, `undecided→未定`。

---

## src/lib/date.ts（既存を維持＋微修正）
- `getJSTNow(): Date`、`formatDate(date: Date|string): string`（'YYYY/MM/DD'）はそのまま。
- `parseJSTDate(s: string): Date` を追加: 'YYYY/MM/DD' を JST 壁時計の Date として解釈（`new Date(y, m-1, d)` 相当, UTCランタイム前提で getJSTNow と整合）。
- `getDaysUntil(dateStr: string, now?: Date): number` を追加: 'YYYY/MM/DD' と今日(JST)の日数差。

## src/lib/recurrence.ts（新規）
RRULE 評価を 1 箇所に閉じ込める。消費側は以下のみ使う。
※ recurring の系列基準は `notifications.anchor_date`（'YYYY/MM/DD'・任意）を dtstart に使う。隔週の開催週パリティを安定させるため（UI では「次回の開催日」候補として提示。「基準日」表記は廃語・ADR 0007）。未設定時は固定エポックにフォールバック（週次/毎月第N曜は基準非依存）。rrule は内部 UTC 評価のため、JST カレンダー値を UTC フィールドに載せて渡し、結果も getUTC* で読む（TZ 非依存）。
- `nextOccurrenceDate(n: Notification, now?: Date): string | null`
  - `n.type==='oneoff'`: `n.one_off_date` を返す（過去でもそのまま返す。呼び出し側が daysUntil で判定）。
  - `n.type==='recurring'`: `n.rrule` を JST 基準で評価し、**今日以降で最も近い開催日**を 'YYYY/MM/DD' で返す。当日でも開始時刻前なら当日、開始時刻以降なら次の回（旧 getTargetDate の当日ロジックを踏襲。start_time を使う）。
  - 第一実装は `rrule` パッケージの `RRule.fromString()` + `.after(jstMidnightToday, inc=true)`。Workers 非互換ならサポート対象（FREQ=WEEKLY[;INTERVAL=2] / FREQ=MONTHLY;BYDAY=NSA 等の第N曜）だけの自前評価にフォールバック（API は変えない）。
- `buildRRule(opts): string` ヘルパ（任意・UI/テスト用）。weekly(byday) / biweekly(interval=2) / monthly-nth-weekday を組み立て。

> RRULE 例: 毎週土曜=`FREQ=WEEKLY;BYDAY=SA` / 隔週土曜=`FREQ=WEEKLY;INTERVAL=2;BYDAY=SA` / 毎月第2土曜=`FREQ=MONTHLY;BYDAY=2SA`。

## src/discord/rest.ts（改修）
- `createButtonComponents(occurrenceId: number): unknown[]` — custom_id を `{action}_{occurrenceId}` に。ラベル/絵文字は現状維持（参加/不参加/未定/📊 状況確認）。
- `sendChannelMessage(env, channelId: string, content: string, components?: unknown[]|null): Promise<boolean>` — **channelId は必須引数**（既定チャンネル廃止）。
- `buildStatusMessage(dateStr, buckets)` は現状維持。
- `sendDirectMessageCached(env, db, member, content, components?)` は現状維持。
- メンション用ヘルパ `buildMentionPrefix(segment: Segment, enabled: boolean): string` を追加: enabled かつ `mention_role_id` があれば `<@&id>\n\n`（'@everyone' は `@everyone\n\n`）、無ければ ''。

## src/db/events.ts（廃止・ADR 0005）
Event 層は廃止し `events.ts` は削除。Notification は `guild_id` で Server に直結する。サーバー一覧は Discord API（`listGuilds`）由来で DB マスタ（events テーブル）を持たない。

## src/db/segments.ts（新規）
- `listSegments(db): Promise<Segment[]>` / `getSegment(db, id): Promise<Segment|null>`
- `createSegment(db, { name, mention_role_id }): Promise<Segment>`
- `updateSegment(db, id, { name, mention_role_id }): Promise<boolean>`
- `deleteSegment(db, id): Promise<boolean>` — 所属(segment_members)も削除。対象にしている notification がある場合は削除させない（呼び出し側で 409 等。db 関数は notification 数を数える `countNotificationsForSegment(db, id)` を提供）。
- `listSegmentMembers(db, segmentId): Promise<SegmentMember[]>`（members JOIN、status 付き、created_at 順）
- `getActiveSegmentMembers(db, segmentId): Promise<Member[]>`（status='' のみ）
- `addSegmentMember(db, segmentId, userId): Promise<void>`（存在すれば no-op の upsert、status は既存維持）
- `setSegmentMemberStatus(db, segmentId, userId, status): Promise<boolean>`
- `removeSegmentMember(db, segmentId, userId): Promise<boolean>`
- `listSegmentsForMember(db, userId): Promise<Segment[]>`（その人が所属する区分。/pause の自動選択用）

## src/db/members.ts（改修: status 列を撤去）
- `getAllMembers(db): Promise<Member[]>` / `getMember(db, userId): Promise<Member|null>`
- `addMember(db, userId, userName, displayName): Promise<'added'|'exists'>`（status 引数なし）
- `updateMemberDisplayName(db, userId, displayName, userName): Promise<void>`（未設定時のみ書く・現挙動踏襲）
- `setDmChannelId(db, userId, channelId): Promise<void>`
- `upsertMember(db, { user_id, user_name?, display_name? }): Promise<void>`（status 列なし）
- `deleteMember(db, userId): Promise<boolean>`（全 segment_members / responses / assignments からも掃除）
- `ensureMember(db, userId, userName, displayName): Promise<void>`（無ければ追加。ボタン自動登録用）

## src/db/notifications.ts（新規）
- `listNotifications(db): Promise<NotificationListItem[]>`（一覧用に candidate_count/decided_date/decided_time を付与）/ `listActiveNotifications(db): Promise<Notification[]>`（active=1・cron 用）
- `getNotification(db, id): Promise<Notification|null>`
- `listNotificationsByGuild(db, guildId): Promise<NotificationListItem[]>`（Server 配下の絞り込み・一覧用集計列付き）
- `createNotification(db, input): Promise<Notification>` / `updateNotification(db, id, patch): Promise<boolean>`
- `deleteNotification(db, id): Promise<boolean>` — 配下 occurrences と、その responses/assignments も削除。
- 数値フラグ(quota_enabled/assignment_enabled/mention_enabled/active)は 0/1 で扱う。

## src/db/occurrences.ts（新規）
- `getOrCreateOccurrence(db, notificationId, dateStr): Promise<Occurrence>` — UNIQUE(notification_id, occurrence_date) で upsert。既存なら取得。
- `getOccurrence(db, id): Promise<Occurrence|null>`
- `getLatestScheduledOccurrence(db, notificationId): Promise<Occurrence|null>`（occurrence_date 最大・status='scheduled'）
- `setOccurrenceStatus(db, id, status): Promise<boolean>`（'scheduled'|'cancelled'）
- `updateOccurrenceDate(db, id, dateStr): Promise<boolean>`（リスケ）
- `listOccurrencesForNotification(db, notificationId, limit?): Promise<Occurrence[]>`

## src/db/responses.ts（旧 eventLog 改修）
- `upsertResponse(db, occurrenceId, userId, userName, status): Promise<void>`（PK=(occurrence_id,user_id) で upsert）
- `getResponsesForOccurrence(db, occurrenceId): Promise<Record<string,{status:string}>>`
- `getUndecidedForOccurrence(db, occurrenceId): Promise<{userId:string,name:string|null}[]>`
- `getStatusBuckets(db, occurrenceId, segmentId): Promise<EventStatusBuckets>` — **その区分のアクティブメンバー**（getActiveSegmentMembers）を母集団に、responses を突合。回答なし=未回答。
- `checkQuotaForNotification(db, n: Notification, now?): Promise<QuotaAlert[]>` — n.quota_enabled かつ interval 設定時。対象=segment のアクティブメンバー。各人の「このNotificationの occurrences における status='参加' の最大 occurrence_date」を求め、interval 超過者を返す（未参加者は除外＝旧仕様）。
- `listRecentResponses(db, limit=200): Promise<Array<Response & { occurrence_date: string; notification_name: string }>>`（admin 閲覧用、occurrences/notifications を JOIN、新しい順）

## src/db/assignments.ts（新規）
- `assignNumbers(db, occurrenceId): Promise<{ assigned: {user_id:string; number:number}[]; all: {user_id:string; number:number; name:string}[] }>`
  - 安定割り当て: 既存 assignments は維持。対象=その occurrence で status='参加' の responder のうち未採番の人。空き番号（1..最大、欠番優先で連番が埋まるよう 1 から最小の空き）を集め、**新規対象者をシャッフルして**順に割り当て。`all` は全採番済みを number 昇順で、名前(resolveDisplayName 相当)付きで返す。
  - ※ ランダム性: シャッフルは Fisher–Yates。`Math.random()` 可（テスト時は順序非依存の検証に留める）。
- `getAssignments(db, occurrenceId): Promise<{user_id:string; number:number}[]>`

---

## src/cron/dailyCheck.ts（全面改修）
`mainDailyCheck(env)`: `listActiveNotifications` をループ。各 n について:
1. `target = nextOccurrenceDate(n)`。null ならスキップ。`daysUntil = getDaysUntil(target)`。
2. **募集 & ノルマ**: `daysUntil === n.recruit_days_before` のとき:
   - `occ = getOrCreateOccurrence(db, n.id, target)`。occ.status==='cancelled' ならスキップ。
   - 募集メッセージを `n.channel_id` へ送信（mention 接頭辞 + 「📅 イベント募集開始!」＋ 日時 `target (曜日) start_time~` ＋ ボタン `createButtonComponents(occ.id)`）。
   - `n.quota_enabled` なら `checkQuotaForNotification` → 各対象へ DM。
3. **未回答リマインド**: `0 <= daysUntil <= n.remind_start_days` のとき、当日は開始時刻前のみ（現挙動踏襲）。対象=segment アクティブメンバー − 既回答。occ が無ければ getOrCreate。各対象へ DM。
4. **未定リマインド**: `daysUntil === n.remind_undecided_days` のとき、occ の未定者（休止者除く）へ DM。
- DM 連投は `await sleep(300)` を挟む（DM_INTERVAL_MS）。ログは現行同様 `console.log`。

## src/interactions/index.ts（全面改修）
- 署名検証(verifyKey)・PING は現状維持。
- **ボタン**: custom_id を `{action}_{occurrenceId}` で解析。
  - `status`: `occ = getOccurrence`; その notification の segment_id で `getStatusBuckets(db, occ.id, segmentId)` → `buildStatusMessage(occ.occurrence_date, buckets)`。
  - participate/absent/undecided: `ensureMember` → occ から notification → segment を辿り `addSegmentMember`（自動所属）。所属が '休止中' なら回答拒否メッセージ。OK なら `upsertResponse(db, occ.id, userId, userName, status)`。表示名更新は `ctx.waitUntil`。
- **スラッシュコマンド**（option は register-commands と一致させる）:
  - `/recruit notification_id:int` — 指定 Notification の `nextOccurrenceDate` で occ を getOrCreate し募集投稿。ephemeral で結果。
  - `/assign notification_id:int` — その Notification の `getLatestScheduledOccurrence` に対し `assignNumbers`。結果一覧を **n.channel_id へ公開投稿**（「🎲 割り当て結果」＋ `#番号 表示名` の一覧）。実行者へは ephemeral で要約。
  - `/pause user:user [segment_id:int]` — segment 指定時その区分、未指定で所属が1つならそれ、複数なら ephemeral で「区分を指定してください」。`setSegmentMemberStatus(...,'休止中')`。
  - `/resume user:user [segment_id:int]` — 同様に '' へ。
  - `/members [segment_id:int]` — segment 指定で区分メンバー一覧、未指定で全メンバー一覧（所属区分も表示）。
- 例外時は ephemeral でエラー文言（現行踏襲）。

## src/admin/index.ts（全面改修）
Bearer ADMIN_TOKEN 認証（timingSafeEqual）は現状維持。ルート（すべて JSON）:
- `GET /guilds`, `GET /guilds/:id/channels`, `GET /guilds/:id/members`（Discord API 由来・読み取り専用）
- `GET/POST /segments`, `PUT/DELETE /segments/:id`
- `GET /segments/:id/members`, `POST /segments/:id/members`({user_id}), `PUT /segments/:id/members/:userId`({status}), `DELETE /segments/:id/members/:userId`
- `GET/POST /members`, `DELETE /members/:userId`
- `GET/POST /notifications`, `GET/PUT/DELETE /notifications/:id`
- `GET /notifications/:id/occurrences`, `PUT /occurrences/:id`({status|date})
- `GET /occurrences/:id/responses`, `GET /occurrences/:id/assignments`, `POST /occurrences/:id/assign`（assignNumbers 実行）
- `GET /responses?limit=` （listRecentResponses）
- パスは `url.pathname.replace(/^\/api\/admin/, '')`。404/400/500 ハンドリングは現行踏襲。

## src/index.ts
現状維持（/interactions, /api/admin*, ASSETS, scheduled→mainDailyCheck）。変更不要。

## ui/index.html（全面改修・ADR 0007）
バニラ JS の管理 SPA・2 層シェル。トークンゲート → **全画面サーバー選択**（`GET /guilds`）→ 左サイドナビのワークスペース（ヘッダにサーバー切替・選択は URL ハッシュ + localStorage 保持）。セクション:
- **通知**: notifications の CRUD（`?guild_id=` 絞り込み）。対象 Segment 選択、投稿チャンネルは**チャンネルピッカー**、type(recurring/oneoff)、繰り返しビルダは**生 RRULE 非表示＋日本語サマリ**、隔週時のみ「次回の開催日」候補（→ anchor_date）、条件表示徹底、各日数、quota/assignment/mention トグル。番号割り当ては「通知 → 開催回」の文脈で実行。
- **メンバー区分**: segments の CRUD ＋ 区分メンバー管理。追加は **Discord メンバーピッカー**（`GET /guilds/:id/members`・User ID 手打ち廃止・サーバー内ニック自動取得）。
- **回答履歴**: responses 閲覧。
全 API 呼び出しに `Authorization: Bearer <token>`。エラーは画面に表示。旧「イベント」「メンバー」タブは廃止。

## scripts/register-commands.js（改修）
コマンド定義を更新:
- `recruit`(option: notification_id int, required), `assign`(notification_id int, required),
- `pause`(user:user required, segment_id:int optional), `resume`(同), `members`(segment_id:int optional)。
- `addmember` は廃止（ボタン自動登録＋管理UIで代替）。
- 既存の guild/global 切替・dotenv 読み込みは維持。

## tests/（更新）
- `tests/apply-migrations.ts`: beforeEach のクリアを新テーブルに更新（events, segments, members, segment_members, notifications, occurrences, responses, assignments を DELETE）。
- `tests/recurrence.test.ts`(新規): `nextOccurrenceDate` を週次/隔週/毎月第N曜/oneoff で検証（now をローカルコンストラクタで固定。**Workers 互換の確認も兼ねる**）。
- `tests/db.test.ts`(改修): segment アクティブメンバー集計・`checkQuotaForNotification`・`assignNumbers`（安定割り当て: 再実行で既存番号維持・新規のみ採番・重複なし）を検証。
- `tests/date.test.ts`: 既存の getJSTNow/formatDate 系は維持。
