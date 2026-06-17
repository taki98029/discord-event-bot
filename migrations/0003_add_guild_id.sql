-- events / segments に guild_id を追加（マルチサーバー対応）
-- Discord Guild ID（Snowflake）。既存行は '' で初期化される。

ALTER TABLE events ADD COLUMN guild_id TEXT NOT NULL DEFAULT '';
ALTER TABLE segments ADD COLUMN guild_id TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_events_guild ON events(guild_id);
CREATE INDEX IF NOT EXISTS idx_segments_guild ON segments(guild_id);
