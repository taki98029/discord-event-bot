// 出欠確認の基本設定（スケジュール一覧）。新規/編集/メンバー配置設定は子ページへ遷移（ADR 0016）、
// 削除はその場でアクション（今すぐ募集/告知は開催回タブに一本化・2026-08-23）。Phase 4 ブループリント（.design-sync/templates/NotificationList.dc.html）準拠。
import * as React from 'react';
import { useEffect, useRef, useState } from 'react';
import { Actions, Pill, Switch } from '../../../design-system/src';
import { api, type Guild } from '../api';
import { confirmDialog } from '../lib/dialog';
import { describeRule, parseRule } from '../lib/rrule';
import { scheduleKind, SCHEDULE_LABELS, type ScheduleKind } from '../lib/route';
import type { ToastFn } from '../App';

type Segment = { id: string; name: string };
type Channel = { id: string; name: string };
type Notification = {
  uuid: string;
  name: string;
  /** null = 不定期（ルールなし・開催回は手動追加） */
  rrule?: string | null;
  start_time?: string | null;
  duration_minutes?: number | null;
  /** 今日以降の直近の予定回（不定期の「次回」表示用・LIST_EXTRA） */
  next_occurrence_date?: string | null;
  segment_id: string;
  channel_id: string;
  requires_response?: number;
  active: 0 | 1 | boolean;
};
type Estimate = {
  overDaily: boolean;
  overWindow: boolean;
  dailyTotal: number;
  maxWindow: number;
  recommendedDaily: number;
  recommendedPerWindow: number;
  budget: number;
};

type Filter = 'all' | 'on' | 'off';

/** 一覧の要約（定期=ルールの自然文／不定期=「不定期 21:00〜（次回 9/9）」。文法外は注意表示） */
function schedText(n: Notification): string {
  if (n.rrule && !parseRule(n.rrule)) return '⚠️ 繰り返し設定を読み取れません（編集して設定し直してください）';
  return describeRule(parseRule(n.rrule), n.start_time, n.duration_minutes, n.rrule ? null : n.next_occurrence_date);
}

export function NotificationsScreen({
  guild,
  scope,
  toast,
  onError,
  onNew,
  onEdit,
  onCopy,
  onGroupingSettings,
  onBack,
}: {
  guild: Guild;
  scope: ScheduleKind;
  toast: ToastFn;
  onError: (e: unknown) => void;
  onNew: () => void;
  onEdit: (uuid: string) => void;
  onCopy: (uuid: string) => void;
  onGroupingSettings: (uuid: string) => void;
  onBack: () => void;
}) {
  const [segs, setSegs] = useState<Segment[]>([]);
  const [notifs, setNotifs] = useState<Notification[] | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [est, setEst] = useState<Estimate | null>(null);
  const [filter, setFilter] = useState<Filter>('all');

  // 読み込みの世代番号。サーバー切替後に前のサーバーの応答が遅れて届いても画面へ反映しない（古い一覧の行を削除する事故防止）
  const loadSeq = useRef(0);
  const load = async () => {
    const seq = ++loadSeq.current;
    const stale = () => seq !== loadSeq.current;
    try {
      const g = encodeURIComponent(guild.id);
      const [s, n, c] = await Promise.all([
        api('/segments?guild_id=' + g),
        api('/notifications?guild_id=' + g),
        api(`/guilds/${guild.id}/channels`).catch(() => []),
      ]);
      if (stale()) return;
      setSegs(s);
      setNotifs(n.filter((x: Notification) => scheduleKind(x) === scope));
      setChannels(c);
    } catch (e) {
      if (stale()) return;
      setNotifs([]);
      onError(e);
    }
    try {
      const e = await api('/send-estimate?guild_id=' + encodeURIComponent(guild.id));
      if (!stale()) setEst(e);
    } catch {}
  };

  useEffect(() => {
    setNotifs(null);
    void load();
    return () => {
      loadSeq.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guild.id, scope]);

  const segName = (id: string) => segs.find((x) => x.id === id)?.name ?? '?';
  const chName = (id: string) => {
    const c = channels.find((x) => x.id === id);
    return c ? '#' + c.name : id;
  };

  const remove = async (uuid: string) => {
    const ok = await confirmDialog('このテンプレートを、配下の開催日・回答ごとすべて削除します。元に戻せません。', { danger: true, okLabel: '削除する' });
    if (!ok) return;
    try {
      await api('/notifications/' + uuid, { method: 'DELETE' });
      toast('削除しました');
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), true);
    }
  };

  // 一覧の「有効」スイッチ（C03・2026-09-20）: フォームを開かずに切り替える。失敗時は読み直して実際の状態に戻す。
  const toggle = async (uuid: string, on: boolean) => {
    setNotifs((prev) => prev && prev.map((x) => (x.uuid === uuid ? { ...x, active: on ? 1 : 0 } : x)));
    try {
      await api('/notifications/' + uuid + '/active', { method: 'POST', body: JSON.stringify({ active: on }) });
      toast(on ? '有効にしました（自動送信の対象）' : '無効にしました（自動送信の対象外）');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), true);
      await load();
    }
  };

  if (notifs === null) return <p className="muted">読み込み中…</p>;

  const over = est && (est.overDaily || est.overWindow);
  const shown = notifs.filter((n) => (filter === 'all' ? true : filter === 'on' ? !!n.active : !n.active));

  return (
    <>
      <div className="page-crumb">
        <a href={`#g/${guild.id}/${scope}`} onClick={e => { e.preventDefault(); onBack(); }}>{SCHEDULE_LABELS[scope]}</a>
        <span>›</span><span>テンプレート</span>
      </div>
      <button className="page-back" onClick={onBack}>← {SCHEDULE_LABELS[scope]}へ戻る</button>
      {over && est && (
        <div className="alert warn" style={{ marginBottom: 14 }}>
          <div className="alert-icon">⚠️</div>
          <div>
            <div style={{ fontWeight: 600 }}>送信量が無料枠の推奨上限を超えています</div>
            <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>
              推定ピーク: <b>{est.dailyTotal}</b> 件/日（同一送信時刻 最大 <b>{est.maxWindow}</b> 件）／ 推奨: 日次 ≤{' '}
              {est.recommendedDaily}・同一時刻 ≤ {est.recommendedPerWindow}（送信予算 {est.budget}/分）。
              送信時刻を分散するか、Paid 化のうえ送信予算を上げてください。
            </div>
          </div>
        </div>
      )}

      <div className="sec-head occurrence-head">
        <h2>{SCHEDULE_LABELS[scope]}のテンプレート ({notifs.length})</h2>
        <button className="btn" disabled={!segs.length} onClick={onNew}>
          ＋ 新規テンプレート
        </button>
      </div>
      <p className="muted">{SCHEDULE_LABELS[scope]}で使う対象者・投稿先・募集やリマインドを設定します。</p>
      {!segs.length && <p className="muted">先に「メンバー管理」でメンバー区分を作成してください（テンプレートの対象になります）。</p>}

      <Actions style={{ margin: '4px 0 12px' }}>
        {(
          [
            ['all', 'すべて'],
            ['on', '有効'],
            ['off', '無効'],
          ] as [Filter, string][]
        ).map(([k, label]) => (
          <button key={k} className={'btn sm ' + (filter === k ? 'secondary' : 'ghost')} onClick={() => setFilter(k)}>
            {label}
          </button>
        ))}
      </Actions>

      {shown.length === 0 ? (
        <div className="empty">
          {notifs.length === 0 ? (
            <>
              まだテンプレートがありません。
              <br />
              「＋ 新規テンプレート」から最初のテンプレートを作成しましょう。
            </>
          ) : (
            '該当するテンプレートがありません。'
          )}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {shown.map((n) => (
            <div key={n.uuid} className="listrow">
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                <div className="ava">{(n.name || '?').slice(0, 1)}</div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>{n.name}</div>
                  <div className="muted" style={{ fontSize: 12.5, marginTop: 1 }}>
                    <Pill>{segName(n.segment_id)}</Pill> {schedText(n)} ・ {chName(n.channel_id)}
                  </div>
                </div>
              </div>
              <Actions>
                <span className="muted" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }} title="オフにすると自動送信の対象外になります">
                  <Switch aria-label={`${n.name} を有効にする（自動送信の対象）`} checked={!!n.active} onChange={(e) => toggle(n.uuid, e.target.checked)} />
                  {n.active ? '有効' : '無効'}
                </span>
                <button className="btn sm ghost" onClick={() => onGroupingSettings(n.uuid)}>
                  メンバー配置設定
                </button>
                <button className="btn sm ghost" onClick={() => onEdit(n.uuid)}>
                  編集
                </button>
                <button className="btn sm ghost" onClick={() => onCopy(n.uuid)} title="この内容を初期値にして新しいテンプレートを作ります">
                  複製
                </button>
                <button className="btn sm ghost danger" onClick={() => remove(n.uuid)}>
                  削除
                </button>
              </Actions>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
