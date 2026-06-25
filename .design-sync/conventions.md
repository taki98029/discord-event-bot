# EventBot Design System — 使い方の規約

Discord 2025 リフレッシュ準拠の**モダンダークテーマ**の React コンポーネント群。全コンポーネントは
`window.EventBotDS.*`（バンドル）から利用でき、見た目は**固定の CSS クラス + `var(--*)` トークン**で決まる。

## セットアップ（重要）

- **provider/wrapper は不要**。スタイルは `styles.css`（その `@import` 閉包＝トークン＋コンポーネント CSS）を
  読み込むだけで効く。React のテーマコンテキストやプロバイダで包む必要はない。
- **ダークテーマ前提**。トークンは `:root` の CSS カスタムプロパティ。コンポーネントは**自分の背景しか塗らない**ため、
  ページ/コンテナ側を `background: var(--bg); color: var(--text)` にしないと、ホスト既定（白）の上に乗って浮く。
  画面の土台には必ず `--bg` 面を敷くこと。

```jsx
// 画面の土台は --bg 面。コンポーネントはそのまま置くだけ。
<div style={{ background: 'var(--bg)', color: 'var(--text)', minHeight: '100vh', padding: 24 }}>
  <SummaryBanner>✓ 次回の通知は今週土曜 21:00</SummaryBanner>
  <SettingRow title="フレンドがオンライン" description="オンライン時に通知します"
    control={<Switch defaultChecked />} />
  <Actions>
    <Button variant="ghost">キャンセル</Button>
    <Button>保存</Button>
  </Actions>
</div>
```

## スタイリングの作法

- コンポーネントは `.btn` / `.card` / `.pill` / `.setting-row` / `.alert` / `.toast` 等の**意味的な固定クラス**を出力する。
  **自前でユーティリティクラスを足さない**。見た目の差は**props で出す**:
  `variant`（primary/secondary/danger/ghost）, `tone`（info/warn/danger/ok・neutral/on/off など）,
  `size`（md/sm/xs）, `active` / `invalid` / `open` / `busy` —— これらが修飾クラスを切り替える。
- **自分のレイアウト用 glue（余白・配置・面）にはトークンを `var(--*)` で使う**。直値の色・余白を書かない。
  - 面: `--bg` `--panel` `--panel2` `--elevated`
  - 境界: `--border` `--border2` `--border-hover`
  - 文字: `--text` `--muted` `--text-placeholder`
  - アクセント: `--accent` `--accent-hover` `--accent-soft`
  - 状態: `--danger` `--ok` `--warn`
  - 角丸: `--r`（8px）`--r-sm`（4px）`--r-lg`
  - その他: `--sp`（基準余白）`--shadow` `--ring` `--backdrop`
- レイアウトの土台が必要なら、まず DS のレイアウトコンポーネントを使う:
  `Shell`（サイドナビ＋メイン骨格）/ `Main` / `Row` `Row3`（等幅カラム）/ `GridCards`（カードグリッド）/ `Actions`（ボタン群）。

## 真実の在り処（コーディング前に読む）

- `styles.css` とその `@import` 先 `_ds_bundle.css` —— 全クラスとトークン定義の一次資料。
- 各コンポーネントの `<Name>.d.ts`（props 契約）と `<Name>.prompt.md`（使い方）。
- 合成の組み合わせ（行・テーブル・設定画面）は各コンポーネントのプレビューカードが実例。

## 合成の定石

- **入れ子で意味が出る部品は親の中で使う**: `Radio`→`RadioGroup`（同じ `name`）, `SubTab`→`SubTabs`,
  `NavItem`→`SideNav`, `ServerRailItem`/`ServerRailDivider`→`ServerRail`, `Avatar`/`ServerBadge`→`Topbar`。
- `SettingRow` は `title` + `description` + `control`（右に `Switch`/`Select`/`DropdownButton`）。Discord 風の設定行はこれを縦に並べる。
- `Modal` は `open` を真にして開く。`.toast`/`.backdrop` 等の固定配置はオーバーレイとして全画面に効く。
