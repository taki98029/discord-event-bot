import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { resolveGuildName, GUILD_NAMES_KEY } from '../src/cron/tick';
import { getConfig } from '../src/db/config';

// MOCK_DISCORD=1（vitest.config）: listGuilds は MOCK_GUILDS（1001=土曜サークル・1002=音楽部の集い）を返す。
const mkCtx = (config: Record<string, string> = {}) => ({
  env,
  db: env.DB,
  now: new Date(),
  today: '2026/07/09',
  hour: 12,
  budget: { n: 45 },
  d1: { n: 40 },
  config,
  chan: new Map(),
});

describe('resolveGuildName（DM のサーバー名付記・1日1回同期）', () => {
  it('初回は listGuilds から同期して名前を返し、config に永続化する', async () => {
    const ctx = mkCtx();
    expect(await resolveGuildName(ctx, '1001')).toBe('土曜サークル');
    expect(ctx.budget.n).toBe(44); // listGuilds の subrequest 1 控除
    const saved = JSON.parse((await getConfig(env.DB, GUILD_NAMES_KEY)) || '{}');
    expect(saved.day).toBe('2026/07/09');
    expect(saved.names['1002']).toBe('音楽部の集い');
  });

  it('同日中は再同期せず config スナップショットの値を使う', async () => {
    const ctx = mkCtx({
      [GUILD_NAMES_KEY]: JSON.stringify({ day: '2026/07/09', names: { '1001': '保存済みの名前' } }),
    });
    expect(await resolveGuildName(ctx, '1001')).toBe('保存済みの名前');
    expect(ctx.budget.n).toBe(45); // API を叩いていない＝予算控除なし
  });

  it('日付が変わっていれば再同期して最新名に更新する', async () => {
    const ctx = mkCtx({
      [GUILD_NAMES_KEY]: JSON.stringify({ day: '2026/07/08', names: { '1001': '旧名' } }),
    });
    expect(await resolveGuildName(ctx, '1001')).toBe('土曜サークル');
  });

  it('未知の guild は空文字（DM 側は付記を省略）', async () => {
    const ctx = mkCtx({
      [GUILD_NAMES_KEY]: JSON.stringify({ day: '2026/07/09', names: {} }),
    });
    expect(await resolveGuildName(ctx, '9999')).toBe('');
  });

  it('壊れた config 値でも落ちずに再同期する', async () => {
    const ctx = mkCtx({ [GUILD_NAMES_KEY]: '{broken json' });
    expect(await resolveGuildName(ctx, '1002')).toBe('音楽部の集い');
  });
});
