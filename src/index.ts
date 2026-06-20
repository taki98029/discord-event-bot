import type { Env } from './env';
import { handleInteraction } from './interactions';
import { handleAdmin } from './admin';
import { mainDailyCheck } from './cron/dailyCheck';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Discord Interactions（公開・Ed25519 署名で保護）
    if (url.pathname === '/interactions' && request.method === 'POST') {
      return handleInteraction(request, env, ctx);
    }

    // 管理 API（ADMIN_TOKEN 認証）
    if (url.pathname.startsWith('/api/admin')) {
      return handleAdmin(request, env);
    }

    // それ以外は管理 UI（静的アセット / SPA フォールバック）
    return env.ASSETS.fetch(request);
  },

  // 日次 cron（wrangler.jsonc の triggers.crons: 0 12 * * * UTC = JST 21:00）
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(mainDailyCheck(env));
  },
} satisfies ExportedHandler<Env>;
