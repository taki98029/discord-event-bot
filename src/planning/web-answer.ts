import type { Env } from '../env';
import { getPlan, savePlan } from './store';
import { isAnswer, PlanningError, requireValue, type Availability, type Plan, type PlanningAnswerSnapshot } from './model';
import { planningCandidates, planningClosed, planningDate, planningDeadline } from './answer-view';

const LINK_MS = 15 * 60_000;
const SESSION_MS = 30 * 24 * 60 * 60_000;
const KEY = /^[A-Za-z0-9_-]{43}$/;
const expired = '回答画面の有効期限が切れたか、リンクが使用済みです。Discordの案内から開き直してください。';
const answerCookie = (guild: string) => `__Host-planning-browser-${guild}`;
const discordUrl = (p: Plan) =>
  `https://discord.com/channels/${encodeURIComponent(p.guild_id)}/${encodeURIComponent(p.data.channel)}`;
export const answerHeaders = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
};

function checkAnswerOrigin(request: Request) {
  const url = new URL(request.url);
  requireValue(url.protocol === 'https:', 'HTTPSの回答画面を利用してください', 403);
  requireValue(request.headers.get('Sec-Fetch-Site') !== 'cross-site', '回答画面から操作してください', 403);
  if (request.method === 'POST') {
    requireValue(
      request.headers.get('Origin') === url.origin &&
        request.headers.get('Content-Type')?.split(';')[0].trim() === 'application/json',
      '回答画面から操作してください',
      403,
    );
  }
}

export async function readAnswerBody(request: Request): Promise<any> {
  requireValue(Number(request.headers.get('Content-Length') ?? 0) <= 65536, '回答が長すぎます', 413);
  let size = 0,
    raw = '';
  const reader = request.body?.getReader(),
    decoder = new TextDecoder();
  try {
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65536) {
        await reader.cancel();
        throw new PlanningError('回答が長すぎます', 413);
      }
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
  } finally {
    reader?.releaseLock();
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new PlanningError('回答の内容を確認してください');
  }
}
export const randomAnswerKey = () =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
export async function hashAnswerKey(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Only called after Discord signature and participant checks. Store hashes, never bearer keys. */
export async function issuePlanningLink(db: D1Database, p: Plan, user: string, origin: string) {
  requireValue(new URL(origin).protocol === 'https:', 'HTTPSの回答画面を利用してください');
  requireValue(p.data.state !== 'draft', '回答受付はまだ始まっていません', 403);
  const key = randomAnswerKey();
  // One pending link per person/plan; issuing another does not log out remembered browsers.
  await db
    .prepare(
      `INSERT INTO planning_sessions(plan_id,user_id,data,updated_at) VALUES(?,?,?,?)
    ON CONFLICT(plan_id,user_id) DO UPDATE SET
    data=json_set(planning_sessions.data,'$.linkHash',json_extract(excluded.data,'$.linkHash'),'$.linkUntil',json_extract(excluded.data,'$.linkUntil')),
    updated_at=excluded.updated_at`,
    )
    .bind(
      p.id,
      user,
      JSON.stringify({ linkHash: await hashAnswerKey(key), linkUntil: Date.now() + LINK_MS }),
      new Date().toISOString(),
    )
    .run();
  const url = new URL('/answer.html', origin);
  url.searchParams.set('plan', p.id);
  // Fragments are not sent in the HTTP request or Referer. The page removes this before exchanging it.
  url.hash = key;
  return url.href;
}

export async function planningAnswerSnapshot(p: Plan, user: string): Promise<PlanningAnswerSnapshot> {
  const person = p.data.people.find((x) => x.id === user && x.active !== false);
  requireValue(person && p.data.state !== 'draft', 'この回答の対象者ではありません', 403);
  const candidates = planningCandidates(p);
  const saved = p.data.answers[user] ?? { values: {}, comment: '' };
  const version = await hashAnswerKey(
    JSON.stringify([p.id, user, candidates, saved, p.data.answerVersions?.[user] ?? p.data.answerRevisions?.[user] ?? null]),
  );
  // Shared answers are read-only context for the respondent; they stay out of the conflict version and never include comments.
  const others = p.data.shareAnswers
    ? p.data.people.filter((x) => x.active !== false).map((x) => {
        const values: Record<string, Availability> = {};
        for (const c of candidates) {
          const v = p.data.answers[x.id]?.values[c.id];
          if (isAnswer(v)) values[c.id] = v;
        }
        return { name: x.name, values };
      })
    : undefined;
  return {
    ...(others ? { others } : {}),
    id: p.id,
    name: p.data.name,
    person: { id: user, name: person.name },
    note: p.data.note,
    deadline: p.data.deadline,
    deadlineLabel: planningDeadline(p.data.deadline),
    closed: planningClosed(p),
    cancelled: p.data.state === 'cancelled',
    version,
    candidates: candidates.map((c) => ({
      id: c.id,
      label: planningDate(c),
      date: c.date,
      time: c.time,
      value: saved.values[c.id] ?? null,
    })),
    comment: saved.comment,
  };
}

function browserKey(request: Request, guild: string) {
  return (
    request.headers
      .get('Cookie')
      ?.split(';')
      .map((c) => c.trim())
      .find((c) => c.startsWith(answerCookie(guild) + '='))
      ?.slice(answerCookie(guild).length + 1) ?? ''
  );
}
async function sessionUser(request: Request, db: D1Database, guild: string) {
  const cookie = browserKey(request, guild);
  const message =
    'このブラウザーで回答者の確認が必要です。Discordの案内の「初回利用」を押してください。';
  requireValue(KEY.test(cookie), message, 401);
  const hash = await hashAnswerKey(cookie);
  const row = await db
    .prepare(
      'SELECT user_id FROM planning_browser_sessions WHERE guild_id=? AND token_hash=? AND expires_at>?',
    )
    .bind(guild, hash, Date.now())
    .first<{ user_id: string }>();
  requireValue(row, message, 401);
  return { user: row.user_id, hash };
}

async function saveAnswers(db: D1Database, id: string, user: string, hash: string, body: any) {
  requireValue(
    body &&
      typeof body === 'object' &&
      !Array.isArray(body) &&
      typeof body.version === 'string' &&
      /^[a-f0-9]{64}$/.test(body.version) &&
      body.values &&
      typeof body.values === 'object' &&
      !Array.isArray(body.values) &&
      typeof body.comment === 'string' &&
      body.comment.length <= 500,
    '回答の内容を確認してください',
  );
  for (let attempt = 0; attempt < 4; attempt++) {
    const p = await getPlan(db, id);
    const snapshot = await planningAnswerSnapshot(p, user);
    requireValue(!snapshot.closed, '回答は締め切りました。変更は運営担当者へ個別に連絡してください。', 409);
    requireValue(
      snapshot.version === body.version,
      '候補または回答が変更されています。最新の回答を読み直してください。',
      409,
    );
    requireValue(
      snapshot.candidates.length > 0 &&
        Object.keys(body.values).length === snapshot.candidates.length &&
        snapshot.candidates.every((c) => Object.hasOwn(body.values, c.id) && isAnswer(body.values[c.id])),
      'すべての候補に可・不可・未定のいずれかを選択してください',
    );
    if (snapshot.comment === body.comment && snapshot.candidates.every((c) => c.value === body.values[c.id]))
      return snapshot;
    const next = structuredClone(p.data);
    next.answers[user] = { values: { ...next.answers[user]?.values, ...body.values }, comment: body.comment };
    try {
      const saved = await savePlan(db, p, next, 'participant-answer', '', user, undefined, hash);
      return planningAnswerSnapshot(saved, user);
    } catch (e) {
      if (!(e instanceof PlanningError && e.status === 409) || attempt === 3) throw e;
    }
  }
  throw new PlanningError('最新の回答を読み直してください。', 409);
}

/** Public participant API: no admin token, no client-supplied identity, no cross-origin access. */
export async function handlePlanningAnswer(request: Request, env: Env): Promise<Response> {
  const headers = new Headers(answerHeaders);
  let p: Plan | undefined;
  try {
    const url = new URL(request.url);
    const route = url.pathname.match(/^\/api\/planning\/answers\/([a-f0-9-]{36})(\/(?:exchange|forget))?$/);
    requireValue(route, '回答画面が見つかりません', 404);
    const [, id, action] = route;
    checkAnswerOrigin(request);
    requireValue(
      action ? request.method === 'POST' : ['GET', 'POST'].includes(request.method),
      'この操作は利用できません',
      405,
    );
    const body = request.method === 'POST' ? await readAnswerBody(request) : undefined;
    p = await getPlan(env.DB, id);
    const cookieOptions = 'Path=/; Secure; HttpOnly; SameSite=Strict';
    if (action === '/forget') {
      await env.DB.prepare('DELETE FROM planning_browser_sessions WHERE guild_id=? AND token_hash=?')
        .bind(p.guild_id, await hashAnswerKey(browserKey(request, p.guild_id)))
        .run();
      headers.set('Set-Cookie', `${answerCookie(p.guild_id)}=; ${cookieOptions}; Max-Age=0`);
      return new Response(JSON.stringify({ discordUrl: discordUrl(p) }), { headers });
    }
    let result;
    if (action === '/exchange') {
      requireValue(typeof body?.key === 'string' && KEY.test(body.key), expired, 401);
      const session = randomAnswerKey(),
        now = Date.now();
      // Only POST consumes a link; Discord previews and browser GETs cannot consume it.
      const row = await env.DB.prepare(
        `UPDATE planning_sessions
        SET data=json_remove(data,'$.linkHash','$.linkUntil','$.webSessionHash','$.webSessionUntil'),updated_at=?
        WHERE plan_id=? AND json_extract(data,'$.linkHash')=? AND json_extract(data,'$.linkUntil')>?
        RETURNING user_id`,
      )
        .bind(new Date(now).toISOString(), id, await hashAnswerKey(body.key), now)
        .first<{ user_id: string }>();
      if (!row) {
        // A used or expired personal link opened again from a remembered browser keeps that browser's identity (C07, 2026-09-20).
        const remembered = await sessionUser(request, env.DB, p.guild_id).catch(() => null);
        requireValue(remembered, expired, 401);
        return new Response(JSON.stringify(await planningAnswerSnapshot(p, remembered.user)), { headers });
      }
      result = await planningAnswerSnapshot(p, row.user_id);
      await env.DB.batch([
        // Switching identity revokes this browser's old credential, but keeps other devices signed in.
        env.DB.prepare(
          'DELETE FROM planning_browser_sessions WHERE expires_at<=? OR (guild_id=? AND token_hash=?)',
        ).bind(now, p.guild_id, await hashAnswerKey(browserKey(request, p.guild_id))),
        env.DB.prepare(
          'INSERT INTO planning_browser_sessions(token_hash,guild_id,user_id,expires_at) VALUES(?,?,?,?)',
        ).bind(await hashAnswerKey(session), p.guild_id, row.user_id, now + SESSION_MS),
      ]);
      headers.set(
        'Set-Cookie',
        `${answerCookie(p.guild_id)}=${session}; ${cookieOptions}; Max-Age=${SESSION_MS / 1000}`,
      );
    } else {
      const { user, hash } = await sessionUser(request, env.DB, p.guild_id);
      result =
        request.method === 'GET'
          ? await planningAnswerSnapshot(p, user)
          : await saveAnswers(env.DB, id, user, hash, body);
    }
    return new Response(JSON.stringify(result), { headers });
  } catch (e) {
    const status = e instanceof PlanningError ? e.status : 500;
    const error =
      e instanceof PlanningError
        ? e.message
        : '処理結果を確認できませんでした。入力を保持して、もう一度お試しください。';
    // Do not log the request, key, cookie, identity or submitted answers.
    if (status === 500) console.error('[PlanningWeb] request failed');
    return new Response(
      JSON.stringify({
        error,
        ...((status === 401 || status === 403) && p && p.data.state !== 'draft'
          ? { discordUrl: discordUrl(p) }
          : {}),
      }),
      { status, headers },
    );
  }
}
