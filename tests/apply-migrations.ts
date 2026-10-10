import { beforeEach } from 'vitest';
import { applyD1Migrations, env } from 'cloudflare:test';

// テーブル作成（マイグレーション）はテストワーカー起動時に一度だけ適用する。
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// vitest-pool-workers 0.16 では isolatedStorage が廃止されたため、
// 各テスト前に全テーブルを空にしてテスト間の独立性を担保する。
// Event 廃止後のテーブル群（Server[guild_id] ＞ notifications → segments ＞ occurrences ほか）。
beforeEach(async () => {
  await env.DB.batch([
    // メンバー配置（migration 0011）と回答の変更履歴。子から順に消す
    env.DB.prepare('DELETE FROM group_members'),
    env.DB.prepare('DELETE FROM groups'),
    env.DB.prepare('DELETE FROM groupings'),
    env.DB.prepare('DELETE FROM grouping_constraints'),
    env.DB.prepare('DELETE FROM response_log'),
    env.DB.prepare('DELETE FROM planning_browser_sessions'),
    env.DB.prepare('DELETE FROM planning_sessions'),
    env.DB.prepare('DELETE FROM planning_history'),
    env.DB.prepare('DELETE FROM planning_deliveries'),
    env.DB.prepare('DELETE FROM planning_roster'),
    env.DB.prepare('DELETE FROM planning_occurrences'),
    env.DB.prepare('DELETE FROM planning_cycles'),
    env.DB.prepare('DELETE FROM planning_plans'),

    env.DB.prepare('DELETE FROM responses'),
    env.DB.prepare('DELETE FROM occurrences'),
    env.DB.prepare('DELETE FROM notifications'),
    env.DB.prepare('DELETE FROM segment_members'),
    env.DB.prepare('DELETE FROM members'),
    // ギルドごとの表示名（migration 0020）
    env.DB.prepare('DELETE FROM member_guild_profiles'),
    env.DB.prepare('DELETE FROM segments'),
    // オーバーホールで追加（migration 0010）。テスト間で送信ログ/設定が漏れないよう毎回クリアする。
    env.DB.prepare('DELETE FROM send_log'),
    env.DB.prepare('DELETE FROM config'),
  ]);
});
