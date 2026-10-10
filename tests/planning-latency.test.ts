import { expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import { blankPlan } from '../src/planning/model';
import { createPlan } from '../src/planning/store';
import { handlePlanningAnswer } from '../src/planning/web-answer';
import { openWebAnswer, answerRequest } from './planning-web-client';

it('200候補の一括保存を1回のHTTP要求・1回の書込batchで処理する', async () => {
  const d = blankPlan('一括保存');
  d.state = 'open';
  d.deadline = '2099-01-01T00:00:00Z';
  d.people = [{ id: 'user1', name: '本人', schedules: [] }];
  d.candidates = Array.from({ length: 200 }, (_, i) => ({
    id: `candidate-${i}`,
    date: '2099-01-03',
    time: '',
    active: true,
  }));
  const p = await createPlan(env.DB, 'guild', d),
    E = env as unknown as Env;
  const s = await openWebAnswer(p, E);
  let batches = 0;
  const measured = {
    prepare: env.DB.prepare.bind(env.DB),
    batch: (statements: D1PreparedStatement[]) => {
      batches++;
      return env.DB.batch(statements);
    },
  } as D1Database;
  const result = await handlePlanningAnswer(
    answerRequest(p.id, s.cookie, {
      version: s.snapshot.version,
      values: Object.fromEntries(d.candidates.map((c) => [c.id, '未定'])),
      comment: '',
    }),
    { ...E, DB: measured },
  );
  expect(result.status).toBe(200);
  expect(batches).toBe(1);
});
