import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      // migrations/ の .sql を読み込み、テスト用 D1（Miniflare）に適用する
      const migrations = await readD1Migrations('migrations');
      return {
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations },
        },
        wrangler: { configPath: './wrangler.toml' },
      };
    }),
  ],
  test: {
    setupFiles: ['./tests/apply-migrations.ts'],
  },
});
