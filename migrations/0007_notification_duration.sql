-- 開催時間（duration）対応。予定確保の From-To 表示のため、Notification に所要分を持たせる。
-- 値は分（INTEGER）。NULL / 0 以下 = 未設定で、従来どおり開始時刻のみ「HH:MM〜」で表示する。
-- 候補スロットは「同一イベントの代替開始時刻」のため長さは全候補共通＝Notification 単位で持つ
--   （スロット同一性キー (notification_id, occurrence_date, start_time) は不変・同期ロジック無改修）。
-- recurring でも同じ列を流用して From-To 表示できる。
ALTER TABLE notifications ADD COLUMN duration_minutes INTEGER;
