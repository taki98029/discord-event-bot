-- 日程調整の変更履歴を計画ごとに新しい順で引く（WHERE plan_id=? ORDER BY id DESC）ための索引。
-- 索引が無いと全計画の履歴を走査する（2026-10-03 リリース前レビュー A6-02）。既存データは変わらない。
CREATE INDEX IF NOT EXISTS idx_planning_history_plan ON planning_history(plan_id, id);
