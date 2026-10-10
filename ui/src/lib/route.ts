// ハッシュルータ（ADR 0016 準拠）。URL 形式: #g/<guildId>/<resource>/<uuid?>/<sub?>
// 旧 vanilla 実装の parseHash()/handleHashRoute() の want 判定を純関数として移植。
export type PlanningView = 'prepare' | 'details' | 'answers' | 'history';
export type ScheduleKind = 'regular' | 'irregular' | 'oneoff';
export type Section = ScheduleKind | 'planning' | 'oneoff-planning' | 'segments' | 'records' | 'reports' | 'sendlog' | 'setup' | 'bot-settings' | 'channels';
export const SCHEDULE_LABELS: Record<ScheduleKind, string> = { regular: '定期出欠確認', irregular: '不定期出欠確認', oneoff: '単発出欠確認' };
/** 臨時回も親スケジュールの種別に含める。開催回の origin では分類しない。単発＝type 'oneoff'（テンプレートと開催回 1 件を同時に作る・2026-10-02） */
export const scheduleKind = (n: { rrule?: string | null; type?: string }): ScheduleKind =>
  n.type === 'oneoff' ? 'oneoff' : n.rrule ? 'regular' : 'irregular';

export type Route = (
  | { kind: 'setup' | 'bot-settings' | 'channels' }
  | { kind: 'planning-settings' }
  | { kind: 'planning'; planId?: string; view?: PlanningView; oneOff?: boolean } // oneOff = 単発日程調整（#…/oneoff-planning/…・2026-10-02）
  | { kind: 'list'; section?: 'segments' | 'records' | 'reports' | 'sendlog' }
  | { kind: 'notification-list' }
  | { kind: 'notif-new'; irregular?: boolean; oneOff?: boolean; copy?: string } // copy = この行を初期値にした新規作成（複製・2026-09-20）
  | { kind: 'notif-edit'; nuuid: string }
  | { kind: 'grouping-settings'; nuuid: string }
  | { kind: 'grouping'; nuuid: string; ouuid: string }
  | { kind: 'seg-members'; suuid: string }
) & { scope?: ScheduleKind };

export function parseHash(hash: string): { guildId: string | null; rest: string[] } {
  const raw = hash.replace(/^#/, '');
  const parts = raw.split('/').filter(Boolean);
  if (parts.length >= 2 && parts[0] === 'g') return { guildId: parts[1], rest: parts.slice(2) };
  return { guildId: null, rest: [] };
}

export function routeFromRest(rest: string[]): Route {
  if (rest[0] === 'regular' || rest[0] === 'irregular' || rest[0] === 'oneoff') {
    const scope = rest[0];
    const route = routeFromRest(rest.slice(1));
    return { ...route, scope, ...(route.kind === 'notif-new' ? { irregular: scope !== 'regular', oneOff: scope === 'oneoff' } : {}) };
  }
  if (rest[0] === 'setup' || rest[0] === 'bot-settings' || rest[0] === 'channels') return { kind: rest[0] };
  if (rest[0] === 'planning-settings') return { kind: 'planning-settings' };
  if (rest[0] === 'planning' || rest[0] === 'oneoff-planning') {
    const view = rest[2];
    return {
      kind: 'planning',
      ...(rest[0] === 'oneoff-planning' ? { oneOff: true } : {}),
      planId: rest[1],
      view: ['prepare', 'details', 'answers', 'history'].includes(view)
        ? (view as PlanningView)
        : undefined,
    };
  }
  if (rest.length === 0) return { kind: 'list' };
  if (rest[0] === 'settings') return { kind: 'notification-list' };
  if (rest[0] === 'notifications') {
    // new2/edit2 は旧「新デザイン（V2）」時代のパス。V1 撤去（2026-08-23）後は同じフォームへ
    // new/irregular = 不定期の新規作成（種別は作成時に固定・ADR 0025）
    if (rest[1] === 'new' || rest[1] === 'new2')
      return { kind: 'notif-new', irregular: rest[2] === 'irregular' };
    if (rest[2] === 'edit' || rest[2] === 'edit2') return { kind: 'notif-edit', nuuid: rest[1] };
    if (rest[2] === 'copy') return { kind: 'notif-new', copy: rest[1] };
    if (rest[2] === 'grouping-settings') return { kind: 'grouping-settings', nuuid: rest[1] };
    if (rest[2] === 'occurrences' && rest[4] === 'grouping') {
      return { kind: 'grouping', nuuid: rest[1], ouuid: rest[3] };
    }
    return { kind: 'notification-list' };
  }
  if (rest[0] === 'segments' && rest[2] === 'members') return { kind: 'seg-members', suuid: rest[1] };
  if (rest[0] === 'segments' || rest[0] === 'records' || rest[0] === 'reports' || rest[0] === 'sendlog')
    return { kind: 'list', section: rest[0] };
  return { kind: 'list' };
}

/** 設定・編集・配置の子ページでも、開いた運用メニューを選択したままにする。 */
export function sectionForRoute(route: Route): Section {
  if (route.kind === 'setup' || route.kind === 'bot-settings' || route.kind === 'channels') return route.kind;
  if (route.kind === 'planning') return route.oneOff ? 'oneoff-planning' : 'planning';
  if (route.kind === 'planning-settings') return 'planning';
  if (route.kind === 'seg-members') return 'segments';
  if (route.kind === 'list' && route.section) return route.section;
  return route.scope ?? (route.kind === 'notif-new' && route.irregular ? 'irregular' : 'regular');
}
