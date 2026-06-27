/**
 * 管理UI（ui/index.html）向けの TanStack table-core グルー（②・ADR 0013）。
 * バニラJS から呼べる window.EventBotTable.mount(container, opts) を公開する。
 * 機能: 列ソート（クリック）/ グローバル検索 / 列ごと検索 / 列の並べ替え（ヘッダD&D）/ ページング。
 * esbuild で IIFE バンドルし ui/eventbot-tables.js として配信（Worker は ./ui を配信）。
 */
import {
  createTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  type TableState,
} from '@tanstack/table-core';

export interface ColSpec {
  id: string;
  header: string;
  accessor: (row: Record<string, unknown>) => unknown;
  sortable?: boolean;
  filterable?: boolean;
  /** セルを HTML 文字列で返す（省略時はエスケープした値）。 */
  render?: (value: unknown, row: Record<string, unknown>) => string;
}
export interface MountOpts {
  columns: ColSpec[];
  rows: Record<string, unknown>[];
  pageSize?: number;
  searchPlaceholder?: string;
  /** グローバル全体検索ボックスの表示。既定 true。false で非表示（列ごとの絞り込み・ソートは残る）。 */
  search?: boolean;
}

function esc(s: unknown): string {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

function mount(container: HTMLElement, opts: MountOpts): void {
  const specs = opts.columns;
  const byId: Record<string, ColSpec> = {};
  for (const c of specs) byId[c.id] = c;

  const columnDefs = specs.map((c) => ({
    id: c.id,
    accessorFn: (row: Record<string, unknown>) => c.accessor(row),
    header: c.header,
    enableSorting: c.sortable !== false,
    enableColumnFilter: c.filterable !== false,
  }));

  let state: TableState = {
    sorting: [],
    columnFilters: [],
    globalFilter: '',
    pagination: { pageIndex: 0, pageSize: opts.pageSize || 20 },
    columnOrder: specs.map((c) => c.id),
    columnVisibility: {},
    expanded: {},
    grouping: [],
    columnPinning: { left: [], right: [] },
    rowSelection: {},
    rowPinning: { top: [], bottom: [] },
    columnSizing: {},
    columnSizingInfo: {} as TableState['columnSizingInfo'],
  };

  const table = createTable<Record<string, unknown>>({
    data: opts.rows,
    columns: columnDefs as never,
    state,
    onStateChange: () => undefined,
    renderFallbackValue: null,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    globalFilterFn: 'includesString',
    enableSortingRemoval: true,
  });

  function setState(partial: Partial<TableState>): void {
    state = { ...state, ...partial } as TableState;
    table.setOptions((prev) => ({ ...prev, state }));
    render();
  }

  let dragId: string | null = null;

  function render(): void {
    const order = state.columnOrder.length ? state.columnOrder : specs.map((c) => c.id);
    const rowModel = table.getRowModel();
    const pageCount = table.getPageCount();
    const pageIndex = state.pagination.pageIndex;

    const sortMark: Record<string, string> = {};
    for (const s of state.sorting) sortMark[s.id] = s.desc ? ' ▼' : ' ▲';
    const filterVal: Record<string, string> = {};
    for (const f of state.columnFilters) filterVal[f.id] = String(f.value ?? '');

    const ths = order
      .map((id) => {
        const c = byId[id];
        if (!c) return '';
        const cur = c.sortable !== false ? 'cursor:pointer;' : '';
        return `<th data-col="${id}" draggable="true" style="${cur}user-select:none;white-space:nowrap">${esc(c.header)}${sortMark[id] || ''}</th>`;
      })
      .join('');

    const filters = order
      .map((id) => {
        const c = byId[id];
        if (!c || c.filterable === false) return '<th></th>';
        return `<th><input class="ebt-filter" data-col="${id}" value="${esc(filterVal[id] || '')}" placeholder="絞り込み" style="padding:4px 6px;font-size:12px" /></th>`;
      })
      .join('');

    const trs = rowModel.rows
      .map((r) => {
        const tds = order
          .map((id) => {
            const c = byId[id];
            if (!c) return '';
            const v = c.accessor(r.original);
            return `<td>${c.render ? c.render(v, r.original) : esc(v)}</td>`;
          })
          .join('');
        return `<tr>${tds}</tr>`;
      })
      .join('');

    const searchBox =
      opts.search === false
        ? ''
        : `<input class="ebt-global" value="${esc(state.globalFilter || '')}" placeholder="${esc(opts.searchPlaceholder || '全体を検索')}" style="max-width:280px" />`;
    container.innerHTML = `
      <div style="display:flex;justify-content:${opts.search === false ? 'flex-end' : 'space-between'};align-items:center;gap:10px;margin-bottom:8px;flex-wrap:wrap">
        ${searchBox}
        <div class="muted" style="font-size:12px">${rowModel.rows.length} 件</div>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr>${ths}</tr><tr class="ebt-filters">${filters}</tr></thead>
          <tbody>${trs || `<tr><td colspan="${order.length}" class="muted" style="text-align:center;padding:18px">該当なし</td></tr>`}</tbody>
        </table>
      </div>
      <div class="actions" style="justify-content:flex-end;margin-top:8px">
        <button class="btn xs secondary ebt-prev"${pageIndex <= 0 ? ' disabled' : ''}>← 前</button>
        <span class="muted" style="font-size:12px">${pageCount ? pageIndex + 1 : 0} / ${pageCount}</span>
        <button class="btn xs secondary ebt-next"${pageIndex >= pageCount - 1 ? ' disabled' : ''}>次 →</button>
      </div>`;

    const q = <T extends Element>(sel: string) => container.querySelector(sel) as T | null;

    // IME（日本語入力など）対策: 反映は setState→render で input を作り直すため、変換中
    // (composition 中) に走らせると変換が壊れて子音が生のローマ字で残る。変換中は保留し、
    // 確定（compositionend）後にまとめて反映する。英数字など非変換入力は従来どおり即時反映。
    let composing = false;

    const global = q<HTMLInputElement>('.ebt-global');
    if (global) {
      const applyGlobal = () => {
        const val = global.value;
        setState({ globalFilter: val, pagination: { ...state.pagination, pageIndex: 0 } });
        const again = q<HTMLInputElement>('.ebt-global');
        if (again) {
          again.focus();
          again.setSelectionRange(val.length, val.length);
        }
      };
      global.addEventListener('compositionstart', () => {
        composing = true;
      });
      global.addEventListener('compositionend', () => {
        composing = false;
        applyGlobal();
      });
      global.oninput = () => {
        if (!composing) applyGlobal();
      };
    }

    container.querySelectorAll<HTMLInputElement>('.ebt-filter').forEach((inp) => {
      const applyFilter = () => {
        const col = inp.dataset.col as string;
        const val = inp.value;
        const others = state.columnFilters.filter((f) => f.id !== col);
        const next = val ? [...others, { id: col, value: val }] : others;
        setState({ columnFilters: next, pagination: { ...state.pagination, pageIndex: 0 } });
        const again = container.querySelector<HTMLInputElement>(`.ebt-filter[data-col="${col}"]`);
        if (again) {
          again.focus();
          again.setSelectionRange(val.length, val.length);
        }
      };
      inp.addEventListener('compositionstart', () => {
        composing = true;
      });
      inp.addEventListener('compositionend', () => {
        composing = false;
        applyFilter();
      });
      inp.oninput = () => {
        if (!composing) applyFilter();
      };
    });

    container.querySelectorAll<HTMLElement>('th[data-col]').forEach((th) => {
      const id = th.dataset.col as string;
      const c = byId[id];
      if (c && c.sortable !== false) {
        th.onclick = (e) => {
          if ((e.target as HTMLElement).tagName === 'INPUT') return;
          const cur = state.sorting[0];
          const next =
            !cur || cur.id !== id ? [{ id, desc: false }] : !cur.desc ? [{ id, desc: true }] : [];
          setState({ sorting: next });
        };
      }
      th.ondragstart = () => {
        dragId = id;
      };
      th.ondragover = (e) => e.preventDefault();
      th.ondrop = () => {
        if (!dragId || dragId === id) return;
        const ord = [...(state.columnOrder.length ? state.columnOrder : specs.map((s) => s.id))];
        const from = ord.indexOf(dragId);
        const to = ord.indexOf(id);
        if (from < 0 || to < 0) return;
        ord.splice(from, 1);
        ord.splice(to, 0, dragId);
        dragId = null;
        setState({ columnOrder: ord });
      };
    });

    const prev = q<HTMLButtonElement>('.ebt-prev');
    if (prev) prev.onclick = () => setState({ pagination: { ...state.pagination, pageIndex: Math.max(0, pageIndex - 1) } });
    const next = q<HTMLButtonElement>('.ebt-next');
    if (next) next.onclick = () => setState({ pagination: { ...state.pagination, pageIndex: Math.min(pageCount - 1, pageIndex + 1) } });
  }

  render();
}

(window as unknown as { EventBotTable: { mount: typeof mount } }).EventBotTable = { mount };
