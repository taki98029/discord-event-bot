# 通知機能オーバーホール 確定仕様（2026-06-25）

通知設定まわりの 7 機能を `/grill-with-docs` で詰めた**確定設計**。実装前の単一の参照点。用語は [CONTEXT.md](CONTEXT.md)、深い決定は ADR、構造の単一の真実は [IMPLEMENTATION-CONTRACT.md](IMPLEMENTATION-CONTRACT.md)。

- 関連 ADR: [0013 配信パイプライン](adr/0013-notification-delivery-pipeline.md)（③④⑦）／ [0014 回答締切](adr/0014-response-deadline-and-change-detection.md)（①）
- CONTEXT 追加語: **回答締切（確定日時）** / **送信時刻** / Response の別名「出勤ボタン」注記
- 内部ドキュメント（配布版には含めない）。

## 0. グリルで変わった前提（重要）

- **単発（oneoff）は UI から全撤去**：type 切替・候補日入力・「開催回」の確定/確定解除を**画面から消す**。**コード（cron の単発処理・decide/undecide・`one_off_date`/`decided_occurrence_id` 等の列）は残置（休眠）**。本番に既存の単発通知は**無い**ため移行措置不要。→ フォームは実質 recurring 専用になり ⑤ が単純化。
- 「監督ロール」概念は**破棄**（①はロール通知ではなくチャンネル投稿に決定）。
- ④は「リマインド先を増やす」話ではなく**主催者向けの送信可視化（監査）**。晒し上げは不可。

## 1. 機能①：回答締切と締切後変更 → [ADR 0014](adr/0014-response-deadline-and-change-detection.md)

- 通知ごとに任意の `response_deadline_hours`（開始の N 時間前・null=なし）。全 Occurrence に自動適用。**ソフトロック**（締切後もボタンは押せる）。
- 締切告知（メンバー）: 募集投稿に「回答締切: M/D HH:MM」自動表示 ＋ 締切後の最初の cron で追従投稿（送信ログで冪等）。
- 締切後変更（管理者）: **押下時に即時検知**（旧↔新、未回答→回答も含む）→ `change_alert_channel_id`（null時は通知の channel_id）へ **メンション無し**で「＠変更者が[旧]→[新]に変更」を投稿。
- 回答履歴で識別: `responses.post_deadline_change`（0/1）→ ②の表に「締切後変更」列。
- announce-only（回答不要）通知は対象外。

## 2. 機能②：回答履歴の TanStack 化（table-core）

- **実装方式＝ `@tanstack/table-core`（バニラ・フレームワーク非依存）**。React ランタイムは ui に載せない。design-system の esbuild で **JS を 1 本バンドル**し、CSS と同様 `sync:ui` で `ui/index.html` へ注入（**CDN 非依存**）。React 島・Phase 5 SPA 化は将来の別判断。
- 機能: **任意列ソート（複数列）／グローバル検索／列ごと検索（columnFilters）／列の並べ替え・表示非表示／ページング**。**行の手動 D&D は入れない**（履歴は更新時刻順ログで意味が薄い）。
- 適用対象 2 テーブル・**独立タブ維持**:
  1. **回答履歴**（既存 `listRecentResponses`）＋ **「締切後変更」列**（①）。
  2. **リマインド送信履歴**（新 `send_log` ・④）: 誰へ/いつ/種別/成否（DM拒否等）。
- 「通知設定画面で」は作業バッチの意。回答履歴を通知設定に**埋め込まない**。

## 3. 機能③：通知ごと送信時刻 → [ADR 0013](adr/0013-notification-delivery-pipeline.md)

- `notifications.send_hour`（時単位・既定 21）。cron 駆動の全送信をこの時刻に送る。`start_time`（開催時刻）とは別物。
- cron を毎分化し「指定時刻に達した未送信分」を予算分だけ送る（④⑦と同一エンジン）。

## 4. 機能④：リマインド送信ログ（可視化） → [ADR 0013](adr/0013-notification-delivery-pipeline.md)

- 新テーブル `send_log` に全送信を記録。管理 UI（②）で主催が**完全非公開**に送信状況・失敗を確認。Discord への push・公開はしない（晒し上げ回避）。
- このログは ⑦の**冪等台帳兼ペースカーソル**も兼ねる（毎分実行でも二重送信しない）。

## 5. 機能⑤：通知フォームの 2 段 IA

「これは何 → 誰に → どこへ → 何を → いつ → どう告知 → 特別扱い → ON/OFF」の入力動線。

**■ 基本（常に表示）**
1. 通知名 ✱ / 2. 対象区分 ✱ / 3. 投稿チャンネル ✱
4. 見出し ✱ ／ 本文（任意）
5. スケジュール: 開始時刻 ✱・繰り返し ✱（曜日/月次ルール/隔週起点）・📅サマリー
6. **回答を集める**トグル（基本の末尾に昇格。OFF＝通知のみ＝下位の回答依存項目を隠す）

**■ 詳細／必要に応じて（既定は折りたたみ `<details>`）**
- **投稿の見せ方**: メンション方法・開催時間(分)
- **送信タイミング**: 送信時刻〔③〕・募集 N日前・未回答リマインド N日前・未定リマインド N日前
- **回答締切と変更通知**〔①〕: 回答締切（開始の N時間前）・変更通知チャンネル
- **機能**: ノルマ(＋間隔)・番号割り当て
- **状態**: 有効／無効

- 単発関連 UI（type 切替・候補日・開催回確定）は撤去。

## 6. 機能⑥：デザインシステム適用

- 折りたたみ＝**ネイティブ `<details>/<summary>` ＋ DS スタイル**（JS 不要）。
- チェックボックス群（回答を集める/有効/ノルマ/番号割り当て）→ **`.switch` ＋ `.SettingRow`**（Discord 設定画面風）に格上げ。
- 既存 DS で賄える: `fieldset/legend`・`.card`・`.Alert`（注意書き・@everyone 警告）・`.pill`（締切後変更/状態バッジ）・`.row`・`table`＋`.table-wrap`（②）。
- **DS への小追加**（`design-system/styles/components.css` を編集 → `sync:ui`）: ①`<details>` スタイル ②`.req`（必須マーク✱）③必要なら `.subhead`（サブ見出し）。

## 7. 機能⑦：ペース配信・推奨上限・プラン別予算 → [ADR 0013](adr/0013-notification-delivery-pipeline.md)

- 律速＝**subrequest 50/実行（Free）**。予算 45/ティックで構造的に超えない。`config.send_budget_per_tick` で **Paid 時に引き上げ可**（~120/実行 → ~172,800/日）。
- **推奨上限を UI 提示（ソフト警告）**: 現構成の推定ピーク送信 vs 推奨。**Free 推奨 = 総 ≤ 10,000/日・同一送信時刻 ≤ 2,500**。
- DM 個別配信は維持（チャンネル一斉配信は作らない）。

### 規模の根拠（実数）
- 想定 worst case = **10区分 × 10通知 × 100人 = 10,000 DM/日**。
- Free ハード上限 = 1,440実行 × 50 = **72,000/日**。10,000 は**余裕約 7 倍**、初回接触 2 倍の最悪日（20,000）でも安全。
- ドレイン（毎分・45/実行）: 10,000÷45 ≒ 223実行 ≒ **約 3.7 時間**（1時刻集中時）。③で時刻分散すれば各窓は数十分。
- 超大規模（20×10×200 = 40,000/日級）は Free では破綻（初回接触で 80,000 > 72,000・ドレイン約15h・Discord anti-spam）。→ **Paid 前提**（予算引き上げで突破）。

## 8. 実装アウトライン（着手時に タスクリスト へ採番）

1. **migrations（新連番・現最新0009）**: `notifications.send_hour` / `notifications.response_deadline_hours` / `notifications.change_alert_channel_id` / `responses.post_deadline_change` / 新 `send_log`（＋UNIQUE・index） / `config.send_budget_per_tick` 初期値。
2. **src/db**: `notifications.ts`（新列の入出力）・`responses.ts`（締切後変更フラグ・回答履歴に列）・新 `sendLog.ts`（記録・冪等チェック・一覧）。
3. **src/cron/dailyCheck.ts（全面改修）**: 毎分エンジン化。`send_hour` ゲート → due 算出 → `send_log` 冪等チェック → 予算内送信 → 記録。締切告知（deadline_notice）の冪等送信。バックログ判定。
4. **src/interactions/index.ts**: ボタン押下時に締切判定＋旧↔新比較で締切後変更を即時検知 → 変更通知チャンネルへ無メンション投稿 ＋ `post_deadline_change=1`。
5. **src/discord/rest.ts**: 募集文面に「回答締切」行を合成（`composePost`）。
6. **src/admin/index.ts**: `GET /send-log`（②可視化・フィルタ）。通知 CRUD に新フィールド。推奨上限の推定値算出 API（または UI 側算出）。
7. **wrangler.jsonc**: `crons` を `* * * * *` に。
8. **ui/index.html**: ⑤の 2 段 IA・⑥の DS 化（switch/SettingRow/details）・単発 UI 撤去・①③の新フィールド・②の table-core 化（回答履歴＋送信履歴）・推奨上限の表示と警告。
9. **design-system**: `components.css` に `<details>`/`.req`/`.subhead` 追加、table-core を含む JS バンドル＋ `sync:ui` 拡張（JS 注入）。
10. **tests**: 締切後変更検知・送信ログ冪等（同日二重送信なし）・予算ドレイン・`send_hour` ゲート・回答履歴列。

## 9. 残・前提メモ

- 送信時刻の粒度は**時単位**で確定（必要なら 30 分 cron で :30 対応の余地）。
- 締切オフセット単位は**時間前**で確定。
- `change_alert_channel_id` 未設定時は募集チャンネルにフォールバック（専用チャンネル推奨）。
- 配布フローは [.claude/rules/dev-and-release.md](../../.claude/rules/dev-and-release.md) 準拠（main 直コミット禁止・migrations は既存編集禁止で新連番・`deploy:cli` は本番＝要許可）。
