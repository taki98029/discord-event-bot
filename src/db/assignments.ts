import type { Member } from './types';
import { resolveDisplayName } from './types';

/** Fisher–Yates シャッフル（in-place） */
function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * 安定割り当て: 既存 assignments は維持し、その occurrence で status='参加' かつ
 * 未採番の responder にのみ空き番号を振る。
 * 空き番号は 1.. の欠番優先（連番が 1 から埋まるよう最小の空きから）。
 * 新規対象者は Fisher–Yates でシャッフルしてから順に割り当てる。
 *
 * @returns assigned 今回新規に割り当てた {user_id, number}、all 全採番済みを number 昇順で名前付きで返す
 */
export async function assignNumbers(
  db: D1Database,
  occurrenceId: number,
): Promise<{
  assigned: { user_id: string; number: number }[];
  all: { user_id: string; number: number; name: string }[];
}> {
  // 既存割り当て（番号維持）
  const { results: existing } = await db
    .prepare('SELECT user_id, number FROM assignments WHERE occurrence_id = ?')
    .bind(occurrenceId)
    .all<{ user_id: string; number: number }>();
  const assignedUserIds = new Set(existing.map((e) => e.user_id));
  const usedNumbers = new Set(existing.map((e) => e.number));

  // この occurrence で「参加」と回答した responder
  const { results: participants } = await db
    .prepare("SELECT user_id FROM responses WHERE occurrence_id = ? AND status = '参加'")
    .bind(occurrenceId)
    .all<{ user_id: string }>();

  // 未採番の新規対象者
  const targets = participants.map((p) => p.user_id).filter((uid) => !assignedUserIds.has(uid));
  shuffle(targets);

  // 空き番号を 1 から欠番優先で集める（必要数ぶん）
  const freeNumbers: number[] = [];
  let candidate = 1;
  while (freeNumbers.length < targets.length) {
    if (!usedNumbers.has(candidate)) freeNumbers.push(candidate);
    candidate++;
  }

  const ts = new Date().toISOString();
  const assigned: { user_id: string; number: number }[] = [];
  for (let i = 0; i < targets.length; i++) {
    const userId = targets[i];
    const number = freeNumbers[i];
    await db
      .prepare(
        'INSERT INTO assignments (occurrence_id, user_id, number, assigned_at) VALUES (?, ?, ?, ?)',
      )
      .bind(occurrenceId, userId, number, ts)
      .run();
    assigned.push({ user_id: userId, number });
  }

  // all: 全採番済みを number 昇順で、表示名付きで返す
  const { results: allRows } = await db
    .prepare(
      `SELECT a.user_id AS user_id, a.number AS number,
              m.user_id AS m_user_id, m.user_name AS user_name,
              m.display_name AS display_name, m.dm_channel_id AS dm_channel_id,
              m.created_at AS created_at
         FROM assignments a
         LEFT JOIN members m ON m.user_id = a.user_id
        WHERE a.occurrence_id = ?
        ORDER BY a.number ASC`,
    )
    .bind(occurrenceId)
    .all<{
      user_id: string;
      number: number;
      m_user_id: string | null;
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
