-- ChoiemuEventBot D1 初期スキーマ
-- 旧 Google Sheets（Config / Member_DB / Event_Log）を D1 テーブル化したもの。

-- 設定（旧 Config シート）: キー・バリュー型
CREATE TABLE IF NOT EXISTS config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- メンバーマスタ（旧 Member_DB シート）
CREATE TABLE IF NOT EXISTS members (
  user_id       TEXT PRIMARY KEY,         -- Discord User ID
  user_name     TEXT,                     -- 管理用名（旧 A 列）
  status        TEXT NOT NULL DEFAULT '', -- 休止中/スタッフ等。空=アクティブ（旧 C 列）
  display_name  TEXT,                     -- 表示名・自動更新（旧 D 列）
  dm_channel_id TEXT,                     -- DM チャンネル ID キャッシュ（サブリクエスト削減）
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 出欠記録（旧 Event_Log シート）
CREATE TABLE IF NOT EXISTS event_log (
  event_date TEXT NOT NULL,               -- 'YYYY/MM/DD'（JST・ゼロ埋めで辞書順=時系列順）
  user_id    TEXT NOT NULL,
  user_name  TEXT,
  status     TEXT NOT NULL,               -- 参加/不参加/未定
  updated_at TEXT NOT NULL,
  PRIMARY KEY (event_date, user_id)       -- upsert の自然キー
);

CREATE INDEX IF NOT EXISTS idx_event_log_user ON event_log(user_id);
