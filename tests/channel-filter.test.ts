import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import { handleAdmin } from '../src/admin';

const E = { ...env, ADMIN_TOKEN: 'channel-filter-test', MOCK_DISCORD: '1', DISCORD_BOT_TOKEN: 'dummy' } as unknown as Env;
const call = (path: string, body?: unknown) =>
  handleAdmin(
    new Request(`https://test.invalid/api/admin/guilds/1001/${path}`, {
      method: body === undefined ? 'GET' : 'PUT',
      headers: { Authorization: `Bearer ${E.ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    E,
  );
const enabledIds = async () =>
  ((await (await call('channels')).json()) as { id: string; enabled: boolean }[]).filter((c) => c.enabled).map((c) => c.id);

describe('チャンネル管理', () => {
  it('未設定は全部有効・保存したものだけ有効・null で全部に戻る・不正値は拒否', async () => {
    const all = await enabledIds();
    expect(all.length).toBeGreaterThan(1);

    expect((await call('channel-filter', { enabled: [all[0]] })).status).toBe(200);
    expect(await enabledIds()).toEqual([all[0]]);

    expect((await call('channel-filter', { enabled: null })).status).toBe(200);
    expect(await enabledIds()).toEqual(all);

    expect((await call('channel-filter', { enabled: ['abc'] })).status).toBe(400);
    expect((await call('channel-filter', {})).status).toBe(400);
  });
});
