# グループ分け機能とペア制約

Notification ごとに任意で有効化できる「グループ分け」機能を追加する。Occurrence の「参加」回答者を複数の Group に分割し、ペア制約（同一/別グループ × 必須/推奨）を考慮した自動配置とリアルタイム違反検出を提供する。用語は [CONTEXT.md](../CONTEXT.md) の「Grouping」「Group」「Constraint」、既存の番号割り当てとの関係は [Assignment](../CONTEXT.md) を参照。

## 文脈

- 出欠回答の集計を行う既存運用で、参加者を複数のグループ（控室・班・チーム等）に分けたい要求が出てきた。
- 既存の Assignment（番号割り当て）は連番 1..N を振る別機能で、グループ分けとは目的が異なる（座席/個室の番号 vs チーム編成）。
- 「特定の 2 人を必ず同じグループにしたい / なるべく同じグループにしたい」という制約を、毎回設定し直すのは非実用的。
- D1 のマイグレーションは配布済み環境との整合性のため後から変更できない（`.claude/rules/dev-and-release.md`）。最初のスキーマで拡張性を確保する必要がある。

## 決定

### スコープと粒度

- **Grouping は Occurrence 単位**：1 つの Occurrence に対して複数の Group を持ち、参加者を分割する。Assignment と同じ粒度に揃え、毎回独立した編成を行う（前回の結果は引き継がない）。
- **Constraint は Notification 単位**：ペア制約はその Notification の全 Occurrence で共有する。毎回の入力を不要にし、繰り返し開催での運用負荷を下げる。その回に不参加のメンバーを含む制約は該当なしとしてスキップ。
- **Assignment とは完全に独立**：同一 Notification で番号割り当てとグループ分けを両方有効化できる。設定フラグも別（`assignment_enabled` / `grouping_enabled`）。

### Constraint のデータモデル

- **direction + strength の 2 軸**：
  - `direction`：`'together'`（同一グループ）/ `'apart'`（別グループ）
  - `strength`：`'required'`（必須・違反は赤エラー）/ `'preferred'`（推奨・違反は黄警告）
- 当初は together のみ実装する（PRD の必須要件）が、apart は将来の任意拡張として同一スキーマで吸収する。

### 参加者スナップショットと回答変更への対応

- **保存時点の参加者スナップショットに対する操作**として割り切る。保存後に参加状況が変わっても、保存済みのグループ割り当ては自動では変更しない。
- グループ分け画面を再度開いたとき、現在の回答状況との差分（不参加に変わったメンバー・新規参加者）を視覚的に示し、運用者が手動で調整する。
- 既存の Assignment と同じ思想（既存番号は維持・新規参加者にのみ空き番号を振る）。

### 自動配置（v1 で含める）

- 「自動配置」ボタンを設け、ランダムシャッフル＋制約考慮の初期配置を生成する。
- アルゴリズム：
  1. 参加者を Fisher-Yates でシャッフル（既存の `assignNumbers` と同じ手法）
  2. `required + together` 制約のペアを同一グループに優先配置
  3. 残りの参加者をラウンドロビンで人数均等に分配
  4. `preferred` 制約は試行的に考慮（厳密な最適化は行わない）
- ランダム性により、毎回異なる組み合わせが得られる。
- 違反が残った場合はリアルタイム検出が警告するので、運用者が手動で微調整する。

### 違反時の保存

- hard 制約違反でも、確認ダイアログ付きで保存を許可する。現場の正当な例外変更（「今回だけ分ける」等）を阻害しない。
- soft 制約違反は警告のみで、確認ダイアログは不要。

### Discord 投稿の任意性

- グループ分けは試行錯誤的な作業（DnD → 確認 → 修正）のため、保存と Discord 投稿を分離する。
- 「結果をチャンネルへ投稿」ボタンを明示的に押したときのみ投稿する。Assignment の「即投稿」とは異なる。
- 投稿先は通知の `channel_id`（Assignment と同じ）。

### UI/技術選定

- **設定の場所**：制約の設定・編集はグループ分け操作画面内で行う（Notification 設定画面ではない）。参加者の名前を見ながら設定でき、フィードバックループが短い。
- **DnD ライブラリ**：SortableJS（~14KB gzip）を採用し、TanStack Table-core と同様に esbuild で IIFE バンドルして `ui/` に配置する。HTML5 Drag and Drop API は複数コンテナ間のドラッグで実装が煩雑になりバグを生みやすい。
- **グループ名**：カスタム名を持てる（既定は「グループ 1」「グループ 2」…）。実運用で「控室1」「レッスン室A」等の具体的な名前が必要になるため。

### 用語の衝突回避

- CONTEXT.md の Server 定義にあった `_Avoid_: グループ` は、「Discord サーバーを『グループ』と呼ぶな」という意味であり、参加者グループ分けの「グループ」とは別概念。注記を追加して区別する。

## 根拠

- **Occurrence 単位の Grouping**：参加者は回ごとに変動する出欠の性質上、毎回独立した編成が自然。Notification 単位だと「テンプレートにいるが今回不参加」の扱いが複雑化する。
- **Notification 単位の Constraint**：繰り返し開催で毎回入力し直すのは非実用的。一方、Segment 単位だと制約が広すぎて通知ごとの使い分けができない。
- **direction + strength の 2 軸**：マイグレーション不変の原則上、最初に拡張性を確保するコストは低い。フラット enum（`required_together | preferred_together | ...`）は値が増えるたびに意味解読が必要になる。
- **Assignment との完全独立**：目的が異なる（番号 vs チーム）。併用可能にすることで「グループ分けした上で各人に番号も振る」運用にも対応できる。
- **保存と Discord 投稿の分離**：DnD 操作は試行錯誤的で、保存＝確定とすると「まだ調整中なのに投稿してしまった」事故が起きうる。
- **SortableJS 導入**：複数コンテナ間 DnD の実装コスト差が大きく、14KB のサイズ増は許容範囲。既存の IIFE バンドル方式に揃えられる。

## トレードオフ

- **自動配置の最適性は限定的**：required + together のみ厳密に遵守し、apart や preferred は試行的考慮にとどめる。完全な最適化（制約充足問題ソルバー）は実装コストに見合わない。違反検出 + 手動微調整で十分実用的と判断。
- **回答変更の自動反映なし**：スナップショット方針のため、参加状況が変わった場合は運用者の手動調整が必要。自動反映だと「なぜこの配置になったか」が追えなくなる副作用が大きい。
- **Constraint スコープが Notification 固定**：1 回限りの特殊な制約（「今回のこの回だけ一緒にしたい」）は、Notification の制約として登録するか、グループ分け画面で手動配置して保存するかの 2 択になる。Occurrence 単位の制約は v1 では持たない。
- **Group メンバーシップは Occurrence 単位の独立テーブル**：参加者の所属を `responses` に持たせる選択肢もあったが、責務分離のため別テーブルにする。`responses` は出欠表明、`group_members` はグループ編成と分けて理解できる。
- **SortableJS 追加で配布物が増える**：BOOTH 配布物は `setup.html` 単体のみ（ADR 0011）で、これは利用者の fork 経由でデプロイされるので配布物の体積には影響しない。ただし Worker のアセットサイズが若干増える。
- **Discord 投稿のフォーマットは固定**：v1 では「グループ名: メンバー一覧」の単純なフォーマット。カスタマイズ性は将来要望が出てから検討する。

## スキーマ影響（migration 0011）

- `notifications.grouping_enabled INTEGER NOT NULL DEFAULT 0`
- 新テーブル `groupings`：
  - `id INTEGER PRIMARY KEY`
  - `occurrence_id INTEGER NOT NULL UNIQUE`（1 Occurrence = 1 Grouping）
  - `group_count INTEGER NOT NULL`
  - `created_at TEXT NOT NULL`
  - `updated_at TEXT NOT NULL`
- 新テーブル `groups`：
  - `id INTEGER PRIMARY KEY`
  - `grouping_id INTEGER NOT NULL`
  - `group_index INTEGER NOT NULL`（0..N-1、表示順）
  - `name TEXT NOT NULL`（既定「グループ N」）
  - `UNIQUE (grouping_id, group_index)`
- 新テーブル `group_members`：
  - `group_id INTEGER NOT NULL`
  - `user_id TEXT NOT NULL`
  - `PRIMARY KEY (group_id, user_id)`
  - 注：未割り当ては行を持たない（プールはアプリ層で「参加者 - 割り当て済み」で計算）
- 新テーブル `grouping_constraints`：
  - `id INTEGER PRIMARY KEY`
  - `notification_id INTEGER NOT NULL`
  - `user_id_a TEXT NOT NULL`
  - `user_id_b TEXT NOT NULL`
  - `direction TEXT NOT NULL CHECK (direction IN ('together', 'apart'))`
  - `strength TEXT NOT NULL CHECK (strength IN ('required', 'preferred'))`
  - `created_at TEXT NOT NULL`
  - `UNIQUE (notification_id, user_id_a, user_id_b)`（ペアは a < b で正規化して保存）
