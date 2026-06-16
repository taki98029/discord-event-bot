import {
  defineWorkersConfig,
  readD1Migrations,
} from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig(async () => {
  // migrations/ の .sql を読み込み、テスト用 D1 に適用する
  const migrations = await readD1Migrations('migrations');

  return {
    test: {
      setupFiles: ['./tests/apply-migrations.ts'],
      poolOptions: {
        workers: {
          singleWorker: true,
          isolatedStorage: true,
          miniflare: {
            bindings: { TEST_MIGRATIONS: migrations },
          },
          wrangler: { configPath: './wrangler.toml' },
        },
      },
    },
  };
});
