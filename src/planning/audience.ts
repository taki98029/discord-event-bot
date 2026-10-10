import type { Env } from '../env';
import { listGuildMemberPage } from '../discord/rest';
import { collectSegmentPeople } from './store';
import { requireValue, type PlanningPerson } from './model';

const PAGE_SIZE = 200;
type Progress = { checked?: number; token?: string; after?: string; people?: PlanningPerson[]; locked?: boolean };

export function mergePlanningAudience(previous: PlanningPerson[], current: PlanningPerson[]): PlanningPerson[] {
  const ids = new Set(current.map((p) => p.id));
  return [
    ...current.map((p) => ({ ...p, schedules: [...p.schedules].sort((a, b) => a - b), active: true })),
    ...previous.filter((p) => !ids.has(p.id)).map((p) => ({ ...p, active: false })),
  ].sort((a, b) => a.id.localeCompare(b.id));
}

/** One page per authenticated admin request. Answers never enter Worker memory on this path. */
export async function refreshPlanningAudience(env: Env, id: string, input: { version?: unknown; token?: unknown }) {
  const db = env.DB, now = Date.now();
  const row = await db.prepare(`SELECT id,guild_id,version,
      json_extract(data,'$.standalone') AS standalone,json_extract(data,'$.state') AS state,
      json_extract(data,'$.deadline') AS deadline,json_extract(data,'$.segments') AS segments,
      json_extract(data,'$.people') AS people,audience_progress AS value
    FROM planning_plans WHERE id=?`).bind(id)
    .first<{ id: string; guild_id: string; version: number; standalone: number; state: string; deadline: string; segments: string; people: string; value: string | null }>();
  requireValue(row, '日程調整が見つかりません', 404);
  requireValue(row.standalone && row.state === 'open' && Date.parse(row.deadline) > now,
    '回答受付中の日程調整だけ対象者を更新できます');
  requireValue(input && typeof input === 'object' && (input.token === undefined || typeof input.token === 'string'), '更新操作が不正です');
  const previous: Progress = row.value ? JSON.parse(row.value) : {};
  if (input.token !== undefined) {
    requireValue(input.token && input.token === previous.token && !previous.locked,
      '更新処理が変更されました。もう一度「対象者を更新」を押してください', 409);
  } else {
    requireValue(input.version === row.version, '最新の内容を読み直してください', 409);
    requireValue(!previous.token || (previous.checked ?? 0) < now - 60000,
      '対象者を更新中です。画面を閉じた場合は1分ほど待ってから再度お試しください', 409);
  }
  const progress = input.token === undefined ? {} : previous;
  const token = crypto.randomUUID();
  const claim = JSON.stringify({ ...progress, checked: now, token, locked: true });
  const claimed = await db.prepare('UPDATE planning_plans SET audience_progress=? WHERE id=? AND audience_progress IS ?')
    .bind(claim, row.id, row.value).run();
  requireValue(claimed.meta.changes, '別の更新処理が進行中です。時間をおいて再度お試しください', 409);
  const saveProgress = async (next: Progress) => {
    const saved = await db.prepare('UPDATE planning_plans SET audience_progress=? WHERE id=? AND audience_progress=?')
      .bind(JSON.stringify({ ...next, checked: now, token, locked: false }), row.id, claim).run();
    requireValue(saved.meta.changes, '更新処理が変更されました。もう一度お試しください', 409);
    return { token };
  };
  try {
    const segments: number[] = JSON.parse(row.segments);
    const hasRoles = await db.prepare("SELECT 1 FROM segments WHERE id IN (SELECT value FROM json_each(?)) AND COALESCE(mention_role_id,'')!='' LIMIT 1")
      .bind(row.segments).first();
    // ponytail: the admin tab advances the scan; add background jobs only if scans regularly outlive the tab.
    const page = hasRoles ? await listGuildMemberPage(env, row.guild_id, progress.after ?? '0', PAGE_SIZE)
      : { members: [], after: '0', done: true };
    requireValue(page.done || page.after !== (progress.after ?? '0'), 'メンバー一覧を最後まで取得できませんでした');
    const current = await collectSegmentPeople(env, row.guild_id, segments, page.members);
    const people = new Map((progress.people ?? []).map((p) => [p.id, p]));
    for (const person of current) {
      const old = people.get(person.id);
      people.set(person.id, { ...person, schedules: [...new Set([...(old?.schedules ?? []), ...person.schedules])] });
    }
    requireValue(people.size <= 200, '回答対象者が200人を超えています。区分を確認してください');
    if (!page.done) {
      return await saveProgress({ after: page.after, people: [...people.values()] });
    }
    const oldPeople: PlanningPerson[] = JSON.parse(row.people);
    const oldIds = new Set(oldPeople.filter((p) => p.active !== false).map((p) => p.id));
    const added = [...people.keys()].filter((id) => !oldIds.has(id)).length;
    const removed = [...oldIds].filter((id) => !people.has(id)).length;
    const updated = JSON.stringify(mergePlanningAudience(oldPeople, [...people.values()]));
    const condition = "id=? AND version=? AND audience_progress=? AND json_extract(data,'$.state')='open' AND julianday(json_extract(data,'$.deadline'))>julianday('now')";
    if (updated !== row.people) {
      const size = await db.prepare("SELECT length(CAST(json_set(data,'$.people',json(?)) AS BLOB)) AS bytes FROM planning_plans WHERE id=?")
        .bind(updated, row.id).first<{ bytes: number }>();
      requireValue(size && size.bytes <= 1800000, '回答・対象者の履歴が保存上限に達しました。新しい日程調整を作成してください');
      // SQL copies answers/history inside D1; avoid cloning/serializing up to 200 × 200 answers in Workers.
      const stamp = new Date(now).toISOString();
      const results = await db.batch([
        db.prepare(`INSERT INTO planning_history(plan_id,kind,before_data,after_data,reason,changed_at)
          SELECT id,'audience-refresh',json_remove(data,'$.answers','$.answerRevisions','$.answerVersions'),
            json_set(json_remove(data,'$.answers','$.answerRevisions','$.answerVersions'),'$.people',json(?)),
            'ロール・区分の対象者を更新',? FROM planning_plans WHERE ${condition}`)
          .bind(updated, stamp, row.id, row.version, claim),
        db.prepare(`UPDATE planning_plans SET data=json_set(data,'$.people',json(?)),version=version+1,mutation=?,updated_at=?,audience_progress=NULL WHERE ${condition}`)
          .bind(updated, crypto.randomUUID(), stamp, row.id, row.version, claim),
      ]);
      if (!results[1].meta.changes) return await saveProgress(progress); // A concurrent answer wins; retry this page.
    } else {
      const cleared = await db.prepare(`UPDATE planning_plans SET audience_progress=NULL WHERE ${condition}`)
        .bind(row.id, row.version, claim).run();
      if (!cleared.meta.changes) return await saveProgress(progress);
    }
    return { token: null, added, removed, total: people.size };
  } catch (e) {
    // A failed or abandoned scan must never publish a partial audience.
    await db.prepare('UPDATE planning_plans SET audience_progress=NULL WHERE id=? AND audience_progress=?')
      .bind(row.id, claim).run();
    throw e;
  }
}
