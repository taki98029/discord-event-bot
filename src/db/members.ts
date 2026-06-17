import type { Member } from './types';

// 休止状態は segment_members 側に持つため members に status 列は無い
const COLS = 'user_id, user_name, display_name, dm_channel_id, created_at';

/** 全メンバー取得（作成順） */
export async function getAllMembers(db: D1Database): Promise<Member[]> {
  const { results } = await db
    .prepare(`SELECT ${COLS} FROM members ORDER BY created_at`)
    .all<Member>();
  return results;
}

/** 単一メンバー取得（未登録なら null） */
export async function getMember(db: D1Database, userId: string): Promise<Member | null> {
  const row = await db
    .prepare(`SELECT ${COLS} FROM members WHERE user_id = ?`)
    .bind(userId)
    .first<Member>();
  return row ?? null;
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
    .prepare('INSERT INTO members (user_id, user_name, display_name) VALUES (?, ?, ?)')
    .bind(userId, userName ?? null, displayName ?? null)
    .run();
  return 'added';
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

/**
 * メンバーが存在しなければ追加（ボタン応答からの自動登録用）。
 * 既存メンバーには触れない（表示名更新は updateMemberDisplayName 側で行う）。
 */
export async function ensureMember(
  db: D1Database,
  userId: string,
  userName: string | null,
  displayName: string | null,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO members (user_id, user_name, display_name) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO NOTHING`,
    )
    .bind(userId, userName ?? null, displayName ?? null)
    .run();
}

// --- 管理 UI 用 CRUD ---

/** メンバーの作成/更新（管理 UI）。user_id をキーに upsert */
export async function upsertMember(
  db: D1Database,
  m: { user_id: string; user_name?: string | null; display_name?: string | null },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO members (user_id, user_name, display_name)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         user_name = excluded.user_name,
         display_name = excluded.display_name`,
    )
    .bind(m.user_id, m.user_name ?? null, m.display_name ?? null)
    .run();
}

/**
 * メンバー削除（管理 UI）。削除した場合 true。
 * 全 segment_members / responses / assignments からも掃除する。
 */
export async function deleteMember(db: D1Database, userId: string): Promise<boolean> {
  await db.prepare('DELETE FROM segment_members WHERE user_id = ?').bind(userId).run();
  await db.prepare('DELETE FROM responses WHERE user_id = ?').bind(userId).run();
  await db.prepare('DELETE FROM assignments WHERE user_id = ?').bind(userId).run();
  const res = await db.prepare('DELETE FROM members WHERE user_id = ?').bind(userId).run();
  return (res.meta.changes ?? 0) > 0;
}
