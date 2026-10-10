-- Where the unanswered/undecided reminders go: 'dm' (existing behaviour) or 'channel'
-- (one post per day to the recruit channel mentioning the members). CCL review C02, 2026-09-20.
ALTER TABLE notifications ADD COLUMN remind_target TEXT NOT NULL DEFAULT 'dm'
  CHECK (remind_target IN ('dm', 'channel'));
