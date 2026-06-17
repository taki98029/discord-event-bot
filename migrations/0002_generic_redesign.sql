-- 汎用リデザイン: 単一定例モデル → Event ＞ Notification → Segment ＞ Occurrence
-- ※ Event 層は後続の ADR 0005 / migration 0004 で廃止し、Notification は guild_id で Server に直結する。
-- ⚠️ 破壊的マイグレーション。旧 config / members / event_log を破棄して再構築する。
--    本番データは存在せず（本番は旧 Vercel 版が別系統で稼働）、テスト D1 のデータは使い捨て前提。

DROP TABLE IF EXISTS event_log;
DROP TABLE IF EXISTS members;
DROP TABLE IF EXISTS config;

-- Event: 束ねる最上位グループ
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Segment（区分）: 設定可能なメンバー区分。@メンション用 Discord ロールを任意紐付け
CREATE TABLE IF NOT EXISTS segments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  mention_role_id TEXT,                  -- Discord ロールID / '@everyone' / NULL
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- メンバーマスタ（グローバル・人物単位）。休止状態は segment_members 側に持つ
CREATE TABLE IF NOT EXISTS members (
  user_id       TEXT PRIMARY KEY,        -- Discord User ID
  user_name     TEXT,
  display_name  TEXT,
  dm_channel_id TEXT,                     -- DM チャンネル ID キャッシュ
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 所属（Member × Segment）＋ 区分ごとの休止状態
CREATE TABLE IF NOT EXISTS segment_members (
  segment_id INTEGER NOT NULL,
  user_id    TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT '',    -- '' = アクティブ / '休止中'
  joined_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (segment_id, user_id)
);

-- Notification（通知）: 独立トラック
CREATE TABLE IF NOT EXISTS notifications (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id              INTEGER NOT NULL,
  segment_id            INTEGER NOT NULL,
  name                  TEXT NOT NULL,
  channel_id            TEXT NOT NULL,
  type                  TEXT NOT NULL DEFAULT 'recurring', -- 'recurring' | 'oneoff'
  rrule                 TEXT,                 -- recurring: RFC5545 RRULE 文字列
  one_off_date          TEXT,                 -- oneoff: 'YYYY/MM/DD'
  anchor_date           TEXT,                 -- recurring の系列基準日（隔週パリティ用・任意）
  start_time            TEXT NOT NULL DEFAULT '21:00',     -- 'HH:MM'(JST)
  recruit_days_before   INTEGER NOT NULL DEFAULT 7,
  remind_start_days     INTEGER NOT NULL DEFAULT 3,
  remind_undecided_days INTEGER NOT NULL DEFAULT 1,
  quota_enabled         INTEGER NOT NULL DEFAULT 0,
  quota_interval_days   INTEGER,
  assignment_enabled    INTEGER NOT NULL DEFAULT 0,
  mention_enabled       INTEGER NOT NULL DEFAULT 1,
  active                INTEGER NOT NULL DEFAULT 1,
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Occurrence（開催回）: 募集時に遅延生成
CREATE TABLE IF NOT EXISTS occurrences (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  notification_id INTEGER NOT NULL,
  occurrence_date TEXT NOT NULL,           -- 'YYYY/MM/DD'(JST)
  status          TEXT NOT NULL DEFAULT 'scheduled', -- 'scheduled' | 'cancelled'
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (notification_id, occurrence_date)
);

-- Response（回答・旧 event_log）
CREATE TABLE IF NOT EXISTS responses (
  occurrence_id INTEGER NOT NULL,
  user_id       TEXT NOT NULL,
  user_name     TEXT,
  status        TEXT NOT NULL,             -- 参加 / 不参加 / 未定
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (occurrence_id, user_id)
);

-- Assignment（番号割り当て）: 開催回ごとにユニークな連番
CREATE TABLE IF NOT EXISTS assignments (
  occurrence_id INTEGER NOT NULL,
  user_id       TEXT NOT NULL,
  number        INTEGER NOT NULL,
  assigned_at   TEXT NOT NULL,
  PRIMARY KEY (occurrence_id, user_id),
  UNIQUE (occurrence_id, number)
);

CREATE INDEX IF NOT EXISTS idx_notifications_event   ON notifications(event_id);
CREATE INDEX IF NOT EXISTS idx_notifications_segment ON notifications(segment_id);
CREATE INDEX IF NOT EXISTS idx_segment_members_user  ON segment_members(user_id);
CREATE INDEX IF NOT EXISTS idx_occurrences_notif     ON occurrences(notification_id);
CREATE INDEX IF NOT EXISTS idx_responses_user        ON responses(user_id);
CREATE INDEX IF NOT EXISTS idx_responses_occurrence  ON responses(occurrence_id);
