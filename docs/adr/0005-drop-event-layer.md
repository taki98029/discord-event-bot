# Event 層を廃止し Server ＞ Notification に平坦化する

ADR [0001](./0001-domain-model.md) は `Event ＞ Notification → Segment ＞ Occurrence` の階層を定めたが、最上位に Server（ADR [0004](./0004-multi-server.md)）を導入した結果、**Event 層は空フォルダとなり混乱を生む**ため廃止する。

## 決定

- `Event` エンティティ（`events` テーブル）を廃止する。
- `Notification` は `guild_id` で **Server に直接紐づく**（`notifications.event_id` → `notifications.guild_id`）。
- 階層は `Server ＞ Notification → Segment ＞ Occurrence` になる。
- 管理 UI には Event セクションを置かない。通知はサーバー配下のフラットな一覧として並べる。

## 根拠

- 実運用は「1 サーバー＝実質 1 プログラム」で、Event は通知をまとめるだけの薄いグルーピング（`{guild_id, name}` のみ）。ユーザーは Server と Event を区別できず混乱した。
- cron・interactions・occurrence は **Event を一切参照していない**（すべて Notification にぶら下がる）。Event はカスケード削除の対象でしかなかった。
- 1 サーバー内に複数の通知（キャスト用／スタッフ用／練習会など）はあるが、その整理は **Notification の命名**で足り、専用の階層は要らない。

## トレードオフ

- 1 サーバーで複数プログラムを**明示的にグルーピング**する手段を失う（命名で代替）。将来必要になれば、`notifications` への nullable な多対多タグとして、cron／occurrence を非参照のまま比較的低コストで再導入しうる（要設計）。
- スキーマ変更のコストは小さくない：既存 `notifications.event_id` → `guild_id` の**値継承（所属 event の `guild_id` から移送）**が要り、D1/SQLite では列削除にテーブル再構築を伴う。
- **現リポジトリとの不整合**：未コミットの `migrations/0003_add_guild_id.sql` は `events`／`segments` にだけ `guild_id` を足し `notifications` には足していない（本 ADR と逆方向）。0003 を作り直すか、後続マイグレーション（`notifications.guild_id` 追加・`events` DROP）で最終形へ寄せる必要がある。
- admin API の `/events` 撤去、UI の Event 選択廃止が必要。

Supersedes: ADR [0001](./0001-domain-model.md) の Event 層（Notification／Segment／Occurrence／Response／Assignment の一級エンティティ化は維持）。
