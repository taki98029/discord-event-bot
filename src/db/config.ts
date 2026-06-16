import type { Config } from './types';

/** 全設定を取得（旧 getAllConfig） */
export async function getAllConfig(db: D1Database): Promise<Config> {
  const { results } = await db
    .prepare('SELECT key, value FROM config')
    .all<{ key: string; value: string }>();
  const config: Config = {};
  for (const row of results) config[row.key] = row.value;
  return config;
}

/** 単一設定を取得（未設定なら null） */
export async function getConfig(db: D1Database, key: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT value FROM config WHERE key = ?')
    .bind(key)
    .first<{ value: string }>();
  return row ? row.value : null;
}

/** 設定を upsert（管理 UI から利用） */
export async function setConfig(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(
      'INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    .bind(key, value)
    .run();
}
