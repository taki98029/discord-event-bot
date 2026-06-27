---
paths:
  - "wrangler.jsonc"
  - "wrangler.local.jsonc"
  - "package.json"
  - "migrations/**"
  - "src/**"
  - "ui/**"
  - ".github/**"
---

# リポジトリ・環境・デプロイ構造（必読 / model A: main 一本＋本番は手動）

> 構造の把握と「どの push が何を自動デプロイするか」「本番デプロイはどう行うか」を取り違えないための恒久メモ。
> コマンド/手順の詳細は [dev-and-release.md](./dev-and-release.md)、根拠は ADR [0011](../../docs/dev/adr/0011-distribution-and-update-model.md)（配布モデル）・[0012](../../docs/dev/adr/0012-three-tier-parity.md)（3層 parity・unified／model A 移行追補）。

## リポジトリ（リモート2本）
- **origin** = `taki98029/event-master-bot`（**非公開**・保守者の開発リポジトリ。`main` ブランチ＋作業枝群）。
- **public** = `taki98029/discord-event-bot`（**公開**・配布。利用者が **Fork** する元＋「Sync fork」の upstream。`setup.html` 配布基盤・廃止不可）。
- 紛らわしい点: **本番 Worker 名も `discord-event-bot`**（＝公開 repo 名と同じ）。非公開 repo は `event-master-bot`。

## 環境3層（ADR0012・model A）
| 層 | Worker / D1 / Discord | デプロイ |
|---|---|---|
| ① ローカル | `npm test` / `typecheck` / sealed `wrangler dev` | リモート無し |
| ② 検証 staging | `discord-event-bot-staging` / `choiemu-event-bot-db-staging`(`43d98794-…`) / テスト用Discord | **origin/`main` への push → Workers Builds が自動デプロイ**（`npm run deploy:staging`） |
| ③ 本番 prod | `discord-event-bot` / `choiemu-event-bot-db`(`f6ff753c-…`) / 本番Choiemu | **手動: 保守者がローカルで `npm run deploy:cli`**（本番 Workers Builds は **auto-deploy 無効**） |

## ★最重要: push≠本番デプロイ（model A）
- **`git push origin main` → ②staging が自動デプロイ**（Workers Builds が `npm run deploy:staging` 実行 = `wrangler deploy --env staging`）。**本番には飛ばない**。
- **③本番デプロイは `npm run deploy:cli` を保守者が手で実行する**（CLI ＝本番 Choiemu 操作・**毎回ユーザー許可必須**）。`deploy:cli` は `wrangler.local.jsonc`（実 `database_id` 入り）を `--config` で指定して D1 マイグレーション→deploy を実行。
- 本番 Workers Builds プロジェクト（`discord-event-bot`）は **「Builds disabled」設定**で push 時の auto-deploy が起きない。誤って main push しても本番には影響なし（staging だけ更新される）。
- 利用者: `public/main` を Fork → 各自の Workers Builds → 各自の Worker。更新は GitHub「Sync fork」のみ（CLI 不要）。

## ブランチ役割（origin）
| ブランチ | 役割 | wrangler.jsonc | Workers Builds Deploy command |
|---|---|---|---|
| `main` | **唯一の長命ブランチ**。push で②staging に auto-deploy。本番リリース時は保守者が手動 `npm run deploy:cli` | **unified（base=配布）**＋`env.staging` ブロック同梱 | （staging プロジェクト側で）`npm run deploy:staging` |
| `public-release` | `public/main` 追跡（公開配布の内容） | unified | （利用者が各自設定。setup.html は `npm run deploy` を指示） |
| feature 群 | `feat/*`・`ui/*`・`integrate/*`・`design-sync/*` ＝ main へ統合する作業枝 | unified | — |
| ~~`staging`~~ | **廃止（2026-06-27 model A 採用）**。コミット履歴は main に統合済み。残存する場合は削除可 | — | — |

## wrangler.jsonc は全ブランチ共通（unified・2026-06-27 移行）
- **設計**: base = 配布／本番設定。`env.staging` 上書きで staging 用 name/d1 を分離。
  - 本番デプロイ: `wrangler deploy`（env 無し）→ Worker `discord-event-bot` / D1 `choiemu-event-bot-db`
  - staging デプロイ: `wrangler deploy --env staging` → Worker `discord-event-bot-staging`（base + `-staging` 自動サフィックス）/ D1 `choiemu-event-bot-db-staging`（id 明記）
- **継承**: `triggers`(crons) / `assets` / `compatibility_*` / `main` / `name` は env block へ自動継承。`d1_databases` のみ非継承＝env block で全項目再記述必須（Wrangler 公式）。
- **`wrangler.local.jsonc`**: gitignore・実 `database_id`・`deploy:cli`（本番デプロイ専用）。`--config` は設定を**置換**するので wrangler.jsonc 変更時は追従必須（cron 等のドリフトに注意）。

## 通常運用フロー（model A）
1. **開発**: feature ブランチを切る → 実装 → `npm test` / `typecheck` → main へマージ（PR か直 merge）
2. **②検証**: main へ push されると Workers Builds が staging Worker(`discord-event-bot-staging`) へ自動デプロイ。テスト用 Discord で挙動確認
3. **③本番リリース**: 動作 OK の判断ができたら、**ユーザーへ事前許可を取って** `npm run deploy:cli` を実行。本番 D1 にマイグレ適用→本番 Worker へデプロイ
4. **リリース記録**: `git tag v7.x.x && git push --tags` でリリース時点を記録（任意）
5. **公開配布反映**: 必要に応じ `public/main` への push（[[two-repo-topology]]・[[distribution-and-environments-is-internal]] 参照）

## Cloudflare ダッシュボード設定（model A 前提）
- staging プロジェクト(`discord-event-bot-staging`): **Production branch = `main`**, **Deploy command = `npm run deploy:staging`**
- prod プロジェクト(`discord-event-bot`): **Builds disabled**（または接続解除）。auto-deploy が一切走らない状態に保つ
- 上記設定が崩れると model A は成立しない（特に prod project の Builds が有効に戻ると、main push が本番に飛ぶ事故になる）

## ★ Cloudflare auto-PR は merge してはいけない（要厳守）
- staging プロジェクトの Build 画面で「`Update wrangler.jsonc in your repo to keep settings consistent. On Wrangler v3.109.0+, we will auto-generate a PR to fix this after the build`」のような警告が出る。
- これは Cloudflare の静的チェックが top-level `name` (`discord-event-bot`) と staging Worker 名 (`discord-event-bot-staging`) の不一致を検出したもの。**unified wrangler.jsonc の `env.staging` 上書きを Cloudflare が認識していない**ため発生する。
- 警告自体は無害（実デプロイは `--env staging` で正しく解決される）だが、**ビルド後に Cloudflare が GitHub に「top-level `name` を `discord-event-bot-staging` に書き換える」自動 PR を立てる可能性**がある。これを merge すると **本番デプロイ(`npm run deploy:cli`)が staging Worker を狙う**ようになり本番が壊れる。
- **対応**: ダッシュボードの警告は X で閉じる。GitHub に Cloudflare 由来の wrangler.jsonc 編集 PR が立ったら **絶対に merge せず Close**。理想的には `env.staging.name = "discord-event-bot-staging"` を明記しておくと意図が明確化＋警告抑止が期待できる（2026-06-28 wrangler.jsonc に追加済み）。
