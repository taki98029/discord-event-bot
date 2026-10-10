import type { PlanData } from '../../../src/planning/model';

/** Download only the admin's loaded snapshot. Quote every cell and neutralize spreadsheet formulas. */
export function planningCsv(data: PlanData): string {
  const candidates = data.candidates.filter((c) => c.active)
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  const rows = [
    ['名前', '区分', ...candidates.map((c) => `${c.date} ${c.time || '時刻未定'}`), '補足'],
    ...data.people.filter((p) => p.active !== false).map((p) => [
      p.name,
      p.schedules.map((id) => data.scheduleNames?.[id] ?? String(id)).join(' / '),
      ...candidates.map((c) => data.answers[p.id]?.values[c.id] ?? '未回答'),
      data.answers[p.id]?.comment ?? '',
    ]),
  ];
  return '\uFEFF' + rows.map((row) => row.map((cell) => {
    const safe = /^[\s\u0000-\u001f]*[=+@\-]/.test(cell) || /^[\t\r\n]/.test(cell) ? "'" + cell : cell;
    return '"' + safe.replace(/"/g, '""') + '"';
  }).join(',')).join('\r\n') + '\r\n';
}
