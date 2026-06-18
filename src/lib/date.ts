/**
 * 日付計算ユーティリティ（タイムゾーン: Asia/Tokyo / JST）
 *
 * 重要: Cloudflare Workers のランタイムは常に UTC で動作するため、
 * getJSTNow() が返す Date の getFullYear/getMonth/getDate/getHours/getDay
 * （ローカルゲッター）は JST のカレンダー値になる。旧 lib/date-utils.js と同じ挙動。
 *
 * テスト容易性のため getDaysUntilEvent は now を引数で受け取れる。
 */

/** 'YYYY/MM/DD' 形式にフォーマット */
export function formatDate(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}/${month}/${day}`;
}

/** 現在の JST 時刻（UTC ランタイム前提の計算式。旧 getJSTNow を踏襲） */
export function getJSTNow(): Date {
  const now = new Date();
  const jstOffset = 9 * 60 * 60 * 1000; // JST = UTC+9
  return new Date(now.getTime() + now.getTimezoneOffset() * 60 * 1000 + jstOffset);
}

/** イベントまでの日数（旧 getDaysUntilEvent）。日付のみで比較 */
export function getDaysUntilEvent(targetDate: Date, now: Date = getJSTNow()): number {
  const target = new Date(targetDate);
  target.setHours(0, 0, 0, 0);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  return Math.floor((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * 'YYYY/MM/DD' を JST 壁時計の Date として解釈する。
 *
 * new Date(y, m-1, d) はローカルタイムゾーン基準で Date を構築する。
 * UTC ランタイム前提では getJSTNow() のローカルゲッターが JST 値を返すのと整合し、
 * ここで作る Date のローカルゲッター（getFullYear 等）も JST カレンダー値になる。
 * 不正形式の場合は Invalid Date を返す。
 */
export function parseJSTDate(s: string): Date {
  const [year, month, day] = s.split('/').map(Number);
  return new Date(year, month - 1, day);
}

/**
 * 'YYYY/MM/DD' と今日(JST)との日数差。
 * 内部で parseJSTDate により JST 壁時計の Date に変換し、getDaysUntilEvent で比較する。
 */
export function getDaysUntil(dateStr: string, now: Date = getJSTNow()): number {
  return getDaysUntilEvent(parseJSTDate(dateStr), now);
}

/**
 * 'HH:MM' に分を加算した終了時刻を返す。24:00 を跨いだ場合は nextDay=true。
 * minutes は非負（開催時間=duration）を前提とする。負値を渡すと前日扱いになるが正規の用途ではない。
 * 例: addMinutesToTime('23:00', 180) → { time: '02:00', nextDay: true }
 */
export function addMinutesToTime(time: string, minutes: number): { time: string; nextDay: boolean } {
  const [h, m] = time.split(':').map(Number);
  const total = (h || 0) * 60 + (m || 0) + minutes;
  const wrapped = ((total % 1440) + 1440) % 1440;
  const hh = String(Math.floor(wrapped / 60)).padStart(2, '0');
  const mm = String(wrapped % 60).padStart(2, '0');
  return { time: `${hh}:${mm}`, nextDay: total >= 1440 || total < 0 };
}

/**
 * 開始時刻＋開催時間(分) を From-To 文字列で返す。
 * duration が未設定(null/0以下)なら開始時刻のみの開放端「HH:MM〜」。
 * 翌日に跨ぐ終了時刻は「〜翌HH:MM」。例: '21:00'+120 → '21:00〜23:00' / '23:00'+180 → '23:00〜翌02:00'
 */
export function formatTimeRange(start: string, durationMinutes: number | null | undefined): string {
  if (!durationMinutes || durationMinutes <= 0) return `${start}〜`;
  const end = addMinutesToTime(start, durationMinutes);
  return `${start}〜${end.nextDay ? '翌' : ''}${end.time}`;
}

/** 'YYYY/MM/DD' の曜日ラベル（JST 壁時計・0=日 → '日'）。不正形式は ''。 */
const WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'];
export function weekdayLabel(dateStr: string): string {
  const [y, m, d] = dateStr.split('/').map(Number);
  if (!y || !m || !d) return '';
  return WEEKDAY_LABELS[new Date(y, m - 1, d).getDay()];
}

/** 開催回の表示ラベル 'YYYY/MM/DD (曜) HH:MM〜HH:MM'（duration 未設定なら 'HH:MM〜'）。 */
export function formatOccurrenceLabel(
  date: string,
  time: string,
  durationMinutes: number | null | undefined,
): string {
  const w = weekdayLabel(date);
  return `${date}${w ? ` (${w})` : ''} ${formatTimeRange(time, durationMinutes)}`;
}
