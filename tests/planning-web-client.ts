import type { Env } from '../src/env';
import type { Plan, PlanningAnswerSnapshot } from '../src/planning/model';
import { planningInteraction } from '../src/planning/interactions';
import { handlePlanningAnswer } from '../src/planning/web-answer';

export const ORIGIN = 'https://test.invalid';
export function answerRequest(id: string, cookie = '', body?: unknown, suffix = '') {
  return new Request(`${ORIGIN}/api/planning/answers/${id}${suffix}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json', Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
export async function openWebAnswer(p: Plan, env: Env, user = 'user1') {
  const reply = await planningInteraction(
    { type: 3, guild_id: p.guild_id, user: { id: user }, data: { custom_id: `plan:open:${p.id}:0` } },
    env,
    ORIGIN,
  );
  const url = new URL(reply.data.components[1].components[0].url);
  const key = url.hash.slice(1);
  const response = await handlePlanningAnswer(answerRequest(p.id, '', { key }, '/exchange'), env);
  if (!response.ok) throw new Error(`Test session failed: ${response.status}`);
  const cookie = response.headers.get('Set-Cookie')!.split(';')[0];
  const snapshot = (await response.json()) as PlanningAnswerSnapshot;
  return { url, key, cookie, snapshot, response };
}
