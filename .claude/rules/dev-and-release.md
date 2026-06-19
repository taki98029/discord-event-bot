---
paths:
  - "package.json"
  - "wrangler.toml"
  - "migrations/**"
  - "src/**"
  - "scripts/**"
---

# 開発・配信・更新フローの必須ルール

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
- 配布チャネル: BOOTH＝入口（setup.html 等の小さな一式）。公開GitHubリポジトリ＝「Deploy to Cloudflare」ボタンの動力源で廃止不可（ボタンが公開gitリポジトリを参照するため）。
- 更新: 利用者は自分のfork で「Sync fork」を押すだけ → Cloudflare Workers Builds が push ごとに deploy を実行 → マイグレーション適用＋デプロイが自動。CLI不要。
- リリース時は package.json の version を semver で更新し、日本語リリースノートで「DB変更あり/なし」を明示する。
- zip衛生: 配布zipに `.env` / `.dev.vars` / `node_modules` / 実トークンを絶対に含めない。

詳細は docs/dev-and-release-flow.md、決定の根拠は docs/adr/0011-distribution-and-update-model.md を参照。
