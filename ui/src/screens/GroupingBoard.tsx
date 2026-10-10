// メンバー配置（旧称グループ分け・ADR 0015）盤面。ドラッグ&ドロップ中は SortableJS が
// DOM を直接操作するため、この盤面は意図的に非制御（uncontrolled） — ADR 0019 の
// 「Sortable をフックで包む（React 側で D&D を再現しない）」方針のとおり、
// 旧 vanilla 実装の render/wire 関数群をほぼそのまま 1つの imperative コントローラに移植する。
import { createSortableGroup } from '../lib/sortable';
import { esc } from '../lib/esc';
import { cutText } from '../../../src/lib/text';

export type GroupMember = { user_id: string; name: string; label?: string | null };
export type Group = { id: number; uuid: string; name: string; start_no?: number | null; members: GroupMember[]; group_index: number };
export type GroupingView = {
  grouping: { group_count: number } | null;
  groups: Group[];
  pool: GroupMember[];
  diff: { no_longer_participating: { user_id: string; group_id: number }[] };
  /** どの開催回の配置か見出しに出すための表示情報（API が同送・M4） */
  occurrence?: { occurrence_date: string; start_time: string | null; duration_minutes?: number | null };
  notification?: { name: string; start_time: string | null; duration_minutes: number | null } | null;
};
export type Constraint = {
  uuid: string;
  user_id_a: string;
  user_id_b: string;
  user_a_name?: string;
  user_b_name?: string;
  direction: 'together' | 'apart';
  strength: 'required' | 'preferred';
};

function cssEscape(s: string): string {
  return String(s).replace(/[^\w-]/g, '\\$&');
}
const LABEL_EDIT_TITLE = 'クリックで行頭ラベルを編集（例: Leader。「：」は自動で付きます／空にすると連番に戻る）';
const stripLabelSep = (s: string) => s.replace(/[：:]+$/, '');

export type BoardHandle = {
  render: () => void;
  destroy: () => void;
  collectCurrentAssignments: () => { assignments: { group_uuid: string; members: { user_id: string; label: string | null }[] }[]; groupOf: Map<string, string | null> };
  applyProposalsToBoard: (proposals: { group_uuid: string; user_ids: string[] }[]) => void;
  clearBoard: () => void;
};

/** 盤面（toolbar抜き・board+alerts領域のみ）をコンテナに描画し、以後の D&D/編集操作を配線する。 */
export function mountBoard(
  container: HTMLElement,
  opts: {
    getView: () => GroupingView;
    getConstraints: () => Constraint[];
    onDirty: () => void;
    onStartNoChange: (groupUuid: string, startNo: number) => Promise<void>;
    onApplyCount: (btn: HTMLElement) => void;
    onAutoAssign: (btn: HTMLElement) => void;
    onClear: () => void;
  },
): BoardHandle {
  let sortable: { destroy: () => void } | null = null;

  function countCurrentParticipants(view: GroupingView): number {
    let n = view.pool.length;
    for (const g of view.groups || []) {
      for (const m of g.members) {
        if (!view.diff.no_longer_participating.some((x) => x.user_id === m.user_id && x.group_id === g.id)) n++;
      }
    }
    return n;
  }

  function renderCard(m: GroupMember, currentGroupId: number | null, orderNo: string | null): string {
    const view = opts.getView();
    const isGone = currentGroupId !== null && view.diff.no_longer_participating.some((x) => x.user_id === m.user_id && x.group_id === currentGroupId);
    const badge = isGone ? '<span class="badge gone">不参加に変更</span>' : '';
    const numEl = orderNo != null ? `<span class="order-no" title="${LABEL_EDIT_TITLE}">${esc(orderNo)}</span>` : '';
    const labelAttr = m.label ? ` data-label="${esc(m.label)}"` : '';
    return `<div class="grouping-card${isGone ? ' no-longer' : ''}" data-user-id="${esc(m.user_id)}"${labelAttr}>
      ${numEl}<span>${esc(m.name)}</span>${badge}
    </div>`;
  }

  function renderColumn(g: Group | { id: 'pool'; name: string; members: GroupMember[] }, isPool: boolean): string {
    const cls = isPool ? 'grouping-col pool' : 'grouping-col';
    const groupKey = isPool ? 'pool' : esc((g as Group).uuid);
    const startNo = isPool ? 1 : Number((g as Group).start_no) || 1;
    let no = startNo - 1;
    const cards = (g.members || [])
      .map((m) => {
        const raw = m.label ? stripLabelSep(m.label) : null;
        const shown = isPool ? null : raw ? `${raw}：` : `${++no}：`;
        return renderCard(m, isPool ? null : (g as Group).id, shown);
      })
      .join('');
    const uuidAttr = !isPool && (g as Group).uuid ? `data-group-uuid="${esc((g as Group).uuid)}"` : '';
    const startEl = isPool
      ? ''
      : `<span class="grouping-start muted" title="自動連番の開始番号">開始<input type="number" min="0" max="999" value="${startNo}" data-start-group="${esc((g as Group).uuid)}" /></span>`;
    const head = isPool
      ? `<div class="grouping-col-head"><span class="name">📥 ${esc(g.name)} <span class="muted" style="font-size:11px;font-weight:400">（参加回答者のみ）</span></span><span class="count" id="count-${groupKey}">${(g.members || []).length}</span></div>`
      : `<div class="grouping-col-head"><span class="name" ${uuidAttr} contenteditable="false" title="クリックで名前変更">${esc(g.name)}</span>${startEl}<span class="count" id="count-${groupKey}">${(g.members || []).length}</span></div>`;
    return `<div class="${cls}" data-group-key="${groupKey}">
      ${head}
      <div class="grouping-cards" data-group-key="${groupKey}" data-start-no="${startNo}">${cards}</div>
    </div>`;
  }

  function collectCurrentAssignments() {
    const assignments: { group_uuid: string; members: { user_id: string; label: string | null }[] }[] = [];
    const groupOf = new Map<string, string | null>();
    container.querySelectorAll<HTMLElement>('.grouping-cards').forEach((el) => {
      const key = el.dataset.groupKey!;
      const members = Array.from(el.querySelectorAll<HTMLElement>('.grouping-card')).map((c) => ({
        user_id: c.dataset.userId!,
        label: c.dataset.label || null,
      }));
      if (key !== 'pool') {
        assignments.push({ group_uuid: key, members });
        for (const m of members) groupOf.set(m.user_id, key);
      } else {
        for (const m of members) groupOf.set(m.user_id, null);
      }
    });
    return { assignments, groupOf };
  }

  function nameOfUser(userId: string): string {
    const view = opts.getView();
    for (const g of view.groups || []) {
      const m = g.members.find((x) => x.user_id === userId);
      if (m) return m.name;
    }
    const p = view.pool.find((x) => x.user_id === userId);
    if (p) return p.name;
    for (const c of opts.getConstraints()) {
      if (c.user_id_a === userId && c.user_a_name) return c.user_a_name;
      if (c.user_id_b === userId && c.user_b_name) return c.user_b_name;
    }
    return userId;
  }

  function highlightCard(userId: string, cls: string) {
    container.querySelectorAll<HTMLElement>(`.grouping-card[data-user-id="${cssEscape(userId)}"]`).forEach((el) => {
      if (cls === 'violated-required' || !el.classList.contains('violated-required')) el.classList.add(cls);
    });
  }

  function renderViolationAlerts(required: Constraint[], preferred: Constraint[]) {
    const badge = container.querySelector<HTMLElement>('#groupingViolBadge');
    if (badge) {
      if (required.length || preferred.length) {
        const parts: string[] = [];
        if (required.length) parts.push(`必須 ${required.length}`);
        if (preferred.length) parts.push(`推奨 ${preferred.length}`);
        badge.textContent = '⚠️ ' + parts.join(' · ');
        badge.style.color = required.length ? 'var(--danger)' : 'var(--warn)';
        badge.classList.remove('hidden');
        badge.onclick = () => container.querySelector('#groupingAlerts')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } else {
        badge.classList.add('hidden');
      }
    }
    const el = container.querySelector<HTMLElement>('#groupingAlerts');
    if (!el) return;
    if (!required.length && !preferred.length) {
      el.innerHTML = '';
      return;
    }
    const reqItems = required
      .map((c) => `<li class="err">必須: ${esc(nameOfUser(c.user_id_a))} と ${esc(nameOfUser(c.user_id_b))} は${c.direction === 'together' ? '同じ' : '別の'}グループにしてください</li>`)
      .join('');
    const prefItems = preferred
      .map((c) => `<li class="warn">推奨: ${esc(nameOfUser(c.user_id_a))} と ${esc(nameOfUser(c.user_id_b))} は${c.direction === 'together' ? 'なるべく同じ' : 'なるべく別の'}グループに</li>`)
      .join('');
    el.innerHTML = `<div class="grouping-alerts ${required.length ? 'has-error' : ''}">
      <h4>制約違反 (必須 ${required.length} / 推奨 ${preferred.length})</h4>
      <ul>${reqItems}${prefItems}</ul>
    </div>`;
  }

  function evaluateAndPaintViolations() {
    container.querySelectorAll('.grouping-card').forEach((el) => {
      el.classList.remove('violated-required', 'violated-preferred');
    });
    const { groupOf } = collectCurrentAssignments();
    const required: Constraint[] = [];
    const preferred: Constraint[] = [];
    for (const c of opts.getConstraints()) {
      const ga = groupOf.get(c.user_id_a);
      const gb = groupOf.get(c.user_id_b);
      if (ga === undefined || gb === undefined) continue;
      if (ga === null || gb === null) continue;
      const violated = c.direction === 'together' ? ga !== gb : ga === gb;
      if (!violated) continue;
      (c.strength === 'required' ? required : preferred).push(c);
    }
    for (const c of required) {
      highlightCard(c.user_id_a, 'violated-required');
      highlightCard(c.user_id_b, 'violated-required');
    }
    for (const c of preferred) {
      highlightCard(c.user_id_a, 'violated-preferred');
      highlightCard(c.user_id_b, 'violated-preferred');
    }
    renderViolationAlerts(required, preferred);
  }

  function recalcCounts() {
    container.querySelectorAll<HTMLElement>('.grouping-cards').forEach((el) => {
      const key = el.dataset.groupKey!;
      const cards = el.querySelectorAll<HTMLElement>('.grouping-card');
      if (key !== 'pool') {
        let n = (parseInt(el.dataset.startNo || '1', 10) || 1) - 1;
        cards.forEach((card) => {
          let no = card.querySelector<HTMLElement>('.order-no');
          if (!no) {
            no = document.createElement('span');
            no.className = 'order-no';
            no.title = LABEL_EDIT_TITLE;
            card.insertBefore(no, card.firstChild);
          }
          no.textContent = card.dataset.label ? `${card.dataset.label}：` : `${++n}：`;
        });
      } else {
        cards.forEach((card) => card.querySelector('.order-no')?.remove());
      }
      const counter = container.querySelector<HTMLElement>('#count-' + (key === 'pool' ? 'pool' : CSS.escape(key)));
      if (counter) counter.textContent = String(cards.length);
    });
  }

  function startLabelEdit(no: HTMLElement, card: HTMLElement) {
    const prev = card.dataset.label || '';
    no.textContent = prev;
    no.contentEditable = 'true';
    no.focus();
    const range = document.createRange();
    range.selectNodeContents(no);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    let done = false;
    const commit = (cancelled: boolean) => {
      if (done) return;
      done = true;
      no.contentEditable = 'false';
      no.onkeydown = null;
      no.onblur = null;
      const v = cancelled ? prev : cutText(stripLabelSep(no.textContent?.trim() || ''), 20);
      if (v) card.dataset.label = v;
      else delete card.dataset.label;
      if (v !== prev) opts.onDirty();
      recalcCounts();
    };
    no.onkeydown = (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        commit(false);
      }
      if (ev.key === 'Escape') {
        ev.preventDefault();
        commit(true);
      }
    };
    no.onblur = () => commit(false);
  }

  function wireStartNoInputs() {
    container.querySelectorAll<HTMLInputElement>('input[data-start-group]').forEach((inp) => {
      inp.onchange = async () => {
        const v = Math.max(0, Math.floor(Number(inp.value) || 0));
        inp.value = String(v);
        const guuid = inp.dataset.startGroup!;
        const cardsEl = container.querySelector<HTMLElement>(`.grouping-cards[data-group-key="${CSS.escape(guuid)}"]`);
        if (cardsEl) cardsEl.dataset.startNo = String(v);
        recalcCounts();
        await opts.onStartNoChange(guuid, v);
      };
    });
  }

  function wireGroupNameEditing() {
    container.querySelectorAll<HTMLElement>('.grouping-col-head .name[data-group-uuid]').forEach((el) => {
      el.onclick = () => {
        el.contentEditable = 'true';
        el.focus();
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      };
      el.onkeydown = (ev) => {
        if (ev.key === 'Enter' || ev.key === 'Escape') {
          ev.preventDefault();
          el.blur();
        }
      };
    });
  }

  container.onclick = (ev) => {
    const target = ev.target as HTMLElement;
    const no = target.closest<HTMLElement>('.order-no');
    if (!no || no.isContentEditable) return;
    const card = no.closest<HTMLElement>('.grouping-card');
    if (!card) return;
    startLabelEdit(no, card);
  };

  function render() {
    const view = opts.getView();
    const groupCount = view.grouping ? view.grouping.group_count : 2;
    const toolbar = `
      <div class="grouping-toolbar">
        <label>グループ数</label>
        <input type="number" id="groupingCount" min="1" max="50" value="${groupCount}" style="width:80px" />
        <button class="btn sm secondary" id="groupingApplyCount">${view.grouping ? 'グループ数を変更' : 'グループ枠を作成'}</button>
        <button class="btn sm secondary" id="groupingAuto" title="未割り当てメンバーをランダムに配置します（既存配置は維持）。『同じグループ（必須）』のペアはまとめますが、『別のグループに』制約は考慮しません（違反は下に警告表示）">🎲 ランダムに振り分け</button>
        <button class="btn sm ghost" id="groupingClear">クリア</button>
        <span class="spacer"></span>
        <span id="groupingViolBadge" class="hidden" style="font-size:12px;cursor:pointer" title="クリックで違反の詳細へ移動"></span>
        <span class="muted" style="font-size:12px"><span id="groupingStatus"></span> · 参加 ${countCurrentParticipants(view)}名</span>
      </div>`;
    const poolCol = renderColumn({ id: 'pool', name: '未割り当て', members: view.pool }, true);
    const groupCols = (view.groups || []).map((g) => renderColumn(g, false)).join('');
    const board = `<div class="grouping-board" id="groupingBoard">${poolCol}${groupCols}</div>`;
    container.innerHTML = toolbar + board + '<div id="groupingAlerts"></div>';

    const applyBtn = container.querySelector<HTMLButtonElement>('#groupingApplyCount');
    if (applyBtn) applyBtn.onclick = () => opts.onApplyCount(applyBtn);
    const autoBtn = container.querySelector<HTMLButtonElement>('#groupingAuto');
    if (autoBtn) autoBtn.onclick = () => opts.onAutoAssign(autoBtn);
    const clearBtn = container.querySelector<HTMLButtonElement>('#groupingClear');
    if (clearBtn) clearBtn.onclick = () => opts.onClear();

    wireStartNoInputs();
    wireGroupNameEditing();
    evaluateAndPaintViolations();

    sortable?.destroy();
    const els = Array.from(container.querySelectorAll<HTMLElement>('.grouping-cards'));
    sortable = createSortableGroup(els, () => {
      opts.onDirty();
      recalcCounts();
      evaluateAndPaintViolations();
    });
  }

  return {
    render,
    destroy: () => sortable?.destroy(),
    collectCurrentAssignments,
    applyProposalsToBoard(proposals) {
      let moved = 0;
      for (const p of proposals) {
        if (!p?.group_uuid) continue;
        const target = container.querySelector<HTMLElement>(`.grouping-cards[data-group-key="${CSS.escape(p.group_uuid)}"]`);
        if (!target) continue;
        for (const uid of p.user_ids || []) {
          const card = container.querySelector<HTMLElement>(`.grouping-card[data-user-id="${cssEscape(uid)}"]`);
          if (card) {
            target.appendChild(card);
            moved++;
          }
        }
      }
      if (!moved) return;
      opts.onDirty();
      recalcCounts();
      evaluateAndPaintViolations();
    },
    clearBoard() {
      const pool = container.querySelector<HTMLElement>('.grouping-cards[data-group-key="pool"]');
      if (!pool) return;
      let moved = 0;
      container.querySelectorAll<HTMLElement>('.grouping-cards').forEach((el) => {
        if (el.dataset.groupKey === 'pool') return;
        el.querySelectorAll('.grouping-card').forEach((c) => {
          pool.appendChild(c);
          moved++;
        });
      });
      if (!moved) return;
      opts.onDirty();
      recalcCounts();
      evaluateAndPaintViolations();
    },
  };
}
