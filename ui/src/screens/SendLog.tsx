import * as React from 'react';
import { useEffect, useState } from 'react';
import { api, type Guild } from '../api';
import { esc } from '../lib/esc';
import { EventBotTable } from '../lib/EventBotTable';
import type { ToastFn } from '../App';

type LogRow = {
  send_date?: string;
  notification_name?: string;
  requires_response?: number;
  occurrence_date?: string;
  kind?: string;
  user_id?: string;
  user_name?: string;
  status?: string;
  error?: string;
};

const KIND_LABEL: Record<string, string> = {
  recruit: '募集',
  remind_unanswered: '未回答リマインド',
  remind_undecided: '未定リマインド',
  quota: 'ノルマ',
  deadline_notice: '締切告知',
};

/** kind='recruit' は出欠確認の有無で「募集/告知」に表示分岐する（保存値は不変・用語は CONTEXT.md） */
function kindLabel(r: LogRow): string {
  if (r.kind === 'recruit') return r.requires_response === 0 ? '告知' : '募集';
  return KIND_LABEL[r.kind || ''] || r.kind || '';
}

const STATUS_LABEL: Record<string, string> = { sent: '成功', failed: '失敗' };

export function SendLog({ guild, toast }: { guild: Guild; toast: ToastFn }) {
  const [rows, setRows] = useState<LogRow[] | null>(null);

  useEffect(() => {
    let alive = true;
    api('/send-log?limit=300&guild_id=' + encodeURIComponent(guild.id)).then(
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
      <h2>送信履歴</h2>
      <p className="muted">
        募集・告知・リマインド・ノルマ・締切告知など、自動送信の履歴（直近 {rows.length} 件・このサーバー: {guild.name || guild.id}）。DM
        拒否などの失敗もここで確認できます。
      </p>
      {rows.length === 0 ? (
        <div className="empty">まだ送信履歴がありません。送信時刻になると cron が送信し、ここに残ります。</div>
      ) : (
        <EventBotTable
          options={{
            search: false,
            columns: [
              { id: 'date', header: '送信日', filter: 'date', accessor: (r: LogRow) => r.send_date || '' },
              {
                id: 'notif',
                header: 'テンプレート',
                filter: 'select',
                accessor: (r: LogRow) => r.notification_name || '',
                // スケジュール名が列幅の自動配分で毎行折り返されて読みにくいため折り返さない（M5）
                render: (v: string) => `<span style="white-space:nowrap">${esc(v)}</span>`,
              },
              { id: 'occ', header: '開催日', filter: 'date', accessor: (r: LogRow) => r.occurrence_date || '' },
              {
                id: 'kind',
                header: '種別',
                filter: 'select',
                filterOptions: ['募集', '告知', '未回答リマインド', '未定リマインド', 'ノルマ', '締切告知'],
                accessor: (r: LogRow) => kindLabel(r),
                // 「未回答リマインド」が列幅の自動配分で2行に折り返されるため折り返さない
                render: (v: string) => `<span style="white-space:nowrap">${esc(v)}</span>`,
              },
              {
                id: 'to',
                header: '宛先',
                filter: 'combo',
                // 'chunk:<位置>' はチャンネルリマインドの 2 通目以降（40 人ずつの分割投稿）
                accessor: (r: LogRow) => r.user_name || (r.user_id?.startsWith('chunk:') ? '' : r.user_id) || '（チャンネル）',
                render: (_v: string, r: LogRow) =>
                  !r.user_id || r.user_id.startsWith('chunk:')
                    ? '<span class="muted">（チャンネル）</span>'
                    : r.user_name
                      ? `${esc(r.user_name)} <span class="muted" style="font-size:11px">${esc(r.user_id)}</span>`
                      : esc(r.user_id),
              },
              {
                id: 'status',
                header: '結果',
                filter: 'select',
                filterOptions: ['成功', '失敗'],
                accessor: (r: LogRow) => STATUS_LABEL[r.status || ''] || r.status || '',
                render: (v: string) =>
                  v === '成功'
                    ? '<span class="pill on">成功</span>'
                    : v === '失敗'
                      ? '<span class="pill" style="color:var(--danger);border-color:var(--danger)">失敗</span>'
                      : `<span class="pill">${esc(v)}</span>`,
              },
              {
                id: 'error',
                header: '詳細',
                // 成功行も空欄にせず一言残す（失敗時はエラー内容＝DM拒否等の理由）
                accessor: (r: LogRow) => r.error || (r.status === 'sent' ? '送信に成功' : r.status === 'failed' ? '送信に失敗' : ''),
                render: (v: string, r: LogRow) =>
                  r.status === 'failed'
                    ? `<span style="color:var(--danger)">${esc(v)}</span>`
                    : v
                      ? `<span class="muted">${esc(v)}</span>`
                      : '',
              },
            ],
            rows,
          }}
        />
      )}
    </>
  );
}
