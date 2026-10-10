-- NULL keeps the existing quota DM. Disabling quota does not remove the saved message.
ALTER TABLE notifications ADD COLUMN quota_message TEXT
  CHECK (quota_message IS NULL OR length(quota_message) <= 1500);
