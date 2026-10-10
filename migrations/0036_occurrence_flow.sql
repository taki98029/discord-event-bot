-- 単発出欠確認の送信時刻と投稿の流れ（募集の自動投稿・未回答／未定リマインド）を開催回ごとに持つ（ユーザー指示・2026-09-23）。
-- テンプレートの入力欄は外し、「＋ 開催日時を追加」で登録する。NULL = テンプレート（notifications）の保存値に従う。
-- 定期の臨時回は使わない（常に NULL）。
ALTER TABLE occurrences ADD COLUMN send_hour INTEGER;
ALTER TABLE occurrences ADD COLUMN recruit_enabled INTEGER CHECK (recruit_enabled IN (0, 1));
ALTER TABLE occurrences ADD COLUMN recruit_days_before INTEGER;
ALTER TABLE occurrences ADD COLUMN remind_unanswered_enabled INTEGER CHECK (remind_unanswered_enabled IN (0, 1));
ALTER TABLE occurrences ADD COLUMN remind_start_days INTEGER;
ALTER TABLE occurrences ADD COLUMN remind_undecided_enabled INTEGER CHECK (remind_undecided_enabled IN (0, 1));
ALTER TABLE occurrences ADD COLUMN remind_undecided_days INTEGER;
ALTER TABLE occurrences ADD COLUMN remind_target TEXT CHECK (remind_target IN ('dm', 'channel'));
ALTER TABLE occurrences ADD COLUMN remind_undecided_target TEXT CHECK (remind_undecided_target IN ('dm', 'channel'));
