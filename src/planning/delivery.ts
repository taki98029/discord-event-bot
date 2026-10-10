import type { Env } from '../env';
import { API, USER_AGENT } from '../discord/rest';
import type { Plan, Slot } from './model';
import { getPlan } from './store';
import { requireValue, unanswered, planningGroups } from './model';
import { planningClosed, planningDeadline } from './answer-view';
import { notifyDeliveryFailure } from '../discord/failureNotifications';
import { announcementText } from './announcement';
import { cutText } from '../lib/text';

export async function discord(env: Env, path: string, method = 'GET', body?: unknown): Promise<any> {
  if (env.MOCK_DISCORD) {
    if (path.includes('/channels/') && method === 'GET')
      return { id: path.split('/').pop(), guild_id: 'test-guild', type: 15 };
    return { id: 'mock-' + crypto.randomUUID(), message: { id: 'mock-message-' + crypto.randomUUID() } };
  }
  const r = await fetch(API + path, {
    method,
    signal: AbortSignal.timeout(15000),
    headers: {
      Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Discord ${r.status}`);
  return r.status === 204 ? {} : r.json();
}
export async function validateChannel(env: Env, guild: string, id: string, forum = false, tag = '') {
  requireValue(/^\d{5,22}$/.test(id), '投稿チャンネルを選択してください');
  if (env.MOCK_DISCORD) return;
  const c = await discord(env, `/channels/${id}`);
  requireValue(
    c.guild_id === guild && (forum ? c.type === 15 : [0, 5].includes(c.type)),
    forum
      ? '同じサーバーのフォーラムを選択してください'
      : '同じサーバーのテキストチャンネルを選択してください',
  );
  if (forum) {
    requireValue(!(c.flags & 16) || tag, 'このフォーラムはタグの指定が必要です');
    requireValue(
      !tag || c.available_tags?.some((t: any) => t.id === tag),
      'フォーラムのタグを選び直してください',
    );
  }
}
const answerGuide = '※初回・端末変更時は「初回利用」を押してください。';
export function answerAnnouncement(p: Plan, notice = '') {
  const closed = planningClosed(p);
  // Segment roles captured at publish time (C04, 2026-09-20). '@everyone' is a segment role value, not a role id.
  const roles = p.data.mentionRoles ?? [];
  const everyone = roles.includes('@everyone');
  const roleIds = roles.filter((r) => r !== '@everyone');
  const mention = roles.length ? `${everyone ? '@everyone ' : ''}${roleIds.map((r) => `<@&${r}>`).join(' ')}\n` : '';
  return {
    content: `${mention}${p.data.name}\n候補${p.data.candidates.filter((c) => c.active).length}件 · 回答締切 ${planningDeadline(p.data.deadline)}\n\n${notice ? notice + '\n' : ''}${closed ? '回答受付は終了しました。保存済みの回答を確認できます。\n変更が必要な場合は運営担当者へ連絡してください。' : '回答画面で各日時の「可・不可・未定」を選び、最後に「回答を送信」を押してください。\n「可」は参加確定ではありません。締切までは変更できます。'}\n${p.data.shareAnswers ? '回答内容は運営と、この日程調整の他の回答者も確認できます。' : '回答内容はあなたと運営だけが確認できます。'}${p.data.note ? '\n\n' + p.data.note : ''}\n\n${answerGuide}`,
    allowed_mentions: { parse: everyone ? ['everyone'] : [], ...(roleIds.length ? { roles: roleIds } : {}) },
    components: [
      {
        type: 1,
        components: [
          ...(p.data.answerOrigin
            ? [
                {
                  type: 2,
                  // Discord URL buttons require Link style; Primary cannot navigate directly.
                  style: 5,
                  label: '回答画面を開く',
                  url: new URL(`/answer.html?plan=${p.id}`, p.data.answerOrigin).href,
                },
              ]
            : []),
          {
            type: 2,
            style: 2,
            label: '初回利用',
            custom_id: `plan:open:${p.id}:0`,
          },
        ],
      },
    ],
  };
}
export function slotPayload(p: Plan, slot: Slot, mention: boolean) {
  const c = p.data.candidates.find((c) => c.id === slot.candidate)!;
  const people = new Map(p.data.people.map((x) => [x.id, x]));
  const active = slot.members.filter((m) => m.status !== '除外');
  const users = [...new Set(active.filter((m) => m.status === '参加').map((m) => m.user))];
  requireValue(users.length <= 60, '一つの開催枠の参加者は60人以内にしてください');
  const groups = planningGroups(p.data)
    .map((n) => ({ n, members: active.filter((m) => m.schedule === n) }))
    .filter((x) => x.members.length);
  const text = groups
    .map(
      (g) =>
        `【${p.data.scheduleNames?.[g.n] ?? `テンプレート ${g.n}`}】\n` +
        g.members
          .map(
            (m) =>
              `${people.get(m.user)?.name ?? m.user}${m.duty ? ' / ' + m.duty : ''} — ${m.status === '参加' ? '参加予定' : m.status}`,
          )
          .join('\n'),
    )
    .join('\n\n');
  const description = p.data.announcementTemplate !== undefined
    ? announcementText(p.data, slot)
    : `${slot.gather ? '集合: ' + slot.gather + '\n' : ''}${slot.note}\n\n${text}\n\n欠席・変更は運営担当者へ個別に連絡してください。`;
  requireValue(
    description.length <= 4096,
    '名簿と連絡事項が長すぎます。連絡事項を短くしてください',
  );
  return {
    name: cutText(`${c.date} ${c.time} ${p.data.name}`, 100),
    message: {
      content: `${slot.cancelled ? '【中止】' : '開催案内'} ${c.date} ${c.time}\n${mention && !slot.cancelled ? users.map((u) => `<@${u}>`).join(' ') : ''}`,
      embeds: [
        {
          title: p.data.name.slice(0, 256),
          description,
          footer: { text: `開催枠 ${slot.id}` },
        },
      ],
      allowed_mentions: { parse: [], users: mention && !slot.cancelled ? users : [] },
    },
    applied_tags: p.data.tag ? [p.data.tag] : [],
  };
}
export function deliveryStatement(
  db: D1Database,
  p: Plan,
  guard: string,
  id: string,
  kind: string,
  channel: string,
  payload: unknown,
  slot: string | null = null,
) {
  const now = new Date().toISOString();
  return db
    .prepare(
      `INSERT INTO planning_deliveries(id,plan_id,kind,slot_id,channel_id,payload,created_at,updated_at) SELECT ?,?,?,?,?,?,?,? WHERE ${guard}`,
    )
    .bind(id, p.id, kind, slot, channel, JSON.stringify(payload), now, now);
}
const DELIVERY_KINDS: Record<string, string> = { publish: '回答案内', repost: '回答案内の再投稿', candidates: '候補追加の案内', reminder: '未回答の催促', 'answer-dm': '未回答の催促DM', 'event-reminder': '開催前リマインド', forum: '開催枠の案内', task: '日程候補作成のリマインド' };
const deliveryTarget = (j: { kind: string; payload: string; channel_id: string }) =>
  j.kind === 'answer-dm' ? `送信先: <@${JSON.parse(j.payload).user}>` : `投稿先: <#${j.channel_id}>`;
/** Unknown outcomes are never blindly retried. Admin can associate an existing message/thread. */
export async function deliverPending(env: Env, limit = 5) {
  const db = env.DB;
  // Worker が送信中に止まった投稿は結果不明にして、ほかの失敗と同じく管理者に知らせる
  const stale = (await db
    .prepare(
      `UPDATE planning_deliveries SET status='unknown',error='処理結果を確認してください' WHERE status='sending' AND updated_at < ?
       RETURNING kind,payload,channel_id,
         COALESCE((SELECT guild_id FROM planning_plans p WHERE p.id=plan_id),(SELECT guild_id FROM planning_cycles c WHERE c.id=plan_id)) AS guild_id,
         COALESCE((SELECT json_extract(data,'$.name') FROM planning_plans p WHERE p.id=plan_id),(SELECT json_extract(data,'$.name') FROM planning_cycles c WHERE c.id=plan_id)) AS name`,
    )
    .bind(new Date(Date.now() - 300000).toISOString())
    .all<{ kind: string; payload: string; channel_id: string; guild_id: string | null; name: string | null }>()).results;
  for (const j of stale) {
    if (j.guild_id) await notifyDeliveryFailure(env, j.guild_id, `日程調整「${j.name}」の${DELIVERY_KINDS[j.kind] ?? '投稿'}
${deliveryTarget(j)}
処理が途中で止まり、結果が不明です。送信・投稿履歴を確認してから復旧してください。`);
  }
  const jobs = await db
    .prepare(
      `SELECT * FROM planning_deliveries d WHERE status='pending'
  AND (kind!='event-reminder' OR EXISTS(SELECT 1 FROM planning_deliveries f WHERE f.plan_id=d.plan_id AND f.slot_id=d.slot_id AND f.kind='forum' AND f.status='sent' AND f.thread_id IS NOT NULL))
  AND (kind!='forum' OR NOT EXISTS(SELECT 1 FROM planning_deliveries prior WHERE prior.plan_id=d.plan_id AND prior.slot_id=d.slot_id AND prior.kind='forum' AND prior.id!=d.id AND (prior.status IN ('sending','unknown','failed') OR (prior.status='pending' AND prior.rowid<d.rowid))))
  ORDER BY CASE kind WHEN 'event-reminder' THEN 0 WHEN 'answer-dm' THEN 2 ELSE 1 END,rowid LIMIT ?`,
    )
    .bind(limit)
    .all<any>();
  for (const j of jobs.results) {
    const now = new Date().toISOString();
    const claim = await db
      .prepare(
        "UPDATE planning_deliveries SET status='sending',updated_at=? WHERE id=? AND status='pending' AND (kind!='forum' OR NOT EXISTS(SELECT 1 FROM planning_deliveries prior WHERE prior.plan_id=planning_deliveries.plan_id AND prior.slot_id=planning_deliveries.slot_id AND prior.kind='forum' AND prior.id!=planning_deliveries.id AND (prior.status IN ('sending','unknown','failed') OR (prior.status='pending' AND prior.rowid<planning_deliveries.rowid))))",
      )
      .bind(now, j.id)
      .run();
    if (!claim.meta.changes) continue;
    let failedPlan: Plan | undefined;
    try {
      let payload = JSON.parse(j.payload);
      let message: string,
        thread: string | null = null;
      const p = await getPlan(db, j.plan_id);
      failedPlan = p;
      if (
        j.kind !== 'forum' &&
        j.kind !== 'event-reminder' &&
        (j.kind === 'repost' ? !['open', 'confirmed'].includes(p.data.state) : planningClosed(p))
      ) {
        await db
          .prepare(
            "UPDATE planning_deliveries SET status='cancelled',error='受付終了のため取り消し' WHERE id=?",
          )
          .bind(j.id)
          .run();
        continue;
      }
      // A repost opens the same plan. Rebuild at delivery time so a newly closed plan never invites edits.
      if (j.kind === 'repost') payload = answerAnnouncement(p);
      if (j.kind === 'reminder') {
        const users = (payload.allowed_mentions?.users ?? []).filter(
          (u: string) => p.data.people.some((person) => person.id === u) && unanswered(p.data, u).length,
        );
        if (!users.length) {
          await db.prepare("UPDATE planning_deliveries SET status='cancelled' WHERE id=?").bind(j.id).run();
          continue;
        }
        payload = {
          ...answerAnnouncement(p),
          content: `${users.map((u: string) => `<@${u}>`).join(' ')}\n${p.data.name}\n未回答の候補があります。ボタンから続きの回答をお願いします。\n回答締切 ${planningDeadline(p.data.deadline)}\n回答済みの内容は保持されています。\n\n${answerGuide}`,
          allowed_mentions: { parse: [], users },
        };
      }

      let target = j.channel_id;
      if (j.kind === 'answer-dm') {
        const user = payload.user;
        const day = (stamp: number) => new Date(stamp + 9 * 3600000).toISOString().slice(0, 10);
        if (!p.data.answerReminder?.enabled || day(Date.parse(j.created_at)) !== day(Date.now()) || !p.data.people.some((u) => u.id === user) || !unanswered(p.data, user).length) {
          await db.prepare("UPDATE planning_deliveries SET status='cancelled' WHERE id=?").bind(j.id).run();
          continue;
        }
        const cached = await db.prepare('SELECT dm_channel_id FROM members WHERE user_id=?').bind(user).first<{ dm_channel_id: string | null }>();
        target = cached?.dm_channel_id || (await discord(env, '/users/@me/channels', 'POST', { recipient_id: user })).id;
        if (!cached?.dm_channel_id)
          await db.prepare('UPDATE members SET dm_channel_id=? WHERE user_id=?').bind(target, user).run();
        await db.prepare('UPDATE planning_deliveries SET channel_id=? WHERE id=?').bind(target, j.id).run();
        payload = {
          ...answerAnnouncement(p),
          content: `${p.data.name}\n未回答の候補があります。回答画面から続きの回答をお願いします。\n回答締切 ${planningDeadline(p.data.deadline)}\n回答済みの内容は保持されています。\n\n${answerGuide}`,
          allowed_mentions: { parse: [] },
        };
      }
      if (j.kind === 'event-reminder') {
        const slot = p.data.slots.find((s) => s.id === j.slot_id);
        const candidate = p.data.candidates.find((c) => c.id === slot?.candidate && c.active);
        const start = candidate?.time ? Date.parse(`${candidate.date}T${candidate.time}:00+09:00`) : NaN;
        const users = [...new Set(slot?.members.filter((m) => m.status === '参加').map((m) => m.user) ?? [])];
        if (p.data.state !== 'confirmed' || !p.data.eventReminderHours || !slot || slot.cancelled || !users.length || !Number.isFinite(start) || Date.now() >= start) {
          await db.prepare("UPDATE planning_deliveries SET status='cancelled' WHERE id=?").bind(j.id).run();
          continue;
        }
        const forum = await db.prepare("SELECT thread_id FROM planning_deliveries WHERE plan_id=? AND slot_id=? AND kind='forum' AND status='sent' AND thread_id IS NOT NULL ORDER BY rowid DESC LIMIT 1")
          .bind(p.id, slot.id).first<{ thread_id: string }>();
        requireValue(forum, '開催案内の投稿を確認してください');
        target = forum.thread_id;
        const channel = await discord(env, `/channels/${target}`);
        if (channel.thread_metadata?.archived) await discord(env, `/channels/${target}`, 'PATCH', { archived: false });
        // Rosters change by hand in Discord, so the reminder pings the thread: @everyone in a thread notifies only its members.
        payload = {
          content: `@everyone\n「${p.data.name}」の開催前リマインドです。\n開始: ${candidate!.date} ${candidate!.time}\n詳細はこのフォーラムの開催案内をご確認ください。`,
          allowed_mentions: { parse: ['everyone'] },
        };
        await db.prepare('UPDATE planning_deliveries SET channel_id=? WHERE id=?').bind(target, j.id).run();
      }

      if (j.kind === 'forum') {
        const old = await db
          .prepare(
            "SELECT thread_id,message_id FROM planning_deliveries WHERE plan_id=? AND slot_id=? AND status='sent' AND kind='forum' AND thread_id IS NOT NULL ORDER BY created_at DESC LIMIT 1",
          )
          .bind(j.plan_id, j.slot_id)
          .first<any>();
        const slot = p.data.slots.find((s) => s.id === j.slot_id);
        if (slot) payload = slotPayload(p, slot, !old);
        if (!old && slot?.cancelled) {
          await db.prepare("UPDATE planning_deliveries SET status='cancelled' WHERE id=?").bind(j.id).run();
          continue;
        }
        if (old) {
          const channel = await discord(env, `/channels/${old.thread_id}`);
          if (channel.thread_metadata?.archived)
            await discord(env, `/channels/${old.thread_id}`, 'PATCH', { archived: false });
          await discord(
            env,
            `/channels/${old.thread_id}/messages/${old.message_id}`,
            'PATCH',
            payload.message,
          );
          message = old.message_id;
          thread = old.thread_id;
        } else {
          const r = await discord(env, `/channels/${j.channel_id}/threads`, 'POST', payload);
          message = r.message?.id ?? r.id;
          thread = r.id;
        }
      } else {
        const r = await discord(env, `/channels/${target}/messages`, 'POST', {
          ...payload,
          nonce: Array.from(
            new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(j.id))),
          )
            .slice(0, 12)
            .map((x) => x.toString(16).padStart(2, '0'))
            .join(''),
          enforce_nonce: true,
        });
        message = r.id;
      }
      await db.batch([
        db
          .prepare(
            "UPDATE planning_deliveries SET status='sent',message_id=?,thread_id=?,error=NULL,updated_at=? WHERE id=?",
          )
          .bind(message, thread, new Date().toISOString(), j.id),
        // A posted 回答案内 ends the template's 日程候補作成のリマインド for the current due date.
        ...(j.kind === 'publish' && p.data.profileId
          ? [
              db
                .prepare("UPDATE planning_cycles SET task_status='complete' WHERE id=? AND task_status='pending'")
                .bind(p.data.profileId),
            ]
          : []),
      ]);
    } catch (e) {
      const msg = (e as Error).message;
      // Discord 4xx is a definite rejection. Transport / server errors may have committed.
      const status = /^Discord 4\d\d$/.test(msg) ? 'failed' : 'unknown';
      await db
        .prepare('UPDATE planning_deliveries SET status=?,error=?,updated_at=? WHERE id=?')
        .bind(status, msg, new Date().toISOString(), j.id)
        .run();
      const targetLabel = deliveryTarget(j);
      if (failedPlan) await notifyDeliveryFailure(env, failedPlan.guild_id, `日程調整「${failedPlan.data.name}」の${DELIVERY_KINDS[j.kind] ?? '投稿'}\n${targetLabel}\n${status === 'unknown' ? '処理結果が不明です。送信・投稿履歴を確認してから復旧してください。' : 'Discordが送信・投稿を受け付けませんでした。'}`);
    }
  }
}
