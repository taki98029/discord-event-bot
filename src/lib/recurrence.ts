/**
 * RRULE 評価ユーティリティ（タイムゾーン: Asia/Tokyo / JST）
 *
 * RRULE の評価ロジックをこの 1 ファイルに閉じ込める。消費側（cron / interactions / admin）は
 * nextOccurrenceDate / buildRRule のみを使い、rrule パッケージへ直接依存しない。
 *
 * JST 壁時計での評価について（重要）:
 *   Cloudflare Workers のランタイムは常に UTC で動作するため、getJSTNow() が返す Date の
 *   ローカルゲッター（getFullYear/getMonth/getDate/getHours/getDay）は JST のカレンダー値になる
 *   （src/lib/date.ts と同じ前提）。
 *   rrule の RRule.fromString().after(dtstart, inc) は dtstart のローカル時刻系でイテレートし、
 *   返り値の Date もローカルゲッターで読むと一致する（new Date(y, m-1, d) 系と同じ系列）。
 *   したがって dtstart / now を getJSTNow() ベースのローカルコンストラクタ（new Date(...) や
 *   parseJSTDate）で組み立てれば、評価全体が JST 壁時計で閉じる。
 *   結果は formatDate（ローカルゲッターで 'YYYY/MM/DD' を組む）で文字列化する。
 */

import { RRule, type Weekday } from 'rrule';
import type { Notification } from '../db/types';
import { getJSTNow } from './date';

/**
 * Notification の次の開催日を 'YYYY/MM/DD'（JST）で返す。該当なしは null。
 *
 * - oneoff: one_off_date をそのまま返す（過去でもそのまま。daysUntil 判定は呼び出し側）。
 * - recurring: rrule を JST 基準で評価し、今日以降で最も近い開催日を返す。
 *   当日でも start_time 前なら当日、start_time 以降なら次の回（旧 getTargetDate の当日ロジックを踏襲）。
 */
export function nextOccurrenceDate(n: Notification, now: Date = getJSTNow()): string | null {
  if (n.type === 'oneoff') {
    return n.one_off_date ?? null;
  }

  // recurring: rrule が無ければ評価不能
  if (!n.rrule) return null;

  // rrule は内部を常に UTC で評価する。そこで「JST 壁時計のカレンダー値」を UTC フィールドに
  // 載せた Date を渡し、結果も getUTC* で読む。これでランタイムの TZ（本番=UTC / ローカルテスト=
  // ホストTZ）に依存せず、評価が JST 壁時計で閉じる。now のローカルゲッターは getJSTNow の前提に
  // より JST のカレンダー値を返す（src/lib/date.ts と同じ）。
  const [sh, sm] = n.start_time.split(':').map(Number);
  const startMinutes = sh * 60 + sm;
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const beforeStart = nowMinutes < startMinutes;

  // 当日ロジック（旧 getTargetDate 踏襲）: start_time 前なら今日を含め、以降なら翌日へ＝次の回。
  // 境界の 0:00 は「UTC フィールド = JST のカレンダー日付」で構築する。
  const boundary = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0));
  if (!beforeStart) boundary.setUTCDate(boundary.getUTCDate() + 1);

  let rule: RRule;
  try {
    const opts = RRule.parseString(n.rrule);
    if (opts.freq === undefined) return null; // FREQ 無し = 不正な RRULE
    // dtstart（系列の基準）を明示する。無いと rrule は実行時刻を既定起点にし、渡した now を
    // 反映できない。隔週(INTERVAL=2)は dtstart のパリティで開催週が決まるため基準固定が必須。
    //   anchor_date があればそれ、無ければ固定エポック（週次/毎月第N曜は基準非依存）。
    const dtstart = anchorToUTC(n.anchor_date);
    // dtstart が境界より未来だと、その手前の開催回が生成されず近日の回をスキップしてしまう。
    // 週次/隔週のパリティ（14日周期）を保ったまま境界以前へ巻き戻す（毎月第N曜は基準非依存で無害）。
    const ahead = dtstart.getTime() - boundary.getTime();
    if (ahead > 0) {
      const periods = Math.ceil(ahead / (14 * 86_400_000));
      dtstart.setUTCDate(dtstart.getUTCDate() - periods * 14);
    }
    opts.dtstart = dtstart;
    rule = new RRule(opts);
  } catch {
    return null;
  }

  // inc=true: 境界日（0:00）に一致する開催日も含める。
  const next = rule.after(boundary, true);
  if (!next) return null;

  // UTC フィールド = JST のカレンダー日付。
  const y = next.getUTCFullYear();
  const mo = String(next.getUTCMonth() + 1).padStart(2, '0');
  const d = String(next.getUTCDate()).padStart(2, '0');
  return `${y}/${mo}/${d}`;
}

/** anchor_date('YYYY/MM/DD') または既定エポックを、UTC フィールドに JST 日付を載せた Date で返す。 */
function anchorToUTC(anchorDate: string | null): Date {
  if (anchorDate) {
    const [ay, am, ad] = anchorDate.split('/').map(Number);
    if (ay && am && ad) return new Date(Date.UTC(ay, am - 1, ad, 0, 0, 0));
  }
  return new Date(Date.UTC(2000, 0, 1, 0, 0, 0)); // 既定エポック（2000/01/01 は土曜）
}

/** buildRRule のオプション */
export type BuildRRuleOptions =
  | {
      /** 毎週: 指定曜日に毎週 */
      freq: 'weekly';
      /** 'SU'|'MO'|'TU'|'WE'|'TH'|'FR'|'SA' */
      byday: WeekdayCode;
    }
  | {
      /** 隔週: 指定曜日に 2 週おき（INTERVAL=2） */
      freq: 'biweekly';
      byday: WeekdayCode;
    }
  | {
      /** 毎月第 N 曜日（例 第2土曜 = nth:2, byday:'SA'） */
      freq: 'monthly-nth-weekday';
      /** 第 N（1〜5、-1 で最終週も可） */
      nth: number;
      byday: WeekdayCode;
    };

/** RFC5545 の曜日コード */
export type WeekdayCode = 'SU' | 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA';

/** 曜日コード → rrule の Weekday 定数 */
const WEEKDAY_MAP: Record<WeekdayCode, Weekday> = {
  SU: RRule.SU,
  MO: RRule.MO,
  TU: RRule.TU,
  WE: RRule.WE,
  TH: RRule.TH,
  FR: RRule.FR,
  SA: RRule.SA,
};

/**
 * UI / テスト用の RRULE 文字列ビルダ（任意）。
 * weekly(byday) / biweekly(interval=2) / monthly-nth-weekday を組み立てる。
 * 例: 毎週土曜=FREQ=WEEKLY;BYDAY=SA / 隔週土曜=FREQ=WEEKLY;INTERVAL=2;BYDAY=SA /
 *     毎月第2土曜=FREQ=MONTHLY;BYDAY=2SA
 */
export function buildRRule(opts: BuildRRuleOptions): string {
  let rule: RRule;
  switch (opts.freq) {
    case 'weekly':
      rule = new RRule({ freq: RRule.WEEKLY, byweekday: [WEEKDAY_MAP[opts.byday]] });
      break;
    case 'biweekly':
      rule = new RRule({
        freq: RRule.WEEKLY,
        interval: 2,
        byweekday: [WEEKDAY_MAP[opts.byday]],
      });
      break;
    case 'monthly-nth-weekday':
      // 第 N 曜日は Weekday.nth(N) で表現（例 RRule.SA.nth(2) → BYDAY=2SA）
      rule = new RRule({
        freq: RRule.MONTHLY,
        byweekday: [WEEKDAY_MAP[opts.byday].nth(opts.nth)],
      });
      break;
  }
  // RRule.toString() は 'RRULE:' 接頭辞を含み、正の序数に '+'（例 BYDAY=+2SA）を付ける。
  // 本文だけ・'+' 無しの正規形（BYDAY=2SA）で返す。
  return rule.toString().replace(/^RRULE:/, '').replace(/\+(\d)/g, '$1');
}
