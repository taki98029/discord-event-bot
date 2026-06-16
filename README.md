# ChoiemuEventBot

Discord と連携し、週次イベントの **出欠確認・リマインド・参加ノルマ管理** を自動化する Bot。
非エンジニアでも運用できるよう、**専用の管理 UI** から設定・メンバーを編集できます。

> **v6.0**: ホスティングを **Vercel + Google Sheets** から **Cloudflare Workers + D1** へ移行。
> 登録が必要なサービスは **Discord と Cloudflare の 2 つだけ**、完全無料枠で自己ホストできます。
> （旧 Vercel 版のコードは移行期間中 `api/` `lib/` に併存。カットオーバー後に撤去します。）

## 🏗️ アーキテクチャ

```
Discord ──▶ Cloudflare Worker (単一デプロイ)
              ├─ POST /interactions   スラッシュコマンド / ボタン（Ed25519 署名検証）
              ├─ /api/admin/*         管理 API（ADMIN_TOKEN 認証）
              ├─ /* (静的)            管理 UI（SPA・同梱配信）
              └─ scheduled()          日次 cron（募集/リマインド/ノルマ）
                     │ D1 binding
                     ▼
              Cloudflare D1 (config / members / event_log)
```

## ✨ 機能

- **📅 イベント募集**: 指定日数前に自動で募集メッセージを送信（メンション対象を設定可能）
- **🔘 ボタン操作**: 参加/不参加/未定をワンクリック回答（チャンネル・DM 両対応）。未登録者は自動登録
- **⏰ リマインド**: 未回答者・未定者へ個別 DM（休止中メンバーは除外）
- **📊 ノルマ確認**: 参加間隔が空いたメンバーへ DM（休止中メンバーは除外）
- **👀 状況確認**: `📊 状況確認` ボタンでリアルタイムの参加状況を表示
- **💬 スラッシュコマンド**（管理者用）: `/recruit` `/pause` `/resume` `/members` `/addmember`
- **🖥 管理 UI**: 設定・メンバーマスタ・出欠記録をブラウザから編集/閲覧（トークン認証）

## 📁 プロジェクト構成

```
src/
  index.ts          Worker 入口（fetch + scheduled）
  interactions/     Discord Interaction（コマンド/ボタン・署名検証）
  cron/             日次チェック
  admin/            管理 API（トークン認証）
  db/               D1 データ層（config / members / event_log）
  discord/          Discord REST（メッセージ/DM）
  lib/date.ts       JST 日付計算
ui/                 管理 SPA（静的アセット）
migrations/         D1 スキーマ
scripts/            移行（Sheets→D1）・コマンド登録
tests/              vitest（D1 含む）
```

## 🚀 セットアップ

詳細は [docs/SETUP-cloudflare.md](docs/SETUP-cloudflare.md) を参照。概略:

```bash
npm install && wrangler login
wrangler d1 create choiemu-event-bot-db   # database_id を wrangler.toml に記入
npm run db:migrate:remote                 # スキーマ適用
wrangler secret put ...                   # 各シークレット設定
npm run register-commands                 # スラッシュコマンド登録
npm run deploy                            # デプロイ
```

## 🛠 開発

```bash
npm run dev          # wrangler dev（ローカル D1）
npm test             # vitest
npm run typecheck    # 型チェック
```

## ⚙️ シークレット

`wrangler secret put`（本番）/ `.dev.vars`（ローカル）で設定:

| 名前 | 説明 |
|-------|------|
| `DISCORD_PUBLIC_KEY` | Discord Application Public Key |
| `DISCORD_APPLICATION_ID` | Application ID（コマンド登録用） |
| `DISCORD_BOT_TOKEN` | Bot Token |
| `DISCORD_CHANNEL_ID` | メッセージ送信先チャンネル ID |
| `ADMIN_TOKEN` | 管理 UI / API のアクセストークン |

## 🕐 Cron

`wrangler.toml` の `crons = ["0 12 * * *"]`（**UTC** = JST 21:00）に日次チェックを実行。

## 📚 ドキュメント

- [docs/SETUP-cloudflare.md](docs/SETUP-cloudflare.md) — セットアップ手順
- [docs/cloudflare-migration.md](docs/cloudflare-migration.md) — 設計ドキュメント / 決定事項

## 📜 ライセンス

[MIT](LICENSE)
