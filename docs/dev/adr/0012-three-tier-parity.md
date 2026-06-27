# 3層構成と dev/prod parity（本番・検証とも GitHub→Workers Builds に統一）＋利用者は3アカウント必須

開発・検証・本番を **①ローカル開発 ／ ②検証(staging) ／ ③本番(prod)** の3層に分け、**②と③のデプロイ機構を Cloudflare Workers Builds（GitHub→Cloudflare）に統一**する。保守者のローカルからの CLI リモートデプロイは段階的に撤去する。あわせて、利用者が必要とする外部アカウントを **Discord・Cloudflare・GitHub の3つ**と明文化する。

> ステータス: **採用・実装完了（2026-06-20）**。配布用設定の `database_id` 省略・`wrangler.jsonc` 化・`wrangler` 下限引き上げ・`deploy:cli` 移行措置は導入済み。**②staging（`discord-event-bot-staging`）／③本番（`discord-event-bot`）ともに Workers Builds 接続完了（2026-06-20）**。②③とも Deploy command を `npm run deploy` に上書き済み。`deploy:cli` はしばらく観察期間を置いた上で撤去予定（P-5）。「同名既存 D1 再利用」の実機検証結果は [ADR 0011 追補 2](0011-distribution-and-update-model.md) を参照。

## 文脈

[ADR 0011](0011-distribution-and-update-model.md) で、利用者の本番は「公開 GitHub fork → Cloudflare Workers Builds」で初回・更新ともノン CLI に統一した。一方で保守者自身の本番（Choiemu）と検証は、これまで**ローカルから `wrangler deploy`（CLI）**で行っていた（[ADR 0008](0008-verify-on-deployed-test-worker.md)）。

この結果、**検証(②)＝ローカル CLI ／ 利用者本番(④)＝Workers Builds** とデプロイ機構が分かれていた。両者で機構が違うと、その差に起因するエラー——特に Cloudflare の自動プロビジョニング（`database_id` を記載しないことによる D1 生成）、Workers Builds 上でのマイグレーション実行、Workers Builds のデプロイコマンド設定——が**検証をすり抜けて本番(利用者環境)で初めて顕在化**する。これは「ローカルでは通るのに本番だけ落ちる」典型である。

また配布用設定の `database_id` を記載しない対応（[ADR 0011](0011-distribution-and-update-model.md) の「未検証＝初回実デプロイで確認」を成立させる前提）を入れると、同じ設定をローカルでも使う保守者の `wrangler deploy` が**別の D1 を自動生成して本番データから切り離される**という副作用が生まれる。これも「ローカル経路と本番経路が別物」であることに起因する。

## 決定

- **3層に分ける。**
  - **① ローカル開発**: `npm test`（vitest・密閉）／`npm run typecheck`／必要なら sealed `wrangler dev`。速い反復の主役。リモートへはデプロイしない。
  - **② 検証(staging)**: `staging` ブランチ（または検証用 fork）を専用の staging Worker に **Workers Builds** で接続。テスト用 Discord アプリ＋自動生成 D1＋テストデータに向ける。
  - **③ 本番(prod)**: `main`（または本番 fork）を本番 Worker に **Workers Builds** で接続。実 Choiemu＋他イベントは**1インスタンスのマルチサーバー**（`guild_id`・[ADR 0004](0004-multi-server.md)）で共存。
- **②③のデプロイ機構を Workers Builds に統一する。** 両方ともデプロイコマンドを **`npm run deploy`**（`= wrangler deploy && npm run db:migrate:remote`。先に `wrangler deploy` で D1 を自動作成し id を `wrangler.jsonc` に書き戻してから `db:migrate:remote` が id を解決してマイグレーション適用）に設定する。Workers Builds の既定コマンドは `npx wrangler deploy`（マイグレーションを実行しない）なので、**必ず `npm run deploy` に上書きする**。違いは接続先 Discord アプリとデータだけで、機構は完全に同一になる。
- **昇格パイプライン**: ① ローカルで実装・`npm test` → `staging` へ push → ② で Workers Builds が自動デプロイ・検証 → `main` へ昇格（③へ反映）。
- **配布用設定の前提を満たす。** `wrangler.jsonc` の `database_id` を記載しない（省略して自動プロビジョニング発火）、`wrangler` 下限を `^4.102.0`（PR #14275 初収録版）に固定する。これにより②で本番と同条件の通し動作（D1 自動生成＋マイグレーション自動適用＋デプロイコマンド）を**本番に触れずに検証**できる。
- **ローカル CLI リモートデプロイは移行措置として残し、最終的に撤去する。** 本番が Workers Builds に乗るまでは、保守者は実 `database_id` を持つ `wrangler.local.jsonc`（gitignore 済み）を `--config` 指定する `npm run deploy:cli` で本番へデプロイする。本番が Workers Builds に移行したら `deploy:cli` と `wrangler.local.jsonc` は撤去する。
- **利用者が必要とする外部アカウントは Discord・Cloudflare・GitHub の3つ**（いずれも無料枠）と明文化する。GitHub は公開リポジトリの **Fork**（Cloudflare Workers Builds に接続）と更新（fork の **Sync fork**）に使うため省略不可（案B・[ADR 0011 追補](0011-distribution-and-update-model.md)）。

## 根拠

- **環境差由来のエラーを②で先に潰せる。** Workers Builds が `npm run deploy` を実行し、D1 自動生成→マイグレーション自動適用という一連が②でも本番と同条件で回るため、自動プロビジョニング・マイグレーション・デプロイコマンドの不備を本番に触れず検出できる。
- **[ADR 0011](0011-distribution-and-update-model.md) の唯一の未検証項目（配布時の D1 別名生成＋マイグレーション自動適用の通し動作）が、本番に触れずに検証される。**
- **`npm run deploy:cli`（ローカルからの本番リモートデプロイ＝毎回ユーザー許可が要る本番操作）が不要になる。** リモートへのデプロイがすべて Workers Builds 経由になり、運用モデルが簡素化される。
- **[ADR 0008](0008-verify-on-deployed-test-worker.md) の安全目的をより完全に満たす。** ADR 0008 が恐れたのは「ローカルの `.env`／`.dev.vars` に本番トークンが混入して本番へ投稿」する事故。Workers Builds は Cloudflare の CI 上で走り、シークレットはダッシュボード管理（ローカル `.env` を読まない）なので、混入経路そのものが消える。
- 複数イベント（Choiemu・他）はマルチサーバーで共存できるため、イベントごとにデプロイを分ける必要はない。

## トレードオフ

- **フィードバックが遅くなる**（push→ビルド→デプロイ）。だから①ローカル（vitest／sealed `wrangler dev`）は残し、速い反復は①、②は最終パリティ確認に限定する。3層はそれぞれ役割が違う（①速さ・②忠実さ・③本番）。
- **[ADR 0008](0008-verify-on-deployed-test-worker.md) の改定が必要。** 「検証はデプロイ済みテスト機で」の精神は維持しつつ、手段を「ローカル `wrangler deploy`」から「Workers Builds」へ更新する（ADR 0008 に追補済み）。
- **初期構築コスト。** staging Worker＋ブランチ＋Workers Builds 設定（デプロイコマンドの上書きを含む）＋②用シークレットのダッシュボード投入が一度必要。
- **移行期の二重管理。** 本番が Workers Builds に乗るまでは `wrangler.local.jsonc`／`deploy:cli` を維持する必要がある（`wrangler.jsonc` を変更したら追従させること。`--config` は設定をマージせず置き換えるため内容がドリフトしうる）。

## 却下した代替案

- **検証はローカル CLI のまま（②＝CLI／③＝Workers Builds）**: デプロイ機構が本番と分かれ、環境差由来のエラーを②で検出できない。本 ADR が解こうとした問題そのものが残る。
- **本番もローカル CLI のまま（`database_id` をベタ書き）**: 配布（利用者本番）で `database_id` の省略が必須になるため、保守者本番だけ別設定を維持し続けることになり、parity が崩れる。省略に伴うローカル別 D1 生成の副作用も解消されない。
- **本番とは別に検証専用の Cloudflare アカウントを用意**: 機構の同一性は得られるが、アカウント・課金・シークレットの二重管理コストが増える。同一アカウント内で staging／prod の Worker を分ける方が軽い。

## 追補 — wrangler.jsonc の unified 化（2026-06-27）

導入当初は `main`/`public` ブランチに「配布版 wrangler.jsonc」、`staging` ブランチに「隔離版 wrangler.jsonc（`*-staging` 名）」を別々に持ち、「staging を main へマージしない」「main 反映は別 worktree で `git checkout staging -- .` → `git checkout HEAD -- wrangler.jsonc`」という運用にしていた。これにより:

- `main` と `staging` の `git merge-base` がリリース時の手動「内容コピー」コミットでしか進まず、PR/IDE のブランチ比較が「実差分は数ファイルなのに +2,700/-400」のような巨大 diff を出し続けた。
- 反映ごとに wrangler.jsonc の差し戻し手作業が必要で、ドリフト/事故源だった。

これを解消するため、`wrangler.jsonc` を **全ブランチ共通（unified）** に変更した。

- base = 配布／本番設定（`name: discord-event-bot` / `database_name: choiemu-event-bot-db` / `database_id` 省略）。`main`/`public/main` の従来の中身。
- `env.staging` 上書きで staging 用の `d1_databases`（`choiemu-event-bot-db-staging` / `id` 明記）を分離。Worker 名は `name` 未指定で base + `-staging` 自動サフィックス＝`discord-event-bot-staging`。`triggers`(crons) / `assets` / `compatibility_*` は env block へ自動継承（[Wrangler Environments](https://developers.cloudflare.com/workers/wrangler/environments/) 公式記述）。
- `package.json` に **`deploy:staging`**（= `wrangler deploy --env staging && wrangler d1 migrations apply DB --remote --env staging`）を追加。Workers Builds の staging プロジェクト Deploy command を `npm run deploy` → **`npm run deploy:staging`** に変更（本番プロジェクトは `npm run deploy` のまま）。
- 旧「staging を main へマージしない」ルールは廃止。unified 化により main↔staging を正式マージできるため、通常の GitHub フローに戻った。

**事故ポイント（要厳守）**: staging プロジェクトの Deploy command が誤って素の `npm run deploy` のままだと、base = 本番 Worker を狙うため staging push が **本番にデプロイされる**。Workers Builds 側の設定が唯一のガード。

## 追補 — model A 採用: main 一本化＋本番は手動デプロイ（2026-06-27）

unified 化（前項）に続き、**ブランチ構成も main 一本に統一**し、**本番デプロイは Workers Builds から外して手動 `npm run deploy:cli` に一本化**する運用に移行した。

**動機**

- unified 化により main↔staging に「意味のある」wrangler 差分は無くなった。残るのは「コードの進度差」のみで、2 ブランチを並走させるメリットが薄れた。
- 1 人運用において、「staging に push して検証 → main にマージして本番デプロイ」のフローは「main にマージしたら自動的に本番に出る」緊張を毎回伴う。明示的なリリース操作のほうが認知負荷が小さく事故も起きにくい。
- Workers Builds の制約上「同じ main ブランチに 2 つのプロジェクトを接続して片方だけ自動／片方だけ手動」を綺麗に分けるには本番側の Builds を切るしかない。むしろそれを明文化する。

**新運用（model A）**

- ブランチ = **`main` 一本（と feature 枝）**。
- **②staging（Worker `discord-event-bot-staging`）= main の auto-deploy**: Workers Builds の staging プロジェクトの Production branch を `main`、Deploy command を `npm run deploy:staging` に設定。main への push で自動更新される。
- **③本番（Worker `discord-event-bot`）= 保守者の手動 `npm run deploy:cli`**: 本番 Workers Builds プロジェクトは **「Builds disabled」**（auto-deploy 無効）。リリース時は保守者が事前許可を取り `npm run deploy:cli` を実行（本番 D1 マイグレ → 本番 Worker デプロイ）。
- 旧 `staging` ブランチは廃止（コミット履歴は main に統合済み）。
- `deploy:cli` は ADR0012 本文では「Workers Builds 安定後に撤去」と書かれていたが、model A 移行により**本番運用の主経路として維持**する（撤去計画は取り消し）。

**意義**

- 「main は本番」という誤解と「staging を main にマージしないと反映されない」という追加手間の両方が解消される。
- main push が本番に到達しないため、開発の心理的安全性が上がる（実験的なマージも staging で観察できる）。
- 本番リリースが「意識的な単一コマンド」になり、リリース時刻・内容が `git tag` と CLI 履歴に明確に残る。

**事故ポイント（要厳守）**

- 本番 Workers Builds プロジェクトの **Builds が誤って有効に戻ると、main push が本番に飛ぶ**。dashboard 状態は折に触れ確認すること。
- staging プロジェクトの Production branch が `main` 以外（旧 `staging` のままなど）だと検証がトリガーされない。設定は staging=`main` を保つこと。
