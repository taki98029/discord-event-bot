-- 未定リマインドの送り先を未回答リマインドと別に持つ（ユーザー指示・2026-09-23）。
-- remind_target（0031）は以後「未回答リマインドの送り先」。既存行は同じ値で埋めて挙動を変えない。
ALTER TABLE notifications ADD COLUMN remind_undecided_target TEXT NOT NULL DEFAULT 'dm'
  CHECK (remind_undecided_target IN ('dm', 'channel'));
UPDATE notifications SET remind_undecided_target = remind_target;
