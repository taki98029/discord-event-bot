# CLAUDE.md

## プロジェクト構成

Cloudflare Workers + D1 で稼働する Discord イベント出欠/勤怠Bot（`discord-event-bot`）。実装は `src/`（Workers版）、管理UIは `ui/`。

旧Vercel + Google Sheets 版（`api/`・`lib/`・`vercel.json`）からの本番カットオーバーは 2026-06-19 に完了し、旧版はリポジトリから撤去済み（必要時は git 履歴で参照可）。

## 本番 Choiemu チャンネルへの操作

本番 Choiemu サーバー／チャンネルに影響が及びうる操作は、実行前に必ずユーザーへ明示的に許可を取ること。

特に以下は本番へ到達しうるため要注意:
- `wrangler dev` / `wrangler dev --test-scheduled`（v4 は `.env` を自動読込し、本番 `DISCORD_BOT_TOKEN` / `DISCORD_CHANNEL_ID` が使われると本番チャンネルへ投稿する）
- 本番 Discord アプリのトークン・チャンネルID・Interaction Endpoint を伴う実行・設定変更
- 本番 Discord へのメッセージ送信・DM・スラッシュコマンド登録

ローカル検証は `.dev.vars`（テスト用アプリ＋ダミーサーバーの値のみ）が存在する前提で行う。本番値が混入する恐れがある場合は実行しない。

## 開発・配信・更新フロー

- 開発／デプロイ／配信・更新の必須ルールは `.claude/rules/dev-and-release.md`（`package.json`・`migrations/`・`src/` 等の関連ファイル編集時に自動ロード）。
- 手順の詳細は `docs/dev-and-release-flow.md`、設計判断の根拠は `docs/adr/0011-distribution-and-update-model.md` を参照。
- 特に重要: `npm run deploy` は本番D1へマイグレーションを適用してからデプロイする（本番Choiemu操作・要事前許可）。
