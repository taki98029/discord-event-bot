import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { getAllConfig, getConfig, setConfig } from '../src/db/config';
import {
  addMember,
  getAllMembers,
  getMember,
  setMemberStatus,
  updateMemberDisplayName,
  upsertMember,
  deleteMember,
} from '../src/db/members';
import {
  upsertEventLog,
  getEventLogsForDate,
  getUndecided,
  getEventStatus,
  checkQuota,
} from '../src/db/eventLog';

const db = () => env.DB;

describe('config', () => {
  it('set → get / getAll', async () => {
    await setConfig(db(), 'Event_StartTime', '21:00');
    await setConfig(db(), 'Recruit_DaysBefore', '6');
    expect(await getConfig(db(), 'Event_StartTime')).toBe('21:00');
    expect(await getConfig(db(), 'NOPE')).toBeNull();
    const all = await getAllConfig(db());
    expect(all.Recruit_DaysBefore).toBe('6');
  });

  it('既存キーは上書きされる', async () => {
    await setConfig(db(), 'k', 'a');
    await setConfig(db(), 'k', 'b');
    expect(await getConfig(db(), 'k')).toBe('b');
  });
});

describe('members', () => {
  it('addMember は新規 added / 重複 exists', async () => {
    expect(await addMember(db(), 'u1', 'name1', 'Disp1')).toBe('added');
    expect(await addMember(db(), 'u1', 'name1', 'Disp1')).toBe('exists');
    const all = await getAllMembers(db());
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe('');
  });

  it('setMemberStatus は対象有無を返す', async () => {
    await addMember(db(), 'u1', 'n', 'D');
    expect(await setMemberStatus(db(), 'u1', '休止中')).toBe(true);
    expect(await setMemberStatus(db(), 'missing', '休止中')).toBe(false);
    expect((await getMember(db(), 'u1'))?.status).toBe('休止中');
  });

  it('updateMemberDisplayName は未設定時のみ書き込む', async () => {
    await addMember(db(), 'u1', null, null);
    await updateMemberDisplayName(db(), 'u1', 'First', 'firstuser');
    let m = await getMember(db(), 'u1');
    expect(m?.display_name).toBe('First');
    expect(m?.user_name).toBe('firstuser');
    // 既に設定済みなので上書きされない
    await updateMemberDisplayName(db(), 'u1', 'Second', 'seconduser');
    m = await getMember(db(), 'u1');
    expect(m?.display_name).toBe('First');
    expect(m?.user_name).toBe('firstuser');
  });

  it('upsertMember / deleteMember（管理 UI 用）', async () => {
    await upsertMember(db(), { user_id: 'u9', user_name: 'x', display_name: 'X', status: '' });
    await upsertMember(db(), { user_id: 'u9', user_name: 'x2', display_name: 'X2', status: 'スタッフ' });
    const m = await getMember(db(), 'u9');
    expect(m?.user_name).toBe('x2');
    expect(m?.status).toBe('スタッフ');
    expect(await deleteMember(db(), 'u9')).toBe(true);
    expect(await getMember(db(), 'u9')).toBeNull();
  });
});

describe('event_log', () => {
  it('upsert は複合キーで更新される', async () => {
    await upsertEventLog(db(), '2025/01/01', 'u1', 'name1', '未定');
    await upsertEventLog(db(), '2025/01/01', 'u1', 'name1', '参加');
    const logs = await getEventLogsForDate(db(), '2025/01/01');
    expect(logs['u1'].status).toBe('参加');
  });

  it('getUndecided は未定のみ返す', async () => {
    await upsertEventLog(db(), '2025/01/01', 'u1', 'n1', '未定');
    await upsertEventLog(db(), '2025/01/01', 'u2', 'n2', '参加');
    const u = await getUndecided(db(), '2025/01/01');
    expect(u.map((x) => x.userId)).toEqual(['u1']);
  });

  it('getEventStatus は休止メンバーを除外し未回答を補完', async () => {
    await addMember(db(), 'u1', 'n1', 'D1');
    await addMember(db(), 'u2', 'n2', 'D2');
    await addMember(db(), 'u3', 'n3', 'D3');
    await setMemberStatus(db(), 'u3', '休止中'); // 除外対象
    await upsertEventLog(db(), '2025/01/01', 'u1', 'n1', '参加');
    const s = await getEventStatus(db(), '2025/01/01');
    expect(s.参加).toEqual(['D1']);
    expect(s.未回答).toEqual(['D2']); // u2 は未回答, u3 は除外
  });

  it('checkQuota は最終参加日から interval を超えたアクティブ会員を返す', async () => {
    await addMember(db(), 'u1', 'n1', 'D1');
    await addMember(db(), 'u2', 'n2', 'D2');
    await addMember(db(), 'u3', 'n3', 'D3'); // 未参加 → 対象外
    await upsertEventLog(db(), '2025/01/01', 'u1', 'n1', '参加'); // 古い
    await upsertEventLog(db(), '2025/03/01', 'u2', 'n2', '参加'); // 直近

    const now = new Date(Date.UTC(2025, 2, 15, 12, 0)); // 2025/03/15 JST
    const alerts = await checkQuota(db(), 30, now);
    const ids = alerts.map((a) => a.user_id);
    expect(ids).toContain('u1'); // 約73日経過 > 30
    expect(ids).not.toContain('u2'); // 14日経過
    expect(ids).not.toContain('u3'); // 未参加
  });
});
