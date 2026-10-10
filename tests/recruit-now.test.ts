import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { getOrCreateOccurrence } from '../src/db/occurrences';
import { claimSend, clearStaleClaims, finishSend, hasSentKind, isSendLogged, reclaimFailedSend } from '../src/db/sendLog';
import { recruitOccurrenceNow } from '../src/cron/tick';
import type { Notification } from '../src/db/types';
import type { Env } from '../src/env';

// recruitOccurrenceNow（管理画面「今すぐ募集」の経路）の claim / force / failed 取り直しの挙動。
// Discord REST は fetch をスタブして成功/失敗を切り替える。occurrences / send_log に FK は無いので通知はリテラルでよい。
const notif = (over: Partial<Notification> = {}): Notification =>
  ({
    id: 9301,
    uuid: 'n-9301',
    guild_id: 'g1',
    name: 'テスト会',
    type: 'recurring',
    rrule: 'FREQ=WEEKLY;BYDAY=WE',
    start_time: '21:00',
    duration_minutes: 60,
    segment_id: 'seg-none',
    channel_id: 'ch1',
    mention_mode: 'none',
    message_title: '募集',
    message_body: '',
    requires_response: 1,
    response_deadline_hours: null,
    recruit_days_before: 7,
    active: 1,
    ...over,
  }) as unknown as Notification;

function stubFetch(ok: boolean): { posts: () => number; restore: () => void } {
  const calls: string[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    calls.push(String(url));
    return new Response(ok ? '{"id":"m1"}' : '{"message":"boom"}', { status: ok ? 200 : 400 });
  }) as typeof fetch;
  return {
    posts: () => calls.filter((u) => u.includes('/channels/ch1/messages')).length,
    restore: () => {
      globalThis.fetch = orig;
    },
  };
}

const E = () => env as unknown as Env;

describe('recruitOccurrenceNow（今すぐ募集の共通経路）', () => {
  it('初回は sent＋send_log 記録、2回目は already_sent、force でのみ再送する', async () => {
    const n = notif();
    const occ = await getOrCreateOccurrence(env.DB, n.id, '2026/09/02', '21:00');
    const f = stubFetch(true);
    try {
      expect(await recruitOccurrenceNow(E(), n, occ)).toBe('sent');
      expect(await hasSentKind(env.DB, n.id, occ.id, 'recruit')).toBe(true);
      expect(f.posts()).toBe(1);
      // 同じ開催回はデフォルトで再送しない（cron・管理画面が同じ真実を見る）
      expect(await recruitOccurrenceNow(E(), n, occ)).toBe('already_sent');
      expect(f.posts()).toBe(1);
      // force（UI の確認ダイアログ了承後）だけ sent を取り直して再送する
      expect(await recruitOccurrenceNow(E(), n, occ, { force: true })).toBe('sent');
      expect(f.posts()).toBe(2);
    } finally {
      f.restore();
    }
  });

  it('前日に投稿済み（send_date が過去日）でも force なしでは already_sent（日をまたいだ重複投稿防止）', async () => {
    const n = notif({ id: 9303, uuid: 'n-9303' });
    const occ = await getOrCreateOccurrence(env.DB, n.id, '2026/09/16', '21:00');
    await env.DB.prepare(
      `INSERT INTO send_log (notification_id, occurrence_id, user_id, kind, send_date, status, created_at)
       VALUES (?, ?, '', 'recruit', '2000/01/01', 'sent', ?)`,
    )
      .bind(n.id, occ.id, new Date().toISOString())
      .run();
    const f = stubFetch(true);
    try {
      expect(await recruitOccurrenceNow(E(), n, occ)).toBe('already_sent');
      expect(f.posts()).toBe(0);
      expect(await recruitOccurrenceNow(E(), n, occ, { force: true })).toBe('sent');
      expect(f.posts()).toBe(1);
    } finally {
      f.restore();
    }
  });

  it('送信失敗は failed で終わり（hasSentKind は数えない）、当日中の再実行で claim を取り直せる', async () => {
    const n = notif({ id: 9302, uuid: 'n-9302' });
    const occ = await getOrCreateOccurrence(env.DB, n.id, '2026/09/09', '21:00');
    const bad = stubFetch(false);
    try {
      expect(await recruitOccurrenceNow(E(), n, occ)).toBe('failed');
      expect(await hasSentKind(env.DB, n.id, occ.id, 'recruit')).toBe(false);
    } finally {
      bad.restore();
    }
    const good = stubFetch(true);
    try {
      expect(await recruitOccurrenceNow(E(), n, occ)).toBe('sent');
      expect(await hasSentKind(env.DB, n.id, occ.id, 'recruit')).toBe(true);
    } finally {
      good.restore();
    }
  });
});

it('手動の取り直しは claim の時刻も新しくする（送信中に古い claim の掃除で消されない）', async () => {
  const db = env.DB;
  const key = { notification_id: 99001, occurrence_id: 99002, kind: 'recruit' as const, send_date: '2026/10/03' };
  await claimSend(db, key);
  await finishSend(db, key, false, 'x');
  await db.prepare("UPDATE send_log SET created_at='2000-01-01T00:00:00Z' WHERE notification_id=99001").run();
  expect(await reclaimFailedSend(db, key)).toBe(true);
  await clearStaleClaims(db, new Date(Date.now() - 5 * 60_000).toISOString());
  expect(await isSendLogged(db, key)).toBe(true);
});
