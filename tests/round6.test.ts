// 2026-10-11 6 巡目（最終）: d4ab7ee（cutText・空白だけの分を送らない）の回帰と、src の残りの切り詰め箇所・
// 25914dc..HEAD 全体の経路間の食い違いの最終確認。1〜5 巡目の場面は繰り返さない。ヘルパーは round5 / oneoff-planning-edge から写した。
// it.fails は確認済みの不具合（// 修正済み 2026-10-11: に理由）。直したら it に戻す。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import { handleAdmin, normalizeBoardMembers } from '../src/admin';
import { createSegment } from '../src/db/segments';
import { composePost, cutText, sendChannelMessage } from '../src/discord/rest';
import { setConfig } from '../src/db/config';
import { failureNotificationKey } from '../src/discord/failureNotifications';
import { slotPayload } from '../src/planning/delivery';
import type { Plan } from '../src/planning/model';

const db = env.DB;
const E = { ...env, ADMIN_TOKEN: 'round6', MOCK_DISCORD: '1', DISCORD_BOT_TOKEN: 'dummy' } as Env;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const EMOJI = '😀'; // サロゲートペア（2 単位）

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const call = (method: string, path: string, body?: unknown) =>
  handleAdmin(
    new Request(`https://test.invalid/api/admin${path}`, {
      method,
      headers: { Authorization: 'Bearer round6', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    E,
  );
async function okJson(method: string, path: string, body?: unknown): Promise<any> {
  const r = await call(method, path, body);
  const v = await r.json();
  expect(r.status, JSON.stringify(v)).toBeLessThan(300);
  return v;
}
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
async function template(segUuid: string, extra: Record<string, unknown>) {
  return okJson('POST', '/notifications', {
    guild_id: '1001', segment_uuid: segUuid, name: '会', channel_id: '2001', message_title: '募集',
    start_time: '20:00', send_hour: 21, recruit_days_before: 7, remind_start_days: 3, remind_undecided_days: 1, ...extra,
  });
}
function captureSends(fail: (nth: number) => boolean = () => false) {
  const sent: { to: string; content: string }[] = [];
  let nth = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const m = String(url).match(/\/channels\/([^/]+)\/messages/);
    if (m) {
      nth++;
      if (fail(nth)) return new Response('{"message":"x"}', { status: 500 });
      sent.push({ to: m[1], content: JSON.parse(String(init?.body ?? '{}')).content });
    }
    return Response.json({ id: 'm' });
  }));
  return { take: () => sent.splice(0) };
}

// =============================================================================
describe('cutText の境界（d4ab7ee）', () => {
  it('n=0・負・長さ超え・ペアの後ろ半分で切る場合', () => {
    expect(cutText('abc', 0)).toBe('');
    expect(cutText('abc', 5)).toBe('abc');
    expect(cutText(EMOJI, 1)).toBe(''); // 上位サロゲートの直後 → 1 つ手前
    expect(cutText(EMOJI, 2)).toBe(EMOJI); // ペアの直後
    expect(cutText(`a${EMOJI}b`, 2)).toBe('a');
    expect(cutText(`a${EMOJI}b`, 3)).toBe(`a${EMOJI}`);
    // ZWJ 連結・結合文字は単位の途中で切れても、サロゲートは割らない（要件はサロゲートだけ）
    const family = '👨‍👩‍👧';
    for (let n = 0; n <= family.length; n++) expect(LONE_SURROGATE.test(cutText(family, n))).toBe(false);
  });

  it('composePost: 見出しが絵文字だけでも割らず、2000 以内', () => {
    const out = composePost('', EMOJI.repeat(1500), null, '日時');
    expect(LONE_SURROGATE.test(out)).toBe(false);
    expect(out.length).toBeLessThanOrEqual(2000);
    expect(out.endsWith('日時')).toBe(true);
  });

  it('postMessage の最終切り詰め: 1999 字目がペアの前半でも割らない', async () => {
    const cap = captureSends();
    expect(await sendChannelMessage(E, '2001', 'a'.repeat(1998) + EMOJI + 'b')).toBe(true);
    const [m] = cap.take();
    expect(m.content.length).toBeLessThanOrEqual(2000);
    expect(LONE_SURROGATE.test(m.content)).toBe(false);
  });
});

// =============================================================================
describe('src に残る .slice(0, N) の切り詰め（Discord に届く文字列）', () => {
  // 修正済み 2026-10-11: src/planning/delivery.ts:113 のフォーラムのスレッド名 `${c.date} ${c.time} ${p.data.name}`.slice(0, 100) は
  // コード単位で切る。名前は画面・API とも 150 字まで入るので、名前の 83 字目がペアの前半だと上位サロゲートだけが残り、
  // スレッド名が化ける（Discord が不正な文字列として拒む可能性もある）。cutText に替えるのが正しい。
  it('確定後のフォーラム投稿: スレッド名が絵文字を途中で割らない', () => {
    const p = {
      id: 'p1', guild_id: '1001', version: 1,
      data: {
        standalone: true, segments: [], schedules: [], name: 'あ'.repeat(82) + EMOJI + 'い', state: 'confirmed',
        channel: '111', forum: '222', tag: '', candidates: [{ id: 'c1', date: '2099-09-10', time: '19:00', active: true }],
        people: [], answers: {}, slots: [],
      },
    } as unknown as Plan;
    const slot = { id: 's1', candidate: 'c1', members: [], cancelled: false, gather: '', note: '' };
    const { name } = slotPayload(p, slot, false);
    expect(name.length).toBeLessThanOrEqual(100);
    expect(LONE_SURROGATE.test(name)).toBe(false);
  });

  // 修正済み 2026-10-11: src/admin/index.ts:1121 のグループ名 b.name.trim().slice(0, 50) がペアを割る。グループ名はメンバー配置の発表で
  // そのまま Discord に投稿され、D1 に保存した時点で割れた半分が U+FFFD（�）に化ける（画面側 ui/src/screens/GroupingDialog.tsx:117 も同じ slice(0, 50) なので画面からも起きる）。
  it('グループ名の改名: 50 字目がペアの前半でも割らない（発表文に化けた文字が出ない）', async () => {
    const s = await segment(['5101']);
    const n = await template(s.uuid, { type: 'oneoff', recruit_days_before: 3 });
    const occ = await okJson('POST', `/notifications/${n.uuid}/occurrences`, { date: '2099/01/10', start_time: '20:00' });
    await okJson('PUT', `/occurrences/${occ.uuid}/grouping`, { group_count: 1 });
    const view = await okJson('GET', `/occurrences/${occ.uuid}/grouping`);
    await okJson('PUT', `/occurrences/${occ.uuid}/grouping/rename`, { group_uuid: view.groups[0].uuid, name: 'あ'.repeat(49) + EMOJI });
    const content = (await okJson('POST', `/occurrences/${occ.uuid}/grouping/announce?dry_run=1`, {})).content as string;
    // D1 は割れたサロゲートを U+FFFD（�）に置き換えて保存するので、発表文には化けた文字として出る
    expect(content).not.toMatch(/�/);
    expect(LONE_SURROGATE.test(content)).toBe(false);
  });

  // 修正済み 2026-10-11: src/admin/index.ts:143（normalizeBoardMembers）の行頭ラベル slice(0, 20) も同じ（画面 GroupingBoard.tsx:245 も同じ）。
  it('配置の行頭ラベル: 20 字目がペアの前半でも割らない', () => {
    const [m] = normalizeBoardMembers([{ user_id: 'u', label: 'a'.repeat(19) + EMOJI }]);
    expect(LONE_SURROGATE.test(m.label ?? '')).toBe(false);
  });

  // 修正済み 2026-10-11: src/discord/failureNotifications.ts:55 の detail.slice(0, 1300)。detail にはテンプレート名がそのまま入り、
  // テンプレート名には上限が無い（toNotificationInput・画面とも）。名前が約 1300 字を超えると割れる。実害は極小（名前が非現実的に長いときだけ）。
  it('失敗通知: 長いテンプレート名で 1300 字目がペアの前半でも割らない', async () => {
    await setConfig(db, failureNotificationKey('1001'), JSON.stringify({ channel_id: '2009', mention_mode: 'none', mention_ids: [] }));
    const s = await segment(['5102']);
    // detail = `今すぐ募集: ${name}\n…` → 先頭 7 字 + 名前。名前の 1292 字目（0 始まり）が 1300 字目の位置
    const n = await template(s.uuid, { type: 'oneoff', recruit_days_before: 3, recruit_enabled: false, name: 'あ'.repeat(1292) + EMOJI });
    at('2099/01/01', '10:00');
    const occ = await okJson('POST', `/notifications/${n.uuid}/occurrences`, { date: '2099/01/10', start_time: '20:00' });
    const cap = captureSends((nth) => nth === 1);
    expect((await call('POST', `/occurrences/${occ.uuid}/recruit`)).status).toBe(400);
    const [alert] = cap.take();
    expect(alert.to).toBe('2009');
    expect(LONE_SURROGATE.test(alert.content)).toBe(false);
  });
});

// =============================================================================
describe('日程調整: 候補を変えない保存は再投稿しない（06ec8ed）', () => {
  const G = '12345678901';
  async function published() {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ id: '1', guild_id: G, type: 0 })));
    await db.prepare("INSERT INTO segments(id,guild_id,name,uuid) VALUES(8601,?,'キャスト','r6-cast')").bind(G).run();
    await db.prepare("INSERT INTO members(user_id,user_name) VALUES('r6p1','回答者')").run();
    await db.prepare("INSERT INTO segment_members(segment_id,user_id,status) VALUES(8601,'r6p1','')").run();
    let p = await okJson('POST', '/planning', {
      guild_id: G, oneOff: true, name: '単発', segments: [8601], channel: '111111', forum: '222222', tag: '',
      deadline: '2099-09-01T00:00:00Z', note: '', remindDays: 0, announceMention: 'none', shareAnswers: false, eventReminderHours: 0,
      answerReminder: { enabled: false, beforeDays: 0, intervalDays: 1, time: '20:00', target: 'dm' },
    });
    p = await okJson('POST', `/planning/${p.id}/candidates`, { version: p.version, candidates: [{ date: '2099-09-10', time: '19:00' }, { date: '2099-09-11', time: '19:00' }] });
    return okJson('POST', `/planning/${p.id}/publish`, { version: p.version });
  }
  const reposts = (id: string) => db.prepare("SELECT COUNT(*) AS n FROM planning_deliveries WHERE plan_id=? AND kind='candidates'").bind(id).first('n');

  it('同じ順の同じ候補は再投稿しない', async () => {
    let p = await published();
    p = await okJson('POST', `/planning/${p.id}/candidates`, { version: p.version, candidates: [{ date: '2099-09-10', time: '19:00' }, { date: '2099-09-11', time: '19:00' }] });
    expect(await reposts(p.id)).toBe(0);
  });

  // 修正済み 2026-10-11: src/planning/admin.ts:775 の activeIds は有効な候補 ID を「送られてきた順」で連結して比べる。候補欄（テキストエリア）の
  // 行を並べ替えて保存すると、候補は何も変わらないのに「日程候補を更新しました（追加0件）」の回答案内が再投稿される。
  // ID を並べ替えてから比べる（例: .sort().join()）のが正しい。
  it('並べ替えただけの同じ候補は再投稿しない', async () => {
    let p = await published();
    p = await okJson('POST', `/planning/${p.id}/candidates`, { version: p.version, candidates: [{ date: '2099-09-11', time: '19:00' }, { date: '2099-09-10', time: '19:00' }] });
    expect(await reposts(p.id)).toBe(0);
  });
});
