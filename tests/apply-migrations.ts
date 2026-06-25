import { beforeEach } from 'vitest';
import { applyD1Migrations, env } from 'cloudflare:test';

// テーブル作成（マイグレーション）はテストワーカー起動時に一度だけ適用する。
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// vitest-pool-workers 0.16 では isolatedStorage が廃止されたため、
// 各テスト前に全テーブルを空にしてテスト間の独立性を担保する。
// Event 廃止後の 7 テーブル（Server[guild_id] ＞ notifications → segments ＞ occurrences ほか）。
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM assignments'),
    env.DB.prepare('DELETE FROM responses'),
    env.DB.prepare('DELETE FROM occurrences'),
    env.DB.prepare('DELETE FROM notifications'),
    env.DB.prepare('DELETE FROM segment_members'),
    env.DB.prepare('DELETE FROM members'),
    env.DB.prepare('DELETE FROM segments'),
    // オーバーホールで追加（migration 0010）。テスト間で送信ログ/設定が漏れないよう毎回クリアする。
    env.DB.prepare('DELETE FROM send_log'),
    env.DB.prepare('DELETE FROM config'),
  ]);
});
