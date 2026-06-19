# discord-event-bot

Discord と連携し、繰り返し/単発イベントの **出欠確認・リマインド・参加ノルマ管理** を自動化する Bot。
1 デプロイで**複数の Discord サーバー**を管理でき、専用の **管理 UI** から設定・メンバー編集ができます。
登録が必要なサービスは **Discord・Cloudflare・GitHub の 3 つ**（GitHub は「Deploy to Cloudflare」ボタンの動力源＝公開リポジトリの fork に使用）。いずれも完全無料枠で自己ホストできます。

> **非エンジニアの方へ**: BOOTH で配布される **`setup.html` をダウンロードして開くだけ**で、
> 画面の案内に沿って初期設定を進められます（管理パスワードの自動生成・Bot 招待リンクの自動作成・
> コピーボタンつき）。**ターミナル操作は不要**です。

## 🚀 デプロイ

- **非エンジニアの方**: BOOTH で配布される **`setup.html` をダウンロードして開くだけ**。画面の案内に従って設定できます（ターミナル不要）。
- **GitHub から直接使う方**: 下の「Deploy to Cloudflare」ボタンでデプロイできます。D1 は自動作成、デプロイ途中で 4 つのシークレット（`DISCORD_PUBLIC_KEY` / `DISCORD_APPLICATION_ID` / `DISCORD_BOT_TOKEN` / `ADMIN_TOKEN`）を設定します。**ステップ詳細は `setup.html` に委ねています。**

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/taki98029/discord-event-bot)

> 配布は **BOOTH＝入口（`setup.html` を配布）／公開 GitHub＝「Deploy to Cloudflare」ボタンの動力源**（ボタンが公開リポジトリを参照するため廃止不可）という二段構成です。

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

開発・初回 CLI セットアップ・配信/更新フローは **[docs/dev/dev-and-release-flow.md](docs/dev/dev-and-release-flow.md)** を参照（開発者向けの唯一の手順書）。

- `npm run deploy` = `npm run db:migrate:remote && wrangler deploy`（本番 D1 へマイグレーション適用 → デプロイ）。**本番 Choiemu への操作にあたるため、実行前に必ずユーザー許可を得る。**
- マイグレーションはバインディング名 `DB` 指定（`wrangler d1 migrations apply DB --remote`）。配布先の D1 が別名で生成されるため統一。

## ⚙️ シークレット

「Deploy to Cloudflare」では**デプロイ時の入力欄**（または後から Cloudflare 管理画面の Settings → Variables and Secrets）で、CLI では `wrangler secret put`（本番）/ `.dev.vars`（ローカル）で設定:

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

- `setup.html` — **非エンジニア向けセットアップ（BOOTH 配布・ターミナル不要）**
- [docs/dev/dev-and-release-flow.md](docs/dev/dev-and-release-flow.md) — **開発者向け**（開発・初回 CLI セットアップ・配信/更新フロー）
- [docs/dev/IMPLEMENTATION-CONTRACT.md](docs/dev/IMPLEMENTATION-CONTRACT.md) / [docs/dev/adr/](docs/dev/adr/) — 設計ドキュメント / 決定事項（ADR）

## 📜 ライセンス

[MIT](LICENSE)
