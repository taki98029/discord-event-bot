import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createSegment, addSegmentMember } from '../src/db/segments';
import { addMember } from '../src/db/members';
import { upsertResponse, getStatusBuckets } from '../src/db/responses';
import { assignNumbers } from '../src/db/assignments';
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
  getOrCreateOccurrence,
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

const dt = (o: { occurrence_date: string; start_time: string }) =>
  `${o.occurrence_date} ${o.start_time}`;

describe('syncCandidateOccurrences（候補スロット=日付+時刻 の同期）', () => {
  it('スロットを occurrences として作成し、(日付,時刻) 昇順で scheduled を返す', async () => {
    const seg = await createSegment(db(), { guild_id: 'g1', name: 'メンバー', mention_role_id: null });
    const n = await createNotification(db(), oneoffInput('g1', seg.id));
    const occs = await syncCandidateOccurrences(db(), n.id, [
      { date: '2025/03/20', time: '21:00' },
      { date: '2025/03/10', time: '21:00' },
      { date: '2025/03/15', time: '19:00' },
    ]);
    expect(occs.map(dt)).toEqual(['2025/03/10 21:00', '2025/03/15 19:00', '2025/03/20 21:00']);
    expect(occs.every((o) => o.status === 'scheduled')).toBe(true);
  });

  it('同一日に複数の時刻スロットが共存できる（旧 UNIQUE 違反しない）', async () => {
    const seg = await createSegment(db(), { guild_id: 'g1', name: 'メンバー', mention_role_id: null });
    const n = await createNotification(db(), oneoffInput('g1', seg.id));
    const occs = await syncCandidateOccurrences(db(), n.id, [
      { date: '2025/03/15', time: '21:00' },
      { date: '2025/03/15', time: '19:00' },
    ]);
    expect(occs).toHaveLength(2);
    expect(occs.map((o) => o.start_time)).toEqual(['19:00', '21:00']); // 時刻昇順
    expect(new Set(occs.map((o) => o.id)).size).toBe(2); // 別 occurrence
  });

  it('外したスロットは cancelled・回答保全、再追加で同一 id が復活（id は安定）', async () => {
    const seg = await createSegment(db(), { guild_id: 'g1', name: 'メンバー', mention_role_id: null });
    const n = await createNotification(db(), oneoffInput('g1', seg.id));
    const created = await syncCandidateOccurrences(db(), n.id, [
      { date: '2025/03/15', time: '19:00' },
      { date: '2025/03/15', time: '21:00' },
    ]);
    const slot19 = created.find((o) => o.start_time === '19:00')!;
    await addMember(db(), 'u1', 'n1', 'D1');
    await upsertResponse(db(), slot19.id, 'u1', 'n1', '参加');

    // 19:00 を外す → cancelled、scheduled は 21:00 のみ
    const after = await syncCandidateOccurrences(db(), n.id, [{ date: '2025/03/15', time: '21:00' }]);
    expect(after.map((o) => o.start_time)).toEqual(['21:00']);
    expect((await getOccurrence(db(), slot19.id))?.status).toBe('cancelled');
    const resp = await db()
      .prepare('SELECT status FROM responses WHERE occurrence_id = ? AND user_id = ?')
      .bind(slot19.id, 'u1')
      .first<{ status: string }>();
    expect(resp?.status).toBe('参加'); // 回答は保全

    // 再追加で同一 id が scheduled に復活
    const restored = await syncCandidateOccurrences(db(), n.id, [
      { date: '2025/03/15', time: '19:00' },
      { date: '2025/03/15', time: '21:00' },
    ]);
    const back = restored.find((o) => o.start_time === '19:00');
    expect(back?.id).toBe(slot19.id);
    expect(back?.status).toBe('scheduled');
  });
});

describe('getOrCreateOccurrence（スロット単位の取得/生成・後方互換の再利用）', () => {
  it('同一 (date,time) は既存を返し、同日でも時刻違いは新規スロットを作る', async () => {
    const seg = await createSegment(db(), { guild_id: 'g1', name: 'メンバー', mention_role_id: null });
    const n = await createNotification(db(), oneoffInput('g1', seg.id));
    const a = await getOrCreateOccurrence(db(), n.id, '2025/03/15', '19:00');
    const again = await getOrCreateOccurrence(db(), n.id, '2025/03/15', '19:00');
    expect(again.id).toBe(a.id); // 同一スロットは重複生成しない（lookup が start_time を含む）
    const b = await getOrCreateOccurrence(db(), n.id, '2025/03/15', '21:00');
    expect(b.id).not.toBe(a.id); // 同日でも時刻違いは別スロット
    expect(b.start_time).toBe('21:00');
  });
});

describe('スロットごとの独立した出欠集計', () => {
  it('同一日でも時刻スロットごとに別々の回答・割り当てを持てる', async () => {
    const seg = await createSegment(db(), { guild_id: 'g1', name: 'メンバー', mention_role_id: null });
    const n = await createNotification(db(), oneoffInput('g1', seg.id));
    const occs = await syncCandidateOccurrences(db(), n.id, [
      { date: '2025/03/15', time: '19:00' },
      { date: '2025/03/15', time: '21:00' },
    ]);
    const s19 = occs[0];
    const s21 = occs[1];
    await addMember(db(), 'u1', 'n1', 'D1');
    await addSegmentMember(db(), seg.id, 'u1');
    await upsertResponse(db(), s19.id, 'u1', 'n1', '参加');
    await upsertResponse(db(), s21.id, 'u1', 'n1', '不参加');

    const b19 = await getStatusBuckets(db(), s19.id, seg.id);
    const b21 = await getStatusBuckets(db(), s21.id, seg.id);
    expect(b19.参加).toEqual(['D1']);
    expect(b21.不参加).toEqual(['D1']);

    // 割り当ても occurrence 単位で独立
    const a19 = await assignNumbers(db(), s19.id);
    expect(a19.all.map((a) => a.user_id)).toEqual(['u1']); // 参加者のみ
    const a21 = await assignNumbers(db(), s21.id);
    expect(a21.all).toHaveLength(0); // 不参加は対象外
  });
});

describe('decideOccurrence / undecideNotification（スロット確定）', () => {
  it('あるスロットを確定すると同日他スロットも含め他候補が cancelled になる', async () => {
    const seg = await createSegment(db(), { guild_id: 'g1', name: 'メンバー', mention_role_id: null });
    const n = await createNotification(db(), oneoffInput('g1', seg.id));
    const occs = await syncCandidateOccurrences(db(), n.id, [
      { date: '2025/03/15', time: '19:00' },
      { date: '2025/03/15', time: '21:00' },
      { date: '2025/03/20', time: '20:00' },
    ]);
    const chosen = occs[0]; // 2025/03/15 19:00

    await decideOccurrence(db(), n.id, chosen.id);
    const scheduled = await listScheduledOccurrences(db(), n.id);
    expect(scheduled.map((o) => o.id)).toEqual([chosen.id]);
    expect((await getNotification(db(), n.id))?.decided_occurrence_id).toBe(chosen.id);

    await undecideNotification(db(), n.id);
    const restored = await listScheduledOccurrences(db(), n.id);
    expect(restored.map(dt)).toEqual(['2025/03/15 19:00', '2025/03/15 21:00', '2025/03/20 20:00']);
    expect((await getNotification(db(), n.id))?.decided_occurrence_id).toBeNull();
  });
});
