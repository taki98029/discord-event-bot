// メンバー配置設定（スケジュール設定の子ページ・Notification 単位のマスター設定）
// = 配置結果の投稿先チャンネル ＋ ペア制約。どちらも即時保存。
import * as React from 'react';
import { useEffect, useState } from 'react';
import { Select } from '../../../design-system/src';
import { pickable } from '../lib/channels';
import { api, type Guild } from '../api';
import { withBusy } from '../lib/dialog';
import type { ToastFn } from '../App';

type Channel = { id: string; name: string; enabled?: boolean };
type Segment = { id: string; uuid: string; name: string };
type Member = { user_id: string; display_name?: string | null; user_name?: string | null };
type Constraint = {
  uuid: string;
  user_id_a: string;
  user_id_b: string;
  user_a_name?: string;
  user_b_name?: string;
  direction: 'together' | 'apart';
  strength: 'required' | 'preferred';
};
type NotifSummary = { uuid: string; name: string; segment_id: string; channel_id: string; grouping_channel_id?: string | null };

export function GroupingSettings({
  guild,
  nuuid,
  toast,
  onClose,
  oneOff,
}: {
  guild: Guild;
  nuuid: string;
  toast: ToastFn;
  onClose: () => void;
  /** 単発出欠確認（テンプレート一覧が無いので戻り先・文言を単発に合わせる・P2-15） */
  oneOff?: boolean;
}) {
  const [notif, setNotif] = useState<NotifSummary | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [constraints, setConstraints] = useState<Constraint[]>([]);
  const [candidates, setCandidates] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [gChannel, setGChannel] = useState('');
  const [userA, setUserA] = useState('');
  const [userB, setUserB] = useState('');
  const [direction, setDirection] = useState<'together' | 'apart'>('together');
  const [strength, setStrength] = useState<'required' | 'preferred'>('required');

  async function load() {
    setLoading(true);
    try {
      const n: NotifSummary = await api('/notifications/' + nuuid);
      setNotif(n);
      setGChannel(n.grouping_channel_id || '');
      const [ch, cs, segs] = await Promise.all([
        api(`/guilds/${guild.id}/channels`).catch(() => []),
        api(`/notifications/${nuuid}/constraints`),
        api(`/segments?guild_id=${encodeURIComponent(guild.id)}`),
      ]);
      setChannels(ch);
      setConstraints(cs);
      const seg = (segs as Segment[]).find((s) => s.id === n.segment_id);
      if (seg) {
        try {
          setCandidates(await api(`/segments/${seg.uuid}/members`));
        } catch {
          setCandidates([]);
        }
      }
    } catch (e) {
      toast('テンプレートが見つかりません', true);
      setNotFound(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nuuid]);

  if (notFound) return null;
  if (loading || !notif) return <p className="muted">読み込み中…</p>;

  const chName = (id?: string | null) => {
    const c = channels.find((x) => x.id === id);
    return c ? '#' + c.name : id || '';
  };

  const saveChannel = async (v: string) => {
    setGChannel(v);
    try {
      await api(`/notifications/${nuuid}/grouping-channel`, { method: 'PUT', body: JSON.stringify({ channel_id: v || null }) });
      toast('投稿先を保存しました');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), true);
    }
  };

  const addConstraint = async (btn: HTMLElement | null) => {
    if (!userA || !userB || userA === userB) return toast('異なる 2 名を選んでください', true);
    await withBusy(btn, async () => {
      try {
        await api(`/notifications/${nuuid}/constraints`, {
          method: 'POST',
          body: JSON.stringify({ user_id_a: userA, user_id_b: userB, direction, strength }),
        });
        setUserA('');
        setUserB('');
        await load();
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e), true);
      }
    });
  };

  const removeConstraint = async (cuuid: string) => {
    try {
      await api(`/notifications/${nuuid}/constraints/${cuuid}`, { method: 'DELETE' });
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), true);
    }
  };

  const memberOptions = candidates.map((m) => (
    <option key={m.user_id} value={m.user_id}>
      {m.display_name || m.user_name || m.user_id}
    </option>
  ));

  return (
    <dialog className="modal-lg as-page" open aria-labelledby="constraintsTitle">
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
              {oneOff ? '単発出欠確認' : 'テンプレート'}
            </a>{' '}
            <span>›</span> <span>メンバー配置設定</span>
          </div>
          <h3 id="constraintsTitle">メンバー配置設定: {notif.name}</h3>
        </div>
        <button type="button" className="page-back" aria-label="戻る" onClick={onClose}>
          ← 戻る
        </button>
      </div>
      <div className="modal-body">
        <div className="summary">
          🧩 <span>{oneOff ? 'この出欠確認のメンバー配置設定です。' : 'このテンプレートで毎回使う、メンバー配置の共通設定です。'}変更はその場で保存されます。</span>
        </div>

        <h3 style={{ marginTop: 18 }}>📣 配置結果の投稿先</h3>
        <p className="muted" style={{ fontSize: 12.5, margin: '0 0 6px' }}>
          メンバー配置画面の「📣 配置をチャンネルへ投稿」の投稿先チャンネルです。
        </p>
        <Select style={{ maxWidth: 360 }} value={gChannel} onChange={(e) => saveChannel(e.target.value)}>
          <option value="">募集と同じチャンネル（{chName(notif.channel_id)}）</option>
          {pickable(channels, gChannel).map((c) => (
            <option key={c.id} value={c.id}>
              #{c.name}
            </option>
          ))}
        </Select>

        <h3 style={{ marginTop: 22 }}>🔗 ペア制約</h3>
        <p className="muted" style={{ fontSize: 12.5, margin: '0 0 6px' }}>
          メンバー配置のランダム振り分けと違反チェックに使われます。
        </p>
        <div className="grouping-constraints-list">
          {constraints.length === 0 && <div className="empty">まだ制約はありません。下のフォームから追加できます。</div>}
          {constraints.map((c) => (
            <div key={c.uuid} className="grouping-constraint-row">
              <span>
                {c.user_a_name || c.user_id_a} {c.direction === 'together' ? '🤝' : '🚫'} {c.user_b_name || c.user_id_b}
              </span>
              <span>{c.direction === 'together' ? '同じグループに' : '別のグループに'}</span>
              {c.strength === 'required' ? (
                <span
                  className="pill"
                  style={{
                    fontSize: 11,
                    background: 'color-mix(in srgb,var(--danger) 18%,transparent)',
                    color: 'var(--danger)',
                    borderColor: 'color-mix(in srgb,var(--danger) 55%,transparent)',
                  }}
                >
                  必須
                </span>
              ) : (
                <span className="pill" style={{ fontSize: 11 }}>
                  推奨
                </span>
              )}
              <span className="spacer" />
              <button className="btn sm ghost" onClick={() => removeConstraint(c.uuid)}>
                削除
              </button>
            </div>
          ))}
        </div>
        <div className="grouping-constraints-form" style={{ marginTop: 10 }}>
          <Select value={userA} onChange={(e) => setUserA(e.target.value)}>
            <option value="">メンバーA</option>
            {memberOptions}
          </Select>
          <Select value={userB} onChange={(e) => setUserB(e.target.value)}>
            <option value="">メンバーB</option>
            {memberOptions}
          </Select>
          <Select value={direction} onChange={(e) => setDirection(e.target.value as any)}>
            <option value="together">🤝 同じグループに</option>
            <option value="apart">🚫 別のグループに</option>
          </Select>
          <Select value={strength} onChange={(e) => setStrength(e.target.value as any)}>
            <option value="required">必須</option>
            <option value="preferred">推奨</option>
          </Select>
          <button className="btn sm" onClick={(e) => addConstraint(e.currentTarget)}>
            ＋ 追加
          </button>
        </div>
        {candidates.length === 0 && (
          <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
            ※ 対象区分のメンバーが取得できないため追加はできません（一覧の削除は可能）。
          </p>
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
