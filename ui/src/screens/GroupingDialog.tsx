// メンバー配置ダイアログ（子ページ・ADR 0016）。盤面本体は GroupingBoard.tsx（非制御・SortableJS）。
// ここでは外枠（クロス/戻る/フッターの保存・プレビュー・投稿ボタン）と API 呼び出しを担う。
import * as React from 'react';
import { useEffect, useRef, useState } from 'react';
import { api, type Guild } from '../api';
import { confirmDialog, withBusy } from '../lib/dialog';
import { showPreview } from '../lib/preview';
import { occurrenceLabel } from '../lib/rrule';
import { mountBoard, type BoardHandle, type Constraint, type GroupingView } from './GroupingBoard';
import type { ToastFn } from '../App';
import { cutText } from '../../../src/lib/text';

export function GroupingDialog({
  guild,
  nuuid,
  ouuid,
  toast,
  onDirtyChange,
  onClose,
  onNavigateConstraints,
  oneOff,
}: {
  guild: Guild;
  nuuid: string;
  ouuid: string;
  toast: ToastFn;
  onDirtyChange: (dirty: boolean) => void;
  onClose: () => void;
  onNavigateConstraints: () => void;
  /** 単発出欠確認（テンプレート一覧が無いので「テンプレート」と呼ばない・P2-15） */
  oneOff?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const boardRef = useRef<BoardHandle | null>(null);
  const viewRef = useRef<GroupingView | null>(null);
  const constraintsRef = useRef<Constraint[]>([]);
  const dirtyRef = useRef(false);
  const [hasGrouping, setHasGrouping] = useState(false);
  const [loading, setLoading] = useState(true);
  // どの開催回の配置か（見出し表示用・M4）。API の view.occurrence / view.notification から組み立てる。
  const [occTitle, setOccTitle] = useState('');
  const [notifName, setNotifName] = useState('');

  const setDirty = (v: boolean) => {
    dirtyRef.current = v;
    onDirtyChange(v);
    const el = containerRef.current?.querySelector<HTMLElement>('#groupingStatus');
    if (el) {
      el.textContent = !viewRef.current?.grouping ? 'グループ枠未作成' : v ? '未保存の変更あり' : '保存済み';
      el.style.color = v ? 'var(--warn)' : '';
    }
  };

  async function reloadView() {
    const view: GroupingView = await api(`/occurrences/${ouuid}/grouping`);
    viewRef.current = view;
    try {
      constraintsRef.current = await api(`/notifications/${nuuid}/constraints`);
    } catch {
      constraintsRef.current = [];
    }
    setHasGrouping(!!view.grouping);
    if (view.occurrence) {
      setOccTitle(
        occurrenceLabel(
          view.occurrence.occurrence_date,
          view.occurrence.start_time || view.notification?.start_time,
          view.occurrence.duration_minutes ?? view.notification?.duration_minutes,
        ),
      );
    }
    setNotifName(view.notification?.name || '');
    boardRef.current?.render();
    setDirty(false);
  }

  useEffect(() => {
    if (!containerRef.current) return;
    const board = mountBoard(containerRef.current, {
      getView: () => viewRef.current!,
      getConstraints: () => constraintsRef.current,
      onDirty: () => setDirty(true),
      onStartNoChange: async (guuid, startNo) => {
        try {
          await api(`/occurrences/${ouuid}/grouping/rename`, { method: 'PUT', body: JSON.stringify({ group_uuid: guuid, start_no: startNo }) });
          const g = viewRef.current?.groups.find((x) => x.uuid === guuid);
          if (g) g.start_no = startNo;
        } catch (e) {
          toast(e instanceof Error ? e.message : String(e), true);
        }
      },
      onApplyCount: (btn) => applyCount(btn),
      onAutoAssign: (btn) => autoAssign(btn),
      onClear: () => clearBoard(),
    });
    boardRef.current = board;
    (async () => {
      try {
        await reloadView();
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e), true);
      } finally {
        setLoading(false);
      }
    })();
    return () => board.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ouuid, nuuid]);

  // グループ名インライン編集（GroupingBoard 側は onblur で name プロパティ変更まで感知しないため、ここで API 呼び出しを配線）
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = async (ev: FocusEvent) => {
      const target = ev.target as HTMLElement;
      if (!target.matches?.('.grouping-col-head .name[data-group-uuid]')) return;
      target.contentEditable = 'false';
      const newName = cutText((target.textContent || '').trim(), 50);
      if (!newName) {
        target.textContent = '（名無し）';
        return;
      }
      const guuid = target.dataset.groupUuid!;
      try {
        await api(`/occurrences/${ouuid}/grouping/rename`, { method: 'PUT', body: JSON.stringify({ group_uuid: guuid, name: newName }) });
        const g = viewRef.current?.groups.find((x) => x.uuid === guuid);
        if (g) g.name = newName;
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e), true);
      }
    };
    el.addEventListener('focusout', handler, true);
    return () => el.removeEventListener('focusout', handler, true);
  }, [ouuid, toast]);

  const attemptClose = async () => {
    if (dirtyRef.current) {
      const ok = await confirmDialog('未保存の変更があります。破棄して閉じますか？', { okLabel: '破棄する', danger: true });
      if (!ok) return;
    }
    boardRef.current?.destroy();
    onDirtyChange(false);
    onClose();
  };

  const applyCount = async (btn: HTMLElement | null) => {
    const input = containerRef.current?.querySelector<HTMLInputElement>('#groupingCount');
    const gc = Number(input?.value);
    if (!Number.isInteger(gc) || gc < 1 || gc > 50) return toast('グループ数は 1〜50', true);
    await withBusy(btn, async () => {
      try {
        if (viewRef.current?.grouping) {
          if (dirtyRef.current) {
            const ok = await confirmDialog('未保存の配置変更があります。保存してからグループ数を変更しますか？', { okLabel: '保存して変更' });
            if (!ok) return;
            if (!(await saveMembers(true))) return;
          }
          const cur = viewRef.current.grouping.group_count;
          if (gc < cur) {
            const removed = (viewRef.current.groups || []).filter((g) => g.group_index >= gc);
            const losing = removed.some((g) => g.members.length > 0 || g.name !== `グループ ${g.group_index + 1}`);
            if (losing) {
              const total = removed.reduce((s, g) => s + g.members.length, 0);
              const names = removed.map((g) => `『${g.name}』`).join('');
              const msg = `グループ数を ${cur} → ${gc} に変更します。${names}${total > 0 ? `（計${total}名）` : ''}が削除され、メンバーは未割り当てに戻ります。`;
              const ok = await confirmDialog(msg, { okLabel: '変更する', danger: true });
              if (!ok) return;
            }
          }
        }
        await api(`/occurrences/${ouuid}/grouping`, { method: 'PUT', body: JSON.stringify({ group_count: gc }) });
        await reloadView();
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e), true);
      }
    });
  };

  const autoAssign = async (btn: HTMLElement | null) => {
    await withBusy(btn, async () => {
      try {
        if (!viewRef.current?.grouping) {
          const input = containerRef.current?.querySelector<HTMLInputElement>('#groupingCount');
          const gc = Number(input?.value);
          if (!Number.isInteger(gc) || gc < 1) return toast('グループ数を指定してください', true);
          await api(`/occurrences/${ouuid}/grouping`, { method: 'PUT', body: JSON.stringify({ group_count: gc }) });
          await reloadView();
        }
        const { assignments } = boardRef.current!.collectCurrentAssignments();
        const r = await api(`/occurrences/${ouuid}/grouping/auto-assign`, { method: 'POST', body: JSON.stringify({ assignments }) });
        boardRef.current!.applyProposalsToBoard((r && r.proposals) || []);
        toast('ランダムに振り分けました（保存するまで確定しません）');
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e), true);
      }
    });
  };

  const clearBoard = async () => {
    const ok = await confirmDialog('盤面の全メンバーを未割り当てに戻します（「保存」するまで確定しません）。', { okLabel: 'クリアする' });
    if (!ok) return;
    boardRef.current?.clearBoard();
  };

  /** 保存本体。キャンセル・失敗は false を返し、呼び出し元（グループ数変更・投稿）はそこで止まる（未保存の配置を失わない） */
  async function saveMembers(silent?: boolean): Promise<boolean> {
    if (!viewRef.current?.grouping) {
      const input = containerRef.current?.querySelector<HTMLInputElement>('#groupingCount');
      const gc = Number(input?.value);
      if (!Number.isInteger(gc) || gc < 1) {
        toast('グループ数を指定してください', true);
        return false;
      }
      try {
        await api(`/occurrences/${ouuid}/grouping`, { method: 'PUT', body: JSON.stringify({ group_count: gc }) });
        await reloadView();
        if (!silent) toast('グループ枠を作成しました');
        return true;
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e), true);
        return false;
      }
    }
    const { assignments, groupOf } = boardRef.current!.collectCurrentAssignments();
    const requiredViolations = constraintsRef.current.filter((c) => {
      const ga = groupOf.get(c.user_id_a);
      const gb = groupOf.get(c.user_id_b);
      if (ga == null || gb == null) return false;
      if (c.strength !== 'required') return false;
      return c.direction === 'together' ? ga !== gb : ga === gb;
    });
    if (requiredViolations.length > 0) {
      const ok = await confirmDialog(`必須制約に ${requiredViolations.length} 件の違反があります。このまま保存しますか？`, { okLabel: '保存する', danger: true });
      if (!ok) return false;
    }
    try {
      await api(`/occurrences/${ouuid}/grouping/members`, { method: 'PUT', body: JSON.stringify({ assignments }) });
      if (!silent) toast('保存しました');
      await reloadView();
      return true;
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), true);
      return false;
    }
  }

  const previewAnnounce = async (btn: HTMLElement | null) => {
    const { assignments, groupOf } = boardRef.current!.collectCurrentAssignments();
    const pool_user_ids = [...groupOf.entries()].filter(([, g]) => g === null).map(([u]) => u);
    // busy は取得中のみ（ダイアログを開いている間はボタンのラベルを戻す・M22）
    await showPreview(`/occurrences/${ouuid}/grouping/announce?dry_run=1`, 'メンバー配置 プレビュー', toast, JSON.stringify({ assignments, pool_user_ids }), btn);
  };

  const announce = async (btn: HTMLElement | null) => {
    await withBusy(btn, async () => {
      if (dirtyRef.current) {
        const ok = await confirmDialog('未保存の変更があります。保存してから投稿しますか？', { okLabel: '保存して投稿' });
        if (!ok) return;
        if (!(await saveMembers(true))) return;
      }
      const gone = viewRef.current?.diff.no_longer_participating || [];
      let n: any = null;
      let channels: any[] = [];
      try {
        n = await api('/notifications/' + nuuid);
      } catch {}
      try {
        channels = await api(`/guilds/${guild.id}/channels`);
      } catch {}
      const chName = (id: string) => {
        const c = channels.find((x) => x.id === id);
        return c ? '#' + c.name : id;
      };
      const dest = n ? chName(n.grouping_channel_id || n.channel_id) : 'テンプレートの設定チャンネル';
      const msg =
        (gone.length ? `⚠️ 参加ではなくなったメンバー（不参加・休止中など）が配置に残っています（${gone.map((x: any) => x.name).join('、')}）。このまま` : '') +
        `現在のメンバー配置を ${dest} へ投稿します。（投稿先は「メンバー配置設定」で変更できます）`;
      const ok = await confirmDialog(msg, { okLabel: '投稿する', danger: gone.length > 0 });
      if (!ok) return;
      try {
        const r = await api(`/occurrences/${ouuid}/grouping/announce`, { method: 'POST' });
        toast(r && r.ok ? '投稿しました' : `投稿に失敗しました${r?.progress ? `。${r.progress}` : ''}`, !(r && r.ok));
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e), true);
      }
    });
  };

  const editConstraints = async (e: React.MouseEvent) => {
    e.preventDefault();
    if (dirtyRef.current) {
      const ok = await confirmDialog('未保存の変更があります。破棄して移動しますか？', { okLabel: '破棄する', danger: true });
      if (!ok) return;
    }
    boardRef.current?.destroy();
    onDirtyChange(false);
    onNavigateConstraints();
  };

  return (
    <dialog className="modal-lg as-page" open aria-labelledby="groupingTitle">
      <div className="modal-head">
        <div>
          <div className="page-crumb">
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                attemptClose();
              }}
            >
              出欠一覧
            </a>{' '}
            <span>›</span> <span>メンバー配置</span>
          </div>
          <h3 id="groupingTitle">
            メンバー配置{occTitle ? `: ${occTitle}` : ''}
            {notifName && (
              <span className="muted" style={{ fontWeight: 400, fontSize: 13, marginLeft: 8 }}>
                {notifName}
              </span>
            )}
          </h3>
        </div>
        <button type="button" className="page-back" aria-label="戻る" onClick={attemptClose}>
          ← 戻る
        </button>
      </div>
      <div className="modal-body">
        {loading && <p className="muted">読み込み中…</p>}
        <div ref={containerRef} style={{ display: loading ? 'none' : 'block' }} />
        <p className="muted" style={{ fontSize: 12.5, marginTop: 14 }}>
          🔗 ペア制約（{constraintsRef.current.length}件）と配置結果の投稿先は{oneOff ? 'この出欠確認' : 'テンプレート単位'}の設定です。編集は{' '}
          <a href="#" onClick={editConstraints}>
            {oneOff ? 'メンバー配置設定' : 'テンプレート › メンバー配置設定'}
          </a>{' '}
          から。制約違反があると盤面上に警告表示されます。
        </p>
      </div>
      <div className="modal-foot">
        <span className="muted" style={{ marginRight: 'auto' }} />
        <button type="button" className="btn ghost" onClick={attemptClose}>
          閉じる
        </button>
        <button type="button" className="btn ghost" title="投稿せず内容のプレビューだけ確認" onClick={(e) => previewAnnounce(e.currentTarget)}>
          👁️ プレビュー
        </button>
        <button type="button" className="btn secondary" onClick={(e) => announce(e.currentTarget)}>
          📣 配置をチャンネルへ投稿
        </button>
        <button type="button" className="btn" onClick={(e) => withBusy(e.currentTarget, () => saveMembers())}>
          {hasGrouping ? '保存' : 'グループ枠を作成'}
        </button>
      </div>
    </dialog>
  );
}
