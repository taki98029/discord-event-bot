# CLAUDE.md

## プロジェクト構成

Cloudflare Workers + D1 で稼働する Discord イベント出欠/勤怠Bot（`discord-event-bot`）。実装は `src/`（Workers版）、管理UIは `ui/`。

旧Vercel + Google Sheets 版（`api/`・`lib/`・`vercel.json`）からの本番カットオーバーは 2026-06-19 に完了し、旧版はリポジトリから撤去済み（必要時は git 履歴で参照可）。

## 本番 Choiemu チャンネルへの操作

本番 Choiemu サーバー／チャンネルに影響が及びうる操作は、実行前に必ずユーザーへ明示的に許可を取ること。

特に以下は本番へ到達しうるため要注意（model A: 2026-06-27〜）:
- **`npm run deploy:cli` ＝ 本番デプロイの唯一の経路（手動）**。本番 D1 にマイグレーション適用→本番 Worker へデプロイする。**毎回ユーザー許可必須**。
- **`git push origin main` は ②staging のみ auto-deploy**（Workers Builds が `npm run deploy:staging` 実行）。本番には飛ばない設計（本番 Workers Builds は Builds disabled）。**ただし本番 Workers Builds の Builds が誤って有効に戻ると main push が本番に飛ぶ事故になる**ため、dashboard 設定の状態は折に触れ確認すること。
- ローカル `wrangler deploy` 系（素の `npm run deploy` を `wrangler.jsonc`/`wrangler.local.jsonc` どちらで叩いても）も本番到達しうる。詳細は `.claude/rules/repo-and-environments.md`。
- `wrangler dev` / `wrangler dev --test-scheduled`（v4 は `.env` を自動読込し、本番 `DISCORD_BOT_TOKEN` / `DISCORD_CHANNEL_ID` が使われると本番チャンネルへ投稿する）
- 本番 Discord アプリのトークン・チャンネルID・Interaction Endpoint を伴う実行・設定変更
- 本番 Discord へのメッセージ送信・DM・スラッシュコマンド登録

ローカル検証は `.dev.vars`（テスト用アプリ＋ダミーサーバーの値のみ）が存在する前提で行う。本番値が混入する恐れがある場合は実行しない。

## 開発・配信・更新フロー

- 開発／デプロイ／配信・更新の必須ルールは `.claude/rules/dev-and-release.md`（`package.json`・`migrations/`・`src/` 等の関連ファイル編集時に自動ロード）。
- リポジトリ/環境/デプロイ構造（2リポジトリ・3層環境・**push=自動デプロイ**の対応）は `.claude/rules/repo-and-environments.md`（`wrangler*`/`package.json`/`migrations`/`src`/`ui`/`.github` 操作時に自動ロード）。
- 手順の詳細は `docs/dev/dev-and-release-flow.md`、設計判断の根拠は `docs/dev/adr/0011-distribution-and-update-model.md` を参照。
- 特に重要: `npm run deploy:cli` は **本番デプロイの唯一の経路（model A）**。本番D1へマイグレーションを適用してからデプロイする（本番Choiemu操作・要事前許可）。
