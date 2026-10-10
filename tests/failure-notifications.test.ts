import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import { handleAdmin } from '../src/admin';
import {
  failureNotificationKey,
  getFailureNotificationSettings,
  notifyDeliveryFailure,
} from '../src/discord/failureNotifications';
import { setConfig, SEND_BUDGET_KEY } from '../src/db/config';
import { getNotification } from '../src/db/notifications';
import { getOrCreateOccurrence } from '../src/db/occurrences';
import { claimSend, finishSend } from '../src/db/sendLog';
import { recruitOccurrenceNow, runTick } from '../src/cron/tick';
import { formatDate, getJSTNow } from '../src/lib/date';
import { blankPlan } from '../src/planning/model';
import { createPlan } from '../src/planning/store';
import { deliverPending, deliveryStatement } from '../src/planning/delivery';
import { handleInteraction } from '../src/interactions/index';

const db = env.DB;
const E = {
  ...env,
  ADMIN_TOKEN: 'failure-test',
  MOCK_DISCORD: '1',
  DISCORD_BOT_TOKEN: 'dummy',
} as unknown as Env;
const settings = {
  channel_id: '2003',
  mention_mode: 'roles',
  mention_ids: ['4002'],
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function request(guild = '1001', body?: unknown, token = E.ADMIN_TOKEN) {
  return handleAdmin(
    new Request(`https://test.invalid/api/admin/guilds/${guild}/failure-notification`, {
      method: body === undefined ? 'GET' : 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    E,
  );
}
async function configure(guild = '1001', value = settings) {
  await setConfig(db, failureNotificationKey(guild), JSON.stringify(value));
}
function sending(alertOk = true) {
  const calls: { url: string; body: any }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      const ok = alertOk && String(url).includes('/channels/2003/messages');
      return new Response(ok ? '{"id":"message"}' : '{"message":"denied"}', {
        status: ok ? 200 : 403,
      });
    }),
  );
  return calls;
}
async function schedule() {
  await db.prepare("INSERT INTO segments(id,uuid,guild_id,name) VALUES(1,'segment','1001','対象者')").run();
  await db
    .prepare(
      "INSERT INTO notifications(id,uuid,guild_id,segment_id,name,channel_id,type,rrule,start_time,requires_response,mention_mode,send_hour,recruit_days_before) VALUES(1,'schedule','1001',1,'テスト会','2001','recurring',NULL,'23:59',1,'none',0,7)",
    )
    .run();
  return (await getNotification(db, 1))!;
}

describe('サーバーごとの失敗通知設定', () => {
  it('認証を要求し、未設定は無効。保存・再読込・サーバー分離・解除に対応する', async () => {
    expect((await request('1001', undefined, '')).status).toBe(401);
    expect((await request('1001', settings, '')).status).toBe(401);
    expect(await (await request()).json()).toEqual({
      channel_id: null,
      mention_mode: 'none',
      mention_ids: [],
    });
    expect((await request('1001', settings)).status).toBe(200);
    expect(await (await request()).json()).toEqual(settings);
    expect((await getFailureNotificationSettings(db, '1002')).channel_id).toBeNull();
    const users = {
      ...settings,
      mention_mode: 'users',
      mention_ids: ['3001', '3002', '3001'],
    };
    expect((await request('1002', users)).status).toBe(200);
    expect((await getFailureNotificationSettings(db, '1002')).mention_ids).toEqual(['3001', '3002']);
    expect((await getFailureNotificationSettings(db, '1001')).mention_mode).toBe('roles');
    expect(
      (
        await request('1001', {
          channel_id: null,
          mention_mode: 'none',
          mention_ids: [],
        })
      ).status,
    ).toBe(200);
    const calls = sending();
    expect(await notifyDeliveryFailure(E, '1001', '募集')).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('不正型・他サーバーのチャンネル/ユーザー/ロール・全員メンション・過剰指定を保存しない', async () => {
    await configure();
    for (const bad of [
      null,
      [],
      { ...settings, channel_id: 2003 },
      { ...settings, channel_id: '9999' },
      { ...settings, mention_mode: 'everyone' },
      { ...settings, mention_ids: ['1001'] },
      { ...settings, mention_ids: ['9999'] },
      { ...settings, mention_mode: 'users', mention_ids: ['9999'] },
      { ...settings, mention_ids: [4002] },
      { ...settings, mention_ids: ['@everyone'] },
      { ...settings, mention_ids: [] },
      { ...settings, mention_ids: Array(21).fill('4002') },
    ]) {
      expect((await request('1001', bad)).status).toBe(400);
    }
    expect(await getFailureNotificationSettings(db, '1001')).toEqual(settings);
    const bypass = await handleAdmin(
      new Request('https://test.invalid/api/admin/config', {
        method: 'PUT',
        headers: { Authorization: 'Bearer failure-test' },
        body: JSON.stringify({
          key: failureNotificationKey('1001'),
          value: JSON.stringify(settings),
        }),
      }),
      E,
    );
    expect(bypass.status).toBe(400);
  });
});

describe('失敗通知の投稿', () => {
  it.each(['users', 'roles', 'none'])(
    '指定した%sだけにメンションし、本文内の別宛先はピングしない',
    async (mode) => {
      const ids = mode === 'users' ? ['3001', '3002'] : mode === 'roles' ? ['4002'] : [];
      await configure('1001', {
        ...settings,
        mention_mode: mode,
        mention_ids: ids,
      });
      const calls = sending();
      expect(await notifyDeliveryFailure(E, '1001', '募集: @everyone <@9999>\n投稿先: <#2001>')).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toContain('/channels/2003/messages');
      expect(calls[0].body.allowed_mentions).toEqual({
        parse: [],
        ...(mode === 'none' ? {} : { [mode]: ids }),
      });
      for (const id of ids)
        expect(calls[0].body.content).toContain(mode === 'roles' ? `<@&${id}>` : `<@${id}>`);
      expect(calls[0].body.content).toContain('投稿先: <#2001>');
    },
  );

  it('失敗通知が失敗しても再帰しない。不正な保存値も外部へ投稿しない', async () => {
    await configure();
    const calls = sending(false);
    expect(await notifyDeliveryFailure(E, '1001', '失敗')).toBe(true);
    expect(calls).toHaveLength(1);
    await setConfig(db, failureNotificationKey('1001'), '{broken');
    expect(await notifyDeliveryFailure(E, '1001', '失敗')).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('手動募集は失敗箇所を投稿し、元の失敗履歴と再試行の扱いを維持する', async () => {
    await configure();
    const n = await schedule();
    const occ = await getOrCreateOccurrence(db, n.id, '2099/09/10', '21:00');
    const calls = sending(false);
    expect(await recruitOccurrenceNow(E, n, occ)).toBe('failed');
    expect(calls).toHaveLength(2);
    expect(calls[1].body.content).toContain('今すぐ募集: テスト会');
    expect(calls[1].body.content).toContain('2099/09/10');
    expect((await db.prepare('SELECT status FROM send_log').first<any>())?.status).toBe('failed');
    await recruitOccurrenceNow(E, n, occ);
    expect(calls).toHaveLength(4);
  });

  it('cronのDM失敗も通知し、追加投稿を送信予算に数え、同日重複を防ぐ', async () => {
    await configure();
    const n = await schedule();
    const tomorrow = getJSTNow();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const occ = await getOrCreateOccurrence(db, n.id, formatDate(tomorrow), '23:59');
    const key = {
      notification_id: n.id,
      occurrence_id: occ.id,
      kind: 'recruit' as const,
      send_date: formatDate(getJSTNow()),
    };
    await claimSend(db, key);
    await finishSend(db, key, true);
    for (const user of ['3001', '3002']) {
      await db
        .prepare('INSERT INTO members(user_id,display_name,dm_channel_id) VALUES(?,?,?)')
        .bind(user, user, `dm-${user}`)
        .run();
      await db
        .prepare("INSERT INTO segment_members(segment_id,user_id,status) VALUES(1,?,'')")
        .bind(user)
        .run();
    }
    await setConfig(db, SEND_BUDGET_KEY, '2');
    await setConfig(db, 'rolesync:1001', formatDate(getJSTNow()));
    await setConfig(
      db,
      'guild_names',
      JSON.stringify({
        day: formatDate(getJSTNow()),
        names: { '1001': 'テストサーバー' },
      }),
    );
    const calls = sending();
    await runTick(E);
    expect(calls).toHaveLength(2); // DM1件＋失敗通知1件。もう一人は次のtick。
    expect(calls[0].url).toContain('/channels/dm-3001/messages');
    expect(calls[1].body.content).toContain('未回答リマインド: テスト会');
    expect(calls[1].body.content).toContain('<@3001>');
    expect(calls[1].body.allowed_mentions).toEqual({
      parse: [],
      roles: ['4002'],
    });
    await runTick(E);
    expect(calls).toHaveLength(4);
    await runTick(E);
    expect(calls).toHaveLength(4);
  });

  it.each([403, 503])(
    '日程調整の投稿エラー%sを知らせ、failed/unknownを維持して自動再投稿しない',
    async (status) => {
      await configure();
      const p = await createPlan(db, '1001', {
        ...blankPlan('9月の日程調整'),
        state: 'open',
        deadline: '2099-09-01T00:00:00Z',
        channel: '2001',
      });
      await deliveryStatement(db, p, '1=1', 'delivery', 'publish', '2001', {
        content: '案内',
      }).run();
      const calls: any[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
          calls.push({
            url: String(url),
            body: JSON.parse(String(init?.body)),
          });
          return new Response('{"id":"message"}', {
            status: String(url).includes('/2003/') ? 200 : status,
          });
        }),
      );
      await deliverPending({ ...E, MOCK_DISCORD: undefined });
      expect(calls).toHaveLength(2);
      expect(calls[1].body.content).toContain('日程調整「9月の日程調整」の回答案内');
      expect((await db.prepare('SELECT status FROM planning_deliveries').first<any>())?.status).toBe(
        status === 403 ? 'failed' : 'unknown',
      );
      await deliverPending({ ...E, MOCK_DISCORD: undefined });
      expect(calls).toHaveLength(2);
    },
  );
});

describe('締切後の変更通知（P2-01）', () => {
  /** 締切を過ぎた開催回の参加ボタンを、署名付きの Interaction として押す。waitUntil の後続まで待つ。 */
  async function pressAfterDeadline() {
    const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
    const publicKey = hex((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer);
    const occ = await getOrCreateOccurrence(db, 1, '2020/01/01', '21:00');
    const body = JSON.stringify({
      type: 3,
      application_id: 'app',
      token: 'tok',
      guild_id: '1001',
      data: { custom_id: `participate_${occ.id}` },
      member: { user: { id: '3001', username: 'aoi' }, roles: [] },
    });
    const ts = '1700000000';
    const sig = hex(await crypto.subtle.sign('Ed25519', pair.privateKey, new TextEncoder().encode(ts + body)));
    const tasks: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => tasks.push(p) } as unknown as ExecutionContext;
    await handleInteraction(
      new Request('https://test.invalid/interactions', {
        method: 'POST',
        headers: { 'x-signature-ed25519': sig, 'x-signature-timestamp': ts },
        body,
      }),
      { ...E, DISCORD_PUBLIC_KEY: publicKey },
      ctx,
    );
    while (tasks.length) await tasks.shift();
  }
  const posted = (calls: { url: string }[]) =>
    calls.filter((c) => c.url.includes('/channels/')).map((c) => c.url.match(/channels\/(\d+)/)![1]);

  it('回答非公開で変更通知チャンネルが空なら、投稿チャンネルではなく失敗通知の投稿先へ送る', async () => {
    await configure();
    await schedule();
    await db.prepare('UPDATE notifications SET share_answers=0, response_deadline_hours=1').run();
    const calls = sending();
    await pressAfterDeadline();
    expect(posted(calls)).toEqual(['2003']);
    const alert = calls.find((c) => c.url.includes('/channels/2003/'))!;
    expect(alert.body.content).toContain('締切後の回答変更');
    expect(alert.body.allowed_mentions).toEqual({ parse: [] });
  });

  it('回答非公開で失敗通知の投稿先も未設定なら送らない', async () => {
    await schedule();
    await db.prepare('UPDATE notifications SET share_answers=0, response_deadline_hours=1').run();
    const calls = sending();
    await pressAfterDeadline();
    expect(posted(calls)).toEqual([]);
  });

  it('回答公開なら従来どおり投稿チャンネルへ送る', async () => {
    await configure();
    await schedule();
    await db.prepare('UPDATE notifications SET share_answers=1, response_deadline_hours=1').run();
    const calls = sending(false);
    await pressAfterDeadline();
    // 投稿チャンネル（2001）への送信が失敗し、失敗通知（2003）が続く
    expect(posted(calls)).toEqual(['2001', '2003']);
  });
});

describe('Discord の 429（P2-02）', () => {
  it('claim を消してそのティックを打ち切り、失敗通知を出さず、次のティックで送る', async () => {
    await configure();
    const n = await schedule();
    const tomorrow = getJSTNow();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const occ = await getOrCreateOccurrence(db, n.id, formatDate(tomorrow), '23:59');
    const key = { notification_id: n.id, occurrence_id: occ.id, kind: 'recruit' as const, send_date: formatDate(getJSTNow()) };
    await claimSend(db, key);
    await finishSend(db, key, true);
    for (const user of ['3001', '3002']) {
      await db.prepare('INSERT INTO members(user_id,display_name,dm_channel_id) VALUES(?,?,?)').bind(user, user, `dm-${user}`).run();
      await db.prepare("INSERT INTO segment_members(segment_id,user_id,status) VALUES(1,?,'')").bind(user).run();
    }
    await setConfig(db, 'rolesync:1001', formatDate(getJSTNow()));
    await setConfig(db, 'guild_names', JSON.stringify({ day: formatDate(getJSTNow()), names: { '1001': 'テストサーバー' } }));
    let status = 429;
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: RequestInfo | URL) => {
        urls.push(String(url));
        return new Response(status === 429 ? '{"retry_after":1,"global":false}' : '{"id":"message"}', { status });
      }),
    );
    await runTick(E);
    expect(urls).toEqual(['https://discord.com/api/v10/channels/dm-3001/messages']); // 2 人目へ進まず、失敗通知も出さない
    const reminders = () => db.prepare("SELECT user_id, status FROM send_log WHERE kind='remind_unanswered' ORDER BY user_id").all<any>();
    expect((await reminders()).results).toEqual([]);
    status = 200;
    await runTick(E);
    expect(urls.slice(1)).toEqual([
      'https://discord.com/api/v10/channels/dm-3001/messages',
      'https://discord.com/api/v10/channels/dm-3002/messages',
    ]);
    expect((await reminders()).results).toEqual([
      { user_id: '3001', status: 'sent' },
      { user_id: '3002', status: 'sent' },
    ]);
  });
});

describe('DM の失敗通知はまとめて 1 件（レビュー A7-02）', () => {
  it('DM が届かなかった人を 1 件の失敗通知にまとめる', async () => {
    await configure();
    const n = await schedule();
    const tomorrow = getJSTNow();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const occ = await getOrCreateOccurrence(db, n.id, formatDate(tomorrow), '23:59');
    const key = { notification_id: n.id, occurrence_id: occ.id, kind: 'recruit' as const, send_date: formatDate(getJSTNow()) };
    await claimSend(db, key);
    await finishSend(db, key, true);
    for (const user of ['3101', '3102', '3103']) {
      await db.prepare('INSERT INTO members(user_id,display_name,dm_channel_id) VALUES(?,?,?)').bind(user, user, `dm-${user}`).run();
      await db.prepare("INSERT INTO segment_members(segment_id,user_id,status) VALUES(1,?,'')").bind(user).run();
    }
    await setConfig(db, 'rolesync:1001', formatDate(getJSTNow()));
    await setConfig(db, 'guild_names', JSON.stringify({ day: formatDate(getJSTNow()), names: { '1001': 'テストサーバー' } }));
    const calls = sending(); // 失敗通知の投稿先（2003）以外への送信は失敗する
    await runTick(E);
    const alerts = calls.filter((c) => c.url.includes('/channels/2003/messages'));
    expect(alerts).toHaveLength(1);
    expect(alerts[0].body.content).toContain('DM が 3 人に届きませんでした: <@3101> <@3102> <@3103>');
  });
});
