import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createSegment, addSegmentMember } from '../src/db/segments';
import { addMember } from '../src/db/members';
import { upsertResponse, getStatusBuckets } from '../src/db/responses';
import {
  createNotification,
  getNotification,
  decideOccurrence,
  undecideNotification,
  type NotificationInput,
} from '../src/db/notifications';
import {
  syncCandidateOccurrences,
  listScheduledOccurrences,
  getOccurrence,
} from '../src/db/occurrences';

const db = () => env.DB;

/** 単発(oneoff)の NotificationInput を組み立てる */
function oneoffInput(
  guildId: string,
  segmentId: number,
  over: Partial<NotificationInput> = {},
): NotificationInput {
  return {
    guild_id: guildId,
    segment_id: segmentId,
    name: '単発テスト',
    channel_id: 'c1',
    type: 'oneoff',
    rrule: null,
    one_off_date: null,
    anchor_date: null,
    start_time: '21:00',
    recruit_days_before: 7,
    remind_start_days: 3,
    remind_undecided_days: 1,
    quota_enabled: 0,
    quota_interval_days: null,
    assignment_enabled: 0,
    mention_enabled: 1,
    active: 1,
    ...over,
  };
}

describe('syncCandidateOccurrences（候補日の同期）', () => {
  it('候補日を occurrences として作成し、日付昇順で scheduled を返す', async () => {
    const seg = await createSegment(db(), { guild_id: 'g1', name: 'メンバー', mention_role_id: null });
    const n = await createNotification(db(), oneoffInput('g1', seg.id));
    const occs = await syncCandidateOccurrences(db(), n.id, ['2025/03/20', '2025/03/10', '2025/03/15']);
    expect(occs.map((o) => o.occurrence_date)).toEqual(['2025/03/10', '2025/03/15', '2025/03/20']);
    expect(occs.every((o) => o.status === 'scheduled')).toBe(true);
  });

  it('候補から外した日は cancelled になり回答は保全、再追加で同一回が復活する', async () => {
    const seg = await createSegment(db(), { guild_id: 'g1', name: 'メンバー', mention_role_id: null });
    const n = await createNotification(db(), oneoffInput('g1', seg.id));
    const created = await syncCandidateOccurrences(db(), n.id, ['2025/03/10', '2025/03/15', '2025/03/20']);
    const d15 = created.find((o) => o.occurrence_date === '2025/03/15')!;

    // d15 に回答を入れておく
    await addMember(db(), 'u1', 'n1', 'D1');
    await upsertResponse(db(), d15.id, 'u1', 'n1', '参加');

    // d15 を候補から外す → cancelled になり、scheduled は 2 件
    const after = await syncCandidateOccurrences(db(), n.id, ['2025/03/10', '2025/03/20']);
    expect(after.map((o) => o.occurrence_date)).toEqual(['2025/03/10', '2025/03/20']);
    const d15row = await getOccurrence(db(), d15.id);
    expect(d15row?.status).toBe('cancelled');
    // 回答行は保全されている
    const resp = await db()
      .prepare('SELECT status FROM responses WHERE occurrence_id = ? AND user_id = ?')
      .bind(d15.id, 'u1')
      .first<{ status: string }>();
    expect(resp?.status).toBe('参加');

    // 再追加で同一 occurrence id が scheduled に復活
    const restored = await syncCandidateOccurrences(db(), n.id, ['2025/03/10', '2025/03/15', '2025/03/20']);
    const d15back = restored.find((o) => o.occurrence_date === '2025/03/15');
    expect(d15back?.id).toBe(d15.id);
    expect(d15back?.status).toBe('scheduled');
  });
});

describe('decideOccurrence / undecideNotification（最終確定）', () => {
  it('確定で他候補を cancel し decided_occurrence_id を設定、解除で復活する', async () => {
    const seg = await createSegment(db(), { guild_id: 'g1', name: 'メンバー', mention_role_id: null });
    const n = await createNotification(db(), oneoffInput('g1', seg.id));
    const occs = await syncCandidateOccurrences(db(), n.id, ['2025/03/10', '2025/03/15', '2025/03/20']);
    const chosen = occs[1]; // 2025/03/15

    await decideOccurrence(db(), n.id, chosen.id);
    const scheduledAfter = await listScheduledOccurrences(db(), n.id);
    expect(scheduledAfter.map((o) => o.id)).toEqual([chosen.id]);
    const nAfter = await getNotification(db(), n.id);
    expect(nAfter?.decided_occurrence_id).toBe(chosen.id);

    await undecideNotification(db(), n.id);
    const scheduledRestored = await listScheduledOccurrences(db(), n.id);
    expect(scheduledRestored.map((o) => o.occurrence_date)).toEqual([
      '2025/03/10',
      '2025/03/15',
      '2025/03/20',
    ]);
    const nRestored = await getNotification(db(), n.id);
    expect(nRestored?.decided_occurrence_id).toBeNull();
  });
});

describe('候補日ごとの独立した出欠集計', () => {
  it('同じメンバーが候補日ごとに別々の回答を持てる', async () => {
    const seg = await createSegment(db(), { guild_id: 'g1', name: 'メンバー', mention_role_id: null });
    const n = await createNotification(db(), oneoffInput('g1', seg.id));
    const occs = await syncCandidateOccurrences(db(), n.id, ['2025/03/10', '2025/03/15']);
    const d10 = occs[0];
    const d15 = occs[1];

    await addMember(db(), 'u1', 'n1', 'D1');
    await addSegmentMember(db(), seg.id, 'u1');
    await upsertResponse(db(), d10.id, 'u1', 'n1', '参加');
    await upsertResponse(db(), d15.id, 'u1', 'n1', '不参加');

    const b10 = await getStatusBuckets(db(), d10.id, seg.id);
    const b15 = await getStatusBuckets(db(), d15.id, seg.id);
    expect(b10.参加).toEqual(['D1']);
    expect(b15.不参加).toEqual(['D1']);
  });
});
