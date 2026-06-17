-- 単発イベントの複数「日付＋時間帯」スロット対応。
-- occurrences に start_time を持たせ、一意性を (notification_id, occurrence_date) →
-- (notification_id, occurrence_date, start_time) に変更する（同一日に複数時刻の候補を許可）。
-- SQLite はテーブル定義の UNIQUE を ALTER で外せないため再構築する。
-- ★ responses / assignments / notifications.decided_occurrence_id は occurrence の id を参照する
--   （FK 制約は無い）。INSERT SELECT で id を明示保持しないと参照が全て迷子になるため必ず id を列挙する。

DROP TABLE IF EXISTS occurrences_new;  -- 再適用に備えた冪等化

CREATE TABLE occurrences_new (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  notification_id INTEGER NOT NULL,
  occurrence_date TEXT NOT NULL,                       -- 'YYYY/MM/DD'(JST)
  start_time      TEXT NOT NULL DEFAULT '',            -- 'HH:MM'(JST)。スロットの開始時刻
  status          TEXT NOT NULL DEFAULT 'scheduled',   -- 'scheduled' | 'cancelled'
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (notification_id, occurrence_date, start_time)
);

-- 既存行を移送。id は明示保持。start_time は所属 notification の start_time でバックフィル。
INSERT INTO occurrences_new (id, notification_id, occurrence_date, start_time, status, created_at)
  SELECT id, notification_id, occurrence_date,
         COALESCE((SELECT n.start_time FROM notifications n WHERE n.id = occurrences.notification_id), ''),
         status, created_at
  FROM occurrences;

DROP TABLE occurrences;
ALTER TABLE occurrences_new RENAME TO occurrences;

CREATE INDEX IF NOT EXISTS idx_occurrences_notif ON occurrences(notification_id);
