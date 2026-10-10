import * as React from 'react';
import { useEffect, useState } from 'react';
import { api, type Guild } from '../api';
import { esc } from '../lib/esc';
import { EventBotTable } from '../lib/EventBotTable';
import type { ToastFn } from '../App';

type ResponseRow = {
  occurrence_date?: string;
  occurrence_time?: string;
  notification_name?: string;
  user_name?: string;
  user_id?: string;
  status?: string;
  post_deadline_change?: boolean;
  updated_at?: string;
};

/**
 * updated_at は UTC の ISO 文字列。表示・絞り込みとも JST に揃える。
 * 表示は開催日時列と同じスラッシュ区切り（YYYY/MM/DD HH:MM:SS）。0埋めなので辞書順ソートは維持され、
 * date 絞り込みはテーブル側が先頭10文字をハイフン正規化して比較するため区切り文字に依存しない。
 */
function toJst(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString('sv-SE', { timeZone: 'Asia/Tokyo' }).replace(/-/g, '/');
}

export function Records({ guild, toast }: { guild: Guild; toast: ToastFn }) {
  const [rows, setRows] = useState<ResponseRow[] | null>(null);

  useEffect(() => {
    let alive = true;
    api('/responses?limit=200&guild_id=' + encodeURIComponent(guild.id)).then(
      (r) => alive && setRows(r),
      (e) => {
        if (alive) {
          setRows([]);
          toast(e instanceof Error ? e.message : String(e), true);
        }
      },
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guild.id]);

  if (rows === null) return <p className="muted">読み込み中…</p>;

  return (
    <>
      <h2>回答履歴</h2>
      <p className="muted">
        回答の変更履歴です（変更のたびに 1 行・直近 {rows.length} 件・このサーバー: {guild.name || guild.id}）。
        列ヘッダのクリックでソート、各列下で絞り込み、ヘッダのドラッグで並べ替え。
      </p>
      {rows.length === 0 ? (
        <div className="empty">まだ回答がありません。募集を投稿し、メンバーがボタンで回答すると、ここに表示されます。</div>
      ) : (
        <EventBotTable
          options={{
            search: false,
            columns: [
              { id: 'when', header: '開催日時', filter: 'date', accessor: (r: ResponseRow) => `${r.occurrence_date || ''}${r.occurrence_time ? ' ' + r.occurrence_time : ''}` },
              { id: 'notif', header: 'テンプレート', filter: 'select', accessor: (r: ResponseRow) => r.notification_name || '' },
              { id: 'member', header: 'メンバー', filter: 'combo', accessor: (r: ResponseRow) => r.user_name || r.user_id },
              { id: 'status', header: '回答', filter: 'select', filterOptions: ['参加', '不参加', '未定'], accessor: (r: ResponseRow) => r.status || '' },
              {
                id: 'deadline',
                header: '締切後変更',
                filter: 'select',
                filterOptions: ['あり', 'なし'],
                accessor: (r: ResponseRow) => (r.post_deadline_change ? 'あり' : 'なし'),
                render: (v: string) => (v === 'あり' ? '<span class="pill" style="color:var(--warn);border-color:var(--warn)">締切後変更</span>' : '<span class="muted">—</span>'),
              },
              {
                id: 'updated',
                header: '更新',
                filter: 'date',
                accessor: (r: ResponseRow) => toJst(r.updated_at),
                render: (v: string) => `<span class="muted">${esc(v)}</span>`,
              },
            ],
            rows,
          }}
        />
      )}
    </>
  );
}
