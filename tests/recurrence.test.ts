import { describe, it, expect } from 'vitest';
import { nextOccurrenceDate, buildRRule } from '../src/lib/recurrence';
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
    guild_id: 'g1',
    segment_id: 1,
    name: 'テスト通知',
    channel_id: 'c1',
    type: 'recurring',
    rrule: null,
    one_off_date: null,
    anchor_date: null,
    start_time: '21:00',
    duration_minutes: null,
    recruit_days_before: 7,
    remind_start_days: 3,
    remind_undecided_days: 1,
    quota_enabled: 0,
    quota_interval_days: null,
    assignment_enabled: 0,
    mention_enabled: 1,
    mention_mode: 'role',
    requires_response: 1,
    message_title: 'テスト通知',
    message_body: null,
    active: 1,
    decided_occurrence_id: null,
    response_deadline_hours: null,
    change_alert_channel_id: null,
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

describe('nextOccurrenceDate - 単発（oneoff）', () => {
  it('one_off_date をそのまま返す（未来）', () => {
    const n = makeNotification({ type: 'oneoff', rrule: null, one_off_date: '2025/03/20' });
    const now = new Date(2025, 0, 1, 10, 0);
    expect(nextOccurrenceDate(n, now)).toBe('2025/03/20');
  });

  it('過去の one_off_date でもそのまま返す（判定は呼び出し側）', () => {
    const n = makeNotification({ type: 'oneoff', rrule: null, one_off_date: '2024/12/01' });
    const now = new Date(2025, 0, 1, 10, 0);
    expect(nextOccurrenceDate(n, now)).toBe('2024/12/01');
  });

  it('one_off_date 未設定なら null', () => {
    const n = makeNotification({ type: 'oneoff', rrule: null, one_off_date: null });
    expect(nextOccurrenceDate(n, new Date(2025, 0, 1, 10, 0))).toBeNull();
  });
});

describe('nextOccurrenceDate - recurring の異常系', () => {
  it('rrule 未設定なら null', () => {
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
