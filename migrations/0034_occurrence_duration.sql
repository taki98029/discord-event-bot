-- 開催時間を開催回ごとに持つ。単発出欠確認のテンプレートから開始時刻・開催時間の入力欄を外したため（2026-09-23）、
-- 「＋ 開催日時を追加」で開催回ごとに分を登録する。NULL = 雛形（notifications.duration_minutes）に従う（0007 と同じ意味）。
ALTER TABLE occurrences ADD COLUMN duration_minutes INTEGER;
