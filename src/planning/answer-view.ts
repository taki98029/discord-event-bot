import type { Candidate, Plan } from './model';
export const PLANNING_FLAGS = 64 | 32768;
export interface PlanningResponse {
  type: number;
  data: { flags: number; components: any[]; allowed_mentions: { parse: string[] } };
}
export function planningCandidates(p: Plan): Candidate[] {
  return p.data.candidates
    .filter((c) => c.active)
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
}
export function planningClosed(p: Plan): boolean {
  return p.data.state !== 'open' || !(Date.now() < Date.parse(p.data.deadline));
}
function currentYear() {
  return new Date(Date.now() + 9 * 3600000).getUTCFullYear();
}
export function planningDate(c: Pick<Candidate, 'date' | 'time'>, compact = false): string {
  const d = new Date(`${c.date}T00:00:00Z`);
  return `${d.getUTCFullYear() === currentYear() ? '' : d.getUTCFullYear() + '/'}${d.getUTCMonth() + 1}/${d.getUTCDate()}${compact ? '' : '(' + '日月火水木金土'[d.getUTCDay()] + ')'}${c.time ? ' ' + c.time : compact ? ' 時刻なし' : '（時刻指定なし）'}`;
}
export function planningDeadline(value: string): string {
  const d = new Date(Date.parse(value) + 9 * 3600000);
  if (!Number.isFinite(d.getTime())) return '未設定';
  return `${planningDate({ date: d.toISOString().slice(0, 10), time: d.toISOString().slice(11, 16) })}（日本時間）`;
}
export function planningError(message: string, id?: string): PlanningResponse {
  return {
    type: 4,
    data: {
      flags: PLANNING_FLAGS,
      allowed_mentions: { parse: [] },
      components: [
        { type: 10, content: message },
        ...(id
          ? [
              {
                type: 1,
                components: [
                  { type: 2, style: 2, custom_id: `plan:open:${id}:0`, label: '回答リンクを再発行' },
                ],
              },
            ]
          : []),
      ],
    },
  };
}
