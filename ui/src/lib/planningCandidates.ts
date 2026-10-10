import { dateValue, timeValue, MAX_CANDIDATES } from '../../../src/planning/model';

export type CandidateInput = { date: string; time: string };

/** A yearless line belongs to the fixed year shown beside the editor, never the visible calendar month. */
export function parseCandidateLines(value: string, year: number): CandidateInput[] {
  const result: CandidateInput[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of value.split('\n').entries()) {
    if (!raw.trim()) continue;
    const line = raw.normalize('NFKC').trim();
    const m = line.match(
      /^(?:(\d{4})[\/-])?(\d{1,2})[\/-](\d{1,2})(?:\s*\([日月火水木金土](?:曜日|曜)?\))?(?:\s+(\d{1,2}):(\d{2})\s*[~〜～]?)?\s*$/,
    );
    if (!m)
      throw new Error(
        `${index + 1}行目：日付と開始時刻を入力してください（例：9/11(金) 19:00〜）。`,
      );
    const date = `${m[1] ?? year}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    const time = m[4] ? `${m[4].padStart(2, '0')}:${m[5]}` : '';
    if (!dateValue(date) || (time && !timeValue(time)))
      throw new Error(`${index + 1}行目：存在する日付・時刻を入力してください。`);
    const key = `${date} ${time}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push({ date, time });
    }
  }
  if (!result.length || result.length > MAX_CANDIDATES) throw new Error(`候補は1〜${MAX_CANDIDATES}件で入力してください。`);
  return result;
}
/** Inclusive range, bounded before expansion; UTC avoids DST and month/year rollover errors. */
export function candidateRange(start: string, end: string, time: string): CandidateInput[] {
  if (!dateValue(start) || !dateValue(end) || start > end || (time && !timeValue(time)))
    throw new Error('範囲の開始日・終了日と時刻を確認してください。');
  const days = (Date.parse(end) - Date.parse(start)) / 86400000 + 1;
  if (days > MAX_CANDIDATES) throw new Error(`候補は${MAX_CANDIDATES}件以内にしてください。`);
  return Array.from({ length: days }, (_, i) => ({
    date: new Date(Date.parse(start) + i * 86400000).toISOString().slice(0, 10), time,
  }));
}
export function candidateLine(candidate: CandidateInput, year: number): string {
  const [y, m, d] = candidate.date.split('-').map(Number);
  const day = '日月火水木金土'[new Date(`${candidate.date}T00:00:00Z`).getUTCDay()];
  return `${y === year ? '' : `${y}/`}${m}/${d}(${day})${candidate.time ? ` ${candidate.time}〜` : ''}`;
}
