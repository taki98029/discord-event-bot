-- 単発(oneoff)イベントの複数候補日対応（候補日ごと出欠 ＋ 最終確定）。
-- 候補日は occurrences 行で表現する（status='scheduled'=候補 / 'cancelled'=除外・落選）。
-- 既存の occurrences / responses / ボタン(custom_id={action}_{occurrenceId}) をそのまま流用するため、
-- 追加するのは「確定した候補回」を記録する 1 列だけ。
ALTER TABLE notifications ADD COLUMN decided_occurrence_id INTEGER; -- NULL=未確定 / 確定した occurrences.id
