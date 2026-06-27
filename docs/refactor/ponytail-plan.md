# Ponytail リファクタリング実行計画 v3

> 出典: https://zenn.dev/53able/articles/66616005d7aaf4
> プラグイン: https://github.com/DietrichGebert/ponytail
> 強度モード: `full`（既定）
> grill 確定済み（10 主要判断）

## Context

ユーザー依頼:「Zenn の Ponytail 記事をもとにリポジトリをリファクタリング。計画立案 → 実行前後の行数記録」。

### grill で確定した方針
- 本計画 (II) はコンパクト: マイクロ改善＋依存削減のみ。期間 1〜2 週間で完遂
- 大規模手入れ (III) は全部別計画化: SPA / src 構造再設計 / OPS 小粒は ADR + 別 plan.md で起票（**ADR 0017/0018 は既使用のため 0019/0020 を予約**）
- Phase 6 (本番影響) は最短ルート: staging smoke test → 即ユーザー許可 → 即本番
- ponytail プラグインは `full` モード: 標準ラダーで Phase ごと `/ponytail-review`

### Ponytail（DietrichGebert 版）の核
- **5 段判断ラダー**: ① YAGNI → ② 既存資産 → ③ stdlib → ④ ネイティブ機能 → ⑤ 既存依存 → ⑥ ワンライナー → ⑦ 最小実装
- **公称効果**: 平均 -54% LOC、コスト -20%、速度 +27%、安全ガード 100% 維持

## 計画の 3 層構造

| 層 | 内容 | 本計画スコープ |
|---|---|---|
| (I) 測定基盤 | ponytail プラグイン + progress.md 起点 | ✅ |
| (II) 確定実行 | マイクロ改善 + 依存削減 + UI 重複統合 + CSS 整理 + 信頼境界の依存置換 | ✅ |
| (III) 大規模手入れ | SPA / src 構造再設計 / OPS 小粒 | ❌ 別計画化（Phase 8 で起票のみ） |

## Phase 概要

### Phase 0 — ponytail プラグイン導入（ユーザー実行・完了済み）
`PONYTAIL MODE ACTIVE — level: full` 確認済み。

### Phase 1 — 計測ベースライン + 計画書 commit（本コミット）
- `docs/refactor/ponytail-plan.md`（本ファイル）
- `docs/refactor/ponytail-progress.md`（ベースライン + 各 Phase 追記）
- `docs/refactor/ponytail-ui-regression.md`（Phase 4/5 マニュアル回帰チェックリスト）
- 削減: 0（ドキュメント追加）

### Phase 2 — src/ 軽微な意図的簡略化（-28 行見込）
| 対象 | 変更 |
|---|---|
| `src/lib/shuffle.ts` 新規 | Fisher-Yates 単一実装 |
| `src/db/groupings.ts:13-20` / `src/db/assignments.ts:4-11` | shuffle 削除→import |
| `src/cron/dailyCheck.ts:119` | `pad2` → `String(n).padStart(2,'0')` inline |
| `src/admin/index.ts:183-186` | `mention_mode` IIFE → 三項 |
| `src/db/types.ts` | `isAnnounceOnly(n)` を export し共通化 |
| `tests/fixtures.ts` 新規 | `makeEnv`/`makeNotification` 共有 |

各変更に `// ponytail: ...` コメント。
PR: `refactor(src): ponytail micro-simplifications`

### Phase 3 — scripts + design-system mjs 統合 + dotenv 撤去（-45 行 / deps -1）
| 対象 | 変更 |
|---|---|
| `design-system/serve.mjs` + `serve-ui.mjs` | 統合（`--ui` フラグ + `PORT` env） |
| `design-system/build-ui-sortable.mjs` | 一時ファイル → esbuild stdin |
| `scripts/register-commands.js` | `dotenv/config` import 削除 |
| `package.json` `devDependencies.dotenv` | 削除 |
| `package.json` `scripts` | `dev:ds` / `dev:ui` / `dev:setup` / `build:setup` / `build:ui` / `build:ds` / `sync:ui` 追加 |

PR: `refactor(scripts): merge dev servers, drop dotenv, expose npm scripts`

### Phase 4 — ui/index.html 重複統合（-50〜100 行）
- (i) `confirmDialog` / `confirmDiscardNotif` 統合（行 ~688 と ~1502）
- (ii) 日付フォーマット重複統合（`fmtDate` / `fmtTimeRange` / `addMinsToTime`、出力 100% 維持）
- state 集約はやらない（Phase III-SPA で React state に組み直す）

検証: `docs/refactor/ponytail-ui-regression.md` 7 項目チェックリスト + `/ponytail-review`
PR: `refactor(ui): dedupe confirm dialogs and date formatting helpers`

### Phase 5 — design-system/styles トークン統合（-50〜100 行）
- `design-system/styles/components.css` の未参照クラス削除、重複セレクタ統合
- 削除前に `grep -r '<class-name>' design-system/src ui` で実参照確認

PR: `refactor(design-system): consolidate styles and remove unreferenced utilities`

### Phase 6 — discord-interactions → Web Crypto Ed25519 置換（本番影響）
| 対象 | 変更 |
|---|---|
| `src/interactions/index.ts:1,80` | `verifyKey` を `crypto.subtle.verify('Ed25519', ...)` に |
| 同ファイル冒頭 | `InteractionType` / `InteractionResponseType` を const 再現 |
| `package.json` `dependencies.discord-interactions` | 削除 |
| `tests/interactions.test.ts` 新規 | 有効/無効署名 + PING の 3 ケース |

**検証フロー（最短ルート確定）**:
1. typecheck + npm test + `/ponytail-review` 全 green
2. main マージ → Workers Builds staging auto-deploy
3. staging smoke test（数分）: テスト用 Discord で `/help` `/recruit` `/all_status` + ボタン各 1 回
4. ユーザー許可取得
5. 本番 `npm run deploy:cli`

**ロールバック 3 段**:
- (i) 開発中失敗 → コミット破棄
- (ii) staging で 401 連発 → `git revert` → staging に旧コード再デプロイ
- (iii) 本番 30 分以内に異常 → `git revert` → 再許可 → `deploy:cli` で旧バージョン戻し（緊急時は Discord Portal で interaction endpoint 一時無効化）

PR: `refactor(interactions): replace discord-interactions with Web Crypto Ed25519`

### Phase 7 — design-system 34 components に ADR 0019 参照 deferred 注釈（+102 行）
全 34 .tsx 先頭に 3 行注釈:
```tsx
// ponytail: deferred — see docs/dev/adr/0019-ui-architecture-react-spa.md
// 本コンポーネントは Phase III-SPA (UI 全面 React 化) で初使用予定。
// 現在 ui/index.html は手書き HTML/CSS で完結しており、未参照。
```
PR: `chore(design-system): annotate deferred components with ADR 0019 reference`

### Phase 8 — ADR + plan.md 起票（ドキュメントのみ）
| 作成物 | 内容 |
|---|---|
| `docs/dev/adr/0019-ui-architecture-react-spa.md` | UI SPA 化の設計判断（React/Vite/Router/SortableJS 代替/E2E ツール選定）Status: Proposed |
| `docs/refactor/ponytail-spa-plan.md` | SPA 化の実行 Phase 構成 |
| `docs/dev/adr/0020-src-restructure-by-domain.md` | src 構造再設計 ADR Status: Proposed |
| `docs/refactor/ponytail-src-restructure-plan.md` | A1〜C1 順番 + テスト戦略 +460 行 |
| `docs/refactor/ponytail-ops-cleanup-plan.md` | OPS 小粒（Y-1 / Y-3 / Z-1 / Z-2 / X-2 / X-3 / X-5）集約 |

PR: `docs(refactor): open ADR 0019/0020 and plans for III-SPA / III-A / III-OPS`

### Phase 9 — progress.md ファイナライズ
- 全 Phase delta 集計表
- `// ponytail:` コメント分布
- `/ponytail-audit` Before/After
- `/ponytail-gain` 公称ベンチ
PR: `docs(refactor): finalize ponytail progress report`

## 想定削減合計 (II)

| Phase | LOC delta | deps delta |
|---|---:|---:|
| 1 | +N (doc) | 0 |
| 2 | -28 | 0 |
| 3 | -45 | **-1 (dotenv)** |
| 4 | -50〜-100 | 0 |
| 5 | -50〜-100 | 0 |
| 6 | +0〜+5 | **-1 (discord-interactions)** |
| 7 | +102 (注釈) | 0 |
| 8 | +N (doc) | 0 |
| 9 | +N (doc) | 0 |
| **合計（コア）** | **-70〜-170 行** | **-2** |

主成果は LOC delta よりも `/ponytail-audit` スコアと `// ponytail:` コメント分布の改善。

## (III) 別計画群カタログ

| 計画 | ADR | plan | 想定 |
|---|---|---|---|
| III-SPA: UI 全面 React 化 | 0019 | ponytail-spa-plan.md | 25-35 人日、+11MB deps、ui/index.html -2430、+2700〜3050 |
| III-A: src/ 構造再設計 | 0020 | ponytail-src-restructure-plan.md | A1(admin -183) + A2(groupings -88) + A3(dailyCheck -102) + B1/B2/C1、tests +460 |
| III-OPS: 配布運用クリーンアップ | （不要） | ponytail-ops-cleanup-plan.md | Y-1/Y-3/Z-1/Z-2/X-2/X-3/X-5 集約 |

除外: X-1 GitHub Actions CI（main push → Workers Builds auto-deploy で代替）

## 触ってはいけない領域

### 信頼境界・セキュリティ・データ
- `src/admin/setup.ts` 認証 (`timingSafeEqual` 含む)
- `src/db/sendLog.ts` 監査ログ
- `migrations/0001-0013` 既存ファイル
- D1 スキーマ制約、`interface` 型定義の意味変更
- `@deprecated mention_enabled` 後方互換
- Discord 署名検証の**仕様**（Phase 6 で実装のみ置換可）
- 回答締切 (ADR 0014) `postDeadlineChange`
- 送信予算・ペース配信エンジン (ADR 0013)
- ロール同期 (ADR 0009) access control
- グループ分け制約 (ADR 0015) 一括削除＆再挿入の整合性

### 配布・運用
- `wrangler.jsonc` の `database_id` 省略形
- `wrangler.local.jsonc`
- `setup.html` / `setup.src.html` / `scripts/build-setup-html.mjs` / `.captures/`
- `design-system/sync-ui.mjs`
- `package.json` の `scripts`（Workers Builds 参照 `deploy:staging` 等は変更しない、新規追加のみ）
- `wrangler` `^4.102.0` 下限、`overrides.@emnapi/*`
- model A セマンティクス

### a11y 基本
- `ui/index.html` の `<dialog>` (Esc / フォーカス管理 / ARIA)

### Phase III-SPA 計画との整合
- `design-system/src/components/*.tsx` は **Phase 7 で deferred 注釈のみ**、削除しない
- `design-system/styles/{tokens,components,index}.css` の値の意味を変えない

## 検証フロー（各 Phase 共通）

1. `npm run typecheck`（必要なら `cd design-system && npm run build`）
2. `npm test`
3. `/ponytail-review` で差分レビュー（残差は `/ponytail-debt`）
4. UI/scripts を触った Phase: ローカル起動目視
5. Phase 4, 5: `ponytail-ui-regression.md` の 7 項目
6. progress.md に append
7. main push → Workers Builds staging auto-deploy
8. staging 確認（Phase 4, 5 推奨 / Phase 6 必須）
9. 本番 deploy:cli（Phase 6 のみ・ユーザー明示許可後）

## Critical Files

- `src/interactions/index.ts` — Phase 6
- `ui/index.html` — Phase 4（2,450 行）
- `src/db/groupings.ts` / `src/db/assignments.ts` — Phase 2 shuffle
- `src/admin/index.ts` (833) — Phase 2 mention_mode / announceOnly
- `src/cron/dailyCheck.ts` (482) — Phase 2 pad2 / announceOnly
- `src/db/types.ts` — Phase 2 `isAnnounceOnly`
- `tests/fixtures.ts` / `tests/interactions.test.ts` — Phase 2 / 6 新規
- `design-system/src/components/*.tsx` — Phase 7 deferred 注釈
- `design-system/serve.mjs` + `serve-ui.mjs` — Phase 3 統合
- `design-system/build-ui-sortable.mjs` — Phase 3 stdin 化
- `scripts/register-commands.js` / `package.json` — Phase 3 dotenv 撤去 + scripts 追加
- `docs/dev/adr/0019-*.md` / `0020-*.md` — Phase 8 起票
