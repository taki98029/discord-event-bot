import { describe, it, expect } from 'vitest';
import { formatDate, getDaysUntilEvent } from '../src/lib/date';

// getDaysUntilEvent は now をローカルゲッター（getDay/getHours 等）で読む。
// getJSTNow() は実行環境の TZ に関わらず「ローカル表現が JST 壁時計」になる Date を返すため、
// テストの now/target もローカルコンストラクタ new Date(y, m, d, ...) で組む（TZ 非依存）。

describe('formatDate', () => {
  it('Date を YYYY/MM/DD にゼロ埋めで整形する', () => {
    expect(formatDate(new Date(Date.UTC(2025, 0, 5, 0, 0)))).toBe('2025/01/05');
  });
  it('文字列入力も整形できる', () => {
    expect(formatDate('2025/01/05')).toBe('2025/01/05');
  });
});

describe('getDaysUntilEvent', () => {
  it('同日なら 0', () => {
    const now = new Date(2025, 0, 1, 20, 0); // 水 20:00 JST
    const target = new Date(2025, 0, 1, 21, 0); // 同日
    expect(getDaysUntilEvent(target, now)).toBe(0);
  });

  it('時刻に関わらず日付のみで比較する（同日なら時刻差があっても 0）', () => {
    const now = new Date(2025, 0, 1, 23, 59);
    const target = new Date(2025, 0, 1, 0, 0);
    expect(getDaysUntilEvent(target, now)).toBe(0);
  });

  it('1 週間先なら 7', () => {
    const now = new Date(2025, 0, 1, 21, 30);
    const target = new Date(2025, 0, 8, 21, 0);
    expect(getDaysUntilEvent(target, now)).toBe(7);
  });

  it('6 日先なら 6', () => {
    const now = new Date(2025, 0, 2, 10, 0);
    const target = new Date(2025, 0, 8, 21, 0);
    expect(getDaysUntilEvent(target, now)).toBe(6);
  });
});
