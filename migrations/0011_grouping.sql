-- グループ分け機能（ADR 0015）。既存マイグレーションは編集禁止。新連番として追加する。
-- 内容: notifications.grouping_enabled / 新テーブル groupings, groups, group_members, grouping_constraints。

-- 機能有効化フラグ（既存 assignment_enabled と同パターン）。
ALTER TABLE notifications ADD COLUMN grouping_enabled INTEGER NOT NULL DEFAULT 0;

-- 1 Occurrence あたり 1 つ。グループ数のみ持ち、実体は groups / group_members に分離。
CREATE TABLE IF NOT EXISTS groupings (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  occurrence_id INTEGER NOT NULL UNIQUE,
  group_count   INTEGER NOT NULL,
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL
);

-- グループ実体。表示順（group_index）と名前を持つ。
CREATE TABLE IF NOT EXISTS groups (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  grouping_id  INTEGER NOT NULL,
  group_index  INTEGER NOT NULL,
  name         TEXT    NOT NULL,
  UNIQUE (grouping_id, group_index)
);
CREATE INDEX IF NOT EXISTS idx_groups_grouping ON groups(grouping_id);

-- グループへのメンバー所属。未割り当ては行を持たない（プールはアプリ層で計算）。
CREATE TABLE IF NOT EXISTS group_members (
  group_id INTEGER NOT NULL,
  user_id  TEXT    NOT NULL,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_id);

-- ペア制約（Notification 単位で永続化）。
-- direction: together = 同一グループ / apart = 別グループ
-- strength:  required = 必須（赤エラー） / preferred = 推奨（黄警告）
-- ペアは (user_id_a < user_id_b) で正規化して保存（重複防止）。
CREATE TABLE IF NOT EXISTS grouping_constraints (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  notification_id INTEGER NOT NULL,
  user_id_a       TEXT    NOT NULL,
  user_id_b       TEXT    NOT NULL,
  direction       TEXT    NOT NULL CHECK (direction IN ('together', 'apart')),
  strength        TEXT    NOT NULL CHECK (strength IN ('required', 'preferred')),
  created_at      TEXT    NOT NULL,
  UNIQUE (notification_id, user_id_a, user_id_b)
);
CREATE INDEX IF NOT EXISTS idx_constraints_notif ON grouping_constraints(notification_id);
