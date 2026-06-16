# セットアップ手順（Cloudflare Workers + D1）

自己ホスト型の構築手順。**登録が必要なサービスは Discord と Cloudflare の 2 つだけ**・無料枠で動作します。

## 0. 前提

- Node.js 18 以上
- Cloudflare アカウント（無料で可）
- Discord アプリ（Developer Portal）— Bot Token / Application ID / Public Key

## 1. 取得・インストール

```bash
git clone <this-repo> choiemu-event-bot
cd choiemu-event-bot
npm install
npm install -g wrangler        # CLI（未導入の場合）
wrangler login                 # ブラウザで Cloudflare にログイン
```

## 2. D1 データベース作成

```bash
wrangler d1 create choiemu-event-bot-db
```

出力された `database_id` を **`wrangler.toml` の `[[d1_databases]]` の `database_id`** に貼り付ける
（`PLACEHOLDER_RUN_wrangler_d1_create` を置き換え）。

## 3. スキーマ適用（マイグレーション）

```bash
npm run db:migrate:remote      # 本番 D1
npm run db:migrate:local       # ローカル開発用 D1（任意）
```

## 4. シークレット設定

```bash
wrangler secret put DISCORD_PUBLIC_KEY
wrangler secret put DISCORD_APPLICATION_ID
wrangler secret put DISCORD_BOT_TOKEN
wrangler secret put DISCORD_CHANNEL_ID
wrangler secret put ADMIN_TOKEN        # 管理UI用。例: openssl rand -hex 32 で生成
```

> 値は旧 `.env`（Vercel 版）から流用できます。`ADMIN_TOKEN` のみ新規生成。

## 5. スラッシュコマンド登録

`.env` に `DISCORD_BOT_TOKEN` と `DISCORD_APPLICATION_ID` を入れて:

```bash
npm run register-commands
```

## 6. デプロイ

```bash
npm run deploy
```

出力される URL（例: `https://choiemu-event-bot.<account>.workers.dev`）を控える。

## 7. Discord 側の設定

- Developer Portal → アプリ → **Interactions Endpoint URL** に
  `https://<worker-url>/interactions` を設定（保存時に Discord が PING 検証を行う）。
- Bot をサーバーに招待（メッセージ送信・DM 権限）。

## 8. 既存データの移行（Google Sheets から / 任意）

旧 Sheets 運用からの移行時のみ。`.env` に `GOOGLE_SPREADSHEET_ID` と
`GOOGLE_SERVICE_ACCOUNT_JSON` を設定して:

```bash
npm run migrate-from-sheets    # scripts/seed.sql を生成
wrangler d1 execute choiemu-event-bot-db --local  --file=scripts/seed.sql   # 検証
wrangler d1 execute choiemu-event-bot-db --remote --file=scripts/seed.sql   # 本番反映
```

## 9. 設定投入・管理 UI

- ブラウザで `https://<worker-url>/` を開き、`ADMIN_TOKEN` を入力。
- **設定**タブで開催曜日・時刻・募集日数などを入力（移行した場合は反映済み）。
- **メンバーマスタ**タブでメンバーを管理。**出欠記録**タブで履歴を閲覧。

## 10. ローカル開発

```bash
cp .dev.vars.example .dev.vars   # 実値を設定（.dev.vars は gitignore 済み）
npm run db:migrate:local
npm run dev                      # wrangler dev（ローカル D1）
```

Discord のインタラクションをローカル検証する場合:

```bash
cloudflared tunnel --url http://localhost:8787
```

表示された公開 URL の `/interactions` を、**本番とは別の「テスト用 Discord アプリ」**の
Interaction Endpoint に設定して検証する（本番に影響しない）。

## 11. テスト

```bash
npm test          # vitest（D1 を含む）
npm run typecheck # 型チェック
```

---

## 補足

- **cron**: `wrangler.toml` の `crons = ["0 12 * * *"]` は **UTC**。JST 21:00 に相当。
  通知時刻を変えたい場合はこの cron 式を編集（`Notification_Time` 設定は現状未使用）。
- **無料枠**: Workers 10万req/日、サブリクエスト 50回/起動。DM はチャンネル ID をキャッシュして
  消費を抑えている（20名規模で余裕）。
- 詳細な設計判断は [`docs/cloudflare-migration.md`](./cloudflare-migration.md) を参照。
