import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import {
  membersWithRole,
  isRoleManagedSegment,
  roleGateAllows,
  syncSegmentFromRole,
} from '../src/discord/syncSegment';
import {
  createSegment,
  getSegment,
  listSegmentMembers,
  addSegmentMember,
  setSegmentMemberStatus,
} from '../src/db/segments';

const db = () => env.DB;

const M = (id: string, roles: string[]) => ({ user_id: id, roles });

describe('membersWithRole（ロール保有者の抽出・ADR 0009）', () => {
  it('ロールIDで絞り込む', () => {
    const members = [M('1', ['r1']), M('2', ['r2']), M('3', ['r1', 'r2'])];
    expect(membersWithRole(members, 'r1').map((m) => m.user_id)).toEqual(['1', '3']);
  });
  it('@everyone は全員', () => {
    const members = [M('1', []), M('2', ['r2'])];
    expect(membersWithRole(members, '@everyone').map((m) => m.user_id)).toEqual(['1', '2']);
  });
  it('該当者なしは空配列', () => {
    expect(membersWithRole([M('1', ['x'])], 'r1')).toEqual([]);
  });
});

describe('isRoleManagedSegment', () => {
  it('mention_role_id 設定済みは true（ロール管理）', () => {
    expect(isRoleManagedSegment({ mention_role_id: 'r1' })).toBe(true);
    expect(isRoleManagedSegment({ mention_role_id: '@everyone' })).toBe(true);
  });
  it('null は false（手動管理）', () => {
    expect(isRoleManagedSegment({ mention_role_id: null })).toBe(false);
  });
});

describe('roleGateAllows（回答ボタンのロールゲート・ADR 0009）', () => {
  it('手動区分(null)は常に許可', () => {
    expect(roleGateAllows(null, [])).toBe(true);
    expect(roleGateAllows(null, undefined)).toBe(true);
  });
  it('@everyone は常に許可', () => {
    expect(roleGateAllows('@everyone', [])).toBe(true);
  });
  it('DM(member 不在=undefined)は許可（リマインド回答は既存メンバー前提）', () => {
    expect(roleGateAllows('r1', undefined)).toBe(true);
  });
  it('ギルド内: ロール保有は許可・非保有/空は拒否', () => {
    expect(roleGateAllows('r1', ['r1', 'r2'])).toBe(true);
    expect(roleGateAllows('r1', ['r2'])).toBe(false);
    expect(roleGateAllows('r1', [])).toBe(false);
  });
});

// MOCK_DISCORD=1（vitest.config）でフィクスチャ使用。MOCK_MEMBERS: 3001(aoi)/3002(kenta)=role'4001'、3003(miki)=role無し。
describe('syncSegmentFromRole（完全同期・MOCK・ADR 0009）', () => {
  it('ロール保有者(4001=aoi,kenta)を同期し、非保有者(miki)は入らない・最終同期時刻が入る', async () => {
    const seg = await createSegment(db(), { guild_id: '1001', name: 'キャスト', mention_role_id: '4001' });
    const r = await syncSegmentFromRole(env, seg, { allowEmpty: true });
    expect(r.ok).toBe(true);
    expect(r.added).toBe(2);
    const ids = (await listSegmentMembers(db(), seg.id)).map((m) => m.user_id).sort();
    expect(ids).toEqual(['3001', '3002']);
    expect((await getSegment(db(), seg.id))?.members_synced_at).toBeTruthy();
  });

  it('@everyone は全員(3001,3002,3003)', async () => {
    const seg = await createSegment(db(), { guild_id: '1001', name: '全員', mention_role_id: '@everyone' });
    const r = await syncSegmentFromRole(env, seg, { allowEmpty: true });
    expect(r.ok).toBe(true);
    const ids = (await listSegmentMembers(db(), seg.id)).map((m) => m.user_id).sort();
    expect(ids).toEqual(['3001', '3002', '3003']);
  });

  it('ロールを失った人は除外し、休止状態は保持される', async () => {
    const seg = await createSegment(db(), { guild_id: '1001', name: 'キャスト2', mention_role_id: '4001' });
    await syncSegmentFromRole(env, seg, { allowEmpty: true }); // aoi, kenta
    await setSegmentMemberStatus(db(), seg.id, '3002', '休止中'); // kenta 休止
    await addSegmentMember(db(), seg.id, '3003'); // 非ロール者(miki)を手動投入
    const r = await syncSegmentFromRole(env, seg, { allowEmpty: true });
    expect(r.removed).toBe(1); // miki 除外
    const byId = Object.fromEntries((await listSegmentMembers(db(), seg.id)).map((m) => [m.user_id, m.status]));
    expect(Object.keys(byId).sort()).toEqual(['3001', '3002']);
    expect(byId['3002']).toBe('休止中'); // 休止保持
  });

  it('ロール未設定(手動区分)は同期しない', async () => {
    const seg = await createSegment(db(), { guild_id: '1001', name: '手動', mention_role_id: null });
    const r = await syncSegmentFromRole(env, seg, { allowEmpty: true });
    expect(r.ok).toBe(false);
  });

  it('0人かつ既存ありで allowEmpty=false は無人化を防いでスキップ（既存維持）', async () => {
    const seg = await createSegment(db(), { guild_id: '1001', name: '空ロール', mention_role_id: '9999' });
    await addSegmentMember(db(), seg.id, '3001');
    const r = await syncSegmentFromRole(env, seg, { allowEmpty: false });
    expect(r.ok).toBe(false);
    expect((await listSegmentMembers(db(), seg.id)).length).toBe(1); // 消えていない
  });
});
