# セットアップ手順（discord-event-bot / Cloudflare Workers + D1）

自己ホスト型の構築手順。**登録が必要なサービスは Discord と Cloudflare の 2 つだけ**・無料枠で動作します。
データモデルは Server ＞ Notification → Segment ＞ Occurrence。言語=日本語固定 / 時刻=JST固定 / マルチサーバー（テナント分離なし・単一 ADMIN_TOKEN）。

## 0. 前提
- Node.js 18 以上
- Cloudflare アカウント（無料で可）
- Discord アプリ（Developer Portal）— Bot Token / Application ID / Public Key

## 1. 取得・インストール
```bash
git clone <this-repo> discord-event-bot
cd discord-event-bot
npm install
npm install -g wrangler        # CLI（未導入の場合）
wrangler login                 # ブラウザで Cloudflare にログイン
```

## 2. D1 データベース作成
```bash
wrangler d1 create discord-event-bot-db    # 名前は任意。変える場合は wrangler.toml と package.json の db:migrate スクリプトも合わせる
```
出力された `database_id` を **`wrangler.toml` の `[[d1_databases]]` の `database_id`** に貼り付ける。

## 3. スキーマ適用（マイグレーション）
```bash
npm run db:migrate:remote      # 本番 D1
npm run db:migrate:local       # ローカル開発用 D1（任意）
```
> マイグレーションは **D1 バインディング名 `DB`** を対象に適用する（`wrangler d1 migrations apply DB`）。バインディング名で指定するのは、「Deploy to Cloudflare」ボタンで配布したとき各利用者の D1 が別名で自動生成されても同じスクリプトで動くようにするため。`migrations/` の連番（`0001` 〜）を順に適用し、`d1_migrations` テーブルで適用済みが管理される。**既存のマイグレーションは編集せず、変更は必ず新しい番号で追加すること**（配布済み環境との不整合を防ぐ）。

## 4. シークレット設定
```bash
wrangler secret put DISCORD_PUBLIC_KEY
wrangler secret put DISCORD_APPLICATION_ID
wrangler secret put DISCORD_BOT_TOKEN
wrangler secret put ADMIN_TOKEN        # 管理UI用。例: openssl rand -hex 32 で生成
```
> ⚠️ 旧版にあった `DISCORD_CHANNEL_ID` は**廃止**。投稿チャンネルは Notification ごとに管理 UI で設定する。

## 5. スラッシュコマンド登録
`.env` に `DISCORD_BOT_TOKEN` と `DISCORD_APPLICATION_ID`（テスト時は `DISCORD_GUILD_ID` も）を入れて:
```bash
npm run register-commands
```
登録されるコマンド: `/recruit` `/assign`（ともに `notification_id` 指定）/ `/pause` `/resume`（`user` ＋任意 `segment_id`）/ `/members`（任意 `segment_id`）。

## 6. デプロイ
```bash
npm run deploy   # = db:migrate:remote（本番 D1 へマイグレーション）→ wrangler deploy
```
出力される URL（例 `https://discord-event-bot.<account>.workers.dev`）を控える。
> 「Deploy to Cloudflare」ボタンで配布した利用者環境でも、この `deploy` スクリプトを Cloudflare が自動検出し、初回・更新（本番ブランチへの push ごとの Workers Builds）でマイグレーションが自動適用される。

## 7. Discord 側の設定
- Developer Portal → アプリ → **Interactions Endpoint URL** に `https://<worker-url>/interactions` を設定（保存時に Discord が PING 検証）。
- Developer Portal → **Bot → Privileged Gateway Intents → Server Members Intent を有効化**（管理 UI のメンバーピッカーが参加者一覧を取得するため・ADR 0006）。
- Bot をサーバーに招待（**`bot` ＋ `applications.commands` の両スコープ**。メッセージ送信・DM 権限）。

## 8. 管理 UI で初期設定
ブラウザで `https://<worker-url>/` を開き `ADMIN_TOKEN` を入力。最初に**管理するサーバーを選択**（bot の参加サーバーから自動取得）し、次の順で作る:
1. **メンバー区分**: Segment を作成（例 キャスト / スタッフ）。@メンションする Discord ロールを任意で紐付け。メンバーは「メンバーを追加」のピッカーで参加者から選ぶ（User ID 手打ち不要・サーバー内ニックを自動取得）。
2. **通知**: Notification を作成。対象 Segment・投稿チャンネル（チャンネルピッカー）・スケジュール（毎週/隔週/毎月第N曜、または単発）・開始時刻・募集/リマインド日数・ノルマ/番号割り当て/メンションの ON/OFF を設定。
   - 隔週のときは「次にこの通知で開催する日」を候補から選ぶ（内部の系列起点に使う。RRULE はユーザーには表示されない）。
3. **回答履歴**: 回答（responses）を閲覧。番号割り当ての実行は「通知 → 開催回」から、または Discord の `/assign` から。
4. メンバーは募集ボタンへの回答でも自動登録され、区分に自動所属する。

## 9. ローカル開発
> ⚠️ **重要（本番事故防止）**: `wrangler dev` はローカルで `.env` も自動読込する（wrangler v4 挙動）。
> 本番 `.env` が同居していると本番チャンネルへ投稿してしまうため、必ず `.dev.vars` を作成し、
> **テスト用アプリ＋ダミーサーバーの値のみ**を入れること（本番値は厳禁）。`.dev.vars` は `.env` より優先される。
```bash
cp .dev.vars.example .dev.vars   # 実値を設定（.dev.vars は gitignore 済み）
npm run db:migrate:local
npm run dev                      # wrangler dev（ローカル D1）
```
Discord インタラクションのローカル検証は cloudflared トンネル経由で、**本番とは別のテスト用 Discord アプリ**の Interaction Endpoint に向ける:
```bash
cloudflared tunnel --url http://localhost:8787
```

## 10. テスト
```bash
npm test          # vitest（D1 / RRULE を含む）
npm run typecheck # 型チェック
```

---

## 補足
- **cron**: `wrangler.toml` の `crons = ["0 12 * * *"]` は **UTC**（JST 21:00 相当）。日次 tick で全 active Notification を評価し、各通知の `recruit_days_before` / `remind_start_days` / `remind_undecided_days` に従って募集・リマインドを出す。通知ごとの時刻は `start_time`。
- **無料枠**: Workers 10万req/日。DM はチャンネル ID をキャッシュしてサブリクエストを抑制。
