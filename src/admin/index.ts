import type { Env } from '../env';
import { getAllConfig, setConfig } from '../db/config';
import { getAllMembers, upsertMember, deleteMember } from '../db/members';
import { listRecentEventLogs } from '../db/eventLog';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** 定数時間比較（トークン照合） */
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

function authorized(request: Request, env: Env): boolean {
  const header = request.headers.get('authorization') || '';
  const prefix = 'Bearer ';
  if (!header.startsWith(prefix)) return false;
  const token = header.slice(prefix.length);
  return !!env.ADMIN_TOKEN && timingSafeEqual(token, env.ADMIN_TOKEN);
}

/**
 * 管理 API（/api/admin/*）。すべて ADMIN_TOKEN による Bearer 認証必須。
 * - GET    /api/admin/config            設定一覧
 * - PUT    /api/admin/config            設定更新 { config: {k:v,...} } または { key, value }
 * - GET    /api/admin/members           メンバー一覧
 * - POST   /api/admin/members           メンバー作成/更新
 * - DELETE /api/admin/members/:userId   メンバー削除
 * - GET    /api/admin/event-log         出欠記録（直近）
 */
export async function handleAdmin(request: Request, env: Env): Promise<Response> {
  if (!authorized(request, env)) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/admin/, '') || '/';
  const db = env.DB;

  try {
    // --- config ---
    if (path === '/config') {
      if (request.method === 'GET') {
        return json(await getAllConfig(db));
      }
      if (request.method === 'PUT') {
        const body = (await request.json()) as
          | { config?: Record<string, string>; key?: string; value?: string };
        if (body.config) {
          for (const [k, v] of Object.entries(body.config)) {
            await setConfig(db, k, String(v));
          }
        } else if (body.key !== undefined && body.value !== undefined) {
          await setConfig(db, body.key, String(body.value));
        } else {
          return json({ error: 'Invalid body' }, 400);
        }
        return json({ ok: true });
      }
    }

    // --- members ---
    if (path === '/members') {
      if (request.method === 'GET') {
        return json(await getAllMembers(db));
      }
      if (request.method === 'POST') {
        const m = (await request.json()) as {
          user_id?: string;
          user_name?: string | null;
          status?: string;
          display_name?: string | null;
        };
        if (!m.user_id) return json({ error: 'user_id required' }, 400);
        await upsertMember(db, {
          user_id: m.user_id,
          user_name: m.user_name ?? null,
          status: m.status ?? '',
          display_name: m.display_name ?? null,
        });
        return json({ ok: true });
      }
    }

    const memberDelete = path.match(/^\/members\/(.+)$/);
    if (memberDelete && request.method === 'DELETE') {
      const ok = await deleteMember(db, decodeURIComponent(memberDelete[1]));
      return json({ ok }, ok ? 200 : 404);
    }

    // --- event-log ---
    if (path === '/event-log' && request.method === 'GET') {
      const limit = Number(url.searchParams.get('limit') || '200');
      return json(await listRecentEventLogs(db, limit));
    }

    return json({ error: 'Not found' }, 404);
  } catch (e) {
    console.error('[Admin] error:', (e as Error).message);
    return json({ error: 'Internal error' }, 500);
  }
}
