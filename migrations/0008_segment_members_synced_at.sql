-- ロール連携メンバー区分（ADR 0009）。区分メンバーを Discord ロールから完全同期した最終時刻。
-- mention_role_id を「メンション先＋メンバー源」に兼用する。NULL=未同期（手動区分 / ロール未設定）。
ALTER TABLE segments ADD COLUMN members_synced_at TEXT;
