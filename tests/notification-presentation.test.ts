import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { buildMentionPrefix, composePost } from '../src/discord/rest';
import { createNotification, getNotification } from '../src/db/notifications';
import { createSegment } from '../src/db/segments';
import type { Segment } from '../src/db/types';

/** mention_role_id だけ差し替えた最小 Segment */
const seg = (role: string | null): Segment => ({
  id: 1,
  guild_id: 'g1',
  name: 's',
  mention_role_id: role,
  members_synced_at: null,
  created_at: '',
});

describe('buildMentionPrefix（mention_mode・ADR 0010）', () => {
  it("'none' は常に空（segment があっても）", () => {
    expect(buildMentionPrefix(seg('r1'), 'none', ['1', '2'])).toBe('');
    expect(buildMentionPrefix(null, 'none')).toBe('');
  });

  it("'role' はロール / @everyone をメンション、未設定は空", () => {
    expect(buildMentionPrefix(seg('r1'), 'role')).toBe('<@&r1>\n\n');
    expect(buildMentionPrefix(seg('@everyone'), 'role')).toBe('@everyone\n\n');
    expect(buildMentionPrefix(seg(null), 'role')).toBe('');
  });

  it("'members' はバイネーム列挙（空配列は空）", () => {
    expect(buildMentionPrefix(seg('r1'), 'members', [])).toBe('');
    expect(buildMentionPrefix(seg('r1'), 'members', ['100', '200'])).toBe('<@100> <@200>\n\n');
  });

  it("'members' は2000字未満に収め、超過は「ほかN名」で省略（表示＋省略=全体）", () => {
    // 18桁スノーフレーク相当のユニークIDを大量に用意（`<@id>` ≒ 22字）。
    const ids = Array.from({ length: 200 }, (_, i) => '1' + String(i).padStart(17, '0'));
    const out = buildMentionPrefix(seg('r1'), 'members', ids);
    expect(out.length).toBeLessThan(2000);
    expect(out).toMatch(/ほか\d+名\n\n$/);
    const omitted = Number(out.match(/ほか(\d+)名/)![1]);
    const shown = (out.match(/<@/g) || []).length;
    expect(shown).toBeGreaterThan(0);
    expect(shown + omitted).toBe(200);
  });
});

describe('composePost（投稿合成・ADR 0010）', () => {
  it('メンション＋見出し＋本文＋tail を組む', () => {
    expect(composePost('@everyone\n\n', 'お知らせ', '本文だよ', '日時: **X**')).toBe(
      '@everyone\n\n**お知らせ**\n\n本文だよ\n\n日時: **X**',
    );
  });

  it('本文が空（null / 空白のみ）なら省略する', () => {
    expect(composePost('', '見出し', null, '日時: **X**')).toBe('**見出し**\n\n日時: **X**');
    expect(composePost('', '見出し', '   ', '日時: **X**')).toBe('**見出し**\n\n日時: **X**');
  });
});

describe('notifications 新カラムの往復（migration 0009・ADR 0010）', () => {
  it('mention_mode・requires_response・message_title/body が保存・取得できる', async () => {
    const s = await createSegment(env.DB, { guild_id: 'gP', name: '区分', mention_role_id: null });
    const created = await createNotification(env.DB, {
      guild_id: 'gP',
      segment_id: s.id,
      name: '通知',
      channel_id: 'c1',
      type: 'recurring',
      rrule: 'FREQ=WEEKLY;BYDAY=SA',
      one_off_date: null,
      anchor_date: null,
      start_time: '21:00',
      duration_minutes: null,
      recruit_days_before: 7,
      remind_start_days: 3,
      remind_undecided_days: 1,
      quota_enabled: 0,
      quota_interval_days: null,
      assignment_enabled: 0,
      mention_mode: 'members',
      requires_response: 0,
      message_title: '見出しX',
      message_body: '本文Y',
      active: 1,
    });
    const got = await getNotification(env.DB, created.id);
    expect(got?.mention_mode).toBe('members');
    expect(got?.requires_response).toBe(0);
    expect(got?.message_title).toBe('見出しX');
    expect(got?.message_body).toBe('本文Y');
  });
});
