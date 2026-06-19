import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      // migrations/ の .sql を読み込み、テスト用 D1（Miniflare）に適用する
      const migrations = await readD1Migrations('migrations');
      return {
        miniflare: {
          // MOCK_DISCORD=1: Discord API 呼び出しをフィクスチャで代替（ADR 0008）。ロール同期テスト用。
          bindings: { TEST_MIGRATIONS: migrations, MOCK_DISCORD: '1' },
        },
        wrangler: { configPath: './wrangler.toml' },
      };
    }),
  ],
  test: {
    setupFiles: ['./tests/apply-migrations.ts'],
  },
});
