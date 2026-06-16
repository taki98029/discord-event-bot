import { applyD1Migrations, env } from 'cloudflare:test';

// 各テストファイルのセットアップ時に D1 マイグレーションを適用する。
// isolatedStorage により、テストデータはテストごとにロールバックされる。
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
