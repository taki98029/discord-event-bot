// RRULE サブセット文法（src/lib/rruleGrammar.ts）: 検証・正規化・モデル変換。
// 設計: docs/dev/schedule-recurrence-redesign.md §5.1（2026-08-23）。
import { describe, expect, it } from 'vitest';
import { INTERVAL_MAX, formatRule, normalizeRule, parseRule } from '../src/lib/rruleGrammar';

describe('parseRule / formatRule - 17 パターンの正規形を受理し不動点にする', () => {
  const fixed = [
    'FREQ=DAILY', // 毎日
    'FREQ=WEEKLY;BYDAY=SA', // 毎週（既存形式）
    'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', // 平日
    'FREQ=WEEKLY;BYDAY=SA,SU', // 毎週 複数曜日
    'FREQ=MONTHLY;BYMONTHDAY=15', // 毎月 N 日
    'FREQ=MONTHLY;BYMONTHDAY=1,15', // 毎月 複数日
    'FREQ=MONTHLY;BYMONTHDAY=-1', // 月末
    'FREQ=MONTHLY;BYMONTHDAY=15,-1', // 15 日と月末
    'FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=20', // 毎年
    'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29', // 毎年 2/29（うるう年だけ）
    'FREQ=YEARLY;BYMONTH=12;BYMONTHDAY=31', // 毎年 大の月の 31 日
    'FREQ=DAILY;INTERVAL=3', // N 日おき
    'FREQ=WEEKLY;INTERVAL=2;BYDAY=SA', // 隔週（既存形式）
    'FREQ=WEEKLY;INTERVAL=3;BYDAY=SA', // N 週おき
    'FREQ=MONTHLY;INTERVAL=2;BYDAY=2SA', // N か月おき（第N曜）
    'FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=15', // N か月おき（日付）
    'FREQ=YEARLY;INTERVAL=2;BYMONTH=3;BYMONTHDAY=20', // N 年おき
    'FREQ=MONTHLY;BYDAY=2SA', // 第N曜（既存形式）
    'FREQ=MONTHLY;BYDAY=1SU,3SU,5SU', // 第1・3・5（既存形式）
    'FREQ=MONTHLY;BYDAY=1SU,3TU', // 混在（既存形式）
    'FREQ=MONTHLY;BYDAY=-1SA', // 最終X曜
  ];
  for (const s of fixed) {
    it(`不動点: ${s}`, () => {
      const m = parseRule(s);
      expect(m).not.toBeNull();
      expect(formatRule(m!)).toBe(s);
      expect(normalizeRule(s)).toBe(s);
    });
  }

  it('モデルは文法と 1:1（毎週 土日）', () => {
    expect(parseRule('FREQ=WEEKLY;BYDAY=SA,SU')).toEqual({
      freq: 'WEEKLY',
      interval: 1,
      byday: [
        { nth: 0, day: 'SA' },
        { nth: 0, day: 'SU' },
      ],
      bymonthday: [],
      bymonth: [],
    });
    expect(parseRule('FREQ=YEARLY;INTERVAL=2;BYMONTH=3;BYMONTHDAY=20')).toEqual({
      freq: 'YEARLY',
      interval: 2,
      byday: [],
      bymonthday: [20],
      bymonth: [3],
    });
  });
});

describe('normalizeRule - 正規化（順序・+・WKST・小文字・INTERVAL=1）', () => {
  it('キー順を FREQ;INTERVAL;BYDAY;BYMONTH;BYMONTHDAY に固定する', () => {
    expect(normalizeRule('BYDAY=SA;INTERVAL=2;FREQ=WEEKLY')).toBe('FREQ=WEEKLY;INTERVAL=2;BYDAY=SA');
    expect(normalizeRule('BYMONTHDAY=20;BYMONTH=3;FREQ=YEARLY')).toBe('FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=20');
  });
  it('BYDAY は第N→曜日（月曜起点）の昇順・最終(-1)は末尾、BYMONTHDAY は昇順・月末(-1)は末尾', () => {
    expect(normalizeRule('FREQ=WEEKLY;BYDAY=SU,SA,MO')).toBe('FREQ=WEEKLY;BYDAY=MO,SA,SU');
    expect(normalizeRule('FREQ=MONTHLY;BYDAY=5SU,-1SA,1SU,3TU')).toBe('FREQ=MONTHLY;BYDAY=1SU,3TU,5SU,-1SA');
    expect(normalizeRule('FREQ=MONTHLY;BYMONTHDAY=-1,15,1')).toBe('FREQ=MONTHLY;BYMONTHDAY=1,15,-1');
  });
  it("rrule.js 出力形（'+' 付き序数）と小文字・WKST=MO・INTERVAL=1 を正規形へ", () => {
    expect(normalizeRule('FREQ=MONTHLY;BYDAY=+2SA')).toBe('FREQ=MONTHLY;BYDAY=2SA');
    expect(normalizeRule('freq=weekly;byday=sa')).toBe('FREQ=WEEKLY;BYDAY=SA');
    expect(normalizeRule('FREQ=WEEKLY;WKST=MO;BYDAY=SA')).toBe('FREQ=WEEKLY;BYDAY=SA');
    expect(normalizeRule('FREQ=WEEKLY;INTERVAL=1;BYDAY=SA')).toBe('FREQ=WEEKLY;BYDAY=SA');
  });
});

describe('parseRule - 文法外は null（黙って丸めない）', () => {
  const rejected: [string, string][] = [
    ['空', ''],
    ["'RRULE:' 接頭辞", 'RRULE:FREQ=WEEKLY;BYDAY=SA'],
    ['複数行（DTSTART）', 'DTSTART:20260901T000000Z\nRRULE:FREQ=DAILY'],
    ['空白混入', 'FREQ=WEEKLY; BYDAY=SA'],
    ['FREQ なし', 'BYDAY=SA'],
    ['未知の FREQ', 'FREQ=HOURLY'],
    ['UNTIL（終了条件は不採用）', 'FREQ=WEEKLY;BYDAY=SA;UNTIL=20261231'],
    ['COUNT（整列と非互換）', 'FREQ=WEEKLY;BYDAY=SA;COUNT=3'],
    ['BYSETPOS', 'FREQ=MONTHLY;BYDAY=SA;BYSETPOS=1'],
    ['BYHOUR', 'FREQ=DAILY;BYHOUR=9'],
    ['未知キー', 'FREQ=DAILY;FOO=1'],
    ['キー重複', 'FREQ=WEEKLY;BYDAY=SA;BYDAY=SU'],
    ['空値', 'FREQ=WEEKLY;BYDAY='],
    ['WKST=SU（週末分断・月曜固定）', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=SA,SU;WKST=SU'],
    ['INTERVAL=0', 'FREQ=DAILY;INTERVAL=0'],
    ['INTERVAL 非整数', 'FREQ=DAILY;INTERVAL=1.5'],
    ['INTERVAL 上限超（日 31）', 'FREQ=DAILY;INTERVAL=31'],
    ['INTERVAL 上限超（週 27）', 'FREQ=WEEKLY;INTERVAL=27;BYDAY=SA'],
    ['INTERVAL 上限超（月 13）', 'FREQ=MONTHLY;INTERVAL=13;BYDAY=2SA'],
    ['INTERVAL 上限超（年 11）', 'FREQ=YEARLY;INTERVAL=11;BYMONTH=3;BYMONTHDAY=20'],
    ['DAILY に BYDAY', 'FREQ=DAILY;BYDAY=SA'],
    ['WEEKLY に BYDAY なし', 'FREQ=WEEKLY'],
    ['WEEKLY に序数付き BYDAY', 'FREQ=WEEKLY;BYDAY=2SA'],
    ['WEEKLY に BYMONTHDAY', 'FREQ=WEEKLY;BYDAY=SA;BYMONTHDAY=1'],
    ['WEEKLY に BYDAY 重複', 'FREQ=WEEKLY;BYDAY=SA,SA'],
    ['MONTHLY に BYxxx なし（dtstart 依存）', 'FREQ=MONTHLY'],
    ['MONTHLY に BYDAY と BYMONTHDAY 併存（AND で 0 件）', 'FREQ=MONTHLY;BYDAY=2SA;BYMONTHDAY=15'],
    ['MONTHLY に BYDAY と BYMONTHDAY 併存（要素数が違う・A5-01）', 'FREQ=MONTHLY;BYDAY=5MO;BYMONTHDAY=1,2'],
    ['MONTHLY の BYDAY に序数なし', 'FREQ=MONTHLY;BYDAY=SA'],
    ['MONTHLY の BYDAY 序数 6', 'FREQ=MONTHLY;BYDAY=6SA'],
    ['MONTHLY の BYDAY 序数 -2', 'FREQ=MONTHLY;BYDAY=-2SA'],
    ['MONTHLY の BYMONTHDAY 0', 'FREQ=MONTHLY;BYMONTHDAY=0'],
    ['MONTHLY の BYMONTHDAY 32', 'FREQ=MONTHLY;BYMONTHDAY=32'],
    ['MONTHLY の BYMONTHDAY -2', 'FREQ=MONTHLY;BYMONTHDAY=-2'],
    ['MONTHLY の BYMONTHDAY 重複', 'FREQ=MONTHLY;BYMONTHDAY=1,1'],
    ['MONTHLY に BYMONTH', 'FREQ=MONTHLY;BYMONTHDAY=1;BYMONTH=3'],
    ['YEARLY に BYMONTH なし', 'FREQ=YEARLY;BYMONTHDAY=20'],
    ['YEARLY に BYMONTHDAY なし', 'FREQ=YEARLY;BYMONTH=3'],
    ['YEARLY に BYMONTH 複数', 'FREQ=YEARLY;BYMONTH=3,4;BYMONTHDAY=20'],
    ['YEARLY に BYMONTHDAY 複数', 'FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=20,21'],
    ['YEARLY に BYMONTHDAY=-1', 'FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=-1'],
    ['YEARLY に BYMONTH 13', 'FREQ=YEARLY;BYMONTH=13;BYMONTHDAY=1'],
    ['YEARLY に実在しない月日（2/30）', 'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30'],
    ['YEARLY に実在しない月日（2/31）', 'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=31'],
    ['YEARLY に実在しない月日（4/31）', 'FREQ=YEARLY;BYMONTH=4;BYMONTHDAY=31'],
    ['YEARLY に実在しない月日（11/31・N 年おき）', 'FREQ=YEARLY;INTERVAL=2;BYMONTH=11;BYMONTHDAY=31'],
    ['YEARLY に BYDAY', 'FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=20;BYDAY=SA'],
    ['不正な曜日コード', 'FREQ=WEEKLY;BYDAY=XX'],
  ];
  for (const [label, s] of rejected) {
    it(label, () => {
      expect(parseRule(s)).toBeNull();
      expect(normalizeRule(s)).toBeNull();
    });
  }
  it('null / undefined は null', () => {
    expect(parseRule(null)).toBeNull();
    expect(parseRule(undefined)).toBeNull();
  });
});

describe('INTERVAL_MAX - 上限値は裁定どおり（日 30・週 26・月 12・年 10）で上限ちょうどは受理', () => {
  it('値', () => {
    expect(INTERVAL_MAX).toEqual({ DAILY: 30, WEEKLY: 26, MONTHLY: 12, YEARLY: 10 });
  });
  it('上限ちょうど', () => {
    expect(parseRule('FREQ=DAILY;INTERVAL=30')?.interval).toBe(30);
    expect(parseRule('FREQ=WEEKLY;INTERVAL=26;BYDAY=SA')?.interval).toBe(26);
    expect(parseRule('FREQ=MONTHLY;INTERVAL=12;BYMONTHDAY=1')?.interval).toBe(12);
    expect(parseRule('FREQ=YEARLY;INTERVAL=10;BYMONTH=1;BYMONTHDAY=1')?.interval).toBe(10);
  });
});
