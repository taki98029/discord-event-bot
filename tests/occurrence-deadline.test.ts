// 不定期の開催回ごとの回答締切（ADR 0032・2026-09-05）:
//   - 純関数: nextRecruitAt（次の募集投稿時刻）・occurrenceDeadlineError（締切ガード）
//   - admin API: 開催回追加時のガード（不定期の開催回締切・定期の臨時回は雛形の締切＝Q4）、
//     📣 投稿時の締切選択（不定期×手動募集のみ）、投稿済み／締切ありの日時変更ロック
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createSegment } from '../src/db/segments';
import { getOccurrenceByUuid } from '../src/db/occurrences';
import { hasSentKind } from '../src/db/sendLog';
import { handleAdmin } from '../src/admin/index';
import { nextRecruitAt, occurrenceDeadlineError, formatDate } from '../src/lib/date';
import type { Env } from '../src/env';
import type { Notification, Occurrence } from '../src/db/types';

const db = () => env.DB;

describe('締切ガードの純関数', () => {
  const now = new Date(2026, 8, 5, 10, 0); // 2026/09/05 10:00
  it('nextRecruitAt: N 日前の送信時刻。過ぎていれば今日の送信時刻（追いつき投稿は cron が send_hour まで待つ）・それも過ぎていれば今', () => {
    const n = { recruit_days_before: 7, send_hour: 21 };
    expect(nextRecruitAt(n, '2026/09/20', now)).toEqual(new Date(2026, 8, 13, 21, 0, 0, 0));
    expect(nextRecruitAt(n, '2026/09/08', now)).toEqual(new Date(2026, 8, 5, 21, 0, 0, 0)); // 7 日前（9/1）は過去→今日 21:00
    const late = new Date(2026, 8, 5, 22, 0); // 今日の送信時刻も過ぎている→今（次ティック）
    expect(nextRecruitAt(n, '2026/09/08', late)).toBe(late);
  });
  it('occurrenceDeadlineError: 締切が募集投稿時刻より前なら理由文・後なら null・締切なしは null', () => {
    const recruitAt = new Date(2026, 8, 13, 21, 0);
    const ok = occurrenceDeadlineError({ dateStr: '2026/09/20', timeStr: '20:00', deadlineHours: 24, recruitAt });
    expect(ok).toBeNull();
    const ng = occurrenceDeadlineError({ dateStr: '2026/09/14', timeStr: '20:00', deadlineHours: 24, recruitAt });
    expect(ng).toContain('募集の投稿予定（9/13 21:00）より前');
    expect(occurrenceDeadlineError({ dateStr: '2026/09/14', timeStr: '20:00', deadlineHours: null, recruitAt })).toBeNull();
    // 投稿時（募集時刻＝今）は文言が変わる
    const post = occurrenceDeadlineError({ dateStr: '2026/09/05', timeStr: '20:00', deadlineHours: 12, recruitAt: now, posting: true });
    expect(post).toContain('すでに過ぎている');
  });
});

describe('admin API - 開催回の回答締切（ADR 0032）', () => {
  const adminEnv = () => ({ DB: db(), ADMIN_TOKEN: 't', DISCORD_BOT_TOKEN: 'b' }) as unknown as Env;
  const call = (method: string, path: string, body?: unknown) =>
    handleAdmin(
      new Request(`https://x.dev/api/admin${path}`, {
        method,
        headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      adminEnv(),
    );
  const body = (segment_uuid: string, over: Record<string, unknown> = {}) => ({
    guild_id: 'gD',
    segment_uuid,
    name: 'N',
    channel_id: 'ch1',
    message_title: 'T',
    rrule: null,
    start_time: '20:00',
    recruit_days_before: 7,
    send_hour: 21,
    ...over,
  });
  async function segmentUuid() {
    return (await createSegment(db(), { guild_id: 'gD', name: 'S', mention_role_id: null })).uuid;
  }
  const daysAhead = (d: number) => formatDate(new Date(Date.now() + d * 86_400_000));
  function stubFetch(): () => void {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => new Response('{"id":"m1"}', { status: 200 })) as typeof fetch;
    return () => {
      globalThis.fetch = orig;
    };
  }

  it('不定期×自動募集: 締切は登録時に付けられる。募集投稿予定より前の締切は 400', async () => {
    const su = await segmentUuid();
    const n = (await (await call('POST', '/notifications', body(su))).json()) as Notification;
    // 20 日先・締切 24h → 募集は 13 日先 21:00 → OK
    const ok = await call('POST', `/notifications/${n.uuid}/occurrences`, { date: daysAhead(20), response_deadline_hours: 24 });
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as Occurrence).response_deadline_hours).toBe(24);
    // 明日 20:00 開催・締切 48h → 締切はもう過去・募集は「今」→ 400
    const ng = await call('POST', `/notifications/${n.uuid}/occurrences`, { date: daysAhead(1), response_deadline_hours: 48 });
    expect(ng.status).toBe(400);
    expect(((await ng.json()) as { error: string }).error).toContain('募集の投稿予定');
    // 締切なしなら遅れ登録でも登録できる
    expect((await call('POST', `/notifications/${n.uuid}/occurrences`, { date: daysAhead(1) })).status).toBe(201);
  });

  it('不定期×手動募集: 登録時の締切は 400・📣 投稿時に選ぶ（設定→投稿→以後は日時も締切も変更不可）', async () => {
    const su = await segmentUuid();
    const n = (await (await call('POST', '/notifications', body(su, { recruit_enabled: false }))).json()) as Notification;
    const pre = await call('POST', `/notifications/${n.uuid}/occurrences`, { date: daysAhead(10), response_deadline_hours: 24 });
    expect(pre.status).toBe(400);
    expect(((await pre.json()) as { error: string }).error).toContain('📣');
    const occ = (await (await call('POST', `/notifications/${n.uuid}/occurrences`, { date: daysAhead(10) })).json()) as Occurrence;
    expect(occ.response_deadline_hours).toBeNull();
    // 過去になる締切（10 日先の開催に 400 時間前）は投稿不可
    const bad = await call('POST', `/occurrences/${occ.uuid}/recruit`, { response_deadline_hours: 400 });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toContain('すでに過ぎている');
    const restore = stubFetch();
    try {
      const sent = await call('POST', `/occurrences/${occ.uuid}/recruit`, { response_deadline_hours: 24 });
      expect(sent.status).toBe(200);
    } finally {
      restore();
    }
    const got = await getOccurrenceByUuid(db(), occ.uuid);
    expect(got?.response_deadline_hours).toBe(24);
    expect(await hasSentKind(db(), n.id, occ.id, 'recruit')).toBe(true);
    // 投稿済み＋締切あり: 日時変更は 400・締切の付け替えも 400
    const mv = await call('PUT', `/occurrences/${occ.uuid}`, { date: daysAhead(12) });
    expect(mv.status).toBe(400);
    expect(((await mv.json()) as { error: string }).error).toContain('変更できません');
    const again = await call('POST', `/occurrences/${occ.uuid}/recruit`, { response_deadline_hours: 6 });
    expect(again.status).toBe(400);
  });

  it('定期の臨時回: 雛形の締切が募集投稿予定より前になる登録は 400（Q4）。開催回に締切は付けられない', async () => {
    const su = await segmentUuid();
    const n = (await (
      await call('POST', '/notifications', body(su, { rrule: 'FREQ=WEEKLY;BYDAY=SA', response_deadline_hours: 48, remind_start_days: 4, remind_undecided_days: 3 }))
    ).json()) as Notification;
    expect(n.response_deadline_hours).toBe(48);
    const ng = await call('POST', `/notifications/${n.uuid}/occurrences`, { date: daysAhead(1) });
    expect(ng.status).toBe(400);
    const ok = await call('POST', `/notifications/${n.uuid}/occurrences`, { date: daysAhead(20) });
    expect(ok.status).toBe(201);
    const own = await call('POST', `/notifications/${n.uuid}/occurrences`, { date: daysAhead(21), response_deadline_hours: 6 });
    expect(own.status).toBe(400);
    expect(((await own.json()) as { error: string }).error).toContain('定期');
  });

  it('締切なしの開催回は投稿前なら日時を変更できる', async () => {
    const su = await segmentUuid();
    const n = (await (await call('POST', '/notifications', body(su))).json()) as Notification;
    const occ = (await (await call('POST', `/notifications/${n.uuid}/occurrences`, { date: daysAhead(10) })).json()) as Occurrence;
    expect((await call('PUT', `/occurrences/${occ.uuid}`, { date: daysAhead(11) })).status).toBe(200);
  });
});

describe('中止した開催回の登録し直し（ADR 0032・2026-10-03 リリース前レビュー R-04）', () => {
  const adminEnv = () => ({ DB: db(), ADMIN_TOKEN: 't', DISCORD_BOT_TOKEN: 'b' }) as unknown as Env;
  const call = (method: string, path: string, body?: unknown) =>
    handleAdmin(
      new Request(`https://x.dev/api/admin${path}`, {
        method,
        headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      adminEnv(),
    );
  const daysAhead = (d: number) => formatDate(new Date(Date.now() + d * 86_400_000));
  async function setup() {
    const su = (await createSegment(db(), { guild_id: 'gR', name: 'S', mention_role_id: null })).uuid;
    const n = (await (
      await call('POST', '/notifications', { guild_id: 'gR', segment_uuid: su, name: 'N', channel_id: 'ch1', message_title: 'T', rrule: null, start_time: '20:00', recruit_days_before: 7, send_hour: 21 })
    ).json()) as Notification;
    const date = daysAhead(20);
    const occ = (await (await call('POST', `/notifications/${n.uuid}/occurrences`, { date, response_deadline_hours: 48, note: '旧補足' })).json()) as Occurrence;
    // 回答と「募集を投稿済み」の記録がある状態にする
    await db().batch([
      db().prepare("INSERT INTO members(user_id,user_name,display_name) VALUES('8101','a','あ') ON CONFLICT DO NOTHING"),
      db().prepare("INSERT INTO responses(occurrence_id,user_id,status,updated_at) VALUES(?,'8101','参加','2026-10-01T00:00:00Z')").bind(occ.id),
      db().prepare("INSERT INTO send_log(notification_id,occurrence_id,user_id,kind,send_date,status,created_at) VALUES(?,?,'','recruit','2026/10/01','sent','2026-10-01T00:00:00Z')").bind(n.id, occ.id),
    ]);
    expect((await call('PUT', `/occurrences/${occ.uuid}`, { status: 'cancelled' })).status).toBe(200);
    return { n, occ, date };
  }
  const responsesOf = async (id: number) => (await db().prepare('SELECT COUNT(*) AS c FROM responses WHERE occurrence_id=?').bind(id).first<{ c: number }>())!.c;

  it('同じ日時で登録し直すと、回答・締切・補足・投稿の記録を引き継がず、新しい締切で始まる', async () => {
    const { n, occ, date } = await setup();
    const res = await call('POST', `/notifications/${n.uuid}/occurrences`, { date, response_deadline_hours: 24 });
    expect(res.status).toBe(201);
    const again = (await getOccurrenceByUuid(db(), occ.uuid))!;
    expect(again.status).toBe('scheduled');
    expect(again.response_deadline_hours).toBe(24);
    expect(again.note).toBeNull();
    expect(await responsesOf(occ.id)).toBe(0);
    expect(await hasSentKind(db(), n.id, occ.id, 'recruit')).toBe(false); // 募集はあらためて投稿される
  });

  it('「中止の取り消し」（PUT で scheduled に戻す）は回答を残す', async () => {
    const { occ } = await setup();
    expect((await call('PUT', `/occurrences/${occ.uuid}`, { status: 'scheduled' })).status).toBe(200);
    expect(await responsesOf(occ.id)).toBe(1);
    expect((await getOccurrenceByUuid(db(), occ.uuid))!.response_deadline_hours).toBe(48);
  });
});
