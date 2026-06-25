# /design-sync 引き継ぎメモ（初回同期・ターミナルCLIで実行すること）

> **全体計画（最終ゴール・Phase 1–5・Discord 参考の再設計フロー）は `../design-system/PLAN.md` を必ず参照。**
> このメモは「今すぐの同期」に絞った補足。

このリポジトリの `/design-sync` は **ターミナルCLIの `claude` セッションで実行**してください。
デスクトップアプリは OAuth 系コマンド（`/design-login`・`/login`）をブロックするため、同期を完了できません。

## 同期対象（重要）
- **同期するのは `design-system/` サブパッケージのみ**。リポジトリ root は Cloudflare Worker の
  Discord Bot（`discord-event-bot`）であり、**同期対象ではない**。
- 形（shape）: **package**（Storybook なし）。
- パッケージ: `design-system/`（npm パッケージ `@eventbot/design-system`）。
  - ビルド: `cd design-system && npm install && npm run build` → `dist/index.js`（ESM）＋ `dist/*.d.ts`。
  - スタイル（styles.css 相当）: `design-system/styles/index.css`（`tokens.css` + `components.css` を @import）。
  - 公開グローバル名の候補: `EventBotDS`。
  - エントリ barrel: `design-system/src/index.ts`（31 export）。

## 中身（現状＝Phase 1–2 完了）
- 28 コンポーネント / 31 export（cn 含む）。Form / Display / Overlay(Modal) / Surface / Layout / Nav / Topbar / App固有。
- 共有CSSコア `design-system/styles/` が**唯一の真実**。React コンポーネントは同じ CSS class を出力する。
- これは「現状の見た目」を忠実にコード化したライブラリ。**この後 claude.ai/design 上でデザインエージェントが
  Discord（https://discord.com/channels/@me）を参考にスタイリッシュへ再設計**する想定（だから現状の見た目で同期してよい）。

## 留意
- 設計言語は「CSS クラス + `var(--*)` トークン」。新しい色・余白は直書きせず token を使う。
- 既存の静的UI（`ui/index.html`）は将来この React 層へ移行予定（Phase 5）。今回の同期対象ではない。

## 初回同期（2026-06-25）で確立した事項 — 再同期で踏襲すること
- **CSS 閉包**: コンバータは `cfg.cssEntry` の中身を `_ds_bundle.css` に**verbatim コピー**し、相対 `@import` を辿らない。
  そのため `styles/index.css`（`@import` だけのバレル）を直接指すと tokens/components が欠落する。
  → DS の `build.mjs` に **esbuild で @import を解決した平坦化 CSS `dist/styles/index.bundle.css`** を出力する step を追加し、
  `cfg.cssEntry = "dist/styles/index.bundle.css"` を指す。CSS を増減したら `npm --prefix design-system run build` で追従。
- **プレビュー足場**: `.design-sync/_frame.tsx`（previews/ の**外**に置く＝コンポーネント名に一致させず "stale preview" 警告を避ける）。
  カード body は白に上書きされるため、`_frame` が body を `--bg/--text` 化し、`Frame`（props: `row`/`maxWidth`/`gap`）でレイアウト。全 preview が `import { Frame } from '../_frame';`。
- **fixed/absolute 系の逃げ**: `.toast`（position:fixed）等は素のままだとカード枠外へ逃げて見切れる。コンポーネントが `...rest` を
  spread することを利用し、preview 側で `style={{ position: 'static' }}` を渡して in-flow 化する（config 変更不要）。Modal/backdrop も同系。
- **サブ部品は親で合成**: Radio→RadioGroup（同一 `name`）、SubTab→SubTabs、NavItem→SideNav、ServerRailItem/Divider→ServerRail、
  Avatar/ServerBadge→Topbar。レイアウト（Shell/Row/Row3/GridCards/Actions/Main）は実 DS 子（Card/Button 等）で中身を埋める。
- **薄いラッパの合成補完**: `SlotGroup` は `.timechips` ラッパを内包しないので preview で手動 `<div className="timechips">` を置く。
  `SearchBox`(`.search`) は relative のみ＝アイコンは子の absolute span＋input paddingLeft で出す（CSS に search-icon 規約なし）。
- **DS 仕様メモ**: `.actions` は既定 **左寄せ**（右寄せは `.modal .actions` のみ）。preview は実挙動どおり左寄せで採点済み。

## Known render warns
- **Modal `[RENDER_THIN]`（良性・記録済み）**: Modal は overlay（`.backdrop` が position:fixed）で、計測上の高さが 0px になり thin 判定が出る。
  `cfg.overrides.Modal = {cardMode:"single", primaryStory:"Confirm"}` を適用済みで、single カードでは開いた状態が正しく描画される（grid overflow は解消）。次回も出るが対応不要。
- その他は現状なし（43 コンポーネント全件 authored、floor card 0）。新しい warn が出たら都度精査。

## Re-sync risks（次回同期で揺れうる点・監視対象）
- **平坦化 CSS への依存**: `cfg.cssEntry` は生成物 `dist/styles/index.bundle.css` を指す。`build.mjs` の該当 step か `styles/index.css` の
  `@import` 構成が変わると CSS 閉包が壊れる。再同期は必ず `npm --prefix design-system run build` 後に確認（`styles.css` → `_ds_bundle.css` が実CSSを含むこと）。
- **cardMode**: 初回は Modal/Table 等に grid overflow 上書きを適用していない（validate の `[GRID_OVERFLOW]` 判定に従う方針）。
  コンポーネント追加や横幅増で overflow が出たら validate の `suggestedOverride` どおり `cfg.overrides.<Name>` を足す。
- **省いた状態**: hover/focus/disabled の一部、ネイティブ select 展開、ServerRailItem の画像 `src` バリアントは未カバー（静的キャプチャ制約）。
- **プレビューの実コードへの結合**: previews/*.tsx は実コンポーネントの props/CSS class に依存。DS 側で class 名や props を変えたら
  該当 preview の再 author/再採点が要る。
