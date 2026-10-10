import { describe, it, expect } from 'vitest';
import { nextOccurrenceDate, nextOccurrenceDates, buildRRule, occurrenceDatesBetween, anchorMatchesRule, alignDtstart } from '../src/lib/recurrence';
import type { Notification } from '../src/db/types';

// nextOccurrenceDate は内部で rrule を JST 壁時計で評価する。
// getJSTNow() のローカルゲッターが JST カレンダー値を返す前提に合わせ、
// テストの now もローカルコンストラクタ new Date(y, m-1, d, h, min) で組む（TZ 非依存）。
// このテストは rrule パッケージの Workers 互換確認も兼ねる。
//
// 基準日メモ:
//   2025/01/01 = 水曜 / 2025/01/04 = 土曜 / 2025/01/11 = 土曜 / 2025/01/18 = 土曜。

/** 検証に必要な列だけ埋めた Notification を組み立てる */
function makeNotification(over: Partial<Notification>): Notification {
  return {
    id: 1,
    uuid: '00000000-0000-0000-0000-000000000001',
    guild_id: 'g1',
    segment_id: 1,
    name: 'テスト通知',
    channel_id: 'c1',
    type: 'recurring',
    rrule: null,
    anchor_date: null,
    start_time: '21:00',
    duration_minutes: null,
    recruit_days_before: 7,
    remind_start_days: 3,
    remind_undecided_days: 1,
    recruit_enabled: 1,
    remind_unanswered_enabled: 1,
    remind_undecided_enabled: 1,
    remind_target: 'dm',
    remind_undecided_target: 'dm',
    share_answers: 1,
    quota_enabled: 0,
    quota_interval_days: null,
    assignment_enabled: 0,
    grouping_enabled: 0,
    mention_enabled: 1,
    mention_mode: 'role',
    requires_response: 1,
    message_title: 'テスト通知',
    message_body: null,
    active: 1,
    response_deadline_hours: null,
    change_alert_channel_id: null,
    grouping_channel_id: null,
    send_hour: 21,
    created_at: '',
    ...over,
  };
}

describe('nextOccurrenceDate - 週次（FREQ=WEEKLY;BYDAY=SA）', () => {
  const n = makeNotification({ type: 'recurring', rrule: 'FREQ=WEEKLY;BYDAY=SA', start_time: '21:00' });

  it('別の曜日からは直近の開催曜日を返す', () => {
    const now = new Date(2025, 0, 1, 10, 0); // 水 10:00 JST → 次の土曜
    expect(nextOccurrenceDate(n, now)).toBe('2025/01/04');
  });

  it('開催曜日当日・開始時刻前なら当日を返す', () => {
    const now = new Date(2025, 0, 4, 20, 0); // 土 20:00 JST（21:00 前）
    expect(nextOccurrenceDate(n, now)).toBe('2025/01/04');
  });

  it('開催曜日当日・開始時刻以降なら次の回を返す', () => {
    const now = new Date(2025, 0, 4, 21, 30); // 土 21:30 JST（21:00 以降）
    expect(nextOccurrenceDate(n, now)).toBe('2025/01/11');
  });
});

describe('nextOccurrenceDate - 隔週（FREQ=WEEKLY;INTERVAL=2;BYDAY=SA）', () => {
  // rrule の隔週は DTSTART を基準に 2 週おきで展開される。基準なしの fromString では
  // ライブラリ既定の起点に依存するため、隣り合う 2 つの候補日の間隔が 14 日であることを検証する。
  const n = makeNotification({
    type: 'recurring',
    rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=SA',
    start_time: '21:00',
  });

  it('候補は土曜日で、連続する開催回の間隔は 14 日', () => {
    const now = new Date(2025, 0, 1, 10, 0); // 水 10:00 JST
    const first = nextOccurrenceDate(n, now);
    expect(first).not.toBeNull();

    // first の翌日以降で次の開催回を求める
    const [fy, fm, fd] = first!.split('/').map(Number);
    const afterFirst = new Date(fy, fm - 1, fd, 23, 0); // 当日開始時刻以降 → 次の回へ
    const second = nextOccurrenceDate(n, afterFirst);
    expect(second).not.toBeNull();

    // どちらも土曜（getDay()===6）
    const fdDate = new Date(fy, fm - 1, fd);
    expect(fdDate.getDay()).toBe(6);
    const [sy, sm, sd] = second!.split('/').map(Number);
    expect(new Date(sy, sm - 1, sd).getDay()).toBe(6);

    // 間隔は 14 日
    const diff = Math.round(
      (new Date(sy, sm - 1, sd).getTime() - fdDate.getTime()) / 86_400_000,
    );
    expect(diff).toBe(14);
  });
});

describe('nextOccurrenceDate - 毎月第N曜（FREQ=MONTHLY;BYDAY=2SA）', () => {
  const n = makeNotification({
    type: 'recurring',
    rrule: 'FREQ=MONTHLY;BYDAY=2SA',
    start_time: '21:00',
  });

  it('当月の第2土曜が未来ならそれを返す', () => {
    // 2025/01 の第2土曜は 2025/01/11
    const now = new Date(2025, 0, 1, 10, 0); // 1/1 水
    expect(nextOccurrenceDate(n, now)).toBe('2025/01/11');
  });

  it('当月の第2土曜を過ぎたら翌月の第2土曜を返す', () => {
    // 2025/02 の第2土曜は 2025/02/08
    const now = new Date(2025, 0, 12, 10, 0); // 1/12（1/11 を過ぎた）
    expect(nextOccurrenceDate(n, now)).toBe('2025/02/08');
  });
});

describe('nextOccurrenceDate - 毎月 複数第N曜（BYDAY 複数指定）', () => {
  // 2025/06 の日曜=1,8,15,22,29 → 第1=6/1, 第3=6/15, 第5=6/29。火曜=3,10,17,24 → 第3火=6/17。
  it('第1・第3・第5 日曜のうち直近を返す（第5がある月）', () => {
    const n = makeNotification({ type: 'recurring', rrule: 'FREQ=MONTHLY;BYDAY=1SU,3SU,5SU', start_time: '21:00' });
    expect(nextOccurrenceDate(n, new Date(2025, 5, 2, 10, 0))).toBe('2025/06/15'); // 6/2 → 第3
    expect(nextOccurrenceDate(n, new Date(2025, 5, 16, 10, 0))).toBe('2025/06/29'); // 6/16 → 第5
    expect(nextOccurrenceDate(n, new Date(2025, 5, 30, 10, 0))).toBe('2025/07/06'); // 6/30 → 翌月第1(7/6)
  });

  it('第5が無い月は第5の回だけスキップされる', () => {
    // 2025/02 の日曜=2,9,16,23（第5なし）。第1=2/2, 第3=2/16。
    const n = makeNotification({ type: 'recurring', rrule: 'FREQ=MONTHLY;BYDAY=1SU,3SU,5SU', start_time: '21:00' });
    expect(nextOccurrenceDate(n, new Date(2025, 1, 17, 10, 0))).toBe('2025/03/02'); // 2/17 → 第5なし→翌月第1(3/2)
  });

  it('曜日混在 第1日曜＋第3火曜', () => {
    const n = makeNotification({ type: 'recurring', rrule: 'FREQ=MONTHLY;BYDAY=1SU,3TU', start_time: '21:00' });
    expect(nextOccurrenceDate(n, new Date(2025, 5, 2, 10, 0))).toBe('2025/06/17'); // 6/1(第1日)は過去→6/17(第3火)
  });
});

describe('nextOccurrenceDate - anchor_date（隔週パリティ / 未来anchorの巻き戻し）', () => {
  it('anchor_date で隔週の開催週パリティが変わる', () => {
    const now = new Date(2025, 0, 1, 10, 0); // 1/1 水
    const base = { type: 'recurring' as const, rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=SA', start_time: '21:00' };
    // 基準を 1/04 にすると直近回は 1/04、1/11 にすると 1/11（隔週の偶奇が切り替わる）
    expect(nextOccurrenceDate(makeNotification({ ...base, anchor_date: '2025/01/04' }), now)).toBe('2025/01/04');
    expect(nextOccurrenceDate(makeNotification({ ...base, anchor_date: '2025/01/11' }), now)).toBe('2025/01/11');
  });

  it('遠い過去の anchor_date は 14 日パリティを保って巻き寄せられる（CPU対策・挙動不変）', () => {
    const now = new Date(2025, 0, 1, 10, 0); // 1/1 水
    const base = { type: 'recurring' as const, rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=SA', start_time: '21:00' };
    // 2025/01/04 から 14 日 × 653 回さかのぼった遠い過去の anchor は同じ隔週系列に属する
    const far = new Date(2025, 0, 4);
    far.setDate(far.getDate() - 653 * 14);
    const farStr = `${far.getFullYear()}/${String(far.getMonth() + 1).padStart(2, '0')}/${String(far.getDate()).padStart(2, '0')}`;
    expect(nextOccurrenceDate(makeNotification({ ...base, anchor_date: farStr }), now)).toBe(
      nextOccurrenceDate(makeNotification({ ...base, anchor_date: '2025/01/04' }), now),
    );
    expect(nextOccurrenceDate(makeNotification({ ...base, anchor_date: farStr }), now)).toBe('2025/01/04');
  });

  it('未来の anchor_date でも近日の開催回をスキップしない（巻き戻し）', () => {
    const now = new Date(2025, 0, 1, 10, 0); // 1/1 水
    const n = makeNotification({
      type: 'recurring',
      rrule: 'FREQ=WEEKLY;BYDAY=SA',
      anchor_date: '2025/06/07', // 半年先の土曜を基準に設定しても…
      start_time: '21:00',
    });
    expect(nextOccurrenceDate(n, now)).toBe('2025/01/04'); // …直近の土曜が返る
  });
});

describe('nextOccurrenceDate - 異常系', () => {
  it('rrule 未設定（不定期）なら null', () => {
    const n = makeNotification({ type: 'recurring', rrule: null });
    expect(nextOccurrenceDate(n, new Date(2025, 0, 1, 10, 0))).toBeNull();
  });

  it('不正な rrule なら null', () => {
    const n = makeNotification({ type: 'recurring', rrule: 'NOT_A_VALID_RRULE' });
    expect(nextOccurrenceDate(n, new Date(2025, 0, 1, 10, 0))).toBeNull();
  });
});

describe('buildRRule', () => {
  it('weekly → FREQ=WEEKLY;BYDAY=SA', () => {
    expect(buildRRule({ freq: 'weekly', byday: 'SA' })).toBe('FREQ=WEEKLY;BYDAY=SA');
  });

  it('biweekly → FREQ=WEEKLY;INTERVAL=2;BYDAY=SA', () => {
    expect(buildRRule({ freq: 'biweekly', byday: 'SA' })).toBe(
      'FREQ=WEEKLY;INTERVAL=2;BYDAY=SA',
    );
  });

  it('monthly-nth-weekday → FREQ=MONTHLY;BYDAY=2SA', () => {
    expect(buildRRule({ freq: 'monthly-nth-weekday', nth: 2, byday: 'SA' })).toBe(
      'FREQ=MONTHLY;BYDAY=2SA',
    );
  });

  it('monthly-nth-weekdays（複数）→ FREQ=MONTHLY;BYDAY=1SU,3SU,5SU（順不同）', () => {
    const r = buildRRule({
      freq: 'monthly-nth-weekdays',
      rules: [{ nth: 1, byday: 'SU' }, { nth: 3, byday: 'SU' }, { nth: 5, byday: 'SU' }],
    });
    expect(r.startsWith('FREQ=MONTHLY;BYDAY=')).toBe(true);
    expect(r.split('BYDAY=')[1].split(',').sort()).toEqual(['1SU', '3SU', '5SU']);
  });

  it('monthly-nth-weekdays（曜日混在）→ BYDAY=1SU,3TU', () => {
    const r = buildRRule({
      freq: 'monthly-nth-weekdays',
      rules: [{ nth: 1, byday: 'SU' }, { nth: 3, byday: 'TU' }],
    });
    expect(r.split('BYDAY=')[1].split(',').sort()).toEqual(['1SU', '3TU']);
  });

  it('buildRRule の出力は nextOccurrenceDate でそのまま評価できる', () => {
    const rrule = buildRRule({ freq: 'weekly', byday: 'SA' });
    const n = makeNotification({ type: 'recurring', rrule, start_time: '21:00' });
    const now = new Date(2025, 0, 1, 10, 0); // 水 → 次の土曜
    expect(nextOccurrenceDate(n, now)).toBe('2025/01/04');
  });
});

describe('nextOccurrenceDates（複数件の未来開催日・配信予定の仮想導出用）', () => {
  it('毎週土曜: 連続する土曜日を count 件返す', () => {
    const n = makeNotification({ rrule: 'FREQ=WEEKLY;BYDAY=SA' });
    const now = new Date(2025, 0, 1, 12, 0); // 水曜
    expect(nextOccurrenceDates(n, 3, now)).toEqual(['2025/01/04', '2025/01/11', '2025/01/18']);
  });

  it('先頭は nextOccurrenceDate と一致する（当日ロジック含め同一）', () => {
    const n = makeNotification({ rrule: 'FREQ=WEEKLY;BYDAY=SA', start_time: '21:00' });
    // 土曜当日の start_time 後 → 次週へ進む挙動も一致すること
    const after = new Date(2025, 0, 4, 22, 0);
    expect(nextOccurrenceDates(n, 1, after)[0]).toBe(nextOccurrenceDate(n, after));
    expect(nextOccurrenceDates(n, 1, after)).toEqual(['2025/01/11']);
  });

  it('隔週: anchor_date のパリティを保って 14 日おきに返す', () => {
    const n = makeNotification({
      rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=SA',
      anchor_date: '2025/01/04',
    });
    const now = new Date(2025, 0, 1, 12, 0);
    expect(nextOccurrenceDates(n, 3, now)).toEqual(['2025/01/04', '2025/01/18', '2025/02/01']);
  });

  it('rrule 無し/不正は空配列', () => {
    expect(nextOccurrenceDates(makeNotification({ rrule: null }), 3, new Date(2025, 0, 1))).toEqual([]);
    expect(nextOccurrenceDates(makeNotification({ rrule: 'BYDAY=SA' }), 3, new Date(2025, 0, 1))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// 以下は繰り返し柔軟化（docs/dev/schedule-recurrence-redesign.md・2026-08-23）Phase 1 で追加。
// 基準日メモ: 2026/09/01 = 火 / 9/5 = 土 / 9/6 = 日 / 9/12 = 第2土 / 2027/01/09 = 第2土 / 2028 はうるう年。
// ---------------------------------------------------------------------------------------------

const rec = (over: Partial<Notification>) => makeNotification({ type: 'recurring', start_time: '21:00', ...over });

describe('17 パターン - 新 FREQ の評価（INTERVAL=1・位相なし）', () => {
  it('毎日（FREQ=DAILY）: 当日ロジックを含め連日', () => {
    const n = rec({ rrule: 'FREQ=DAILY' });
    expect(nextOccurrenceDates(n, 3, new Date(2026, 8, 1, 10, 0))).toEqual(['2026/09/01', '2026/09/02', '2026/09/03']);
    expect(nextOccurrenceDates(n, 3, new Date(2026, 8, 1, 22, 0))).toEqual(['2026/09/02', '2026/09/03', '2026/09/04']);
  });

  it('平日（BYDAY=MO,TU,WE,TH,FR）: 金曜 → 金・月・火', () => {
    const n = rec({ rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR' });
    expect(nextOccurrenceDates(n, 3, new Date(2026, 8, 4, 10, 0))).toEqual(['2026/09/04', '2026/09/07', '2026/09/08']);
  });

  it('毎週 複数曜日（BYDAY=SA,SU）', () => {
    const n = rec({ rrule: 'FREQ=WEEKLY;BYDAY=SA,SU' });
    expect(nextOccurrenceDates(n, 3, new Date(2026, 8, 1, 10, 0))).toEqual(['2026/09/05', '2026/09/06', '2026/09/12']);
  });

  it('毎月 日付 複数（BYMONTHDAY=1,15）', () => {
    const n = rec({ rrule: 'FREQ=MONTHLY;BYMONTHDAY=1,15' });
    expect(nextOccurrenceDates(n, 3, new Date(2026, 8, 2, 10, 0))).toEqual(['2026/09/15', '2026/10/01', '2026/10/15']);
  });

  it('月末（BYMONTHDAY=-1）: 30/31/28 日を月ごとに', () => {
    const n = rec({ rrule: 'FREQ=MONTHLY;BYMONTHDAY=-1' });
    expect(nextOccurrenceDates(n, 6, new Date(2026, 8, 1, 10, 0))).toEqual([
      '2026/09/30',
      '2026/10/31',
      '2026/11/30',
      '2026/12/31',
      '2027/01/31',
      '2027/02/28',
    ]);
  });

  it('31 日（BYMONTHDAY=31）: 31 日が無い月はスキップ（RFC どおり・繰り上げない）', () => {
    const n = rec({ rrule: 'FREQ=MONTHLY;BYMONTHDAY=31' });
    expect(nextOccurrenceDates(n, 3, new Date(2026, 8, 1, 10, 0))).toEqual(['2026/10/31', '2026/12/31', '2027/01/31']);
  });

  it('毎年（BYMONTH=3;BYMONTHDAY=20）', () => {
    const n = rec({ rrule: 'FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=20' });
    expect(nextOccurrenceDates(n, 2, new Date(2026, 8, 1, 10, 0))).toEqual(['2027/03/20', '2028/03/20']);
  });

  it('毎年 2/29: うるう年のみ', () => {
    const n = rec({ rrule: 'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29' });
    expect(nextOccurrenceDates(n, 2, new Date(2026, 8, 1, 10, 0))).toEqual(['2028/02/29', '2032/02/29']);
  });

  it('最終金曜（BYDAY=-1FR）', () => {
    const n = rec({ rrule: 'FREQ=MONTHLY;BYDAY=-1FR' });
    expect(nextOccurrenceDates(n, 3, new Date(2026, 8, 1, 10, 0))).toEqual(['2026/09/25', '2026/10/30', '2026/11/27']);
  });

  it('INTERVAL=1 では anchor_date は位相に影響しない（未来 anchor でも直近の回を返す）', () => {
    const base = { rrule: 'FREQ=MONTHLY;BYMONTHDAY=15' };
    const now = new Date(2026, 8, 1, 10, 0);
    expect(nextOccurrenceDate(rec({ ...base, anchor_date: '2026/12/15' }), now)).toBe('2026/09/15');
    expect(nextOccurrenceDate(rec({ ...base, anchor_date: null }), now)).toBe('2026/09/15');
  });
});

describe('17 パターン - INTERVAL>=2 の位相（anchor_date = 次回の開催日）', () => {
  it('N 日おき（DAILY;INTERVAL=3）: 未来 anchor はそのまま・過去 anchor は位相維持で前進', () => {
    const n = rec({ rrule: 'FREQ=DAILY;INTERVAL=3', anchor_date: '2026/09/04' });
    expect(nextOccurrenceDates(n, 3, new Date(2026, 8, 1, 10, 0))).toEqual(['2026/09/04', '2026/09/07', '2026/09/10']);
    expect(nextOccurrenceDates(n, 3, new Date(2026, 8, 20, 10, 0))).toEqual(['2026/09/22', '2026/09/25', '2026/09/28']);
  });

  it('N 週おき（WEEKLY;INTERVAL=3）: 旧実装の 14 日巻き寄せでは崩れた位相が保たれる', () => {
    const n = rec({ rrule: 'FREQ=WEEKLY;INTERVAL=3;BYDAY=SA', anchor_date: '2026/09/05' });
    expect(nextOccurrenceDates(n, 4, new Date(2026, 8, 1, 10, 0))).toEqual([
      '2026/09/05',
      '2026/09/26',
      '2026/10/17',
      '2026/11/07',
    ]);
    expect(nextOccurrenceDates(n, 2, new Date(2026, 9, 1, 10, 0))).toEqual(['2026/10/17', '2026/11/07']);
  });

  it('隔月 第2土曜（MONTHLY;INTERVAL=2;BYDAY=2SA）: 月境界を跨いで評価しても位相が反転しない（実測 #11b の修正）', () => {
    const n = rec({ rrule: 'FREQ=MONTHLY;INTERVAL=2;BYDAY=2SA', anchor_date: '2026/09/12' });
    expect(nextOccurrenceDates(n, 3, new Date(2026, 7, 22, 10, 0))).toEqual(['2026/09/12', '2026/11/14', '2027/01/09']);
    expect(nextOccurrenceDates(n, 2, new Date(2026, 11, 1, 10, 0))).toEqual(['2027/01/09', '2027/03/13']);
  });

  it('隔月 日付（MONTHLY;INTERVAL=2;BYMONTHDAY=1,15）: 次回の開催日より前の同月の日は含まない', () => {
    const n = rec({ rrule: 'FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=1,15', anchor_date: '2026/09/15' });
    expect(nextOccurrenceDates(n, 3, new Date(2026, 7, 20, 10, 0))).toEqual(['2026/09/15', '2026/11/01', '2026/11/15']);
    // anchor が過去になったら月初に正規化して同月の回を取りこぼさない
    expect(nextOccurrenceDates(n, 2, new Date(2026, 10, 5, 10, 0))).toEqual(['2026/11/15', '2027/01/01']);
  });

  it('N 年おき（YEARLY;INTERVAL=2）: 年境界を跨いでも位相が保たれる（実測 #23b の修正）', () => {
    const n = rec({ rrule: 'FREQ=YEARLY;INTERVAL=2;BYMONTH=3;BYMONTHDAY=20', anchor_date: '2027/03/20' });
    expect(nextOccurrenceDates(n, 2, new Date(2026, 0, 1, 10, 0))).toEqual(['2027/03/20', '2029/03/20']);
    expect(nextOccurrenceDates(n, 2, new Date(2028, 0, 1, 10, 0))).toEqual(['2029/03/20', '2031/03/20']);
  });

  it('隔週 複数曜日: 次回の開催日より前の同じ週の曜日は含まない（Q6 注記・WKST=MO）', () => {
    const sun = rec({ rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=SA,SU', anchor_date: '2026/09/06' });
    expect(nextOccurrenceDates(sun, 4, new Date(2026, 8, 1, 10, 0))).toEqual([
      '2026/09/06',
      '2026/09/19',
      '2026/09/20',
      '2026/10/03',
    ]);
    const sat = rec({ rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=SA,SU', anchor_date: '2026/09/05' });
    expect(nextOccurrenceDates(sat, 4, new Date(2026, 8, 1, 10, 0))).toEqual([
      '2026/09/05',
      '2026/09/06',
      '2026/09/19',
      '2026/09/20',
    ]);
    // anchor が過去になっても週の位相は維持（土日を同じ週として扱う）
    expect(nextOccurrenceDates(sun, 2, new Date(2026, 8, 21, 10, 0))).toEqual(['2026/10/03', '2026/10/04']);
  });

  it('隔週 anchor 無し: 既定エポック 2000/01/01（土）の位相（既存行と同一）', () => {
    const n = rec({ rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=SA' });
    // 2000/01/01 から 2025/01/11 は 9142 日 = 14 × 653
    expect(nextOccurrenceDates(n, 2, new Date(2025, 0, 1, 10, 0))).toEqual(['2025/01/11', '2025/01/25']);
  });

  it('隔週 未来 anchor は文字どおり次回（候補 3・4 番目＝15 日以上先を選んだときも手前の回を作らない）', () => {
    const n = rec({ rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=SA', anchor_date: '2026/09/19' });
    expect(nextOccurrenceDates(n, 2, new Date(2026, 8, 1, 10, 0))).toEqual(['2026/09/19', '2026/10/03']);
  });
});

describe('alignDtstart - 起点の整列', () => {
  const d = (y: number, m: number, day: number) => new Date(Date.UTC(y, m - 1, day));
  it('INTERVAL=1 は境界日そのもの（anchor 無視・走査ゼロ）', () => {
    expect(alignDtstart('WEEKLY', 1, d(2026, 12, 5), d(2026, 9, 1))).toEqual(d(2026, 9, 1));
  });
  it('境界以降の anchor はそのまま', () => {
    expect(alignDtstart('WEEKLY', 2, d(2026, 9, 1), d(2026, 9, 1))).toEqual(d(2026, 9, 1));
    expect(alignDtstart('WEEKLY', 2, d(2026, 9, 19), d(2026, 9, 1))).toEqual(d(2026, 9, 19));
  });
  it('過去の anchor は周期の倍数で (境界-周期, 境界] へ前進', () => {
    expect(alignDtstart('DAILY', 3, d(2026, 9, 4), d(2026, 9, 20))).toEqual(d(2026, 9, 19));
    expect(alignDtstart('WEEKLY', 2, d(2026, 9, 5), d(2026, 9, 21))).toEqual(d(2026, 9, 19));
    expect(alignDtstart('WEEKLY', 2, d(2026, 9, 5), d(2026, 9, 19))).toEqual(d(2026, 9, 19));
    expect(alignDtstart('WEEKLY', 3, d(2026, 9, 5), d(2026, 10, 1))).toEqual(d(2026, 9, 26));
  });
  it('月・年は月初・年初に正規化（境界と同じ月・年の回を取りこぼさない）', () => {
    expect(alignDtstart('MONTHLY', 2, d(2026, 9, 12), d(2027, 1, 5))).toEqual(d(2027, 1, 1));
    expect(alignDtstart('MONTHLY', 2, d(2026, 9, 12), d(2026, 12, 1))).toEqual(d(2026, 11, 1));
    expect(alignDtstart('YEARLY', 2, d(2027, 3, 20), d(2028, 1, 1))).toEqual(d(2027, 1, 1));
    expect(alignDtstart('YEARLY', 2, d(2027, 3, 20), d(2029, 5, 1))).toEqual(d(2029, 1, 1));
  });
  it('anchor 無しはエポック 2000/01/01 を同規則で整列', () => {
    const r = alignDtstart('WEEKLY', 2, null, d(2025, 1, 1));
    expect((d(2025, 1, 1).getTime() - r.getTime()) / 86_400_000).toBeLessThan(14);
    expect((r.getTime() - Date.UTC(2000, 0, 1)) % (14 * 86_400_000)).toBe(0);
  });
});

describe('occurrenceDatesBetween - 境界日から窓内の全ルール回（両端含む）', () => {
  it('毎週土曜・14 日窓', () => {
    const n = rec({ rrule: 'FREQ=WEEKLY;BYDAY=SA' });
    expect(occurrenceDatesBetween(n, 14, new Date(2025, 0, 1, 10, 0))).toEqual(['2025/01/04', '2025/01/11']);
  });
  it('毎日・窓 2 日で 3 件（当日ロジック: 開始後は翌日から）', () => {
    const n = rec({ rrule: 'FREQ=DAILY' });
    expect(occurrenceDatesBetween(n, 2, new Date(2026, 8, 1, 10, 0))).toEqual(['2026/09/01', '2026/09/02', '2026/09/03']);
    expect(occurrenceDatesBetween(n, 0, new Date(2026, 8, 1, 22, 0))).toEqual(['2026/09/02']);
  });
  it('先頭は nextOccurrenceDate と一致し、窓外は含まない', () => {
    const n = rec({ rrule: 'FREQ=MONTHLY;INTERVAL=2;BYDAY=2SA', anchor_date: '2026/09/12' });
    const now = new Date(2026, 7, 22, 10, 0);
    expect(occurrenceDatesBetween(n, 7, now)).toEqual([]);
    expect(occurrenceDatesBetween(n, 30, now)).toEqual(['2026/09/12']);
    expect(occurrenceDatesBetween(n, 90, now)[0]).toBe(nextOccurrenceDate(n, now));
  });
  it('不定期（rrule 無し）・文法外は空', () => {
    expect(occurrenceDatesBetween(rec({ rrule: null }), 30, new Date(2026, 8, 1))).toEqual([]);
    expect(occurrenceDatesBetween(rec({ rrule: 'FREQ=DAILY;COUNT=3' }), 30, new Date(2026, 8, 1))).toEqual([]);
  });
});

describe('文法外の rrule は評価しない（UNTIL/COUNT/複数行は文法で拒否）', () => {
  const now = new Date(2026, 8, 1, 10, 0);
  it.each([
    'FREQ=WEEKLY;BYDAY=SA;COUNT=3',
    'FREQ=WEEKLY;BYDAY=SA;UNTIL=20261231',
    'DTSTART:20260901T000000Z\nRRULE:FREQ=DAILY',
    'FREQ=MONTHLY;BYDAY=2SA;BYMONTHDAY=15',
    'FREQ=MONTHLY',
  ])('%s → []', (rrule) => {
    expect(nextOccurrenceDates(rec({ rrule }), 3, now)).toEqual([]);
  });
});

describe('anchorMatchesRule - anchor_date がルールの開催日か（API 検証用）', () => {
  it.each<[string, string, boolean]>([
    ['FREQ=WEEKLY;INTERVAL=2;BYDAY=SA', '2026/09/05', true],
    ['FREQ=WEEKLY;INTERVAL=2;BYDAY=SA', '2026/09/06', false],
    ['FREQ=WEEKLY;INTERVAL=2;BYDAY=SA,SU', '2026/09/06', true],
    ['FREQ=MONTHLY;INTERVAL=2;BYDAY=2SA', '2026/09/12', true],
    ['FREQ=MONTHLY;INTERVAL=2;BYDAY=2SA', '2026/09/05', false],
    ['FREQ=MONTHLY;BYMONTHDAY=-1', '2026/09/30', true],
    ['FREQ=MONTHLY;BYMONTHDAY=-1', '2026/09/29', false],
    ['FREQ=YEARLY;INTERVAL=2;BYMONTH=2;BYMONTHDAY=29', '2028/02/29', true],
    ['FREQ=YEARLY;INTERVAL=2;BYMONTH=2;BYMONTHDAY=29', '2027/02/28', false],
    ['FREQ=DAILY;INTERVAL=3', '2026/09/04', true],
    ['FREQ=DAILY;COUNT=3', '2026/09/04', false],
    ['FREQ=WEEKLY;BYDAY=SA', 'invalid', false],
  ])('%s × %s → %s', (rrule, anchor, ok) => {
    expect(anchorMatchesRule(rrule, anchor)).toBe(ok);
  });
});
