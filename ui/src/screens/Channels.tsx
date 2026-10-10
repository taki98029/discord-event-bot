// チャンネル管理: 出欠確認・日程調整などの投稿先の選択肢に出すチャンネルを選ぶ（サーバー単位）。
// 全部オン＝未設定（null）で保存し、Discord で増えたチャンネルも出す。一部だけオンにすると、後で増えたチャンネルは出さない。
import * as React from 'react';
import { useEffect, useState } from 'react';
import { api, type Guild } from '../api';
import type { ToastFn } from '../App';

type Channel = { id: string; name: string; type: number; enabled: boolean };
const TYPE_LABEL: Record<number, string> = { 0: 'テキスト', 5: 'アナウンス', 15: 'フォーラム' };

export function Channels({ guild, toast, onDirtyChange }: { guild: Guild; toast: ToastFn; onDirtyChange: (dirty: boolean) => void }) {
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [on, setOn] = useState<Set<string>>(new Set());
  const [saved, setSaved] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let alive = true;
    setError('');
    api(`/planning/channels?guild_id=${guild.id}`).then(
      (cs: Channel[]) => {
        if (!alive) return;
        const ids = cs.filter((c) => c.enabled).map((c) => c.id);
        setChannels(cs);
        setOn(new Set(ids));
        setSaved(ids.join());
      },
      (e) => alive && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      alive = false;
    };
  }, [guild.id, reload]);

  const current = channels?.filter((c) => on.has(c.id)).map((c) => c.id) ?? [];
  const dirty = channels !== null && current.join() !== saved;
  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);

  const toggle = (id: string) =>
    setOn((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  const save = async () => {
    if (!channels || saving || current.length === 0) return;
    setSaving(true);
    try {
      await api(`/guilds/${guild.id}/channel-filter`, {
        method: 'PUT',
        body: JSON.stringify({ enabled: current.length === channels.length ? null : current }),
      });
      setSaved(current.join());
      toast('チャンネルの設定を保存しました');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <h2>チャンネル管理</h2>
      <p className="muted">
        出欠確認・日程調整などで投稿先を選ぶときに、選択肢に出すチャンネルを選びます。オフにしても、すでに投稿先として保存しているチャンネルはそのまま使えます。
        一部だけオンにして保存すると、あとで Discord に作ったチャンネルはオフの状態で追加されます。
      </p>
      {error ? (
        <>
          <p role="alert">{error}</p>
          <button className="btn secondary sm" onClick={() => setReload((n) => n + 1)}>
            再読み込み
          </button>
        </>
      ) : !channels ? (
        <p className="muted">読み込み中…</p>
      ) : channels.length === 0 ? (
        <div className="empty">投稿できるチャンネルがありません。</div>
      ) : (
        <fieldset disabled={saving}>
          <legend>
            選択肢に出すチャンネル（{current.length} / {channels.length}）
          </legend>
          <div className="actions" style={{ marginBottom: 8 }}>
            <button type="button" className="btn secondary sm" onClick={() => setOn(new Set(channels.map((c) => c.id)))}>
              すべて選択
            </button>
            <button type="button" className="btn secondary sm" onClick={() => setOn(new Set())}>
              すべて解除
            </button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
            {channels.map((c) => (
              <label key={c.id} className="inline">
                <input type="checkbox" checked={on.has(c.id)} onChange={() => toggle(c.id)} />#{c.name}
                <span className="muted" style={{ fontSize: 12 }}>
                  {TYPE_LABEL[c.type] ?? ''}
                </span>
              </label>
            ))}
          </div>
          <div className="actions" style={{ marginTop: 12 }}>
            <button className="btn" onClick={save} disabled={!dirty || current.length === 0}>
              保存
            </button>
            {current.length === 0 && <span className="muted">1つ以上選んでください</span>}
          </div>
        </fieldset>
      )}
    </>
  );
}
