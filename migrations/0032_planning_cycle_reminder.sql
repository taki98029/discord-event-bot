-- 日程候補作成のリマインドは下書きの日程調整を作らず、テンプレート（planning_cycles）の行だけで進める（2026-09-23）。
-- task_status: 'pending' のあいだ、期限（next_date）の N 日前から期限まで毎日投稿する。
--              テンプレートを使う日程調整の回答案内が投稿されると 'complete'。期限を過ぎると次の期限へ進めて 'pending' に戻す。
-- reminded_on: その日（JST）の投稿を 1 回にするための日付。
ALTER TABLE planning_cycles ADD COLUMN task_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE planning_cycles ADD COLUMN reminded_on TEXT;
-- 下書きに紐づく未送信のリマインドは送らない。planning_tasks（下書きごとの依頼）は役目を終えたので落とす。
UPDATE planning_deliveries SET status='cancelled', error='下書きの自動作成を廃止' WHERE kind='task' AND status='pending';
DROP TABLE planning_tasks;
