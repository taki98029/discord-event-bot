// 管理 API のテンプレート保存・削除・開催回追加のサーバー側ガード（2026-10 リリース前レビュー P2-04〜07・P2-18）
import { afterEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import { handleAdmin } from '../src/admin';
import { createSegment } from '../src/db/segments';
import { countingD1 } from '../src/cron/tick';

afterEach(() => vi.unstubAllGlobals());

const E = { ...env, ADMIN_TOKEN: 'guard-test', MOCK_DISCORD: '1', DISCORD_BOT_TOKEN: 'dummy' } as Env;
const call = (method: string, path: string, body?: unknown) =>
  handleAdmin(
    new Request(`https://test.invalid/api/admin${path}`, {
      method,
      headers: { Authorization: 'Bearer guard-test', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    E,
  );
const setup = async (extra: Record<string, unknown> = {}) => {
  const s = await createSegment(env.DB, { guild_id: '1001', name: '対象者', mention_role_id: null });
  const body = { guild_id: '1001', segment_uuid: s.uuid, name: '会', channel_id: '2001', message_title: '募集', start_time: '20:00', send_hour: 21, recruit_days_before: 7, remind_start_days: 3, remind_undecided_days: 2, ...extra };
  const res = await call('POST', '/notifications', body);
  expect(res.status).toBe(201);
  return { body, n: (await res.json()) as any };
};

it('P2-04: 定期と不定期は PUT で切り替えられない', async () => {
  const { body, n } = await setup({ rrule: null });
  expect((await call('PUT', `/notifications/${n.uuid}`, { ...body, rrule: 'FREQ=WEEKLY;BYDAY=SA' })).status).toBe(400);
  const r = await setup({ rrule: 'FREQ=WEEKLY;BYDAY=SA' });
  expect((await call('PUT', `/notifications/${r.n.uuid}`, { ...r.body, rrule: null })).status).toBe(400);
  expect((await call('PUT', `/notifications/${r.n.uuid}`, { ...r.body, rrule: 'FREQ=WEEKLY;BYDAY=SU' })).status).toBe(200);
});

it('P2-05: 締切を付けた未投稿の回は、雛形の変更で締切が募集より前になる・募集が手動になる保存を 400', async () => {
  // 不定期で見る（単発は開始時刻と締切を開催回に持つため、同じ変更が順序ルール E3/E4 で常に 400 になる・A5-02）
  const { body, n } = await setup({ rrule: null });
  expect((await call('POST', `/notifications/${n.uuid}/occurrences`, { date: '2099/01/10', start_time: '20:00', response_deadline_hours: 24 })).status).toBe(201);
  // 変更の無い保存・影響の無い変更は通る
  expect((await call('PUT', `/notifications/${n.uuid}`, body)).status).toBe(200);
  expect((await call('PUT', `/notifications/${n.uuid}`, { ...body, recruit_days_before: 3 })).status).toBe(200);
  // 催促を切って順序ルール（E1）に掛からない形で、締切ガードだけを見る
  const late = await call('PUT', `/notifications/${n.uuid}`, { ...body, recruit_days_before: 0, remind_unanswered_enabled: false, remind_undecided_enabled: false });
  expect(late.status).toBe(400);
  expect(((await late.json()) as any).error).toContain('募集の投稿予定');
  const manual = await call('PUT', `/notifications/${n.uuid}`, { ...body, recruit_enabled: false });
  expect(manual.status).toBe(400);
  expect(((await manual.json()) as any).error).toContain('手動投稿');
  // 募集を投稿済みなら流れを変えても投稿は出直さないので通す
  const occ = await env.DB.prepare('SELECT id FROM occurrences WHERE notification_id=?').bind(n.id).first<{ id: number }>();
  await env.DB.prepare("INSERT INTO send_log(notification_id,occurrence_id,user_id,kind,send_date,status,created_at) VALUES(?,?,'','recruit','2099/01/03','sent','2099-01-03T12:00:00Z')").bind(n.id, occ!.id).run();
  expect((await call('PUT', `/notifications/${n.uuid}`, { ...body, recruit_days_before: 0, remind_unanswered_enabled: false, remind_undecided_enabled: false })).status).toBe(200);
});

it('P2-05: 開催回側に流れを持つ不定期の回は雛形の変更の影響を受けない', async () => {
  const { body, n } = await setup({ rrule: null });
  expect((await call('POST', `/notifications/${n.uuid}/occurrences`, { date: '2099/01/10', start_time: '20:00', recruit_enabled: 1, recruit_days_before: 7, response_deadline_hours: 24 })).status).toBe(201);
  expect((await call('PUT', `/notifications/${n.uuid}`, { ...body, rrule: null, recruit_days_before: 0, remind_unanswered_enabled: false, remind_undecided_enabled: false })).status).toBe(200);
  expect((await call('PUT', `/notifications/${n.uuid}`, { ...body, rrule: null, recruit_enabled: false })).status).toBe(200);
});

it('P2-06: 日程調整で使用中のテンプレートの削除は 409', async () => {
  const { n } = await setup({ rrule: 'FREQ=WEEKLY;BYDAY=SA' });
  await env.DB.prepare("INSERT INTO planning_plans(id,guild_id,data,mutation,created_at,updated_at) VALUES('p-guard','1001',?,'m','2026-10-03','2026-10-03')").bind(JSON.stringify({ schedules: [n.id] })).run();
  const res = await call('DELETE', `/notifications/${n.uuid}`);
  expect(res.status).toBe(409);
  expect(((await res.json()) as any).error).toBe('日程調整で使用中のテンプレートは削除できません。無効化してください。');
  expect((await call('GET', `/notifications/${n.uuid}`)).status).toBe(200);
});

it('P2-07: 区分は同じサーバーのものだけ・PUT ではサーバーを変えられない', async () => {
  const other = await createSegment(env.DB, { guild_id: '9999', name: '別', mention_role_id: null });
  const { body, n } = await setup({ rrule: 'FREQ=WEEKLY;BYDAY=SA' });
  expect((await call('POST', '/notifications', { ...body, segment_uuid: other.uuid })).status).toBe(400);
  expect((await call('PUT', `/notifications/${n.uuid}`, { ...body, segment_uuid: other.uuid })).status).toBe(400);
  expect((await call('PUT', `/notifications/${n.uuid}`, { ...body, guild_id: '9999' })).status).toBe(200);
  expect(((await (await call('GET', `/notifications/${n.uuid}`)).json()) as any).guild_id).toBe('1001');
});

it('P2-18: 単発出欠確認の開催回は 1 件だけ（中止した回の同じ日時での登録し直しは通す）', async () => {
  const { n } = await setup({ type: 'oneoff' });
  const first = await call('POST', `/notifications/${n.uuid}/occurrences`, { date: '2099/02/07', start_time: '20:00' });
  expect(first.status).toBe(201);
  const occ = (await first.json()) as any;
  expect((await call('POST', `/notifications/${n.uuid}/occurrences`, { date: '2099/02/14', start_time: '20:00' })).status).toBe(409);
  expect((await call('PUT', `/occurrences/${occ.uuid}`, { status: 'cancelled' })).status).toBe(200);
  expect((await call('POST', `/notifications/${n.uuid}/occurrences`, { date: '2099/02/07', start_time: '21:00' })).status).toBe(409);
  expect((await call('POST', `/notifications/${n.uuid}/occurrences`, { date: '2099/02/07', start_time: '20:00' })).status).toBe(201);
});

it('P3: 壊れた JSON は 400、存在しない日付は 400、同じ日時への変更は 409', async () => {
  const bad = await handleAdmin(
    new Request('https://test.invalid/api/admin/notifications', {
      method: 'POST',
      headers: { Authorization: 'Bearer guard-test', 'Content-Type': 'application/json' },
      body: '{not json',
    }),
    E,
  );
  expect(bad.status).toBe(400);
  const { n } = await setup({ rrule: null });
  expect((await call('POST', `/notifications/${n.uuid}/occurrences`, { date: '2099/02/31' })).status).toBe(400);
  const a: any = await (await call('POST', `/notifications/${n.uuid}/occurrences`, { date: '2099/03/01' })).json();
  const b: any = await (await call('POST', `/notifications/${n.uuid}/occurrences`, { date: '2099/03/02' })).json();
  expect((await call('PUT', `/occurrences/${a.uuid}`, { date: 'garbage' })).status).toBe(400);
  expect((await call('PUT', `/occurrences/${a.uuid}`, { date: '2099/03/02' })).status).toBe(409);
  expect(b.uuid).toBeTruthy();
});

it('P3: メンバー配置は、パスの開催回に属するグループだけを書き換える', async () => {
  const { n } = await setup({ rrule: null });
  const a: any = await (await call('POST', `/notifications/${n.uuid}/occurrences`, { date: '2099/04/01' })).json();
  const b: any = await (await call('POST', `/notifications/${n.uuid}/occurrences`, { date: '2099/04/02' })).json();
  const ga: any = await (await call('PUT', `/occurrences/${a.uuid}/grouping`, { group_count: 1 })).json();
  const gb: any = await (await call('PUT', `/occurrences/${b.uuid}/grouping`, { group_count: 1 })).json();
  const groupB = gb.groups[0].uuid;
  // 開催回 A のパスに B のグループを渡す → 無視・拒否
  await call('PUT', `/occurrences/${a.uuid}/grouping/members`, { assignments: [{ group_uuid: groupB, members: [{ user_id: '5001', label: null }] }] });
  const after: any = await (await call('GET', `/occurrences/${b.uuid}/grouping`)).json();
  expect(after.groups[0].members).toEqual([]);
  expect((await call('PUT', `/occurrences/${a.uuid}/grouping/move`, { user_id: '5001', to_group_uuid: groupB })).status).toBe(400);
  expect((await call('PUT', `/occurrences/${a.uuid}/grouping/rename`, { group_uuid: groupB, name: 'x' })).status).toBe(404);
  expect(ga.groups).toHaveLength(1);
});

// ---- 2026-10 再レビュー ----

it('A3-01: 14 グループのメンバー配置の保存は D1 50 回未満（作成・移動・名前変更も）', async () => {
  const { n } = await setup({ rrule: null });
  const occ: any = await (await call('POST', `/notifications/${n.uuid}/occurrences`, { date: '2099/05/01' })).json();
  const used = { n: 0 };
  const counted = { ...E, DB: countingD1(env.DB, used) } as Env;
  const callCounted = async (method: string, path: string, body: unknown) => {
    used.n = 0;
    const res = await handleAdmin(
      new Request(`https://test.invalid/api/admin${path}`, {
        method,
        headers: { Authorization: 'Bearer guard-test', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
      counted,
    );
    expect(res.status).toBe(200);
    expect(-used.n).toBeLessThan(50);
    return (await res.json()) as any;
  };
  const created = await callCounted('PUT', `/occurrences/${occ.uuid}/grouping`, { group_count: 14 });
  expect(created.groups).toHaveLength(14);
  const assignments = created.groups.map((g: any, i: number) => ({
    group_uuid: g.uuid,
    members: [{ user_id: `60${i}a`, label: null }, { user_id: `60${i}b`, label: i === 0 ? 'リーダー' : null }],
  }));
  const saved = await callCounted('PUT', `/occurrences/${occ.uuid}/grouping/members`, { assignments });
  expect(saved.groups.map((g: any) => g.members.map((m: any) => m.user_id))).toEqual(created.groups.map((_: any, i: number) => [`60${i}a`, `60${i}b`]));
  expect(saved.groups[0].members[1].label).toBe('リーダー');
  const moved = await callCounted('PUT', `/occurrences/${occ.uuid}/grouping/move`, { user_id: '600a', to_group_uuid: created.groups[13].uuid });
  expect(moved.groups[13].members.map((m: any) => m.user_id)).toEqual(['6013a', '6013b', '600a']);
  await callCounted('PUT', `/occurrences/${occ.uuid}/grouping/rename`, { group_uuid: created.groups[5].uuid, name: '班6' });
  const fewer = await callCounted('PUT', `/occurrences/${occ.uuid}/grouping`, { group_count: 3 });
  expect(fewer.groups.map((g: any) => g.name)).toEqual(['グループ 1', 'グループ 2', 'グループ 3']);
  expect((await callCounted('PUT', `/occurrences/${occ.uuid}/grouping`, { group_count: 100 })).groups).toHaveLength(100);
});

it('A3-02: 投稿先・変更通知先・配置発表先は同じサーバーのチャンネルだけ（取得失敗なら照合しない）', async () => {
  const { body, n } = await setup({ rrule: 'FREQ=WEEKLY;BYDAY=SA' });
  const msg = 'チャンネルはテンプレートと同じサーバーのものを選んでください。';
  const bad = await call('POST', '/notifications', { ...body, channel_id: '9999' });
  expect(bad.status).toBe(400);
  expect(((await bad.json()) as any).error).toBe(msg);
  expect((await call('POST', '/notifications', { ...body, change_alert_channel_id: '9999' })).status).toBe(400);
  expect((await call('PUT', `/notifications/${n.uuid}`, { ...body, channel_id: '9999' })).status).toBe(400);
  expect((await call('PUT', `/notifications/${n.uuid}`, { ...body, change_alert_channel_id: '9999' })).status).toBe(400);
  expect((await call('PUT', `/notifications/${n.uuid}`, { ...body, change_alert_channel_id: '2003' })).status).toBe(200);
  expect((await call('PUT', `/notifications/${n.uuid}/grouping-channel`, { channel_id: '9999' })).status).toBe(400);
  expect((await call('PUT', `/notifications/${n.uuid}/grouping-channel`, { channel_id: '2002' })).status).toBe(200);
  // 保存済みのチャンネルが一覧に無くなっても、変えていなければ他の項目は保存できる
  await env.DB.prepare("UPDATE notifications SET channel_id='8888' WHERE id=?").bind(n.id).run();
  expect((await call('PUT', `/notifications/${n.uuid}`, { ...body, channel_id: '8888', name: '改名' })).status).toBe(200);
  // Discord から一覧を取れないときは保存を止めない
  vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 500 })));
  const offline = { ...E, MOCK_DISCORD: undefined } as Env;
  const res = await handleAdmin(
    new Request('https://test.invalid/api/admin/notifications', {
      method: 'POST',
      headers: { Authorization: 'Bearer guard-test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, channel_id: '9999' }),
    }),
    offline,
  );
  expect(res.status).toBe(201);
});

it('A3-03: 単発出欠確認の開催日は PUT で変えられない', async () => {
  const { n } = await setup({ type: 'oneoff' });
  const occ: any = await (await call('POST', `/notifications/${n.uuid}/occurrences`, { date: '2099/06/06', start_time: '20:00' })).json();
  const res = await call('PUT', `/occurrences/${occ.uuid}`, { date: '2099/06/13' });
  expect(res.status).toBe(400);
  expect(((await res.json()) as any).error).toBe('単発出欠確認の開催日は作成後に変更できません。別の日にするときは新しく作ってください。');
  expect((await (await call('GET', `/notifications/${n.uuid}/occurrences`)).json() as any)[0].occurrence_date).toBe('2099/06/06');
});

it('A5-02: 単発は開催回の開始時刻で順序ルールを判定する（当日 21:00 募集・開始 10:00 は 400）', async () => {
  const flowOff = { recruit_days_before: 0, remind_unanswered_enabled: false, remind_undecided_enabled: false };
  // 開催回の POST: 流れの項目を送らなくてもテンプレートの流れで判定する
  const late = await setup({ type: 'oneoff', start_time: '10:00', send_hour: 21, ...flowOff });
  const res = await call('POST', `/notifications/${late.n.uuid}/occurrences`, { date: '2099/07/04', start_time: '10:00' });
  expect(res.status).toBe(400);
  expect(((await res.json()) as any).error).toContain('開催開始（10:00）より後の投稿');
  // テンプレートの PUT: 開催回の開始時刻で判定する
  const ok = await setup({ type: 'oneoff', start_time: '10:00', send_hour: 9, ...flowOff });
  expect((await call('POST', `/notifications/${ok.n.uuid}/occurrences`, { date: '2099/07/04', start_time: '10:00' })).status).toBe(201);
  expect((await call('PUT', `/notifications/${ok.n.uuid}`, { ...ok.body, send_hour: 21 })).status).toBe(400);
  expect((await call('PUT', `/notifications/${ok.n.uuid}`, { ...ok.body, send_hour: 8 })).status).toBe(200);
  // 不定期の雛形は従来どおり 23:59 扱い（開催回ごとに時刻が違う）。setup が 201 を確かめる
  const irr = await setup({ rrule: null, start_time: '10:00', send_hour: 21, ...flowOff });
  expect((await call('PUT', `/notifications/${irr.n.uuid}`, irr.body)).status).toBe(200);
});

it('ペア制約の一覧は人数によらず少ない D1 呼び出しで、サーバーごとの表示名を付けて返す', async () => {
  const { n } = await setup({ rrule: null });
  const ids = Array.from({ length: 60 }, (_, i) => String(6100 + i));
  await env.DB.batch([
    ...ids.map((id) => env.DB.prepare('INSERT INTO members(user_id,user_name,display_name) VALUES(?,?,?)').bind(id, `u${id}`, `全体${id}`)),
    env.DB.prepare("INSERT INTO member_guild_profiles(user_id,guild_id,display_name) VALUES('6100','1001','サーバー名')"),
  ]);
  for (let i = 0; i < ids.length; i += 2) {
    expect((await call('POST', `/notifications/${n.uuid}/constraints`, { user_id_a: ids[i], user_id_b: ids[i + 1] })).status).toBe(201);
  }
  const used = { n: 0 };
  const res = await handleAdmin(
    new Request(`https://test.invalid/api/admin/notifications/${n.uuid}/constraints`, { headers: { Authorization: 'Bearer guard-test' } }),
    { ...E, DB: countingD1(env.DB, used) } as Env,
  );
  const list: any[] = await res.json();
  expect(list).toHaveLength(30);
  expect(-used.n).toBeLessThan(10);
  expect(list[0].user_a_name).toBe('サーバー名');
  expect(list[0].user_b_name).toBe('全体6101');
});
