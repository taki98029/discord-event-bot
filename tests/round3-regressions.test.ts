// 2026-10-11 の単発向け修正（0ee783b〜d541fae）が定期・不定期・定期の日程調整を壊していないかの回帰テスト。
// it.fails は確認済みの不具合（// 修正済み 2026-10-11: に理由）。直したら it に戻す。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import { handleAdmin } from '../src/admin';
import { createSegment } from '../src/db/segments';
import { claimSend, finishSend } from '../src/db/sendLog';
import { setConfig } from '../src/db/config';
import { runTick } from '../src/cron/tick';
import { answerReminderDue } from '../src/planning/cron';
import { deliverPending } from '../src/planning/delivery';
import { failureNotificationKey } from '../src/discord/failureNotifications';

const db = env.DB;
const E = { ...env, ADMIN_TOKEN: 'round3', MOCK_DISCORD: '1', DISCORD_BOT_TOKEN: 'dummy' } as Env;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const call = (method: string, path: string, body?: unknown) =>
  handleAdmin(
    new Request(`https://test.invalid/api/admin${path}`, {
      method,
      headers: { Authorization: 'Bearer round3', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    E,
  );

/** JST の壁時計で現在時刻を固定する */
const at = (date: string, hhmm: string) => {
  const [y, m, d] = date.split('/').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.UTC(y, m - 1, d, h - 9, mi));
};

async function segment(members: string[] = []) {
  const s = await createSegment(db, { guild_id: '1001', name: `区分${Math.random()}`, mention_role_id: null });
  for (const id of members) {
    await db.batch([
      db.prepare('INSERT OR IGNORE INTO members(user_id,user_name,display_name) VALUES(?,?,?)').bind(id, `u${id}`, `名${id}`),
      db.prepare("INSERT INTO segment_members(segment_id,user_id,status) VALUES(?,?,'')").bind(s.id, id),
    ]);
  }
  return s;
}

/** 定期（毎週土曜 20:00・送信 21 時・募集 7 日前）。既定値の組み合わせで、順序ルールに掛からないごく普通の設定 */
async function weekly(extra: Record<string, unknown> = {}, members: string[] = []) {
  const s = await segment(members);
  const body = {
    guild_id: '1001', segment_uuid: s.uuid, name: '定例会', channel_id: '2001', message_title: '募集',
    rrule: 'FREQ=WEEKLY;BYDAY=SA', start_time: '20:00', send_hour: 21, recruit_days_before: 7,
    remind_start_days: 3, remind_undecided_days: 2, ...extra,
  };
  const res = await call('POST', '/notifications', body);
  expect(res.status).toBe(201);
  return (await res.json()) as any;
}

const markRecruited = async (nid: number, oid: number, day: string) => {
  const key = { notification_id: nid, occurrence_id: oid, kind: 'recruit' as const, send_date: day };
  await claimSend(db, key);
  await finishSend(db, key, true);
};

function captureSends() {
  const sent: { to: string; content: string }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      const b = JSON.parse(String(init?.body ?? '{}'));
      if (u.endsWith('/users/@me/channels')) return Response.json({ id: `dm-${b.recipient_id}` });
      const m = u.match(/\/channels\/([^/]+)\/messages/);
      if (m) sent.push({ to: m[1], content: b.content });
      return Response.json({ id: 'm' });
    }),
  );
  return sent;
}

// =============================================================================
describe('定期: 開催当日の登録・実体化・再開（recruitTimingError・b523386）', () => {
  // 修正済み 2026-10-11: 定期は募集を手動にできない（validateFlow）ので、当日・送信時刻前・開始が送信時刻以前の臨時回は
  // 登録する手段が無くなった（以前は 201 で登録でき「📣 今すぐ募集」で投稿できた）。
  // 400 の文言は「募集を手動にして「📣 今すぐ募集」で投稿してください」で、定期では実行できない案内。
  it('当日 10:00 に当日 20:00 の臨時回を追加できる（📣 で投稿する運用）', async () => {
    const n = await weekly();
    at('2099/01/09', '10:00');
    const res = await call('POST', `/notifications/${n.uuid}/occurrences`, { date: '2099/01/09', start_time: '20:00', status: 'scheduled' });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
  });

  // 修正済み 2026-10-11: 同じ原因。一覧の仮想行（未実体化のルール回）で「📣 今すぐ募集」を押すと、先に行う実体化 POST
  // （origin 'rule'）が当日の送信時刻前は 400 になり、📣 そのものが使えない（ロールフォワードで実体化されない
  // 無効テンプレート・窓外の行など）。
  it('当日 10:00 に仮想行（ルール回）を 📣 のため実体化できる', async () => {
    const n = await weekly();
    at('2099/01/10', '10:00');
    const res = await call('POST', `/notifications/${n.uuid}/occurrences`, { date: '2099/01/10', start_time: '20:00', status: 'scheduled', origin: 'rule' });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
  });

  // 修正済み 2026-10-11: 同じ原因。募集前に中止した定期の回を当日の朝に再開すると「再開できません」。以前は再開でき、📣 で投稿できた
  // （中止中は 📣 も 400 なので、再開できないと当日の回は何もできない）。
  it('募集前に中止した回を当日の朝に再開できる', async () => {
    const n = await weekly();
    at('2099/01/09', '10:00');
    const created = await call('POST', `/notifications/${n.uuid}/occurrences`, { date: '2099/01/10', start_time: '20:00', status: 'scheduled', origin: 'rule' });
    expect(created.status).toBe(201);
    const occ: any = await created.json();
    expect((await call('PUT', `/occurrences/${occ.uuid}`, { status: 'cancelled' })).status).toBe(200);
    at('2099/01/10', '10:00');
    const res = await call('PUT', `/occurrences/${occ.uuid}`, { status: 'scheduled' });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
  });

  it('前日以前の登録・送信時刻を過ぎた当日の登録・開始後の記録用の登録は従来どおり通る', async () => {
    const n = await weekly();
    at('2099/01/08', '10:00');
    expect((await call('POST', `/notifications/${n.uuid}/occurrences`, { date: '2099/01/09', start_time: '20:00' })).status).toBe(201);
    at('2099/01/09', '21:30');
    expect((await call('POST', `/notifications/${n.uuid}/occurrences`, { date: '2099/01/09', start_time: '23:00' })).status).toBe(201);
    expect((await call('POST', `/notifications/${n.uuid}/occurrences`, { date: '2099/01/09', start_time: '18:00' })).status).toBe(201);
  });

  it('不定期は募集を手動にすれば当日の回を登録できる（案内どおりの回避策がある）', async () => {
    const s = await segment();
    const res = await call('POST', '/notifications', {
      guild_id: '1001', segment_uuid: s.uuid, name: '不定期', channel_id: '2001', message_title: '募集', rrule: null,
      start_time: '20:00', send_hour: 21, recruit_days_before: 7, remind_start_days: 3, remind_undecided_days: 2,
    });
    const n: any = await res.json();
    at('2099/01/09', '10:00');
    expect((await call('POST', `/notifications/${n.uuid}/occurrences`, { date: '2099/01/09', start_time: '20:00' })).status).toBe(400);
    expect((await call('POST', `/notifications/${n.uuid}/occurrences`, { date: '2099/01/09', start_time: '20:00', recruit_enabled: 0 })).status).toBe(201);
  });

  it('定期の臨時回の開始時刻: 空は雛形の時刻、HH:MM 以外は 400', async () => {
    const n = await weekly();
    at('2099/01/01', '10:00');
    const ok = await call('POST', `/notifications/${n.uuid}/occurrences`, { date: '2099/01/17', start_time: '', status: 'cancelled', origin: 'rule' });
    expect(ok.status).toBe(201);
    expect((await call('POST', `/notifications/${n.uuid}/occurrences`, { date: '2099/01/24', start_time: '9:00' })).status).toBe(400);
  });
});

// =============================================================================
describe('cron: 開始後は送らない（4e7dc32）が定期の正当な送信を止めない', () => {
  it('締切 0 時間前（開始ちょうど）の締切告知は開始時刻に出る', async () => {
    const n = await weekly({ response_deadline_hours: 0 }, ['u1']);
    at('2099/01/03', '10:00');
    const occ: any = await (await call('POST', `/notifications/${n.uuid}/occurrences`, { date: '2099/01/10', start_time: '20:00', origin: 'rule' })).json();
    await markRecruited(n.id, occ.id, '2099/01/03');
    const sent = captureSends();
    at('2099/01/10', '20:00');
    await runTick(E);
    expect(sent.some((x) => x.to === '2001' && /締め切/.test(x.content))).toBe(true);
  });

  it('当日の送信時刻（開始前）の未回答リマインドは出る', async () => {
    const n = await weekly({ send_hour: 12, remind_undecided_enabled: false }, ['u1']);
    at('2099/01/03', '10:00');
    const occ: any = await (await call('POST', `/notifications/${n.uuid}/occurrences`, { date: '2099/01/10', start_time: '20:00', origin: 'rule' })).json();
    await markRecruited(n.id, occ.id, '2099/01/03');
    const sent = captureSends();
    at('2099/01/10', '12:01');
    await runTick(E);
    expect(sent.some((x) => x.to === 'dm-u1')).toBe(true);
  });
});

// =============================================================================
describe('日程調整: 締切の N 日前の数え方（b523386）は定期の日程調整にも効く', () => {
  const plan = (deadline: string) =>
    ({ state: 'open', deadline, answerReminder: { enabled: true, beforeDays: 1, intervalDays: 1, time: '20:00', target: 'dm' } }) as any;
  const jst = (s: string) => Date.parse(s + '+09:00');

  it('締切が送信時刻より後なら従来と同じ日に送る', () => {
    const d = plan('2099-09-01T23:00:00+09:00');
    expect(answerReminderDue(d, jst('2099-08-30T20:00:00'))).toBe(false);
    expect(answerReminderDue(d, jst('2099-08-31T20:00:00'))).toBe(true);
  });

  // 1 日前以上は従来どおり暦日で数える（00:00 締切・1 日前から＝8/31 の 1 回だけ）。前日にずらすのは「0 日前」だけ
  it('00:00 締切・1 日前からは従来どおり 8/31 の 1 回', () => {
    const d = plan('2099-09-01T00:00:00+09:00');
    expect(answerReminderDue(d, jst('2099-08-30T20:00:00'))).toBe(false);
    expect(answerReminderDue(d, jst('2099-08-31T20:00:00'))).toBe(true);
  });
});

// =============================================================================
describe('日程調整: 送信中のまま止まった配信の回収（b523386）', () => {
  const G = '12345678901';
  it('UPDATE…RETURNING＋サブクエリで回収し、失敗通知は 1 回だけ（次のティックで繰り返さない）', async () => {
    await db.prepare("INSERT INTO planning_plans(id,guild_id,data,mutation,created_at,updated_at) VALUES('stale-p',?,?,'m','2099-01-01','2099-01-01')")
      .bind(G, JSON.stringify({ name: '止まった会', state: 'open', candidates: [], slots: [], people: [] })).run();
    await db.prepare("INSERT INTO planning_deliveries(id,plan_id,kind,channel_id,payload,status,created_at,updated_at) VALUES('d1','stale-p','publish','111111','{}','sending','2000-01-01T00:00:00Z','2000-01-01T00:00:00Z')").run();
    await setConfig(db, failureNotificationKey(G), JSON.stringify({ channel_id: '999999', mention_mode: 'none', mention_ids: [] }));
    const sent = captureSends();
    const live = { ...E, MOCK_DISCORD: undefined } as unknown as Env;
    await deliverPending(live);
    expect((await db.prepare("SELECT status FROM planning_deliveries WHERE id='d1'").first<any>()).status).toBe('unknown');
    expect(sent.filter((x) => x.to === '999999')).toHaveLength(1);
    expect(sent[0].content).toContain('止まった会');
    await deliverPending(live);
    expect(sent.filter((x) => x.to === '999999')).toHaveLength(1);
  });
});
