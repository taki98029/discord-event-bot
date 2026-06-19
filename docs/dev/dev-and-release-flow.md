# 開発・配信・更新フロー

本書は `discord-event-bot`（Cloudflare Workers + D1 で稼働する汎用 Discord イベント出欠/勤怠 Bot）の、開発・配信・更新の3フローを通しで解説する詳細ランブックである。要約版のルール（守るべき要点の箇条書き）は `.claude/rules/dev-and-release.md` にあり、本書はその**詳細手順**を担う。なぜこの配信・更新モデルを採用したのかという**決定の根拠**は `docs/dev/adr/0011-distribution-and-update-model.md` に記録している。本書とルール・ADR で用語と表現は揃えてある。

リポジトリ構成は、実装が `src/`、管理 UI が `ui/`、スキーマのマイグレーションが `migrations/`、配布アシスタント（利用者向けセットアップページ）が `setup.html`（リポジトリ直下）である。言語は日本語。

なお非エンジニアの利用者は CLI を使わず、BOOTH で受け取った `setup.html` から「Deploy to Cloudflare」ボタンでセットアップする（[配信フロー](#配信フロー)参照）。更新は自分の GitHub fork で「Sync fork」を押すだけで完結する（CLI 不要・Workers Builds が自動再デプロイ）。本書は**保守者／開発者が CLI で環境を立ち上げる**ための手順書である。データモデル（Server ＞ Notification → Segment ＞ Occurrence）の用語は [`CONTEXT.md`](CONTEXT.md)、設計は [`docs/dev/adr/`](adr) と [`docs/dev/IMPLEMENTATION-CONTRACT.md`](IMPLEMENTATION-CONTRACT.md) を参照。言語=日本語固定／時刻=JST固定／マルチサーバー（テナント分離なし・単一 `ADMIN_TOKEN`）。

---

## 初回CLIセットアップ（開発者向け）

開発者が手元から CLI で環境を立ち上げ、初回デプロイするまでのブートストラップ手順。ここでは初回構築に必要なステップに絞る。マイグレーションの追記ルール・`.dev.vars` の安全モデル・デプロイの本番挙動など**継続的な運用**は本書の各セクションに委ねるので、該当箇所への内部リンクをたどること。

### 0. 前提

- Node.js 18 以上（`package.json` の `engines` は `>=18.0.0`）。
- **GitHub アカウント**（fork を作成し、Sync fork で更新を受け取るため。公開リポジトリは Deploy ボタンの動力源で廃止不可）。
- Cloudflare アカウント（無料枠で可）。
- Discord アプリ（Developer Portal）— Bot Token / Application ID / Public Key を取得済みであること。

登録が必要な外部サービスは **Discord・Cloudflare・GitHub の 3 つ**で、いずれも無料枠で動作する。

### 1. リポジトリ取得・依存インストール

```bash
git clone <this-repo> discord-event-bot
cd discord-event-bot
npm install
npm install -g wrangler   # CLI 未導入の場合のみ（package.json の devDependencies にも含まれるため npx でも可）
wrangler login            # ブラウザで Cloudflare にログイン
```

### 2. D1 データベース作成

```bash
wrangler d1 create choiemu-event-bot-db   # 名前は任意
```

出力された `database_id` を **`wrangler.toml` の `[[d1_databases]]` の `database_id`** に貼り付ける。`[[d1_databases]]` の **バインディング名は `DB`** のままにすること（マイグレーション・デプロイのスクリプトがバインディング名 `DB` を前提にしている。理由は[バインディング名 DB を指定する理由](#バインディング名-db-を指定する理由issue-13632--pr-14275)を参照）。

### 3. スキーマ適用（初回マイグレーション）

```bash
npm run db:migrate:local    # = wrangler d1 migrations apply DB --local（ローカル開発用 D1）
npm run db:migrate:remote   # = wrangler d1 migrations apply DB --remote（本番 D1。本番操作・要ユーザー許可）
```

`migrations/` の連番を順に適用し、`d1_migrations` テーブルで適用済みが管理される。マイグレーションの追記・編集ルールは[マイグレーション追記手順](#マイグレーション追記手順)を、`db:migrate:remote` が本番 D1 を触ることについては[npm run deploy の本番マイグレーション挙動](#npm-run-deploy-の本番マイグレーション挙動要ユーザー許可)を参照（後述の `npm run deploy` が `db:migrate:remote` を内包するため、初回デプロイだけなら手動の `db:migrate:remote` は省略してもよい）。

### 4. シークレット設定（4つ）

```bash
wrangler secret put DISCORD_PUBLIC_KEY
wrangler secret put DISCORD_APPLICATION_ID
wrangler secret put DISCORD_BOT_TOKEN
wrangler secret put ADMIN_TOKEN          # 管理UIのパスワード。例: openssl rand -hex 32 で生成
```

設定するシークレットはこの **4つだけ**（`.dev.vars.example` のキーと一致）。旧版の `DISCORD_CHANNEL_ID` は**廃止済み**で、投稿チャンネルは Notification ごとに管理 UI で設定する。

### 5. スラッシュコマンド登録

`.env` に `DISCORD_BOT_TOKEN` と `DISCORD_APPLICATION_ID`（テスト用ギルドに限定登録する場合は `DISCORD_GUILD_ID` も）を入れて実行する:

```bash
npm run register-commands   # = node scripts/register-commands.js
```

登録されるコマンド: `/recruit` `/assign`（ともに `notification_id` 指定）／ `/pause` `/resume`（`user` ＋任意 `segment_id`）／ `/members`（任意 `segment_id`）。

### 6. 初回デプロイ

```bash
npm run deploy   # = npm run db:migrate:remote && wrangler deploy
```

`npm run deploy` は**本番 D1 へマイグレーションを適用してからデプロイ**する。本番 Choiemu 操作にあたるため、実行前に必ずユーザーの明示的な許可を得ること（詳細は[npm run deploy の本番マイグレーション挙動](#npm-run-deploy-の本番マイグレーション挙動要ユーザー許可)）。出力される URL（例 `https://discord-event-bot.<account>.workers.dev`）を控える。

### 7. Discord 側の設定

- Developer Portal → アプリ → **Interactions Endpoint URL** に `https://<worker-url>/interactions` を設定（保存時に Discord が PING 検証）。
- Developer Portal → **Bot → Privileged Gateway Intents → Server Members Intent を有効化**（管理 UI のメンバーピッカーが参加者一覧を取得するため・[ADR 0006](adr/0006-discord-as-source-of-truth.md)）。
- Bot をサーバーに招待する（**`bot` ＋ `applications.commands` の両スコープ**。メッセージ送信・DM 権限）。

### 8. 管理 UI で初期設定

ブラウザで `https://<worker-url>/` を開き `ADMIN_TOKEN` を入力。最初に**管理するサーバーを選択**（bot の参加サーバーから自動取得）し、Segment（メンバー区分）→ Notification（通知）の順に作成する。各項目の意味は管理 UI 上で確認できる。

### 9. ローカル開発で回す

```bash
cp .dev.vars.example .dev.vars   # 実値を設定（.dev.vars は gitignore 済み）
npm run db:migrate:local
npm run dev                      # = wrangler dev（ローカル D1）
```

`.dev.vars` には**テスト用 Discord アプリ＋ダミーサーバーの値のみ**を置く。本番値の混入は厳禁（`wrangler` v4 は `.env` を自動読込し、本番値が紛れ込むと本番チャンネルへ投稿しうる）。安全モデルの詳細は[.dev.vars の安全モデル](#dev-vars-の安全モデル)を参照。

Discord インタラクションのローカル検証は、cloudflared トンネル経由で**本番とは別のテスト用 Discord アプリ**の Interaction Endpoint に向ける:

```bash
cloudflared tunnel --url http://localhost:8787
```

ただし UI を含む仕上げ検証は `wrangler dev` ではなく**デプロイ済みテスト Worker** で行う方針である（[仕上げ検証はデプロイ済みテスト Worker で](#仕上げ検証はデプロイ済みテスト-worker-でadr-0008)）。

### 10. テスト

```bash
npm test          # = vitest run（D1 / RRULE を含む密閉検証）
npm run typecheck # = tsc --noEmit
```

ローカル検証の詳細は[ローカル検証（npm test / typecheck）](#ローカル検証npm-test--typecheck)を参照。

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

- **BOOTH ＝入口**。VRChat 層になじみ深い配布チャネルとして、利用者が最初に触れる場所。**配布物は `setup.html` 単体**（下記「配布物の定義」参照）。
- **公開 GitHub リポジトリ ＝基盤**。「Deploy to Cloudflare」ボタンの動力源。

### GitHub を消せない理由

- 「Deploy to Cloudflare」ボタンは**公開 git リポジトリを参照**して動く。BOOTH は git ホスティングではないため、ボタンの参照先になれない。
- したがって公開 GitHub リポジトリは**廃止できない**。ただし利用者は GitHub の UI を直接触る必要はなく、BOOTH で受け取った `setup.html` 経由でデプロイを進める。

### 配布物の定義（唯一の正）

- **BOOTH 配布物 = `setup.html` 単体のみ**。`setup.html` は自己完結 HTML（画像・外部依存なし）なので **zip すら不要**で、ファイル 1 つをそのまま配布できる。
- 配布物を増やす（例: 補足 PDF を添える）場合は、**必ずこの節と `.claude/rules/dev-and-release.md` の定義を同時に更新**してから増やす。ここを配布内容の唯一の正とする。
- `setup.html` は、`ADMIN_TOKEN` 用のパスワード生成や、デプロイ手順への導線を提供する（`package.json` の `cloudflare.bindings` 説明文と対応）。
- 利用者が必要とするソース一式は **Deploy ボタン経由で公開リポジトリから取得**されるため、配布物にソース（`src/` 等）を同梱する必要はない。

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
