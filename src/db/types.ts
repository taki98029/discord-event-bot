/** D1 テーブルの行・ドメイン型 */

/** members テーブル（旧 Member_DB） */
export interface Member {
  user_id: string;
  user_name: string | null;
  /** '' = アクティブ。値が入っていれば除外対象（休止中/スタッフ等） */
  status: string;
  display_name: string | null;
  dm_channel_id: string | null;
  created_at: string;
}

/** event_log テーブル（旧 Event_Log） */
export interface EventLogRow {
  event_date: string;
  user_id: string;
  user_name: string | null;
  status: string;
  updated_at: string;
}

/** config テーブル（旧 Config）。キー→値のマップ */
export type Config = Record<string, string>;

/** 出欠状況の集計結果 */
export type EventStatusBuckets = {
  参加: string[];
  不参加: string[];
  未定: string[];
  未回答: string[];
};

/** ノルマ未達メンバー */
export interface QuotaAlert extends Member {
  daysSinceLast: number;
  lastDateStr: string;
}

/** メンバーの表示名を解決（display_name > user_name > user_id） */
export function resolveDisplayName(m: Member): string {
  return m.display_name || m.user_name || m.user_id;
}
