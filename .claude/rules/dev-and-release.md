---
paths:
  - "package.json"
  - "wrangler.toml"
  - "migrations/**"
  - "src/**"
  - "scripts/**"
---

# 開発・配信・更新フローの必須ルール

## 前提
- 利用者が必要とするアカウントは **Discord・Cloudflare・GitHub の 3 つ**（いずれも無料枠）。GitHub は「Deploy to Cloudflare」ボタンの動力源＝公開リポジトリのため廃止不可。利用者は fork の「Sync fork」で更新する。

## 開発
- main へ直コミット禁止。必ずブランチを切る。
- スキーマ変更は `migrations/` に新しい連番ファイルを追加。既存マイグレーションは絶対に編集しない（配布済み環境と不整合になる）。現状の最新は 0009。
- ローカル検証は `.dev.vars`（テスト用Discordアプリ＋ダミーサーバーの値のみ）。本番値の混入は厳禁。`npm test` / `npm run typecheck` を回す。
- 仕上げ検証はデプロイ済みテストWorker（テスト用Discordに接続）で行う（ADR 0008）。

## デプロイ
- `npm run deploy` = `npm run db:migrate:remote && wrangler deploy`。本番D1へマイグレーションを適用してからデプロイする。
- これは本番Choiemu操作にあたる。CLAUDE.md のルールに従い、実行前に必ずユーザー許可を得る。
- マイグレーションはバインディング名 `DB` で指定する（`wrangler d1 migrations apply DB --remote`）。Deployボタン配布時に各利用者のD1が別名で生成されるため、バインディング名で統一する。

## 配信・更新
- 配布チャネル: **BOOTH＝入口**。公開GitHubリポジトリ＝「Deploy to Cloudflare」ボタンの動力源で廃止不可（ボタンが公開gitリポジトリを参照するため）。
- **BOOTH配布物の定義（唯一の正）**: `setup.html` **単体のみ**（自己完結HTMLのためzip不要）。配布物を増やす場合は必ずこの行を更新する。`.env` / `.dev.vars` / `node_modules` / 実トークン / `src/` 等のソースは**絶対に同梱しない**（利用者はDeployボタンで公開リポジトリから取得する）。
- 更新: 利用者は自分の GitHub fork で「Sync fork」を押すだけ → Cloudflare Workers Builds が push ごとに deploy を実行 → マイグレーション適用＋デプロイが自動。利用者は **CLI 不要・GitHub アカウントのみ必須**。
- リリース時は package.json の version を semver で更新し、日本語リリースノートで「DB変更あり/なし」を明示する。
- zip衛生: 配布zipに `.env` / `.dev.vars` / `node_modules` / 実トークンを絶対に含めない。

詳細は docs/dev/dev-and-release-flow.md、決定の根拠は docs/dev/adr/0011-distribution-and-update-model.md を参照。
