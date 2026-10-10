/** チャンネル管理で外したチャンネルを選択肢から除く。選択中の値は外しても残す（保存済みの投稿先を消さない）。 */
export const pickable = <T extends { id: string; enabled?: boolean }>(channels: T[], value?: string | null): T[] =>
  channels.filter((c) => c.enabled !== false || c.id === value);
