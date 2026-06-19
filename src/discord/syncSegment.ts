import type { Env } from '../env';
import type { Segment } from '../db/types';
import { listGuildMembers, type GuildMemberSummary } from './rest';
import {
  listSegmentMembers,
  addSegmentMember,
  removeSegmentMember,
  setSegmentMembersSyncedAt,
} from '../db/segments';

export interface SegmentSyncResult {
  ok: boolean;
  added: number;
  removed: number;
  total: number;
  message: string;
}

/** ロール管理区分か（mention_role_id にロールID または '@everyone' が設定済み・ADR 0009）。 */
export function isRoleManagedSegment(segment: Pick<Segment, 'mention_role_id'>): boolean {
  return !!segment.mention_role_id;
}

/**
 * roleId のメンバーを抽出する（@everyone は全員）。bot は呼び出し側で除外済み前提。テスト可能な純粋関数。
 */
export function membersWithRole<T extends { roles: string[] }>(members: T[], roleId: string): T[] {
  return roleId === '@everyone' ? members.slice() : members.filter((m) => m.roles.includes(roleId));
}

/**
 * 回答ボタン押下を許可してよいか（ロールゲート・ADR 0009）。
 * - 手動区分(mentionRoleId=null) / '@everyone' は常に許可。
 * - memberRoles=undefined（DM 由来でロール情報が無い）は許可する。DM のリマインド回答ボタンは
 *   ロール同期で母集団に入った所属メンバーにしか届かないため、ロール判定不能でも通す（後段の
 *   所属・休止チェックに委ねる）。ギルド内ボタンは member.roles が付くのでロールで判定する。
 */
export function roleGateAllows(mentionRoleId: string | null, memberRoles: string[] | undefined): boolean {
  if (!mentionRoleId || mentionRoleId === '@everyone') return true;
  if (memberRoles === undefined) return true;
  return memberRoles.includes(mentionRoleId);
}

/**
 * ロール管理区分のメンバーを Discord ロールから完全同期する（ADR 0009）。
 * - mention_role_id が '@everyone' なら全人間メンバー、ロールIDならそのロール保有者を母集合にする。
 * - メンバー取得失敗（Server Members Intent 無効・一時エラー）は同期せず ok:false（既存を絶対に消さない）。
 * - allowEmpty=false のとき、ロール保有者0人で現メンバーが残る同期はスキップ（無人化事故防止）。
 *   cron は false（事故防止）、手動同期は true（確認ダイアログ経由なら空にできる）。
 * - 追加は addSegmentMember（status 維持の upsert）、除外は removeSegmentMember。bot は listGuildMembers で除外済み。
 */
export async function syncSegmentFromRole(
  env: Env,
  segment: Segment,
  opts: { allowEmpty?: boolean; members?: GuildMemberSummary[] } = {},
): Promise<SegmentSyncResult> {
  const roleId = segment.mention_role_id;
  if (!roleId) {
    return { ok: false, added: 0, removed: 0, total: 0, message: 'この区分にはロールが設定されていません（手動管理）。' };
  }

  // 同一ギルドで複数区分を同期する場合、呼び出し側が取得済みメンバーを渡せる（重複フェッチ回避・cron 用）。
  let guildMembers = opts.members;
  if (!guildMembers) {
    try {
      guildMembers = await listGuildMembers(env, segment.guild_id);
    } catch (e) {
      console.error(`[SegmentSync] member fetch failed (seg=${segment.id}): ${(e as Error).message}`);
      return {
        ok: false,
        added: 0,
        removed: 0,
        total: 0,
        message: 'メンバー取得に失敗しました（Discord の Server Members Intent を確認してください）。同期は行っていません。',
      };
    }
  }

  // ロール保有者（@everyone は全員）。
  const wanted = membersWithRole(guildMembers, roleId);
  const wantedIds = new Set(wanted.map((m) => m.user_id));

  const current = await listSegmentMembers(env.DB, segment.id);
  const currentIds = new Set(current.map((m) => m.user_id));

  // 無人化ガード: 全員除外になる同期は allowEmpty でなければスキップ。
  if (wantedIds.size === 0 && currentIds.size > 0 && !opts.allowEmpty) {
    console.warn(
      `[SegmentSync] role yields 0 members but segment has ${currentIds.size}; skip (seg=${segment.id})`,
    );
    return {
      ok: false,
      added: 0,
      removed: 0,
      total: 0,
      message:
        'ロール保有者が0人でした。全員除外になるため同期をスキップしました（ロールの削除や指定ミスをご確認ください）。',
    };
  }

  let added = 0;
  for (const m of wanted) {
    if (!currentIds.has(m.user_id)) {
      await addSegmentMember(env.DB, segment.id, m.user_id, {
        user_name: m.user_name,
        display_name: m.display_name,
      });
      added++;
    }
  }
  let removed = 0;
  for (const m of current) {
    if (!wantedIds.has(m.user_id)) {
      await removeSegmentMember(env.DB, segment.id, m.user_id);
      removed++;
    }
  }
  await setSegmentMembersSyncedAt(env.DB, segment.id);
  return {
    ok: true,
    added,
    removed,
    total: wantedIds.size,
    message: `ロールから同期しました（追加 ${added}・除外 ${removed}・計 ${wantedIds.size}名）。`,
  };
}
