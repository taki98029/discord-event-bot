-- UUID シャドウキー（ADR 0016）。URL／API に露出する 6 テーブルに uuid TEXT 列を追加し、
-- 既存行を 8-4-4-4-12 形式（16 ランダムバイトの hex）でバックフィルする。
-- 一意性は UNIQUE INDEX で担保。NOT NULL はアプリ層で保証する（SQLite の ALTER TABLE では
-- 後付けで NOT NULL 制約を強制できないため）。Discord 由来の ID（guild_id / channel_id /
-- user_id / role_id）は不可侵で、INTEGER PK と UUID は併存する（INTEGER PK は内部結合用、
-- UUID は URL／API 表面用）。
-- 既存マイグレーションは編集禁止。新連番として追加する。

ALTER TABLE notifications ADD COLUMN uuid TEXT;
ALTER TABLE segments ADD COLUMN uuid TEXT;
ALTER TABLE occurrences ADD COLUMN uuid TEXT;
ALTER TABLE groupings ADD COLUMN uuid TEXT;
ALTER TABLE groups ADD COLUMN uuid TEXT;
ALTER TABLE grouping_constraints ADD COLUMN uuid TEXT;

-- バックフィル。randomblob(16) は volatile で行ごとに評価されるため、各行へ別 UUID が入る。
-- 厳密な UUID v4（version=4, variant=10xx）にはこだわらず、長さ 36 字＋ハイフン 4 本で揃える。
-- 新規行は crypto.randomUUID()（Workers ネイティブ）で完全 v4 として発番する。
UPDATE notifications SET uuid = lower(
  substr(hex(randomblob(4)), 1, 8) || '-' ||
  substr(hex(randomblob(2)), 1, 4) || '-' ||
  substr(hex(randomblob(2)), 1, 4) || '-' ||
  substr(hex(randomblob(2)), 1, 4) || '-' ||
  substr(hex(randomblob(6)), 1, 12)
) WHERE uuid IS NULL;

UPDATE segments SET uuid = lower(
  substr(hex(randomblob(4)), 1, 8) || '-' ||
  substr(hex(randomblob(2)), 1, 4) || '-' ||
  substr(hex(randomblob(2)), 1, 4) || '-' ||
  substr(hex(randomblob(2)), 1, 4) || '-' ||
  substr(hex(randomblob(6)), 1, 12)
) WHERE uuid IS NULL;

UPDATE occurrences SET uuid = lower(
  substr(hex(randomblob(4)), 1, 8) || '-' ||
  substr(hex(randomblob(2)), 1, 4) || '-' ||
  substr(hex(randomblob(2)), 1, 4) || '-' ||
  substr(hex(randomblob(2)), 1, 4) || '-' ||
  substr(hex(randomblob(6)), 1, 12)
) WHERE uuid IS NULL;

UPDATE groupings SET uuid = lower(
  substr(hex(randomblob(4)), 1, 8) || '-' ||
  substr(hex(randomblob(2)), 1, 4) || '-' ||
  substr(hex(randomblob(2)), 1, 4) || '-' ||
  substr(hex(randomblob(2)), 1, 4) || '-' ||
  substr(hex(randomblob(6)), 1, 12)
) WHERE uuid IS NULL;

UPDATE groups SET uuid = lower(
  substr(hex(randomblob(4)), 1, 8) || '-' ||
  substr(hex(randomblob(2)), 1, 4) || '-' ||
  substr(hex(randomblob(2)), 1, 4) || '-' ||
  substr(hex(randomblob(2)), 1, 4) || '-' ||
  substr(hex(randomblob(6)), 1, 12)
) WHERE uuid IS NULL;

UPDATE grouping_constraints SET uuid = lower(
  substr(hex(randomblob(4)), 1, 8) || '-' ||
  substr(hex(randomblob(2)), 1, 4) || '-' ||
  substr(hex(randomblob(2)), 1, 4) || '-' ||
  substr(hex(randomblob(2)), 1, 4) || '-' ||
  substr(hex(randomblob(6)), 1, 12)
) WHERE uuid IS NULL;

-- 一意制約。UNIQUE INDEX は NULL を区別するため、NULL 行は重複しないが許容される。
-- 新規行が必ず uuid を持つことはアプリ層で担保する（src/db/*.ts の create 系で crypto.randomUUID()）。
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_uuid ON notifications(uuid);
CREATE UNIQUE INDEX IF NOT EXISTS idx_segments_uuid ON segments(uuid);
CREATE UNIQUE INDEX IF NOT EXISTS idx_occurrences_uuid ON occurrences(uuid);
CREATE UNIQUE INDEX IF NOT EXISTS idx_groupings_uuid ON groupings(uuid);
CREATE UNIQUE INDEX IF NOT EXISTS idx_groups_uuid ON groups(uuid);
CREATE UNIQUE INDEX IF NOT EXISTS idx_grouping_constraints_uuid ON grouping_constraints(uuid);
