import type { Member } from './types';

const COLS = 'user_id, user_name, status, display_name, dm_channel_id, created_at';

function normalize(row: Member): Member {
  return { ...row, status: row.status ?? '' };
}

/** 全メンバー取得（旧 getAllMembers） */
export async function getAllMembers(db: D1Database): Promise<Member[]> {
  const { results } = await db
    .prepare(`SELECT ${COLS} FROM members ORDER BY created_at`)
    .all<Member>();
  return results.map(normalize);
}

/** 単一メンバー取得（未登録なら null） */
export async function getMember(db: D1Database, userId: string): Promise<Member | null> {
  const row = await db
    .prepare(`SELECT ${COLS} FROM members WHERE user_id = ?`)
    .bind(userId)
    .first<Member>();
  return row ? normalize(row) : null;
}

/** 新メンバー追加（旧 addMember）。既存なら 'exists' */
export async function addMember(
  db: D1Database,
  userId: string,
  userName: string | null,
  displayName: string | null,
): Promise<'added' | 'exists'> {
  const existing = await getMember(db, userId);
  if (existing) return 'exists';
  await db
    .prepare('INSERT INTO members (user_id, user_name, status, display_name) VALUES (?, ?, ?, ?)')
    .bind(userId, userName ?? null, '', displayName ?? null)
    .run();
  return 'added';
}

/** ステータス更新（旧 setMemberStatus）。対象が無ければ false */
export async function setMemberStatus(
  db: D1Database,
  userId: string,
  status: string,
): Promise<boolean> {
  const res = await db
    .prepare('UPDATE members SET status = ? WHERE user_id = ?')
    .bind(status, userId)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/**
 * 表示名の自動更新（旧 updateMemberDisplayName）。
 * display_name / user_name が「未設定の場合のみ」書き込む（旧仕様を踏襲）。
 */
export async function updateMemberDisplayName(
  db: D1Database,
  userId: string,
  displayName: string | null,
  userName: string | null,
): Promise<void> {
  if (!displayName) return;
  const m = await getMember(db, userId);
  if (!m) return;

  if (!m.display_name) {
    await db
      .prepare('UPDATE members SET display_name = ? WHERE user_id = ?')
      .bind(displayName, userId)
      .run();
  }
  if (!m.user_name && userName) {
    await db
      .prepare('UPDATE members SET user_name = ? WHERE user_id = ?')
      .bind(userName, userId)
      .run();
  }
}

/** DM チャンネル ID をキャッシュ保存（サブリクエスト削減用） */
export async function setDmChannelId(
  db: D1Database,
  userId: string,
  channelId: string,
): Promise<void> {
  await db
    .prepare('UPDATE members SET dm_channel_id = ? WHERE user_id = ?')
    .bind(channelId, userId)
    .run();
}

// --- 管理 UI 用 CRUD ---

/** メンバーの作成/更新（管理 UI）。user_id をキーに upsert */
export async function upsertMember(
  db: D1Database,
  m: { user_id: string; user_name?: string | null; status?: string; display_name?: string | null },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO members (user_id, user_name, status, display_name)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         user_name = excluded.user_name,
         status = excluded.status,
         display_name = excluded.display_name`,
    )
    .bind(m.user_id, m.user_name ?? null, m.status ?? '', m.display_name ?? null)
    .run();
}

/** メンバー削除（管理 UI）。削除した場合 true */
export async function deleteMember(db: D1Database, userId: string): Promise<boolean> {
  const res = await db.prepare('DELETE FROM members WHERE user_id = ?').bind(userId).run();
  return (res.meta.changes ?? 0) > 0;
}
