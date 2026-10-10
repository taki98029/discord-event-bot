import { expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import { handleAdmin } from '../src/admin';
import { createSegment } from '../src/db/segments';

const E = { ...env, ADMIN_TOKEN: 'oneoff-test', MOCK_DISCORD: '1', DISCORD_BOT_TOKEN: 'dummy' } as Env;
const call = (method: string, path: string, body?: unknown) =>
  handleAdmin(
    new Request(`https://test.invalid/api/admin${path}`, {
      method,
      headers: { Authorization: 'Bearer oneoff-test', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    E,
  );

it('keeps a one-off schedule without a rule and fixes its type at creation', async () => {
  const s = await createSegment(env.DB, { guild_id: '1001', name: '対象者', mention_role_id: null });
  const body = { guild_id: '1001', segment_uuid: s.uuid, name: '単発会', channel_id: '2001', message_title: '募集', type: 'oneoff', rrule: 'FREQ=WEEKLY;BYDAY=SA', start_time: '20:00' };
  const res = await call('POST', '/notifications', body);
  expect(res.status).toBe(201);
  const n: any = await res.json();
  expect([n.type, n.rrule, n.start_time]).toEqual(['oneoff', null, '20:00']);
  // 編集で type を送らなくても（＝定期の形でも）単発のまま
  expect((await call('PUT', `/notifications/${n.uuid}`, { ...body, type: undefined, rrule: 'FREQ=WEEKLY;BYDAY=SA' })).status).toBe(200);
  const after: any = await (await call('GET', `/notifications/${n.uuid}`)).json();
  expect([after.type, after.rrule]).toEqual(['oneoff', null]);
});
