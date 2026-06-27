import type {
  ConstraintDirection,
  ConstraintStrength,
  Group,
  Grouping,
  GroupingConstraint,
  GroupingView,
  Member,
} from './types';
import { resolveDisplayName } from './types';
import { newUuid } from './uuid';

/** Fisher-Yates シャッフル（in-place） */
function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** ペアを (a < b) で正規化（重複登録防止のため） */
export function normalizePair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

/** その Occurrence の Grouping を取得（未作成は null） */
export async function getGrouping(
  db: D1Database,
  occurrenceId: number,
): Promise<Grouping | null> {
  const row = await db
    .prepare(
      'SELECT id, uuid, occurrence_id, group_count, created_at, updated_at FROM groupings WHERE occurrence_id = ?',
    )
    .bind(occurrenceId)
    .first<Grouping>();
  return row ?? null;
}

/** UUID で Grouping を取得（未登録なら null・ADR 0016） */
export async function getGroupingByUuid(
  db: D1Database,
  uuid: string,
): Promise<Grouping | null> {
  const row = await db
    .prepare(
      'SELECT id, uuid, occurrence_id, group_count, created_at, updated_at FROM groupings WHERE uuid = ?',
    )
    .bind(uuid)
    .first<Grouping>();
  return row ?? null;
}

/**
 * Grouping を upsert する。group_count が変わった場合:
 * - 増やす: 既存 groups を維持し、不足分を「グループ N」名で追加
 * - 減らす: 末尾の groups を削除し、そのメンバーは未割り当て（プール）に戻る
 */
export async function upsertGrouping(
  db: D1Database,
  occurrenceId: number,
  groupCount: number,
): Promise<Grouping> {
  if (groupCount < 1) throw new Error('groupCount must be >= 1');
  const ts = new Date().toISOString();
  const existing = await getGrouping(db, occurrenceId);

  if (!existing) {
    const groupingUuid = newUuid();
    const res = await db
      .prepare(
        'INSERT INTO groupings (uuid, occurrence_id, group_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .bind(groupingUuid, occurrenceId, groupCount, ts, ts)
      .run();
    const groupingId = res.meta.last_row_id as number;
    for (let i = 0; i < groupCount; i++) {
      await db
        .prepare(
          'INSERT INTO groups (uuid, grouping_id, group_index, name) VALUES (?, ?, ?, ?)',
        )
        .bind(newUuid(), groupingId, i, `グループ ${i + 1}`)
        .run();
    }
    return {
      id: groupingId,
      uuid: groupingUuid,
      occurrence_id: occurrenceId,
      group_count: groupCount,
      created_at: ts,
      updated_at: ts,
    };
  }

  if (existing.group_count !== groupCount) {
    if (groupCount > existing.group_count) {
      for (let i = existing.group_count; i < groupCount; i++) {
        await db
          .prepare(
            'INSERT INTO groups (uuid, grouping_id, group_index, name) VALUES (?, ?, ?, ?)',
          )
          .bind(newUuid(), existing.id, i, `グループ ${i + 1}`)
          .run();
      }
    } else {
      // 末尾を削除（メンバーも削除＝プールに戻る）
      const { results: removed } = await db
        .prepare(
          'SELECT id FROM groups WHERE grouping_id = ? AND group_index >= ?',
        )
        .bind(existing.id, groupCount)
        .all<{ id: number }>();
      for (const r of removed) {
        await db.prepare('DELETE FROM group_members WHERE group_id = ?').bind(r.id).run();
        await db.prepare('DELETE FROM groups WHERE id = ?').bind(r.id).run();
      }
    }
    await db
      .prepare('UPDATE groupings SET group_count = ?, updated_at = ? WHERE id = ?')
      .bind(groupCount, ts, existing.id)
      .run();
  }
  return (await getGrouping(db, occurrenceId))!;
}

/** その Grouping の Group 一覧（group_index 昇順） */
export async function listGroups(db: D1Database, groupingId: number): Promise<Group[]> {
  const { results } = await db
    .prepare(
      'SELECT id, uuid, grouping_id, group_index, name FROM groups WHERE grouping_id = ? ORDER BY group_index ASC',
    )
    .bind(groupingId)
    .all<Group>();
  return results;
}

/** UUID で Group を取得（未登録なら null・ADR 0016） */
export async function getGroupByUuid(db: D1Database, uuid: string): Promise<Group | null> {
  const row = await db
    .prepare('SELECT id, uuid, grouping_id, group_index, name FROM groups WHERE uuid = ?')
    .bind(uuid)
    .first<Group>();
  return row ?? null;
}

/** グループ名を更新 */
export async function renameGroup(
  db: D1Database,
  groupId: number,
  name: string,
): Promise<boolean> {
  const res = await db
    .prepare('UPDATE groups SET name = ? WHERE id = ?')
    .bind(name, groupId)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/**
 * メンバーの所属を一括設定する。assignments は [{group_id, user_ids[]}] の形式。
 * 既存の group_members を全削除して新しい所属で置き換える。
 * user_ids に登場しない参加者は未割り当て（プール）扱い。
 */
export async function setGroupMembers(
  db: D1Database,
  groupingId: number,
  assignments: { group_id: number; user_ids: string[] }[],
): Promise<void> {
  // 同 grouping 配下の group_id 全てから group_members を削除
  await db
    .prepare(
      'DELETE FROM group_members WHERE group_id IN (SELECT id FROM groups WHERE grouping_id = ?)',
    )
    .bind(groupingId)
    .run();
  for (const a of assignments) {
    for (const uid of a.user_ids) {
      await db
        .prepare(
          'INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)',
        )
        .bind(a.group_id, uid)
        .run();
    }
  }
  await db
    .prepare('UPDATE groupings SET updated_at = ? WHERE id = ?')
    .bind(new Date().toISOString(), groupingId)
    .run();
}

/** 1 メンバーをあるグループに移動（既存所属は同 grouping 内で全削除してから追加） */
export async function moveMemberToGroup(
  db: D1Database,
  groupingId: number,
  userId: string,
  toGroupId: number | null,
): Promise<void> {
  await db
    .prepare(
      `DELETE FROM group_members
        WHERE user_id = ?
          AND group_id IN (SELECT id FROM groups WHERE grouping_id = ?)`,
    )
    .bind(userId, groupingId)
    .run();
  if (toGroupId !== null) {
    await db
      .prepare(
        'INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)',
      )
      .bind(toGroupId, userId)
      .run();
  }
  await db
    .prepare('UPDATE groupings SET updated_at = ? WHERE id = ?')
    .bind(new Date().toISOString(), groupingId)
    .run();
}

/**
 * グループ分けの全体ビューを取得する。
 * - groups にはメンバー（表示名付き）が入る
 * - pool: 現在「参加」かつどのグループにも入っていない参加者
 * - diff.no_longer_participating: グループに入っているが現在は「参加」でないメンバー
 * - diff.newly_participating: 現在「参加」だが、保存された割り当てに含まれない（pool と重複しうるが、こちらは「新規参加」のみ。pool は単に未割り当て全部）
 *   v1 では実装簡略化のため pool = newly_participating としてマージ表現にする可能性あり → 両方返すが、UI 側で必要に応じて見せ方を変える
 */
export async function getGroupingView(
  db: D1Database,
  occurrenceId: number,
): Promise<GroupingView> {
  const grouping = await getGrouping(db, occurrenceId);

  // 現在「参加」と回答しているメンバーを表示名付きで取得
  const { results: participantRows } = await db
    .prepare(
      `SELECT r.user_id AS user_id,
              m.user_name AS user_name,
              m.display_name AS display_name,
              m.dm_channel_id AS dm_channel_id,
              m.created_at AS created_at
         FROM responses r
         LEFT JOIN members m ON m.user_id = r.user_id
        WHERE r.occurrence_id = ? AND r.status = '参加'
        ORDER BY r.updated_at ASC`,
    )
    .bind(occurrenceId)
    .all<{
      user_id: string;
      user_name: string | null;
      display_name: string | null;
      dm_channel_id: string | null;
      created_at: string | null;
    }>();

  const nameOf = new Map<string, string>();
  for (const p of participantRows) {
    const m: Member = {
      user_id: p.user_id,
      user_name: p.user_name,
      display_name: p.display_name,
      dm_channel_id: p.dm_channel_id,
      created_at: p.created_at ?? '',
    };
    nameOf.set(p.user_id, resolveDisplayName(m));
  }
  const participantIds = new Set(participantRows.map((p) => p.user_id));

  if (!grouping) {
    return {
      grouping: null,
      groups: [],
      pool: participantRows.map((p) => ({
        user_id: p.user_id,
        name: nameOf.get(p.user_id) ?? p.user_id,
      })),
      diff: {
        no_longer_participating: [],
        newly_participating: [],
      },
    };
  }

  const groups = await listGroups(db, grouping.id);

  // 各グループのメンバー一覧（保存されたまま。現在不参加のメンバーも含む）
  const groupViews = await Promise.all(
    groups.map(async (g) => {
      const { results: members } = await db
        .prepare(
          `SELECT gm.user_id AS user_id,
                  m.user_name AS user_name,
                  m.display_name AS display_name,
                  m.dm_channel_id AS dm_channel_id,
                  m.created_at AS created_at
             FROM group_members gm
             LEFT JOIN members m ON m.user_id = gm.user_id
            WHERE gm.group_id = ?`,
        )
        .bind(g.id)
        .all<{
          user_id: string;
          user_name: string | null;
          display_name: string | null;
          dm_channel_id: string | null;
          created_at: string | null;
        }>();
      return {
        id: g.id,
        group_index: g.group_index,
        name: g.name,
        members: members.map((mm) => {
          const member: Member = {
            user_id: mm.user_id,
            user_name: mm.user_name,
            display_name: mm.display_name,
            dm_channel_id: mm.dm_channel_id,
            created_at: mm.created_at ?? '',
          };
          // 名前は participants の名前マップを優先、無ければ member から解決
          return {
            user_id: mm.user_id,
            name: nameOf.get(mm.user_id) ?? resolveDisplayName(member),
          };
        }),
      };
    }),
  );

  // 既に割り当て済みの user_id 集合
  const assignedIds = new Set<string>();
  for (const gv of groupViews) {
    for (const m of gv.members) assignedIds.add(m.user_id);
  }

  // プール: 現在参加かつ未割り当て
  const pool = participantRows
    .filter((p) => !assignedIds.has(p.user_id))
    .map((p) => ({
      user_id: p.user_id,
      name: nameOf.get(p.user_id) ?? p.user_id,
    }));

  // 差分: グループに入っているが現在は参加していないメンバー
  const noLonger: { user_id: string; name: string; group_id: number }[] = [];
  for (const gv of groupViews) {
    for (const m of gv.members) {
      if (!participantIds.has(m.user_id)) {
        noLonger.push({ user_id: m.user_id, name: m.name, group_id: gv.id });
      }
    }
  }

  // 差分: 新規参加（プール = 未割り当ての参加者全員 がここに含まれる）
  const newly = pool.map((p) => ({ user_id: p.user_id, name: p.name }));

  return {
    grouping,
    groups: groupViews,
    pool,
    diff: {
      no_longer_participating: noLonger,
      newly_participating: newly,
    },
  };
}

/** Grouping を削除（配下 groups / group_members も削除） */
export async function deleteGrouping(db: D1Database, occurrenceId: number): Promise<boolean> {
  const g = await getGrouping(db, occurrenceId);
  if (!g) return false;
  await db
    .prepare(
      'DELETE FROM group_members WHERE group_id IN (SELECT id FROM groups WHERE grouping_id = ?)',
    )
    .bind(g.id)
    .run();
  await db.prepare('DELETE FROM groups WHERE grouping_id = ?').bind(g.id).run();
  await db.prepare('DELETE FROM groupings WHERE id = ?').bind(g.id).run();
  return true;
}

/* -------------------------------------------------------------------------- */
/* Constraints                                                                */
/* -------------------------------------------------------------------------- */

/** Notification のペア制約一覧 */
export async function listConstraints(
  db: D1Database,
  notificationId: number,
): Promise<GroupingConstraint[]> {
  const { results } = await db
    .prepare(
      `SELECT id, uuid, notification_id, user_id_a, user_id_b, direction, strength, created_at
         FROM grouping_constraints
        WHERE notification_id = ?
        ORDER BY id ASC`,
    )
    .bind(notificationId)
    .all<GroupingConstraint>();
  return results;
}

/** UUID で GroupingConstraint を取得（未登録なら null・ADR 0016） */
export async function getConstraintByUuid(
  db: D1Database,
  uuid: string,
): Promise<GroupingConstraint | null> {
  const row = await db
    .prepare(
      `SELECT id, uuid, notification_id, user_id_a, user_id_b, direction, strength, created_at
         FROM grouping_constraints WHERE uuid = ?`,
    )
    .bind(uuid)
    .first<GroupingConstraint>();
  return row ?? null;
}

/**
 * ペア制約を作成（UNIQUE 制約により重複は INSERT OR REPLACE で direction/strength を更新）。
 * ペアは a < b で正規化される。
 */
export async function upsertConstraint(
  db: D1Database,
  notificationId: number,
  userIdA: string,
  userIdB: string,
  direction: ConstraintDirection,
  strength: ConstraintStrength,
): Promise<GroupingConstraint> {
  if (userIdA === userIdB) throw new Error('Cannot constrain a user with themselves');
  const [a, b] = normalizePair(userIdA, userIdB);
  const ts = new Date().toISOString();

  // 既存があれば direction/strength のみ更新
  const existing = await db
    .prepare(
      `SELECT id, uuid, notification_id, user_id_a, user_id_b, direction, strength, created_at
         FROM grouping_constraints
        WHERE notification_id = ? AND user_id_a = ? AND user_id_b = ?`,
    )
    .bind(notificationId, a, b)
    .first<GroupingConstraint>();

  if (existing) {
    await db
      .prepare(
        'UPDATE grouping_constraints SET direction = ?, strength = ? WHERE id = ?',
      )
      .bind(direction, strength, existing.id)
      .run();
    return { ...existing, direction, strength };
  }

  const uuid = newUuid();
  const res = await db
    .prepare(
      `INSERT INTO grouping_constraints
         (uuid, notification_id, user_id_a, user_id_b, direction, strength, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(uuid, notificationId, a, b, direction, strength, ts)
    .run();
  return {
    id: res.meta.last_row_id as number,
    uuid,
    notification_id: notificationId,
    user_id_a: a,
    user_id_b: b,
    direction,
    strength,
    created_at: ts,
  };
}

/** ペア制約を削除 */
export async function deleteConstraint(db: D1Database, id: number): Promise<boolean> {
  const res = await db
    .prepare('DELETE FROM grouping_constraints WHERE id = ?')
    .bind(id)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/* -------------------------------------------------------------------------- */
/* 自動配置                                                                  */
/* -------------------------------------------------------------------------- */

/** 配置結果の型: グループ ID → ユーザーID配列 */
export interface AutoAssignResult {
  byGroupId: Map<number, string[]>;
}

/**
 * 制約を考慮した自動配置（v1）。
 * アルゴリズム:
 *   1. participants を Fisher-Yates でシャッフル
 *   2. required + together 制約のペアを Union-Find でまとめる（クラスタ）
 *   3. クラスタを大きい順に「最も人数が少ないグループ」へ配置
 *   4. apart/preferred は v1 では厳密に考慮せず（違反検出で運用者にフィードバック）
 *
 * @param participants 現在「参加」のメンバー user_id 配列
 * @param groupIds グループ ID 配列（group_index 昇順）
 * @param constraints このイベントの制約一覧
 */
export function autoAssign(
  participants: string[],
  groupIds: number[],
  constraints: GroupingConstraint[],
): AutoAssignResult {
  const result: Map<number, string[]> = new Map();
  for (const g of groupIds) result.set(g, []);
  if (participants.length === 0 || groupIds.length === 0) return { byGroupId: result };

  // Union-Find for required+together
  const parent = new Map<string, string>();
  function find(x: string): string {
    if (!parent.has(x)) parent.set(x, x);
    let p = parent.get(x)!;
    if (p !== x) {
      p = find(p);
      parent.set(x, p);
    }
    return p;
  }
  function union(a: string, b: string) {
    const pa = find(a);
    const pb = find(b);
    if (pa !== pb) parent.set(pa, pb);
  }
  for (const p of participants) parent.set(p, p);

  for (const c of constraints) {
    if (c.direction === 'together' && c.strength === 'required') {
      // 両方が参加者にいるときだけ結合
      if (parent.has(c.user_id_a) && parent.has(c.user_id_b)) {
        union(c.user_id_a, c.user_id_b);
      }
    }
  }

  // クラスタ生成（root → members[]）
  const clusters = new Map<string, string[]>();
  for (const p of participants) {
    const r = find(p);
    if (!clusters.has(r)) clusters.set(r, []);
    clusters.get(r)!.push(p);
  }

  // 各クラスタ内をシャッフル
  const clusterArr = Array.from(clusters.values()).map((m) => shuffle([...m]));
  // クラスタを大きい順に並べる（同サイズはランダム順）
  shuffle(clusterArr);
  clusterArr.sort((a, b) => b.length - a.length);

  // グループ ID もシャッフル（同人数のグループが複数ある場合にバラけさせる）
  const shuffledGroupIds = shuffle([...groupIds]);

  // クラスタを「最も人数が少ないグループ」に投入
  for (const cluster of clusterArr) {
    let bestId = shuffledGroupIds[0];
    let bestSize = result.get(bestId)!.length;
    for (const gid of shuffledGroupIds) {
      const size = result.get(gid)!.length;
      if (size < bestSize) {
        bestSize = size;
        bestId = gid;
      }
    }
    result.get(bestId)!.push(...cluster);
  }

  return { byGroupId: result };
}

/* -------------------------------------------------------------------------- */
/* 違反検出                                                                  */
/* -------------------------------------------------------------------------- */

/** 制約違反の 1 件 */
export interface ConstraintViolation {
  constraint_id: number;
  user_id_a: string;
  user_id_b: string;
  direction: ConstraintDirection;
  strength: ConstraintStrength;
}

/**
 * 現在のグループ割り当てに対する制約違反を検出する。
 * - 片方または両方が割り当てに含まれない（プールにいる/不参加）場合はスキップ
 * - together: 2 人が別のグループにいると違反
 * - apart: 2 人が同じグループにいると違反
 */
export function detectViolations(
  groupOf: Map<string, number>,
  constraints: GroupingConstraint[],
): ConstraintViolation[] {
  const out: ConstraintViolation[] = [];
  for (const c of constraints) {
    const ga = groupOf.get(c.user_id_a);
    const gb = groupOf.get(c.user_id_b);
    if (ga === undefined || gb === undefined) continue;
    const violated = c.direction === 'together' ? ga !== gb : ga === gb;
    if (violated) {
      out.push({
        constraint_id: c.id,
        user_id_a: c.user_id_a,
        user_id_b: c.user_id_b,
        direction: c.direction,
        strength: c.strength,
      });
    }
  }
  return out;
}
