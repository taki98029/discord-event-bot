import type { Env } from '../env';
import { unanswered, type CycleData, type PlanData } from './model';
import { getPlan } from './store';
import { deliverPending, discord } from './delivery';
import { notifyDeliveryFailure } from '../discord/failureNotifications';
import { nextOccurrenceDates } from '../lib/recurrence';
import { getJSTNow } from '../lib/date';

/** Deterministic delivery keys make repeated and overlapping ticks harmless. */
async function enqueue(env: Env, id: string, plan: string, kind: string, channel: string, payload: unknown) {
  const now = new Date().toISOString();
  await env.DB.prepare(
    'INSERT OR IGNORE INTO planning_deliveries(id,plan_id,kind,channel_id,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
  )
    .bind(id, plan, kind, channel, JSON.stringify(payload), now, now)
    .run();
}
/** Calendar days and send time are JST. Missed days are not replayed as a burst. */
export function answerReminderDue(data: PlanData, stamp = Date.now()): boolean {
  const r = data.answerReminder;
  if (!r?.enabled || data.state !== 'open' || stamp >= Date.parse(data.deadline)) return false;
  const now = new Date(stamp + 9 * 3600000).toISOString();
  // 「締切当日のみ」（0 日前）で締切の時刻が送信時刻以前（典型: 00:00 締切）だと一度も送れないので、送れる最後の日（前日）にする。
  // 1 日前以上は従来どおり暦日で数える（公開中の日程調整の送る日を変えない）
  const [h, m] = r.time.split(':').map(Number);
  const shift = r.beforeDays === 0 ? (h * 60 + m) * 60000 + 1 : 0;
  const deadline = new Date(Date.parse(data.deadline) + 9 * 3600000 - shift).toISOString().slice(0, 10);
  const days = (Date.parse(deadline) - Date.parse(now.slice(0, 10))) / 86400000;
  return days >= 0 && days <= r.beforeDays && (r.beforeDays - days) % r.intervalDays === 0 && now.slice(11, 16) >= r.time;
}
export async function planningTick(env: Env) {
  const db = env.DB,
    now = getJSTNow(),
    today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const clock = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  // The posting due date has passed: move to the next one after today (no catch-up burst) and arm the reminder again.
  // No draft 日程調整 is created any more (2026-09-23); the template row itself carries the reminder state.
  // At most 5 per tick (each evaluates an rrule); moved rows leave the set, so the rest follow on the next ticks.
  const passed = (await db.prepare('SELECT * FROM planning_cycles WHERE enabled=1 AND next_date<? LIMIT 5').bind(today).all<any>()).results;
  for (const cycle of passed) {
    const c: CycleData = JSON.parse(cycle.data);
    const next = nextOccurrenceDates({ rrule: c.rrule, anchor_date: c.anchor.replace(/-/g, '/'), start_time: c.time }, 1, now)[0];
    await db
      .prepare("UPDATE planning_cycles SET next_date=?,task_status='pending',reminded_on=NULL WHERE id=? AND next_date=?")
      .bind(next?.replace(/\//g, '-') ?? '9999-12-31', cycle.id, cycle.next_date)
      .run();
  }
  // Same shape as the answer reminders: once a day at the send time, from taskReminderDays before the due date until the due date,
  // while no 回答案内 from this template has been posted (task_status stays 'pending').
  // At most 5 per tick (ADR 0033); reminded rows drop out via reminded_on, so the rest follow on the next ticks.
  const due = (
    await db
      .prepare(
        "SELECT * FROM planning_cycles WHERE enabled=1 AND task_status='pending' AND next_date>=? AND date(next_date,'-'||COALESCE(json_extract(data,'$.taskReminderDays'),0)||' days')<=? AND json_extract(data,'$.time')<=? AND (reminded_on IS NULL OR reminded_on<?) LIMIT 5",
      )
      .bind(today, today, clock, today)
      .all<any>()
  ).results;
  for (const cycle of due) {
    const c: CycleData = JSON.parse(cycle.data);
    // Claim today's reminder first so overlapping ticks post once; a failed post is reported, not retried today.
    const claim = await db
      .prepare('UPDATE planning_cycles SET reminded_on=? WHERE id=? AND (reminded_on IS NULL OR reminded_on<?)')
      .bind(today, cycle.id, today)
      .run();
    if (!claim.meta.changes) continue;
    // Role ids carry a `role:` prefix; rows saved before 2026-09-20 used mentionMode 'roles' with bare ids.
    const isRole = (x: string) => x.startsWith('role:') || c.mentionMode === 'roles';
    const bare = (x: string) => x.replace(/^role:/, '');
    const mentions = c.mentions.map((x) => (isRole(x) ? `<@&${bare(x)}>` : `<@${x}>`)).join(' ');
    try {
      await discord(env, `/channels/${c.adminChannel}/messages`, 'POST', {
        content: `${mentions}\n「${c.name}」の日程候補を作成し、回答案内を投稿してください。\n回答案内の投稿期限: ${cycle.next_date.replace(/-/g, '/')}\n${c.origin}/admin#g/${cycle.guild_id}/planning`,
        allowed_mentions: { parse: [], users: c.mentions.filter((x) => !isRole(x)), roles: c.mentions.filter(isRole).map(bare) },
      });
    } catch (e) {
      await notifyDeliveryFailure(
        env,
        cycle.guild_id,
        `日程調整のテンプレート「${c.name}」の日程候補作成のリマインド\n投稿先: <#${c.adminChannel}>\n${(e as Error).message}`,
      );
    }
  }
  const plans = (
    await db
      .prepare(
        "SELECT id FROM planning_plans WHERE json_extract(data,'$.state')='open' AND (json_extract(data,'$.answerReminder.enabled')=1 OR (json_type(data,'$.answerReminder') IS NULL AND json_extract(data,'$.remindDays')>0)) AND json_extract(data,'$.deadline')>? ORDER BY COALESCE(reminder_checked_at,'') LIMIT 1",
      )
      .bind(new Date().toISOString())
      .all<{ id: string }>()
  ).results;
  for (const row of plans) {
    const p = await getPlan(db, row.id);
    await db
      .prepare('UPDATE planning_plans SET reminder_checked_at=? WHERE id=?')
      .bind(new Date().toISOString(), row.id)
      .run();
    if (p.data.answerReminder) {
      if (!answerReminderDue(p.data)) continue;
      const users = p.data.people.filter((u) => unanswered(p.data, u.id).length).map((u) => u.id);
      const stamp = new Date().toISOString();
      if (p.data.answerReminder.target === 'channel') {
        // One channel post per 40 people, rebuilt at delivery time; the ids match the legacy channel reminder so each day posts once.
        for (let index = 0; index < users.length; index += 40)
          await enqueue(env, `reminder:${p.id}:${today}:${index}`, p.id, 'reminder', p.data.channel, {
            allowed_mentions: { parse: [], users: users.slice(index, index + 40) },
          });
        continue;
      }
      // One D1 statement for at most 200 users; the delivery worker drains the durable queue.
      await db.prepare(`INSERT OR IGNORE INTO planning_deliveries(id,plan_id,kind,channel_id,payload,created_at,updated_at)
        SELECT ?||value,?,'answer-dm',?,json_object('user',value),?,? FROM json_each(?)`)
        .bind(`answer-dm:${p.id}:${today}:`, p.id, p.data.channel, stamp, stamp, JSON.stringify(users)).run();
      continue;
    }
    const last = await db
      .prepare(
        "SELECT created_at FROM planning_deliveries WHERE plan_id=? AND kind IN ('publish','reminder') ORDER BY created_at DESC LIMIT 1",
      )
      .bind(p.id)
      .first<{ created_at: string }>();
    if (!last || Date.now() - Date.parse(last.created_at) < p.data.remindDays * 86400000) continue;
    const users = p.data.people.filter((u) => unanswered(p.data, u.id).length).map((u) => u.id);
    for (let index = 0; index < users.length; index += 40) {
      const group = users.slice(index, index + 40);
      await enqueue(env, `reminder:${p.id}:${today}:${index}`, p.id, 'reminder', p.data.channel, {
        allowed_mentions: { parse: [], users: group },
      });
    }
  }
  // Expire a queued reminder even if the initial forum post failed and never obtained a thread.
  await db.prepare(`UPDATE planning_deliveries SET status='cancelled',error='中止または開始時刻を過ぎたため取り消し'
    WHERE kind='event-reminder' AND status='pending' AND NOT EXISTS(
      SELECT 1 FROM planning_plans p,json_each(p.data,'$.slots') s,json_each(p.data,'$.candidates') c
      WHERE p.id=planning_deliveries.plan_id AND json_extract(p.data,'$.state')='confirmed'
        AND json_extract(s.value,'$.id')=planning_deliveries.slot_id AND json_extract(s.value,'$.cancelled')=0
        AND json_extract(c.value,'$.id')=json_extract(s.value,'$.candidate') AND json_extract(c.value,'$.time')!=''
        AND julianday(json_extract(c.value,'$.date')||'T'||json_extract(c.value,'$.time')||':00+09:00')>julianday('now'))`).run();
  // Query only a due slot; no loading every confirmed plan and every answer into Worker memory.
  const event = await db.prepare(`SELECT p.id,json_extract(s.value,'$.id') AS slot,json_extract(p.data,'$.forum') AS forum
    FROM planning_plans p,json_each(p.data,'$.slots') s,json_each(p.data,'$.candidates') c
    WHERE json_extract(p.data,'$.state')='confirmed' AND json_extract(p.data,'$.standalone')=1
      AND json_extract(p.data,'$.eventReminderHours')>0 AND json_extract(s.value,'$.cancelled')=0
      AND json_extract(c.value,'$.id')=json_extract(s.value,'$.candidate') AND json_extract(c.value,'$.time')!=''
      AND julianday(json_extract(c.value,'$.date')||'T'||json_extract(c.value,'$.time')||':00+09:00')>julianday('now')
      AND julianday(json_extract(c.value,'$.date')||'T'||json_extract(c.value,'$.time')||':00+09:00')-json_extract(p.data,'$.eventReminderHours')/24.0<=julianday('now')
      AND NOT EXISTS(SELECT 1 FROM planning_deliveries d WHERE d.id='event-reminder:'||p.id||':'||json_extract(s.value,'$.id'))
    ORDER BY json_extract(c.value,'$.date'),json_extract(c.value,'$.time') LIMIT 1`).first<{ id: string; slot: string; forum: string }>();
  if (event) {
    const stamp = new Date().toISOString();
    await db.prepare("INSERT OR IGNORE INTO planning_deliveries(id,plan_id,kind,slot_id,channel_id,payload,created_at,updated_at) VALUES(?,?,'event-reminder',?,?,'{}',?,?)")
      .bind(`event-reminder:${event.id}:${event.slot}`, event.id, event.slot, event.forum, stamp, stamp).run();
  }
  // ponytail: four deliveries per two-minute tick; 200 DMs take about 100 minutes. Prioritize event posts.
  await deliverPending(env, 4);
}
