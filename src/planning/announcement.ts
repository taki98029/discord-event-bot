import { planningGroups, requireValue, type PlanData, type Slot } from './model';

export const DEFAULT_ANNOUNCEMENT_TEMPLATE = 'お疲れ様です。\n\n{{計画名}}\n{{日時}}\n\n{{名簿}}\n\n欠席・変更は運営担当者へ個別に連絡してください。';
// 集合・連絡事項 were retired with the roster screen (2026-09-23); a template not yet re-saved may still hold them, so they stay valid and render empty.
const tokens = ['計画名', '日時', '名簿', '集合', '連絡事項'];
/** Drops the retired {{集合}}/{{連絡事項}} from a saved template (with their now-empty lines), for the editor and on save. */
export function withoutRetiredTokens(template: string): string {
  return template
    .replace(/{{(集合|連絡事項)}}/g, '')
    .replace(/^[ \t　]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
export function validateAnnouncementTemplate(template: string) {
  requireValue(template.length <= 3000, '開催案内の定型文は3000文字以内にしてください');
  for (const token of template.matchAll(/{{(.*?)}}/g))
    requireValue(tokens.includes(token[1]), `差し込み項目「${token[1]}」は使えません`);
  requireValue(!template || template.includes('{{名簿}}'), '開催案内の定型文に {{名簿}} を含めてください');
}
/** Shared by the admin preview and delivery; templates are plain text, never executable. */
export function announcementText(data: PlanData, slot: Slot): string {
  const candidate = data.candidates.find((c) => c.id === slot.candidate);
  const members = slot.members.filter((m) => m.status !== '除外');
  const roster = planningGroups(data).map((id) => {
    const group = members.filter((m) => m.schedule === id);
    return group.length ? `【${data.scheduleNames?.[id] ?? `区分 ${id}`}】\n` + group.map((m) =>
      `<@${m.user}>${m.duty ? ` / ${m.duty}` : ''}${m.status === '参加' ? '' : `（${m.status}）`}`,
    ).join('\n') : '';
  }).filter(Boolean).join('\n\n');
  const values: Record<string, string> = {
    計画名: data.name,
    日時: candidate ? `${candidate.date} ${candidate.time || '時刻未定'}` : '日時未定',
    名簿: roster,
    集合: '',
    連絡事項: '',
  };
  return (data.announcementTemplate || DEFAULT_ANNOUNCEMENT_TEMPLATE)
    .replace(/{{(.*?)}}/g, (match, key) => values[key] ?? match)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
