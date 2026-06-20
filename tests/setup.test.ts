import { describe, it, expect } from 'vitest';
import { getSetupStatus } from '../src/admin/setup';
import { COMMAND_DEFINITIONS } from '../src/discord/commands';
import type { Env } from '../src/env';

function makeEnv(over: Partial<Env> = {}): Env {
  return {
    DISCORD_PUBLIC_KEY: 'pk',
    DISCORD_APPLICATION_ID: 'aid',
    DISCORD_BOT_TOKEN: 'bot',
    ADMIN_TOKEN: 'admin',
    ...over,
  } as unknown as Env;
}

describe('getSetupStatus', () => {
  it('リクエスト URL から Interaction Endpoint / 管理 URL を導出する', () => {
    const st = getSetupStatus(
      makeEnv(),
      new Request('https://example.workers.dev/api/admin/setup/status'),
    );
    expect(st.interaction_endpoint_url).toBe('https://example.workers.dev/interactions');
    expect(st.admin_url).toBe('https://example.workers.dev/');
  });

  it('シークレット未設定は false、設定済みは true（値は返さない）', () => {
    const st = getSetupStatus(
      makeEnv({ DISCORD_BOT_TOKEN: '' }),
      new Request('https://x.dev/api/admin/setup/status'),
    );
    expect(st.secrets.DISCORD_BOT_TOKEN).toBe(false);
    expect(st.secrets.DISCORD_PUBLIC_KEY).toBe(true);
    expect(Object.keys(st.secrets).sort()).toEqual([
      'ADMIN_TOKEN',
      'DISCORD_APPLICATION_ID',
      'DISCORD_BOT_TOKEN',
      'DISCORD_PUBLIC_KEY',
    ]);
  });
});

describe('COMMAND_DEFINITIONS（コマンド定義の単一ソース）', () => {
  it('現行のコマンドを公開している（recruit / help / manage）', () => {
    const names = COMMAND_DEFINITIONS.map((c) => c.name).sort();
    expect(names).toEqual(['help', 'manage', 'recruit']);
  });
});
