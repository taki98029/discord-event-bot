import { getConfig } from '../db/config';

/**
 * 投稿先の選択肢に出すチャンネル（サーバー単位）。config に有効なチャンネル ID の配列を持つ。
 * 未設定＝全チャンネル有効。設定後に Discord で増えたチャンネルは無効（選んだものだけ出す）。
 * 表示の絞り込みだけで、保存済みの投稿先や投稿処理には影響しない。
 */
export const channelFilterKey = (guildId: string) => `channel_filter:${guildId}`;

export function parseChannelFilter(value: unknown): string[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > 1000 || value.some((id) => typeof id !== 'string' || !/^\d{1,22}$/.test(id)))
    throw new Error('チャンネルの指定が不正です');
  return [...new Set(value as string[])];
}

export async function getChannelFilter(db: D1Database, guildId: string): Promise<string[] | null> {
  const raw = await getConfig(db, channelFilterKey(guildId));
  return raw === null ? null : parseChannelFilter(JSON.parse(raw));
}

/** 各チャンネルに enabled を付ける。選択肢に出すかどうかは画面側で決める（保存済みの値は無効でも表示する）。 */
export async function withEnabled<T extends { id: string }>(db: D1Database, guildId: string, channels: T[]) {
  const filter = await getChannelFilter(db, guildId);
  const enabled = filter && new Set(filter);
  return channels.map((c) => ({ ...c, enabled: !enabled || enabled.has(c.id) }));
}
