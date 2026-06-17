# discord-event-bot

Discord と連携し、繰り返し/単発イベントの **出欠確認・リマインド・参加ノルマ管理** を自動化する Bot。
1 デプロイで**複数の Discord サーバー**を管理でき、専用の **管理 UI** から設定・メンバー編集ができます。
登録が必要なサービスは **Discord と Cloudflare の 2 つだけ**、完全無料枠で自己ホストできます。

> **非エンジニアの方へ**: 下の「Deploy to Cloudflare」ボタンと、画面の案内に沿った初期設定だけで動かせます。
> ターミナル操作は不要です。詳しい手順は **[セットアップガイド（日本語・画像付き）](docs/setup-guide-ja.md)** を参照してください。

## 🚀 かんたんデプロイ（ターミナル不要）

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/taki98029/discord-event-bot)

1. **Discord アプリを作る** … [Discord Developer Portal](https://discord.com/developers/applications) で「New Application」。
   `Public Key` / `Application ID` / `Bot Token` を控えます（取得場所は [ガイド](docs/setup-guide-ja.md) に画像付きで掲載）。
2. **上の「Deploy to Cloudflare」ボタン** … Cloudflare にログイン（無料登録）し、GitHub 連携してデプロイ。
   D1 データベースは自動作成されます。
3. **4 つのシークレットを入力** … Cloudflare の管理画面で `DISCORD_PUBLIC_KEY` / `DISCORD_APPLICATION_ID` /
   `DISCORD_BOT_TOKEN` / `ADMIN_TOKEN`（管理画面のパスワード・自分で決めた長い文字列）を設定。
4. **管理画面を開く** … デプロイ先 URL（`https://＜あなたのWorker＞.workers.dev/`）にアクセスし、
   `ADMIN_TOKEN` でログイン。画面の **セットアップウィザード**が次を案内します:
   - 「**コマンドを登録**」ボタン（スラッシュコマンドを自動登録・ターミナル不要）
   - **Interaction Endpoint URL** をコピーして Discord に貼り付け＋ **Server Members Intent** を ON
   - サーバー選択 → メンバー区分 → 通知 → メンバー登録

## 🏗️ アーキテクチャ

```
Discord ──▶ Cloudflare Worker (1 デプロイで複数サーバー)
              ├─ POST /interactions   スラッシュコマンド / ボタン（Ed25519 署名検証）
              ├─ /api/admin/*         管理 API（ADMIN_TOKEN 認証）
              ├─ /* (静的)            管理 UI（SPA・同梱配信）
              └─ scheduled()          日次 cron（募集/リマインド/ノルマ）
                     │ D1 binding
                     ▼
              Cloudflare D1 (segments / members / notifications / occurrences / responses / assignments)
```

## ✨ 機能

- **📅 イベント募集**: 指定日数前に自動で募集メッセージを送信（メンション対象を設定可能）
- **🗓 単発イベントの複数候補日**: 候補日を複数登録 → メンバーが候補日ごとに出欠回答 → 集計を見て主催者が開催日を確定
- **🔘 ボタン操作**: 参加/不参加/未定をワンクリック回答（チャンネル・DM 両対応）。未登録者は自動登録
- **⏰ リマインド**: 未回答者・未定者へ個別 DM（休止中メンバーは除外）
- **📊 ノルマ確認**: 参加間隔が空いたメンバーへ DM（休止中メンバーは除外）
- **👀 状況確認**: `📊 状況確認` ボタンでリアルタイムの参加状況を表示
- **💬 スラッシュコマンド**（管理者用）: `/recruit` `/assign` `/pause` `/resume` `/members`
- **🖥 管理 UI**: サーバー選択 → 通知・メンバー区分・回答履歴をブラウザから編集/閲覧（トークン認証）

## 📁 プロジェクト構成

```
src/
  index.ts          Worker 入口（fetch + scheduled）
  interactions/     Discord Interaction（コマンド/ボタン・署名検証）
  cron/             日次チェック（募集/リマインド/ノルマ）
  admin/            管理 API（トークン認証）・セットアップ支援
  db/               D1 データ層（segments / members / notifications / occurrences / responses / assignments）
  discord/          Discord REST（メッセージ/DM）・コマンド定義（commands.json）
  lib/date.ts       JST 日付計算
ui/                 管理 SPA（静的アセット）
migrations/         D1 スキーマ
scripts/            コマンド登録（CLI フォールバック）
tests/              vitest（D1 含む）
```

## 🛠 開発者向け（CLI）

ローカル開発や CLI でのデプロイを行う場合:

```bash
npm install && wrangler login
wrangler d1 create discord-event-bot-db   # 出力された database_id を wrangler.toml に記入
npm run db:migrate:remote                 # スキーマ適用
wrangler secret put DISCORD_PUBLIC_KEY    # 4 つのシークレットを設定
wrangler secret put DISCORD_APPLICATION_ID
wrangler secret put DISCORD_BOT_TOKEN
wrangler secret put ADMIN_TOKEN
npm run deploy                            # デプロイ
# スラッシュコマンドは管理画面のボタンで登録できます（CLI なら npm run register-commands）
```

```bash
npm run dev          # wrangler dev（ローカル D1）
npm test             # vitest
npm run typecheck    # 型チェック
```

> ⚠️ `wrangler dev` はローカルの `.env` を自動で読み込みます。本番トークンを誤って使わないよう、
> ローカル検証用の値は `.dev.vars`（テスト用アプリ＋ダミーサーバー）に入れてください。

## ⚙️ シークレット

「Deploy to Cloudflare」では Cloudflare 管理画面で、CLI では `wrangler secret put`（本番）/ `.dev.vars`（ローカル）で設定:

| 名前 | 説明 | 取得場所 |
|-------|------|---------|
| `DISCORD_PUBLIC_KEY` | 署名検証用の公開鍵 | Discord Developer Portal → General Information |
| `DISCORD_APPLICATION_ID` | アプリ ID（コマンド登録用） | 同上 |
| `DISCORD_BOT_TOKEN` | Bot のトークン | Discord Developer Portal → Bot |
| `ADMIN_TOKEN` | 管理 UI / API のパスワード（自分で決めた長い文字列） | 自分で生成 |

> 投稿チャンネルは通知（Notification）ごとに管理 UI で設定するため、単一の `DISCORD_CHANNEL_ID` は廃止されています。
> メンバーピッカー（参加者一覧の取得）には Discord の **Server Members Intent**（特権）の有効化が必要です。

## 🕐 Cron

`wrangler.toml` の `crons = ["0 12 * * *"]`（**UTC** = JST 21:00）に日次チェックを実行。

## 📚 ドキュメント

- [docs/setup-guide-ja.md](docs/setup-guide-ja.md) — **非エンジニア向けセットアップガイド（推奨）**
- [docs/SETUP-cloudflare.md](docs/SETUP-cloudflare.md) — CLI でのセットアップ手順
- [docs/cloudflare-migration.md](docs/cloudflare-migration.md) — 設計ドキュメント / 決定事項

## 📜 ライセンス

[MIT](LICENSE)
