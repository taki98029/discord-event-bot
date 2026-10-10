import type { Env } from '../env';
import { getConfig } from '../db/config';
import { sendChannelMessage } from './rest';
import type { FailureNotificationSettings } from '../db/types';
import { cutText } from '../lib/text';

export const failureNotificationKey = (guildId: string) => `failure_notification:${guildId}`;
const emptyFailureNotificationSettings = (): FailureNotificationSettings => ({
  channel_id: null,
  mention_mode: 'none',
  mention_ids: [],
});

/** 保存時と読取時の検証を共用。宛先20件＋詳細1300字でDiscordの本文上限に収める。 */
export function parseFailureNotificationSettings(value: unknown): FailureNotificationSettings {
  const s = value as Partial<FailureNotificationSettings> | null;
  if (!s || (s.channel_id !== null && (typeof s.channel_id !== 'string' || !/^\d{1,22}$/.test(s.channel_id))))
    throw new Error('失敗通知の投稿先を選択してください');
  if (!['none', 'users', 'roles'].includes(s.mention_mode ?? ''))
    throw new Error('メンション方法を選択してください');
  if (
    !Array.isArray(s.mention_ids) ||
    s.mention_ids.length > 20 ||
    s.mention_ids.some((id) => typeof id !== 'string' || !/^\d{1,22}$/.test(id))
  )
    throw new Error('メンション先はユーザーまたはロールを20件以内で選択してください');
  const ids = s.mention_mode === 'none' ? [] : [...new Set(s.mention_ids)];
  if (s.mention_mode !== 'none' && ids.length === 0) throw new Error('メンション先を選択してください');
  return {
    channel_id: s.channel_id,
    mention_mode: s.mention_mode!,
    mention_ids: ids,
  };
}

export async function getFailureNotificationSettings(db: D1Database, guildId: string) {
  const raw = await getConfig(db, failureNotificationKey(guildId));
  return raw === null
    ? emptyFailureNotificationSettings()
    : parseFailureNotificationSettings(JSON.parse(raw));
}

/** 元の失敗結果を変えない。失敗通知自身の失敗はログのみ＝再帰投稿しない。戻り値は投稿試行の有無。 */
export async function notifyDeliveryFailure(env: Env, guildId: string, detail: string): Promise<boolean> {
  let attempted = false;
  try {
    const s = await getFailureNotificationSettings(env.DB, guildId);
    if (!s.channel_id) return false;
    // @everyone のロールIDも許可しない（通常は保存APIで拒否）。
    const ids = s.mention_ids.filter((id) => s.mention_mode !== 'roles' || id !== guildId);
    const mentions = ids.map((id) => (s.mention_mode === 'roles' ? `<@&${id}>` : `<@${id}>`)).join(' ');
    attempted = true;
    await sendChannelMessage(
      env,
      s.channel_id,
      `${mentions ? mentions + '\n' : ''}⚠️ **メッセージの送信失敗**\n${cutText(detail, 1300)}\n\n管理画面の送信履歴・日程調整の投稿状況と、Discordの投稿権限やDM受信設定を確認してください。`,
      null,
      {
        parse: [],
        ...(s.mention_mode === 'none' ? {} : { [s.mention_mode]: ids }),
      },
    );
  } catch {
    console.error('[FailureNotification] 失敗通知を投稿できませんでした');
  }
  return attempted;
}
