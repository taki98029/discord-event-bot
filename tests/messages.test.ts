import { describe, it, expect } from 'vitest';
import { answerLabels, buildOwnAnswerMessage, buildStatusMessage, createButtonComponents } from '../src/discord/rest';
import type { EventStatusBuckets } from '../src/db/types';

/** バケットを件数だけ指定して組み立てるヘルパ */
const bk = (a = 0, x = 0, u = 0, n = 0): EventStatusBuckets => ({
  参加: Array(a).fill('p'),
  不参加: Array(x).fill('a'),
  未定: Array(u).fill('m'),
  未回答: Array(n).fill('q'),
});

describe('answerLabels', () => {
  it('参加/不参加/未定（旧 oneoff の 可/不可/未確定 は廃止）', () => {
    expect(answerLabels()).toEqual({ participate: '参加', absent: '不参加', undecided: '未定' });
  });
});

describe('createButtonComponents', () => {
  it('回答 3 ボタン＋状況確認。custom_id は {action}_{occurrenceId}', () => {
    const rows = createButtonComponents(42) as { components: { label: string; custom_id: string }[] }[];
    expect(rows[0].components.map((c) => c.custom_id)).toEqual([
      'participate_42',
      'absent_42',
      'undecided_42',
      'status_42',
    ]);
    expect(rows[0].components.map((c) => c.label)).toEqual(['参加', '不参加', '未定', '📊 状況確認']);
  });
  it('includeStatus=false で状況確認を省く', () => {
    const rows = createButtonComponents(42, false) as { components: unknown[] }[];
    expect(rows[0].components).toHaveLength(3);
  });
});

describe('buildStatusMessage', () => {
  it('「参加状況」＋参加/不参加/未定', () => {
    const msg = buildStatusMessage('2026/06/20', bk(3, 1, 0, 2));
    expect(msg).toContain('参加状況');
    expect(msg).toContain('参加 (3名)');
  });
  it('名前一覧は subtext（-#）で表示する', () => {
    const msg = buildStatusMessage('2026/06/20', bk(2, 0, 0, 1));
    expect(msg).toContain('\n-# p、p');
    expect(msg).toContain('\n-# (なし)');
  });
  it('myAnswer を渡すと先頭に「あなたの回答」行が付く（null=未回答）', () => {
    const answered = buildStatusMessage('2026/06/20', bk(1), '参加');
    expect(answered).toContain('👤 あなたの回答: **⭕ 参加**');
    const unanswered = buildStatusMessage('2026/06/20', bk(1), null);
    expect(unanswered).toContain('👤 あなたの回答: **⚠️ 未回答**');
    const omitted = buildStatusMessage('2026/06/20', bk(1));
    expect(omitted).not.toContain('あなたの回答');
  });
});

describe('buildOwnAnswerMessage（回答非公開）', () => {
  it('本人の回答だけを出し、人数と名前は出さない', () => {
    const msg = buildOwnAnswerMessage('2026/06/20', '不参加');
    expect(msg).toContain('👤 あなたの回答: **❌ 不参加**');
    expect(msg).not.toContain('名)');
    expect(buildOwnAnswerMessage('2026/06/20', null)).toContain('⚠️ 未回答');
  });
});
