import { describe, it, expect } from 'vitest';
import { answerLabels, buildAllStatusMessage, buildStatusMessage } from '../src/discord/rest';
import type { EventStatusBuckets } from '../src/db/types';

/** バケットを件数だけ指定して組み立てるヘルパ */
const bk = (a = 0, x = 0, u = 0, n = 0): EventStatusBuckets => ({
  参加: Array(a).fill('p'),
  不参加: Array(x).fill('a'),
  未定: Array(u).fill('m'),
  未回答: Array(n).fill('q'),
});

describe('answerLabels', () => {
  it('oneoff は 可/不可/未確定', () => {
    expect(answerLabels('oneoff')).toEqual({ participate: '可', absent: '不可', undecided: '未確定' });
  });
  it('recurring は 参加/不参加/未定', () => {
    expect(answerLabels('recurring')).toEqual({ participate: '参加', absent: '不参加', undecided: '未定' });
  });
});

describe('buildStatusMessage（種別で見出し・回答ラベル切替）', () => {
  it('oneoff は「調整状況」＋可/不可/未確定', () => {
    const msg = buildStatusMessage('2026/06/19 (金) 21:00〜23:00', bk(1, 0, 2, 0), 'oneoff');
    expect(msg).toContain('調整状況');
    expect(msg).toContain('可 (1名)');
    expect(msg).toContain('未確定 (2名)');
  });
  it('recurring は「参加状況」＋参加/不参加/未定', () => {
    const msg = buildStatusMessage('2026/06/20', bk(3, 1, 0, 2), 'recurring');
    expect(msg).toContain('参加状況');
    expect(msg).toContain('参加 (3名)');
  });
});

describe('buildAllStatusMessage（全候補集計・2000字ガード）', () => {
  it('候補ごとに oneoff ラベルで件数を出す', () => {
    const msg = buildAllStatusMessage(
      '調整',
      [{ label: '2026/06/19 (金) 21:00〜23:00', buckets: bk(2, 1, 0, 3) }],
      'oneoff',
    );
    expect(msg).toContain('調整 の候補別 状況');
    expect(msg).toContain('2026/06/19 (金) 21:00〜23:00');
    expect(msg).toContain('可 2 / 不可 1 / 未確定 0 / 未回答 3');
  });

  it('候補が多すぎる場合は 2000 字以内に収め、残りを要約する', () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({
      label: `2026/07/${(i % 28) + 1} (金) 21:00〜23:00 ＜候補スロット ${i} の長いラベル＞`,
      buckets: bk(1, 1, 1, 1),
    }));
    const msg = buildAllStatusMessage('多数候補', rows, 'oneoff');
    expect(msg.length).toBeLessThanOrEqual(2000);
    expect(msg).toContain('…ほか');
    expect(msg).toContain('件（長いため省略）');
  });

  it('上限内なら全件出して要約は付かない', () => {
    const rows = [
      { label: 'A 21:00〜22:00', buckets: bk(1) },
      { label: 'B 22:00〜23:00', buckets: bk(0, 1) },
    ];
    const msg = buildAllStatusMessage('少数', rows, 'oneoff');
    expect(msg).not.toContain('…ほか');
    expect(msg).toContain('A 21:00〜22:00');
    expect(msg).toContain('B 22:00〜23:00');
  });
});
