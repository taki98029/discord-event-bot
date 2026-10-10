import { afterEach, expect, it, vi } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import type { Env } from '../src/env';
import { blankPlan } from '../src/planning/model';
import { createPlan, getPlan } from '../src/planning/store';
import { planningInteraction } from '../src/planning/interactions';
import { respondToPlanningInteraction } from '../src/planning/answer-response';
import { answerAnnouncement } from '../src/planning/delivery';
import { handleInteraction } from '../src/interactions';
import worker from '../src/index';
import { answerRequest, ORIGIN } from './planning-web-client';

const E = env as unknown as Env;
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function fixture() {
  const d = blankPlan('Web回答の検証');
  d.state = 'open';
  d.deadline = '2099-09-01T00:00:00Z';
  d.people = [{ id: 'user1', name: '本人', schedules: [] }];
  d.candidates = [{ id: 'candidate', date: '2099-09-10', time: '', active: true }];
  d.answers.user1 = { values: { candidate: '可' }, comment: '本人だけの補足' };
  return createPlan(env.DB, 'guild', d);
}
const interaction = (id: string, action = 'open', type = 3) => ({
  type,
  guild_id: 'guild',
  user: { id: 'user1' },
  application_id: 'app',
  token: 'test-token',
  data: { custom_id: `plan:${action}:${id}:candidate:1:old-token` },
});

it('旧直接回答・ページ・モーダル・一括操作は回答を変えずWebへ案内する', async () => {
  const p = await fixture();
  for (const action of [
    'open',
    'resume',
    'pick',
    'view',
    'edit',
    'note',
    'note-save',
    'radio-save',
    'bulk',
    'set',
    'save',
  ]) {
    const r = await planningInteraction(
      interaction(p.id, action, action.endsWith('save') ? 5 : 3),
      E,
      ORIGIN,
    );
    expect(r.data.flags).toBe(64 | 32768);
    expect(r.data.allowed_mentions.parse).toEqual([]);
    expect(r.data.components[1].components[0]).toMatchObject({
      type: 2,
      style: 5,
      label: '回答画面を開く',
    });
    expect(JSON.stringify(r)).not.toContain('本人だけの補足');
  }
  expect((await getPlan(env.DB, p.id)).data.answers).toEqual(p.data.answers);
});

it('署名付きDiscord入口から非公開URLを発行し、公開Web APIで本人の回答を取得する', async () => {
  const p = await fixture();
  const keys = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
  const publicKey = hex((await crypto.subtle.exportKey('raw', keys.publicKey)) as ArrayBuffer);
  // A previously configured runtime secret must not restore the retired Activity path.
  const configured = { ...E, DISCORD_PUBLIC_KEY: publicKey, DISCORD_CLIENT_SECRET: 'unused-test-secret' };
  const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetcher);
  for (const [action, type] of [
    ['open', 3],
    ['pick', 3],
    ['note-save', 5],
  ] as const) {
    const body = JSON.stringify(interaction(p.id, action, type));
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = hex(
      await crypto.subtle.sign('Ed25519', keys.privateKey, new TextEncoder().encode(timestamp + body)),
    );
    const ctx = createExecutionContext();
    const response = await handleInteraction(
      new Request(`${ORIGIN}/interactions`, {
        method: 'POST',
        headers: { 'x-signature-ed25519': signature, 'x-signature-timestamp': timestamp },
        body,
      }),
      configured,
      ctx,
    );
    expect(await response.json()).toEqual({ type: 5, data: { flags: 64 } });
    await waitOnExecutionContext(ctx);
    const payload = JSON.parse(fetcher.mock.calls.at(-1)![1].body);
    expect(payload.flags).toBe(32768);
    const url = new URL(payload.components[1].components[0].url);
    const exchanged = await worker.fetch(
      answerRequest(p.id, '', { key: url.hash.slice(1) }, '/exchange'),
      E,
      createExecutionContext(),
    );
    expect(exchanged.status).toBe(200);
    const snapshot: any = await exchanged.json();
    expect(snapshot.person.id).toBe('user1');
    expect(snapshot.comment).toBe('本人だけの補足');
  }
  expect((await getPlan(env.DB, p.id)).version).toBe(p.version);
});

it('署名がないリクエストでは本人用リンクを発行しない', async () => {
  const p = await fixture();
  const r = await handleInteraction(
    new Request(`${ORIGIN}/interactions`, { method: 'POST', body: JSON.stringify(interaction(p.id)) }),
    E,
    createExecutionContext(),
  );
  expect(r.status).toBe(401);
  expect((await env.DB.prepare('SELECT * FROM planning_sessions').all()).results).toHaveLength(0);
});

it('短い429は一度再試行し、表示失敗でも回答データを変更しない', async () => {
  const p = await fixture();
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ retry_after: 0.001 }), { status: 429 }))
    .mockResolvedValue(new Response('{}'));
  vi.stubGlobal('fetch', fetcher);
  await respondToPlanningInteraction(interaction(p.id), E, ORIGIN);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect((await getPlan(env.DB, p.id)).data).toEqual(p.data);
  fetcher.mockReset().mockRejectedValue(new Error('offline'));
  await respondToPlanningInteraction(interaction(p.id), E, ORIGIN);
  expect((await getPlan(env.DB, p.id)).data).toEqual(p.data);
});

it('公開案内の共通URLには本人情報を含めず、初回確認のボタンを併記する', async () => {
  const p = await fixture();
  p.data.answerOrigin = ORIGIN;
  const buttons = answerAnnouncement(p).components[0].components;
  expect(buttons).toEqual([
    { type: 2, style: 5, label: '回答画面を開く', url: `${ORIGIN}/answer.html?plan=${p.id}` },
    { type: 2, style: 2, label: '初回利用', custom_id: `plan:open:${p.id}:0` },
  ]);
  const text = JSON.stringify(answerAnnouncement(p));
  expect(text).toContain('回答を送信');
  expect(text).toContain('回答画面');
  expect(text).toContain('※初回・端末変更時は「初回利用」を押してください。');
  expect(text).not.toContain('本人だけの補足');
  expect(text).not.toContain('user1');
  expect(text).not.toContain('#');
  delete p.data.answerOrigin;
  expect(answerAnnouncement(p).components[0].components).toHaveLength(1);
});
