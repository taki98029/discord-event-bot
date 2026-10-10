-- 不定期スケジュールの回答締切は開催回ごとに持つ（ADR 0032・2026-09-05）。
--
--   occurrences.response_deadline_hours : 開始の N 時間前（NULL ＝ この開催回は雛形 notifications.response_deadline_hours に従う）。
--     - 定期: 常に NULL（雛形の締切を全開催回に適用・ADR 0014 のまま）。
--     - 不定期: 雛形は NULL のまま（migration 0025 の正規化を維持）。自動募集なら開催回の追加時に、
--       手動募集なら 📣／/notify で投稿する瞬間に、開催回へ任意で付ける。
--   有効な締切 ＝ COALESCE(occurrences.response_deadline_hours, notifications.response_deadline_hours)。
--   「締切あり ⇒ 定期」の不変条件は「締切は雛形（定期）か開催回（不定期）のどちらか一方にだけ存在する」に置き換わる。
ALTER TABLE occurrences ADD COLUMN response_deadline_hours INTEGER;
