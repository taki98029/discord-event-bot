// 「〜の流れと、どこで何を決めるか」: 工程（列）× 画面（行）の表。日程調整（Planning.tsx）で作った形を定期出欠確認でも使う。
// 見出しの上に置き、スクロールしても topbar の下に残る。開閉は画面ごとの1つの値でブラウザーに覚える。
// 左端の群列（運用フロー／事前設定／出欠管理者の画面操作）と、フローと画面の段を分ける点線はユーザーの図（2026-09-23）。
import React, { useEffect, useState } from 'react';

/**
 * The flow guide, page title and step rail stick under the topbar one below another. Their heights vary (the guide opens,
 * the title has a status line or wraps), so each measured height is published on the page root (.planning / .flow-page)
 * for the next one's top.
 */
export function useStickyHeight(ref: React.RefObject<HTMLElement | null>, selector: string, variable: string, deps: unknown[] = []) {
  useEffect(() => {
    const root = ref.current?.closest<HTMLElement>('.planning, .flow-page'), target = root?.querySelector<HTMLElement>(selector);
    if (!root || !target) return;
    // html にも出す: Tab で移った先が固定表示の裏に隠れないよう、html の scroll-padding-top がこの高さを使う（app-ui.css）
    const html = document.documentElement;
    const observer = new ResizeObserver(() => {
      root.style.setProperty(variable, `${target.offsetHeight}px`);
      html.style.setProperty(variable, `${target.offsetHeight}px`);
    });
    observer.observe(target);
    return () => {
      observer.disconnect();
      root.style.removeProperty(variable);
      html.style.removeProperty(variable);
    };
  }, deps); // deps: 画面が読み込み後に描画される場合（基本設定の編集画面）に測り直す
}

/** [群（左端の列）, 画面名, 画面の説明, 工程ごとの項目（空＝この画面での作業なし）]。最後の行（事前設定）の上に点線を引く（2026-09-23） */
export type FlowRow = [string, string, string, string[][]];

/** 上段（工程と実施者）の群名。下段の群名は行ごと（事前設定／出欠管理者の画面操作）。 */
const FLOW_GROUP = '運用フロー';

export function FlowGuide({ summary, lead, corner, steps, actors, rows, storageKey }: {
  summary: string;
  lead: string;
  corner: string;
  steps: string[];
  actors: string[];
  rows: FlowRow[];
  storageKey: string;
}) {
  // Storage can throw (private mode, blocked site data); the guide then just opens every time.
  const [open] = useState(() => {
    try {
      return localStorage.getItem(storageKey) !== '0';
    } catch {
      return true;
    }
  });
  const ref = React.useRef<HTMLDetailsElement>(null);
  useStickyHeight(ref, '.planning-flow', '--planning-flow-h');
  return (
    <details
      ref={ref}
      className="planning-flow"
      open={open}
      onToggle={(e) => {
        try {
          localStorage.setItem(storageKey, e.currentTarget.open ? '1' : '0');
        } catch {}
      }}
    >
      <summary>{summary}</summary>
      <p className="muted planning-flow-lead">{lead}</p>
      <div className="planning-flow-scroll">
        <table>
          <thead>
            <tr>
              <th scope="rowgroup" rowSpan={2} className="planning-flow-group">{FLOW_GROUP}</th>
              <th scope="col" className="planning-flow-corner">{corner}</th>
              {steps.map((step, i) => (
                <th key={step} scope="col" className="planning-flow-arrow">
                  {/* Outside the clipped arrow so the badge can overlap its top-left corner. */}
                  <span className="planning-flow-no">{i + 1}</span>
                  <span className="planning-flow-step"><span>{step}</span></span>
                </th>
              ))}
            </tr>
            <tr className="planning-flow-actors">
              <th scope="row">フロー実施者</th>
              {actors.map((actor, i) => (
                <td key={i}>{actor}</td>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(([group, title, rowLead, cells], r) => (
              <React.Fragment key={title}>
              {/* 運用フローと画面操作（上段）／事前設定（下段・最後の行）を分ける点線 */}
              {r === rows.length - 1 && (
                <tr className="planning-flow-sep" aria-hidden="true">
                  <td colSpan={steps.length + 2} />
                </tr>
              )}
              <tr>
                <th scope="row" className="planning-flow-group">{group}</th>
                <th scope="row">
                  {title}
                  <span className="muted">{rowLead}</span>
                </th>
                {cells.map((items, i) => (
                  <td key={i} className={items.length ? undefined : 'planning-flow-none'}>
                    {items.length ? (
                      <ul>
                        {items.map((text) => (
                          // 全角括弧だけの項目は見出し（「（イレギュラーケース）」）。✓ を付けない
                          <li key={text} className={/^（.*）$/.test(text) ? 'planning-flow-heading' : undefined}>{text}</li>
                        ))}
                      </ul>
                    ) : '-'}
                  </td>
                ))}
              </tr>
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
