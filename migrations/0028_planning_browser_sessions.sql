-- Browser identity is scoped to a guild and survives individual plan deletion.
-- Store only a SHA-256 hash of the random cookie, never the credential itself.
CREATE TABLE planning_browser_sessions (
  token_hash TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_planning_browser_sessions_expiry ON planning_browser_sessions(expires_at);
