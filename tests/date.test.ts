import { describe, it, expect } from 'vitest';
import {
  formatDate,
  getDaysUntilEvent,
  addMinutesToTime,
  formatTimeRange,
  formatOccurrenceLabel,
} from '../src/lib/date';

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

describe('addMinutesToTime', () => {
  it('同日内の加算', () => {
    expect(addMinutesToTime('21:00', 120)).toEqual({ time: '23:00', nextDay: false });
  });
  it('分の繰り上がり', () => {
    expect(addMinutesToTime('21:45', 30)).toEqual({ time: '22:15', nextDay: false });
  });
  it('24:00 ちょうどは翌日扱い', () => {
    expect(addMinutesToTime('22:00', 120)).toEqual({ time: '00:00', nextDay: true });
  });
  it('翌日に跨ぐ', () => {
    expect(addMinutesToTime('23:00', 180)).toEqual({ time: '02:00', nextDay: true });
  });
});

describe('formatTimeRange', () => {
  it('duration 未設定(null)は開始時刻のみの開放端', () => {
    expect(formatTimeRange('21:00', null)).toBe('21:00〜');
  });
  it('duration 0 以下は開放端', () => {
    expect(formatTimeRange('21:00', 0)).toBe('21:00〜');
  });
  it('duration 指定で From-To', () => {
    expect(formatTimeRange('21:00', 120)).toBe('21:00〜23:00');
  });
  it('日跨ぎは「翌」を付ける', () => {
    expect(formatTimeRange('23:00', 180)).toBe('23:00〜翌02:00');
  });
});

describe('formatOccurrenceLabel', () => {
  it('曜日付き・duration ありで From-To', () => {
    // 2026/06/19 は金曜
    expect(formatOccurrenceLabel('2026/06/19', '21:00', 120)).toBe('2026/06/19 (金) 21:00〜23:00');
  });
  it('duration 未設定は開放端', () => {
    expect(formatOccurrenceLabel('2026/06/20', '21:00', null)).toBe('2026/06/20 (土) 21:00〜');
  });
});
