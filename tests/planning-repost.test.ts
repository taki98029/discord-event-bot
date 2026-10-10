import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import { handleAdmin } from '../src/admin';
import { blankPlan, type Plan, type PlanData } from '../src/planning/model';
import { createPlan, getPlan, savePlan } from '../src/planning/store';
import { deliverPending, deliveryStatement } from '../src/planning/delivery';
import { openWebAnswer } from './planning-web-client';

const db = env.DB;
const E = { ...env, MOCK_DISCORD: '1', ADMIN_TOKEN: 'planning-repost-test' } as unknown as Env;
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function fixture(overrides: Partial<PlanData> = {}) {
  return createPlan(db, '12345678901', {
    ...blankPlan('9月の日程調整'),
    state: 'open',
    standalone: true,
    segments: [1],
    schedules: [],
    channel: '111111',
    forum: '222222',
    deadline: '2099-09-01T00:00:00.000Z',
    candidates: [{ id: 'candidate1', date: '2099-09-10', time: '19:00', active: true }],
    people: [{ id: 'user1', name: '回答者', schedules: [1] }],
    answers: { user1: { values: { candidate1: '可' }, comment: '補足を保持' } },
    answerRevisions: { user1: { values: { candidate1: 1 }, comment: 1 } },
    ...overrides,
  });
}
function call(p: Plan, action = 'repost', body: object = {}, runtime = E) {
  return handleAdmin(
    new Request(`https://test.invalid/api/admin/planning/${p.id}/${action}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer planning-repost-test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: p.version, ...body }),
    }),
    runtime,
  );
}
async function jobs(p: Plan) {
  return (
    await db.prepare('SELECT * FROM planning_deliveries WHERE plan_id=? ORDER BY rowid').bind(p.id).all<any>()
  ).results;
}
async function enqueue(p: Plan, kind: string, status = 'pending') {
  const id = crypto.randomUUID();
  p = await savePlan(db, p, p.data, 'setup', '', null, (g) => [
    deliveryStatement(db, p, g, id, kind, p.data.channel, {}),
  ]);
  await db.prepare('UPDATE planning_deliveries SET status=? WHERE id=?').bind(status, id).run();
  return p;
}

describe('日程調整の回答案内を再投稿', () => {
  it('同じ計画・回答・候補・締切を保持し、案内と履歴だけを追加する', async () => {
    let p = await enqueue(await fixture(), 'publish', 'sent');
    const before = structuredClone(p.data);
    expect((await call(p)).status).toBe(200);
    p = await getPlan(db, p.id);
    expect(p.data).toEqual({ ...before, answerOrigin: 'https://test.invalid' });
    expect((await db.prepare('SELECT COUNT(*) AS n FROM planning_plans').first<any>())?.n).toBe(1);
    const queued = await jobs(p);
    expect(queued).toHaveLength(2);
    expect(queued[0].status).toBe('sent');
    expect(queued[1]).toMatchObject({ kind: 'repost', status: 'pending', channel_id: before.channel });
    const payload = JSON.parse(queued[1].payload);
    expect(payload.components[0].components[0]).toMatchObject({
      label: '回答画面を開く',
      url: `https://test.invalid/answer.html?plan=${p.id}`,
    });
    expect(payload.components[0].components[1]).toMatchObject({
      label: '初回利用',
      custom_id: `plan:open:${p.id}:0`,
    });
    expect(payload.allowed_mentions).toEqual({ parse: [] });
    expect(payload.content).not.toContain('補足を保持');
    const history = await db
      .prepare("SELECT * FROM planning_history WHERE plan_id=? AND kind='repost'")
      .bind(p.id)
      .all<any>();
    expect(history.results).toHaveLength(1);
    expect(JSON.parse(history.results[0].after_data)).toEqual({
      ...JSON.parse(history.results[0].before_data),
      answerOrigin: 'https://test.invalid',
    });
    await deliverPending(E);
    expect((await jobs(p))[1].status).toBe('sent');
    expect((await getPlan(db, p.id)).data).toEqual({ ...before, answerOrigin: 'https://test.invalid' });
    // The new entry opens the previously saved answer, without creating a separate response.
    const response = (await openWebAnswer(p, E)).snapshot;
    expect(JSON.stringify(response)).toContain('補足を保持');
  });

  it('同時実行・古い画面・投稿待ちの再実行で重複登録しない', async () => {
    const p = await fixture();
    const results = await Promise.all([call(p), call(p)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await call(p)).status).toBe(409);
    expect((await call(await getPlan(db, p.id))).status).toBe(409);
    expect(await jobs(p)).toHaveLength(1);
  });

  it.each(['pending', 'sending', 'failed', 'unknown'])(
    '未完了の案内（%s）がある場合は投稿状況の確認へ案内する',
    async (status) => {
      for (const kind of ['publish', 'candidates', 'repost']) {
        const p = await enqueue(await fixture(), kind, status);
        const response = await call(p);
        expect(response.status).toBe(409);
        expect(await response.text()).toContain('投稿状況を確認');
        expect(await jobs(p)).toHaveLength(1);
      }
    },
  );

  it.each(['draft', 'cancelled'] as const)('%sは再投稿できない', async (state) => {
    const p = await fixture({ state });
    expect((await call(p)).status).toBe(400);
    expect(await jobs(p)).toEqual([]);
  });

  it.each([{ deadline: '2000-09-01T00:00:00.000Z' }, { state: 'confirmed' as const }])(
    '受付終了後は確認用の案内を投稿し、回答を再開しない (%j)',
    async (overrides) => {
      const p = await fixture(overrides);
      expect((await call(p)).status).toBe(200);
      const fetcher = vi.fn().mockResolvedValue(new Response('{"id":"777777"}'));
      vi.stubGlobal('fetch', fetcher);
      await deliverPending({ ...E, MOCK_DISCORD: undefined });
      const payload = JSON.parse(fetcher.mock.calls[0][1].body);
      expect(payload.components[0].components[0].label).toBe('回答画面を開く');
      expect(payload.content).toContain('回答受付は終了');
      expect(payload.content).not.toContain('締切までは変更できます');
      expect((await getPlan(db, p.id)).data).toEqual({ ...p.data, answerOrigin: 'https://test.invalid' });
      expect((await jobs(p))[0].status).toBe('sent');
    },
  );

  it('待機中に受付終了した場合も、投稿する時点の内容と状態を使う', async () => {
    let p = await fixture();
    await call(p);
    p = await getPlan(db, p.id);
    await savePlan(db, p, { ...p.data, state: 'confirmed', note: '最新の連絡事項' }, 'setup');
    const fetcher = vi.fn().mockResolvedValue(new Response('{"id":"777777"}'));
    vi.stubGlobal('fetch', fetcher);
    await deliverPending({ ...E, MOCK_DISCORD: undefined });
    const payload = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(payload.content).toContain('回答受付は終了');
    expect(payload.content).toContain('最新の連絡事項');
    expect(fetcher.mock.calls[0][0]).toContain('/channels/111111/messages');
  });

  it('待機中に中止した場合は投稿しない', async () => {
    let p = await fixture();
    await call(p);
    p = await getPlan(db, p.id);
    await savePlan(db, p, { ...p.data, state: 'cancelled' }, 'setup');
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    await deliverPending({ ...E, MOCK_DISCORD: undefined });
    expect(fetcher).not.toHaveBeenCalled();
    expect((await jobs(p))[0].status).toBe('cancelled');
  });

  it('投稿失敗は既存の再試行を使い、同じ処理のnonceで再送する', async () => {
    let p = await fixture();
    await call(p);
    const fetcher = vi.fn().mockResolvedValue(new Response('{}', { status: 403 }));
    vi.stubGlobal('fetch', fetcher);
    await deliverPending({ ...E, MOCK_DISCORD: undefined });
    const first = (await jobs(p))[0];
    expect(first.status).toBe('failed');
    p = await getPlan(db, p.id);
    expect((await call(p)).status).toBe(409);
    expect((await call(p, 'retry', { delivery: first.id })).status).toBe(200);
    fetcher.mockImplementation(async () => new Response('{"id":"777777"}'));
    await deliverPending({ ...E, MOCK_DISCORD: undefined });
    expect((await jobs(p))[0].status).toBe('sent');
    const payloads = fetcher.mock.calls.map((c) => JSON.parse(c[1].body));
    expect(payloads[0].nonce).toBe(payloads[1].nonce);
    expect(payloads[1].enforce_nonce).toBe(true);
    expect(await jobs(p)).toHaveLength(1);
  });

  it('履歴保存に失敗した場合は再投稿登録とバージョン更新も取り消す', async () => {
    const p = await fixture();
    await db
      .prepare(
        "CREATE TRIGGER reject_repost_history BEFORE INSERT ON planning_history WHEN NEW.kind='repost' BEGIN SELECT RAISE(ABORT,'history unavailable'); END",
      )
      .run();
    try {
      expect((await call(p)).status).toBe(400);
      expect(await getPlan(db, p.id)).toEqual(p);
      expect(await jobs(p)).toHaveLength(0);
    } finally {
      await db.prepare('DROP TRIGGER reject_repost_history').run();
    }
  });

  it('結果不明の再投稿は自動再試行せず、同じ計画の投稿だけを関連付ける', async () => {
    let p = await fixture();
    await call(p);
    const fetcher = vi.fn().mockRejectedValue(new Error('connection reset'));
    vi.stubGlobal('fetch', fetcher);
    const runtime = { ...E, MOCK_DISCORD: undefined, DISCORD_APPLICATION_ID: '555555' };
    await deliverPending(runtime);
    await deliverPending(runtime);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const job = (await jobs(p))[0];
    expect(job.status).toBe('unknown');
    p = await getPlan(db, p.id);
    let planId = 'another-plan';
    fetcher.mockImplementation(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.includes('/messages/')
              ? {
                  author: { id: '555555' },
                  components: [{ type: 1, components: [{ custom_id: `plan:open:${planId}:0` }] }],
                }
              : { id: p.data.channel, guild_id: p.guild_id },
          ),
        ),
    );
    const association = { delivery: job.id, thread: p.data.channel, message: '777777' };
    expect((await call(p, 'associate', association, runtime)).status).toBe(400);
    planId = p.id;
    expect((await call(p, 'associate', association, runtime)).status).toBe(200);
    expect((await jobs(p))[0]).toMatchObject({ status: 'sent', message_id: '777777' });
  });

  it('管理認証がないリクエストで再投稿できない', async () => {
    const p = await fixture();
    const response = await handleAdmin(
      new Request(`https://test.invalid/api/admin/planning/${p.id}/repost`, {
        method: 'POST',
        body: JSON.stringify({ version: p.version }),
      }),
      E,
    );
    expect(response.status).toBe(401);
    expect(await jobs(p)).toEqual([]);
  });
});
