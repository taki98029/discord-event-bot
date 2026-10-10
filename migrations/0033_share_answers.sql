-- Whether 📊 状況確認 shows everyone's answers (1, existing behaviour) or only the presser's own (0).
-- Mirrors the planning shareAnswers switch; default public. 2026-09-23.
ALTER TABLE notifications ADD COLUMN share_answers INTEGER NOT NULL DEFAULT 1
  CHECK (share_answers IN (0, 1));
