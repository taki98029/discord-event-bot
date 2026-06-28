import type { Member } from './types';
import { resolveDisplayName } from './types';
import { shuffle } from '../lib/shuffle';

export type AssignMode = 'first-come' | 'random';

/**
 * 番号割り当て（ADR 0018）。指定した occurrence の既存 assignments を **すべて削除** し、
 * その回で status='参加' の responder に 1..N の連番を振り直す。
 * - mode='first-come': responses.updated_at ASC, user_id ASC（早い順・同秒は user_id 昇順）
 * - mode='random'   : Fisher–Yates でランダム並び
 *
 * 既存の「安定割り当て（既存番号維持・欠番優先）」は破棄した（ADR 0018）。
 *
 * @returns assigned 今回振り直した {user_id, number}（= all と同じ集合）、
 *          all 全採番済みを number 昇順で名前付きで返す
 */
export async function assignNumbers(
  db: D1Database,
  occurrenceId: number,
  mode: AssignMode,
): Promise<{
  assigned: { user_id: string; number: number }[];
  all: { user_id: string; number: number; name: string }[];
}> {
  // 既存 assignments を全クリア（振り直し）
  // await db
  //   .prepare('DELETE FROM assignments WHERE occurrence_id = ?')
  //   .bind(occurrenceId)
  //  .run();

  // 参加者を順序付きで取得（早い順は SQL ORDER BY、ランダムはアプリ層シャッフル）
  const orderBy =
    mode === 'first-come'
      ? 'ORDER BY r.updated_at ASC, r.user_id ASC'
      : 'ORDER BY r.user_id ASC'; // ランダム前の決定論的初期順
  const { results: rows } = await db
    .prepare(
      `SELECT r.user_id FROM responses r
        WHERE r.occurrence_id = ? AND r.status = '参加'
        ${orderBy}`,
    )
    .bind(occurrenceId)
    .all<{ user_id: string }>();
  const ordered = rows.map((r) => r.user_id);
  if (mode === 'random') shuffle(ordered);

  // 1..N で振り直し
  const ts = new Date().toISOString();
  const assigned: { user_id: string; number: number }[] = [];
  for (let i = 0; i < ordered.length; i++) {
    const userId = ordered[i];
    const number = i + 1;
    await db
      .prepare(
        'INSERT INTO assignments (occurrence_id, user_id, number, assigned_at) VALUES (?, ?, ?, ?)',
      )
      .bind(occurrenceId, userId, number, ts)
      .run();
    assigned.push({ user_id: userId, number });
  }

  // all: number 昇順で表示名付き
  const { results: allRows } = await db
    .prepare(
      `SELECT a.user_id AS user_id, a.number AS number,
              m.user_name AS user_name, m.display_name AS display_name,
              m.dm_channel_id AS dm_channel_id, m.created_at AS created_at
         FROM assignments a
         LEFT JOIN members m ON m.user_id = a.user_id
        WHERE a.occurrence_id = ?
        ORDER BY a.number ASC`,
    )
    .bind(occurrenceId)
    .all<{
      user_id: string;
      number: number;
      user_name: string | null;
      display_name: string | null;
      dm_channel_id: string | null;
      created_at: string | null;
    }>();

  const all = allRows.map((r) => {
    const m: Member = {
      user_id: r.user_id,
      user_name: r.user_name,
      display_name: r.display_name,
      dm_channel_id: r.dm_channel_id,
      created_at: r.created_at ?? '',
    };
    return { user_id: r.user_id, number: r.number, name: resolveDisplayName(m) };
  });

  return { assigned, all };
}

/** 開催回の割り当て一覧（number 昇順・表示名付き）。assignNumbers の all とレスポンス形を揃える */
export async function getAssignments(
  db: D1Database,
  occurrenceId: number,
): Promise<{ user_id: string; number: number; name: string }[]> {
  const { results } = await db
    .prepare(
      `SELECT a.user_id AS user_id, a.number AS number,
              m.user_name AS user_name, m.display_name AS display_name
         FROM assignments a
         LEFT JOIN members m ON m.user_id = a.user_id
        WHERE a.occurrence_id = ?
          AND NOT EXISTS (
              SELECT 1
                FROM group_members gm
                JOIN groups g
                  ON g.id = gm.group_id
                JOIN groupings gp
                  ON gp.id = g.grouping_id
               WHERE gm.user_id = a.user_id
                 AND gp.occurrence_id = a.occurrence_id
              )
        ORDER BY a.number ASC`,
    )
    .bind(occurrenceId)
    .all<{ user_id: string; number: number; user_name: string | null; display_name: string | null }>();
  return results.map((r) => ({
    user_id: r.user_id,
    number: r.number,
    name: r.display_name || r.user_name || r.user_id,
  }));
}
