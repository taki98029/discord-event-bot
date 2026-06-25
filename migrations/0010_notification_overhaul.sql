-- 通知機能オーバーホール（ADR 0013 配信パイプライン / ADR 0014 回答締切）。
-- 既存マイグレーションは編集禁止。新連番として追加する。
-- 内容: notifications への列追加（①回答締切・③送信時刻）/ responses フラグ（①）/
--       新テーブル send_log（④可視化＝⑦冪等台帳兼カーソル）/ config 再作成（⑦送信予算）。

-- ① 回答締切（ADR 0014）-----------------------------------------------------
-- response_deadline_hours: 開催開始の N 時間前を回答締切とする。NULL=締切なし（既定）。
ALTER TABLE notifications ADD COLUMN response_deadline_hours INTEGER;
-- change_alert_channel_id: 締切後変更の通知先チャンネル。NULL=募集チャンネルにフォールバック。
ALTER TABLE notifications ADD COLUMN change_alert_channel_id TEXT;
-- post_deadline_change: その回答が締切後に変更された印（0/1）。回答履歴で識別する。
ALTER TABLE responses ADD COLUMN post_deadline_change INTEGER NOT NULL DEFAULT 0;

-- ③ 通知ごと送信時刻（ADR 0013）---------------------------------------------
-- send_hour: cron 駆動送信を JST の何時に送るか（0〜23）。開催の start_time とは別物。
-- 既定 21 は従来の cron 固定 21:00 を踏襲（既存行のバックフィル）。
ALTER TABLE notifications ADD COLUMN send_hour INTEGER NOT NULL DEFAULT 21;

-- ④⑦ 送信ログ（冪等台帳 兼 ペースカーソル 兼 可視化・ADR 0013）---------------
-- 1 送信ごとに記録。毎分 cron のペース配信は、この行の有無で「同日すでに送ったか」を判定し
-- 二重送信を防ぐ。SQLite の UNIQUE は NULL を区別するため、冪等鍵の列は NOT NULL＋センチネル
-- （occurrence_id=0＝開催回に紐づかない（ノルマ等） / user_id=''＝チャンネル投稿で個人宛なし）。
CREATE TABLE IF NOT EXISTS send_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  notification_id INTEGER NOT NULL,
  occurrence_id   INTEGER NOT NULL DEFAULT 0,   -- 0 = 開催回に紐づかない
  user_id         TEXT    NOT NULL DEFAULT '',  -- '' = チャンネル投稿（個人宛なし）
  kind            TEXT    NOT NULL,             -- recruit|remind_unanswered|remind_undecided|quota|deadline_notice
  send_date       TEXT    NOT NULL,             -- 'YYYY/MM/DD'(JST)。同日冪等の鍵
  status          TEXT    NOT NULL,             -- sent | failed
  error           TEXT,                          -- 失敗理由（DM 拒否等）。成功時 NULL
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (notification_id, occurrence_id, user_id, kind, send_date)
);
CREATE INDEX IF NOT EXISTS idx_send_log_notif ON send_log(notification_id);
CREATE INDEX IF NOT EXISTS idx_send_log_date  ON send_log(send_date);

-- ⑦ プラン別送信予算（key/value 設定）----------------------------------------
-- config は 0002 で破棄されているため再作成する。send_budget_per_tick = 1 cron ティックで
-- 投げる Discord API 呼び出し上限。Free 既定 45（subrequest 50 律速の安全側）。Paid 化時に
-- 値を上げると上限を突破できる（コード分岐なし）。
CREATE TABLE IF NOT EXISTS config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO config (key, value) VALUES ('send_budget_per_tick', '45');
