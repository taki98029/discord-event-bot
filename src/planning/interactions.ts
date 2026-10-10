import type { Env } from '../env';
import { getPlan } from './store';
import { PlanningError, requireValue, type Plan } from './model';
import { planningError, PLANNING_FLAGS, type PlanningResponse } from './answer-view';
import { issuePlanningLink } from './web-answer';

export interface PlanningInteraction {
  type: number;
  guild_id?: string;
  member?: { user?: { id: string } };
  user?: { id: string };
  message?: { id?: string; flags?: number };
  data?: { custom_id?: string; values?: string[] };
}
export function requirePlanningUser(i: PlanningInteraction, p: Plan): string {
  const user = i.member?.user?.id ?? i.user?.id;
  requireValue(
    user && (i.guild_id === p.guild_id || (!i.guild_id && i.user?.id === user)) && p.data.people.some((u) => u.id === user && u.active !== false),
    'この回答の対象者ではありません',
    403,
  );
  return user;
}

/** All historical plan controls now issue a private web link; old payloads never save answers. */
export async function planningInteraction(
  i: PlanningInteraction,
  env: Env,
  origin: string,
): Promise<PlanningResponse> {
  try {
    const id = i.data?.custom_id?.split(':')[2];
    requireValue(id && [3, 5].includes(i.type), 'この回答の対象者ではありません', 403);
    const p = await getPlan(env.DB, id);
    const user = requirePlanningUser(i, p);
    const url = await issuePlanningLink(env.DB, p, user, origin);
    return {
      type: 4,
      data: {
        flags: PLANNING_FLAGS,
        allowed_mentions: { parse: [] },
        components: [
          {
            type: 10,
            content:
              '下のボタンで、このブラウザーに回答者を30日間記憶します。同じサーバーでは、次回から案内の「回答画面を開く」で直接回答できます。\nこの本人用リンクは15分以内に一度だけ使えます（使ったあとは案内の「回答画面を開く」から開けます）。他の人に共有しないでください。共有端末では、回答後に画面の「記憶を解除」を押してください。',
          },
          { type: 1, components: [{ type: 2, style: 5, label: '回答画面を開く', url }] },
        ],
      },
    };
  } catch (e) {
    return planningError(
      e instanceof PlanningError
        ? e.message
        : '回答リンクを発行できませんでした。Discordの案内からもう一度お試しください。',
    );
  }
}
