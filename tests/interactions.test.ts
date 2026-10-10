import { describe, it, expect, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { verifyEd25519, handleInteraction } from '../src/interactions/index';
import type { Env } from '../src/env';
import {
  createSegment,
  addSegmentMember,
  removeSegmentMember,
  getSegmentMemberStatus,
  setSegmentMemberStatus,
} from '../src/db/segments';
import { getOrCreateOccurrence } from '../src/db/occurrences';
import { getResponseStatus, upsertResponse } from '../src/db/responses';
import { syncSegmentFromRole } from '../src/discord/syncSegment';

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function makeKeyPair(): Promise<{ publicKeyHex: string; privateKey: CryptoKey }> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const pubRaw = (await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer;
  return { publicKeyHex: bytesToHex(new Uint8Array(pubRaw)), privateKey: pair.privateKey };
}

async function sign(privateKey: CryptoKey, timestamp: string, body: string): Promise<string> {
  const sig = await crypto.subtle.sign('Ed25519', privateKey, new TextEncoder().encode(timestamp + body));
  return bytesToHex(new Uint8Array(sig));
}

describe('verifyEd25519 (Discord Interaction 署名検証)', () => {
  it('正しい鍵・署名 → true (PING 受け入れ)', async () => {
    const { publicKeyHex, privateKey } = await makeKeyPair();
    const body = '{"type":1}';
    const ts = '1700000000';
    const sig = await sign(privateKey, ts, body);
    expect(await verifyEd25519(body, sig, ts, publicKeyHex)).toBe(true);
  });

  it('body が改ざんされた → false', async () => {
    const { publicKeyHex, privateKey } = await makeKeyPair();
    const sig = await sign(privateKey, '1700000000', '{"type":1}');
    expect(await verifyEd25519('{"type":2}', sig, '1700000000', publicKeyHex)).toBe(false);
  });

  it('別鍵の公開鍵で検証 → false', async () => {
    const a = await makeKeyPair();
    const b = await makeKeyPair();
    const sig = await sign(a.privateKey, '1700000000', '{"type":1}');
    expect(await verifyEd25519('{"type":1}', sig, '1700000000', b.publicKeyHex)).toBe(false);
  });

  it('公開鍵フォーマット不正 → false (throw しない)', async () => {
    expect(await verifyEd25519('body', 'aabb', '0', 'not-hex')).toBe(false);
    expect(await verifyEd25519('body', 'aabb', '0', 'abc')).toBe(false); // odd-length
    expect(await verifyEd25519('body', 'aabb', '0', '')).toBe(false);
  });

  it('署名フォーマット不正 → false (throw しない)', async () => {
    const { publicKeyHex } = await makeKeyPair();
    expect(await verifyEd25519('body', 'zz', '0', publicKeyHex)).toBe(false);
  });
});

describe('handleInteraction — ボタンは deferred (type 5) を即返す', () => {
  it('MESSAGE_COMPONENT → 即時 type 5 (ephemeral) + waitUntil で PATCH @original', async () => {
    const { publicKeyHex, privateKey } = await makeKeyPair();
    // custom_id に区切り '_' 無し → occurrenceId NaN → DB を触らず早期 ephemeral エラーで返る経路
    const body = JSON.stringify({
      type: 3,
      application_id: 'app123',
      token: 'tok456',
      data: { custom_id: 'garbage' },
      member: { user: { id: 'u1', username: 'alice' } },
    });
    const ts = '1700000000';
    const sig = await sign(privateKey, ts, body);
    const request = new Request('https://example.com/interactions', {
      method: 'POST',
      headers: { 'x-signature-ed25519': sig, 'x-signature-timestamp': ts },
      body,
    });

    const tasks: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (p: Promise<unknown>) => tasks.push(p),
    } as unknown as Parameters<typeof handleInteraction>[2];

    const patches: { url: string; body: string }[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      patches.push({ url: String(url), body: String(init?.body) });
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    try {
      const res = await handleInteraction(request, { DISCORD_PUBLIC_KEY: publicKeyHex } as Env, ctx);
      expect(await res.json()).toEqual({ type: 5, data: { flags: 64 } });

      // 実処理は waitUntil に 1 件だけ積まれ、完了後に PATCH @original が飛ぶ
      expect(tasks).toHaveLength(1);
      await Promise.all(tasks);
      expect(patches).toHaveLength(1);
      expect(patches[0].url).toBe(
        'https://discord.com/api/v10/webhooks/app123/tok456/messages/@original',
      );
      expect(JSON.parse(patches[0].body).content).toContain('不正なインタラクション');
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe('回答ボタン — 出欠確認オフ（A1-01）', () => {
  it('募集の投稿後にテンプレートを出欠確認なしにしたら、古いボタンの回答を保存しない', async () => {
    const { env } = await import('cloudflare:test');
    const { createSegment } = await import('../src/db/segments');
    const seg = await createSegment(env.DB, { guild_id: '1001', name: '対象者', mention_role_id: null });
    const ins = await env.DB.prepare(
      "INSERT INTO notifications (guild_id, segment_id, name, channel_id, type, rrule, start_time, requires_response, active) VALUES ('1001', ?, '会', '2001', 'recurring', NULL, '21:00', 0, 1)",
    ).bind(seg.id).run();
    const occ = await env.DB.prepare("INSERT INTO occurrences (notification_id, occurrence_date, start_time, status) VALUES (?, '2099/01/01', '21:00', 'scheduled')")
      .bind(ins.meta.last_row_id).run();
    const { publicKeyHex, privateKey } = await makeKeyPair();
    const body = JSON.stringify({
      type: 3,
      application_id: 'app',
      token: 'tok',
      guild_id: '1001',
      data: { custom_id: `participate_${occ.meta.last_row_id}` },
      member: { user: { id: '3001', username: 'aoi' }, roles: [] },
    });
    const ts = '1700000000';
    const tasks: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => tasks.push(p) } as unknown as ExecutionContext;
    const patches: string[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      patches.push(String(init?.body));
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    try {
      await handleInteraction(
        new Request('https://test.invalid/interactions', {
          method: 'POST',
          headers: { 'x-signature-ed25519': await sign(privateKey, ts, body), 'x-signature-timestamp': ts },
          body,
        }),
        { ...env, MOCK_DISCORD: '1', DISCORD_PUBLIC_KEY: publicKeyHex } as unknown as Env,
        ctx,
      );
      while (tasks.length) await tasks.shift();
    } finally {
      globalThis.fetch = origFetch;
    }
    expect(JSON.parse(patches[0]).content).toBe('⛔ この出欠確認は現在、回答を受け付けていません（出欠確認なしに変更されました）。');
    expect(await env.DB.prepare('SELECT COUNT(*) AS c FROM responses WHERE occurrence_id = ?').bind(occ.meta.last_row_id).first('c')).toBe(0);
  });
});

const RESPONDENT = '3001';
const GUILD = '1001';
const ROLE = '4001';

async function attendanceFixture(mentionRoleId: string | null = ROLE) {
  const segment = await createSegment(env.DB, { guild_id: GUILD, name: '回答対象', mention_role_id: mentionRoleId });
  const inserted = await env.DB
    .prepare('INSERT INTO notifications (guild_id, segment_id, name, channel_id) VALUES (?, ?, ?, ?)')
    .bind(GUILD, segment.id, '出欠確認', 'c1')
    .run();
  const occurrence = await getOrCreateOccurrence(env.DB, inserted.meta.last_row_id, '2099/01/01', '21:00');
  return { segment, occurrence };
}

/** ローカル鍵で署名して公開入口を通す。Discord への送信はすべて捕捉する。 */
async function pressAnswer(customId: string, guildRoles?: string[]): Promise<string> {
  const { publicKeyHex, privateKey } = await makeKeyPair();
  const user = { id: RESPONDENT, username: 'alice', global_name: 'Alice' };
  const body = JSON.stringify({
    type: 3,
    application_id: 'app123',
    token: 'tok456',
    data: { custom_id: customId },
    ...(guildRoles === undefined ? { user } : { guild_id: GUILD, member: { user, roles: guildRoles, nick: 'ありす' } }),
  });
  const timestamp = '1700000000';
  const signature = await sign(privateKey, timestamp, body);
  const request = new Request('https://example.com/interactions', {
    method: 'POST',
    headers: { 'x-signature-ed25519': signature, 'x-signature-timestamp': timestamp },
    body,
  });
  const tasks: Promise<unknown>[] = [];
  const ctx = { waitUntil: (task: Promise<unknown>) => tasks.push(task) } as unknown as ExecutionContext;
  const patches: { url: string; method: string | undefined; content: string }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    patches.push({ url: String(url), method: init?.method, content: JSON.parse(String(init?.body)).content });
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  try {
    const response = await handleInteraction(request, { ...env, DISCORD_PUBLIC_KEY: publicKeyHex }, ctx);
    expect(await response.json()).toEqual({ type: 5, data: { flags: 64 } });
    // 回答中に追加される表示名更新などの waitUntil も完了させる。
    for (const task of tasks) await task;
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({
      url: 'https://discord.com/api/v10/webhooks/app123/tok456/messages/@original',
      method: 'PATCH',
    });
    return patches[0].content;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function storedAnswerState(segmentId: number, occurrenceId: number) {
  const rows = await env.DB.batch([
    env.DB.prepare('SELECT * FROM members WHERE user_id = ?').bind(RESPONDENT),
    env.DB.prepare('SELECT * FROM member_guild_profiles WHERE user_id = ? ORDER BY guild_id').bind(RESPONDENT),
    env.DB.prepare('SELECT * FROM segment_members WHERE segment_id = ? AND user_id = ?').bind(segmentId, RESPONDENT),
    env.DB.prepare('SELECT * FROM responses WHERE occurrence_id = ? AND user_id = ?').bind(occurrenceId, RESPONDENT),
    env.DB.prepare('SELECT * FROM response_log WHERE occurrence_id = ? AND user_id = ? ORDER BY id').bind(occurrenceId, RESPONDENT),
  ]);
  return rows.map((row) => row.results);
}

describe('handleInteraction — 回答前の所属・休止確認', () => {
  it.each([
    ['participate', null],
    ['absent', '未定'],
    ['undecided', '参加'],
  ])('ロール喪失の同期後、古い DM の %s で再登録・回答変更しない', async (action, previousStatus) => {
    const { segment, occurrence } = await attendanceFixture();
    const members = [
      { user_id: RESPONDENT, user_name: 'alice', display_name: 'Alice', roles: [ROLE] },
      { user_id: '3002', user_name: 'bob', display_name: 'Bob', roles: [ROLE] },
    ];
    await syncSegmentFromRole(env, segment, { members });
    const oldButton = `${action}_${occurrence.id}`;
    if (previousStatus) await upsertResponse(env.DB, occurrence.id, RESPONDENT, 'alice', previousStatus);

    const synced = await syncSegmentFromRole(env, segment, {
      members: members.map((member) => member.user_id === RESPONDENT ? { ...member, roles: [] } : member),
    });
    expect(synced.removed).toBe(1);
    expect(await getSegmentMemberStatus(env.DB, segment.id, RESPONDENT)).toBeNull();
    const before = await storedAnswerState(segment.id, occurrence.id);

    expect(await pressAnswer(oldButton)).toContain('🚫');
    expect(await storedAnswerState(segment.id, occurrence.id)).toEqual(before);
  });

  it.each([ROLE, null, '@everyone'])('有効な所属があれば DM で回答・変更できる（role=%s）', async (role) => {
    const { segment, occurrence } = await attendanceFixture(role);
    await addSegmentMember(env.DB, segment, RESPONDENT);
    for (const [action, status] of [['participate', '参加'], ['absent', '不参加'], ['undecided', '未定']]) {
      expect(await pressAnswer(`${action}_${occurrence.id}`)).toContain('記録しました');
      expect(await getResponseStatus(env.DB, occurrence.id, RESPONDENT)).toBe(status);
    }
    expect(await getSegmentMemberStatus(env.DB, segment.id, RESPONDENT)).toBe('');
    const history = await env.DB.prepare('SELECT status FROM response_log WHERE occurrence_id = ? AND user_id = ? ORDER BY id')
      .bind(occurrence.id, RESPONDENT).all<{ status: string }>();
    expect(history.results.map((row) => row.status)).toEqual(['参加', '不参加', '未定']);
  });

  it.each([null, '@everyone'])('手動区分・全員区分でも削除済み所属を DM で復活させない（role=%s）', async (role) => {
    const { segment, occurrence } = await attendanceFixture(role);
    await addSegmentMember(env.DB, segment, RESPONDENT);
    await removeSegmentMember(env.DB, segment.id, RESPONDENT);
    const before = await storedAnswerState(segment.id, occurrence.id);
    expect(await pressAnswer(`participate_${occurrence.id}`)).toContain('🚫');
    expect(await storedAnswerState(segment.id, occurrence.id)).toEqual(before);
  });

  it('別区分だけに所属する人の DM 回答も拒否する', async () => {
    const { segment, occurrence } = await attendanceFixture();
    const other = await createSegment(env.DB, { guild_id: GUILD, name: '別区分', mention_role_id: ROLE });
    await addSegmentMember(env.DB, other, RESPONDENT);
    const before = await storedAnswerState(segment.id, occurrence.id);
    expect(await pressAnswer(`participate_${occurrence.id}`)).toContain('🚫');
    expect(await storedAnswerState(segment.id, occurrence.id)).toEqual(before);
    expect(await getSegmentMemberStatus(env.DB, other.id, RESPONDENT)).toBe('');
  });

  it('未登録ユーザーの DM 回答はメンバーマスタも作らず拒否する', async () => {
    const { segment, occurrence } = await attendanceFixture();
    const before = await storedAnswerState(segment.id, occurrence.id);
    expect(before).toEqual([[], [], [], [], []]);
    expect(await pressAnswer(`participate_${occurrence.id}`)).toContain('🚫');
    expect(await storedAnswerState(segment.id, occurrence.id)).toEqual(before);
  });

  it.each(['DM', 'guild'])('休止中の %s 回答は既存の回答・休止状態を変更しない', async (origin) => {
    const { segment, occurrence } = await attendanceFixture();
    await addSegmentMember(env.DB, segment, RESPONDENT);
    await upsertResponse(env.DB, occurrence.id, RESPONDENT, 'alice', '未定');
    await setSegmentMemberStatus(env.DB, segment.id, RESPONDENT, '休止中');
    const before = await storedAnswerState(segment.id, occurrence.id);
    const prepare = vi.spyOn(env.DB, 'prepare');
    const batch = vi.spyOn(env.DB, 'batch');
    try {
      expect(await pressAnswer(`participate_${occurrence.id}`, origin === 'guild' ? [ROLE] : undefined)).toContain('休止中');
      expect(prepare.mock.calls.filter(([sql]) => /^(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql.trimStart()))).toEqual([]);
      expect(batch).not.toHaveBeenCalled();
    } finally {
      prepare.mockRestore();
      batch.mockRestore();
    }
    expect(await storedAnswerState(segment.id, occurrence.id)).toEqual(before);
  });

  it.each([ROLE, null, '@everyone'])('サーバー内の正当な初回回答は自動所属できる（role=%s）', async (role) => {
    const { segment, occurrence } = await attendanceFixture(role);
    expect(await pressAnswer(`participate_${occurrence.id}`, role === ROLE ? [ROLE] : [])).toContain('記録しました');
    expect(await getSegmentMemberStatus(env.DB, segment.id, RESPONDENT)).toBe('');
    expect(await getResponseStatus(env.DB, occurrence.id, RESPONDENT)).toBe('参加');
    const profile = await env.DB.prepare('SELECT display_name FROM member_guild_profiles WHERE guild_id = ? AND user_id = ?')
      .bind(GUILD, RESPONDENT).first<{ display_name: string }>();
    expect(profile?.display_name).toBe('ありす');
  });

  it('サーバー内では既存所属があっても指定ロールなしの回答を拒否する', async () => {
    const { segment, occurrence } = await attendanceFixture();
    await addSegmentMember(env.DB, segment, RESPONDENT);
    const before = await storedAnswerState(segment.id, occurrence.id);
    expect(await pressAnswer(`participate_${occurrence.id}`, [])).toContain('指定ロールの保有者');
    expect(await storedAnswerState(segment.id, occurrence.id)).toEqual(before);
  });
});
