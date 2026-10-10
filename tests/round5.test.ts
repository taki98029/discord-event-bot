// 2026-10-11 5 巡目: 4 巡目の修正（abb4b18）の回帰と、共有経路（表示名・失敗通知・429・締切の時間）の追加調査。
// 1〜4 巡目（oneoff-*・round3-regressions・round4）の場面は繰り返さない。ヘルパーは round4 から写した。
// it.fails は確認済みの不具合（// 修正済み 2026-10-11: に理由）。直したら it に戻す。
// 「// 要判断:」の it は現状の挙動を記録したもので、仕様の判断待ち（直すなら期待値を変える）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import { handleAdmin } from '../src/admin';
import { createSegment } from '../src/db/segments';
import { composePost } from '../src/discord/rest';
import { runTick } from '../src/cron/tick';
import { setConfig } from '../src/db/config';
import { failureNotificationKey } from '../src/discord/failureNotifications';

const db = env.DB;
const E = { ...env, ADMIN_TOKEN: 'round5', MOCK_DISCORD: '1', DISCORD_BOT_TOKEN: 'dummy' } as Env;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const call = (method: string, path: string, body?: unknown) =>
  handleAdmin(
    new Request(`https://test.invalid/api/admin${path}`, {
      method,
      headers: { Authorization: 'Bearer round5', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    E,
  );

const at = (date: string, hhmm: string) => {
  const [y, m, d] = date.split('/').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.UTC(y, m - 1, d, h - 9, mi));
};

async function segment(members: string[] = [], name = (id: string) => `名${id}`, role: string | null = null) {
  const s = await createSegment(db, { guild_id: '1001', name: `区分${Math.random()}`, mention_role_id: role });
  for (const id of members) {
    await db.batch([
      db.prepare('INSERT OR IGNORE INTO members(user_id,user_name,display_name) VALUES(?,?,?)').bind(id, `u${id}`, name(id)),
      db.prepare("INSERT INTO segment_members(segment_id,user_id,status) VALUES(?,?,'')").bind(s.id, id),
    ]);
  }
  return s;
}

async function template(segUuid: string, extra: Record<string, unknown>) {
  const res = await call('POST', '/notifications', {
    guild_id: '1001', segment_uuid: segUuid, name: '会', channel_id: '2001', message_title: '募集',
    start_time: '20:00', send_hour: 21, recruit_days_before: 7, remind_start_days: 3, remind_undecided_days: 1, ...extra,
  });
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
  return (await res.json()) as any;
}
async function occurrence(n: any, body: Record<string, unknown>) {
  const o = await call('POST', `/notifications/${n.uuid}/occurrences`, body);
  expect(o.status, JSON.stringify(await o.clone().json())).toBe(201);
  return (await o.json()) as any;
}

/** チャンネル投稿を記録する。fail(n) が true の n 通目（1 始まり）は 500 を返す */
function captureSends(fail: (nth: number) => boolean = () => false) {
  const sent: { to: string; content: string; allowed?: any }[] = [];
  let nth = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      const b = JSON.parse(String(init?.body ?? '{}'));
      if (u.endsWith('/users/@me/channels')) return Response.json({ id: `dm-${b.recipient_id}` });
      const m = u.match(/\/channels\/([^/]+)\/messages/);
      if (m) {
        nth++;
        if (fail(nth)) return new Response('{"message":"x"}', { status: 500 });
        sent.push({ to: m[1], content: b.content, allowed: b.allowed_mentions });
      }
      return Response.json({ id: 'm' });
    }),
  );
  return { take: () => sent.splice(0) };
}

const answer = (oid: number, uid: string, status: string) =>
  db.prepare("INSERT INTO responses(occurrence_id,user_id,user_name,status,updated_at) VALUES(?,?,?,?,'x')").bind(oid, uid, `u${uid}`, status).run();
const ids = (n: number, base: bigint) => Array.from({ length: n }, (_, i) => String(base + BigInt(i)));
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

// =============================================================================
describe('composePost の切り詰め（abb4b18）', () => {
  // 修正済み 2026-10-11: src/discord/rest.ts:111 は本文を UTF-16 の位置で切るので、絵文字（サロゲートペア）の途中で割れ、
  // 孤立サロゲートを含んだ本文を Discord へ送る（見出しの切り詰め :114 も同じ）。round4 で 📊 の切り詰めには同じ配慮を入れている。
  // UI から届く: 見出し 100＋本文 1500（絵文字 750 個）＋開催回の補足 500 で募集すると本文が削られる。
  it('本文を削るときに絵文字を途中で割らない', () => {
    const msg = composePost('', 'T', '😀'.repeat(1000), 'X'); // 7+2000+2+1 = 2010 → 本文を 1989 単位に切る（奇数）
    expect(msg.length).toBeLessThanOrEqual(2000);
    expect(LONE_SURROGATE.test(msg)).toBe(false); // 文字列そのものを出すとテストの通信が UTF-8 で壊れるので真偽で見る
  });

  it('tail（日時・締切の行）とメンションは削らず、合計は 2000 以内', () => {
    const tail = '補'.repeat(500) + '\n\n日時: **2099/01/14 (水) 20:00〜**\n回答締切: **2099/01/14 18:00**';
    const msg = composePost('<@&123456789012345678>\n\n', '見'.repeat(100), '本'.repeat(1500), tail);
    expect(msg.length).toBe(2000);
    expect(msg.startsWith('<@&123456789012345678>\n\n**')).toBe(true);
    expect(msg.endsWith(tail)).toBe(true);
  });

  // 要判断: バイネーム（mention_mode='members'）の予算は「本文を削ったあとの長さ」から逆算する（src/cron/tick.ts:155）。
  // 見出し＋本文＋補足で 2000 に届くと予算 0 となり、メンションは全員分なくなる（本文が優先）。
  // 一方ロールメンションは abb4b18 以降、本文を削ってでも必ず残る。区分のメンバーは誰も通知されない。
  // 案: (1) 現状（本文優先・ADR 0010 の記述どおり） (2) 最低 N 人分（例: 400 字）をメンションに確保し本文を削る
  it('要判断: 長い本文＋補足の募集では、バイネームのメンションが 1 人分も付かない', async () => {
    const s = await segment(['3001', '3002']);
    const n = await template(s.uuid, { message_title: '見'.repeat(100), message_body: '本'.repeat(1500), rrule: null, mention_mode: 'members' });
    at('2099/01/01', '10:00');
    const occ = await occurrence(n, { date: '2099/01/14', start_time: '20:00', note: '補'.repeat(500) });
    const cap = captureSends();
    expect((await call('POST', `/occurrences/${occ.uuid}/recruit`)).status).toBe(200);
    const [post] = cap.take();
    expect(post.content).not.toContain('<@3001>');
    expect(post.content.length).toBeLessThanOrEqual(2000);
  });
});

// =============================================================================
describe('メンバー配置の発表の分割（abb4b18）', () => {
  /** 単発・グループ 1 つに participants を全員配置した開催回 */
  async function assigned(participants: string[], name: (id: string) => string) {
    const s = await segment(participants, name);
    const n = await template(s.uuid, { type: 'oneoff', recruit_days_before: 3 });
    const occ = await occurrence(n, { date: '2099/01/10', start_time: '20:00' });
    for (const u of participants) await answer(occ.id, u, '参加');
    expect((await call('PUT', `/occurrences/${occ.uuid}/grouping`, { group_count: 1 })).status).toBe(200);
    const g = await db.prepare('SELECT g.id FROM groups g JOIN groupings gg ON gg.id=g.grouping_id WHERE gg.occurrence_id=?').bind(occ.id).first<{ id: number }>();
    for (const [i, u] of participants.entries())
      await db.prepare('INSERT INTO group_members(group_id,members_index,user_id) VALUES(?,?,?)').bind(g!.id, i, u).run();
    return { n, occ };
  }
  const preview = async (uuid: string) => ((await (await call('POST', `/occurrences/${uuid}/grouping/announce?dry_run=1`, {})).json()) as any).content as string;

  // 修正済み 2026-10-11: src/admin/index.ts:1218-1222 の分割は、前の分がちょうど 2000 字で埋まると、最後の空行（各グループの後ろに入れる ''）だけで
  // 新しい分を作る。空の content は Discord が 400（Cannot send an empty message）で拒むので、全員を載せ終えたのに
  // ok:false と「配置発表」の失敗通知になる。管理者が再実行すると全体がもう一度投稿される。空白だけの分は送らないのが正しい。
  // 起きる条件は「配置の文面がちょうど 2001 字（末尾が改行）」で狭い（名前の長さの組み合わせ次第）。
  it('2000 字ちょうどで区切れても、空の投稿を作らない', async () => {
    const members = ids(70, 600000000000000000n);
    const { occ } = await assigned(members, () => '名'.repeat(25));
    let content = await preview(occ.uuid);
    // 名前の長さを調整して、文面をちょうど 2001 字（＝2000 字＋末尾の改行）にする
    let delta = 2001 - content.length;
    for (const u of members) {
      if (!delta) break;
      const step = Math.max(-24, Math.min(7, delta));
      await db.prepare('UPDATE members SET display_name=? WHERE user_id=?').bind('名'.repeat(25 + step), u).run();
      delta -= step;
    }
    content = await preview(occ.uuid);
    expect(content.length).toBe(2001);
    expect(content.endsWith('\n')).toBe(true);
    const cap = captureSends();
    const res: any = await (await call('POST', `/occurrences/${occ.uuid}/grouping/announce`, {})).json();
    const parts = cap.take().map((p) => p.content);
    expect(parts.every((p) => p.trim().length > 0)).toBe(true);
    expect(res.ok).toBe(true);
  });

  // 要判断: 2 通目以降が失敗すると ok:false・失敗通知になるが、1 通目は投稿済みのまま。画面から再実行すると 1 通目から全部を
  // 投稿し直すので、前半が二重に載る。返す content は全文で、どこまで載ったかは分からない。
  // 案: (1) 現状（失敗時は手で前半を消してから再実行） (2) 失敗した位置を返して続きから再開 (3) 失敗通知・画面に「n 通中 m 通まで投稿済み」を出す
  it('要判断: 2 通目が失敗 → ok:false、再実行で 1 通目が二重に投稿される', async () => {
    const members = ids(120, 610000000000000000n);
    const { occ } = await assigned(members, () => '名'.repeat(25));
    let cap = captureSends((nth) => nth === 2);
    const first: any = await (await call('POST', `/occurrences/${occ.uuid}/grouping/announce`, {})).json();
    const posted1 = cap.take().filter((p) => p.to === '2001').map((p) => p.content);
    expect(first.ok).toBe(false);
    expect(posted1).toHaveLength(1);
    cap = captureSends();
    const second: any = await (await call('POST', `/occurrences/${occ.uuid}/grouping/announce`, {})).json();
    const posted2 = cap.take().map((p) => p.content);
    expect(second.ok).toBe(true);
    expect(posted2[0]).toBe(posted1[0]); // 前半がもう一度載る
  });

  it('中止した回でも dry_run の下見は返す（発表だけを止める）', async () => {
    const { occ } = await assigned(['3601', '3602'], (id) => `名${id}`);
    expect((await call('PUT', `/occurrences/${occ.uuid}`, { status: 'cancelled' })).status).toBe(200);
    const res = await call('POST', `/occurrences/${occ.uuid}/grouping/announce?dry_run=1`, {});
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).content).toContain('名3601');
  });
});

// =============================================================================
describe('単発の回答締切の時間が長い（168 時間）', () => {
  it('2 日後の開催に 168 時間前の締切は登録できない（締切が今より前）', async () => {
    const s = await segment(['3801']);
    const n = await template(s.uuid, { type: 'oneoff', recruit_days_before: 3 });
    at('2099/01/08', '10:00');
    const res = await call('POST', `/notifications/${n.uuid}/occurrences`, { date: '2099/01/10', start_time: '20:00', response_deadline_hours: 168 });
    expect(res.status).toBe(400);
    expect(await db.prepare('SELECT COUNT(*) AS c FROM occurrences WHERE notification_id=?').bind(n.id).first('c')).toBe(0);
  });

  it('桁外れの締切（1e12 時間）も 400 で、開催回を作らない', async () => {
    const s = await segment(['3802']);
    const n = await template(s.uuid, { type: 'oneoff', recruit_days_before: 3 });
    at('2099/01/08', '10:00');
    const res = await call('POST', `/notifications/${n.uuid}/occurrences`, { date: '2099/01/10', start_time: '20:00', response_deadline_hours: 1e12 });
    expect(res.status).toBe(400);
    expect(await db.prepare('SELECT COUNT(*) AS c FROM occurrences WHERE notification_id=?').bind(n.id).first('c')).toBe(0);
  });
});

// =============================================================================
describe('単発の失敗通知と 429', () => {
  it('📣 の投稿失敗: 失敗通知はメンション先のユーザーだけを許可して投稿する', async () => {
    await setConfig(db, failureNotificationKey('1001'), JSON.stringify({ channel_id: '2009', mention_mode: 'users', mention_ids: ['4001'] }));
    const s = await segment(['3901']);
    const n = await template(s.uuid, { type: 'oneoff', recruit_days_before: 3, recruit_enabled: false });
    at('2099/01/01', '10:00');
    const occ = await occurrence(n, { date: '2099/01/10', start_time: '20:00' });
    const cap = captureSends((nth) => nth === 1);
    expect((await call('POST', `/occurrences/${occ.uuid}/recruit`)).status).toBe(400);
    const [alert] = cap.take();
    expect(alert.to).toBe('2009');
    expect(alert.content.startsWith('<@4001>\n⚠️')).toBe(true);
    expect(alert.allowed).toEqual({ parse: [], users: ['4001'] });
  });

  it('cron の単発の募集が 429: 失敗通知を出さず、次のティックで投稿する', async () => {
    await setConfig(db, failureNotificationKey('1001'), JSON.stringify({ channel_id: '2009', mention_mode: 'none', mention_ids: [] }));
    const s = await segment(['3902']);
    const n = await template(s.uuid, { type: 'oneoff', recruit_days_before: 3, send_hour: 9 });
    at('2099/01/01', '08:00');
    await occurrence(n, { date: '2099/01/03', start_time: '20:00' });
    at('2099/01/01', '09:00');
    await setConfig(db, 'rolesync:1001', '2099/01/01');
    await setConfig(db, 'guild_names', JSON.stringify({ day: '2099/01/01', names: { '1001': 'テスト' } }));
    let status = 429;
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
      urls.push(String(url));
      return new Response(status === 429 ? '{"retry_after":1,"global":false}' : '{"id":"m"}', { status });
    }));
    await runTick(E);
    expect(urls.filter((u) => u.includes('/channels/'))).toEqual(['https://discord.com/api/v10/channels/2001/messages']);
    status = 200;
    at('2099/01/01', '09:01');
    await runTick(E);
    expect(urls.slice(1).filter((u) => u.includes('/channels/2001/'))).toHaveLength(1);
    expect(urls.some((u) => u.includes('/channels/2009/'))).toBe(false);
    expect(await db.prepare("SELECT status FROM send_log WHERE notification_id=? AND kind='recruit'").bind(n.id).first('status')).toBe('sent');
  });
});
