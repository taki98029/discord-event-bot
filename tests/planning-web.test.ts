import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import { blankPlan, type Plan } from '../src/planning/model';
import { createPlan, getPlan, savePlan } from '../src/planning/store';
import { handlePlanningAnswer, issuePlanningLink } from '../src/planning/web-answer';
import { planningInteraction } from '../src/planning/interactions';
import { answerRequest, openWebAnswer, ORIGIN } from './planning-web-client';

const db = env.DB,
  E = env as unknown as Env;
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function fixture(count = 22) {
  const data = blankPlan('9月の日程調整');
  data.state = 'open';
  data.deadline = '2099-08-30T12:00:00.000Z';
  data.people = [
    { id: 'user1', name: '回答者', schedules: [] },
    { id: 'user2', name: '他の人', schedules: [] },
  ];
  data.candidates = Array.from({ length: count }, (_, i) => ({
    id: crypto.randomUUID(),
    date: new Date(Date.UTC(2099, 8, i + 1)).toISOString().slice(0, 10),
    time: i % 2 ? '' : '19:00',
    active: true,
  }));
  data.answers.user2 = { values: { [data.candidates[0].id]: '不可' }, comment: '他人の秘密' };
  return createPlan(db, 'web-guild', data);
}
const answers = (p: Plan, version: string, value = '未定') => ({
  version,
  values: Object.fromEntries(p.data.candidates.filter((c) => c.active).map((c) => [c.id, value])),
  comment: '任意の補足',
});
const api = (request: Request) => handlePlanningAnswer(request, E);

describe('本人用リンクからWebで一括回答', () => {
  it('本人だけにリンクを発行し、全100候補と本人の回答だけを返す', async () => {
    const p = await fixture(100);
    const s = await openWebAnswer(p, E);
    expect(s.url.origin).toBe(ORIGIN);
    expect(s.url.searchParams.get('plan')).toBe(p.id);
    expect(s.url.href).not.toContain('user1');
    expect(s.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(s.snapshot.candidates).toHaveLength(100);
    expect(JSON.stringify(s.snapshot)).not.toMatch(/user2|他人の秘密|他の人/);
    expect(s.snapshot.candidates[1].label).toContain('時刻指定なし');
    const header = s.response.headers.get('Set-Cookie')!;
    for (const flag of ['Secure', 'HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=2592000'])
      expect(header).toContain(flag);
    const stored = await db
      .prepare('SELECT data FROM planning_sessions WHERE plan_id=?')
      .bind(p.id)
      .first<any>();
    expect(stored.data).not.toContain(s.key);
    expect(stored.data).not.toContain(s.cookie.split('=')[1]);
    const browser = await db.prepare('SELECT * FROM planning_browser_sessions').first<any>();
    expect(browser.token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(browser)).not.toContain(s.cookie.split('=')[1]);
    expect(browser.expires_at).toBeGreaterThan(Date.now() + 29 * 86400_000);
    expect((await api(answerRequest(p.id, s.cookie))).status).toBe(200);
    expect((await getPlan(db, p.id)).data.answers.user1).toBeUndefined();
  });
  it('全候補を一つの履歴で保存し、全未定も回答完了・同一内容の再送は無変更', async () => {
    const p = await fixture();
    const s = await openWebAnswer(p, E);
    const result = await api(
      answerRequest(p.id, s.cookie, { ...answers(p, s.snapshot.version), user: 'user2' }),
    );
    expect(result.status).toBe(200);
    const saved = await getPlan(db, p.id);
    expect(saved.data.answers.user1.values).toEqual(answers(p, s.snapshot.version).values);
    expect(saved.data.answers.user2.comment).toBe('他人の秘密');
    expect(
      (await db.prepare("SELECT * FROM planning_history WHERE kind='participant-answer'").all()).results,
    ).toHaveLength(1);
    const snapshot: any = await result.json();
    expect((await api(answerRequest(p.id, s.cookie, answers(p, snapshot.version)))).status).toBe(200);
    expect((await getPlan(db, p.id)).version).toBe(saved.version);
  });
  it('リンクの同時交換は一度だけ成功し、再利用・改ざん・別計画への流用を拒否', async () => {
    const p = await fixture();
    const url = new URL(await issuePlanningLink(db, p, 'user1', ORIGIN));
    const key = url.hash.slice(1);
    const results = await Promise.all([0, 1].map(() => api(answerRequest(p.id, '', { key }, '/exchange'))));
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
    expect((await api(answerRequest(p.id, '', { key }, '/exchange'))).status).toBe(401);
    expect((await api(answerRequest(p.id, '', { key: 'x'.repeat(43) }, '/exchange'))).status).toBe(401);
    const other = await fixture();
    expect((await api(answerRequest(other.id, '', { key }, '/exchange'))).status).toBe(401);
    const winner = results.find((r) => r.status === 200)!;
    expect((await api(answerRequest(other.id, winner.headers.get('Set-Cookie')!.split(';')[0]))).status).toBe(
      200,
    );
  });
  it('リンクのGETでは消費せず、期限切れのリンク・セッションを拒否', async () => {
    const p = await fixture();
    const url = new URL(await issuePlanningLink(db, p, 'user1', ORIGIN));
    expect((await api(new Request(`${ORIGIN}/api/planning/answers/${p.id}/exchange`))).status).toBe(405);
    await db.prepare("UPDATE planning_sessions SET data=json_set(data,'$.linkUntil',0)").run();
    expect((await api(answerRequest(p.id, '', { key: url.hash.slice(1) }, '/exchange'))).status).toBe(401);
    const s = await openWebAnswer(p, E);
    await db.prepare('UPDATE planning_browser_sessions SET expires_at=0').run();
    expect((await api(answerRequest(p.id, s.cookie))).status).toBe(401);
    expect((await api(answerRequest(p.id, s.cookie, answers(p, s.snapshot.version)))).status).toBe(401);
  });
  it('新リンクの発行は記憶を保ち、同じブラウザーで交換すると古い記憶を無効にする', async () => {
    const p = await fixture();
    const old = await openWebAnswer(p, E);
    const url = new URL(await issuePlanningLink(db, p, 'user1', ORIGIN));
    expect((await api(answerRequest(p.id, old.cookie))).status).toBe(200);
    expect((await api(answerRequest(p.id, old.cookie, { key: url.hash.slice(1) }, '/exchange'))).status).toBe(
      200,
    );
    expect((await api(answerRequest(p.id, old.cookie))).status).toBe(401);
  });
  it('ID指定・管理トークンだけでは閲覧できず、別サイト・不正Origin・フォーム投稿を拒否', async () => {
    const p = await fixture();
    const s = await openWebAnswer(p, E);
    const anonymous = new Request(`${ORIGIN}/api/planning/answers/${p.id}?user_id=user1`, {
      headers: { Authorization: 'Bearer admin' },
    });
    expect((await api(anonymous)).status).toBe(401);
    for (const patch of [
      { Origin: 'https://another.invalid' },
      { Origin: 'null' },
      { 'Content-Type': 'text/plain' },
      { 'Sec-Fetch-Site': 'cross-site' },
    ]) {
      const req = answerRequest(p.id, s.cookie, answers(p, s.snapshot.version));
      Object.entries(patch).forEach(([k, v]) => req.headers.set(k, v));
      expect((await api(req)).status).toBe(403);
    }
    const noOrigin = answerRequest(p.id, s.cookie, answers(p, s.snapshot.version));
    noOrigin.headers.delete('Origin');
    expect((await api(noOrigin)).status).toBe(403);
    expect((await getPlan(db, p.id)).data.answers.user1).toBeUndefined();
  });
  it('記憶は同じサーバーの別計画で使え、元の計画を削除しても残る', async () => {
    const original = await fixture();
    const s = await openWebAnswer(original, E);
    const next = await fixture();
    await db.prepare('DELETE FROM planning_sessions WHERE plan_id=?').bind(original.id).run();
    await db.prepare('DELETE FROM planning_plans WHERE id=?').bind(original.id).run();
    const response = await api(answerRequest(next.id, s.cookie));
    expect(response.status).toBe(200);
    const snapshot: any = await response.json();
    expect(snapshot.person.id).toBe('user1');
    expect((await api(answerRequest(next.id, s.cookie, answers(next, snapshot.version)))).status).toBe(200);
    expect((await getPlan(db, next.id)).data.answers.user1.comment).toBe('任意の補足');
  });
  it('記憶があっても別サーバー・対象外・下書きは閲覧できない', async () => {
    const p = await fixture();
    const s = await openWebAnswer(p, E);
    const otherGuild = await createPlan(db, 'another-guild', p.data);
    // Even copying a token into the other guild's cookie must fail.
    expect(
      (await api(answerRequest(otherGuild.id, s.cookie.replace('web-guild', 'another-guild')))).status,
    ).toBe(401);
    const removed = await fixture();
    removed.data.people = removed.data.people.filter((person) => person.id !== 'user1');
    await savePlan(db, removed, removed.data, 'setup');
    const hidden = await api(answerRequest(removed.id, s.cookie));
    expect(hidden.status).toBe(403);
    expect(await hidden.text()).not.toContain('他人の秘密');
    const draft = await fixture();
    draft.data.state = 'draft';
    await savePlan(db, draft, draft.data, 'setup');
    expect((await api(answerRequest(draft.id, s.cookie))).status).toBe(403);
  });
  it('回答者の切替はこのブラウザーだけを失効させ、解除後は別計画でも使えない', async () => {
    const p = await fixture();
    const a = await openWebAnswer(p, E);
    const b = await openWebAnswer(p, E);
    const key = new URL(await issuePlanningLink(db, p, 'user2', ORIGIN)).hash.slice(1);
    const changed = await api(answerRequest(p.id, a.cookie, { key }, '/exchange'));
    expect(changed.status).toBe(200);
    const switched = changed.headers.get('Set-Cookie')!.split(';')[0];
    expect(((await changed.json()) as any).person.id).toBe('user2');
    expect((await api(answerRequest(p.id, a.cookie))).status).toBe(401);
    expect((await api(answerRequest(p.id, b.cookie))).status).toBe(200);
    const crossSite = answerRequest(p.id, switched, {}, '/forget');
    crossSite.headers.set('Origin', 'https://another.invalid');
    expect((await api(crossSite)).status).toBe(403);
    expect((await api(answerRequest(p.id, switched))).status).toBe(200);
    const forgotten = await api(answerRequest(p.id, switched, {}, '/forget'));
    expect(forgotten.status).toBe(200);
    expect(forgotten.headers.get('Set-Cookie')).toContain('Max-Age=0');
    const next = await fixture();
    expect((await api(answerRequest(next.id, switched))).status).toBe(401);
    expect((await api(answerRequest(p.id, b.cookie))).status).toBe(200);
    expect((await getPlan(db, p.id)).data.answers.user2.comment).toBe('他人の秘密');
  });
  it('初回の共通URLは本人確認へ案内し、回答や個人情報は返さない', async () => {
    const p = await fixture();
    const response = await api(answerRequest(p.id));
    expect(response.status).toBe(401);
    const body: any = await response.json();
    expect(body.discordUrl).toMatch(/^https:\/\/discord.com\/channels\//);
    expect(body.error).toContain('初回利用');
    expect(JSON.stringify(body)).not.toMatch(/user1|user2|他人の秘密|9月の日程調整/);
  });
  it('長さを偽装した大きい本文も読み込み中に拒否する', async () => {
    const p = await fixture();
    const request = answerRequest(p.id, '', { key: 'x'.repeat(70_000) }, '/exchange');
    request.headers.set('Content-Length', '1');
    expect((await api(request)).status).toBe(413);
    const malformed = new Request(`${ORIGIN}/api/planning/answers/${p.id}/exchange`, {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: '{',
    });
    expect((await api(malformed)).status).toBe(400);
  });
  it('対象外・別サーバー・下書きでは専用リンクを発行しない', async () => {
    const p = await fixture();
    for (const [guild, user] of [
      [p.guild_id, 'outsider'],
      ['another', 'user1'],
    ]) {
      const reply = await planningInteraction(
        { type: 3, guild_id: guild, user: { id: user }, data: { custom_id: `plan:open:${p.id}` } },
        E,
        ORIGIN,
      );
      expect(JSON.stringify(reply)).toContain('対象者ではありません');
      expect(JSON.stringify(reply)).not.toContain('url');
    }
    p.data.state = 'draft';
    await savePlan(db, p, p.data, 'setup');
    const reply = await planningInteraction(
      { type: 3, guild_id: p.guild_id, user: { id: 'user1' }, data: { custom_id: `plan:open:${p.id}` } },
      E,
      ORIGIN,
    );
    expect(JSON.stringify(reply)).toContain('まだ始まっていません');
    expect((await db.prepare('SELECT * FROM planning_sessions').all()).results).toHaveLength(0);
  });
  it('未回答・余分な候補・不正な値・長すぎる補足では一部も保存しない', async () => {
    const p = await fixture();
    const s = await openWebAnswer(p, E);
    const valid = answers(p, s.snapshot.version);
    for (const bad of [
      { ...valid, values: {} },
      { ...valid, values: { ...valid.values, extra: '可' } },
      { ...valid, values: { ...valid.values, [p.data.candidates[0].id]: '参加' } },
      { ...valid, comment: 'a'.repeat(501) },
      { ...valid, version: null },
      null,
    ])
      expect((await api(answerRequest(p.id, s.cookie, bad))).status).toBe(400);
    expect((await getPlan(db, p.id)).data.answers.user1).toBeUndefined();
  });
  it('他の参加者の同時送信を保持し、同じ本人の別画面と代理変更の上書きを拒否', async () => {
    let p = await fixture();
    const a = await openWebAnswer(p, E);
    const b = await openWebAnswer(p, E, 'user2');
    const responses = await Promise.all([
      api(answerRequest(p.id, a.cookie, answers(p, a.snapshot.version, '可'))),
      api(answerRequest(p.id, b.cookie, answers(p, b.snapshot.version, '不可'))),
    ]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    expect((await api(answerRequest(p.id, a.cookie, answers(p, a.snapshot.version, '不可')))).status).toBe(
      409,
    );
    const latest: any = await (await api(answerRequest(p.id, a.cookie))).json();
    p = await getPlan(db, p.id);
    for (const value of ['未定', '可'] as const) {
      const d = structuredClone(p.data);
      d.answers.user1.values[p.data.candidates[0].id] = value;
      p = await savePlan(db, p, d, 'admin-answer');
    }
    expect((await api(answerRequest(p.id, a.cookie, answers(p, latest.version, '不可')))).status).toBe(409);
    expect((await getPlan(db, p.id)).data.answers.user1.values[p.data.candidates[0].id]).toBe('可');
  });
  it('候補の追加・取り下げ・日時変更で古い全問回答を拒否する', async () => {
    for (const change of ['add', 'remove', 'time']) {
      let p = await fixture();
      const s = await openWebAnswer(p, E);
      const body = answers(p, s.snapshot.version);
      const d = structuredClone(p.data);
      if (change === 'add') d.candidates.push({ ...d.candidates[0], id: crypto.randomUUID() });
      if (change === 'remove') d.candidates[0].active = false;
      if (change === 'time') d.candidates[0].time = '22:00';
      p = await savePlan(db, p, d, 'candidates');
      expect((await api(answerRequest(p.id, s.cookie, body))).status).toBe(409);
      expect((await getPlan(db, p.id)).data.answers.user1).toBeUndefined();
    }
  });
  it('締切後・確定後・中止後は本人の回答を閲覧できるが変更できない', async () => {
    for (const state of ['deadline', 'confirmed', 'cancelled']) {
      let p = await fixture();
      const s = await openWebAnswer(p, E);
      const d = structuredClone(p.data);
      if (state === 'deadline') d.deadline = '2000-01-01T00:00:00Z';
      else d.state = state as 'confirmed' | 'cancelled';
      p = await savePlan(db, p, d, 'setup');
      const latest: any = await (await api(answerRequest(p.id, s.cookie))).json();
      expect(latest.closed).toBe(true);
      expect((await api(answerRequest(p.id, s.cookie, answers(p, s.snapshot.version)))).status).toBe(409);
      expect((await openWebAnswer(p, E)).snapshot.closed).toBe(true);
    }
  });
  it('履歴保存に失敗したら全回答をロールバックし、結果不明の表現を返す', async () => {
    const p = await fixture();
    const s = await openWebAnswer(p, E);
    await db
      .prepare(
        "CREATE TRIGGER fail_web_history BEFORE INSERT ON planning_history WHEN NEW.kind='participant-answer' BEGIN SELECT RAISE(ABORT,'test'); END",
      )
      .run();
    try {
      const r = await api(answerRequest(p.id, s.cookie, answers(p, s.snapshot.version)));
      expect(r.status).toBe(500);
      expect(JSON.stringify(await r.json())).toContain('処理結果を確認できません');
      expect((await getPlan(db, p.id)).data.answers.user1).toBeUndefined();
    } finally {
      await db.prepare('DROP TRIGGER fail_web_history').run();
    }
  });
  it('書込直前にセッションを無効化してもSQLで保存を拒否する', async () => {
    const p = await fixture();
    const s = await openWebAnswer(p, E);
    const guarded = {
      prepare: db.prepare.bind(db),
      batch: async (statements: D1PreparedStatement[]) => {
        await db.prepare('UPDATE planning_browser_sessions SET expires_at=0').run();
        return db.batch(statements);
      },
    } as D1Database;
    const r = await handlePlanningAnswer(answerRequest(p.id, s.cookie, answers(p, s.snapshot.version)), {
      ...E,
      DB: guarded,
    });
    expect(r.status).toBe(409);
    expect((await getPlan(db, p.id)).data.answers.user1).toBeUndefined();
    expect(
      (await db.prepare("SELECT * FROM planning_history WHERE kind='participant-answer'").all()).results,
    ).toHaveLength(0);
  });
  it('応答は常に非キャッシュで、認証情報・本人以外のデータをエラーに出さない', async () => {
    const p = await fixture();
    const s = await openWebAnswer(p, E);
    for (const req of [
      answerRequest(p.id, s.cookie),
      answerRequest(p.id),
      answerRequest(p.id, s.cookie, {}),
    ]) {
      const r = await api(req);
      expect(r.headers.get('Cache-Control')).toBe('no-store');
      expect(r.headers.get('Referrer-Policy')).toBe('no-referrer');
      expect(r.headers.has('Access-Control-Allow-Origin')).toBe(false);
      const text = await r.text();
      expect(text).not.toContain(s.key);
      expect(text).not.toContain(s.cookie);
      expect(text).not.toContain('他人の秘密');
    }
  });
});
