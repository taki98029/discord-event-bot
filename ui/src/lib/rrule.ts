// 繰り返し（RRULE サブセット文法）の UI 側ヘルパ。文法・正規化はサーバーと同じ純関数
// src/lib/rruleGrammar.ts を直接 import して共有する（文法の真実は 1 か所・rrule.js は UI に同梱しない）。
// 日付の列挙（プレビュー・次回の開催日候補）はサーバー POST /notifications/preview-plan。
// 設計: docs/dev/schedule-recurrence-redesign.md §5.1・§6（2026-08-23）。
import {
  INTERVAL_MAX,
  MONTH_MAX_DAY,
  WEEKDAY_CODES,
  formatRule,
  parseRule,
  type Freq,
  type RuleModel,
  type WeekdayCode,
} from '../../../src/lib/rruleGrammar';

export { INTERVAL_MAX, MONTH_MAX_DAY, formatRule, parseRule };
export type { Freq, RuleModel, WeekdayCode };

/** 表示順は日〜土（日本のカレンダー慣行）。保存形の並びは formatRule が月曜起点に正規化する */
export const WEEKDAYS: [WeekdayCode, string][] = [
  ['SU', '日'],
  ['MO', '月'],
  ['TU', '火'],
  ['WE', '水'],
  ['TH', '木'],
  ['FR', '金'],
  ['SA', '土'],
];
export const NTH: [string, string][] = [
  ['1', '第1'],
  ['2', '第2'],
  ['3', '第3'],
  ['4', '第4'],
  ['5', '第5'],
  ['-1', '最終'],
];
export const wdLabel = (c: string) => (WEEKDAYS.find((w) => w[0] === c) || ['', ''])[1];
export const nthLabel = (n: string | number) => (NTH.find((x) => x[0] === String(n)) || ['', ''])[1];
export const WEEKDAYS_MON_FRI: WeekdayCode[] = ['MO', 'TU', 'WE', 'TH', 'FR'];

/** 毎月「第N曜」ルール 1 件（セレクトの値は文字列のまま持つ） */
export type MonthlyRule = { nth: string; byday: string };

/**
 * フォームの「開催日時」ステップの状態（カード＋入力）。文法モデルと相互変換できる。
 * freq 'IRREGULAR' = 不定期（rrule NULL・入力なし）。
 */
export type RuleForm = {
  freq: Freq | 'IRREGULAR';
  /** 1..INTERVAL_MAX[freq]（入力途中の不正値も保持して missing で弾く） */
  interval: number;
  /** WEEKLY の曜日（複数） */
  weekdays: WeekdayCode[];
  /** MONTHLY の方式 */
  monthlyMode: 'byday' | 'bymonthday';
  monthlyRules: MonthlyRule[];
  /** MONTHLY 日付（1..31・-1=月末） */
  monthDays: number[];
  /** YEARLY の月日 */
  yearMonth: number;
  yearDay: number;
};

export const DEFAULT_RULE_FORM: RuleForm = {
  freq: 'WEEKLY',
  interval: 1,
  weekdays: ['SA'],
  monthlyMode: 'byday',
  monthlyRules: [{ nth: '2', byday: 'SA' }],
  monthDays: [],
  yearMonth: 1,
  yearDay: 1,
};

export function dedupeMonthlyRules(rules: MonthlyRule[]): MonthlyRule[] {
  const seen = new Set<string>();
  const out: MonthlyRule[] = [];
  for (const r of rules) {
    const k = r.nth + r.byday;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(r);
    }
  }
  return out;
}

/** 文法モデル → フォーム状態（既定値に上書き）。null（不定期）は IRREGULAR */
export function ruleFormFromModel(m: RuleModel | null): RuleForm {
  if (!m) return { ...DEFAULT_RULE_FORM, freq: 'IRREGULAR' };
  const f: RuleForm = { ...DEFAULT_RULE_FORM, freq: m.freq, interval: m.interval };
  if (m.freq === 'WEEKLY') f.weekdays = m.byday.map((d) => d.day);
  if (m.freq === 'MONTHLY') {
    if (m.byday.length) {
      f.monthlyMode = 'byday';
      f.monthlyRules = m.byday.map((d) => ({ nth: String(d.nth), byday: d.day }));
    } else {
      f.monthlyMode = 'bymonthday';
      f.monthDays = [...m.bymonthday];
    }
  }
  if (m.freq === 'YEARLY') {
    f.yearMonth = m.bymonth[0];
    f.yearDay = m.bymonthday[0];
  }
  return f;
}

/** フォーム状態 → 文法モデル。不定期・入力不足（曜日なし等）・間隔不正は null */
export function modelFromRuleForm(f: RuleForm): RuleModel | null {
  if (f.freq === 'IRREGULAR') return null;
  const interval = f.interval;
  if (!Number.isInteger(interval) || interval < 1 || interval > INTERVAL_MAX[f.freq]) return null;
  const base: RuleModel = { freq: f.freq, interval, byday: [], bymonthday: [], bymonth: [] };
  switch (f.freq) {
    case 'DAILY':
      return base;
    case 'WEEKLY':
      if (!f.weekdays.length) return null;
      return { ...base, byday: f.weekdays.map((day) => ({ nth: 0, day })) };
    case 'MONTHLY':
      if (f.monthlyMode === 'byday') {
        const rules = dedupeMonthlyRules(f.monthlyRules);
        if (!rules.length) return null;
        return { ...base, byday: rules.map((r) => ({ nth: Number(r.nth), day: r.byday as WeekdayCode })) };
      }
      if (!f.monthDays.length) return null;
      return { ...base, bymonthday: [...f.monthDays] };
    case 'YEARLY':
      return { ...base, bymonth: [f.yearMonth], bymonthday: [f.yearDay] };
  }
}

/** フォーム状態 → 保存する RRULE（正規形）。不定期・不完全は null */
export function rruleFromRuleForm(f: RuleForm): string | null {
  const m = modelFromRuleForm(f);
  return m ? formatRule(m) : null;
}

const nthOrder = (nth: number) => (nth === -1 ? 99 : nth);

/** 「第1・第3・第5 日曜日」/ 混在「第1日曜・第3火曜」（並びは保存形と同じ: 第N→曜日、最終は末尾） */
function describeMonthlyByday(input: { nth: number; day: WeekdayCode }[]): string {
  const rules = [...input].sort((a, b) => nthOrder(a.nth) - nthOrder(b.nth) || WEEKDAY_CODES.indexOf(a.day) - WEEKDAY_CODES.indexOf(b.day));
  const wds = new Set(rules.map((r) => r.day));
  if (wds.size === 1) return `${rules.map((r) => nthLabel(r.nth)).join('・')} ${wdLabel(rules[0].day)}曜日`;
  return rules.map((r) => nthLabel(r.nth) + wdLabel(r.day) + '曜').join('・');
}

function describeWeekdays(days: WeekdayCode[]): string {
  const set = new Set(days);
  if (set.size === 5 && WEEKDAYS_MON_FRI.every((d) => set.has(d))) return '平日（月〜金）';
  // 文言は月曜起点（WKST=MO・保存形と同じ並び）。週末が「土・日」と読める
  return WEEKDAY_CODES.filter((c) => set.has(c))
    .map((c) => wdLabel(c))
    .join('・') + '曜日';
}

const monthDayLabel = (d: number) => (d === -1 ? '月末' : `${d}日`);

/** 'YYYY/MM/DD' を「M/D」（今年）または「YYYY/M/D」に */
export function shortDate(ymd: string, now: Date = new Date()): string {
  const [y, m, d] = ymd.split('/').map(Number);
  if (!y || !m || !d) return ymd;
  return y === now.getFullYear() ? `${m}/${d}` : `${y}/${m}/${d}`;
}

/**
 * 要約文言（確認ステップ・開催日時の即時表示・一覧で共用・docs §6.4）。
 * 例: 「毎週 土・日曜日 21:00〜23:00」「隔週 土曜日 21:00〜（次回 9/5）」「毎月 15日・月末 21:00〜」
 *     「2年おき 3月20日 21:00〜（次回 2027/3/20）」「不定期 21:00〜」「不定期 21:00〜（次回 9/9）」
 * nextDate は間隔 ≥ 2（次回の開催日）または不定期（直近の予定回）のときだけ付く。
 */
export function describeRule(
  m: RuleModel | null,
  startTime: string | null | undefined,
  duration: number | null | undefined,
  nextDate?: string | null,
): string {
  const tr = fmtTimeRange(startTime || '', duration);
  const next = nextDate ? `（次回 ${shortDate(nextDate)}）` : '';
  if (!m) return `不定期 ${tr}${next}`;
  const n = m.interval;
  let head: string;
  switch (m.freq) {
    case 'DAILY':
      head = n === 1 ? '毎日' : `${n}日おき`;
      break;
    case 'WEEKLY':
      head = `${n === 1 ? '毎週' : n === 2 ? '隔週' : `${n}週おき`} ${describeWeekdays(m.byday.map((d) => d.day))}`;
      break;
    case 'MONTHLY':
      head = `${n === 1 ? '毎月' : n === 2 ? '隔月' : `${n}か月おき`} ${
        m.byday.length
          ? describeMonthlyByday(m.byday)
          : [...m.bymonthday].sort((a, b) => nthOrder(a) - nthOrder(b)).map(monthDayLabel).join('・')
      }`;
      break;
    case 'YEARLY':
      head = `${n === 1 ? '毎年' : `${n}年おき`} ${m.bymonth[0]}月${m.bymonthday[0]}日`;
      break;
  }
  return `${head} ${tr}${n >= 2 ? next : ''}`;
}

function addMinsToTime(time: string, minutes: number): { time: string; nextDay: boolean } {
  const [h, m] = (time || '0:0').split(':').map(Number);
  const total = (h || 0) * 60 + (m || 0) + minutes;
  const wrapped = ((total % 1440) + 1440) % 1440;
  const hh = String(Math.floor(wrapped / 60)).padStart(2, '0');
  const mm = String(wrapped % 60).padStart(2, '0');
  return { time: `${hh}:${mm}`, nextDay: total >= 1440 || total < 0 };
}

/** 開始時刻＋開催時間(分) を From-To 文字列に（サーバ src/lib/date.ts formatTimeRange と同等） */
export function fmtTimeRange(start: string, dur?: number | null): string {
  if (!dur || dur <= 0) return `${start}〜`;
  const e = addMinsToTime(start, dur);
  return `${start}〜${e.nextDay ? '翌' : ''}${e.time}`;
}

/** 開催回の表示ラベル「YYYY/MM/DD (曜) HH:MM〜HH:MM」（サーバ formatOccurrenceLabel と同等） */
export function occurrenceLabel(dateStr: string, time?: string | null, dur?: number | null): string {
  const [y, m, d] = (dateStr || '').split('/').map(Number);
  const w = y && m && d ? '日月火水木金土'[new Date(y, m - 1, d).getDay()] : '';
  return `${dateStr}${w ? ` (${w})` : ''}${time ? ' ' + fmtTimeRange(time, dur) : ''}`;
}

/** 'YYYY/MM/DD' → 「M/D(曜)」（プレビューの「次の開催日」列挙用） */
export function shortDateWithWeekday(ymd: string, now: Date = new Date()): string {
  const [y, m, d] = ymd.split('/').map(Number);
  if (!y || !m || !d) return ymd;
  return `${shortDate(ymd, now)}(${'日月火水木金土'[new Date(y, m - 1, d).getDay()]})`;
}

/** 'YYYY/MM/DD' と今日（ローカル）の日数差（密度警告用）。不正は NaN */
export function daysFromToday(ymd: string, now: Date = new Date()): number {
  const [y, m, d] = ymd.split('/').map(Number);
  if (!y || !m || !d) return NaN;
  const a = new Date(y, m - 1, d).getTime();
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.round((a - b) / 86_400_000);
}

/** JST の 'YYYY/MM/DD' と 'HH:MM' → 時刻（ms）。時刻は JST 固定なので端末のタイムゾーンに依らず組み立てる */
export function jstMs(ymd: string, hm = '00:00'): number {
  const [y, m, d] = ymd.split('/').map(Number);
  const [h, mi] = hm.split(':').map(Number);
  return Date.UTC(y || 0, (m || 1) - 1, d || 1, (h || 0) - 9, mi || 0);
}

/** 今日（JST）の 'YYYY/MM/DD'（0埋めなので文字列比較で日付比較になる） */
export const jstToday = (now: number = Date.now()): string =>
  new Date(now + 9 * 3_600_000).toISOString().slice(0, 10).replace(/-/g, '/');
