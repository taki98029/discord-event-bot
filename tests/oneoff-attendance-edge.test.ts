// 単発出欠確認（notifications.type='oneoff'・rrule NULL・開催回 1 件）のエッジケース。
// 仕様の根拠: docs/dev/CONTEXT.md（単発出欠確認）・docs/dev/attendance-settings-matrix.md（単発出欠確認の保存先）・ADR 0032。
// it.fails は実装の不具合を示すテスト（// BUG: に理由）。直したら it に戻す。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import { handleAdmin } from '../src/admin';
import { handleInteraction } from '../src/interactions/index';
import { createSegment, setSegmentMemberStatus } from '../src/db/segments';
import { claimSend, finishSend } from '../src/db/sendLog';
import { runTick } from '../src/cron/tick';

const db = env.DB;
const E = { ...env, ADMIN_TOKEN: 'oneoff-edge', MOCK_DISCORD: '1', DISCORD_BOT_TOKEN: 'dummy' } as Env;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const call = (method: string, path: string, body?: unknown) =>
  handleAdmin(
    new Request(`https://test.invalid/api/admin${path}`, {
      method,
      headers: { Authorization: 'Bearer oneoff-edge', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    E,
  );

/** JST の壁時計で現在時刻を固定する */
const at = (date: string, hhmm: string) => {
  const [y, m, d] = date.split('/').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  vi.setSystemTime(Date.UTC(y, m - 1, d, h - 9, mi));
};

async function segment(guild = '1001', role: string | null = null, members: string[] = []) {
  const s = await createSegment(db, { guild_id: guild, name: `区分${Math.random()}`, mention_role_id: role });
  for (const id of members) {
    await db.batch([
      db.prepare('INSERT OR IGNORE INTO members(user_id,user_name,display_name) VALUES(?,?,?)').bind(id, `u${id}`, `名${id}`),
      db.prepare("INSERT INTO segment_members(segment_id,user_id,status) VALUES(?,?,'')").bind(s.id, id),
    ]);
  }
  return s;
}

const template = (segUuid: string, extra: Record<string, unknown> = {}) => ({
  guild_id: '1001',
  segment_uuid: segUuid,
  name: '単発会',
  channel_id: '2001',
  message_title: '募集',
  type: 'oneoff',
  start_time: '20:00',
  send_hour: 21,
  recruit_days_before: 7,
  remind_start_days: 3,
  remind_undecided_days: 2,
  ...extra,
});

/** 画面と同じ順で、テンプレート → 開催回 1 件を作る */
async function oneoff(extra: Record<string, unknown> = {}, occBody: Record<string, unknown> = { date: '2099/01/10', start_time: '20:00' }, members: string[] = []) {
  const s = await segment('1001', null, members);
  const body = template(s.uuid, extra);
  const res = await call('POST', '/notifications', body);
  expect(res.status).toBe(201);
  const n: any = await res.json();
  const o = await call('POST', `/notifications/${n.uuid}/occurrences`, occBody);
  expect(o.status).toBe(201);
  return { s, body, n, occ: (await o.json()) as any };
}

const occRows = async (nid: number) =>
  (await db.prepare('SELECT * FROM occurrences WHERE notification_id=? ORDER BY id').bind(nid).all<any>()).results;

const markRecruited = async (nid: number, oid: number, day = '2099/01/03') => {
  const key = { notification_id: nid, occurrence_id: oid, kind: 'recruit' as const, send_date: day };
  await claimSend(db, key);
  await finishSend(db, key, true);
};

// ---- Discord ボタン（署名して公開入口を通す）----
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
let keyPair: Promise<{ pub: string; priv: CryptoKey }> | null = null;
const keys = () =>
  (keyPair ??= (async () => {
    const p = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    return { pub: hex(new Uint8Array((await crypto.subtle.exportKey('raw', p.publicKey)) as ArrayBuffer)), priv: p.privateKey };
  })());

/** ボタンを押す。guild を渡せばサーバー内、null なら DM。返り値は ephemeral の返答と、その他の Discord 投稿 */
async function press(customId: string, userId: string, guild: string | null = '1001', roles: string[] = []) {
  const { pub, priv } = await keys();
  const user = { id: userId, username: `u${userId}` };
  const body = JSON.stringify({
    type: 3,
    application_id: 'app',
    token: 'tok',
    data: { custom_id: customId },
    ...(guild ? { guild_id: guild, member: { user, roles } } : { user }),
  });
  const ts = '1700000000';
  const sig = hex(new Uint8Array(await crypto.subtle.sign('Ed25519', priv, new TextEncoder().encode(ts + body))));
  const tasks: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => tasks.push(p) } as unknown as ExecutionContext;
  let reply = '';
  const posts: { url: string; content: string }[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const content = JSON.parse(String(init?.body ?? '{}')).content ?? '';
    if (String(url).includes('/webhooks/')) reply = content;
    else posts.push({ url: String(url), content });
    return Response.json({ id: 'm' });
  }) as typeof fetch;
  try {
    await handleInteraction(
      new Request('https://test.invalid/interactions', { method: 'POST', headers: { 'x-signature-ed25519': sig, 'x-signature-timestamp': ts }, body }),
      { ...E, DISCORD_PUBLIC_KEY: pub } as Env,
      ctx,
    );
    while (tasks.length) await tasks.shift();
  } finally {
    globalThis.fetch = orig;
  }
  return { reply, posts };
}

const responseOf = (oid: number, uid: string) =>
  db.prepare('SELECT status, post_deadline_change FROM responses WHERE occurrence_id=? AND user_id=?').bind(oid, uid).first<any>();

// ---- cron の送信を記録する ----
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
  return { take: () => sent.splice(0).sort((a, b) => a.to.localeCompare(b.to)) };
}
const tick = async () => {
  await runTick(E);
  await runTick(E);
};

// =============================================================================
describe('作成時の検証', () => {
  it('開催日が無い・形式違い・実在しない日付は 400（テンプレートだけ残る＝画面が DELETE で戻す）', async () => {
    const s = await segment();
    const n: any = await (await call('POST', '/notifications', template(s.uuid))).json();
    for (const date of [undefined, '', '2099-01-10', '2099/1/10', '2099/02/30', '2099/13/01']) {
      expect((await call('POST', `/notifications/${n.uuid}/occurrences`, { date, start_time: '20:00' })).status).toBe(400);
    }
    expect(await occRows(n.id)).toHaveLength(0);
  });

  it('見出しなし・別サーバーの区分・別サーバーのチャンネルは単発でも 400', async () => {
    const s = await segment();
    const other = await segment('9999');
    expect((await call('POST', '/notifications', template(s.uuid, { message_title: '  ' }))).status).toBe(400);
    expect((await call('POST', '/notifications', template(other.uuid))).status).toBe(400);
    expect((await call('POST', '/notifications', template(s.uuid, { channel_id: '9999' }))).status).toBe(400);
    expect((await call('POST', '/notifications', template(s.uuid, { change_alert_channel_id: '9999' }))).status).toBe(400);
  });

  it('単発のテンプレートは締切を持たない（送っても NULL）・rrule も NULL', async () => {
    const s = await segment();
    const n: any = await (await call('POST', '/notifications', template(s.uuid, { response_deadline_hours: 24, rrule: 'FREQ=DAILY' }))).json();
    expect([n.type, n.rrule, n.response_deadline_hours]).toEqual(['oneoff', null, null]);
    // 配信予定（ルール導出）は空
    expect(await (await call('GET', `/notifications/${n.uuid}/plan`)).json()).toEqual([]);
  });

  it('締切が募集より前になる・不正な値は 400、0 時間前（開始ちょうど）と負値（0 に丸め）は通る', async () => {
    const s = await segment();
    const n: any = await (await call('POST', '/notifications', template(s.uuid))).json();
    const post = (h: unknown) => call('POST', `/notifications/${n.uuid}/occurrences`, { date: '2099/01/10', start_time: '20:00', response_deadline_hours: h });
    // 募集は 2099/01/03 21:00。締切 200 時間前＝01/02 12:00 は募集より前
    expect((await post(200)).status).toBe(400);
    expect((await post('abc')).status).toBe(400);
    expect(await occRows(n.id)).toHaveLength(0);
    const ok = await post(-5);
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as any).response_deadline_hours).toBe(0);
  });

  it('流れの順序ルール: テンプレートで E1、開催回で E6（締切より後に催促開始）は 400', async () => {
    const s = await segment();
    // E1: 催促の開始（10 日前）が募集（3 日前）より前
    expect((await call('POST', '/notifications', template(s.uuid, { recruit_days_before: 3, remind_start_days: 10 }))).status).toBe(400);
    // E6: 催促 1 日前 21:00（開始の 23 時間前）・締切 48 時間前 → 1 通も送られない設定
    const n: any = await (await call('POST', '/notifications', template(s.uuid, { remind_start_days: 1, remind_undecided_enabled: false }))).json();
    const res = await call('POST', `/notifications/${n.uuid}/occurrences`, { date: '2099/01/10', start_time: '20:00', response_deadline_hours: 48 });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toContain('投稿の流れに登録できない設定');
  });

  it('告知（出欠確認なし）・手動募集の単発に締切を付けると 400', async () => {
    const s = await segment();
    const ann: any = await (await call('POST', '/notifications', template(s.uuid, { requires_response: 0 }))).json();
    expect((await call('POST', `/notifications/${ann.uuid}/occurrences`, { date: '2099/01/10', start_time: '20:00', response_deadline_hours: 1 })).status).toBe(400);
    const manual: any = await (await call('POST', '/notifications', template(s.uuid, { recruit_enabled: 0 }))).json();
    expect((await call('POST', `/notifications/${manual.uuid}/occurrences`, { date: '2099/01/10', start_time: '20:00', response_deadline_hours: 1 })).status).toBe(400);
    // 締切なしなら通る
    expect((await call('POST', `/notifications/${manual.uuid}/occurrences`, { date: '2099/01/10', start_time: '20:00' })).status).toBe(201);
  });

  it('過去の日付はサーバーでは拒否しない（画面側だけの判定・attendance-settings-matrix）。cron は過去回に何も送らない', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at('2026/10/03', '21:01');
    const { n } = await oneoff({}, { date: '2026/10/01', start_time: '20:00' });
    expect((await occRows(n.id))[0].occurrence_date).toBe('2026/10/01');
    const cap = captureSends();
    await tick();
    expect(cap.take()).toEqual([]);
  });

  // 修正済み 2026-10-11: src/admin/index.ts:747 — start_time は typeof 'string' なら検証なしで開催回に保存される。'25:99' のような時刻が
  // 単発の開始時刻になり、順序ルール・締切は 0 埋めの別時刻で判定される（flowWarnings は Number('99')||0）。
  it('開始時刻が HH:MM でなければ 400', async () => {
    const s = await segment();
    const n: any = await (await call('POST', '/notifications', template(s.uuid))).json();
    expect((await call('POST', `/notifications/${n.uuid}/occurrences`, { date: '2099/01/10', start_time: '25:99' })).status).toBe(400);
  });

  // 修正済み 2026-10-11: src/admin/index.ts:747 — start_time: '' を受け付け、開催回の start_time が '' になる。表示・cron は
  // テンプレートの start_time にフォールバックする（slotTime）ので、作成後に変えられないはずの開始時刻が
  // テンプレートの PUT で変わってしまう。登録時の締切ガードは 00:00 開始として判定される（responseDeadline の '00:00'）。
  it('開始時刻が空文字なら 400（単発の開始時刻は開催回に固定）', async () => {
    const s = await segment();
    const n: any = await (await call('POST', '/notifications', template(s.uuid))).json();
    expect((await call('POST', `/notifications/${n.uuid}/occurrences`, { date: '2099/01/10', start_time: '' })).status).toBe(400);
  });
});

// =============================================================================
describe('作成の後始末（テンプレートと開催回の同時作成）', () => {
  it('開催回の登録に失敗したテンプレートは DELETE で跡形なく消せ、開催回の無い間も cron は何も送らない', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at('2026/10/03', '21:01');
    const s = await segment('1001', null, ['3001']);
    const n: any = await (await call('POST', '/notifications', template(s.uuid, { quota_enabled: 1, quota_interval_days: 7 }))).json();
    // 締切ガードで失敗（画面はここで DELETE する）
    expect((await call('POST', `/notifications/${n.uuid}/occurrences`, { date: '2026/10/05', start_time: '20:00', response_deadline_hours: 72 })).status).toBe(400);
    expect(await occRows(n.id)).toHaveLength(0);
    const cap = captureSends();
    await tick();
    expect(cap.take()).toEqual([]);
    expect((await call('DELETE', `/notifications/${n.uuid}`)).status).toBe(200);
    expect(await db.prepare('SELECT COUNT(*) AS c FROM notifications WHERE id=?').bind(n.id).first('c')).toBe(0);
  });

  it('400 を返した開催回の POST は、中止済みの回を scheduled に戻したり回答を消したりしない', async () => {
    const { n, occ } = await oneoff({}, { date: '2099/01/10', start_time: '20:00', response_deadline_hours: 24 });
    await db.prepare("INSERT INTO responses(occurrence_id,user_id,user_name,status,updated_at) VALUES(?,'3001','a','参加','x')").bind(occ.id).run();
    expect((await call('PUT', `/occurrences/${occ.uuid}`, { status: 'cancelled' })).status).toBe(200);
    // 締切が募集より前 → 400（中止のまま・回答も残る）
    expect((await call('POST', `/notifications/${n.uuid}/occurrences`, { date: '2099/01/10', start_time: '20:00', response_deadline_hours: 500 })).status).toBe(400);
    const [row] = await occRows(n.id);
    expect(row.status).toBe('cancelled');
    expect(await responseOf(occ.id, '3001')).toBeTruthy();
  });
});

// =============================================================================
describe('作成後のロック', () => {
  it('種別は PUT で変わらない: 不定期に type=oneoff を送っても不定期のまま（開催回を 2 件持てる）', async () => {
    const s = await segment();
    const body = template(s.uuid, { type: undefined, rrule: null });
    const n: any = await (await call('POST', '/notifications', body)).json();
    expect(n.type).toBe('recurring');
    expect((await call('PUT', `/notifications/${n.uuid}`, { ...body, type: 'oneoff' })).status).toBe(200);
    expect(((await (await call('GET', `/notifications/${n.uuid}`)).json()) as any).type).toBe('recurring');
    expect((await call('POST', `/notifications/${n.uuid}/occurrences`, { date: '2099/01/10', start_time: '20:00' })).status).toBe(201);
    expect((await call('POST', `/notifications/${n.uuid}/occurrences`, { date: '2099/01/11', start_time: '20:00' })).status).toBe(201);
  });

  it('単発の開催日は中止後も PUT で変えられず、同じ日の別時刻・別の日の 2 件目は 409', async () => {
    const { n, occ } = await oneoff();
    expect((await call('PUT', `/occurrences/${occ.uuid}`, { status: 'cancelled' })).status).toBe(200);
    expect((await call('PUT', `/occurrences/${occ.uuid}`, { date: '2099/01/11' })).status).toBe(400);
    expect((await call('POST', `/notifications/${n.uuid}/occurrences`, { date: '2099/01/11', start_time: '20:00', status: 'cancelled' })).status).toBe(409);
    // start_time 省略はテンプレートの 20:00＝同じ日時なので通る
    expect((await call('POST', `/notifications/${n.uuid}/occurrences`, { date: '2099/01/10' })).status).toBe(201);
    expect(await occRows(n.id)).toHaveLength(1);
  });

  it('テンプレートの開始時刻を変えても、開催回の開始時刻はそのまま・開催回も消えない', async () => {
    const { n, body } = await oneoff();
    const r: any = await (await call('PUT', `/notifications/${n.uuid}`, { ...body, start_time: '18:00' })).json();
    expect(r.pruned).toBe(0);
    const rows = await occRows(n.id);
    expect(rows.map((o: any) => o.start_time)).toEqual(['20:00']);
  });

  it('締切を付けた単発の締切は、同じ日時の再登録で別の値に変えられない（400）', async () => {
    const { n } = await oneoff({}, { date: '2099/01/10', start_time: '20:00', response_deadline_hours: 24 });
    const res = await call('POST', `/notifications/${n.uuid}/occurrences`, { date: '2099/01/10', start_time: '20:00', response_deadline_hours: 2 });
    expect(res.status).toBe(400);
    expect((await occRows(n.id))[0].response_deadline_hours).toBe(24);
  });

  // 修正済み 2026-10-11: src/admin/index.ts:822 — 締切なしで作った開催回に、同じ日時の POST で後から締切を付けられる
  // （occ.response_deadline_hours == null のとき setOccurrenceDeadline）。CONTEXT.md「開催日・開始時刻・回答締切は作成後は変えない」、
  // attendance-settings-matrix ※4「単発は、作成時に締切を付けなかった場合も…後で付けることはできません」に反する。
  it('締切なしで作った単発に、後から締切を付けられない', async () => {
    const { n } = await oneoff();
    const res = await call('POST', `/notifications/${n.uuid}/occurrences`, { date: '2099/01/10', start_time: '20:00', response_deadline_hours: 24 });
    expect((await occRows(n.id))[0].response_deadline_hours).toBeNull();
    expect(res.status).toBe(400);
  });

  // 修正済み 2026-10-11: src/admin/index.ts:822 — 募集を投稿済みの開催回にも、同じ日時の POST で締切を追加できる。
  // ADR 0032 決定 4「募集を投稿した開催回…は日時も締切も変更できない（投稿に日時と締切が載っているため）」に反する。
  // 投稿済みの募集には締切が載っていないのに、以後の回答が「締切後の変更」として管理者に通知され、催促も止まる。
  // 不定期の「＋ 開催日時を追加」で同じ日時を入れ直しても同じ経路に入る（画面から到達可能）。
  it('募集を投稿した単発には、後から締切を付けられない（ADR 0032 の変更ロック）', async () => {
    const { n, occ } = await oneoff();
    await markRecruited(n.id, occ.id);
    await call('POST', `/notifications/${n.uuid}/occurrences`, { date: '2099/01/10', start_time: '20:00', response_deadline_hours: 24 });
    expect((await occRows(n.id))[0].response_deadline_hours).toBeNull();
  });

  // 修正済み 2026-10-11: src/admin/index.ts:752-767,819-821 — 単発の開催回 POST も送信時刻・投稿の流れ・開催時間を受け取り開催回に保存する。
  // 単発の開催回は「NULL＝テンプレートに従う」（attendance-settings-matrix の保存先表）なので、これが入ると
  // 以後のテンプレート編集（送信時刻など）が開催回に効かなくなる。API 直叩き／同じ日時の再登録で起きる（低）。
  it('単発の開催回には送信時刻・投稿の流れ・開催時間を保存しない（テンプレートに従う）', async () => {
    const { n } = await oneoff();
    await call('POST', `/notifications/${n.uuid}/occurrences`, { date: '2099/01/10', start_time: '20:00', send_hour: 5, duration_minutes: 30 });
    const [row] = await occRows(n.id);
    expect([row.send_hour, row.duration_minutes]).toEqual([null, null]);
  });

  // 修正済み 2026-10-11: src/admin/index.ts:804 と 898-904 — 単発（rrule NULL）でも origin:'rule' を受け付け、テンプレートの start_time を
  // 変える PUT が「ルール変更」として pruneRuleOccurrences を走らせ、単発の唯一の開催回を消す（開催回の無い単発＝一覧から消える）。
  // API 直叩きのみ（画面は origin を送らない）。低。
  it('origin=rule で作った単発の開催回も、テンプレートの PUT で消えない', async () => {
    const { n, body } = await oneoff({}, { date: '2099/01/10', start_time: '20:00', origin: 'rule' });
    await call('PUT', `/notifications/${n.uuid}`, { ...body, start_time: '18:00' });
    expect(await occRows(n.id)).toHaveLength(1);
  });

  it('締切が募集より前になる流れの変更・手動化は 400（単発は募集の投稿後も E3 で 400）', async () => {
    const { n, body, occ } = await oneoff({}, { date: '2099/01/10', start_time: '20:00', response_deadline_hours: 24 });
    const flowOff = { remind_unanswered_enabled: false, remind_undecided_enabled: false };
    expect((await call('PUT', `/notifications/${n.uuid}`, { ...body, ...flowOff, recruit_days_before: 0, send_hour: 8 })).status).toBe(400);
    expect((await call('PUT', `/notifications/${n.uuid}`, { ...body, recruit_enabled: 0 })).status).toBe(400);
    // 投稿の流れの順序ルール（単発は開催回の開始時刻で判定・A5-02）: 当日 21:00 の募集は 20:00 開始より後
    expect((await call('PUT', `/notifications/${n.uuid}`, { ...body, ...flowOff, recruit_days_before: 0 })).status).toBe(400);
    // 締切ガード（occurrenceFlowError）は投稿済みの回を飛ばすが、単発は開催回の開始時刻・締切で E1〜E6 を判定し直すので
    // 投稿後も締切が募集より前になる流れ（E3）は 400（A5-02）。順序ルールに掛からない変更は通る
    await markRecruited(n.id, occ.id);
    expect((await call('PUT', `/notifications/${n.uuid}`, { ...body, ...flowOff, recruit_days_before: 0, send_hour: 8 })).status).toBe(400);
    expect((await call('PUT', `/notifications/${n.uuid}`, { ...body, recruit_days_before: 5 })).status).toBe(200);
  });

  // BUG: src/admin/index.ts:749 — 「単発の開催回は 1 件だけ」を SELECT で確かめてから getOrCreateOccurrence で INSERT する
  // （確認と作成が別クエリ・DB 制約なし）。別々の日付の POST が同時に来るとどれも確認を通り、開催回が複数できる。
  // 画面は作成時に 1 回しか送らない（二重クリックは同じ日時＝UNIQUE で 1 行）ので、API の並行呼び出しでのみ起きる（低）。
  // ponytail: 確認と作成の間の競合。画面からは 1 回しか送らないので許容（直すなら INSERT … WHERE NOT EXISTS で 1 文に）
  it.fails('同時に別々の日付で開催回を POST しても、単発の開催回は 1 件だけ', async () => {
    const s = await segment();
    const n: any = await (await call('POST', '/notifications', template(s.uuid))).json();
    const res = await Promise.all(
      ['2099/01/10', '2099/01/11', '2099/01/12'].map((date) => call('POST', `/notifications/${n.uuid}/occurrences`, { date, start_time: '20:00' })),
    );
    expect(res.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await occRows(n.id)).toHaveLength(1);
  });
});

// =============================================================================
describe('中止と再登録', () => {
  it('中止した単発は回答・📣 を受け付けず、同じ日時の再登録でまっさらに戻る', async () => {
    const { n, occ } = await oneoff({}, { date: '2099/01/10', start_time: '20:00', response_deadline_hours: 24 }, ['3001']);
    expect((await press(`participate_${occ.id}`, '3001')).reply).toContain('記録しました');
    await markRecruited(n.id, occ.id);
    expect((await call('PUT', `/occurrences/${occ.uuid}`, { status: 'cancelled' })).status).toBe(200);
    expect((await press(`absent_${occ.id}`, '3001')).reply).toContain('中止');
    expect((await responseOf(occ.id, '3001')).status).toBe('参加');
    expect((await call('POST', `/occurrences/${occ.uuid}/recruit`, {})).status).toBe(400);
    // 再登録（締切なし）: 回答・投稿記録・締切が消える
    const again = await call('POST', `/notifications/${n.uuid}/occurrences`, { date: '2099/01/10', start_time: '20:00' });
    expect(again.status).toBe(201);
    expect(((await again.json()) as any).uuid).toBe(occ.uuid);
    const [row] = await occRows(n.id);
    expect([row.status, row.response_deadline_hours]).toEqual(['scheduled', null]);
    expect(await responseOf(occ.id, '3001')).toBeNull();
    expect(await db.prepare('SELECT COUNT(*) AS c FROM send_log WHERE occurrence_id=?').bind(occ.id).first('c')).toBe(0);
    // 古い投稿のボタン（同じ開催回 ID）からまた回答できる
    expect((await press(`absent_${occ.id}`, '3001')).reply).toContain('記録しました');
  });

  it('中止の取り消し（PUT status=scheduled）は回答と投稿記録を残す（再登録とは別）', async () => {
    const { n, occ } = await oneoff({}, undefined, ['3001']);
    await press(`participate_${occ.id}`, '3001');
    await markRecruited(n.id, occ.id);
    await call('PUT', `/occurrences/${occ.uuid}`, { status: 'cancelled' });
    expect((await call('PUT', `/occurrences/${occ.uuid}`, { status: 'scheduled' })).status).toBe(200);
    expect((await responseOf(occ.id, '3001')).status).toBe('参加');
    expect((await call('POST', `/occurrences/${occ.uuid}/recruit`, {})).status).toBe(409);
  });
});

// =============================================================================
describe('cron（不定期と同じ扱い）', () => {
  it('募集 → 未回答リマインド → 締切告知 を不定期と同じ日時に送り、開始後・翌日は何も送らない', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at('2026/10/03', '12:01');
    const flow = { send_hour: 21, recruit_days_before: 3, remind_start_days: 1, remind_undecided_days: 1 };
    const sa = await segment('1001', null, ['3001']);
    const sb = await segment('1001', null, ['3002']);
    const one: any = await (await call('POST', '/notifications', template(sa.uuid, { ...flow, channel_id: '2001' }))).json();
    const irr: any = await (await call('POST', '/notifications', template(sb.uuid, { ...flow, type: undefined, rrule: null, channel_id: '2002' }))).json();
    for (const n of [one, irr]) {
      expect((await call('POST', `/notifications/${n.uuid}/occurrences`, { date: '2026/10/06', start_time: '20:00', response_deadline_hours: 2 })).status).toBe(201);
    }
    const cap = captureSends();
    const step = async (d: string, t: string) => {
      at(d, t);
      await tick();
      return cap.take();
    };
    expect(await step('2026/10/03', '20:59')).toEqual([]); // 送信時刻前
    const recruit = await step('2026/10/03', '21:01');
    expect(recruit.map((x) => x.to)).toEqual(['2001', '2002']);
    for (const r of recruit) expect(r.content).toContain('回答締切: **2026/10/06 18:00**');
    expect(await step('2026/10/04', '21:01')).toEqual([]);
    expect((await step('2026/10/05', '21:01')).map((x) => x.to)).toEqual(['dm-3001', 'dm-3002']);
    expect(await step('2026/10/06', '12:01')).toEqual([]);
    const deadline = await step('2026/10/06', '18:01');
    expect(deadline.map((x) => x.to)).toEqual(['2001', '2002']);
    for (const r of deadline) expect(r.content).toContain('回答を締め切りました');
    expect(await step('2026/10/06', '21:01')).toEqual([]);
    expect(await step('2026/10/07', '21:01')).toEqual([]);
  });

  it('開始時刻を過ぎてから作った当日の単発（締切なし）には、募集もリマインドも送らない', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at('2026/10/03', '21:30');
    await oneoff({ send_hour: 9, recruit_days_before: 3, remind_start_days: 1, remind_undecided_days: 1 }, { date: '2026/10/03', start_time: '20:00' }, ['3001']);
    const cap = captureSends();
    await tick();
    expect(cap.take()).toEqual([]);
  });

  it('中止・無効（active=0）の単発には何も送らない', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at('2026/10/03', '12:01');
    const a = await oneoff({ recruit_days_before: 3 }, { date: '2026/10/06', start_time: '20:00' }, ['3001']);
    const b = await oneoff({ recruit_days_before: 3, channel_id: '2002' }, { date: '2026/10/06', start_time: '20:00' }, ['3002']);
    await call('PUT', `/occurrences/${a.occ.uuid}`, { status: 'cancelled' });
    expect((await call('POST', `/notifications/${b.n.uuid}/active`, { active: false })).status).toBe(200);
    const cap = captureSends();
    at('2026/10/03', '21:01');
    await tick();
    expect(cap.take()).toEqual([]);
  });

  it('手動募集の単発は 📣 まで何も送らず、📣 の締切指定後は締切告知まで不定期と同じ', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at('2026/10/03', '12:01');
    const { occ } = await oneoff({ recruit_enabled: 0, remind_start_days: 1, remind_undecided_days: 1 }, { date: '2026/10/06', start_time: '20:00' }, ['3001']);
    const cap = captureSends();
    at('2026/10/05', '21:01');
    await tick();
    expect(cap.take()).toEqual([]);
    // 📣（締切 2 時間前）
    expect((await call('POST', `/occurrences/${occ.uuid}/recruit`, { response_deadline_hours: 2 })).status).toBe(200);
    expect(cap.take().map((x) => x.to)).toEqual(['2001']);
    // 締切を後から変えることはできない
    expect((await call('POST', `/occurrences/${occ.uuid}/recruit`, { response_deadline_hours: 5, force: true })).status).toBe(400);
    at('2026/10/05', '21:03');
    await tick();
    expect(cap.take().map((x) => x.to)).toEqual(['dm-3001']);
    at('2026/10/06', '18:01');
    await tick();
    expect(cap.take().map((x) => x.content)).toEqual([expect.stringContaining('回答を締め切りました')]);
  });
});

// =============================================================================
describe('回答ボタン', () => {
  it('締切後の回答は記録し、締切後の変更として投稿チャンネルに通知する（締切は開催回の値）', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at('2026/10/03', '12:01');
    const { occ } = await oneoff({ recruit_days_before: 3, remind_start_days: 1, remind_undecided_days: 1 }, { date: '2026/10/06', start_time: '20:00', response_deadline_hours: 2 }, ['3001']);
    at('2026/10/05', '12:00');
    const before = await press(`participate_${occ.id}`, '3001');
    expect(before.posts).toEqual([]);
    expect(await responseOf(occ.id, '3001')).toEqual({ status: '参加', post_deadline_change: 0 });
    at('2026/10/06', '18:30');
    const after = await press(`absent_${occ.id}`, '3001');
    expect(after.reply).toContain('記録しました');
    expect(await responseOf(occ.id, '3001')).toEqual({ status: '不参加', post_deadline_change: 1 });
    expect(after.posts).toHaveLength(1);
    expect(after.posts[0].url).toContain('/channels/2001/messages');
    expect(after.posts[0].content).toContain('締切後の回答変更');
  });

  it('DM: 区分外は拒否・休止中は拒否、サーバー内: ロール外は拒否', async () => {
    const { occ, s } = await oneoff({}, undefined, ['3001']);
    expect((await press(`participate_${occ.id}`, '3999', null)).reply).toContain('対象メンバーではない');
    await setSegmentMemberStatus(db, s.id, '3001', '休止');
    expect((await press(`participate_${occ.id}`, '3001', null)).reply).toContain('休止');
    expect((await press(`participate_${occ.id}`, '3001', '1001')).reply).toContain('休止');
    expect(await responseOf(occ.id, '3001')).toBeNull();
    // ロール管理区分の単発: ロールが無いサーバー内の回答は拒否、あれば記録
    const roleSeg = await segment('1001', '4001');
    const n: any = await (await call('POST', '/notifications', template(roleSeg.uuid))).json();
    const o: any = await (await call('POST', `/notifications/${n.uuid}/occurrences`, { date: '2099/01/10', start_time: '20:00' })).json();
    expect((await press(`participate_${o.id}`, '3005', '1001', [])).reply).toContain('対象（指定ロールの保有者）ではない');
    expect((await press(`participate_${o.id}`, '3005', '1001', ['4001'])).reply).toContain('記録しました');
  });

  it('告知（出欠確認なし）に変えた単発の古いボタンは回答を受け付けない', async () => {
    const { n, body, occ } = await oneoff({}, undefined, ['3001']);
    expect((await call('PUT', `/notifications/${n.uuid}`, { ...body, requires_response: 0 })).status).toBe(200);
    expect((await press(`participate_${occ.id}`, '3001')).reply).toContain('回答を受け付けていません');
  });

  // 修正済み 2026-10-11: src/interactions/index.ts:261-294 — ボタンの interaction.guild_id とテンプレートの guild_id を照合しない。
  // 別サーバーから来た回答でも記録し、そのユーザーを元のサーバーの区分へ自動所属させる（addSegmentMember）。
  // Discord はボタンを押したメッセージの custom_id しか送らないため実際に到達する経路は乏しい＝多層防御の欠落（低）。
  it('別サーバー（guild_id 不一致）からのボタンは回答として記録しない', async () => {
    const { occ, s } = await oneoff();
    await press(`participate_${occ.id}`, '3777', '9999');
    expect(await responseOf(occ.id, '3777')).toBeNull();
    expect(await db.prepare('SELECT COUNT(*) AS c FROM segment_members WHERE segment_id=? AND user_id=?').bind(s.id, '3777').first('c')).toBe(0);
  });
});

// =============================================================================
describe('複製・削除', () => {
  it('同じ日時の単発を別に作れる（複製）。片方の中止・削除はもう片方に影響しない', async () => {
    const a = await oneoff({}, undefined, ['3001']);
    const b = await oneoff({ name: '単発会のコピー' }, undefined, ['3001']);
    expect(a.occ.id).not.toBe(b.occ.id);
    await call('PUT', `/occurrences/${a.occ.uuid}`, { status: 'cancelled' });
    expect((await press(`participate_${b.occ.id}`, '3001')).reply).toContain('記録しました');
    expect((await call('DELETE', `/notifications/${a.n.uuid}`)).status).toBe(200);
    expect((await occRows(b.n.id))[0].status).toBe('scheduled');
    expect((await responseOf(b.occ.id, '3001')).status).toBe('参加');
  });

  it('削除で開催回・回答・配置も消え、古いボタンは「見つかりません」。開催回 ID は再利用されない', async () => {
    const { n, occ } = await oneoff({}, undefined, ['3001']);
    await markRecruited(n.id, occ.id);
    await press(`participate_${occ.id}`, '3001');
    expect((await call('PUT', `/occurrences/${occ.uuid}/grouping`, { group_count: 2 })).status).toBe(200);
    expect((await call('DELETE', `/notifications/${n.uuid}`)).status).toBe(200);
    expect(await db.prepare('SELECT COUNT(*) AS c FROM occurrences WHERE id=?').bind(occ.id).first('c')).toBe(0);
    expect(await db.prepare('SELECT COUNT(*) AS c FROM responses WHERE occurrence_id=?').bind(occ.id).first('c')).toBe(0);
    expect(await db.prepare('SELECT COUNT(*) AS c FROM groupings WHERE occurrence_id=?').bind(occ.id).first('c')).toBe(0);
    expect(await db.prepare('SELECT COUNT(*) AS c FROM send_log WHERE notification_id=?').bind(n.id).first('c')).toBe(0);
    expect((await call('GET', `/occurrences/${occ.uuid}/status`)).status).toBe(404);
    expect((await press(`participate_${occ.id}`, '3001')).reply).toContain('見つかりません');
    const next = await oneoff();
    expect(next.occ.id).toBeGreaterThan(occ.id);
    expect((await call('DELETE', `/notifications/${n.uuid}`)).status).toBe(404);
  });
});

// =============================================================================
describe('サーバーの取り違え（guild_id）', () => {
  it('PUT ではサーバーを変えられず、別サーバーの区分・チャンネルへの変更は 400', async () => {
    const { n, body } = await oneoff();
    const other = await segment('9999');
    expect((await call('PUT', `/notifications/${n.uuid}`, { ...body, guild_id: '9999' })).status).toBe(200);
    expect(((await (await call('GET', `/notifications/${n.uuid}`)).json()) as any).guild_id).toBe('1001');
    expect((await call('PUT', `/notifications/${n.uuid}`, { ...body, segment_uuid: other.uuid })).status).toBe(400);
    expect((await call('PUT', `/notifications/${n.uuid}`, { ...body, channel_id: '9999' })).status).toBe(400);
    expect((await call('PUT', `/notifications/${n.uuid}`, { ...body, change_alert_channel_id: '9999' })).status).toBe(400);
    // 一覧のサーバー絞り込みに他サーバーの単発は出ない
    const list: any[] = await (await call('GET', '/notifications?guild_id=9999')).json();
    expect(list.some((x) => x.uuid === n.uuid)).toBe(false);
  });

  it('存在しない UUID・形式違いの ID は 404（単発の各エンドポイント）', async () => {
    const ghost = '00000000-0000-4000-8000-000000000000';
    for (const [m, p] of [
      ['GET', `/notifications/${ghost}`],
      ['PUT', `/notifications/${ghost}`],
      ['DELETE', `/notifications/${ghost}`],
      ['GET', `/notifications/${ghost}/occurrences`],
      ['POST', `/notifications/${ghost}/occurrences`],
      ['POST', `/notifications/${ghost}/active`],
      ['PUT', `/occurrences/${ghost}`],
      ['POST', `/occurrences/${ghost}/recruit`],
    ] as const) {
      expect((await call(m, p, m === 'GET' || m === 'DELETE' ? undefined : { date: '2099/01/10', active: true, status: 'cancelled' })).status, `${m} ${p}`).toBe(404);
    }
  });
});
