import type { Plan, PlanData, PlanningPerson } from './model';
import { requireValue, PlanningError } from './model';
import type { Env } from '../env';
import { listGuildMembers, type GuildMemberSummary } from '../discord/rest';
import { membersWithRole } from '../discord/syncSegment';

export type PlanRow = Omit<Plan, 'data'> & { data: string };
export function planFromRow(row: PlanRow | null | undefined): Plan {
  requireValue(row, '開催計画が見つかりません', 404);
  return { ...row, data: JSON.parse(row.data) };
}

export async function getPlan(db: D1Database, id: string): Promise<Plan> {
  const row = await db
    .prepare('SELECT id,guild_id,version,data FROM planning_plans WHERE id=?')
    .bind(id)
    .first<PlanRow>();
  return planFromRow(row);
}
export async function listPlans(db: D1Database, guild: string): Promise<Plan[]> {
  const r = await db
    .prepare('SELECT id,guild_id,version,data FROM planning_plans WHERE guild_id=? ORDER BY created_at DESC')
    .bind(guild)
    .all<{ id: string; guild_id: string; version: number; data: string }>();
  return r.results.map((x) => ({ ...x, data: JSON.parse(x.data) }));
}
export async function collectPeople(db: D1Database, guild: string, ids: number[]): Promise<PlanningPerson[]> {
  requireValue(ids.length > 0 && ids.length <= 10, '対象テンプレートを1〜10件選択してください');
  const schedules = (
    await db
      .prepare(
        'SELECT id,guild_id,rrule,requires_response FROM notifications WHERE id IN (SELECT value FROM json_each(?))',
      )
      .bind(JSON.stringify(ids))
      .all<any>()
  ).results;
  requireValue(
    schedules.length === ids.length &&
      schedules.every((n) => n.guild_id === guild && !n.rrule && n.requires_response === 1),
    '同じサーバーの出欠確認ありの不定期のテンプレートを選択してください',
  );
  const rows = (
    await db
      .prepare(
        `SELECT n.id AS schedule,m.user_id,COALESCE(gp.display_name,m.display_name,m.user_name,m.user_id) AS name FROM notifications n JOIN segment_members sm ON sm.segment_id=n.segment_id AND sm.status='' JOIN members m ON m.user_id=sm.user_id LEFT JOIN member_guild_profiles gp ON gp.user_id=m.user_id AND gp.guild_id=n.guild_id WHERE n.id IN (SELECT value FROM json_each(?))`,
      )
      .bind(JSON.stringify(ids))
      .all<{ schedule: number; user_id: string; name: string }>()
  ).results;
  const map = new Map<string, PlanningPerson>();
  for (const m of rows) {
    const person = map.get(m.user_id) ?? { id: m.user_id, name: m.name, schedules: [] };
    person.schedules.push(m.schedule);
    map.set(m.user_id, person);
  }
  requireValue(map.size <= 200, '対象者は200人以内にしてください');
  return [...map.values()];
}
export async function collectSegmentPeople(
  env: Env,
  guild: string,
  ids: number[],
  source?: GuildMemberSummary[],
): Promise<PlanningPerson[]> {
  const db = env.DB;
  requireValue(ids.length > 0 && ids.length <= 10, '回答対象の区分を1〜10件選択してください');
  const groups = (
    await db
      .prepare('SELECT id,guild_id,mention_role_id FROM segments WHERE id IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify(ids))
      .all<{ id: number; guild_id: string; mention_role_id: string | null }>()
  ).results;
  requireValue(
    groups.length === ids.length && groups.every((s) => s.guild_id === guild),
    '同じサーバーのメンバー区分を選択してください',
  );
  const rows = (
    await db
      .prepare(
        `SELECT s.id AS schedule,m.user_id,sm.status,COALESCE(gp.display_name,m.display_name,m.user_name,m.user_id) AS name
    FROM segments s JOIN segment_members sm ON sm.segment_id=s.id
    JOIN members m ON m.user_id=sm.user_id
    LEFT JOIN member_guild_profiles gp ON gp.user_id=m.user_id AND gp.guild_id=s.guild_id
    WHERE s.id IN (SELECT value FROM json_each(?))
    ${source ? "AND (COALESCE(s.mention_role_id,'')='' OR sm.user_id IN (SELECT value FROM json_each(?)))" : ''}`,
      )
      .bind(JSON.stringify(ids), ...(source ? [JSON.stringify(source.map((m) => m.user_id))] : []))
      .all<{ schedule: number; user_id: string; name: string; status: string }>()
  ).results;
  // Planning has no scheduled occurrence to trigger role sync. Read Discord once for the snapshot.
  let discordMembers: GuildMemberSummary[] = source ?? [];
  if (!source && groups.some((s) => s.mention_role_id)) {
    try {
      discordMembers = await listGuildMembers(env, guild);
    } catch {
      throw new PlanningError('Discordのロールを取得できませんでした。時間をおいて再試行してください。', 503);
    }
  }
  const people = new Map<string, PlanningPerson>();
  for (const group of groups) {
    const stored = rows.filter((r) => r.schedule === group.id);
    const paused = new Set(stored.filter((r) => r.status !== '').map((r) => r.user_id));
    const members = group.mention_role_id
      ? membersWithRole(discordMembers, group.mention_role_id).map((m) => ({
          user_id: m.user_id, name: m.display_name ?? m.user_name ?? m.user_id,
        }))
      : stored;
    for (const member of members) {
      if (paused.has(member.user_id)) continue;
      const person = people.get(member.user_id) ?? { id: member.user_id, name: member.name, schedules: [] };
      person.schedules.push(group.id);
      people.set(member.user_id, person);
    }
  }
  requireValue(people.size <= 200, '対象者は200人以内にしてください');
  return [...people.values()];
}
/** Distinct role ids (or '@everyone') of the given segments, for the answer announcement mention. */
export async function segmentMentionRoles(db: D1Database, ids: number[]): Promise<string[]> {
  const rows = (
    await db
      .prepare("SELECT DISTINCT mention_role_id AS role FROM segments WHERE id IN (SELECT value FROM json_each(?)) AND COALESCE(mention_role_id,'')!='' ORDER BY role")
      .bind(JSON.stringify(ids))
      .all<{ role: string }>()
  ).results;
  return rows.map((r) => r.role);
}
export async function createPlan(
  db: D1Database,
  guild: string,
  data: PlanData,
  id = crypto.randomUUID(),
): Promise<Plan> {
  const now = new Date().toISOString();
  await db
    .prepare(
      'INSERT INTO planning_plans(id,guild_id,data,mutation,created_at,updated_at) VALUES(?,?,?,?,?,?)',
    )
    .bind(id, guild, JSON.stringify(data), crypto.randomUUID(), now, now)
    .run();
  return getPlan(db, id);
}
/** Every dependent statement runs only when the optimistic update succeeded, in the same D1 transaction. */
export async function savePlan(
  db: D1Database,
  p: Plan,
  next: PlanData,
  kind: string,
  reason = '',
  user: string | null = null,
  extra?: (guard: string, token: string) => D1PreparedStatement[],
  sessionHash?: string,
): Promise<Plan> {
  const token = crypto.randomUUID(),
    now = new Date().toISOString();
  next = structuredClone(next);
  // Derive versions for every writer, including proxy edits. Web submissions are atomic per person.
  const revisions = { ...p.data.answerRevisions };
  const versions = { ...p.data.answerVersions };
  const changedUsers: string[] = [];
  for (const userId of new Set([...Object.keys(p.data.answers), ...Object.keys(next.answers)])) {
    const before = p.data.answers[userId],
      after = next.answers[userId];
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      versions[userId] = p.version + 1;
      delete revisions[userId];
      changedUsers.push(userId);
    }
  }
  if (Object.keys(revisions).length) next.answerRevisions = revisions;
  else delete next.answerRevisions;
  if (Object.keys(versions).length) next.answerVersions = versions;
  else delete next.answerVersions;
  const serialized = JSON.stringify(next);
  requireValue(new TextEncoder().encode(serialized).byteLength <= 1800000,
    '回答・候補の履歴が保存上限に達しました。新しい日程調整を作成してください');
  // Store the answers changed by this operation, not every participant's unchanged answers twice.
  // Existing history stays untouched. All current/retired answers remain in the plan.
  const history = (data: PlanData) => JSON.stringify({
    ...data, answerRevisions: undefined, answerVersions: undefined,
    answers: Object.fromEntries(changedUsers.filter((id) => data.answers[id]).map((id) => [id, data.answers[id]])),
  });
  const guard = `EXISTS (SELECT 1 FROM planning_plans WHERE id='${p.id.replace(/'/g, "''")}' AND mutation='${token}')`;
  const result = await db.batch<PlanRow>([
    db
      .prepare(
        `UPDATE planning_plans SET data=?,version=version+1,mutation=?,updated_at=? WHERE id=? AND version=? ${kind === 'participant-answer' ? "AND json_extract(data,'$.state')='open' AND julianday(json_extract(data,'$.deadline'))>julianday('now')" : ''}
        ${sessionHash ? "AND EXISTS (SELECT 1 FROM planning_browser_sessions WHERE guild_id=planning_plans.guild_id AND user_id=? AND token_hash=? AND expires_at>(julianday('now')-2440587.5)*86400000)" : ''}`,
      )
      .bind(serialized, token, now, p.id, p.version, ...(sessionHash ? [user, sessionHash] : [])),
    db
      .prepare(
        `INSERT INTO planning_history(plan_id,kind,user_id,before_data,after_data,reason,changed_at) SELECT ?,?,?,?,?,?,? WHERE ${guard}`,
      )
      .bind(p.id, kind, user, history(p.data), history(next), reason, now),
    ...(extra?.(guard, token) ?? []),
    // Return the committed snapshot in the same round trip as the atomic write and history.
    db.prepare('SELECT id,guild_id,version,data FROM planning_plans WHERE id=?').bind(p.id),
  ]);
  if (!result[0].meta.changes)
    throw new PlanningError('別の操作で更新されました。最新の内容を読み直してください', 409);
  return planFromRow(result[result.length - 1].results[0]);
}
export async function plannedOccurrence(db: D1Database, id: number): Promise<boolean> {
  return !!(await db.prepare('SELECT 1 FROM planning_occurrences WHERE occurrence_id=?').bind(id).first());
}
