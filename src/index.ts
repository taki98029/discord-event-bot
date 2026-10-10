import { planningTick } from './planning/cron';
import type { Env } from './env';
import { handleInteraction } from './interactions';
import { handleAdmin } from './admin';
import { isPlanningMinute, runTick } from './cron/tick';
import { handlePlanningAnswer } from './planning/web-answer';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/planning/answers/')) return handlePlanningAnswer(request, env);

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

  // 毎分 cron（wrangler.jsonc の triggers.crons: * * * * *）を 1 本だけ使い、奇数分＝出欠確認（runTick・ADR 0013）、
  // 偶数分＝日程調整（planningTick）に振り分ける。実行ごとの上限（CPU 10ms・D1 50 クエリ・subrequest 50）を
  // 両者で分け合わないための分離（ADR 0033）。cron を 2 本にすると Free のアカウント上限 5 本を食うため 1 本で交互にする。
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(isPlanningMinute(event.scheduledTime) ? planningTick(env) : runTick(env));
  },
} satisfies ExportedHandler<Env>;
