# 出欠管理ドメインモデル: Event ＞ Notification → Segment ＞ Occurrence

> **一部 superseded**: 本 ADR の **Event 層は [ADR 0005](./0005-drop-event-layer.md) で廃止**し、階層は `Server ＞ Notification → Segment ＞ Occurrence` に平坦化した（Server は [ADR 0004](./0004-multi-server.md)）。Notification／Segment／Occurrence／Response／Assignment を一級エンティティ化する判断は引き続き有効。

当初は「毎週 1 回の定例イベント」を前提に、出欠を `(event_date, user_id)` の複合キーで記録していた（1 日 1 イベント・単一チャンネル・単一対象・単一テナント）。汎用化にあたり、これを一級エンティティ群へ作り替える。

- **Event**: 出欠管理を束ねる最上位グループ（スケジュール・出欠は持たない）。
- **Notification**: Event 配下の独立トラック（※ Event 廃止後は Server 配下・`guild_id` 直結。[ADR 0005](./0005-drop-event-layer.md)）。投稿チャンネル・スケジュール(RRULE)・募集/リマインド日数・ノルマ・番号割り当てを所有。対象は 1 つの Segment。
- **Segment**: 設定可能なメンバー区分（キャスト/スタッフ等）。Member の所属と休止状態を**区分ごと**に持つ。@メンション用 Discord ロールを任意紐付け。
- **Occurrence**: Notification の 1 開催回。募集時に遅延生成され、Response が紐づく。
- **Response / Assignment**: Occurrence に対する 1 Member の出欠・割り当て番号。

これにより複数イベント・複数対象・単発/繰り返しを表現できる。代償として単一日付キーの単純さを失い、テーブル数とクエリ結合が増える。用語の正確な定義は [`CONTEXT.md`](../../CONTEXT.md) を参照。
