import type { Env } from '../env';
import { API, USER_AGENT } from '../discord/rest';

import { planningInteraction, type PlanningInteraction } from './interactions';
import type { PlanningResponse } from './answer-view';
import { planningError } from './answer-view';

export interface PlanningWebhookInteraction extends PlanningInteraction {
  application_id: string;
  token: string;
}

async function discordWebhook(url: string, method: string, body: unknown) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(6000),
    });
    if (res.ok) return;
    if (res.status === 429 && attempt === 0) {
      const delay = Number(((await res.json()) as { retry_after?: number }).retry_after);
      if (delay > 0 && delay <= 1) {
        await new Promise((resolve) => setTimeout(resolve, Math.ceil(delay * 1000)));
        continue;
      }
    }
    throw new Error(`Discord response ${res.status}`);
  }
}
async function patchPlanningResponse(i: PlanningWebhookInteraction, res: PlanningResponse) {
  await discordWebhook(`${API}/webhooks/${i.application_id}/${i.token}/messages/@original`, 'PATCH', {
    ...res.data,
    // EPHEMERAL is fixed by the initial response; PATCH accepts only editable message flags.
    flags: res.data.flags & ~64,
    content: null,
    embeds: null,
  });
}

export function planningDeferredResponse(_i: PlanningInteraction) {
  // Always create a private reply. Old answer screens and the public announcement stay untouched.
  return { type: 5, data: { flags: 64 } };
}

export async function respondToPlanningInteraction(
  i: PlanningWebhookInteraction,
  env: Env,
  origin: string,
): Promise<void> {
  try {
    await patchPlanningResponse(i, await planningInteraction(i, env, origin));
  } catch {
    try {
      await patchPlanningResponse(
        i,
        planningError('回答リンクを表示できませんでした。Discordの案内からもう一度お試しください。'),
      );
    } catch {
      console.error('[Planning] link response failed');
    }
  }
}
