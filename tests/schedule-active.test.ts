import { expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import { handleAdmin } from '../src/admin';
import { createSegment } from '../src/db/segments';

const E = { ...env, ADMIN_TOKEN: 'active-test', MOCK_DISCORD: '1', DISCORD_BOT_TOKEN: 'dummy' } as Env;
const call = (method: string, path: string, body?: unknown) =>
  handleAdmin(
    new Request(`https://test.invalid/api/admin${path}`, {
      method,
      headers: { Authorization: 'Bearer active-test', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    E,
  );

it('toggles only the active flag of a schedule from the settings list', async () => {
  const s = await createSegment(env.DB, { guild_id: '1001', name: '対象者', mention_role_id: null });
  const res = await call('POST', '/notifications', { guild_id: '1001', segment_uuid: s.uuid, name: 'テスト会', channel_id: '2001', message_title: '募集', rrule: null, start_time: '21:00' });
  expect(res.status).toBe(201);
  const n: any = await res.json();
  expect(n.active).toBe(1);
  expect((await call('POST', `/notifications/${n.uuid}/active`, { active: false })).status).toBe(200);
  const off: any = await (await call('GET', `/notifications/${n.uuid}`)).json();
  expect(off.active).toBe(0);
  expect(off.message_title).toBe('募集');
  expect((await call('POST', `/notifications/${n.uuid}/active`, { active: 'yes' })).status).toBe(400);
  expect((await call('POST', '/notifications/00000000-0000-4000-8000-000000000000/active', { active: true })).status).toBe(404);
  expect((await call('POST', `/notifications/${n.uuid}/active`, { active: true })).status).toBe(200);
  expect(((await (await call('GET', `/notifications/${n.uuid}`)).json()) as any).active).toBe(1);
});
