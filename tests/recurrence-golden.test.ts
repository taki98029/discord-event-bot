// 旧エバリュエータ（2026-08-23 以前の src/lib/recurrence.ts・14 日巻き寄せ方式）との golden 一致テスト。
// 既存の保存形式（毎週・隔週 anchor 有/無・毎月第N曜 単独/複数/最終）について、新実装が
// 2025〜2027 の任意日・任意時刻で完全に同じ開催日を返すこと＝本番挙動不変の回帰ガード（Phase 1）。
//
// 対象外（意図した差分）: 隔週で anchor が「評価日より 15 日以上先」のケース。旧実装は anchor を 14 日単位で
// 巻き戻して anchor より前の回を生成していたが、新実装は anchor（次回の開催日）を文字どおり守る
// （tests/recurrence.test.ts「隔週 未来 anchor は文字どおり次回」）。UI 経由の既存行は anchor が 14 日以内 or 過去。
import { describe, expect, it } from 'vitest';
import { RRule } from 'rrule';
import { nextOccurrenceDates } from '../src/lib/recurrence';
import type { Notification } from '../src/db/types';

/** 旧実装（src/lib/recurrence.ts@be6986f nextOccurrenceDates の recurring 部分を凍結コピー） */
function legacyNextOccurrenceDates(n: Notification, count: number, now: Date): string[] {
  if (!n.rrule) return [];
  const [sh, sm] = n.start_time.split(':').map(Number);
  const startMinutes = sh * 60 + sm;
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const beforeStart = nowMinutes < startMinutes;
  const boundary = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0));
  if (!beforeStart) boundary.setUTCDate(boundary.getUTCDate() + 1);

  let rule: RRule;
  try {
    const opts = RRule.parseString(n.rrule);
    if (opts.freq === undefined) return [];
    const dtstart = legacyAnchorToUTC(n.anchor_date);
    const drift = dtstart.getTime() - boundary.getTime();
    const periods = Math.ceil(drift / (14 * 86_400_000));
    if (periods !== 0) dtstart.setUTCDate(dtstart.getUTCDate() - periods * 14);
    opts.dtstart = dtstart;
    rule = new RRule(opts);
  } catch {
    return [];
  }

  const out: string[] = [];
  let cursor: Date | null = rule.after(boundary, true);
  while (cursor && out.length < count) {
    const y = cursor.getUTCFullYear();
    const mo = String(cursor.getUTCMonth() + 1).padStart(2, '0');
    const d = String(cursor.getUTCDate()).padStart(2, '0');
    out.push(`${y}/${mo}/${d}`);
    cursor = rule.after(cursor, false);
  }
  return out;
}

function legacyAnchorToUTC(anchorDate: string | null): Date {
  if (anchorDate) {
    const [ay, am, ad] = anchorDate.split('/').map(Number);
    if (ay && am && ad) return new Date(Date.UTC(ay, am - 1, ad, 0, 0, 0));
  }
  return new Date(Date.UTC(2000, 0, 1, 0, 0, 0));
}

function makeNotification(over: Partial<Notification>): Notification {
  return {
    id: 1,
    uuid: '00000000-0000-0000-0000-000000000001',
    guild_id: 'g1',
    segment_id: 1,
    name: 'golden',
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
    message_title: 'golden',
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

// 既存 UI（ui/src/lib/rrule.ts buildRRule）が生成しうる形式＋既存テストの形式
const RULES = [
  'FREQ=WEEKLY;BYDAY=SA',
  'FREQ=WEEKLY;BYDAY=MO',
  'FREQ=WEEKLY;INTERVAL=2;BYDAY=SA',
  'FREQ=WEEKLY;INTERVAL=2;BYDAY=WE',
  'FREQ=MONTHLY;BYDAY=2SA',
  'FREQ=MONTHLY;BYDAY=1SU,3SU,5SU',
  'FREQ=MONTHLY;BYDAY=1SU,3TU',
  'FREQ=MONTHLY;BYDAY=-1FR',
];
// anchor: 無し / 掃引開始より過去（土・水・遠い過去の土）
const ANCHORS: (string | null)[] = [null, '2024/06/01', '2024/11/13', '2019/03/02'];
const START_TIMES = ['21:00', '09:30'];

/** 2025/01/01 〜 2027/12/31 を 5 日刻み × 3 時刻（開始前・開始後・深夜）で掃引 */
function* sweep(): Generator<Date> {
  for (let t = new Date(2025, 0, 1); t.getFullYear() <= 2027; t.setDate(t.getDate() + 5)) {
    for (const [h, m] of [
      [10, 0],
      [21, 30],
      [0, 15],
    ]) {
      yield new Date(t.getFullYear(), t.getMonth(), t.getDate(), h, m);
    }
  }
}

describe('golden: 既存形式の RRULE は旧実装と完全一致（2025〜2027 掃引）', () => {
  for (const rrule of RULES) {
    for (const anchor of ANCHORS) {
      it(`${rrule} anchor=${anchor ?? 'なし'}`, () => {
        for (const start_time of START_TIMES) {
          const n = makeNotification({ rrule, anchor_date: anchor, start_time });
          let evaluated = 0;
          for (const now of sweep()) {
            const expected = legacyNextOccurrenceDates(n, 4, now);
            const actual = nextOccurrenceDates(n, 4, now);
            if (actual.join() !== expected.join()) {
              // 失敗時に条件が分かるよう now を添えて落とす
              expect({ now: now.toString(), actual }).toEqual({ now: now.toString(), actual: expected });
            }
            evaluated++;
          }
          expect(evaluated).toBeGreaterThan(600);
        }
      });
    }
  }

  it('隔週: anchor が評価日から 14 日以内の未来でも旧実装と一致（UI 候補 1・2 番目）', () => {
    const n = makeNotification({ rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=SA', anchor_date: '2026/09/12' });
    for (let d = 0; d <= 13; d++) {
      for (const h of [10, 22]) {
        const now = new Date(2026, 7, 30 + d, h, 0); // 8/30〜9/12
        expect(nextOccurrenceDates(n, 3, now)).toEqual(legacyNextOccurrenceDates(n, 3, now));
      }
    }
  });
});
