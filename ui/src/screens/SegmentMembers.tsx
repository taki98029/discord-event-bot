// 区分メンバー（手動ピッカー / ロール同期・ADR 0009）。スケジュール設定と同格の子ページ。
import * as React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { TextField } from '../../../design-system/src';
import { api, type Guild } from '../api';
import { confirmDialog, withBusy } from '../lib/dialog';
import type { ToastFn } from '../App';

type Segment = { uuid: string; name: string; mention_role_id?: string | null; members_synced_at?: string | null };
type SegMember = { user_id: string; user_name?: string | null; display_name?: string | null; status?: string | null };
type GuildMember = { user_id: string; user_name?: string | null; display_name?: string | null };
type Role = { id: string; name: string };

/** members_synced_at は SQLite の UTC 'YYYY-MM-DD HH:MM:SS'。JST・他画面と同じスラッシュ書式で表示する（M2） */
function syncedAtJst(utc?: string | null): string {
  if (!utc) return '未同期';
  const d = new Date(utc.replace(' ', 'T') + 'Z');
  return isNaN(d.getTime())
    ? utc
    : d.toLocaleString('sv-SE', { timeZone: 'Asia/Tokyo' }).slice(0, 16).replace(/-/g, '/');
}

export function SegmentMembers({
  guild,
  segUuid,
  toast,
  onClose,
}: {
  guild: Guild;
  segUuid: string;
  toast: ToastFn;
  onClose: () => void;
}) {
  const [seg, setSeg] = useState<Segment | null>(null);
  const [list, setList] = useState<SegMember[] | null>(null);
  const [guildMembers, setGuildMembers] = useState<GuildMember[] | null>(null);
  const [roles, setRoles] = useState<Role[] | null>(null);
  const [pickerErr, setPickerErr] = useState('');
  const [search, setSearch] = useState('');

  const load = async () => {
    try {
      const [segs, members] = await Promise.all([
        api('/segments?guild_id=' + encodeURIComponent(guild.id)),
        api('/segments/' + segUuid + '/members'),
      ]);
      setSeg((segs as Segment[]).find((s) => s.uuid === segUuid) || null);
      setList(members);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), true);
    }
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segUuid]);

  const roleManaged = !!(seg && seg.mention_role_id);
  const isEveryone = !!(seg && seg.mention_role_id === '@everyone');

  // ロール管理区分の説明行をロール名で出す（失敗時は生IDフォールバック・ベストエフォート）
  useEffect(() => {
    if (!roleManaged || isEveryone || roles !== null) return;
    api(`/guilds/${guild.id}/roles`).then(setRoles, () => setRoles([]));
  }, [roleManaged, isEveryone, roles, guild.id]);
  const roleLabel = seg?.mention_role_id
    ? roles?.some((r) => r.id === seg.mention_role_id)
      ? '@' + roles.find((r) => r.id === seg.mention_role_id)!.name
      : seg.mention_role_id
    : '';

  useEffect(() => {
    if (!seg || roleManaged || guildMembers !== null) return;
    (async () => {
      try {
        setGuildMembers(await api(`/guilds/${guild.id}/members`));
      } catch (e) {
        setGuildMembers([]);
        setPickerErr(`サーバー参加者を取得できませんでした（${e instanceof Error ? e.message : String(e)}）。Server Members Intent の有効化が必要な場合があります。`);
      }
    })();
  }, [seg, roleManaged, guildMembers, guild.id]);

  const toggle = async (userId: string, newStatus: string) => {
    try {
      await api(`/segments/${segUuid}/members/${encodeURIComponent(userId)}`, { method: 'PUT', body: JSON.stringify({ status: newStatus }) });
      toast('更新しました');
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), true);
    }
  };
  const removeMember = async (userId: string) => {
    const ok = await confirmDialog('このメンバーを区分から外します。', { danger: true, okLabel: '外す' });
    if (!ok) return;
    try {
      await api(`/segments/${segUuid}/members/${encodeURIComponent(userId)}`, { method: 'DELETE' });
      toast('外しました');
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), true);
    }
  };
  const sync = async (btn: HTMLElement | null) => {
    const warn = isEveryone
      ? 'Discord ロール @everyone（サーバー全員）からメンバーを同期します。ロール非保有者は区分から外れ、全員がリマインド/ノルマ DM の対象になります。'
      : 'Discord ロールからメンバーを同期します。ロール非保有の現メンバーは区分から外れます。';
    const ok = await confirmDialog(warn, { okLabel: '同期する', danger: true });
    if (!ok) return;
    await withBusy(btn, async () => {
      try {
        const r = await api(`/segments/${segUuid}/sync-from-role`, { method: 'POST' });
        toast(r && r.message ? r.message : '同期しました');
        await load();
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e), true);
      }
    });
  };
  const addMember = async (m: GuildMember) => {
    try {
      await api(`/segments/${segUuid}/members`, {
        method: 'POST',
        body: JSON.stringify({ user_id: m.user_id, user_name: m.user_name, display_name: m.display_name }),
      });
      toast('追加しました');
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), true);
    }
  };

  const candidates = useMemo(() => {
    if (!guildMembers || !list) return [];
    const already = new Set(list.map((m) => m.user_id));
    const ql = search.toLowerCase();
    return guildMembers
      .filter((m) => !already.has(m.user_id))
      .filter((m) => !ql || (m.display_name || '').toLowerCase().includes(ql) || (m.user_name || '').toLowerCase().includes(ql))
      .slice(0, 30);
  }, [guildMembers, list, search]);

  if (!list) return <p className="muted">読み込み中…</p>;

  const emptyMsg = roleManaged
    ? 'まだ同期されていません。下の「ロールから同期」を実行してください。'
    : 'まだ誰も所属していません。下のピッカーから追加できます。';

  return (
    <dialog className="modal-lg as-page" open aria-labelledby="segMembersTitle">
      <div className="modal-head">
        <div>
          <div className="page-crumb">
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                onClose();
              }}
            >
              メンバー管理
            </a>{' '}
            <span>›</span> <span>メンバー</span>
          </div>
          <h3 id="segMembersTitle">
            区分メンバー: {isEveryone ? 'Everyone' : roles?.find((r) => r.id === seg?.mention_role_id)?.name || seg?.name || segUuid} ({list.length})
          </h3>
        </div>
        <button type="button" className="page-back" aria-label="戻る" onClick={onClose}>
          ← 戻る
        </button>
      </div>
      <div className="modal-body">
        {list.length === 0 ? (
          <div className="empty">{emptyMsg}</div>
        ) : (
          list.map((m) => {
            const paused = m.status === '休止中';
            const name = m.display_name || m.user_name || m.user_id;
            return (
              <div className="pickrow" key={m.user_id}>
                <div>
                  {name} <span className="muted" style={{ fontSize: 12 }}>{m.user_id}</span>{' '}
                  {paused ? <span className="pill off">休止中</span> : <span className="pill on">アクティブ</span>}
                </div>
                <div className="actions">
                  <button className="btn sm secondary" onClick={() => toggle(m.user_id, paused ? '' : '休止中')}>
                    {paused ? '再開' : '休止'}
                  </button>
                  {!roleManaged && (
                    <button className="btn sm danger" onClick={() => removeMember(m.user_id)}>
                      外す
                    </button>
                  )}
                </div>
              </div>
            );
          })
        )}

        {roleManaged ? (
          <>
            <div className="summary" style={{ marginTop: 14 }}>
              🔗{' '}
              <span>
                <b>ロール管理区分</b>：メンバーは Discord ロール「{isEveryone ? '@everyone（全員）' : roleLabel}」
                から自動同期されます（手動での追加・除外は不可、休止は可）。最終同期: {syncedAtJst(seg?.members_synced_at)}
              </span>
            </div>
            {isEveryone && (
              <p className="muted" style={{ fontSize: 12, color: 'var(--warn)' }}>
                ⚠️ @everyone はサーバー全員が対象です。リマインド/ノルマの DM も全員へ届きます。
              </p>
            )}
            <div className="actions">
              <button className="btn" onClick={(e) => sync(e.currentTarget)}>
                🔄 ロールから同期
              </button>
            </div>
          </>
        ) : (
          <>
            <h3 style={{ marginTop: 14 }}>メンバーを追加</h3>
            <div className="search">
              <TextField placeholder="サーバー参加者を検索（User ID 入力は不要）" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <div style={{ marginTop: 8 }}>
              {guildMembers === null ? (
                <p className="muted">読み込み中…</p>
              ) : pickerErr ? (
                <p className="muted">{pickerErr}</p>
              ) : candidates.length === 0 ? (
                <p className="muted">該当する参加者がいません。</p>
              ) : (
                candidates.map((m) => (
                  <div className="pickrow" key={m.user_id}>
                    <div>
                      {m.display_name || m.user_name || m.user_id} <span className="muted" style={{ fontSize: 12 }}>{m.user_name || ''}</span>
                    </div>
                    <button className="btn sm" onClick={() => addMember(m)}>
                      追加
                    </button>
                  </div>
                ))
              )}
            </div>
          </>
        )}
      </div>
      <div className="modal-foot">
        <button type="button" className="btn ghost" onClick={onClose}>
          閉じる
        </button>
      </div>
    </dialog>
  );
}
