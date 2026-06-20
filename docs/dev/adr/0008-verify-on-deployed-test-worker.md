# 検証はデプロイ済みテスト Worker で行う（ローカル wrangler dev を使わない）

管理画面リデザインの UI 検証（Playwright）を、ローカルの `wrangler dev` ではなく、**デプロイ済みの Cloudflare Worker（テスト用 Discord アプリ＋ダミーサーバー接続・実 Choiemu ではない）**に対して行う。

## 背景

[CLAUDE.md](../../CLAUDE.md) のとおり、`wrangler dev`（v4）は `.env` を自動読込し、本番 `DISCORD_BOT_TOKEN` / チャンネル ID が混入すると本番チャンネルへ投稿しうる。ローカル検証の事故リスクを構造的に避けたい。現デプロイ機はテスト Discord サーバーに接続済みで、実 Choiemu には繋がっていない。テスト用アプリ連携の再構築コストが高いという運用上の事情もある。

## 決定

- UI 検証は「コード変更 → `wrangler deploy` → デプロイ済み URL へ Playwright(MCP)」で回す。各画面・通知フォームの条件分岐をスクリーンショットで確認する。
- バックエンドは vitest（`@cloudflare/vitest-pool-workers`・ローカル D1・Discord 非依存）で密閉検証する。
- Playwright は **localhost ではなくデプロイ機**を駆動するが、**実 Choiemu サーバーには一切向けない**。`--test-scheduled` は使わない。
- リデザインの適用に伴い、デプロイ機の remote D1 へ新マイグレーションを適用する（テストデータは作り直し可）。

## トレードオフ

- フィードバックループが遅い（毎回デプロイ）。ローカル即時反映を捨てる。
- ライブ cron はテスト鯖に対して動き続ける（実害なし。静かに保ちたい場合は通知を遠い未来日にする等で回避）。
- Playwright 駆動にはデプロイ機の `ADMIN_TOKEN` が必要（検証フェーズで安全に受け渡す）。
- 代替：`.dev.vars`（テスト専用値のみ）での `wrangler dev` も技術的には可能だが、本番値混入の恐れがある場合は禁止（CLAUDE.md）。任意のテスト用シーム `MOCK_DISCORD` で Discord 依存を切る選択肢も将来の CI 密閉化のために残す。

## 追補（2026-06-20・[ADR 0012](0012-three-tier-parity.md) による改定）

本 ADR の**精神（仕上げ検証はデプロイ済みテスト機で・実 Choiemu には向けない）は維持**するが、その**手段を「ローカル `wrangler deploy`（CLI）」から「GitHub→Cloudflare Workers Builds」へ更新**する（[ADR 0012](0012-three-tier-parity.md)）。

- 検証(②staging)は、`staging` ブランチ（または検証用 fork）を専用の staging Worker に Workers Builds で接続し、テスト用 Discord アプリ＋自動生成 D1 に向ける。デプロイコマンドは `npm run deploy` に設定する。
- これにより本番(③)と**デプロイ機構が完全に一致**し、自動プロビジョニング・マイグレーション・デプロイコマンドの不備を本番に触れず②で検出できる。
- 安全面はむしろ強化される: Workers Builds は Cloudflare CI 上で走り、シークレットはダッシュボード管理（ローカル `.env`／`.dev.vars` を読まない）ため、本 ADR が恐れた**本番値混入による誤投稿の経路自体が消える**。
- 「コード変更 → ローカル `wrangler deploy`（テスト機）→ Playwright(MCP)」という旧手順は、Workers Builds 移行後は「`staging` へ push → 自動デプロイ → デプロイ済み URL へ Playwright(MCP)」に置き換わる。`--test-scheduled` を使わず実 Choiemu に向けない点は不変。
