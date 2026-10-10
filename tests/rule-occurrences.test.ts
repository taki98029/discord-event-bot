// 繰り返し柔軟化 Phase 2（docs/dev/schedule-recurrence-redesign.md §5.2-5.3・migration 0023）:
// 開催回の由来 origin・ルール変更時の掃除（prune）・窓内全件実体化（pure）・一覧 next_occurrence_date・
// admin API（文法検証・anchor 検証・preview-plan・PUT の pruned/kept_posted・origin 受け入れ）。
import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { createSegment, addSegmentMember } from '../src/db/segments';
import { addMember } from '../src/db/members';
import { upsertResponse } from '../src/db/responses';
import { upsertGrouping } from '../src/db/groupings';
import { claimSend, finishSend } from '../src/db/sendLog';
import {
  createNotification,
  getNotification,
  listNotificationsByGuild,
  type NotificationInput,
} from '../src/db/notifications';
import {
  getOccurrence,
  getOrCreateOccurrence,
  listOccurrencesForNotification,
  pruneRuleOccurrences,
  setOccurrenceStatus,
} from '../src/db/occurrences';
import { maxWindowDays, ruleDatesToMaterialize } from '../src/cron/tick';
import { handleAdmin } from '../src/admin/index';
import type { Env } from '../src/env';
import type { Notification } from '../src/db/types';

const db = () => env.DB;
const TODAY = '2026/09/02'; // 水

function input(guildId: string, segmentId: number, over: Partial<NotificationInput> = {}): NotificationInput {
  return {
    guild_id: guildId,
    segment_id: segmentId,
    name: 'N',
    channel_id: 'c1',
    type: 'recurring',
    rrule: 'FREQ=WEEKLY;BYDAY=SA',
    anchor_date: null,
    start_time: '21:00',
    duration_minutes: null,
    recruit_days_before: 7,
    remind_start_days: 3,
    remind_undecided_days: 1,
    recruit_enabled: 1,
    remind_unanswered_enabled: 1,
    remind_undecided_enabled: 1,
    quota_enabled: 0,
    quota_interval_days: null,
    assignment_enabled: 0,
    grouping_enabled: 0,
    mention_mode: 'role',
    requires_response: 1,
    message_title: 'N',
    message_body: null,
    active: 1,
    response_deadline_hours: null,
    change_alert_channel_id: null,
    send_hour: 21,
    ...over,
  };
}

/** pure 関数用の Notification 行（DB 不要） */
function notif(over: Partial<Notification>): Notification {
  return {
    id: 1,
    uuid: '00000000-0000-0000-0000-000000000001',
    created_at: '',
    mention_enabled: 1,
    grouping_channel_id: null,
    remind_target: 'dm',
    remind_undecided_target: 'dm',
    share_answers: 1,
    ...input('g', 1),
    ...over,
  };
}

beforeEach(async () => {
  // apply-migrations.ts の共通クリアに含まれないグループ分けテーブルも空にする（prune の配置あり判定用）
  await db().batch([
    db().prepare('DELETE FROM group_members'),
    db().prepare('DELETE FROM groups'),
    db().prepare('DELETE FROM groupings'),
  ]);
});

describe('getOrCreateOccurrence - origin（migration 0023）', () => {
  it('既定は manual・指定すれば rule。既存行は由来を変えずにそのまま返す', async () => {
    const seg = await createSegment(db(), { guild_id: 'g1', name: 'S', mention_role_id: null });
    const n = await createNotification(db(), input('g1', seg.id));
    const manual = await getOrCreateOccurrence(db(), n.id, '2026/09/05', '21:00');
    expect(manual.origin).toBe('manual');
    const rule = await getOrCreateOccurrence(db(), n.id, '2026/09/12', '21:00', 'rule');
    expect(rule.origin).toBe('rule');
    expect((await getOccurrence(db(), rule.id))?.origin).toBe('rule');
    const again = await getOrCreateOccurrence(db(), n.id, '2026/09/05', '21:00', 'rule');
    expect(again.id).toBe(manual.id);
    expect(again.origin).toBe('manual');
  });
});

describe('pruneRuleOccurrences - ルール変更時の掃除（§5.3）', () => {
  async function setup() {
    const seg = await createSegment(db(), { guild_id: 'g1', name: 'S', mention_role_id: null });
    const n = await createNotification(db(), input('g1', seg.id));
    return { seg, n };
  }

  it('未投稿・回答なし・配置なしの rule 行だけ削除し、manual・墓石・過去は残す', async () => {
    const { n } = await setup();
    const clean = await getOrCreateOccurrence(db(), n.id, '2026/09/05', '21:00', 'rule');
    const manual = await getOrCreateOccurrence(db(), n.id, '2026/09/06', '21:00', 'manual');
    const tomb = await getOrCreateOccurrence(db(), n.id, '2026/09/12', '21:00', 'rule');
    await setOccurrenceStatus(db(), tomb.id, 'cancelled');
    const past = await getOrCreateOccurrence(db(), n.id, '2026/08/29', '21:00', 'rule');
    const today = await getOrCreateOccurrence(db(), n.id, TODAY, '21:00', 'rule'); // 今日は「未来」扱い（>=）

    expect(await pruneRuleOccurrences(db(), n.id, TODAY)).toEqual({ pruned: 2, kept_posted: 0 });
    expect(await getOccurrence(db(), clean.id)).toBeNull();
    expect(await getOccurrence(db(), today.id)).toBeNull();
    expect((await getOccurrence(db(), manual.id))?.status).toBe('scheduled');
    expect((await getOccurrence(db(), tomb.id))?.status).toBe('cancelled');
    expect(await getOccurrence(db(), past.id)).not.toBeNull();
  });

  it('投稿済み（send_log に sent/sending）・回答あり・配置ありの rule 行は保持し kept_posted に数える', async () => {
    const { seg, n } = await setup();
    const posted = await getOrCreateOccurrence(db(), n.id, '2026/09/05', '21:00', 'rule');
    const key = { notification_id: n.id, occurrence_id: posted.id, kind: 'recruit' as const, send_date: TODAY };
    await claimSend(db(), key);
    await finishSend(db(), key, true);

    const sending = await getOrCreateOccurrence(db(), n.id, '2026/09/12', '21:00', 'rule');
    await claimSend(db(), { notification_id: n.id, occurrence_id: sending.id, kind: 'deadline_notice', send_date: TODAY });

    const failedOnly = await getOrCreateOccurrence(db(), n.id, '2026/09/19', '21:00', 'rule');
    const fkey = { notification_id: n.id, occurrence_id: failedOnly.id, kind: 'recruit' as const, send_date: TODAY };
    await claimSend(db(), fkey);
    await finishSend(db(), fkey, false, 'x');

    const answered = await getOrCreateOccurrence(db(), n.id, '2026/09/26', '21:00', 'rule');
    await addMember(db(), 'u1', 'n1', 'D1');
    await addSegmentMember(db(), seg, 'u1');
    await upsertResponse(db(), answered.id, 'u1', 'n1', '参加');

    const grouped = await getOrCreateOccurrence(db(), n.id, '2026/10/03', '21:00', 'rule');
    await upsertGrouping(db(), grouped.id, 2);

    expect(await pruneRuleOccurrences(db(), n.id, TODAY)).toEqual({ pruned: 1, kept_posted: 4 });
    expect(await getOccurrence(db(), failedOnly.id)).toBeNull(); // failed だけは「何も起きていない」
    for (const o of [posted, sending, answered, grouped]) {
      expect((await getOccurrence(db(), o.id))?.status).toBe('scheduled');
    }
  });

  it('他の通知の行には触れない', async () => {
    const { seg, n } = await setup();
    const other = await createNotification(db(), input('g1', seg.id, { name: 'O' }));
    const mine = await getOrCreateOccurrence(db(), n.id, '2026/09/05', '21:00', 'rule');
    const theirs = await getOrCreateOccurrence(db(), other.id, '2026/09/05', '21:00', 'rule');
    expect(await pruneRuleOccurrences(db(), n.id, TODAY)).toEqual({ pruned: 1, kept_posted: 0 });
    expect(await getOccurrence(db(), mine.id)).toBeNull();
    expect(await getOccurrence(db(), theirs.id)).not.toBeNull();
  });
});

describe('ruleDatesToMaterialize / maxWindowDays - 送信窓内の全ルール回（pure）', () => {
  const now = new Date(2026, 8, 2, 10, 0); // 水 10:00

  it('maxWindowDays は募集・リマインド窓の最遠日（回答不要は募集窓のみ）', () => {
    expect(maxWindowDays(notif({ recruit_days_before: 7, remind_start_days: 3, remind_undecided_days: 1 }))).toBe(7);
    expect(maxWindowDays(notif({ recruit_days_before: 1, remind_start_days: 3, remind_undecided_days: 10 }))).toBe(10);
    expect(maxWindowDays(notif({ recruit_days_before: 1, remind_start_days: 3, requires_response: 0 }))).toBe(1);
  });

  it('maxWindowDays: OFF の工程は数えない（ADR 0026）。募集 OFF＋締切は締切時刻から逆算', () => {
    expect(maxWindowDays(notif({ recruit_enabled: 0, remind_start_days: 3, remind_undecided_days: 1 }))).toBe(3);
    expect(maxWindowDays(notif({ recruit_enabled: 0, remind_unanswered_enabled: 0, remind_undecided_enabled: 0 }))).toBe(0);
    // 締切は募集窓に含まれるため加算しない（締切あり ⇒ 定期 ⇒ 募集自動の不変条件・migration 0025）
    expect(maxWindowDays(notif({ recruit_days_before: 7, response_deadline_hours: 240 }))).toBe(7);
  });

  it('募集 OFF・リマインド 3 日前: 実体化は窓（3 日）内だけ', () => {
    const n = notif({ rrule: 'FREQ=DAILY', recruit_enabled: 0, remind_start_days: 3, remind_undecided_days: 1 });
    expect(ruleDatesToMaterialize(n, [], now)).toEqual(['2026/09/02', '2026/09/03', '2026/09/04', '2026/09/05']);
  });

  it('毎週土曜・募集 7 日前: 窓内の 1 件だけ（次の次は窓外）', () => {
    expect(ruleDatesToMaterialize(notif({}), [], now)).toEqual(['2026/09/05']);
  });

  it('毎日・募集 1 日前・リマインド 3 日前: 窓内の全日付（既存日付はスキップ＝墓石も同じ）', () => {
    const n = notif({ rrule: 'FREQ=DAILY', recruit_days_before: 1, remind_start_days: 3 });
    expect(ruleDatesToMaterialize(n, [], now)).toEqual(['2026/09/02', '2026/09/03', '2026/09/04', '2026/09/05']);
    expect(ruleDatesToMaterialize(n, ['2026/09/03'], now)).toEqual(['2026/09/02', '2026/09/04', '2026/09/05']);
  });

  it('回答不要（告知）は募集窓だけ', () => {
    const n = notif({ rrule: 'FREQ=DAILY', recruit_days_before: 1, remind_start_days: 3, requires_response: 0 });
    expect(ruleDatesToMaterialize(n, [], now)).toEqual(['2026/09/02', '2026/09/03']);
  });

  it('未定リマインドが最遠なら、その日ちょうどの回も拾う（inSendWindow と同じ判定）', () => {
    const n = notif({ recruit_days_before: 7, remind_start_days: 3, remind_undecided_days: 10 });
    expect(ruleDatesToMaterialize(n, [], now)).toEqual(['2026/09/05', '2026/09/12']);
  });

  it('不定期（rrule 無し）は何も実体化しない', () => {
    expect(ruleDatesToMaterialize(notif({ rrule: null }), [], now)).toEqual([]);
  });
});

describe('listNotificationsByGuild - next_occurrence_date', () => {
  it('今日以降の scheduled の最小日付。中止・過去は除外・無ければ null', async () => {
    const seg = await createSegment(db(), { guild_id: 'gL', name: 'S', mention_role_id: null });
    const n = await createNotification(db(), input('gL', seg.id, { rrule: null }));
    const empty = await createNotification(db(), input('gL', seg.id, { rrule: null, name: 'E' }));
    await getOrCreateOccurrence(db(), n.id, '2026/09/10', '21:00');
    await getOrCreateOccurrence(db(), n.id, '2026/09/20', '21:00');
    const tomb = await getOrCreateOccurrence(db(), n.id, '2026/09/05', '21:00');
    await setOccurrenceStatus(db(), tomb.id, 'cancelled');
    await getOrCreateOccurrence(db(), n.id, '2026/08/20', '21:00');
    const rows = await listNotificationsByGuild(db(), 'gL', TODAY);
    expect(rows.find((r) => r.id === n.id)?.next_occurrence_date).toBe('2026/09/10');
    expect(rows.find((r) => r.id === empty.id)?.next_occurrence_date).toBeNull();
  });
});

describe('admin API - 繰り返しの検証・preview-plan・PUT の掃除・origin', () => {
  const adminEnv = () => ({ DB: db(), ADMIN_TOKEN: 't', DISCORD_BOT_TOKEN: 'b' }) as unknown as Env;
  const call = (method: string, path: string, body?: unknown) =>
    handleAdmin(
      new Request(`https://x.dev/api/admin${path}`, {
        method,
        headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      adminEnv(),
    );
  async function segmentUuid(guild = 'gA') {
    return (await createSegment(db(), { guild_id: guild, name: 'S', mention_role_id: null })).uuid;
  }
  const body = (segment_uuid: string, over: Record<string, unknown> = {}) => ({
    guild_id: 'gA',
    segment_uuid,
    name: 'N',
    channel_id: 'c1',
    message_title: 'T',
    rrule: 'FREQ=WEEKLY;BYDAY=SA',
    start_time: '21:00',
    ...over,
  });

  it('POST: 文法外の rrule は 400・受理した rrule は正規化して保存・間隔 1 の anchor は捨てる', async () => {
    const su = await segmentUuid();
    const bad = await call('POST', '/notifications', body(su, { rrule: 'FREQ=WEEKLY;BYDAY=SA;COUNT=3' }));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toContain('読み取れません');

    const ok = await call('POST', '/notifications', body(su, { rrule: 'freq=weekly;byday=sa', anchor_date: '2026/09/05' }));
    expect(ok.status).toBe(201);
    const created = (await ok.json()) as Notification;
    expect(created.rrule).toBe('FREQ=WEEKLY;BYDAY=SA');
    expect(created.anchor_date).toBeNull();
  });

  it('POST/PUT: 工程スイッチは省略時 1・false/0 で 0 になり、日数はそのまま保持される（ADR 0026・手動投稿は不定期のみ）', async () => {
    const su = await segmentUuid();
    const created = (await (await call('POST', '/notifications', body(su))).json()) as Notification;
    expect([created.recruit_enabled, created.remind_unanswered_enabled, created.remind_undecided_enabled]).toEqual([1, 1, 1]);

    // 定期のままリマインドの ON/OFF を往復（日数は OFF でも保持）
    const res = await call(
      'PUT',
      `/notifications/${created.uuid}`,
      body(su, { remind_unanswered_enabled: 0, remind_undecided_enabled: true, remind_start_days: 5 }),
    );
    expect(res.status).toBe(200);
    const got = await getNotification(db(), created.id);
    expect([got?.recruit_enabled, got?.remind_unanswered_enabled, got?.remind_undecided_enabled]).toEqual([1, 0, 1]);
    expect(got?.remind_start_days).toBe(5); // OFF でも日数は保持（ON に戻せば復帰）

    // 不定期は雛形の締切だけ正規化（NULL・締切は開催回ごと・ADR 0032）。②③は保持・募集の手動化は可
    const irregular = (await (await call('POST', '/notifications', body(su, { rrule: null }))).json()) as Notification;
    const res2 = await call(
      'PUT',
      `/notifications/${irregular.uuid}`,
      body(su, { rrule: null, recruit_enabled: false, remind_unanswered_enabled: 1, remind_undecided_enabled: 1, response_deadline_hours: 24 }),
    );
    expect(res2.status).toBe(200);
    const got2 = await getNotification(db(), irregular.id);
    expect([got2?.recruit_enabled, got2?.remind_unanswered_enabled, got2?.remind_undecided_enabled]).toEqual([0, 1, 1]);
    expect(got2?.response_deadline_hours).toBeNull();
  });

  it('定期の保存時検証（flow-settings-spec §3-4）: ①手動は 400・順序ルール違反は 400・不定期は警告のみで受理', async () => {
    const su = await segmentUuid();
    // 定期 × 手動投稿は不可
    const manual = await call('POST', '/notifications', body(su, { recruit_enabled: false }));
    expect(manual.status).toBe(400);
    expect(((await manual.json()) as { error: string }).error).toContain('手動にできません');

    // E1: 未回答の開始が募集より前
    const e1 = await call('POST', '/notifications', body(su, { recruit_days_before: 3, remind_start_days: 5 }));
    expect(e1.status).toBe(400);
    expect(((await e1.json()) as { error: string }).error).toContain('募集（3日前 21:00）より前から催促');

    // E5: 未定リマインドが締切より後
    const e5 = await call('POST', '/notifications', body(su, { recruit_days_before: 7, remind_undecided_days: 1, response_deadline_hours: 48 }));
    expect(e5.status).toBe(400);
    expect(((await e5.json()) as { error: string }).error).toContain('締切（開始48時間前）より後');

    // 不定期×自動募集: ②③は解禁されたので E1（②が①より前）は 400（ADR 0032）。雛形の締切は正規化で NULL
    const ng = await call('POST', '/notifications', body(su, { rrule: null, recruit_days_before: 3, remind_start_days: 5, response_deadline_hours: 48 }));
    expect(ng.status).toBe(400);
    // 不定期×手動募集: ①が無いので E1/E2 は判定対象外＝受理。②③は保持・締切は NULL
    const ok = await call(
      'POST',
      '/notifications',
      body(su, { rrule: null, recruit_enabled: false, recruit_days_before: 3, remind_start_days: 5, response_deadline_hours: 48 }),
    );
    expect(ok.status).toBe(201);
    const okBody = (await ok.json()) as Notification;
    expect([okBody.remind_unanswered_enabled, okBody.remind_undecided_enabled, okBody.response_deadline_hours]).toEqual([1, 1, null]);

    // 正しい順序の定期は受理（募集7 → 未回答3 → 未定3 → 締切48h → 開催）
    const ok2 = await call(
      'POST',
      '/notifications',
      body(su, { recruit_days_before: 7, remind_start_days: 3, remind_undecided_days: 3, response_deadline_hours: 48 }),
    );
    expect(ok2.status).toBe(201);
  });

  it('POST: rrule 無しは不定期として作成できる（旧 400 を撤廃）', async () => {
    const su = await segmentUuid();
    const res = await call('POST', '/notifications', body(su, { rrule: '' }));
    expect(res.status).toBe(201);
    const created = (await res.json()) as Notification;
    expect(created.rrule).toBeNull();
    expect(created.type).toBe('recurring');
    const plan = await call('GET', `/notifications/${created.uuid}/plan`);
    expect(await plan.json()).toEqual([]);
  });

  it('POST: 間隔 ≥ 2 の anchor はルールの開催日でなければ 400', async () => {
    const su = await segmentUuid();
    const bad = await call('POST', '/notifications', body(su, { rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=SA', anchor_date: '2026/09/06' }));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toContain('次回の開催日');
    const ok = await call('POST', '/notifications', body(su, { rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=SA', anchor_date: '2026/09/05' }));
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as Notification).anchor_date).toBe('2026/09/05');
  });

  it('preview-plan: 文法外は error・毎日は連日・間隔 ≥ 2 は anchor 候補を返す・anchor 不一致は error', async () => {
    const bad = (await (await call('POST', '/notifications/preview-plan', { rrule: 'FREQ=MONTHLY' })).json()) as {
      dates: string[];
      anchor_candidates: string[];
      error?: string;
    };
    expect(bad.error).toContain('読み取れません');
    expect(bad.dates).toEqual([]);

    const daily = (await (await call('POST', '/notifications/preview-plan', { rrule: 'FREQ=DAILY', start_time: '21:00', count: 3 })).json()) as { dates: string[]; anchor_candidates: string[] };
    expect(daily.dates).toHaveLength(3);
    expect(daily.anchor_candidates).toEqual([]);

    const bi = (await (await call('POST', '/notifications/preview-plan', { rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=SA,SU', start_time: '21:00' })).json()) as { dates: string[]; anchor_candidates: string[]; error?: string };
    expect(bi.error).toBeUndefined();
    expect(bi.anchor_candidates).toHaveLength(4); // interval 2 × 曜日 2
    expect(bi.anchor_candidates.every((d) => /^\d{4}\/\d{2}\/\d{2}$/.test(d))).toBe(true);
    expect(bi.dates.length).toBeGreaterThan(0);

    // anchor を候補の 2 番目（日曜）にすると、その前の土曜は出ない（次回の開催日を文字どおり守る）
    const sun = bi.anchor_candidates[1];
    const withAnchor = (await (await call('POST', '/notifications/preview-plan', { rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=SA,SU', start_time: '21:00', anchor_date: sun })).json()) as { dates: string[] };
    expect(withAnchor.dates[0]).toBe(sun);

    const mismatch = (await (await call('POST', '/notifications/preview-plan', { rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=SA', start_time: '21:00', anchor_date: '2026/09/06' })).json()) as { error?: string };
    expect(mismatch.error).toContain('次回の開催日');
  });

  it('PUT: ルールが変わったら未投稿の rule 行を掃除して {pruned, kept_posted}・変わらなければ 0', async () => {
    const su = await segmentUuid();
    const created = (await (await call('POST', '/notifications', body(su))).json()) as Notification;
    const ruleRow = await getOrCreateOccurrence(db(), created.id, '2099/01/03', '21:00', 'rule');
    const manualRow = await getOrCreateOccurrence(db(), created.id, '2099/01/04', '21:00', 'manual');

    const same = await call('PUT', `/notifications/${created.uuid}`, body(su, { name: 'renamed' }));
    expect(await same.json()).toEqual({ ok: true, pruned: 0, kept_posted: 0 });
    expect(await getOccurrence(db(), ruleRow.id)).not.toBeNull();

    const changed = await call('PUT', `/notifications/${created.uuid}`, body(su, { rrule: 'FREQ=WEEKLY;BYDAY=SU' }));
    expect(await changed.json()).toEqual({ ok: true, pruned: 1, kept_posted: 0 });
    expect(await getOccurrence(db(), ruleRow.id)).toBeNull();
    expect(await getOccurrence(db(), manualRow.id)).not.toBeNull();
    expect((await getNotification(db(), created.id))?.rrule).toBe('FREQ=WEEKLY;BYDAY=SU');

    // start_time の変更もルール変更（未投稿 rule 行は作り直し）
    const r2 = await getOrCreateOccurrence(db(), created.id, '2099/01/10', '21:00', 'rule');
    const t = await call('PUT', `/notifications/${created.uuid}`, body(su, { rrule: 'FREQ=WEEKLY;BYDAY=SU', start_time: '20:00' }));
    expect(await t.json()).toEqual({ ok: true, pruned: 1, kept_posted: 0 });
    expect(await getOccurrence(db(), r2.id)).toBeNull();

    // 定期 → 不定期の切替は 400（種別は作成時に固定・P2-04）。開催回にも触れない
    const r3 = await getOrCreateOccurrence(db(), created.id, '2099/01/17', '20:00', 'rule');
    const irregular = await call('PUT', `/notifications/${created.uuid}`, body(su, { rrule: '', start_time: '20:00' }));
    expect(irregular.status).toBe(400);
    expect(await getOccurrence(db(), r3.id)).not.toBeNull();
    expect((await getNotification(db(), created.id))?.rrule).toBe('FREQ=WEEKLY;BYDAY=SU');
  });

  it('POST /notifications/:id/occurrences は origin を受け付ける（既定 manual）', async () => {
    const su = await segmentUuid();
    const created = (await (await call('POST', '/notifications', body(su))).json()) as Notification;
    const a = (await (await call('POST', `/notifications/${created.uuid}/occurrences`, { date: '2099/02/07' })).json()) as { id: number };
    const b = (await (await call('POST', `/notifications/${created.uuid}/occurrences`, { date: '2099/02/14', origin: 'rule' })).json()) as { id: number };
    const c = (await (await call('POST', `/notifications/${created.uuid}/occurrences`, { date: '2099/02/21', origin: 'bogus' })).json()) as { id: number };
    expect((await getOccurrence(db(), a.id))?.origin).toBe('manual');
    expect((await getOccurrence(db(), b.id))?.origin).toBe('rule');
    expect((await getOccurrence(db(), c.id))?.origin).toBe('manual');
    expect((await listOccurrencesForNotification(db(), created.id)).map((o) => o.origin).sort()).toEqual(['manual', 'manual', 'rule']);
  });
});

describe('createNotification / updateNotification - 列の往復（INSERT/UPDATE の列順ガード）', () => {
  it('duration_minutes・anchor_date・rrule を保存・更新・null 化できる', async () => {
    const seg = await createSegment(db(), { guild_id: 'gd', name: 'S', mention_role_id: null });
    const { updateNotification } = await import('../src/db/notifications');
    const n = await createNotification(
      db(),
      input('gd', seg.id, { duration_minutes: 120, rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=SA', anchor_date: '2026/09/05' }),
    );
    let got = await getNotification(db(), n.id);
    expect([got?.duration_minutes, got?.rrule, got?.anchor_date]).toEqual([120, 'FREQ=WEEKLY;INTERVAL=2;BYDAY=SA', '2026/09/05']);

    await updateNotification(db(), n.id, input('gd', seg.id, { duration_minutes: 90, rrule: null, anchor_date: null }));
    got = await getNotification(db(), n.id);
    expect([got?.duration_minutes, got?.rrule, got?.anchor_date]).toEqual([90, null, null]);

    await updateNotification(db(), n.id, input('gd', seg.id, { duration_minutes: null }));
    expect((await getNotification(db(), n.id))?.duration_minutes).toBeNull();
  });
});
