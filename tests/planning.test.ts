import { describe, it, expect, vi, afterEach } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import { blankPlan, unanswered, type Plan, type PlanData } from '../src/planning/model';
import { createPlan, getPlan, savePlan } from '../src/planning/store';
import { confirmPlan } from '../src/planning/admin';
import { planningInteraction } from '../src/planning/interactions';
import { openWebAnswer, answerRequest, ORIGIN } from './planning-web-client';
import { handlePlanningAnswer } from '../src/planning/web-answer';
import { deliverPending, deliveryStatement } from '../src/planning/delivery';
import { planningTick } from '../src/planning/cron';
import { handleAdmin } from '../src/admin';
import { getStatusBuckets, upsertResponse } from '../src/db/responses';
import { getAttendanceReport } from '../src/db/reports';
import { getGroupingView } from '../src/db/groupings';
import { recruitOccurrenceNow } from '../src/cron/tick';
import { getNotification } from '../src/db/notifications';
import { getOccurrence } from '../src/db/occurrences';

const G = '12345678901',
  db = env.DB;
const E = () => ({ ...env, MOCK_DISCORD: '1', ADMIN_TOKEN: 'planning-test-token' }) as unknown as Env;
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function fixture(count = 3): Promise<Plan> {
  await db
    .prepare("INSERT INTO segments(id,guild_id,name,uuid) VALUES(7001,?,'キャスト','plan-segment')")
    .bind(G)
    .run();
  await db
    .prepare(
      "INSERT INTO notifications(id,uuid,guild_id,segment_id,name,channel_id,type,rrule,start_time,requires_response) VALUES(7001,'plan-notification',?,7001,'キャスト日程','111111','recurring',NULL,'21:00',1)",
    )
    .bind(G)
    .run();
  for (let i = 1; i <= 5; i++) {
    await db
      .prepare('INSERT INTO members(user_id,user_name,display_name) VALUES(?,?,?)')
      .bind(`user${i}`, `name${i}`, `参加者${i}`)
      .run();
    await db
      .prepare("INSERT INTO segment_members(segment_id,user_id,status) VALUES(7001,?,'')")
      .bind(`user${i}`)
      .run();
  }
  const d: PlanData = {
    ...blankPlan('9月の開催計画'),
    state: 'open',
    schedules: [7001],
    channel: '111111',
    forum: '222222',
    deadline: '2099-09-01T00:00:00.000Z',
    candidates: Array.from({ length: count }, (_, i) => ({
      id: crypto.randomUUID(),
      date: `2099-09-${String(i + 1).padStart(2, '0')}`,
      time: '21:00',
      active: true,
    })),
    people: Array.from({ length: 5 }, (_, i) => ({
      id: `user${i + 1}`,
      name: `参加者${i + 1}`,
      schedules: [7001],
    })),
    answers: {},
    slots: [],
  };
  return createPlan(db, G, d);
}
async function answer(p: Plan, action: string, user = 'user1', arg = '0', values?: string[]) {
  const res = await planningInteraction(
    {
      type: 3,
      guild_id: G,
      member: { user: { id: user } },
      data: { custom_id: `plan:${action}:${p.id}:${arg}`, values },
    },
    E(), ORIGIN,
  );
  return { ...res, data: { ...res.data, content: JSON.stringify(res.data.components) } };
}
function call(p: Plan, action: string, body: object = {}) {
  return handleAdmin(
    new Request(`https://test.invalid/api/admin/planning/${p.id}/${action}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer planning-test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, version: p.version }),
    }),
    E(),
  );
}
async function select(p: Plan) {
  const d = structuredClone(p.data);
  d.slots = [
    {
      id: crypto.randomUUID(),
      candidate: d.candidates[0].id,
      members: d.people
        .slice(0, 3)
        .map((u) => ({ user: u.id, schedule: 7001, status: '参加' as const, duty: '' })),
      cancelled: false,
      gather: '',
      note: '',
    },
  ];
  allOk(d);
  return savePlan(db, p, d, 'selection');
}
/** Only 可 answers can be selected, so fixtures answer 可 for everyone they select. */
function allOk(d: PlanData) {
  for (const s of d.slots)
    for (const m of s.members)
      d.answers[m.user] = { ...d.answers[m.user], comment: d.answers[m.user]?.comment ?? '', values: { ...d.answers[m.user]?.values, [s.candidate]: '可' } };
}

describe('開催計画の回答・認証・履歴', () => {
  it('22候補をWeb画面で一括回答し、他人の回答を表示しない', async () => {
    const p = await fixture(22);
    p.data.answers.user2 = { values: { [p.data.candidates[0].id]: '不可' }, comment: '秘密の補足' };
    await savePlan(db, p, p.data, 'setup');
    const opened = await openWebAnswer(p, E());
    expect(opened.snapshot.candidates).toHaveLength(22);
    expect(JSON.stringify(opened.snapshot)).not.toContain('秘密の補足');
    const saved = await handlePlanningAnswer(answerRequest(p.id, opened.cookie, {
      version: opened.snapshot.version,
      values: Object.fromEntries(p.data.candidates.map((c) => [c.id, '可'])), comment: '',
    }), E());
    expect(saved.status).toBe(200);
    expect((await getPlan(db, p.id)).data.answers.user1.values[p.data.candidates[0].id]).toBe('可');
  });
  it('全候補に可・未定・不可のいずれかがあれば催促対象外', async () => {
    const p = await fixture();
    for (const status of ['可', '未定', '不可'] as const) {
      p.data.answers.user1 = {
        values: Object.fromEntries(p.data.candidates.map((c) => [c.id, status])),
        comment: '',
      };
      expect(unanswered(p.data, 'user1')).toHaveLength(0);
    }
    delete p.data.answers.user1.values[p.data.candidates[0].id];
    expect(unanswered(p.data, 'user1')).toHaveLength(1);
  });
  it('公開後の候補追加は既存回答を保持し追加分だけ未回答にする', async () => {
    let p = await fixture();
    p.data.answers.user1 = {
      values: Object.fromEntries(p.data.candidates.map((c) => [c.id, '不可' as const])),
      comment: '',
    };
    p = await savePlan(db, p, p.data, 'setup');
    const res = await call(p, 'candidates', {
      candidates: [...p.data.candidates, { date: '2099-09-20', time: '22:00' }],
    });
    expect(res.status).toBe(200);
    const next = await getPlan(db, p.id);
    expect(unanswered(next.data, 'user1')).toHaveLength(1);
    expect(next.data.answers.user1.values[p.data.candidates[0].id]).toBe('不可');
    const job = await db
      .prepare("SELECT payload FROM planning_deliveries WHERE plan_id=? AND kind='candidates'")
      .bind(p.id)
      .first<{ payload: string }>();
    expect(JSON.parse(job!.payload).content).toContain('追加1件');
    expect(JSON.parse(job!.payload).content).toContain('回答済みの内容は保持');
  });
  it('締切直前に開いた画面でも締切後の本人保存を拒否し、管理者代理変更だけ履歴付きで許可', async () => {
    let p = await fixture();
    const opened = await openWebAnswer(p, E());
    p.data.deadline = '2000-01-01T00:00:00.000Z';
    p = await savePlan(db, p, p.data, 'setup');
    const late = await handlePlanningAnswer(answerRequest(p.id, opened.cookie, {
      version: opened.snapshot.version,
      values: Object.fromEntries(p.data.candidates.map((c) => [c.id, '可'])), comment: '',
    }), E());
    expect(late.status).toBe(409);
    expect(await late.text()).toContain('締め切りました');
    expect((await getPlan(db, p.id)).data.answers.user1).toBeUndefined();
    const res = await call(p, 'answer', {
      user: 'user1',
      values: { [p.data.candidates[0].id]: '不可' },
      reason: '本人から個別連絡',
    });
    expect(res.status).toBe(200);
    const h = await db.prepare("SELECT * FROM planning_history WHERE kind='admin-answer'").first<any>();
    expect(h.user_id).toBe('user1');
    expect(h.reason).toBe('本人から個別連絡');
    expect(JSON.parse(h.before_data).answers.user1).toBeUndefined();
  });
  it('別サーバー・対象外の人を拒否し管理APIは既存認証を要求', async () => {
    const p = await fixture();
    expect((await answer(p, 'open', 'outsider')).data.content).toContain('対象者ではありません');
    expect(
      (
        await planningInteraction(
          { type: 3, guild_id: 'other', user: { id: 'user1' }, data: { custom_id: `plan:open:${p.id}:0` } },
          E(), ORIGIN,
        )
      ).data.components,
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ content: 'この回答の対象者ではありません' })]),
    );
    const res = await handleAdmin(new Request(`https://test.invalid/api/admin/planning/${p.id}`), E());
    expect(res.status).toBe(401);
  });
  it('同時編集は片方だけ成功し、負けた操作の履歴と副作用を残さない', async () => {
    const p = await fixture();
    const outcomes = await Promise.allSettled(
      ['A', 'B'].map((name) =>
        savePlan(db, p, { ...p.data, name }, 'settings', '', null, (g) => [
          deliveryStatement(db, p, g, crypto.randomUUID(), 'publish', '111111', {}),
        ]),
      ),
    );
    expect(outcomes.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect((await db.prepare('SELECT * FROM planning_history').all()).results).toHaveLength(1);
    expect((await db.prepare('SELECT * FROM planning_deliveries').all()).results).toHaveLength(1);
  });
  it('履歴の保存に失敗すると回答変更もロールバック', async () => {
    const p = await fixture();
    await db.exec(
      "CREATE TRIGGER reject_planning_history BEFORE INSERT ON planning_history BEGIN SELECT RAISE(ABORT,'test history unavailable'); END;",
    );
    try {
      await expect(savePlan(db, p, { ...p.data, name: '変更' }, 'settings')).rejects.toThrow();
      expect((await getPlan(db, p.id)).data.name).toBe(p.data.name);
    } finally {
      await db.exec('DROP TRIGGER reject_planning_history');
    }
  });
});
describe('開催枠・選定名簿と既存機能', () => {
  it('5人から3人を選定し、本人回答を捏造せず未選定者を集計から除外', async () => {
    let p = await select(await fixture());
    p = await confirmPlan(db, p, structuredClone(p.data));
    const o = await db.prepare('SELECT * FROM occurrences').first<any>();
    expect((await db.prepare('SELECT * FROM responses').all()).results).toHaveLength(0);
    const buckets = await getStatusBuckets(db, o.id, 7001);
    expect(buckets.参加).toHaveLength(3);
    expect(buckets.未回答).toEqual([]);
    await expect(upsertResponse(db, o.id, 'user4', 'name', '参加')).rejects.toThrow('代理変更');
    const report = await getAttendanceReport(db, 7001, { from: '2099/01/01', today: '2099/12/31' });
    expect(report.find((x) => x.user_id === 'user1')?.total).toBe(1);
    expect(report.find((x) => x.user_id === 'user4')?.total).toBe(0);
    const view = await getGroupingView(db, o.id);
    expect(JSON.stringify(view)).toContain('user1');
    expect(JSON.stringify(view)).not.toContain('user4');
  });
  it('確定後の名簿変更は受け付けない（名簿はDiscordで手動管理・2026-09-23）', async () => {
    let p = await select(await fixture());
    p = await confirmPlan(db, p, structuredClone(p.data));
    const slot = p.data.slots[0];
    expect((await call(p, 'roster', { slot: slot.id, members: [], reason: '全員キャンセル', cancelled: true })).status).toBe(404);
    expect((await getPlan(db, p.id)).data.slots[0]).toEqual(slot);
  });
  it('〇以外の回答の人は選定・確定できない', async () => {
    let p = await select(await fixture());
    p.data.answers.user1.values[p.data.candidates[0].id] = '未定';
    p = await savePlan(db, p, p.data, 'setup');
    expect((await call(p, 'confirm', { reason: '本人に確認済み' })).status).toBe(400);
    await expect(confirmPlan(db, p, structuredClone(p.data))).rejects.toThrow('〇以外');
  });
  it('同じ開催枠の複数区分は一つのフォーラム投稿、同日別時刻は別投稿', async () => {
    let p = await select(await fixture());
    await db
      .prepare(
        "INSERT INTO notifications(id,uuid,guild_id,segment_id,name,channel_id,type,rrule,start_time) VALUES(7002,'staff',?,7001,'スタッフ','111111','recurring',NULL,'21:00')",
      )
      .bind(G)
      .run();
    const d = structuredClone(p.data);
    d.schedules.push(7002);
    d.people[0].schedules.push(7002);
    d.slots[0].members.push({ user: 'user1', schedule: 7002, status: '参加', duty: '兼務' });
    const c = { ...d.candidates[0], id: crypto.randomUUID(), time: '22:00' };
    d.candidates.push(c);
    d.slots.push({ ...structuredClone(d.slots[0]), id: crypto.randomUUID(), candidate: c.id });
    allOk(d);
    p = await savePlan(db, p, d, 'selection');
    p = await confirmPlan(db, p, structuredClone(p.data));
    expect((await db.prepare('SELECT * FROM occurrences').all()).results).toHaveLength(4);
    const jobs = (await db.prepare('SELECT * FROM planning_deliveries').all<any>()).results;
    expect(jobs).toHaveLength(2);
    expect(JSON.parse(jobs[0].payload).message.allowed_mentions.users).toHaveLength(3);
    await expect(confirmPlan(db, p, structuredClone(p.data))).rejects.toThrow('確定できません');
  });
  it('旧募集経路は計画開催回へ投稿せず、従来開催回は維持する', async () => {
    let p = await select(await fixture());
    p = await confirmPlan(db, p, structuredClone(p.data));
    const row = await db.prepare('SELECT id FROM occurrences').first<any>();
    expect(
      await recruitOccurrenceNow(E(), (await getNotification(db, 7001))!, (await getOccurrence(db, row.id))!),
    ).toBe('failed');
  });
});
describe('投稿の再試行・周期タスク', () => {
  it('送信待ちの間に全件回答・締切・中止となった場合は古い催促を投稿しない', async () => {
    let p = await fixture();
    p = await savePlan(db, p, p.data, 'setup', '', null, (g) => [
      deliveryStatement(db, p, g, 'stale-reminder', 'reminder', p.data.channel, {
        allowed_mentions: { users: ['user1'] },
      }),
    ]);
    p.data.answers.user1 = {
      values: Object.fromEntries(p.data.candidates.map((c) => [c.id, '未定' as const])),
      comment: '',
    };
    p = await savePlan(db, p, p.data, 'setup');
    await deliverPending(E());
    expect(
      (await db.prepare("SELECT status FROM planning_deliveries WHERE id='stale-reminder'").first<any>())
        .status,
    ).toBe('cancelled');
    p = await select(p);
    p = await confirmPlan(db, p, structuredClone(p.data));
    expect((await call(p, 'cancel')).status).toBe(200);
    await deliverPending(E());
    expect(
      (await db.prepare("SELECT * FROM planning_deliveries WHERE status='sent'").all()).results,
    ).toHaveLength(0);
  });
  it('失敗の再試行は履歴付きで復旧し、送信済みフォーラムを重複作成しない', async () => {
    let p = await select(await fixture());
    p = await confirmPlan(db, p, structuredClone(p.data));
    const e = { ...E(), MOCK_DISCORD: undefined };
    const fetcher = vi.fn().mockResolvedValue(new Response('{}', { status: 403 }));
    vi.stubGlobal('fetch', fetcher);
    await deliverPending(e);
    let job = await db.prepare('SELECT * FROM planning_deliveries').first<any>();
    expect(job.status).toBe('failed');
    expect((await call(p, 'retry', { delivery: job.id })).status).toBe(200);
    fetcher.mockImplementation(
      async (_url: any, options: any) =>
        new Response(
          JSON.stringify(options.method === 'POST' ? { id: '777777', message: { id: '777777' } } : {}),
        ),
    );
    await deliverPending(e);
    job = await db.prepare('SELECT * FROM planning_deliveries').first<any>();
    expect(job.status).toBe('sent');
    p = await getPlan(db, p.id);
    expect((await call(p, 'cancel', { reason: '全体中止' })).status).toBe(200);
    fetcher.mockClear();
    await deliverPending(e);
    expect(fetcher.mock.calls.some(([, options]) => options.method === 'POST')).toBe(false);
    expect(fetcher.mock.calls.some(([, options]) => options.method === 'PATCH')).toBe(true);
  });
  it('結果不明は自動再試行せず、管理者の確認記録がある場合だけ再試行する', async () => {
    let p = await select(await fixture());
    p = await confirmPlan(db, p, structuredClone(p.data));
    await db.prepare("UPDATE planning_deliveries SET status='unknown'").run();
    const job = await db.prepare('SELECT id FROM planning_deliveries').first<any>();
    expect((await call(p, 'retry', { delivery: job.id })).status).toBe(400);
    expect((await call(p, 'retry-verified', { delivery: job.id })).status).toBe(400);
    expect(
      (
        await call(p, 'retry-verified', {
          delivery: job.id,
          verified: true,
          reason: 'フォーラムに投稿が存在しないことを確認',
        })
      ).status,
    ).toBe(200);
  });
  it('既存投稿の関連付けは同じ計画の投稿だけを受け付ける', async () => {
    let p = await select(await fixture());
    p = await confirmPlan(db, p, structuredClone(p.data));
    await db.prepare("UPDATE planning_deliveries SET status='unknown'").run();
    const job = await db.prepare('SELECT id FROM planning_deliveries').first<any>();
    const e = { ...E(), MOCK_DISCORD: undefined, DISCORD_APPLICATION_ID: '555555' };
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (url: any) =>
          new Response(
            JSON.stringify(
              String(url).includes('/messages/')
                ? { author: { id: '555555' }, embeds: [{ footer: { text: '別の計画' } }] }
                : { guild_id: G, parent_id: '222222' },
            ),
          ),
      ),
    );
    const res = await handleAdmin(
      new Request(`https://test.invalid/api/admin/planning/${p.id}/associate`, {
        method: 'POST',
        headers: { Authorization: 'Bearer planning-test-token' },
        body: JSON.stringify({ version: p.version, delivery: job.id, thread: '777777', message: '777777' }),
      }),
      e,
    );
    expect(res.status).toBe(400);
  });
  it('22開催枠をまとめて確定でき、照会数が名簿人数に比例しない', async () => {
    let p = await fixture(22);
    const d = structuredClone(p.data);
    d.slots = d.candidates.map((c) => ({
      id: crypto.randomUUID(),
      candidate: c.id,
      cancelled: false,
      gather: '',
      note: '',
      members: d.people.map((u) => ({ user: u.id, schedule: 7001, status: '参加' as const, duty: '' })),
    }));
    allOk(d);
    p = await savePlan(db, p, d, 'selection');
    const spy = vi.spyOn(db, 'prepare');
    await confirmPlan(db, p, structuredClone(p.data));
    expect(spy.mock.calls.length).toBeLessThan(15);
    spy.mockRestore();
    expect((await db.prepare('SELECT COUNT(*) AS n FROM planning_roster').first<any>()).n).toBe(110);
  });
  // JST calendar date, and a fetch stub that records Discord posts (the creator reminder posts directly, not via the queue).
  const jstDate = (offsetDays = 0) => new Date(Date.now() + 9 * 3600000 + offsetDays * 86400000).toISOString().slice(0, 10);
  function discordCalls() {
    const calls: { path: string; method: string; body: any }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ path: new URL(String(url)).pathname, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return Response.json({ id: '999999', thread_metadata: { archived: false } });
    }));
    return calls;
  }
  it('停止中は催促せず、再開後は過去の期限を投稿せずに次の期限へ進む', async () => {
    await fixture();
    const calls = discordCalls();
    const data = {
      name: '毎月調整',
      schedules: [7001],
      channel: '111111',
      forum: '222222',
      tag: '',
      rrule: 'FREQ=MONTHLY;BYMONTHDAY=1',
      anchor: '2000-01-01',
      time: '00:00',
      adminChannel: '333333',
      mentionMode: 'users',
      mentions: ['555555'],
      taskReminderDays: 0,
      origin: 'https://test.invalid',
    };
    await db
      .prepare('INSERT INTO planning_cycles(id,guild_id,data,next_date,enabled) VALUES(?,?,?,?,0)')
      .bind('paused', G, JSON.stringify(data), '2000-01-01')
      .run();
    const real = { ...E(), MOCK_DISCORD: undefined };
    await planningTick(real);
    expect((await db.prepare("SELECT next_date FROM planning_cycles WHERE id='paused'").first<any>()).next_date).toBe('2000-01-01');
    await db.prepare('UPDATE planning_cycles SET enabled=1').run();
    await planningTick(real);
    await planningTick(real);
    const row = await db.prepare("SELECT next_date,task_status FROM planning_cycles WHERE id='paused'").first<any>();
    expect(row.next_date >= jstDate()).toBe(true); // Stale due dates are skipped, never replayed.
    expect(row.task_status).toBe('pending');
    expect(calls.filter((c) => c.path.endsWith('/channels/333333/messages'))).toHaveLength(0);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM planning_plans').first<any>()).n).toBe(1); // No draft is created.
  });
  it('旧一括・ラジオ・下書き保存は新しい画面へ案内し、回答を上書きしない', async () => {
    const p = await fixture();
    await call(p, 'answer', { user: 'user1', values: { [p.data.candidates[0].id]: '可' } });
    for (const action of ['bulk', 'mode', 'radio', 'radio-save', 'set', 'save', 'comment-save']) {
      const result = await answer(p, action, 'user1', '0', ['不可|all']);
      expect(result.data.components.some((x: any) => x.type === 10)).toBe(true);
    }
    expect((await getPlan(db, p.id)).data.answers.user1.values[p.data.candidates[0].id]).toBe('可');
  });
  it('確定の連打でも重複せず、結果不明のフォーラム投稿は次の更新も止める', async () => {
    let p = await select(await fixture());
    const both = await Promise.allSettled([
      confirmPlan(db, p, structuredClone(p.data)),
      confirmPlan(db, p, structuredClone(p.data)),
    ]);
    expect(both.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    p = await getPlan(db, p.id);
    const fetcher = vi.fn().mockRejectedValue(new Error('connection reset'));
    vi.stubGlobal('fetch', fetcher);
    const e = { ...E(), MOCK_DISCORD: undefined };
    await deliverPending(e);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const first = await db.prepare('SELECT status FROM planning_deliveries').first<any>();
    expect(first.status).toBe('unknown');
    await call(p, 'cancel', { reason: '全体中止' });
    await deliverPending(e);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('リマインドは期限まで毎日投稿し、テンプレートの回答案内が投稿されると止まり、期限を過ぎると次の期限へ進む', async () => {
    const p0 = await fixture();
    const calls = discordCalls();
    const today = jstDate(0), due = jstDate(2);
    const cycle = {
      name: '隔月調整',
      schedules: [7001],
      channel: '111111',
      forum: '222222',
      tag: '',
      rrule: `FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=${Number(due.slice(8))}`,
      anchor: due,
      time: '00:00',
      adminChannel: '333333',
      mentionMode: 'roles',
      mentions: ['444444'],
      taskReminderDays: 3,
      origin: 'https://test.invalid',
    };
    await db
      .prepare('INSERT INTO planning_cycles(id,guild_id,data,next_date) VALUES(?,?,?,?)')
      .bind('cycle1', G, JSON.stringify(cycle), due)
      .run();
    const real = { ...E(), MOCK_DISCORD: undefined };
    const posts = () => calls.filter((c) => c.path.endsWith('/channels/333333/messages') && c.method === 'POST');
    const row = () => db.prepare("SELECT next_date,task_status,reminded_on FROM planning_cycles WHERE id='cycle1'").first<any>();
    await planningTick(real);
    await planningTick(real);
    expect(posts()).toHaveLength(1); // Two ticks on the same day post once.
    expect((await db.prepare('SELECT COUNT(*) AS n FROM planning_plans').first<any>()).n).toBe(1); // No draft is created.
    expect(posts()[0].body.allowed_mentions.roles).toEqual(['444444']);
    expect(posts()[0].body.content).toContain(`回答案内の投稿期限: ${due.replace(/-/g, '/')}`);
    expect(posts()[0].body.content.endsWith(`/admin#g/${G}/planning`)).toBe(true);
    expect(await row()).toEqual({ next_date: due, task_status: 'pending', reminded_on: today });
    await db.prepare("UPDATE planning_cycles SET reminded_on='2000-01-01'").run(); // Yesterday's reminder.
    await planningTick(real);
    expect(posts()).toHaveLength(2);
    // Publishing a 日程調整 made from the template completes the reminder for this due date, but only once the post is delivered.
    const p = await createPlan(db, G, { ...p0.data, state: 'draft', profileId: 'cycle1', deadline: '2099-08-01T00:00:00.000Z' });
    expect((await call(p, 'publish')).status).toBe(200);
    expect((await row()).task_status).toBe('pending');
    await deliverPending(real);
    expect((await row()).task_status).toBe('complete');
    await db.prepare("UPDATE planning_cycles SET reminded_on='2000-01-01'").run();
    await planningTick(real);
    expect(posts()).toHaveLength(2);
    // Past the due date: the next due date is picked up and, being inside the lead already, reminded right away.
    await db.prepare('UPDATE planning_cycles SET next_date=?').bind(jstDate(-1)).run();
    await planningTick(real);
    expect(await row()).toEqual({ next_date: due, task_status: 'pending', reminded_on: today });
    expect(posts()).toHaveLength(3);
  });
  it('担当者催促は 1 回 5 件まで。残りは次の周期に送り、同じ日に二重送信しない（ADR 0033）', async () => {
    const calls = discordCalls();
    const due = jstDate(1);
    const cycle = {
      name: '毎月調整', schedules: [], channel: '111111', forum: '222222', tag: '',
      rrule: `FREQ=MONTHLY;BYMONTHDAY=${Number(due.slice(8))}`, anchor: due, time: '00:00',
      adminChannel: '333333', mentionMode: 'users', mentions: [], taskReminderDays: 3, origin: 'https://test.invalid',
    };
    for (let i = 0; i < 7; i++)
      await db
        .prepare('INSERT INTO planning_cycles(id,guild_id,data,next_date) VALUES(?,?,?,?)')
        .bind(`cycle${i}`, G, JSON.stringify(cycle), due)
        .run();
    const real = { ...E(), MOCK_DISCORD: undefined };
    const posts = () => calls.filter((c) => c.path.endsWith('/channels/333333/messages') && c.method === 'POST');
    await planningTick(real);
    expect(posts()).toHaveLength(5);
    await planningTick(real);
    expect(posts()).toHaveLength(7);
    await planningTick(real);
    expect(posts()).toHaveLength(7);
  });
  it('全件未定は催促せず部分回答者だけを対象にする', async () => {
    let p = await fixture();
    p.data.remindDays = 1;
    p.data.answers.user1 = {
      values: Object.fromEntries(p.data.candidates.map((c) => [c.id, '未定' as const])),
      comment: '',
    };
    p = await savePlan(db, p, p.data, 'setup', '', null, (g) => [
      deliveryStatement(db, p, g, 'oldpublish', 'publish', p.data.channel, {}),
    ]);
    await db
      .prepare("UPDATE planning_deliveries SET created_at='2000-01-01T00:00:00.000Z',status='sent'")
      .run();
    const fetcher = vi.fn().mockResolvedValue(new Response('{"id":"777777"}'));
    vi.stubGlobal('fetch', fetcher);
    await planningTick({ ...E(), MOCK_DISCORD: undefined });
    const jobs = (
      await db.prepare("SELECT payload FROM planning_deliveries WHERE kind='reminder'").all<any>()
    ).results;
    expect(jobs).toHaveLength(1);
    expect(JSON.parse(jobs[0].payload).allowed_mentions.users).toEqual(['user2', 'user3', 'user4', 'user5']);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const posted = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(posted.allowed_mentions).toEqual({ parse: [], users: ['user2', 'user3', 'user4', 'user5'] });
    expect(posted.content).toContain('回答締切');
    expect(posted.content).toContain('09:00');
    expect(posted.content).toContain('ボタンから続きの回答');
    expect(posted.content).toContain('回答済みの内容は保持されています。');
    expect(posted.components[0].components[0].custom_id).toBe(`plan:open:${p.id}:0`);
  });
  it('旧形式の催促ジョブも投稿時の回答状況と最新の本文で処理する', async () => {
    let p = await fixture();
    p = await savePlan(db, p, p.data, 'setup', '', null, (g) => [
      deliveryStatement(db, p, g, 'legacy-reminder', 'reminder', p.data.channel, {
        content: '古い案内文',
        components: [],
        allowed_mentions: { users: ['user1', 'user2'] },
      }),
    ]);
    p.data.name = '更新した日程調整';
    p.data.answers.user1 = {
      values: Object.fromEntries(p.data.candidates.map((c) => [c.id, '未定' as const])),
      comment: '',
    };
    p = await savePlan(db, p, p.data, 'setup');
    const fetcher = vi.fn().mockResolvedValue(new Response('{"id":"777777"}'));
    vi.stubGlobal('fetch', fetcher);
    await deliverPending({ ...E(), MOCK_DISCORD: undefined });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const posted = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(posted.allowed_mentions).toEqual({ parse: [], users: ['user2'] });
    expect(posted.content).toContain('更新した日程調整');
    expect(posted.content).not.toContain('古い案内文');
    expect(posted.content).not.toContain('<@user1>');
    expect(posted.components[0].components[0].custom_id).toBe(`plan:open:${p.id}:0`);
  });
  it('新旧の周期設定で同じ入力検証を行い、新方式の無効時だけ省略する', async () => {
    await fixture();
    const data = {
      name: '周期設定',
      schedules: [7001],
      segments: [7001],
      channel: '111111',
      forum: '222222',
      tag: '',
      rrule: 'FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=1',
      anchor: '2099-01-01',
      time: '21:00',
      adminChannel: '333333',
      mentionMode: 'users',
      mentions: ['555555'],
      retryDays: 3,
    };
    await db
      .prepare('INSERT INTO planning_cycles(id,guild_id,data,next_date) VALUES(?,?,?,?)')
      .bind('legacy-cycle', G, JSON.stringify(data), data.anchor)
      .run();
    const post = (endpoint: string, input: object, enabled: boolean) =>
      handleAdmin(
        new Request(`https://test.invalid/api/admin/planning/${endpoint}`, {
          method: 'POST',
          headers: { Authorization: 'Bearer planning-test-token', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: endpoint === 'cycles' ? 'legacy-cycle' : 'new-profile',
            guild_id: G,
            data: input,
            enabled,
          }),
        }),
        E(),
      );
    for (const endpoint of ['profiles', 'cycles']) {
      expect((await post(endpoint, data, true)).status).toBe(200);
      for (const invalid of [
        { rrule: 'invalid' },
        { anchor: '2099-01-02' },
        { time: '25:00' },
        { taskReminderDays: -1 },
        { taskReminderDays: 31 },
        { mentionMode: 'everyone' },
        { mentions: [] },
        { mentions: ['invalid'] },
      ]) {
        const response = await post(endpoint, { ...data, ...invalid }, true);
        expect(response.status, JSON.stringify({ endpoint, invalid })).toBe(400);
        expect(await response.json()).toHaveProperty('error');
      }
    }
    const disabled = { ...data, rrule: '', anchor: '', time: '', mentions: [], taskReminderDays: -1 };
    expect((await post('profiles', disabled, false)).status).toBe(200);
    expect((await post('cycles', disabled, false)).status).toBe(400);
  });
});
