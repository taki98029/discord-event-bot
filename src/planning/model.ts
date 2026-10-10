export type Availability = '可' | '未定' | '不可';
export const MAX_CANDIDATES = 200;
export interface AnswerReminder {
  enabled: boolean;
  beforeDays: number;
  intervalDays: number;
  time: string;
  /** 'channel' posts one mention message per 40 people to the answer channel; absent = 'dm' (C05, 2026-09-20). */
  target?: 'dm' | 'channel';
}
export const DEFAULT_ANSWER_REMINDER: AnswerReminder = {
  enabled: true, beforeDays: 3, intervalDays: 1, time: '21:00',
};
/** Only the signed-in participant's data may cross the public answer API. */
export interface PlanningAnswerSnapshot {
  id: string;
  name: string;
  person: { id: string; name: string };
  note: string;
  deadline: string;
  deadlineLabel: string;
  closed: boolean;
  cancelled: boolean;
  version: string;
  /** date (YYYY-MM-DD) and time (HH:MM, '' when unset) place each candidate on the answer calendar. */
  candidates: { id: string; label: string; date: string; time: string; value: Availability | null }[];
  comment: string;
  /** Present only when the plan shares answers (shareAnswers): each current respondent's name and answers, never comments. */
  others?: { name: string; values: Record<string, Availability> }[];
}
export interface Candidate {
  id: string;
  date: string;
  time: string;
  active: boolean;
}
export interface PlanningPerson {
  id: string;
  name: string;
  schedules: number[];
  /** Retained for history and draft selections after leaving the audience. */
  active?: boolean;
}
export interface Selection {
  user: string;
  schedule: number;
  status: '参加' | '未定' | '不参加' | '除外';
  duty: string;
}
export interface Slot {
  schedules?: number[];
  id: string;
  candidate: string;
  members: Selection[];
  cancelled: boolean;
  gather: string;
  note: string;
}
export interface PlanData {
  /** New plans are independent of notifications/occurrences. Legacy plans omit this flag. */
  standalone?: boolean;
  /** 単発日程調整（2026-10-02）: テンプレートなしで作り、下書きのうちは全設定を直せる（投稿後は名前・補足だけ）。standalone も true */
  oneOff?: boolean;
  profileId?: string;
  profileName?: string;
  segments?: number[];
  name: string;
  state: 'draft' | 'open' | 'confirmed' | 'cancelled';
  scheduleNames?: Record<string, string>;
  schedules: number[];
  channel: string;
  /** Public Worker origin captured when the admin publishes/updates the plan. */
  answerOrigin?: string;
  forum: string;
  tag: string;
  deadline: string;
  note: string;
  remindDays: number;
  /** Absent on old plans: preserve their publication-based channel reminders. */
  answerReminder?: AnswerReminder;
  announcementTemplate?: string;
  /** 0 disables; absent preserves old plans without an event reminder. */
  eventReminderHours?: number;
  /** Legacy setting, ignored: audience updates are now initiated by an administrator. */
  autoAudience?: boolean;
  /** Role mention on the answer announcement; absent = none (settings saved before 2026-09-20). */
  announceMention?: 'none' | 'role';
  /** Segment role ids captured when the plan was published, so reposts and reminders mention the same roles. */
  mentionRoles?: string[];
  /** Respondents see everyone's answers on the answer page (C06, 2026-09-20); absent = false. */
  shareAnswers?: boolean;
  candidates: Candidate[];
  people: PlanningPerson[];
  answers: Record<string, { values: Record<string, Availability>; comment: string }>;
  /** Legacy per-field versions, read until that person's next atomic web/proxy edit. */
  answerRevisions?: Record<string, { values: Record<string, number>; comment: number }>;
  /** Web answers are saved atomically per person. Old per-field revisions remain readable. */
  answerVersions?: Record<string, number>;
  slots: Slot[];
}
export interface Plan {
  task?: { status: 'pending' | 'complete' | 'skipped'; due_date: string; cycle_id: string } | null;
  id: string;
  guild_id: string;
  version: number;
  data: PlanData;
}
export interface CycleData {
  standalone?: boolean;
  segments?: number[];
  remindDays?: number;
  answerReminder?: AnswerReminder;
  announcementTemplate?: string;
  eventReminderHours?: number;
  /** Legacy setting, ignored: audience updates are now initiated by an administrator. */
  autoAudience?: boolean;
  announceMention?: 'none' | 'role';
  shareAnswers?: boolean;
  name: string;
  schedules: number[];
  channel: string;
  forum: string;
  tag: string;
  rrule: string;
  anchor: string;
  time: string;
  adminChannel: string;
  /** 'roles' only on rows saved before 2026-09-20 (bare role ids). New rows use 'users' and prefix role ids with `role:` in `mentions`. */
  mentionMode: 'users' | 'roles';
  mentions: string[];
  /** Daily reminders to the candidate creator start this many days before the posting due date (0 = on the day). */
  taskReminderDays?: number;
  /** Legacy repeat interval; superseded by taskReminderDays and ignored. */
  retryDays?: number;
  origin: string;
}
/** The persisted selection key is named schedule for backward compatibility; standalone keys are segment IDs. */
export function planningGroups(data: Pick<PlanData, 'standalone' | 'segments' | 'schedules'>): number[] {
  return data.standalone ? (data.segments ?? []) : data.schedules;
}
export class PlanningError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export function requireValue(ok: unknown, message: string, status = 400): asserts ok {
  if (!ok) throw new PlanningError(message, status);
}
export function dateValue(v: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(v) &&
    !Number.isNaN(Date.parse(v)) &&
    new Date(v).toISOString().slice(0, 10) === v
  );
}
export function timeValue(v: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
}
export function isAnswer(v: unknown): v is Availability {
  return v === '可' || v === '不可' || v === '未定';
}
export function unanswered(p: PlanData, user: string): Candidate[] {
  if (p.people.some((u) => u.id === user && u.active === false)) return [];
  return p.candidates.filter((c) => c.active && !isAnswer(p.answers[user]?.values[c.id]));
}
export function blankPlan(name: string): PlanData {
  return {
    name,
    state: 'draft',
    schedules: [],
    channel: '',
    forum: '',
    tag: '',
    deadline: '',
    note: '',
    remindDays: 0,
    candidates: [],
    people: [],
    answers: {},
    slots: [],
  };
}
