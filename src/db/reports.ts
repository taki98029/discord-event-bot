// 出勤レポート（管理UI・区分単位）。
// 「出勤」= 開催回（occurrences）への status='参加' 回答。
// 母数はその区分の Notification（requires_response=1）に属する開催済み開催回（scheduled・当日まで）。
import { resolveDisplayName } from './types';
import { getActiveSegmentMembers } from './segments';

export interface AttendanceRow {
  user_id: string;
  name: string;
  /** 全期間での初出勤日（'YYYY/MM/DD'）。一度も参加なしは null */
  first_date: string | null;
  /** 集計期間内の参加回数 */
  attended: number;
  /** 集計期間内の対象開催回数（母数） */
  total: number;
  /** attended / total。母数 0 は null（表示側で「—」） */
  rate: number | null;
  /** 期間内の直近の参加日（新しい順・最大3件）。先頭が前回出勤 */
  recent: string[];
}

/**
 * 区分の出勤レポートを集計する。
 * from 未指定時は各メンバーの初出勤日を期間の起点にする（＝デフォルトは初出勤〜現在）。
 * from 指定時は全員同一期間で集計し、未参加者も 0% として出す。
 * notificationId 指定時はその通知の開催回だけを対象にする（母集団は区分のまま）。
 */
export async function getAttendanceReport(
  db: D1Database,
  segmentId: number,
  opts: { from?: string | null; to?: string | null; today: string; notificationId?: number | null },
): Promise<AttendanceRow[]> {
  const upper = opts.to && opts.to < opts.today ? opts.to : opts.today;
  const members = await getActiveSegmentMembers(db, segmentId);
  const notifCond = opts.notificationId ? ' AND n.id = ?' : '';
  const binds = opts.notificationId ? [segmentId, upper, opts.notificationId] : [segmentId, upper];

  // 対象開催回の日付（母数）。中止回・回答不要（通知のみ）の通知は含めない。
  const occ = await db
    .prepare(
      `SELECT o.id, o.occurrence_date AS d, po.plan_id
         FROM occurrences o
         JOIN notifications n ON n.id = o.notification_id
         LEFT JOIN planning_occurrences po ON po.occurrence_id=o.id
        WHERE n.segment_id = ? AND n.requires_response = 1
          AND o.status = 'scheduled' AND o.occurrence_date <= ?${notifCond}
        ORDER BY o.occurrence_date`,
    )
    .bind(...binds)
    .all<{ id:number; d: string; plan_id:string|null }>();
  const roster=(await db.prepare("SELECT occurrence_id,user_id FROM planning_roster WHERE status!='除外'").all<{occurrence_id:number;user_id:string}>()).results;
  const targets=new Set(roster.map(r=>`${r.occurrence_id}:${r.user_id}`));

  // 各メンバーの参加日（初出勤の判定に使うため from では絞らず、上限のみ適用）。
  const att = await db
    .prepare(
      `SELECT r.user_id AS user_id, o.occurrence_date AS d
         FROM (SELECT occurrence_id,user_id,status FROM responses UNION ALL SELECT occurrence_id,user_id,status FROM planning_roster WHERE status!='除外') r
         JOIN occurrences o ON o.id = r.occurrence_id
         JOIN notifications n ON n.id = o.notification_id
        WHERE n.segment_id = ? AND n.requires_response = 1 AND r.status = '参加'
          AND o.status = 'scheduled' AND o.occurrence_date <= ?${notifCond}
        ORDER BY o.occurrence_date`,
    )
    .bind(...binds)
    .all<{ user_id: string; d: string }>();
  const attendsOf = new Map<string, string[]>();
  for (const r of att.results) {
    const list = attendsOf.get(r.user_id);
    if (list) list.push(r.d);
    else attendsOf.set(r.user_id, [r.d]);
  }

  return members.map((m) => {
    const all = attendsOf.get(m.user_id) ?? [];
    const first = all[0] ?? null;
    // 期間の起点: 明示指定 > 初出勤日。どちらも無い（未参加＋from なし）は母数なし。
    const lower = opts.from ?? first;
    const inRange = (d: string) => lower !== null && d >= lower;
    const attended = all.filter(inRange);
    const total = lower === null ? 0 : occ.results.filter(r=>inRange(r.d)&&(!r.plan_id||targets.has(`${r.id}:${m.user_id}`))).length;
    return {
      user_id: m.user_id,
      name: resolveDisplayName(m),
      first_date: first,
      attended: attended.length,
      total,
      rate: total > 0 ? attended.length / total : null,
      recent: attended.slice(-3).reverse(),
    };
  });
}
