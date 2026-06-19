/// <reference types="@cloudflare/vitest-pool-workers/types" />
import type { D1Migration } from '@cloudflare/vitest-pool-workers';

declare global {
  namespace Cloudflare {
    // src/env.ts の Env と整合させ、cloudflare:test の env をアプリ関数（syncSegmentFromRole 等）へ
    // そのまま渡せるようにする。値は wrangler.toml / .dev.vars / vitest.config の bindings 由来。
    interface Env {
      DB: D1Database;
      TEST_MIGRATIONS: D1Migration[];
      ASSETS: Fetcher;
      DISCORD_PUBLIC_KEY: string;
      DISCORD_APPLICATION_ID: string;
      DISCORD_BOT_TOKEN: string;
      ADMIN_TOKEN: string;
      MOCK_DISCORD?: string;
    }
  }
}
