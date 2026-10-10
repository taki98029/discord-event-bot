/**
 * RRULE サブセット文法（docs/dev/schedule-recurrence-redesign.md §5.1）の検証・正規化・モデル変換。
 *
 * rrule パッケージに依存しない純関数。API の入力検証（Phase 2）と UI ビルダ（Phase 3）が
 * 同じ文法を共有するための 1 か所。評価（日付の列挙）は src/lib/recurrence.ts が担う。
 *
 * 文法（1 行・'RRULE:' 接頭辞なし・KEY=VALUE を ';' 連結）:
 *   FREQ       := DAILY | WEEKLY | MONTHLY | YEARLY（必須）
 *   INTERVAL   := 1..INTERVAL_MAX[FREQ]（省略時 1）
 *   WEEKLY     : BYDAY 必須（序数なし・1 個以上・重複なし）
 *   MONTHLY    : BYDAY（序数 -1,1..5 付き） xor BYMONTHDAY（1..31 と -1=月末）
 *   YEARLY     : BYMONTH（1 個）＋ BYMONTHDAY（1 個・その月に実在する日。2月は 29 まで＝うるう年だけ開催）
 *   DAILY      : BYxxx なし
 *   WKST       := MO（任意・省略時も MO）
 *   禁止       : UNTIL, COUNT, BYSETPOS, BYHOUR 等その他すべてのキー（文法外は null = 読み取り不能）
 */

export type Freq = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';

/** RFC5545 の曜日コード。並びは正規化の順序（WKST=MO 起点） */
export type WeekdayCode = 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU';
export const WEEKDAY_CODES: readonly WeekdayCode[] = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

/** 月ごとの最大日（2月は 29＝うるう年だけ開催）。YEARLY の実在日検証と UI の日の選択肢で共有する */
export const MONTH_MAX_DAY: readonly number[] = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** INTERVAL の上限（FREQ 別・2026-08-23 裁定 Q8）。API 検証と UI の入力上限で共有する */
export const INTERVAL_MAX: Readonly<Record<Freq, number>> = { DAILY: 30, WEEKLY: 26, MONTHLY: 12, YEARLY: 10 };

/** 文法と 1:1 のモデル（文法外の値は表現できない） */
export type RuleModel = {
  freq: Freq;
  /** 1..INTERVAL_MAX[freq] */
  interval: number;
  /** WEEKLY: nth=0 のみ / MONTHLY: nth ∈ {-1, 1..5}（bymonthday と排他）/ DAILY・YEARLY: [] */
  byday: { nth: number; day: WeekdayCode }[];
  /** MONTHLY: 1..31 と -1（月末）/ YEARLY: 1 個（1..31）/ DAILY・WEEKLY: [] */
  bymonthday: number[];
  /** YEARLY: 1 個（1..12）/ それ以外: [] */
  bymonth: number[];
};

const KEYS: readonly string[] = ['FREQ', 'INTERVAL', 'BYDAY', 'BYMONTHDAY', 'BYMONTH', 'WKST'];
const BYDAY_RE = /^([+-]?\d+)?(MO|TU|WE|TH|FR|SA|SU)$/;
const INT_RE = /^[+-]?\d+$/;

function ints(v: string | undefined): number[] | null {
  if (v === undefined) return [];
  const out = v.split(',').map((t) => (INT_RE.test(t) ? Number(t) : NaN));
  return out.some((x) => Number.isNaN(x)) ? null : out;
}

function unique<T>(xs: T[], key: (x: T) => string): boolean {
  return new Set(xs.map(key)).size === xs.length;
}

/**
 * RRULE 文字列を文法検証してモデルに変換する。文法外（不明キー・UNTIL/COUNT・複数行・重複・範囲外・
 * FREQ ごとの必須/禁止違反）は null。黙って既定値に丸めない（P5 対策）。
 */
export function parseRule(rrule: string | null | undefined): RuleModel | null {
  if (!rrule || /\s/.test(rrule)) return null; // 空・複数行（DTSTART:…\nRRULE:…）・空白混入
  const kv = new Map<string, string>();
  for (const pair of rrule.toUpperCase().split(';')) {
    const i = pair.indexOf('=');
    if (i <= 0) return null;
    const k = pair.slice(0, i);
    const v = pair.slice(i + 1);
    if (!KEYS.includes(k) || kv.has(k) || !v) return null; // 未知キー（UNTIL/COUNT/BYSETPOS 等）・重複・空値
    kv.set(k, v);
  }

  const freq = kv.get('FREQ') as Freq | undefined;
  if (!freq || !(freq in INTERVAL_MAX)) return null;
  const intervalStr = kv.get('INTERVAL');
  const interval = intervalStr === undefined ? 1 : /^\d+$/.test(intervalStr) ? Number(intervalStr) : NaN;
  if (!(interval >= 1 && interval <= INTERVAL_MAX[freq])) return null;
  if (kv.has('WKST') && kv.get('WKST') !== 'MO') return null;

  const bydayStr = kv.get('BYDAY');
  const byday: RuleModel['byday'] = [];
  if (bydayStr !== undefined) {
    for (const tok of bydayStr.split(',')) {
      const m = BYDAY_RE.exec(tok);
      if (!m) return null;
      byday.push({ nth: m[1] ? Number(m[1]) : 0, day: m[2] as WeekdayCode });
    }
    if (!unique(byday, (d) => `${d.nth}${d.day}`)) return null;
  }
  const bymonthday = ints(kv.get('BYMONTHDAY'));
  const bymonth = ints(kv.get('BYMONTH'));
  if (!bymonthday || !bymonth) return null;
  if (!unique(bymonthday, String) || !unique(bymonth, String)) return null;

  const monthdayOk = (d: number, allowLast: boolean) => (d >= 1 && d <= 31) || (allowLast && d === -1);
  switch (freq) {
    case 'DAILY':
      if (byday.length || bymonthday.length || bymonth.length) return null;
      break;
    case 'WEEKLY':
      if (!byday.length || byday.some((d) => d.nth !== 0) || bymonthday.length || bymonth.length) return null;
      break;
    case 'MONTHLY':
      if (bymonth.length || !byday.length === !bymonthday.length) return null; // 両方あり（AND で 0 件）／両方なし（dtstart 依存）。要素数ではなく有無で比べる
      if (byday.some((d) => d.nth === 0 || d.nth < -1 || d.nth > 5)) return null;
      if (bymonthday.some((d) => !monthdayOk(d, true))) return null;
      break;
    case 'YEARLY':
      if (byday.length || bymonth.length !== 1 || bymonthday.length !== 1) return null;
      if (bymonth[0] < 1 || bymonth[0] > 12 || !monthdayOk(bymonthday[0], false)) return null;
      // 実在しない月日（2/30・4/31 等）は 0 件のまま rrule が 9999 年まで探索し続ける（1 回 約90ms）ため拒否
      if (bymonthday[0] > MONTH_MAX_DAY[bymonth[0] - 1]) return null;
      break;
  }
  return { freq, interval, byday, bymonthday, bymonth };
}

const bydayOrder = (d: { nth: number; day: WeekdayCode }) => (d.nth === -1 ? 99 : d.nth) * 10 + WEEKDAY_CODES.indexOf(d.day);
const monthdayOrder = (d: number) => (d === -1 ? 99 : d);

/**
 * モデルを正規形の RRULE 文字列にする（キー順 FREQ;INTERVAL;BYDAY;BYMONTH;BYMONTHDAY・INTERVAL=1 は省略・
 * BYDAY は第N→曜日（月曜起点）昇順で最終は末尾・BYMONTHDAY は昇順で月末(-1)は末尾・'+' なし・WKST 省略）。
 * 文字列比較で「ルールが変わったか」を判定できる。既存の保存形式（FREQ=WEEKLY;BYDAY=SA /
 * FREQ=WEEKLY;INTERVAL=2;BYDAY=SA / FREQ=MONTHLY;BYDAY=1SU,3SU,5SU）は不動点。
 */
export function formatRule(m: RuleModel): string {
  const parts = [`FREQ=${m.freq}`];
  if (m.interval !== 1) parts.push(`INTERVAL=${m.interval}`);
  if (m.byday.length) {
    const days = [...m.byday].sort((a, b) => bydayOrder(a) - bydayOrder(b));
    parts.push('BYDAY=' + days.map((d) => (d.nth || '') + d.day).join(','));
  }
  if (m.bymonth.length) parts.push('BYMONTH=' + [...m.bymonth].sort((a, b) => a - b).join(','));
  if (m.bymonthday.length) {
    parts.push('BYMONTHDAY=' + [...m.bymonthday].sort((a, b) => monthdayOrder(a) - monthdayOrder(b)).join(','));
  }
  return parts.join(';');
}

/** 文法検証＋正規化。文法外は null。 */
export function normalizeRule(rrule: string | null | undefined): string | null {
  const m = parseRule(rrule);
  return m ? formatRule(m) : null;
}
