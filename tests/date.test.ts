import { describe, it, expect } from 'vitest';
import { formatDate, getTargetDate, getDaysUntilEvent } from '../src/lib/date';

// getTargetDate/getDaysUntilEvent はローカルゲッター（getDay/getHours 等）で now を読む。
// getJSTNow() は実行環境の TZ に関わらず「ローカル表現が JST 壁時計」になる Date を返すため、
// テストの now もローカルコンストラクタ new Date(y, m, d, h, min) で組む（TZ 非依存）。
// 2025-01-01 は水曜日（WEDNESDAY）。

const EVENT = { eventDayOfWeek: 'WEDNESDAY', eventStartTime: '21:00' };

describe('formatDate', () => {
  it('Date を YYYY/MM/DD にゼロ埋めで整形する', () => {
    expect(formatDate(new Date(Date.UTC(2025, 0, 5, 0, 0)))).toBe('2025/01/05');
  });
  it('文字列入力も整形できる', () => {
    expect(formatDate('2025/01/05')).toBe('2025/01/05');
  });
});

describe('getTargetDate / getDaysUntilEvent', () => {
  it('開催曜日の開始時刻より前なら「今日」が対象', () => {
    const now = new Date(2025, 0, 1, 20, 0); // 水 20:00 JST
    const target = getTargetDate(EVENT, now);
    expect(formatDate(target)).toBe('2025/01/01');
    expect(getDaysUntilEvent(target, now)).toBe(0);
  });

  it('開催曜日の開始時刻以降なら「来週」が対象', () => {
    const now = new Date(2025, 0, 1, 21, 30); // 水 21:30 JST（開始後）
    const target = getTargetDate(EVENT, now);
    expect(formatDate(target)).toBe('2025/01/08');
    expect(getDaysUntilEvent(target, now)).toBe(7);
  });

  it('別の曜日からは直近の開催曜日が対象', () => {
    const now = new Date(2025, 0, 2, 10, 0); // 木 10:00 JST
    const target = getTargetDate(EVENT, now);
    expect(formatDate(target)).toBe('2025/01/08');
    expect(getDaysUntilEvent(target, now)).toBe(6);
  });
});
