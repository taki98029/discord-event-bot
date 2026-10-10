import { resolveDisplayName, type Notification, type QuotaAlert } from '../db/types';

export const DEFAULT_QUOTA_MESSAGE =
  '📊 **参加間隔の確認**（{{サーバー名}}）\n\n' +
  'こんにちは、**{{名前}}** さん！\n' +
  '前回のイベント参加から少し時間が空いているようです（目安: {{参加間隔}}日に1回）。\n\n' +
  '- 最終参加: **{{最終参加日}}** ({{経過日数}}日前)\n\n' +
  '次回のイベントへの参加をぜひご検討ください！お待ちしています✨';
export const QUOTA_MESSAGE_FIELDS = ['サーバー名', '名前', '参加間隔', '最終参加日', '経過日数'];
export const QUOTA_MESSAGE_MAX = 1500;

/** Reserve 200 UTF-16 units per replacement (100 Unicode characters), including emoji. */
export function quotaMessageError(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== 'string') return 'ノルマのメッセージは文字列で入力してください。';
  const message = value.trim();
  if (message.length > QUOTA_MESSAGE_MAX) return `ノルマのメッセージは${QUOTA_MESSAGE_MAX}文字以内で入力してください。`;
  let unknown = false;
  const expanded = message.replace(/{{(.*?)}}/g, (_, key: string) => {
    if (!QUOTA_MESSAGE_FIELDS.includes(key)) unknown = true;
    return '字'.repeat(200);
  });
  if (unknown) return 'ノルマのメッセージに使えない差し込み項目があります。';
  if (expanded.length > 2000) return '差し込み後に2000文字を超える可能性があります。本文か差し込み項目を減らしてください。';
  return null;
}

/** Shared by the settings preview and the actual quota DM. Replacements are not re-interpreted. */
export function quotaMessage(
  n: Pick<Notification, 'quota_interval_days' | 'quota_message'>,
  member: Pick<QuotaAlert, 'user_id' | 'user_name' | 'display_name' | 'lastDateStr' | 'daysSinceLast'>,
  guildName: string,
): string {
  let message = n.quota_message?.trim() || DEFAULT_QUOTA_MESSAGE;
  if (message === DEFAULT_QUOTA_MESSAGE && !guildName) message = message.replace('（{{サーバー名}}）', '');
  const values: Record<string, string> = {
    サーバー名: guildName,
    名前: resolveDisplayName(member),
    参加間隔: String(n.quota_interval_days ?? ''),
    最終参加日: member.lastDateStr,
    経過日数: String(member.daysSinceLast),
  };
  return message.replace(/{{(.*?)}}/g, (match, key: string) =>
    Object.hasOwn(values, key) ? Array.from(values[key]).slice(0, 100).join('') : match);
}
