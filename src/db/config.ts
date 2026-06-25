/**
 * config テーブル（key/value）アクセサ。実行時設定を保持する（migration 0010 で再作成）。
 * 主用途は send_budget_per_tick（⑦ ペース配信の 1 ティック送信予算・ADR 0013）。
 */

export async function getConfig(db: D1Database, key: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT value FROM config WHERE key = ?')
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

/** 正の整数として読む。未設定・不正値・0以下は fallback。 */
export async function getConfigInt(db: D1Database, key: string, fallback: number): Promise<number> {
  const v = await getConfig(db, key);
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export async function setConfig(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(
      'INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    .bind(key, value)
    .run();
}

export async function getAllConfig(db: D1Database): Promise<Record<string, string>> {
  const { results } = await db
    .prepare('SELECT key, value FROM config')
    .all<{ key: string; value: string }>();
  const map: Record<string, string> = {};
  for (const r of results) map[r.key] = r.value;
  return map;
}

/** ⑦ 送信予算（per-tick）。Free 既定 45。Paid 化時は値を上げて上限を突破する。 */
export const SEND_BUDGET_KEY = 'send_budget_per_tick';
export const DEFAULT_SEND_BUDGET = 45;

export async function getSendBudget(db: D1Database): Promise<number> {
  return getConfigInt(db, SEND_BUDGET_KEY, DEFAULT_SEND_BUDGET);
}
