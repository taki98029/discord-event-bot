# 開発・配信・更新フロー

本書は `discord-event-bot`（Cloudflare Workers + D1 で稼働する汎用 Discord イベント出欠/勤怠 Bot）の、開発・配信・更新の3フローを通しで解説する詳細ランブックである。要約版のルール（守るべき要点の箇条書き）は `.claude/rules/dev-and-release.md` にあり、本書はその**詳細手順**を担う。なぜこの配信・更新モデルを採用したのかという**決定の根拠**は `docs/dev/adr/0011-distribution-and-update-model.md` に記録している。本書とルール・ADR で用語と表現は揃えてある。

リポジトリ構成は、実装が `src/`、管理 UI が `ui/`、スキーマのマイグレーションが `migrations/`、配布アシスタント（利用者向けセットアップページ）が `setup.html`（リポジトリ直下）である。言語は日本語。

なお非エンジニアの利用者は CLI を使わず、BOOTH で受け取った `setup.html` の案内に沿って**公開リポジトリを Fork → Cloudflare Workers Builds に接続**してセットアップする（[配信フロー](#配信フロー)参照・案B）。更新は自分の GitHub fork で「Sync fork」を押すだけで完結する（CLI 不要・Workers Builds が自動再デプロイ）。本書は**保守者／開発者が CLI で環境を立ち上げる**ための手順書である。データモデル（Server ＞ Notification → Segment ＞ Occurrence）の用語は [`CONTEXT.md`](CONTEXT.md)、設計は [`docs/dev/adr/`](adr) と [`docs/dev/IMPLEMENTATION-CONTRACT.md`](IMPLEMENTATION-CONTRACT.md) を参照。言語=日本語固定／時刻=JST固定／マルチサーバー（テナント分離なし・単一 `ADMIN_TOKEN`）。

---

## 初回CLIセットアップ（開発者向け）

開発者が手元から CLI で環境を立ち上げ、初回デプロイするまでのブートストラップ手順。ここでは初回構築に必要なステップに絞る。マイグレーションの追記ルール・`.dev.vars` の安全モデル・デプロイの本番挙動など**継続的な運用**は本書の各セクションに委ねるので、該当箇所への内部リンクをたどること。

### 0. 前提

- Node.js は `.node-version` で **22.16.0 を固定**（Workers Builds の `npm ci` 整合のため。`package.json` の `engines` 下限は `>=18.0.0`）。
- **GitHub アカウント**（公開リポジトリを fork して Cloudflare Workers Builds に接続し、Sync fork で更新を受け取るため。公開リポジトリは fork 元かつ Sync fork の upstream で廃止不可）。
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

出力された `database_id` は、**配布用の `wrangler.jsonc` ではなく `wrangler.local.jsonc`（gitignore 済み・保守者ローカル専用）の `database_id`** に貼り付ける。配布用 `wrangler.jsonc` の `database_id` は**記載しない（フィールドごと省略する）**こと（省略しておくと、利用者の fork を接続した Workers Builds が利用者のアカウントに D1 を自動生成する。ベタ書きすると自動生成がスキップされ利用者のデプロイが失敗する。理由は[配布用設定は database_id を記載しない](#配布用設定は-database_id-を記載しない)を参照）。`d1_databases` の **バインディング名は `DB`** のままにすること（マイグレーション・デプロイのスクリプトがバインディング名 `DB` を前提にしている。理由は[バインディング名 DB を指定する理由](#バインディング名-db-を指定する理由issue-13632--pr-14275)を参照）。

### 3. スキーマ適用（初回マイグレーション）

```bash
npm run db:migrate:local    # = wrangler d1 migrations apply DB --local（ローカル開発用 D1）
npm run db:migrate:remote   # = wrangler d1 migrations apply DB --remote（本番 D1。本番操作・要ユーザー許可）
```

`migrations/` の連番を順に適用し、`d1_migrations` テーブルで適用済みが管理される。マイグレーションの追記・編集ルールは[マイグレーション追記手順](#マイグレーション追記手順)を、`db:migrate:remote` が本番 D1 を触ることについては[npm run deploy / deploy:cli の本番マイグレーション挙動](#npm-run-deploy--deploycli-の本番マイグレーション挙動要ユーザー許可)を参照（後述の `npm run deploy` が `db:migrate:remote` を内包するため、初回デプロイだけなら手動の `db:migrate:remote` は省略してもよい）。

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

保守者がローカル CLI から自分の本番 D1（実 `database_id`）へデプロイするときは、`wrangler.local.jsonc` を指定する **`deploy:cli`** を使う:

```bash
npm run deploy:cli
# = wrangler d1 migrations apply DB --remote --config wrangler.local.jsonc
#   && wrangler deploy --config wrangler.local.jsonc
```

配布用 `wrangler.jsonc` は `database_id` を記載していないため、素の `npm run deploy`（`--config` 無し）をローカルで実行すると**本番とは別の新しい D1 を自動生成してしまう**（本番 Choiemu データから切り離される）。素の `npm run deploy` は **Workers Builds 側が実行する用**（利用者の fork 接続・開発者の staging/prod）で、ローカルからの本番デプロイには使わない。詳細は[配布用設定は database_id を記載しない](#配布用設定は-database_id-を記載しない)を参照。

`deploy:cli` も**本番 D1 へマイグレーションを適用してからデプロイ**する。本番 Choiemu 操作にあたるため、実行前に必ずユーザーの明示的な許可を得ること（詳細は[npm run deploy / deploy:cli の本番マイグレーション挙動](#npm-run-deploy--deploycli-の本番マイグレーション挙動要ユーザー許可)）。出力される URL（例 `https://discord-event-bot.<account>.workers.dev`）を控える。

> **方針（[ADR 0012](adr/0012-three-tier-parity.md)）**: 本番も検証も GitHub→Cloudflare（Workers Builds）経路に寄せ、ローカルからの CLI リモートデプロイ（`deploy:cli`）は撤去する。**2026-06-20 に本番 Worker（`discord-event-bot`）の Workers Builds 接続が完了し、staging（`discord-event-bot-staging`）も同日にスモークテスト＋シークレット投入＋スラッシュコマンド登録まで完了済み**。`deploy:cli` は緊急時フォールバックとしてしばらく残置し、観察期間を経て撤去予定（タスク P-5）。

### 7. Discord 側の設定

- Developer Portal → アプリ → **Interactions Endpoint URL** に `https://<worker-url>/interactions` を設定（保存時に Discord が PING 検証）。
- Developer Portal → **Bot → Privileged Gateway Intents → Server Members Intent を有効化**（管理 UI のメンバーピッカーが参加者一覧を取得するため・[ADR 0006](adr/0006-member-three-layers.md)）。
- Bot をサーバーに招待する（**`bot` ＋ `applications.commands` の両スコープ**。メッセージ送信・DM 権限）。

### 8. 管理 UI で初期設定

ブラウザで `https://<worker-url>/` を開き `ADMIN_TOKEN` を入力。最初に**管理するサーバーを選択**（bot の参加サーバーから自動取得）し、Segment（メンバー区分）→ Notification（通知）の順に作成する。各項目の意味は管理 UI 上で確認できる。

### 9. ローカル開発で回す

```bash
cp .dev.vars.example .dev.vars   # 実値を設定（.dev.vars は gitignore 済み）
npm run db:migrate:local
npm run dev                      # = wrangler dev（ローカル D1）
```

`.dev.vars` には**テスト用 Discord アプリ＋ダミーサーバーの値のみ**を置く。本番値の混入は厳禁（`wrangler` v4 は `.env` を自動読込し、本番値が紛れ込むと本番チャンネルへ投稿しうる）。安全モデルの詳細は[.dev.vars の安全モデル](#devvars-の安全モデル)を参照。

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
- **公開 GitHub リポジトリ ＝基盤**。利用者が **Fork** して Cloudflare Workers Builds に接続する「fork 元」であり、更新（Sync fork）の upstream でもある（[ADR 0011 追補](adr/0011-distribution-and-update-model.md) の案B）。

### GitHub を消せない理由

- 利用者は公開リポジトリを **Fork** し、その fork を Cloudflare Workers Builds に接続（ダッシュボード **Workers & Pages → Create → Import a repository**）してデプロイする。BOOTH は git ホスティングではないため fork 元になれない。
- 更新は GitHub 純正の **「Sync fork」**（fork の upstream＝公開リポジトリから取り込む）で回す。**fork 元としても upstream としても公開 GitHub リポジトリは廃止できない**。
- 利用者は `setup.html` の案内に沿って **GitHub（Fork・Sync fork）と Cloudflare ダッシュボード**を操作する（いずれも Web・CLI 不要）。
- 補足: 「Deploy to Cloudflare」ボタンは**採用しない**。ボタンは fork ではなく clone を作り、純正「Sync fork」が使えず更新が回らないため（[ADR 0011 追補](adr/0011-distribution-and-update-model.md)）。

### 配布物の定義（唯一の正）

- **BOOTH 配布物 = `setup.html` 単体のみ**。`setup.html` は自己完結 HTML（画像・外部依存なし）なので **zip すら不要**で、ファイル 1 つをそのまま配布できる。
- 配布物を増やす（例: 補足 PDF を添える）場合は、**必ずこの節と `.claude/rules/dev-and-release.md` の定義を同時に更新**してから増やす。ここを配布内容の唯一の正とする。
- `setup.html` は、`ADMIN_TOKEN` 用のパスワード生成や、デプロイ手順への導線を提供する（`package.json` の `cloudflare.bindings` 説明文と対応）。
- 利用者が必要とするソース一式は **fork（公開リポジトリの複製）として利用者の GitHub に入る**ため、配布物にソース（`src/` 等）を同梱する必要はない。

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
    1. wrangler deploy            →  デプロイ（D1 を自動作成し id を wrangler.jsonc に書き戻し）
    2. npm run db:migrate:remote  →  wrangler d1 migrations apply DB --remote（書き戻された id を解決してマイグレーション適用）
                                   │
                                   ▼
完了（利用者の操作は「Sync fork」ボタン1回のみ・CLI 不要）
```

箇条書きで整理すると:

- **maintainer 側**: 修正を `main` にマージし、リリースする（`package.json` の `version` 更新＋日本語リリースノート、「DB変更あり／なし」を明記）。
- **利用者側**: 自分の GitHub fork で「**Sync fork**」を押すだけ。
- **Cloudflare Workers Builds**: 本番ブランチへの push ごとに `deploy` コマンドを自動実行する（公式仕様）。「Sync fork」による push がトリガーになる。
- **deploy スクリプト**: `npm run deploy`（`"deploy": "wrangler deploy && npm run db:migrate:remote"`）が、**デプロイ（D1 自動作成＋id 書き戻し）→ マイグレーション適用**を自動で順に実行する。
- 利用者に **CLI 操作は不要**。
- 重要な修正のみ告知する（毎リリースを逐一アナウンスはしない）。「DB変更あり／なし」の記載が、利用者が更新の重みを判断する材料になる。

---

## 注意点

### 配布用設定は database_id を記載しない

- 配布用 `wrangler.jsonc` の `d1_databases[]` には `database_id` フィールドを**記載しない（省略する）**。Cloudflare の自動プロビジョニング（2025-10-24〜）は「id の無いバインディング＝新規作成」とみなし、利用者の fork を接続した Workers Builds が利用者のアカウントに D1 を自動生成する。実 `database_id` をベタ書きすると、そのリソースは利用者のアカウントに存在しないため自動生成がスキップされ、**利用者のデプロイが失敗する**。
- 自動生成された id の「書き戻し」が `.toml` では行われない（workers-sdk issue #13632）ため、設定ファイルは **`wrangler.jsonc`（JSON 形式）** にしている。
- **保守者の落とし穴**: 同じ `database_id` 省略の設定をローカルから `wrangler deploy` で実行すると、自動プロビジョニングで**本番とは別の D1 を作ってしまう**ように見える点に注意。ただし **2026-06-20 の P-2 実機検証で、Cloudflare の auto-provisioning は「同名（`database_name`）の既存 D1 が同一アカウントに存在すれば、それを再利用してバインドする」挙動を取ることが確認された**（配布用 `wrangler.jsonc` に `database_id` が無く `database_name = "choiemu-event-bot-db"` のみの状態で本番 Worker を Workers Builds に接続したところ、Bindings タブで既存本番 D1 の UUID `f6ff753c-bf29-4eb5-83ec-317631743cfc` がそのまま割り当てられた）。これは workers-sdk PR #14275 の `getDatabaseByNameOrBinding` が control plane API で name→UUID を解決するロジックが deploy 経路にも効くと推認できる（公式 docs は未明文化）。詳細は [ADR 0011 追補](adr/0011-distribution-and-update-model.md) を参照。なお、ローカル CLI から本番 Choiemu へ直接デプロイする緊急時は、実 `database_id` を持つ `wrangler.local.jsonc`（gitignore 済み）を `--config` で指定する **`npm run deploy:cli`** を使う（フォールバック用途・タスク P-5 で観察後に撤去予定）。

### npm run deploy / deploy:cli の本番マイグレーション挙動（要ユーザー許可）

- 素の `npm run deploy`（`"wrangler deploy && npm run db:migrate:remote"`）は **Workers Builds が実行する用**（利用者の fork 接続・開発者の staging/prod）。`database_id` を省略した配布用設定では、まだ存在しない D1 へ先にマイグレーションを当てられないため、**先に `wrangler deploy` で D1 を自動作成し id を `wrangler.jsonc` に書き戻してから、`db:migrate:remote` がその id を解決してマイグレーションを適用する**順番にしている。ローカルから素で実行すると上記のとおり別 D1 を作るため、ローカルからの本番デプロイには使わない。
- 保守者がローカル CLI から本番 Choiemu へデプロイするときは **`npm run deploy:cli`**（`wrangler.local.jsonc` を `--config` 指定）を使う。`deploy:cli` は実 `database_id` を持ち本番 D1 が既に存在するため、従来どおり **本番 D1 へマイグレーションを適用してからデプロイする**（`npm run deploy` とは順番が逆）。
- `--remote` は本番（リモート）D1 を対象とする。これは本番 Choiemu 操作にあたるため、[CLAUDE.md](../CLAUDE.md) のルールに従い、**実行前に必ずユーザーの明示的な許可を得る**こと。
- 開発中にスキーマを試すときは、本番ではなく `npm run db:migrate:local`（`--local`）を使う。

### バインディング名 DB を指定する理由（issue #13632 → PR #14275）

- マイグレーションコマンドは「データベース名」ではなく「**バインディング名 `DB`**」で指定している（`wrangler d1 migrations apply DB --remote` / `--local`）。
- 理由: 利用者が fork を Workers Builds に接続してデプロイすると、各利用者の D1 は**自動生成**される（名前は環境依存）。データベース名で指定すると利用者ごとに名前が異なって動かないが、**バインディング名は全環境で `DB` に揃う**ため、同じスクリプトがそのまま動く。これは Cloudflare 公式推奨の方式である。関連 PR #14275 で `d1 migrations apply` は config 内の id（または name）からバインディング名を解決できるようになったが、**未作成の DB を自動生成はしない**。よって `wrangler deploy` を先に実行して D1 を自動プロビジョニング（同名既存 D1 があれば再利用、無ければ新規作成）し、その後で `migrations apply` が成功する（2026-06-20 P-2 で実機検証・本番では既存同名 D1 が再利用された）。
- `database_id` を省略してもバインディング名 `DB` から UUID を API 解決して `wrangler d1 migrations apply DB --remote` が通るのは PR #14275（**wrangler 4.102.0 で初収録**）以降。このため `package.json` の `wrangler` 下限は **`^4.102.0`** に固定している（4.101.x へ戻ると id 省略時にマイグレーションが解決できない）。`package.json` を変更する際は `@emnapi` ピン留め（Deploy ビルド対策）を崩さないよう、lockfile は npm10 で扱うこと。

### 利用者のシークレット入力（fork 接続）

- 利用者は fork を Workers Builds に接続後、Worker の **Settings → Variables and Secrets** で4つのシークレット（`DISCORD_PUBLIC_KEY` / `DISCORD_APPLICATION_ID` / `DISCORD_BOT_TOKEN` / `ADMIN_TOKEN`・`.dev.vars.example` と一致）を設定する（接続フローで環境変数欄が出ればそこでも可）。`package.json` の `cloudflare.bindings` は各シークレットの説明文の出所。

### 案Bの実挙動は実機検証済み（2026-06-20）

- fork 接続経由での「**D1 自動生成＋マイグレーション自動適用＋Sync fork での再デプロイ＋既存 D1 の再利用（データ保全）**」の通し動作は、**2026-06-20 に staging（`discord-event-bot-staging` / `choiemu-event-bot-db-staging`）でのスモークテスト、および本番 Worker（`discord-event-bot`）の Workers Builds 接続で実機検証完了**（タスク P-2）。
- 特に「**同名既存 D1 の再利用**」は、本番接続時に Bindings タブで既存本番 D1 の UUID（`f6ff753c-bf29-4eb5-83ec-317631743cfc`）が再割り当てされたことを実機で確認済み。本番データを保持したまま Workers Builds 化に成功した。
- staging・本番とも Deploy command を `npm run deploy` に上書き設定済み（タスク P-2 のリスク②対応）。
- 文書上の成立はバインディング名 `DB` 解決・自動プロビジョニングの「紐付け維持」・純正 Sync fork 仕様から既に確認済み（出典は [distribution-and-environments.html](distribution-and-environments.html) 末尾）。実地確認も上記で完了。

---

## 関連リンク

- [ADR 0008: 検証はデプロイ済みテスト Worker で行う](adr/0008-verify-on-deployed-test-worker.md)
- [ADR 0011: 配信・更新モデル](adr/0011-distribution-and-update-model.md)
- [.claude/rules/dev-and-release.md（要約ルール）](../.claude/rules/dev-and-release.md)
