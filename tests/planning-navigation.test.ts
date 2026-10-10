import { expect, it } from 'vitest';
import { parseHash, routeFromRest, sectionForRoute, scheduleKind } from '../ui/src/lib/route';

it('keeps the selected planning task in deep links and accepts existing plan links', () => {
  for (const view of ['prepare', 'details', 'answers', 'history']) {
    const parsed = parseHash(`#g/guild-123/planning/plan-123/${view}`);
    expect(parsed.guildId).toBe('guild-123');
    const route = routeFromRest(parsed.rest);
    expect(route).toEqual({ kind: 'planning', planId: 'plan-123', view });
    expect(sectionForRoute(route)).toBe('planning');
  }
  expect(routeFromRest(['planning', 'plan-123'])).toEqual({
    kind: 'planning', planId: 'plan-123', view: undefined,
  });
  expect(routeFromRest(['planning', 'plan-123', 'unknown'])).toEqual({
    kind: 'planning', planId: 'plan-123', view: undefined,
  });
  expect(routeFromRest(['planning'])).toEqual({ kind: 'planning', planId: undefined, view: undefined });
  // 単発日程調整は別メニュー（同じ画面を oneOff で開く）
  const oneOff = routeFromRest(['oneoff-planning', 'plan-123', 'details']);
  expect(oneOff).toEqual({ kind: 'planning', oneOff: true, planId: 'plan-123', view: 'details' });
  expect(sectionForRoute(oneOff)).toBe('oneoff-planning');
});

it('keeps each schedule entry selected through settings, creation, editing and grouping deep links', () => {
  for (const scope of ['regular', 'irregular', 'oneoff']) {
    for (const path of ['', '/settings', '/notifications/new', '/notifications/n1/edit', '/notifications/n1/grouping-settings', '/notifications/n1/occurrences/o1/grouping']) {
      const route = routeFromRest(parseHash(`#g/g1/${scope}${path}`).rest);
      expect(route.scope).toBe(scope);
      expect(sectionForRoute(route)).toBe(scope);
    }
    expect(routeFromRest([scope, 'settings']).kind).toBe('notification-list');
    expect(routeFromRest([scope, 'notifications', 'new'])).toEqual({ kind: 'notif-new', scope, irregular: scope !== 'regular', oneOff: scope === 'oneoff' });
  }
  expect(routeFromRest(['notifications', 'n1', 'edit'])).toEqual({ kind: 'notif-edit', nuuid: 'n1' });
  expect(sectionForRoute(routeFromRest(['notifications', 'new', 'irregular']))).toBe('irregular');
  expect(sectionForRoute(routeFromRest(['planning-settings']))).toBe('planning');
  for (const section of ['segments', 'records', 'reports', 'sendlog']) expect(sectionForRoute(routeFromRest([section]))).toBe(section);
});

it('classifies manual extra occurrences by their parent schedule, including announcement-only schedules', () => {
  const rows = [
    { rrule: 'FREQ=WEEKLY;BYDAY=SA', origin: 'rule', requires_response: 1 },
    { rrule: 'FREQ=WEEKLY;BYDAY=SA', origin: 'manual', requires_response: 1 },
    { rrule: null, origin: 'manual', requires_response: 1 },
    { rrule: null, origin: 'manual', requires_response: 0 },
    { rrule: 'FREQ=MONTHLY;BYMONTHDAY=1', origin: 'rule', requires_response: 0 },
  ];
  expect(rows.filter(n => scheduleKind(n) === 'regular')).toEqual([rows[0], rows[1], rows[4]]);
  expect(rows.filter(n => scheduleKind(n) === 'irregular')).toEqual([rows[2], rows[3]]);
  // 単発は type で分ける（rrule は不定期と同じ NULL）
  expect(scheduleKind({ rrule: null, type: 'oneoff' })).toBe('oneoff');
});
