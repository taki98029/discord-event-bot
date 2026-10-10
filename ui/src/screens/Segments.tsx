// メンバー区分（グループ分けの母集団定義）。新規/編集はオーバーレイモーダル、
// メンバー一覧は子ページ（ADR 0016・#g/<gid>/segments/<uuid>/members）。
import * as React from 'react';
import { useEffect, useState } from 'react';
import { Select } from '../../../design-system/src';
import { api, type Guild } from '../api';
import { confirmDialog, withBusy } from '../lib/dialog';
import { FormDialog } from '../lib/FormDialog';
import type { ToastFn } from '../App';

type Segment = { uuid: string; name: string; mention_role_id?: string | null; members_synced_at?: string | null };
type Role = { id: string; name: string };

export function Segments({
  guild,
  toast,
  onOpenMembers,
}: {
  guild: Guild;
  toast: ToastFn;
  onOpenMembers: (segUuid: string) => void;
}) {
  const [segs, setSegs] = useState<Segment[] | null>(null);
  const [roles, setRoles] = useState<Role[] | null>(null);
  const [editing, setEditing] = useState<Segment | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [roleId, setRoleId] = useState('');

  const load = async () => {
    try {
      setSegs(await api('/segments?guild_id=' + encodeURIComponent(guild.id)));
    } catch (e) {
      setSegs([]);
      toast(e instanceof Error ? e.message : String(e), true);
    }
    // Discordの現在のロール名を表示。取得失敗時は保存済みの区分名を残す。
    if (!roles) {
      try {
        setRoles(await api(`/guilds/${guild.id}/roles`));
      } catch {}
    }
  };
  const roleName = (id?: string | null) =>
    id === '@everyone' ? 'Everyone' : roles?.find((r) => r.id === id)?.name;
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guild.id]);

  const openForm = async (s: Segment | null) => {
    setEditing(s);
    setRoleId(s?.mention_role_id || '');
    setShowForm(true);
    setRoles(null);
    try {
      setRoles(await api(`/guilds/${guild.id}/roles`));
    } catch (e) {
      setRoles([]);
      toast('ロール一覧の取得に失敗しました: ' + (e instanceof Error ? e.message : String(e)), true);
    }
  };

  const save = async (btn: HTMLElement | null) => {
    const name = roleName(roleId);
    if (!name) return toast('DiscordのロールまたはEveryoneを選んでください', true);
    await withBusy(btn, async () => {
      try {
        const mention_role_id = roleId;
        if (editing) {
          await api(`/segments/${editing.uuid}`, { method: 'PUT', body: JSON.stringify({ name, mention_role_id }) });
          toast('更新しました');
        } else {
          await api('/segments', { method: 'POST', body: JSON.stringify({ guild_id: guild.id, name, mention_role_id }) });
          toast('作成しました');
        }
        setShowForm(false);
        await load();
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e), true);
      }
    });
  };

  const remove = async (uuid: string) => {
    const ok = await confirmDialog(
      'この区分を削除します。所属メンバーの登録も解除されます（過去の回答履歴は残ります）。元に戻せません。',
      { danger: true, okLabel: '削除する' },
    );
    if (!ok) return;
    try {
      await api('/segments/' + uuid, { method: 'DELETE' });
      toast('削除しました');
      await load();
    } catch (e) {
      // スケジュールの対象になっている区分はサーバー側が 409 で拒否する
      if ((e as { status?: number }).status === 409) {
        toast('この区分はテンプレートの対象になっているため削除できません。先に「定期出欠確認」「不定期出欠確認」の「テンプレート作成・編集」か「単発出欠確認」の「✏️ 編集」で対象区分を変更してください。', true);
        return;
      }
      toast(e instanceof Error ? e.message : String(e), true);
    }
  };

  if (segs === null) return <p className="muted">読み込み中…</p>;

  const roleOptions = (
    <>
      <option value="" disabled>選択してください</option>
      <option value="@everyone">Everyone（サーバー全員）</option>
      {(roles || []).map((r) => (
        <option key={r.id} value={r.id}>
          {r.name}
        </option>
      ))}
      {roleId && roleId !== '@everyone' && roles && !roles.some((r) => r.id === roleId) && (
        <option value={roleId} disabled>⚠ 不明なロール ({roleId})</option>
      )}
    </>
  );

  return (
    <>
      <div className="sec-head">
        <h2>メンバー管理</h2>
        <button className="btn" onClick={() => openForm(null)}>
          ＋ 新規区分
        </button>
      </div>
      <p className="muted">メンバー区分（{segs.length}件）を選び、所属メンバーや休止状態を管理します。</p>
      {segs.length === 0 ? (
        <div className="empty">
          メンバー区分がまだありません。
          <br />
          DiscordのロールまたはEveryoneを選んで作成してください。
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {segs.map((s) => (
            <div key={s.uuid} className="listrow">
              <div>
                <div style={{ fontWeight: 600 }}>{roleName(s.mention_role_id) || s.name}</div>
                {!s.mention_role_id && (
                  <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>メンバーを手動で管理</div>
                )}
              </div>
              <div className="actions">
                <button className="btn sm secondary" onClick={() => onOpenMembers(s.uuid)}>
                  メンバー
                </button>
                <button className="btn sm ghost" onClick={() => openForm(s)}>
                  編集
                </button>
                <button className="btn sm ghost danger" onClick={() => remove(s.uuid)}>
                  削除
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <FormDialog
        open={showForm}
        title={editing ? '編集' : '新規区分'}
        onClose={() => setShowForm(false)}
        footer={
          <>
            <button className="btn ghost" type="button" onClick={() => setShowForm(false)}>
              キャンセル
            </button>
            <button className="btn" disabled={!roleName(roleId)} onClick={(e) => save(e.currentTarget)}>
              保存
            </button>
          </>
        }
      >
        <div>
          <label htmlFor="segment-role">Discordのロール / Everyone</label>
          <Select id="segment-role" required value={roleId} onChange={(e) => setRoleId(e.target.value)}>
            {roleOptions}
          </Select>
          <p className="muted" style={{ fontSize: 12, margin: '6px 0 0' }}>
            区分名には選んだロール名またはEveryoneをそのまま使います。メンバーを自動同期し、メンション先になります。
          </p>
        </div>
      </FormDialog>
    </>
  );
}
