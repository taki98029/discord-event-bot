import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createSegment, addSegmentMember, setSegmentMemberStatus } from '../src/db/segments';
import { addMember } from '../src/db/members';
import {
  upsertResponse,
  getResponseStatus,
  remainingUnansweredTargets,
  remainingUndecidedTargets,
  listRecentResponses,
} from '../src/db/responses';
import { getOrCreateOccurrence } from '../src/db/occurrences';
import { createNotification, getNotification, type NotificationInput } from '../src/db/notifications';
import { claimSend, finishSend, isSendLogged, listSendLog, clearStaleClaims } from '../src/db/sendLog';
import { getSendBudget, setConfig, getConfigInt } from '../src/db/config';
import { responseDeadline } from '../src/lib/date';

const db = () => env.DB;
const TODAY = '2026/07/05';

function notifInput(over: Partial<NotificationInput> = {}): NotificationInput {
  return {
    guild_id: 'g1',
    segment_id: 1,
    name: 'N',
    channel_id: 'c1',
    type: 'recurring',
    rrule: 'FREQ=WEEKLY;BYDAY=SA',
    one_off_date: null,
    anchor_date: null,
    start_time: '21:00',
    duration_minutes: null,
    recruit_days_before: 7,
    remind_start_days: 3,
    remind_undecided_days: 1,
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

/** seg＋members A/B/C/D ＋ notification ＋ occurrence を用意する共通フィクスチャ。 */
async function fixture() {
  const seg = await createSegment(db(), { guild_id: 'g1', name: 'S', mention_role_id: null });
  for (const u of ['A', 'B', 'C', 'D']) {
    await addMember(db(), u, u, u);
    await addSegmentMember(db(), seg.id, u);
  }
  const n = await createNotification(db(), notifInput({ segment_id: seg.id }));
  const occ = await getOrCreateOccurrence(db(), n.id, TODAY, '21:00');
  return { seg, n, occ };
}

describe('responseDeadline（回答締切の時刻・ADR 0014）', () => {
  it('開始の N 時間前を返す（同日内）', () => {
    const dl = responseDeadline('2026/07/05', '21:00', 3)!;
    expect(dl.getFullYear()).toBe(2026);
    expect(dl.getMonth()).toBe(6); // 0-based = 7月
    expect(dl.getDate()).toBe(5);
    expect(dl.getHours()).toBe(18);
  });
  it('日付を跨ぐ場合は前日になる', () => {
    const dl = responseDeadline('2026/07/05', '01:00', 3)!;
    expect(dl.getDate()).toBe(4);
    expect(dl.getHours()).toBe(22);
  });
  it('hoursBefore=null は null（締切なし）', () => {
    expect(responseDeadline('2026/07/05', '21:00', null)).toBeNull();
  });
});

describe('send_log の冪等（claim/finish・ADR 0013）', () => {
  it('同一キーの claim は 1 回目 true・2 回目 false（二重送信防止）', async () => {
    const { n, occ } = await fixture();
    const key = { notification_id: n.id, occurrence_id: occ.id, user_id: 'A', kind: 'remind_unanswered' as const, send_date: TODAY };
    expect(await claimSend(db(), key)).toBe(true);
    expect(await claimSend(db(), key)).toBe(false);
    await finishSend(db(), key, true);
    expect(await isSendLogged(db(), key)).toBe(true);
    const rows = await listSendLog(db(), {});
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('sent');
    expect(rows[0].notification_name).toBe('N');
  });

  it('チャンネル投稿（user_id 既定 ""）と開催回なし（occurrence_id 既定 0）も冪等', async () => {
    const { n, occ } = await fixture();
    const recruitKey = { notification_id: n.id, occurrence_id: occ.id, kind: 'recruit' as const, send_date: TODAY };
    expect(await claimSend(db(), recruitKey)).toBe(true);
    expect(await claimSend(db(), recruitKey)).toBe(false);
    const quotaKey = { notification_id: n.id, user_id: 'A', kind: 'quota' as const, send_date: TODAY };
    expect(await claimSend(db(), quotaKey)).toBe(true);
    expect(await claimSend(db(), quotaKey)).toBe(false);
  });
});

describe('未送信ターゲットの取得（ペース配信・ADR 0013）', () => {
  it('未回答リマインドは「アクティブ − 既回答 − 送信済み」を返す', async () => {
    const { seg, n, occ } = await fixture();
    await upsertResponse(db(), occ.id, 'A', 'A', '参加'); // 既回答
    await upsertResponse(db(), occ.id, 'B', 'B', '未定'); // 既回答
    // C, D は未回答
    let targets = await remainingUnansweredTargets(db(), seg.id, occ.id, n.id, TODAY, 10);
    expect(targets.map((m) => m.user_id).sort()).toEqual(['C', 'D']);

    // C に送信済みを記録 → C は除外される
    await claimSend(db(), { notification_id: n.id, occurrence_id: occ.id, user_id: 'C', kind: 'remind_unanswered', send_date: TODAY });
    targets = await remainingUnansweredTargets(db(), seg.id, occ.id, n.id, TODAY, 10);
    expect(targets.map((m) => m.user_id)).toEqual(['D']);
  });

  it('LIMIT で予算分だけ返す', async () => {
    const { seg, n, occ } = await fixture(); // A,B,C,D 全員未回答
    const targets = await remainingUnansweredTargets(db(), seg.id, occ.id, n.id, TODAY, 2);
    expect(targets.length).toBe(2);
  });

  it('休止中メンバーは未回答リマインドの母集団から除外', async () => {
    const { seg, n, occ } = await fixture();
    await setSegmentMemberStatus(db(), seg.id, 'A', '休止中');
    const targets = await remainingUnansweredTargets(db(), seg.id, occ.id, n.id, TODAY, 10);
    expect(targets.map((m) => m.user_id)).not.toContain('A');
  });

  it('未定リマインドは「未定」回答かつアクティブのみ', async () => {
    const { seg, n, occ } = await fixture();
    await upsertResponse(db(), occ.id, 'A', 'A', '未定');
    await upsertResponse(db(), occ.id, 'B', 'B', '参加');
    await upsertResponse(db(), occ.id, 'C', 'C', '未定');
    const targets = await remainingUndecidedTargets(db(), seg.id, occ.id, n.id, TODAY, 10);
    expect(targets.map((m) => m.user_id).sort()).toEqual(['A', 'C']);
  });
});

describe('締切後変更フラグ（ADR 0014）', () => {
  it('post_deadline_change が立ち・sticky（MAX で保持）・回答履歴に出る', async () => {
    const { occ } = await fixture();
    // 締切前の通常回答 → フラグ 0
    await upsertResponse(db(), occ.id, 'A', 'A', '参加', false);
    expect(await getResponseStatus(db(), occ.id, 'A')).toBe('参加');

    // 締切後の変更 → フラグ 1
    await upsertResponse(db(), occ.id, 'A', 'A', '不参加', true);
    let rows = await listRecentResponses(db(), 50);
    expect(rows.find((r) => r.user_id === 'A')?.post_deadline_change).toBe(1);

    // その後の通常回答でも sticky（1 のまま）
    await upsertResponse(db(), occ.id, 'A', 'A', '参加', false);
    rows = await listRecentResponses(db(), 50);
    const a = rows.find((r) => r.user_id === 'A');
    expect(a?.status).toBe('参加');
    expect(a?.post_deadline_change).toBe(1);
  });
});

describe('notifications 新カラムの往復（migration 0010）', () => {
  it('response_deadline_hours / change_alert_channel_id / send_hour が保存・取得できる', async () => {
    const seg = await createSegment(db(), { guild_id: 'g1', name: 'S', mention_role_id: null });
    const created = await createNotification(
      db(),
      notifInput({ segment_id: seg.id, response_deadline_hours: 3, change_alert_channel_id: 'cc', send_hour: 9 }),
    );
    const got = await getNotification(db(), created.id);
    expect(got?.response_deadline_hours).toBe(3);
    expect(got?.change_alert_channel_id).toBe('cc');
    expect(got?.send_hour).toBe(9);
  });
});

describe('送信予算 config（⑦・ADR 0013）', () => {
  it('既定 45・setConfig で上書きできる（課金時の上限突破）', async () => {
    expect(await getSendBudget(db())).toBe(45);
    await setConfig(db(), 'send_budget_per_tick', '120');
    expect(await getSendBudget(db())).toBe(120);
  });
  it('未設定キーは fallback', async () => {
    expect(await getConfigInt(db(), 'missing_key', 7)).toBe(7);
  });
});

describe('stale claim の回収（クラッシュ耐性・ADR 0013）', () => {
  it("'sending' のまま残った claim は回収され、再 claim できる", async () => {
    const { n, occ } = await fixture();
    const key = { notification_id: n.id, occurrence_id: occ.id, user_id: 'A', kind: 'remind_unanswered' as const, send_date: TODAY };
    expect(await claimSend(db(), key)).toBe(true); // 'sending'
    expect(await claimSend(db(), key)).toBe(false); // 既に claim 済み
    // 未来時刻を閾値に → 直近の 'sending' 行を回収対象にする
    await clearStaleClaims(db(), new Date(Date.now() + 60000).toISOString());
    expect(await claimSend(db(), key)).toBe(true); // 回収後は再 claim 可能
  });
  it("完了済み('sent')は回収されない", async () => {
    const { n, occ } = await fixture();
    const key = { notification_id: n.id, occurrence_id: occ.id, user_id: 'B', kind: 'remind_unanswered' as const, send_date: TODAY };
    await claimSend(db(), key);
    await finishSend(db(), key, true);
    await clearStaleClaims(db(), new Date(Date.now() + 60000).toISOString());
    expect(await claimSend(db(), key)).toBe(false); // 'sent' は残り再送しない
  });
});
