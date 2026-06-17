-- Event 層を廃止し、Notification を guild_id で Server に直結する（ADR 0005）。
-- 0003 で events / segments に付けた guild_id のうち、events 側の値を notifications へ移送してから
-- events を破棄する。segments.guild_id はそのまま維持。
-- ※ D1 / SQLite(3.35+) は DROP COLUMN 可。対象列を参照するインデックスは先に落とす。

-- 1. notifications に guild_id を追加（既存行は所属 event の guild_id を継承）
ALTER TABLE notifications ADD COLUMN guild_id TEXT NOT NULL DEFAULT '';
UPDATE notifications
   SET guild_id = COALESCE((SELECT e.guild_id FROM events e WHERE e.id = notifications.event_id), '');

-- 2. event_id を撤去（参照インデックスを先に削除）
DROP INDEX IF EXISTS idx_notifications_event;
ALTER TABLE notifications DROP COLUMN event_id;

-- 3. guild_id インデックスを張り、events を破棄
CREATE INDEX IF NOT EXISTS idx_notifications_guild ON notifications(guild_id);
DROP TABLE IF EXISTS events;
