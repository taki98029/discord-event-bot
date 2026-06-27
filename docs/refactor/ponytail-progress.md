# Ponytail リファクタリング進捗ログ

> 計画書: [ponytail-plan.md](./ponytail-plan.md)
> 開始: 2026-06-28

## Phase 1 ベースライン (commit: TBD)

| metric | value |
|---|---:|
| LOC src/ | 4,972 |
| LOC ui/ | 2,450 |
| LOC design-system/{src+styles} | 1,737 |
| LOC design-system/*.mjs | 187 |
| LOC scripts/ | 125 |
| LOC tests/ | 1,444 |
| LOC config (wrangler+package+tsconfig+vitest) | 185 |
| **LOC 合計** | **11,100** |
| deps root (dependencies + devDependencies) | 9 |
| deps design-system (dependencies + devDependencies) | 7 |
| `// ponytail:` コメント数 | 0 |
| tests passed | 103 (9 files) |

### `/ponytail-audit` ベースライン (full mode)

biggest cut first:

```
delete: design-system/src/components/*.tsx 34 files unused. SPA 化まで deferred 注釈で代替 (ADR 0019 で正式採用予定). [design-system/src/components/*.tsx]
native: discord-interactions verifyKey. crypto.subtle.verify('Ed25519'). [src/interactions/index.ts:1,80]
shrink: ui/index.html confirmDialog + confirmDiscardNotif dup. Unify. [ui/index.html:688,1502]
shrink: ui/index.html fmtDate/fmtTimeRange/addMinsToTime split. Collapse to one block. [ui/index.html]
yagni: validation 散在 (toNotificationInput/candidateSlotsOf/num/parseLimit). 集約は別計画 ADR 0020. [src/admin/index.ts:71-122]
yagni: design-system/serve.mjs + serve-ui.mjs 2 file copy. Merge to --ui flag. [design-system/serve.mjs, serve-ui.mjs]
delete: design-system/styles/components.css 未参照クラス. grep 確認後 prune. [design-system/styles/components.css]
native: dotenv import + devDep. wrangler v4 が .env 自動読込. [scripts/register-commands.js:17, package.json]
yagni: shuffle Fisher-Yates 2 copies. src/lib/shuffle.ts に 1 本化. [src/db/groupings.ts:13-20, src/db/assignments.ts:4-11]
shrink: build-ui-sortable.mjs 一時ファイル書出し. esbuild stdin. [design-system/build-ui-sortable.mjs:17-18]
stdlib: pad2 helper. String(n).padStart(2,'0'). [src/cron/dailyCheck.ts:119]
shrink: mention_mode IIFE 4 行. 三項 1 行. [src/admin/index.ts:183-186]
yagni: isAnnounceOnly 判定 inline 重複. src/db/types.ts に export. [src/cron/dailyCheck.ts:43, src/admin/index.ts:146]
delete: register-commands npm script + scripts/register-commands.js. 管理 UI 経由で代替. [package.json, scripts/register-commands.js]
yagni: db:migrate:remote:staging npm script. deploy:staging が apply 込み. [package.json]
delete: admin/index.ts 833 / groupings.ts 618 / dailyCheck.ts 482 大型責務混在. 別計画 ADR 0020 で分割. [src/admin/index.ts, src/db/groupings.ts, src/cron/dailyCheck.ts]
```

**net: -200〜-1700 lines, -2 deps possible.**
(本計画スコープは 34 components を deferred 注釈で保留するため **-200〜-300 行 + -2 deps** が現実ライン)

### `/ponytail-gain` ベースライン (公式ベンチ参考値)

Phase 9 で再実行して Before/After 比較する。本リポジトリ固有値ではなく、ponytail プラグインの公称ベンチを参考値として記録。

| 指標 | 公称値 |
|---|---|
| LOC 削減平均 | -54% (最大 -94%) |
| コスト削減 | -20% |
| 速度 | +27% |
| 安全ガード維持 | 100% |

## Phase 2 src/ 軽微簡略化 (commits 71545d2 / 0bec4d4 / cc7a0b7 / 453482a)

| metric | before | after | delta |
|---|---:|---:|---:|
| LOC src/ | 4,972 | 4,961 | **-11** |
| ponytail comments | 0 | 2 | +2 |
| tests passed | 103 | 103 | ±0 |

実施:
- Commit 1 `71545d2`: `src/lib/shuffle.ts` 新規。`assignments.ts` / `groupings.ts` の Fisher-Yates 重複定義を統合（-8 行 + 新規 8 行 = ±0 だが 1 本化）
- Commit 2 `0bec4d4`: `dailyCheck.ts` の `pad2` ヘルパー削除→`String(n).padStart(2,'0')` inline（-2 行）
- Commit 3 `cc7a0b7`: `admin/index.ts` の `mention_mode` IIFE 4 行→三項 1 行（-3 行）
- Commit 4 `453482a`: `isAnnounceOnly(Pick<Notification, 'type' | 'requires_response'>)` を `db/types.ts` に export。`dailyCheck.ts` のローカル定義 + `admin/index.ts` のインライン式（`type === 'recurring' && requiresResponse === 0`）を統合

スキップ: `tests/fixtures.ts` 新規（`makeEnv` は setup.test.ts のみ・1 ファイル限定、`makeNotification` は recurrence.test.ts / db.test.ts でシグネチャが同期/非同期で異なり共有不適）。Ponytail 流に実利薄として除外。当初計画 5 コミット→ **4 コミットに圧縮**。

## Phase 3 scripts + dotenv 撤去 + serve 統合 (commits 68a6d10 / 064e9c8 / e2dd00f)

| metric | before | after | delta |
|---|---:|---:|---:|
| LOC scripts/ | 125 | 125 | ±0 |
| LOC design-system/*.mjs | 187 | 160 | **-27** |
| deps root | 9 | 8 | **-1 (dotenv)** |
| ponytail comments | 2 | 5 | +3 |
| tests passed | 103 | 103 | ±0 |

実施:
- Commit 1 `68a6d10`: `scripts/register-commands.js` から `import 'dotenv/config'` 削除。`package.json` の `register-commands` を `node --env-file=.env scripts/register-commands.js` に。devDep `dotenv` 削除。`engines.node` を `>=20.6.0` に引き上げ（`--env-file` サポート）
- Commit 2 `064e9c8`: `design-system/serve.mjs` と `serve-ui.mjs` の 2 ファイル重複を `--ui` フラグ + `PORT` env で 1 本化。`serve-ui.mjs` 削除。`.claude/launch.json` の ui-preview / `design-system/README.md` / `docs/refactor/ponytail-ui-regression.md` を新コマンドに更新。両モード curl smoke (200) 合格
- Commit 3 `e2dd00f`: `build-ui-sortable.mjs` の一時 entry 書出し（`writeFileSync`）を esbuild `stdin` に置換。残骸 `design-system/src/_ui-sortable-entry.ts` も撤去

スキップ: 計画にあった `dev:ds`/`dev:ui`/`dev:setup`/`build:setup`/`build:ui`/`sync:ui` 等の追加 npm scripts は `.claude/launch.json` で既に代替済みのため Ponytail (YAGNI) で見送り。当初計画 4 コミット → **3 コミット**に圧縮。

## Phase 4 ui/index.html 重複統合 (TBD)

| metric | before | after | delta |
|---|---:|---:|---:|
| LOC ui/ | 2,450 | TBD | TBD |

## Phase 5 design-system/styles (TBD)

| metric | before | after | delta |
|---|---:|---:|---:|
| LOC design-system/{src+styles} | 1,737 | TBD | TBD |

## Phase 6 discord-interactions → Web Crypto (TBD)

| metric | before | after | delta |
|---|---:|---:|---:|
| LOC src/ | TBD | TBD | TBD |
| deps root | TBD | TBD | TBD |
| tests passed | TBD | TBD | TBD |

## Phase 7 design-system deferred 注釈 (TBD)

| metric | before | after | delta |
|---|---:|---:|---:|
| LOC design-system/{src+styles} | TBD | TBD | TBD |
| ponytail comments (deferred) | TBD | TBD | TBD |

## Phase 8 ADR + plan 起票 (TBD)

ドキュメント追加のみ。LOC delta なし。

## Phase 9 Summary (TBD)

全 Phase の集計表 + `/ponytail-audit` Before/After + `/ponytail-gain` 比較を追記。
