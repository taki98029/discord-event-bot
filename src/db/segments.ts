import type { Member, Segment, SegmentMember } from './types';

const SEG_COLS = 'id, guild_id, name, mention_role_id, members_synced_at, created_at';
const MEMBER_COLS = 'm.user_id, m.user_name, m.display_name, m.dm_channel_id, m.created_at';

/** Segment 取得（guildId 指定時はそのギルドのみ、未指定で全件） */
export async function listSegments(db: D1Database, guildId?: string): Promise<Segment[]> {
  if (guildId) {
    const { results } = await db
      .prepare(`SELECT ${SEG_COLS} FROM segments WHERE guild_id = ? ORDER BY created_at`)
      .bind(guildId)
      .all<Segment>();
    return results;
  }
  const { results } = await db
    .prepare(`SELECT ${SEG_COLS} FROM segments ORDER BY created_at`)
    .all<Segment>();
  return results;
}

/** 単一 Segment 取得（未登録なら null） */
export async function getSegment(db: D1Database, id: number): Promise<Segment | null> {
  const row = await db
    .prepare(`SELECT ${SEG_COLS} FROM segments WHERE id = ?`)
    .bind(id)
    .first<Segment>();
  return row ?? null;
}

/** Segment 作成。採番後の行を返す */
export async function createSegment(
  db: D1Database,
  input: { guild_id: string; name: string; mention_role_id: string | null },
): Promise<Segment> {
  const res = await db
    .prepare('INSERT INTO segments (guild_id, name, mention_role_id) VALUES (?, ?, ?)')
    .bind(input.guild_id, input.name, input.mention_role_id ?? null)
    .run();
  const id = res.meta.last_row_id as number;
  const row = await getSegment(db, id);
  return (
    row ?? {
      id,
      guild_id: input.guild_id,
      name: input.name,
      mention_role_id: input.mention_role_id ?? null,
      members_synced_at: null,
      created_at: '',
    }
  );
}

/** Segment 更新。対象が無ければ false */
export async function updateSegment(
  db: D1Database,
  id: number,
  patch: { name: string; mention_role_id: string | null },
): Promise<boolean> {
  const res = await db
    .prepare('UPDATE segments SET name = ?, mention_role_id = ? WHERE id = ?')
    .bind(patch.name, patch.mention_role_id ?? null, id)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/** この Segment を対象にしている Notification 数（削除可否判定用） */
export async function countNotificationsForSegment(
  db: D1Database,
  id: number,
): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS c FROM notifications WHERE segment_id = ?')
    .bind(id)
    .first<{ c: number }>();
  return row?.c ?? 0;
}

/**
 * Segment 削除。所属（segment_members）も削除する。削除した場合 true。
 * ※ 対象 Notification がある場合は呼び出し側で countNotificationsForSegment により
 *   事前にブロックする想定（db 関数自体はガードしない）。
 */
export async function deleteSegment(db: D1Database, id: number): Promise<boolean> {
  await db.prepare('DELETE FROM segment_members WHERE segment_id = ?').bind(id).run();
  const res = await db.prepare('DELETE FROM segments WHERE id = ?').bind(id).run();
  return (res.meta.changes ?? 0) > 0;
}

// --- 所属（segment_members）操作 ---

/** 区分メンバー一覧（members JOIN・status 付き・所属順） */
export async function listSegmentMembers(
  db: D1Database,
  segmentId: number,
): Promise<SegmentMember[]> {
  const { results } = await db
    .prepare(
      `SELECT ${MEMBER_COLS}, sm.status AS status
         FROM segment_members sm
         JOIN members m ON m.user_id = sm.user_id
        WHERE sm.segment_id = ?
        ORDER BY sm.joined_at`,
    )
    .bind(segmentId)
    .all<SegmentMember>();
  return results;
}

/** 区分のアクティブメンバー（status='' のみ）。集計・リマインド対象の母集団 */
export async function getActiveSegmentMembers(
  db: D1Database,
  segmentId: number,
): Promise<Member[]> {
  const { results } = await db
    .prepare(
      `SELECT ${MEMBER_COLS}
         FROM segment_members sm
         JOIN members m ON m.user_id = sm.user_id
        WHERE sm.segment_id = ? AND sm.status = ''
        ORDER BY sm.joined_at`,
    )
    .bind(segmentId)
    .all<Member>();
  return results;
}

/**
 * 所属追加（存在すれば no-op の upsert）。status は既存維持。
 * names（ピッカー由来のサーバー内ニック / ユーザー名）があれば members マスタへ取り込む。
 */
export async function addSegmentMember(
  db: D1Database,
  segmentId: number,
  userId: string,
  names: { user_name?: string | null; display_name?: string | null } = {},
): Promise<void> {
  // members マスタを確実化する。segment_members は一覧/集計時に members と INNER JOIN される
  // ため、マスタに存在しない user_id を所属させると、一覧・アクティブ母集団・リマインド・
  // ノルマ・集計のすべてから孤立して消える。所属追加の不変条件として db 層で保証する。
  // 表示名（サーバー内ニック）は最新の非 null 値で上書きする（ADR 0006）。
  await db
    .prepare(
      `INSERT INTO members (user_id, user_name, display_name) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         user_name = COALESCE(excluded.user_name, members.user_name),
         display_name = COALESCE(excluded.display_name, members.display_name)`,
    )
    .bind(userId, names.user_name ?? null, names.display_name ?? null)
    .run();
  await db
    .prepare(
      `INSERT INTO segment_members (segment_id, user_id) VALUES (?, ?)
       ON CONFLICT(segment_id, user_id) DO NOTHING`,
    )
    .bind(segmentId, userId)
    .run();
}

/** 所属ステータスを更新（'' / '休止中'）。対象が無ければ false */
export async function setSegmentMemberStatus(
  db: D1Database,
  segmentId: number,
  userId: string,
  status: string,
): Promise<boolean> {
  const res = await db
    .prepare('UPDATE segment_members SET status = ? WHERE segment_id = ? AND user_id = ?')
    .bind(status, segmentId, userId)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/** 所属解除。削除した場合 true */
export async function removeSegmentMember(
  db: D1Database,
  segmentId: number,
  userId: string,
): Promise<boolean> {
  const res = await db
    .prepare('DELETE FROM segment_members WHERE segment_id = ? AND user_id = ?')
    .bind(segmentId, userId)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/** ロール管理区分のメンバー同期完了時刻を現在時刻で記録する（ADR 0009）。 */
export async function setSegmentMembersSyncedAt(db: D1Database, segmentId: number): Promise<void> {
  await db
    .prepare("UPDATE segments SET members_synced_at = datetime('now') WHERE id = ?")
    .bind(segmentId)
    .run();
}

/** ある Member が所属する区分一覧（/pause の自動選択用） */
export async function listSegmentsForMember(
  db: D1Database,
  userId: string,
): Promise<Segment[]> {
  const { results } = await db
    .prepare(
      `SELECT s.id, s.guild_id, s.name, s.mention_role_id, s.members_synced_at, s.created_at
         FROM segment_members sm
         JOIN segments s ON s.id = sm.segment_id
        WHERE sm.user_id = ?
        ORDER BY s.created_at`,
    )
    .bind(userId)
    .all<Segment>();
  return results;
}
