import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { addMember, updateMemberDisplayName, getMember } from '../src/db/members';
import {
  createSegment,
  addSegmentMember,
  setSegmentMemberStatus,
  getActiveSegmentMembers,
  listSegmentMembers,
} from '../src/db/segments';
import { upsertResponse, getStatusBuckets, checkQuotaForNotification, listRecentResponses } from '../src/db/responses';
import { claimSend } from '../src/db/sendLog';
import type { Notification } from '../src/db/types';

const db = () => env.DB;

// --- テスト用の最小フィクスチャ ---
// Event 廃止後、Notification は guild_id で Server に直結する（ADR 0005）。
const GUILD = 'g1';

/** notifications に 1 行入れて Notification を返す（必要列のみ over で上書き） */
async function insertNotification(
  guildId: string,
  segmentId: number,
  over: Partial<Notification> = {},
): Promise<Notification> {
  const n: Notification = {
    id: 0,
    uuid: '00000000-0000-0000-0000-000000000001',
    guild_id: guildId,
    segment_id: segmentId,
    name: 'テスト通知',
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
    remind_target: 'dm',
    remind_undecided_target: 'dm',
    share_answers: 1,
    quota_enabled: 0,
    quota_interval_days: null,
    assignment_enabled: 0,
    grouping_enabled: 0,
    mention_enabled: 1,
    mention_mode: 'role',
    requires_response: 1,
    message_title: 'テスト通知',
    message_body: null,
    active: 1,
    response_deadline_hours: null,
    change_alert_channel_id: null,
    grouping_channel_id: null,
    send_hour: 21,
    created_at: '',
    ...over,
  };
  const res = await db()
    .prepare(
      `INSERT INTO notifications (
         guild_id, segment_id, name, channel_id, type, rrule, one_off_date, start_time,
         recruit_days_before, remind_start_days, remind_undecided_days,
         quota_enabled, quota_interval_days, assignment_enabled, mention_enabled, active
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      n.guild_id,
      n.segment_id,
      n.name,
      n.channel_id,
      n.type,
      n.rrule,
      null, // one_off_date（旧 oneoff 用・休眠列）
      n.start_time,
      n.recruit_days_before,
      n.remind_start_days,
      n.remind_undecided_days,
      n.quota_enabled,
      n.quota_interval_days,
      n.assignment_enabled,
      n.mention_enabled,
      n.active,
    )
    .run();
  n.id = res.meta.last_row_id as number;
  return n;
}

/** occurrences に 1 行入れて id を返す */
async function insertOccurrence(
  notificationId: number,
  dateStr: string,
  status: 'scheduled' | 'cancelled' = 'scheduled',
  startTime = '',
): Promise<number> {
  const res = await db()
    .prepare(
      'INSERT INTO occurrences (notification_id, occurrence_date, start_time, status) VALUES (?, ?, ?, ?)',
    )
    .bind(notificationId, dateStr, startTime, status)
    .run();
  return res.meta.last_row_id as number;
}

describe('segment members（アクティブ集計）', () => {
  it('getActiveSegmentMembers は status="" のみを返す', async () => {
    const seg = await createSegment(db(), { guild_id: 'g1', name: 'キャスト', mention_role_id: null });
    await addMember(db(), 'u1', 'n1', 'D1');
    await addMember(db(), 'u2', 'n2', 'D2');
    await addMember(db(), 'u3', 'n3', 'D3');
    await addSegmentMember(db(), seg,'u1');
    await addSegmentMember(db(), seg,'u2');
    await addSegmentMember(db(), seg,'u3');
    await setSegmentMemberStatus(db(), seg.id, 'u3', '休止中');

    const active = await getActiveSegmentMembers(db(), seg.id);
    expect(active.map((m) => m.user_id).sort()).toEqual(['u1', 'u2']);
  });

  it('getStatusBuckets は区分アクティブメンバーを母集団に集計し休止者を除外・未回答を補完', async () => {
    const seg = await createSegment(db(), { guild_id: 'g1', name: 'キャスト', mention_role_id: null });
    const n = await insertNotification(GUILD, seg.id);
    const occId = await insertOccurrence(n.id, '2025/01/04');

    await addMember(db(), 'u1', 'n1', 'D1');
    await addMember(db(), 'u2', 'n2', 'D2');
    await addMember(db(), 'u3', 'n3', 'D3');
    await addMember(db(), 'u4', 'n4', 'D4'); // 区分外 → 母集団に含まれない
    await addSegmentMember(db(), seg,'u1');
    await addSegmentMember(db(), seg,'u2');
    await addSegmentMember(db(), seg,'u3');
    await setSegmentMemberStatus(db(), seg.id, 'u3', '休止中'); // 除外対象

    await upsertResponse(db(), occId, 'u1', 'n1', '参加');
    await upsertResponse(db(), occId, 'u3', 'n3', '参加'); // 休止者の回答は無視される
    await upsertResponse(db(), occId, 'u4', 'n4', '参加'); // 区分外の回答も無視される

    const buckets = await getStatusBuckets(db(), occId, seg.id);
    expect(buckets.参加).toEqual(['D1']);
    expect(buckets.未回答).toEqual(['D2']); // u2 は未回答, u3 は休止で除外, u4 は区分外
    expect(buckets.不参加).toEqual([]);
    expect(buckets.未定).toEqual([]);
  });
});

describe('ギルドごとの表示名（member_guild_profiles・ADR 0022）', () => {
  it('同一ユーザーが複数ギルドに居ても、区分一覧は各ギルドの nick を返す（上書きされない）', async () => {
    const segA = await createSegment(db(), { guild_id: 'gA', name: 'A区分', mention_role_id: null });
    const segB = await createSegment(db(), { guild_id: 'gB', name: 'B区分', mention_role_id: null });

    // ギルドAの nick で所属 → その後ギルドBの nick で所属（旧実装ではここで A の表示名が壊れた）
    await addSegmentMember(db(), segA, 'u1', { user_name: 'alice', display_name: 'ありすA' });
    await addSegmentMember(db(), segB, 'u1', { user_name: 'alice', display_name: 'ありすB' });

    const inA = await getActiveSegmentMembers(db(), segA.id);
    const inB = await listSegmentMembers(db(), segB.id);
    expect(inA[0].display_name).toBe('ありすA');
    expect(inB[0].display_name).toBe('ありすB');
  });

  it('updateMemberDisplayName は guildId 付きでそのギルドの nick を常に最新化する', async () => {
    const seg = await createSegment(db(), { guild_id: 'gA', name: 'A区分', mention_role_id: null });
    await addSegmentMember(db(), seg, 'u1', { user_name: 'alice', display_name: '旧ニック' });

    await updateMemberDisplayName(db(), 'u1', '新ニック', 'alice', 'gA');

    const inA = await getActiveSegmentMembers(db(), seg.id);
    expect(inA[0].display_name).toBe('新ニック');
    // グローバルフォールバック（members）は初回値のまま（他ギルドへ波及しない）
    expect((await getMember(db(), 'u1'))?.display_name).toBe('旧ニック');
  });

  it('ギルド nick が無いユーザーはグローバル表示名にフォールバックする', async () => {
    const seg = await createSegment(db(), { guild_id: 'gA', name: 'A区分', mention_role_id: null });
    await addMember(db(), 'u1', 'alice', 'グローバル名');
    await addSegmentMember(db(), seg, 'u1'); // names 無し＝profile 行なし

    const inA = await getActiveSegmentMembers(db(), seg.id);
    expect(inA[0].display_name).toBe('グローバル名');
  });
});

describe('checkQuotaForNotification', () => {
  it('quota 無効なら空配列', async () => {
    const seg = await createSegment(db(), { guild_id: 'g1', name: 'キャスト', mention_role_id: null });
    const n = await insertNotification(GUILD, seg.id, {
      quota_enabled: 0,
      quota_interval_days: 30,
    });
    expect(await checkQuotaForNotification(db(), n)).toEqual([]);
  });

  it('最終参加日から interval を超えたアクティブメンバーのみ返す（未参加者は除外）', async () => {
    const seg = await createSegment(db(), { guild_id: 'g1', name: 'キャスト', mention_role_id: null });
    const n = await insertNotification(GUILD, seg.id, {
      quota_enabled: 1,
      quota_interval_days: 30,
    });

    await addMember(db(), 'u1', 'n1', 'D1');
    await addMember(db(), 'u2', 'n2', 'D2');
    await addMember(db(), 'u3', 'n3', 'D3'); // 未参加 → 対象外
    await addSegmentMember(db(), seg,'u1');
    await addSegmentMember(db(), seg,'u2');
    await addSegmentMember(db(), seg,'u3');

    const occOld = await insertOccurrence(n.id, '2025/01/01'); // 古い回
    const occNew = await insertOccurrence(n.id, '2025/03/01'); // 直近の回
    await upsertResponse(db(), occOld, 'u1', 'n1', '参加'); // u1 の最終参加 = 2025/01/01
    await upsertResponse(db(), occNew, 'u2', 'n2', '参加'); // u2 の最終参加 = 2025/03/01

    const now = new Date(Date.UTC(2025, 2, 15, 12, 0)); // 2025/03/15 JST 相当
    const alerts = await checkQuotaForNotification(db(), n, now);
    const ids = alerts.map((a) => a.user_id);
    expect(ids).toContain('u1'); // 約73日経過 > 30
    expect(ids).not.toContain('u2'); // 14日経過 ≤ 30
    expect(ids).not.toContain('u3'); // 未参加
  });

  it('休止メンバーは対象外', async () => {
    const seg = await createSegment(db(), { guild_id: 'g1', name: 'キャスト', mention_role_id: null });
    const n = await insertNotification(GUILD, seg.id, {
      quota_enabled: 1,
      quota_interval_days: 30,
    });
    await addMember(db(), 'u1', 'n1', 'D1');
    await addSegmentMember(db(), seg,'u1');
    await setSegmentMemberStatus(db(), seg.id, 'u1', '休止中');
    const occ = await insertOccurrence(n.id, '2025/01/01');
    await upsertResponse(db(), occ, 'u1', 'n1', '参加');

    const now = new Date(Date.UTC(2025, 2, 15, 12, 0));
    expect(await checkQuotaForNotification(db(), n, now)).toEqual([]);
  });

  it('超過し続ける限り、後続の募集日でも繰り返し対象になり send_log も日違いで通す（2回目が送られる構造）', async () => {
    const seg = await createSegment(db(), { guild_id: 'g1', name: 'キャスト', mention_role_id: null });
    const n = await insertNotification(GUILD, seg.id, {
      quota_enabled: 1,
      quota_interval_days: 30,
    });
    await addMember(db(), 'u1', 'n1', 'D1');
    await addSegmentMember(db(), seg, 'u1');
    const occ = await insertOccurrence(n.id, '2025/01/01'); // 最終参加 = 2025/01/01
    await upsertResponse(db(), occ, 'u1', 'n1', '参加');

    // 1 回目の募集日（超過 73 日）: 対象になり claim が通る
    const week1 = new Date(Date.UTC(2025, 2, 15, 12, 0));
    const alerts1 = await checkQuotaForNotification(db(), n, week1);
    expect(alerts1.map((a) => a.user_id)).toEqual(['u1']);
    expect(
      await claimSend(db(), { notification_id: n.id, user_id: 'u1', kind: 'quota', send_date: '2025/03/15' }),
    ).toBe(true);

    // 翌週の募集日（参加していない → 超過 80 日）: 引き続き対象・send_date が変わるので claim も通る
    const week2 = new Date(Date.UTC(2025, 2, 22, 12, 0));
    const alerts2 = await checkQuotaForNotification(db(), n, week2);
    expect(alerts2.map((a) => a.user_id)).toEqual(['u1']);
    expect(
      await claimSend(db(), { notification_id: n.id, user_id: 'u1', kind: 'quota', send_date: '2025/03/22' }),
    ).toBe(true);
  });

  it('【既知の穴】「参加」記録が 1 件も無いメンバーは、何ヶ月経っても永遠に対象にならない', async () => {
    const seg = await createSegment(db(), { guild_id: 'g1', name: 'キャスト', mention_role_id: null });
    const n = await insertNotification(GUILD, seg.id, {
      quota_enabled: 1,
      quota_interval_days: 30,
    });
    // u1 は所属しているが responses に「参加」が一度も無い
    // （旧 Sheets 版からの移行で過去の参加記録が D1 に無いメンバーはこの状態になる）
    await addMember(db(), 'u1', 'n1', 'D1');
    await addSegmentMember(db(), seg, 'u1');

    // 8 ヶ月後でも対象外（未参加者除外・旧仕様踏襲）
    const eightMonthsLater = new Date(Date.UTC(2025, 8, 1, 12, 0));
    expect(await checkQuotaForNotification(db(), n, eightMonthsLater)).toEqual([]);
  });
});


describe('response_log（回答の変更履歴・0022）', () => {
  it('回答を変更すると 1 変更 = 1 行が残り、listRecentResponses が新しい順に全行返す', async () => {
    const seg = await createSegment(db(), { guild_id: 'g1', name: 'キャスト', mention_role_id: null });
    const n = await insertNotification(GUILD, seg.id);
    const occId = await insertOccurrence(n.id, '2025/01/04');

    await upsertResponse(db(), occId, 'u1', 'n1', '未定');
    await upsertResponse(db(), occId, 'u1', 'n1', '参加', true); // 締切後に変更

    // responses は最新値のみ（従来どおり）
    const cur = await db()
      .prepare('SELECT status FROM responses WHERE occurrence_id = ? AND user_id = ?')
      .bind(occId, 'u1')
      .first<{ status: string }>();
    expect(cur?.status).toBe('参加');

    // 履歴は 2 行、新しい順。post_deadline_change は行ごと（1 行目のみ 1）
    const hist = await listRecentResponses(db(), 10, GUILD);
    expect(hist.map((r) => r.status)).toEqual(['参加', '未定']);
    expect(hist.map((r) => r.post_deadline_change)).toEqual([1, 0]);
  });
});
