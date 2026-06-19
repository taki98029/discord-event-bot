-- 通知の体裁（ADR 0010）: 回答要否・メンション方法・カスタムメッセージ（見出し/本文）。
--
-- requires_response: recurring が出欠回答を集めるか。0=回答不要（通知のみ・ボタンなし）。
--   既定 1（既存行はすべて回答ありなので維持）。oneoff は常に回答あり（アプリ側で 1 に固定）。
-- mention_mode: 'none' | 'role' | 'members'。旧 mention_enabled を置換する
--   （1→'role', 0→'none'）。mention_enabled 列は後方互換のため残置するが本体は参照しない。
-- message_title: 投稿の見出し（必須・1 行）。既存行は現行文言 'イベント募集開始!' でバックフィル。
-- message_body: 投稿本文（任意・複数行）。NULL=本文なし。
ALTER TABLE notifications ADD COLUMN requires_response INTEGER NOT NULL DEFAULT 1;
ALTER TABLE notifications ADD COLUMN mention_mode TEXT NOT NULL DEFAULT 'role';
ALTER TABLE notifications ADD COLUMN message_title TEXT NOT NULL DEFAULT '';
ALTER TABLE notifications ADD COLUMN message_body TEXT;

-- 旧 mention_enabled からメンション方法を移行（1=ロールメンション有→'role' / 0=無→'none'）。
UPDATE notifications SET mention_mode = CASE WHEN mention_enabled = 1 THEN 'role' ELSE 'none' END;

-- 既存行の見出しを現行の募集文言でバックフィル（挙動を維持・以後ユーザーが各通知で編集可能）。
UPDATE notifications SET message_title = 'イベント募集開始!' WHERE message_title = '';
