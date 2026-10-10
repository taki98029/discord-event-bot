import type { Env } from '../env';
import {
  blankPlan,
  dateValue,
  timeValue,
  isAnswer,
  requireValue,
  PlanningError,
  MAX_CANDIDATES,
  type Plan,
  type PlanData,
  type Slot,
  type CycleData,
} from './model';
import { collectPeople, collectSegmentPeople, createPlan, getPlan, listPlans, savePlan, segmentMentionRoles } from './store';
import { answerAnnouncement, deliveryStatement, discord, slotPayload, validateChannel } from './delivery';
import { normalizeRule } from '../lib/rruleGrammar';
import { withEnabled } from '../discord/channelFilter';
import { anchorMatchesRule, nextOccurrenceDates } from '../lib/recurrence';
import { validateAnnouncementTemplate, withoutRetiredTokens } from './announcement';
import { refreshPlanningAudience } from './audience';

const json = (data: unknown, status = 200) => Response.json(data, { status });
function text(x: unknown, max: number) {
  requireValue(typeof x === 'string' && x.length <= max, '入力内容が長すぎるか不正です');
  return x.trim();
}
function ids(x: unknown, label = 'テンプレート'): number[] {
  requireValue(
    Array.isArray(x) && x.length <= 10 && x.every((v) => Number.isSafeInteger(v) && v > 0),
    `${label}の指定が不正です`,
  );
  return [...new Set(x)];
}
function validateCycleReminder(d: CycleData, rule: string | null) {
  requireValue(
    rule &&
      dateValue(d.anchor) &&
      timeValue(d.time) &&
      anchorMatchesRule(rule, d.anchor.replace(/-/g, '/')),
    '繰り返しと初回の期限を確認してください',
  );
  const lead = d.taskReminderDays ?? 0;
  requireValue(
    Number.isInteger(lead) && lead >= 0 && lead <= 30,
    '日程候補作成のリマインドは投稿期限の0〜30日前から設定してください',
  );
  requireValue(
    ['users', 'roles'].includes(d.mentionMode) &&
      Array.isArray(d.mentions) &&
      d.mentions.length > 0 &&
      d.mentions.length <= 30 &&
      d.mentions.every((x) => /^(role:)?\d{5,22}$/.test(x)), // `role:` prefix = Discord role id (2026-09-20)
    '担当者を選択してください',
  );
}
type CommunicationSettings = Pick<PlanData, 'answerReminder' | 'announcementTemplate' | 'eventReminderHours' | 'autoAudience' | 'announceMention' | 'shareAnswers'>;
function communicationSettings(input: any): CommunicationSettings {
  const settings: CommunicationSettings = { autoAudience: false };
  if (input.answerReminder !== undefined) {
    const r = input.answerReminder;
    requireValue(r && typeof r.enabled === 'boolean' && Number.isInteger(r.beforeDays) && r.beforeDays >= 0 && r.beforeDays <= 30 &&
      Number.isInteger(r.intervalDays) && r.intervalDays >= 1 && r.intervalDays <= 30 && typeof r.time === 'string' && timeValue(r.time) &&
      (r.target === undefined || r.target === 'dm' || r.target === 'channel'),
      '催促は締切の0〜30日前・1〜30日ごと・日本時間の時刻で設定してください');
    settings.answerReminder = { enabled: r.enabled, beforeDays: r.beforeDays, intervalDays: r.intervalDays, time: r.time, target: r.target === 'channel' ? 'channel' : 'dm' };
  }
  if (input.announceMention !== undefined) {
    requireValue(input.announceMention === 'none' || input.announceMention === 'role', '回答案内のメンションを選択してください');
    settings.announceMention = input.announceMention;
  }
  if (input.shareAnswers !== undefined) {
    requireValue(typeof input.shareAnswers === 'boolean', '他の回答者の回答を見せる設定を確認してください');
    settings.shareAnswers = input.shareAnswers;
  }
  if (input.announcementTemplate !== undefined) {
    settings.announcementTemplate = withoutRetiredTokens(text(input.announcementTemplate, 3000));
    validateAnnouncementTemplate(settings.announcementTemplate);
  }
  if (input.eventReminderHours !== undefined) {
    requireValue(typeof input.eventReminderHours === 'number' && Number.isInteger(input.eventReminderHours) && input.eventReminderHours >= 0 && input.eventReminderHours <= 168,
      '開催前リマインドは1〜168時間前、0で無効にしてください');
    settings.eventReminderHours = input.eventReminderHours;
  }
  return settings;
}
async function validateOneOffChannels(env: Env, b: any) {
  await validateChannel(env, b.guild_id, b.channel);
  await validateChannel(env, b.guild_id, b.forum, true, b.tag);
}
async function segmentNames(db: D1Database, segments: number[]): Promise<Record<string, string>> {
  return Object.fromEntries(
    (
      await db
        .prepare('SELECT id,name FROM segments WHERE id IN (SELECT value FROM json_each(?))')
        .bind(JSON.stringify(segments))
        .all<{ id: number; name: string }>()
    ).results.map((s) => [s.id, s.name]),
  );
}
export function editSettings(d: PlanData, b: any) {
  d.name = text(b.name, 150);
  requireValue(d.name, '計画名を入力してください');
  d.note = text(b.note ?? '', 1000);
  d.channel = text(b.channel, 30);
  d.forum = text(b.forum, 30);
  d.tag = text(b.tag ?? '', 30);
  d.deadline = text(b.deadline ?? '', 40);
  requireValue(!d.deadline || Number.isFinite(Date.parse(d.deadline)), '回答締切が不正です');
  if (d.deadline) d.deadline = new Date(d.deadline).toISOString();
  d.remindDays = Number(b.remindDays ?? 0);
  requireValue(
    Number.isInteger(d.remindDays) && d.remindDays >= 0 && d.remindDays <= 30,
    '催促間隔は0〜30日です',
  );
  Object.assign(d, communicationSettings(b));
}
/** Confirmation is a bounded transaction, regardless of roster size (D1 Free: 50 queries/invocation). */
export async function confirmPlan(db: D1Database, p: Plan, next: PlanData, reason = ''): Promise<Plan> {
  requireValue(['draft', 'open'].includes(p.data.state), 'この計画は確定できません');
  requireValue(next.slots.length > 0, '開催枠と参加者を選択してください');
  next.slots = selections(next, next.slots);
  if (next.standalone) {
    for (const slot of next.slots) {
      requireValue(
        slot.members.some((m) => m.status === '参加'),
        '各開催枠の参加者を選択してください',
      );
      slot.schedules = [...new Set(slot.members.map((m) => m.schedule))];
    }
    next.state = 'confirmed';
    return savePlan(db, p, next, 'confirm', reason, null, (g) =>
      next.slots.map((slot) =>
        deliveryStatement(
          db,
          p,
          g,
          crypto.randomUUID(),
          'forum',
          next.forum,
          slotPayload({ ...p, data: next }, slot, true),
          slot.id,
        ),
      ),
    );
  }
  const ns = (
    await db
      .prepare(
        'SELECT id,name,guild_id,rrule,requires_response FROM notifications WHERE id IN (SELECT value FROM json_each(?))',
      )
      .bind(JSON.stringify(next.schedules))
      .all<any>()
  ).results;
  requireValue(
    ns.length === next.schedules.length &&
      ns.every((n) => n.guild_id === p.guild_id && !n.rrule && n.requires_response === 1),
    '対象テンプレートが変更されています',
  );
  next.scheduleNames = Object.fromEntries(ns.map((n) => [n.id, n.name]));
  const specs: Array<{ uuid: string; slot: string; n: number; date: string; time: string; note: string }> =
    [];
  const roster: Array<{ slot: string; n: number; user: string; name: string; status: string; duty: string }> =
    [];
  const jobs: Array<{ id: string; slot: string; payload: string }> = [];
  for (const slot of next.slots) {
    const c = next.candidates.find((c) => c.id === slot.candidate && c.active);
    requireValue(c, '採用候補が無効です');
    requireValue(
      slot.members.some((m) => m.status === '参加'),
      '各開催枠の参加者を選択してください',
    );
    slot.schedules = [...new Set(slot.members.map((m) => m.schedule))];
    for (const n of slot.schedules)
      specs.push({
        uuid: crypto.randomUUID(),
        slot: slot.id,
        n,
        date: c.date.replace(/-/g, '/'),
        time: c.time,
        note: slot.note,
      });
    for (const m of slot.members)
      roster.push({
        slot: slot.id,
        n: m.schedule,
        user: m.user,
        name: next.people.find((u) => u.id === m.user)!.name,
        status: m.status,
        duty: m.duty,
      });
    jobs.push({
      id: crypto.randomUUID(),
      slot: slot.id,
      payload: JSON.stringify(slotPayload({ ...p, data: next }, slot, true)),
    });
  }
  const specJSON = JSON.stringify(specs);
  const duplicate = await db
    .prepare(
      "SELECT 1 FROM occurrences o JOIN json_each(?) j ON o.notification_id=json_extract(j.value,'$.n') AND o.occurrence_date=json_extract(j.value,'$.date') AND o.start_time=json_extract(j.value,'$.time') LIMIT 1",
    )
    .bind(specJSON)
    .first();
  requireValue(
    !duplicate,
    'このテンプレートには同じ開催日時が既に登録されています。別の日時を選択してください',
    409,
  );
  next.state = 'confirmed';
  const now = new Date().toISOString();
  return savePlan(db, p, next, 'confirm', reason, null, (g) => [
    db
      .prepare(
        `INSERT INTO occurrences(uuid,notification_id,occurrence_date,start_time,status,origin,note) SELECT json_extract(value,'$.uuid'),json_extract(value,'$.n'),json_extract(value,'$.date'),json_extract(value,'$.time'),'scheduled','manual',json_extract(value,'$.note') FROM json_each(?) WHERE ${g}`,
      )
      .bind(specJSON),
    db
      .prepare(
        `INSERT INTO planning_occurrences(occurrence_id,plan_id,slot_id) SELECT o.id,?,json_extract(j.value,'$.slot') FROM json_each(?) j JOIN occurrences o ON o.uuid=json_extract(j.value,'$.uuid') WHERE ${g}`,
      )
      .bind(p.id, specJSON),
    db
      .prepare(
        `INSERT INTO planning_roster(occurrence_id,user_id,name,status,duty) SELECT po.occurrence_id,json_extract(j.value,'$.user'),json_extract(j.value,'$.name'),json_extract(j.value,'$.status'),json_extract(j.value,'$.duty') FROM json_each(?) j JOIN planning_occurrences po ON po.plan_id=? AND po.slot_id=json_extract(j.value,'$.slot') JOIN occurrences o ON o.id=po.occurrence_id AND o.notification_id=json_extract(j.value,'$.n') WHERE ${g}`,
      )
      .bind(JSON.stringify(roster), p.id),
    db
      .prepare(
        `INSERT INTO planning_deliveries(id,plan_id,kind,slot_id,channel_id,payload,created_at,updated_at) SELECT json_extract(value,'$.id'),?,'forum',json_extract(value,'$.slot'),?,json_extract(value,'$.payload'),?,? FROM json_each(?) WHERE ${g}`,
      )
      .bind(p.id, next.forum, now, now, JSON.stringify(jobs)),
  ]);
}

function selections(p: PlanData, input: any): Slot[] {
  requireValue(Array.isArray(input) && input.length <= 40, '開催枠の指定が不正です');
  const seen = new Set<string>();
  return input.map((s: any) => {
    requireValue(
      p.candidates.some((c) => c.active && c.id === s.candidate) && !seen.has(s.candidate),
      '候補が無効または重複しています',
    );
    seen.add(s.candidate);
    requireValue(Array.isArray(s.members) && s.members.length <= 100, '名簿が不正です');
    const membersSeen = new Set<string>();
    const members = s.members.map((m: any) => {
      const person = p.people.find((u) => u.id === m.user);
      requireValue(person && person.active !== false && person.schedules.includes(m.schedule), '対象外の参加者または区分です。選定を確認してください');
      requireValue(m.status === '除外' || p.answers[m.user]?.values[s.candidate] === '可', '〇以外の回答の人は選定できません。代理変更で〇にしてから選定してください');
      const key = `${m.user}:${m.schedule}`;
      requireValue(!membersSeen.has(key), '名簿が重複しています');
      membersSeen.add(key);
      requireValue(['参加', '未定', '不参加', '除外'].includes(m.status), '参加予定の状態が不正です');
      return { user: person!.id, schedule: m.schedule, status: m.status, duty: text(m.duty ?? '', 60) };
    });
    const old = p.slots.find((x) => x.candidate === s.candidate);
    return {
      schedules: old?.schedules,
      id: old?.id ?? crypto.randomUUID(),
      candidate: s.candidate,
      members,
      cancelled: old?.cancelled ?? false,
      gather: text(s.gather ?? '', 80),
      note: text(s.note ?? '', 1000),
    };
  });
}
export async function handlePlanningAdmin(request: Request, env: Env, path: string): Promise<Response> {
  try {
    const db = env.DB,
      url = new URL(request.url),
      method = request.method;
    requireValue(method === 'GET' || method === 'POST', 'この操作方法は利用できません', 405);
    const b: any = method === 'GET' ? {} : await request.json();
    if (path === '/planning/segments' && method === 'GET')
      return json(
        (
          await db
            .prepare('SELECT id,name FROM segments WHERE guild_id=? ORDER BY name')
            .bind(url.searchParams.get('guild_id'))
            .all()
        ).results,
      );
    if (path === '/planning/profiles') {
      if (method === 'GET')
        return json(
          (
            await db
              .prepare(
                "SELECT * FROM planning_cycles WHERE guild_id=? AND json_extract(data,'$.standalone')=1",
              )
              .bind(url.searchParams.get('guild_id'))
              .all<any>()
          ).results.map((x) => ({ ...x, data: JSON.parse(x.data) })),
        );
      const input = b.data as CycleData;
      requireValue(input, '設定を入力してください');
      const segments = ids(input.segments, '回答対象の区分');
      await collectSegmentPeople(env, b.guild_id, segments);
      const name = text(input.name, 150);
      requireValue(name, '設定名を入力してください');
      await validateChannel(env, b.guild_id, input.channel);
      await validateChannel(env, b.guild_id, input.forum, true, input.tag);
      const remindDays = Number(input.remindDays ?? 0);
      requireValue(
        Number.isInteger(remindDays) && remindDays >= 0 && remindDays <= 30,
        '催促間隔は0〜30日です',
      );
      const enabled = b.enabled === true;
      const rule = normalizeRule(input.rrule);
      if (enabled) {
        validateCycleReminder(input, rule);
        await validateChannel(env, b.guild_id, input.adminChannel);
      }
      const id = b.id ?? crypto.randomUUID();
      const old = await db.prepare('SELECT * FROM planning_cycles WHERE id=?').bind(id).first<any>();
      requireValue(
        !old || (old.guild_id === b.guild_id && JSON.parse(old.data).standalone),
        '設定が一致しません',
      );
      const data: CycleData = {
        standalone: true,
        segments,
        schedules: [],
        name,
        channel: input.channel,
        forum: input.forum,
        tag: input.tag ?? '',
        remindDays,
        ...communicationSettings(input),
        rrule: rule ?? '',
        anchor: input.anchor,
        time: input.time,
        adminChannel: input.adminChannel,
        mentionMode: input.mentionMode,
        mentions: input.mentions,
        taskReminderDays: Number(input.taskReminderDays ?? 0),
        origin: url.origin,
      };
      const next = enabled
        ? nextOccurrenceDates(
            { rrule: rule!, anchor_date: input.anchor.replace(/-/g, '/'), start_time: input.time },
            1,
          )
        : [];
      const serialized = JSON.stringify(data);
      const nextDate = enabled
        ? old?.enabled && old.data === serialized
          ? old.next_date
          : [input.anchor, (next[0] ?? input.anchor).replace(/\//g, '-')].sort().at(-1)
        : '9999-12-31';
      await db
        .prepare(
          'INSERT INTO planning_cycles(id,guild_id,data,next_date,enabled) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,next_date=excluded.next_date,enabled=excluded.enabled',
        )
        .bind(id, b.guild_id, serialized, nextDate, enabled ? 1 : 0)
        .run();
      return json({ id });
    }
    if (path === '/planning/schedules' && method === 'GET')
      return json(
        (
          await db
            .prepare(
              'SELECT id,name,segment_id,duration_minutes FROM notifications WHERE guild_id=? AND rrule IS NULL AND requires_response=1',
            )
            .bind(url.searchParams.get('guild_id'))
            .all()
        ).results,
      );
    if (path === '/planning/channels') {
      const guild = url.searchParams.get('guild_id') ?? '';
      const rows = env.MOCK_DISCORD ? [] : await discord(env, `/guilds/${guild}/channels`);
      return json(
        await withEnabled(
          db,
          guild,
          rows
            .filter((c: any) => [0, 5, 15].includes(c.type))
            .map((c: any) => ({ id: c.id, name: c.name, type: c.type, tags: c.available_tags ?? [] })),
        ),
      );
    }
    if (path === '/planning/cycles') {
      if (method === 'GET')
        return json(
          (
            await db
              .prepare('SELECT * FROM planning_cycles WHERE guild_id=?')
              .bind(url.searchParams.get('guild_id'))
              .all<any>()
          ).results.map((x) => ({ ...x, data: JSON.parse(x.data) })),
        );
      const d = b.data as CycleData;
      requireValue(d, '設定を入力してください');
      requireValue(b.id, '新規の設定は日程調整設定で作成してください');
      const rule = normalizeRule(d.rrule);
      validateCycleReminder(d, rule);
      await collectPeople(db, b.guild_id, ids(d.schedules));
      await validateChannel(env, b.guild_id, d.adminChannel);
      await validateChannel(env, b.guild_id, d.channel);
      await validateChannel(env, b.guild_id, d.forum, true, d.tag);
      const id = b.id ?? crypto.randomUUID();
      const old = await db.prepare('SELECT * FROM planning_cycles WHERE id=?').bind(id).first<any>();
      requireValue(
        old && old.guild_id === b.guild_id && !JSON.parse(old.data).standalone,
        '設定が一致しません',
      );
      const data = { ...d, name: text(d.name, 150), rrule: rule, origin: url.origin };
      const next = nextOccurrenceDates(
        { rrule: rule, anchor_date: d.anchor.replace(/-/g, '/'), start_time: d.time },
        3,
      );
      await db
        .prepare(
          'INSERT INTO planning_cycles(id,guild_id,data,next_date,enabled) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,enabled=excluded.enabled,next_date=excluded.next_date',
        )
        .bind(
          id,
          b.guild_id,
          JSON.stringify(data),
          old && old.data === JSON.stringify(data)
            ? old.next_date
            : [d.anchor, (next[0] ?? d.anchor).replace(/\//g, '-')].sort().at(-1)!,
          b.enabled === false ? 0 : 1,
        )
        .run();
      return json({ id, next });
    }
    if (path === '/planning') {
      if (method === 'GET') return json(await listPlans(db, url.searchParams.get('guild_id') ?? ''));
      requireValue(method === 'POST', '操作が不正です');
      const d = blankPlan('');
      if (b.oneOff) {
        // 単発日程調整: テンプレートを使わず、設定を作成画面でその場で入れる（2026-10-02）
        await validateOneOffChannels(env, b);
        editSettings(d, b);
        d.oneOff = true;
        d.segments = ids(b.segments, '回答対象の区分');
      } else {
        const profile = await db
          .prepare('SELECT * FROM planning_cycles WHERE id=? AND guild_id=?')
          .bind(b.profileId ?? '', b.guild_id)
          .first<any>();
        requireValue(profile && JSON.parse(profile.data).standalone, '日程調整設定を選択してください');
        const settings: CycleData = JSON.parse(profile.data);
        editSettings(d, { ...settings, name: b.name, deadline: b.deadline, note: b.note });
        d.profileId = profile.id;
        d.profileName = settings.name;
        d.segments = settings.segments;
      }
      d.standalone = true;
      d.people = await collectSegmentPeople(env, b.guild_id, d.segments!);
      d.scheduleNames = await segmentNames(db, d.segments!);
      return json(await createPlan(db, b.guild_id, d));
    }
    const m = path.match(/^\/planning\/([\w-]+)(?:\/([\w-]+))?$/);
    requireValue(m, '見つかりません', 404);
    // Keep the bounded refresh path independent of the full answer snapshot.
    if (m[2] === 'audience-refresh') {
      requireValue(method === 'POST', 'この操作方法は利用できません', 405);
      return json(await refreshPlanningAudience(env, m[1], b));
    }
    const p = await getPlan(db, m[1]),
      action = m[2] ?? '';
    if (method === 'GET') {
      if (action === 'history')
        return json(
          (
            await db
              .prepare(
                'SELECT id,kind,user_id,before_data,after_data,reason,changed_at FROM planning_history WHERE plan_id=? ORDER BY id DESC LIMIT 200',
              )
              .bind(p.id)
              .all()
          ).results,
        );
      if (action === 'deliveries')
        return json(
          (
            await db
              .prepare('SELECT *,? AS guild_id FROM planning_deliveries WHERE plan_id=? ORDER BY rowid DESC')
              .bind(p.guild_id, p.id)
              .all()
          ).results,
        );
      requireValue(!action, '操作が見つかりません', 404);
      return json(p);
    }
    requireValue(b.version === p.version, '最新の内容を読み直してください', 409);
    const d = structuredClone(p.data);
    d.answerOrigin = url.origin;
    if (action === 'settings') {
      requireValue(d.state === 'draft' || d.state === 'open', '確定後の共通設定は変更できません');
      if (d.oneOff && d.state === 'draft') {
        // 単発は下書きのうちだけ全設定を直せる。投稿後は定期と同じく名前・補足だけ（変えたいときは中止して複製で作り直す）
        await validateOneOffChannels(env, { ...b, guild_id: p.guild_id });
        editSettings(d, b);
        const segments = ids(b.segments, '回答対象の区分');
        if (JSON.stringify(segments) !== JSON.stringify(d.segments)) {
          d.people = await collectSegmentPeople(env, p.guild_id, segments);
          d.segments = segments;
          d.scheduleNames = await segmentNames(db, segments);
        }
      } else editSettings(d, d.standalone ? { ...d, name: b.name, deadline: b.deadline, note: b.note } : b);
      if (d.state === 'draft' && !d.standalone) {
        d.schedules = ids(b.schedules);
        d.people = await collectPeople(db, p.guild_id, d.schedules);
      }
      if (p.data.state === 'open')
        requireValue(d.deadline === p.data.deadline, '公開後の締切は変更できません');
    } else if (action === 'candidates') {
      requireValue(
        d.state === 'draft' || (d.state === 'open' && Date.now() < Date.parse(d.deadline)),
        '締切後・確定後は候補を変更できません',
      );
      requireValue(
        Array.isArray(b.candidates) && b.candidates.length > 0 && b.candidates.length <= MAX_CANDIDATES,
        `候補は1〜${MAX_CANDIDATES}件です`,
      );
      const seen = new Set<string>();
      // Candidate identity is scoped to a plan. Short, monotonic IDs keep 200 × 200 answers within D1's row limit.
      let candidateNumber = Math.max(0, ...d.candidates.map((c) => /^c\d+$/.test(c.id) ? Number(c.id.slice(1)) : 0));
      const fresh = b.candidates.map((c: any) => {
        requireValue(
          dateValue(c.date) && timeValue(c.time),
          '日程候補の日付と開始時刻を確認してください',
        );
        const key = c.date + ' ' + c.time;
        requireValue(!seen.has(key), '日程候補が重複しています');
        seen.add(key);
        const old = d.candidates.find((x) => x.active && x.date === c.date && x.time === c.time);
        return old ?? { id: `c${++candidateNumber}`, date: c.date, time: c.time, active: true };
      });
      d.candidates = [
        ...d.candidates
          .filter((c) => !fresh.some((x: any) => x.id === c.id))
          .map((c) => ({ ...c, active: false })),
        ...fresh,
      ];
      requireValue(
        d.candidates.length <= 600,
        '候補の編集履歴が上限に達しました。新しい開催計画を作成してください',
      );
      d.slots = d.slots.filter((s) => fresh.some((c: any) => c.id === s.candidate));
    } else if (action === 'publish') {
      requireValue(
        d.state === 'draft' && d.candidates.some((c) => c.active) && Date.parse(d.deadline) > Date.now(),
        '候補と未来の回答締切を設定してください',
      );
      await validateChannel(env, p.guild_id, d.channel);
      d.people = d.standalone
        ? await collectSegmentPeople(env, p.guild_id, d.segments!)
        : await collectPeople(db, p.guild_id, d.schedules);
      requireValue(d.people.length > 0, '回答対象者がいません。メンバー区分の所属を確認してください');
      d.mentionRoles = d.standalone && d.announceMention === 'role' ? await segmentMentionRoles(db, d.segments!) : undefined;
      // 対象者と同じく区分名も投稿時の名前にする（下書きの間に区分名を変えても古い名前が投稿に出ない）
      if (d.standalone) d.scheduleNames = await segmentNames(db, d.segments!);
      d.state = 'open';
      return json(
        await savePlan(db, p, d, 'publish', '', null, (g) => [
          deliveryStatement(
            db,
            p,
            g,
            crypto.randomUUID(),
            'publish',
            d.channel,
            answerAnnouncement({ ...p, data: d }),
          ),
        ]),
      );
    } else if (action === 'repost') {
      requireValue(['open', 'confirmed'].includes(d.state), '公開済みの日程調整だけ再投稿できます');
      const unresolved = await db
        .prepare(
          "SELECT 1 FROM planning_deliveries WHERE plan_id=? AND kind IN ('publish','repost','candidates') AND status IN ('pending','sending','failed','unknown') LIMIT 1",
        )
        .bind(p.id)
        .first();
      requireValue(!unresolved, '未完了の回答案内があります。投稿状況を確認してください', 409);
      await validateChannel(env, p.guild_id, d.channel);
      // Re-read the segment roles so a repost mentions the roles as they are now; plans without the key stay unchanged.
      const roles = d.standalone && d.announceMention === 'role' ? await segmentMentionRoles(db, d.segments!) : [];
      if (roles.length || d.mentionRoles) d.mentionRoles = roles;
      return json(
        await savePlan(db, p, d, 'repost', '', null, (g) => [
          deliveryStatement(db, p, g, crypto.randomUUID(), 'repost', d.channel, answerAnnouncement({ ...p, data: d })),
        ]),
      );
    } else if (action === 'selection') {
      requireValue(d.state === 'draft' || d.state === 'open', '確定済み名簿は変更操作から編集してください');
      d.slots = selections(d, b.slots);
    } else if (action === 'confirm' || action === 'confirm-selection') {
      if (action === 'confirm-selection') d.slots = selections(d, b.slots);
      await validateChannel(env, p.guild_id, d.forum, true, d.tag);
      return json(await confirmPlan(db, p, d, text(b.reason ?? '', 500)));
    } else if (action === 'answer') {
      requireValue(d.state === 'open', '候補回答の受付中だけ代理変更できます');
      requireValue(
        d.people.some((x) => x.id === b.user && x.active !== false),
        '対象者が不正です',
      );
      requireValue(b.values && typeof b.values === 'object', '回答が不正です');
      for (const [id, v] of Object.entries(b.values))
        requireValue(d.candidates.some((c) => c.id === id && c.active) && isAnswer(v), '回答が不正です');
      d.answers[b.user] = {
        values: { ...d.answers[b.user]?.values, ...b.values },
        comment: text(b.comment ?? d.answers[b.user]?.comment ?? '', 500),
      };
      return json(await savePlan(db, p, d, 'admin-answer', text(b.reason ?? '', 500), b.user));
    } else if (action === 'cancel') {
      requireValue(d.state !== 'cancelled', '既に中止しています');
      d.state = 'cancelled';
      d.slots.forEach((s) => (s.cancelled = true));
      return json(
        await savePlan(db, p, d, 'cancel', text(b.reason ?? '', 500), null, (g) => [
          db
            .prepare(
              `UPDATE planning_deliveries SET status='cancelled' WHERE plan_id=? AND status='pending' AND ${g}`,
            )
            .bind(p.id),
          db
            .prepare(
              `UPDATE occurrences SET status='cancelled' WHERE id IN(SELECT occurrence_id FROM planning_occurrences WHERE plan_id=?) AND ${g}`,
            )
            .bind(p.id),
          // 開催案内を更新するのは確定後だけ（受付中の選定は未投稿。60 人を超える選定でも中止できるように作らない）
          ...(p.data.state === 'confirmed' ? d.slots : []).map((s) =>
            deliveryStatement(
              db,
              p,
              g,
              crypto.randomUUID(),
              'forum',
              d.forum,
              slotPayload({ ...p, data: d }, s, false),
              s.id,
            ),
          ),
        ]),
      );
    } else if (action === 'retry' || action === 'retry-verified' || action === 'recreate') {
      const job = await db
        .prepare('SELECT * FROM planning_deliveries WHERE id=? AND plan_id=?')
        .bind(b.delivery, p.id)
        .first<any>();
      requireValue(job, '投稿処理が見つかりません');
      if (action === 'retry')
        requireValue(job.status === 'failed', '結果不明の投稿は確認・関連付けを行ってください');
      else
        requireValue(
          ['failed', 'unknown'].includes(job.status) && b.verified === true && b.reason?.trim(),
          'Discord上の確認結果を記録してください',
        );
      if (action === 'recreate') {
        requireValue(
          job.kind === 'forum' && job.error === 'Discord 404',
          '削除されたフォーラム投稿だけ再作成できます',
        );
        const old = await db
          .prepare(
            "SELECT thread_id,message_id FROM planning_deliveries WHERE plan_id=? AND slot_id=? AND status='sent' AND thread_id IS NOT NULL ORDER BY rowid DESC LIMIT 1",
          )
          .bind(p.id, job.slot_id)
          .first<any>();
        requireValue(old, '関連済みの投稿がありません');
        let missing = false;
        try {
          await discord(env, `/channels/${old.thread_id}/messages/${old.message_id}`);
        } catch (e) {
          missing = (e as Error).message === 'Discord 404';
        }
        requireValue(missing, '既存の投稿の削除を確認できません。権限と投稿を確認してください');
      }
      return json(
        await savePlan(db, p, d, action, text(b.reason ?? '', 500), null, (g) => [
          ...(action === 'recreate'
            ? [
                db
                  .prepare(
                    `UPDATE planning_deliveries SET thread_id=NULL,message_id=NULL WHERE plan_id=? AND slot_id=? AND status='sent' AND ${g}`,
                  )
                  .bind(p.id, job.slot_id),
              ]
            : []),
          db
            .prepare(
              `UPDATE planning_deliveries SET status='pending',error=NULL WHERE id=? AND status IN ('failed','unknown') AND ${g}`,
            )
            .bind(job.id),
        ]),
      );
    } else if (action === 'associate') {
      const job = await db
        .prepare('SELECT * FROM planning_deliveries WHERE id=? AND plan_id=?')
        .bind(b.delivery, p.id)
        .first<any>();
      requireValue(
        job && ['failed', 'unknown', 'pending'].includes(job.status),
        '関連付けできる投稿処理がありません',
      );
      requireValue(
        /^\d{5,22}$/.test(b.thread) && /^\d{5,22}$/.test(b.message),
        '投稿リンクのチャンネルIDとメッセージIDを確認してください',
      );
      const channel = await discord(env, `/channels/${b.thread}`);
      requireValue(
        env.MOCK_DISCORD ||
          (job.kind === 'answer-dm'
            ? channel.type === 1 && channel.recipients?.some((u: any) => u.id === JSON.parse(job.payload).user)
            : channel.guild_id === p.guild_id &&
              (job.kind === 'forum' ? channel.parent_id === d.forum : channel.id === job.channel_id)),
        '同じサーバーの対象投稿先を指定してください',
      );
      const message = await discord(env, `/channels/${b.thread}/messages/${b.message}`);
      requireValue(
        env.MOCK_DISCORD || message.author?.id === env.DISCORD_APPLICATION_ID,
        'Bot自身が作成したメッセージを指定してください',
      );
      const slot = d.slots.find((s) => s.id === job.slot_id);
      requireValue(
        env.MOCK_DISCORD ||
          (job.kind === 'forum'
            ? message.embeds?.some((e: any) => e.footer?.text === `開催枠 ${job.slot_id}`)
            : !['publish', 'repost'].includes(job.kind) ||
              message.components?.some((r: any) =>
                r.components?.some((c: any) => c.custom_id?.includes(p.id)),
              )),
        'この開催計画の投稿であることを確認できません',
      );
      return json(
        await savePlan(
          db,
          p,
          d,
          'associate',
          text(b.reason ?? '既存の投稿を確認して関連付け', 500),
          null,
          (g) => [
            db
              .prepare(
                `UPDATE planning_deliveries SET status='sent',thread_id=?,message_id=?,error=NULL WHERE id=? AND status IN ('failed','unknown','pending') AND ${g}`,
              )
              .bind(job.kind === 'forum' ? b.thread : null, b.message, job.id),
            ...(job.kind === 'publish' && p.data.profileId
              ? [
                  db
                    .prepare(
                      `UPDATE planning_cycles SET task_status='complete' WHERE id=? AND task_status='pending' AND ${g}`,
                    )
                    .bind(p.data.profileId),
                ]
              : []),
            ...(slot && job.kind === 'forum'
              ? [
                  deliveryStatement(
                    db,
                    p,
                    g,
                    crypto.randomUUID(),
                    'forum',
                    d.forum,
                    slotPayload(p, slot, false),
                    slot.id,
                  ),
                ]
              : []),
          ],
        ),
      );
    } else throw new PlanningError('操作が見つかりません', 404);
    // 候補が何も変わらない保存では再投稿しない（設定資料 ※5「変更すると再投稿」）
    const activeIds = (x: PlanData) => x.candidates.filter((c) => c.active).map((c) => c.id).sort().join();
    const extra =
      action === 'candidates' && d.state === 'open' && activeIds(d) !== activeIds(p.data)
        ? (g: string) => [
            deliveryStatement(
              db,
              p,
              g,
              crypto.randomUUID(),
              'candidates',
              d.channel,
              answerAnnouncement(
                { ...p, data: d },
                `日程候補を更新しました（追加${d.candidates.filter(c => c.active && !p.data.candidates.some(old => old.id === c.id && old.active)).length}件）。回答済みの内容は保持されています。`,
              ),
            ),
          ]
        : undefined;
    return json(await savePlan(db, p, d, action, text(b.reason ?? '', 500), null, extra));
  } catch (e) {
    return json({ error: (e as Error).message }, e instanceof PlanningError ? e.status : 400);
  }
}
