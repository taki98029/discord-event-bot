# 開発・配信・更新フロー

本書は `discord-event-bot`（Cloudflare Workers + D1 で稼働する汎用 Discord イベント出欠/勤怠 Bot）の、開発・配信・更新の3フローを通しで解説する詳細ランブックである。要約版のルール（守るべき要点の箇条書き）は `.claude/rules/dev-and-release.md` にあり、本書はその**詳細手順**を担う。なぜこの配信・更新モデルを採用したのかという**決定の根拠**は `docs/adr/0011-distribution-and-update-model.md` に記録している。本書とルール・ADR で用語と表現は揃えてある。

リポジトリ構成は、実装が `src/`、管理 UI が `ui/`、スキーマのマイグレーションが `migrations/`、配布アシスタント（利用者向けセットアップページ）が `setup.html`（リポジトリ直下）である。言語は日本語。

---

## 開発フロー

### ブランチ運用

- **`main` への直コミットは禁止**。変更は必ずブランチを切って行い、レビュー・マージを経て `main` に入れる。

### マイグレーション追記手順

- スキーマ変更は `migrations/` に**新しい連番ファイルを追加**する形で行う。
- **既存のマイグレーションは絶対に編集しない**。理由: マイグレーションは配布済みの各利用者環境で順番に適用される。既存ファイルを後から書き換えると、すでに適用済みの環境との間でスキーマが不整合になり、再現不能な障害を生む。適用済みかどうかは Cloudflare D1 の `d1_migrations` テーブルで管理される（一度適用された連番は二度と再適用されない）ため、過去ファイルの改変は適用済み環境に届かず、未適用環境とだけ食い違う。
- 現状の最新マイグレーションは `0009`（`migrations/0009_notification_presentation.sql`）。次の変更は `0010_*` として追加する。

### ローカル検証（npm test / typecheck）

- ロジックの密閉検証はローカルで行う。

  - `npm test` … vitest（`@cloudflare/vitest-pool-workers`・ローカル D1・Discord 非依存）でバックエンドを密閉検証する。
  - `npm run typecheck` … `tsc --noEmit` で型を検証する。

- ローカル D1 にマイグレーションを当てたい場合は `npm run db:migrate:local`（`wrangler d1 migrations apply DB --local`）を使う。

### .dev.vars の安全モデル

- `wrangler dev` を使う場合、シークレットは `.dev.vars` から読む。`.dev.vars` には**テスト用 Discord アプリ＋ダミーサーバーの値のみ**を置く。
- **本番値の混入は厳禁**。`wrangler`（v4）は `.env` を自動読込し、本番 `DISCORD_BOT_TOKEN` / チャンネル ID が紛れ込むと本番チャンネルへ投稿しうる（[CLAUDE.md](../CLAUDE.md) / [ADR 0008](adr/0008-verify-on-deployed-test-worker.md)）。本番値が混入する恐れがある場合は `wrangler dev` を実行しない。

### 仕上げ検証はデプロイ済みテスト Worker で（ADR 0008）

- 管理画面・通知フォームなどの UI を含む仕上げ検証は、ローカルの `wrangler dev` ではなく、**デプロイ済みのテスト Worker**（テスト用 Discord アプリ＋ダミーサーバーに接続・実 Choiemu ではない）に対して行う（[ADR 0008](adr/0008-verify-on-deployed-test-worker.md)）。
- 回し方は「コード変更 → `wrangler deploy`（テスト機）→ デプロイ済み URL へ Playwright(MCP)」。`--test-scheduled` は使わず、実 Choiemu サーバーには一切向けない。
- この方式により、ローカル検証で本番値が混入する構造的な事故リスクを避ける。フィードバックループが毎回デプロイで遅くなるトレードオフは受け入れる。

### version 更新＋リリースノート

- マージ後、`package.json` の `version` を **semver** で更新する。
- 日本語の**リリースノート**を書く。書式の要点:

  - そのリリースで何が変わったかを日本語で簡潔に列挙する。
  - **「DB変更あり／なし」を必ず明記する**（マイグレーションを追加したか否か）。利用者の更新時にスキーマ適用が走るかどうかの判断材料になる。

---

## 配信フロー

### BOOTH 入口と GitHub 基盤の役割分担

- **BOOTH ＝入口**。VRChat 層になじみ深い配布チャネルとして、利用者が最初に触れる場所。配布物は `setup.html` 等の小さな一式。
- **公開 GitHub リポジトリ ＝基盤**。「Deploy to Cloudflare」ボタンの動力源。

### GitHub を消せない理由

- 「Deploy to Cloudflare」ボタンは**公開 git リポジトリを参照**して動く。BOOTH は git ホスティングではないため、ボタンの参照先になれない。
- したがって公開 GitHub リポジトリは**廃止できない**。ただし利用者は GitHub の UI を直接触る必要はなく、BOOTH で受け取った `setup.html` 経由でデプロイを進める。

### 配布物（setup.html 等）

- 配布 zip には `setup.html`（セットアップアシスタント）を中心とした**小さな一式**を入れる。
- `setup.html` は、`ADMIN_TOKEN` 用のパスワード生成や、デプロイ手順への導線を提供する（`package.json` の `cloudflare.bindings` 説明文と対応）。

### zip 衛生

- 配布 zip には次を**絶対に含めない**:

  - `.env`
  - `.dev.vars`
  - `node_modules`
  - 実トークン（Bot Token などのシークレット）

- 配布前に zip の中身を点検し、上記が混入していないことを確認する。

### ソース公開による信頼性

- 本 Bot は利用者の **Bot Token を預かる**性質を持つ。だからこそ、ソースが公開 GitHub で誰でも閲覧できる方が、利用者は「何をしているか確認できる」という安心を得られる。ソース公開は信頼性の根拠そのものである。

---

## 更新フロー

利用者は CLI を一切使わずに更新できる。流れは次のとおり。

```
maintainer:  修正を main にマージ ＋ リリース（version 更新 ＋ 日本語リリースノート）
                                   │
                                   ▼
利用者:       自分の GitHub fork で「Sync fork」を押す
                                   │
                                   ▼
Cloudflare Workers Builds:  fork の本番ブランチへの push を検知して自動で再ビルド
                                   │
                                   ▼
deploy スクリプト（npm run deploy）が自動実行:
    1. npm run db:migrate:remote  →  wrangler d1 migrations apply DB --remote（マイグレーション適用）
    2. wrangler deploy            →  デプロイ
                                   │
                                   ▼
完了（利用者の操作は「Sync fork」ボタン1回のみ・CLI 不要）
```

箇条書きで整理すると:

- **maintainer 側**: 修正を `main` にマージし、リリースする（`package.json` の `version` 更新＋日本語リリースノート、「DB変更あり／なし」を明記）。
- **利用者側**: 自分の GitHub fork で「**Sync fork**」を押すだけ。
- **Cloudflare Workers Builds**: 本番ブランチへの push ごとに `deploy` コマンドを自動実行する（公式仕様）。「Sync fork」による push がトリガーになる。
- **deploy スクリプト**: `npm run deploy`（`"deploy": "npm run db:migrate:remote && wrangler deploy"`）が、**マイグレーション適用 → デプロイ**を自動で順に実行する。
- 利用者に **CLI 操作は不要**。
- 重要な修正のみ告知する（毎リリースを逐一アナウンスはしない）。「DB変更あり／なし」の記載が、利用者が更新の重みを判断する材料になる。

---

## 注意点

### npm run deploy の本番マイグレーション挙動（要ユーザー許可）

- `npm run deploy` は `"deploy": "npm run db:migrate:remote && wrangler deploy"` であり、**本番 D1 へマイグレーションを適用してからデプロイする**。
- `db:migrate:remote` は `wrangler d1 migrations apply DB --remote`。`--remote` は本番（リモート）D1 を対象とする。
- これは本番 Choiemu 操作にあたるため、[CLAUDE.md](../CLAUDE.md) のルールに従い、**実行前に必ずユーザーの明示的な許可を得る**こと。
- 開発中にスキーマを試すときは、本番ではなく `npm run db:migrate:local`（`--local`）を使う。

### バインディング名 DB を指定する理由（issue #13632 → PR #14275）

- マイグレーションコマンドは「データベース名」ではなく「**バインディング名 `DB`**」で指定している（`wrangler d1 migrations apply DB --remote` / `--local`）。
- 理由: 「Deploy to Cloudflare」ボタンで配布すると、各利用者の D1 は**別名で自動生成**される。データベース名で指定すると利用者ごとに名前が異なって動かないが、**バインディング名は全環境で `DB` に揃う**ため、同じスクリプトがそのまま動く。これは Cloudflare 公式推奨の方式で、関連 issue #13632 は PR #14275 で解決済み。

### Deploy ボタンのシークレット入力

- 「Deploy to Cloudflare」ボタンは、`.dev.vars.example` のシークレット名（4つ: `DISCORD_PUBLIC_KEY` / `DISCORD_APPLICATION_ID` / `DISCORD_BOT_TOKEN` / `ADMIN_TOKEN`）と、`package.json` の `cloudflare.bindings` 説明文をもとに、デプロイ時に**シークレット入力欄**を出す。利用者はここに各値を貼り付けてデプロイする。

### Deploy ボタンの実挙動は初回公開デプロイで最終確認

- Deploy ボタン経由でのマイグレーション自動適用の**最終的な実挙動**は、リポジトリを公開して**初回の実デプロイ**で確認する。
- 設定は公式どおりで、ローカルでのバインディング解決（バインディング名 `DB` で当たること）は確認済み。残るのは「配布先の自動生成 D1 に対して初回デプロイ時にマイグレーションが正しく走るか」の実地確認のみで、これは初回公開デプロイをもって締める。

---

## 関連リンク

- [ADR 0008: 検証はデプロイ済みテスト Worker で行う](adr/0008-verify-on-deployed-test-worker.md)
- [ADR 0011: 配信・更新モデル](adr/0011-distribution-and-update-model.md)
- [.claude/rules/dev-and-release.md（要約ルール）](../.claude/rules/dev-and-release.md)
