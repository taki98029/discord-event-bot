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
