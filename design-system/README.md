# EventBot Design System

`discord-event-bot` の管理UI／setup ガイドが共有する**唯一の設計言語**。
Discord 風のダークテーマ（accent = blurple `#5865f2`）。

## このフォルダの役割

```
design-system/
├─ styles/                … 共有CSSコア（単一の真実 / source of truth）
│  ├─ tokens.css          … :root のデザイントークン（色・角丸・影・余白）
│  ├─ components.css      … ベース要素 + コンポーネントの CSS（tokens に依存）
│  ├─ app-ui.css          … ui/index.html 専用の画面合成レイヤー（ws-layout 等。React/preview には不要）
│  └─ index.css           … tokens + components をまとめる読み込みエントリ（styles.css 相当）
├─ src/                   … React コンポーネント層（共有CSSと同じ class を出力）
│  ├─ cn.ts               … className 合成ヘルパ
│  ├─ components/*.tsx     … 各コンポーネント（43点）
│  └─ index.ts            … 公開 barrel（44 export）
├─ dist/                  … ビルド成果物（esbuild ESM + .d.ts）。build で生成・gitignore
├─ sync-ui.mjs            … tokens+components+app-ui を ui/index.html の <style> へ注入（npm run sync:ui）
├─ serve.mjs              … 最小静的プレビューサーバ（既定: design-system/preview.html、`--ui` で ui/index.html）
├─ build.mjs / tsconfig.json / package.json
└─ README.md              … これ
```

## 進捗

- **Phase 1 ✅**: `ui/index.html` のインライン `<style>` から**値を一切変えずに**抽出（352宣言を完全一致で検証）。
- **Phase 2 ✅**: 共有CSSの class を出力する React コンポーネント28点を実装。`npm run build`（design-system/）で
  `dist/`（ESM + `.d.ts`）を生成。型チェック0エラー・31 export をランタイム確認済み。
  ※ `components.css` の `input.invalid, select.invalid` に `textarea.invalid` を加える微修正のみ実施（既存の見た目は不変）。
- **管理UIへ適用 ✅**: `npm run sync:ui`（`sync-ui.mjs`）で tokens+components+app-ui を `ui/index.html` の
  `<style>` へ機械注入。これにより **ui/index.html は design-system のミラー**になり、手書き転記による drift を防ぐ。
  あわせて Discord 風の **ServerRail（最左サーバー列）** を workspace に統合し、旧「サーバー切替」ボタンを置換。
  全画面（gate / picker / workspace の通知・区分・履歴・セットアップ）が現行トークン（color-scheme:dark で
  日付ピッカーも可視化、半透明色は color-mix）で統一済み。
- **Phase 3〜**: `/design-sync` で claude.ai/design へ同期 → デザインエージェントが Discord を参考に再設計 → 管理UI へ反映。
  （CSS変更は `design-system/styles/` に入れ、`npm run sync:ui` で ui へ反映する運用。）

## ビルド

```sh
cd design-system
npm install
npm run build      # esbuild → dist/index.js (ESM) + tsc → dist/*.d.ts + styles/ 同梱
npm run typecheck  # 型のみ検査
```

## 設計言語（idiom）

- **スタイルの当て方は CSS クラス + トークン**。新しい色・余白を直書きせず `var(--*)` を使う。
- ボタンは `<button class="btn ...">`。バリアントは class 追加（`secondary` / `danger` / `ghost`）、
  サイズも class（`sm` / `xs`）。多重指定可（例: `btn xs ghost`）。React 側は `variant` / `size` / `busy` prop で同じ class を出力。
- 真実は常に `styles/` の CSS。要約より実ファイルを読むこと。

## 使い方（React）

```tsx
import { Shell, SideNav, NavItem, Main, Button, Card } from '@eventbot/design-system';
import '@eventbot/design-system/styles.css'; // 共有CSSコア

<Shell>
  <SideNav>
    <NavItem active>🔔 通知</NavItem>
    <NavItem>👥 メンバー区分</NavItem>
  </SideNav>
  <Main>
    <Card onClick={openDetail}>…</Card>
    <Button variant="secondary" size="sm">保存</Button>
  </Main>
</Shell>
```

## コンポーネント目録（実装済み・43点 / 44 export）

| 区分 | コンポーネント | 対応 class |
|---|---|---|
| Form | Button / TextField / Textarea / Select / Checkbox | `.btn`・`input`・`select`・`textarea`・`label.inline` |
| Toggle/Choice | Switch / Radio / RadioGroup | `.switch`・`.radio-option`(`.radio-group`) |
| Settings | SettingRow / NavRow / Divider / Alert | `.setting-row`・`.nav-row`・`.divider`・`.alert` |
| Tabs/選択 | SubTabs / SubTab / DropdownButton | `.subtabs`・`.subtab`(`active`)・`.dropdown-btn` |
| Display | Pill / Toast / SummaryBanner / EmptyState / InlineCode | `.pill`・`.toast`・`.summary`・`.empty`・`code` |
| Overlay | Modal | `.backdrop` `.modal` |
| Surface | Card / ListRow / Table / Fieldset | `.card`・`.listrow`・`.table-wrap`+`table`・`fieldset` |
| Layout | Shell / Main / Row / Row3 / GridCards / Actions | `.shell`・`main`・`.row`・`.row3`・`.grid-cards`・`.actions` |
| Nav | SideNav / NavItem | `.side`・`.navitem`(`active`) |
| ServerRail | ServerRail / ServerRailItem / ServerRailDivider | `.server-rail`・`.server-rail-item`(`active`) |
| Topbar | Topbar / Avatar / ServerBadge | `.topbar`・`.ava`・`.srv` |
| App固有 | TimeChip / SlotGroup / PickRow / SearchBox | `.timechip`・`.slotgroup`・`.pickrow`・`.search` |

> `cn` ヘルパも export。`+ cn` で 31 export。
