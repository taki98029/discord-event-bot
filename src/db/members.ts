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

const GUILD_PROFILE_UPSERT = `INSERT INTO member_guild_profiles (guild_id, user_id, display_name) VALUES (?, ?, ?)
   ON CONFLICT(guild_id, user_id) DO UPDATE SET display_name = excluded.display_name`;

/** ギルドごとの表示名（サーバー内ニック）を最新値で upsert する（ADR 0022） */
export async function upsertGuildDisplayName(
  db: D1Database,
  guildId: string,
  userId: string,
  displayName: string,
): Promise<void> {
  await db.prepare(GUILD_PROFILE_UPSERT).bind(guildId, userId, displayName).run();
}

/** ギルドごとの表示名を一括 upsert（ロール同期用・batch 1 回）。display_name null の要素は無視 */
export async function upsertGuildDisplayNames(
  db: D1Database,
  guildId: string,
  entries: { user_id: string; display_name: string | null }[],
): Promise<void> {
  const stmt = db.prepare(GUILD_PROFILE_UPSERT);
  const batch = entries
    .filter((e) => e.display_name)
    .map((e) => stmt.bind(guildId, e.user_id, e.display_name));
  if (batch.length > 0) await db.batch(batch);
}

/**
 * 表示名の自動更新（旧 updateMemberDisplayName）。
 * - guildId があればそのギルドの表示名を常に最新へ（nick 変更の追従・ADR 0022）。
 * - members（グローバルフォールバック）は「未設定の場合のみ」書き込む（旧仕様を踏襲）。
 */
export async function updateMemberDisplayName(
  db: D1Database,
  userId: string,
  displayName: string | null,
  userName: string | null,
  guildId?: string | null,
): Promise<void> {
  if (!displayName) return;
  const m = await getMember(db, userId);
  if (!m) return;

  if (guildId) await upsertGuildDisplayName(db, guildId, userId, displayName);

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
 * 全 segment_members / responses / member_guild_profiles からも掃除する。
 */
export async function deleteMember(db: D1Database, userId: string): Promise<boolean> {
  await db.prepare('DELETE FROM segment_members WHERE user_id = ?').bind(userId).run();
  await db.prepare('DELETE FROM responses WHERE user_id = ?').bind(userId).run();
  await db.prepare('DELETE FROM response_log WHERE user_id = ?').bind(userId).run();
  await db.prepare('DELETE FROM member_guild_profiles WHERE user_id = ?').bind(userId).run();
  const res = await db.prepare('DELETE FROM members WHERE user_id = ?').bind(userId).run();
  return (res.meta.changes ?? 0) > 0;
}
