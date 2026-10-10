import type { Env } from '../env';
import type { Segment } from '../db/types';
import { listGuildMembers, type GuildMemberSummary } from './rest';
import {
  listSegmentMembers,
  addSegmentMemberStatements,
  removeSegmentMemberStatement,
  setSegmentMembersSyncedAt,
} from '../db/segments';
import { upsertGuildDisplayNames } from '../db/members';

const SYNC_BATCH_SIZE = 100;

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
 * mention_role_id の入力を検証・正規化する（管理 API の保存時に呼ぶ）。
 * - 空/null → null（手動管理区分）
 * - '@everyone' → そのまま（センチネル・ADR 0009）
 * - ロールID（数字のみ）→ そのまま。ただし guildId と同値（= @everyone ロールの実ID）は
 *   '@everyone' に正規化する（Discord 仕様で member.roles に @everyone は含まれず、
 *   実IDのまま保存すると誰にも一致せず永遠に0名同期になるため）
 * - それ以外（ロール名・<@&id> 形式・非文字列）→ undefined（呼び出し側で 400 にする）
 */
export function normalizeMentionRoleId(v: unknown, guildId: string): string | null | undefined {
  if (v == null) return null;
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (s === '') return null;
  if (s === '@everyone') return '@everyone';
  if (!/^\d{1,20}$/.test(s)) return undefined;
  return s === guildId ? '@everyone' : s;
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
 * - memberRoles=undefined（DM 由来でロール情報が無い）はロール判定を省略する。
 *   呼び出し側で書き込み前に現在の所属・休止状態を必ず確認し、DM では自動所属させない。
 *   ギルド内ボタンは member.roles が付くのでロールで判定する。
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

  // ギルドごとの表示名を全員分（既存メンバー含め）最新化する（nick 変更の追従・ADR 0022）。
  // batch 1 回 = 1 サブリクエスト。
  await upsertGuildDisplayNames(env.DB, segment.guild_id, wanted);

  // 差分の追加・削除は batch にまとめる（人数分を個別に打つと cron の D1 予算 50 を超える・再レビュー A2-03）。
  // 文の意味は addSegmentMember（status 維持の upsert）・removeSegmentMember と同じ。表示名は上で書き込み済み。
  const stmts: D1PreparedStatement[] = [];
  let added = 0;
  for (const m of wanted) {
    if (!currentIds.has(m.user_id)) {
      stmts.push(...addSegmentMemberStatements(env.DB, segment.id, m.user_id, { user_name: m.user_name, display_name: m.display_name }));
      added++;
    }
  }
  let removed = 0;
  for (const m of current) {
    if (!wantedIds.has(m.user_id)) {
      stmts.push(removeSegmentMemberStatement(env.DB, segment.id, m.user_id));
      removed++;
    }
  }
  // ponytail: 1 batch の文の数は D1 の上限内に収めるため 100 文（追加 50 人分）で区切る。1 区分の差分が
  // 1000 人を超えると cron のロール同期の残り（D1_FOR_ROLESYNC=30）に収まらない＝その規模は Paid 前提。
  for (let i = 0; i < stmts.length; i += SYNC_BATCH_SIZE) await env.DB.batch(stmts.slice(i, i + SYNC_BATCH_SIZE));
  await setSegmentMembersSyncedAt(env.DB, segment.id);
  // 0名一致は「正しいが保有者0人」と「ロールID誤り・ロール削除」の区別がつかないため、成功扱いのまま警告を添える。
  const message =
    wantedIds.size === 0
      ? `ロールから同期しました（追加 0・除外 ${removed}・計 0名）。⚠ ロール保有者が見つかりません。ロールが削除されていないか、指定が正しいか確認してください。`
      : `ロールから同期しました（追加 ${added}・除外 ${removed}・計 ${wantedIds.size}名）。`;
  return { ok: true, added, removed, total: wantedIds.size, message };
}
