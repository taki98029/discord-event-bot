import * as React from 'react';
import { useEffect, useState } from 'react';
import type { PlanData } from '../../../src/planning/model';
import { timeValue } from '../../../src/planning/model';
import { candidateLine, candidateRange, parseCandidateLines, type CandidateInput } from '../lib/planningCandidates';
import { confirmDialog } from '../lib/dialog';

export function PlanningCandidates({
  data,
  busy,
  onSave,
  onDirty,
  onCancel,
  onChange,
}: {
  /** 単発日程調整の作成画面に埋め込むとき: 入力のたびに候補（読めない入力は null）を渡し、保存ボタンは出さない */
  onChange?: (c: CandidateInput[] | null) => void;
  onDirty?: (dirty: boolean) => void;
  onCancel?: () => void;
  data: PlanData;
  busy: boolean;
  onSave?: (c: CandidateInput[]) => unknown;
}) {
  const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  const initialDate = data.candidates.find((c) => c.active)?.date ?? today;
  const year = Number(initialDate.slice(0, 4));
  const initial = data.candidates
    .filter((c) => c.active)
    .map((c) => candidateLine(c, year))
    .join('\n');
  const [value, setValue] = useState(initial);
  const [undo, setUndo] = useState(initial);
  const [month, setMonth] = useState(initialDate.slice(0, 7));
  const [time, setTime] = useState('19:00〜');
  const [range, setRange] = useState(false);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  // Range mode: every weekday is on; unchecked weekdays are left out of the range (like the reference tool).
  const [weekdays, setWeekdays] = useState<boolean[]>(() => Array(7).fill(true));
  const weekdayOf = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();
  const [error, setError] = useState('');
  const [y, m] = month.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const count = new Date(Date.UTC(y, m, 0)).getUTCDate();
  function update(next: string) {
    setUndo(value);
    setValue(next);
    setError('');
  }
  function shift(offset: number) {
    setMonth(new Date(Date.UTC(y, m - 1 + offset, 1)).toISOString().slice(0, 7));
  }
  function add(day: number) {
    const date = `${month}-${String(day).padStart(2, '0')}`;
    if (range) {
      // Two clicks pick the range in either order; a third click starts over.
      if (!start || end) { setStart(date); setEnd(''); }
      else if (date < start) { setEnd(start); setStart(date); }
      else setEnd(date);
      return;
    }
    addDates(date, date);
  }
  function addDates(from: string, to: string) {
    const entered = time
      .normalize('NFKC')
      .trim()
      .replace(/[~〜～]\s*$/, '')
      .trim();
    const normalized = entered.replace(/^(\d):/, '0$1:');
    if (!timeValue(normalized)) {
      setError('追加する時刻を「19:00〜」の形式で入力してください。');
      return;
    }
    try {
      const existing = value.trim() ? parseCandidateLines(value, year) : [];
      const keys = new Set(existing.map((c) => `${c.date} ${c.time}`));
      const wanted = candidateRange(from, to, normalized).filter((c) => !range || weekdays[weekdayOf(c.date)]);
      if (!wanted.length) { setError('選んだ範囲に、追加する曜日の日がありません。'); return; }
      const extra = wanted.filter((c) => !keys.has(`${c.date} ${c.time}`));
      const next = [value.trimEnd(), ...extra.map((c) => candidateLine(c, year))].filter(Boolean).join('\n');
      parseCandidateLines(next, year); // Reject the whole addition at 201; never truncate input.
      if (extra.length) update(next);
      // The range is consumed once added; the calendar is clear for the next pick.
      if (range) { setStart(''); setEnd(''); }
    } catch (e) { setError((e as Error).message); }
  }
  function parse(): CandidateInput[] | null {
    try {
      const cs = parseCandidateLines(value, year);
      // Every candidate needs a start time (2026-09-23): the answer calendar shows each one as a time chip.
      const dateOnly = cs.find((c) => !c.time);
      if (dateOnly) throw new Error(`${candidateLine(dateOnly, year)} に開始時刻を入力してください（例：19:00〜）。`);
      setError('');
      return cs;
    } catch (e) {
      setError((e as Error).message);
      return null;
    }
  }
  const selected = new Map<string, number>();
  let changed = value !== initial;
  let valid: CandidateInput[] | null = null;
  try {
    // 空欄は「読めない入力」ではなく「候補なし」（作成画面の案内を分けるため）
    const parsed = value.trim() ? parseCandidateLines(value, year) : [];
    valid = parsed.some((c) => !c.time) ? null : parsed;
    for (const c of parsed) selected.set(c.date, (selected.get(c.date) ?? 0) + 1);
    const original = data.candidates.filter((c) => c.active);
    changed =
      parsed.length !== original.length ||
      parsed.some((c) => !original.some((o) => o.date === c.date && o.time === c.time));
  } catch {}
  useEffect(() => onDirty?.(changed), [changed, onDirty]);
  useEffect(() => onChange?.(valid), [value]);
  return (
    <section className="card planning-candidate-form">
      <div className="planning-section-heading">
        <h2>日程候補</h2>
        {onCancel && (
          <button className="btn secondary sm" disabled={busy} onClick={onCancel}>
            変更をやめる
          </button>
        )}
      </div>
      <p className="muted">カレンダーから日付を追加するか、候補欄を直接編集できます。</p>
      <div className="planning-candidate-editor">
        <label className="planning-field">
          <span>日程候補</span>
          <textarea
            aria-label="日程候補"
            rows={10}
            value={value}
            disabled={busy}
            onChange={(e) => update(e.target.value)}
            placeholder={'例：9/11(金) 19:00〜\n9/13(日) 21:00〜\n2027/1/10(日) 20:00〜'}
          />
        </label>
        <div className="planning-field">
          <span>カレンダーから追加</span>
          <div className="planning-calendar">
            <div className="planning-inline planning-calendar-mode" role="radiogroup" aria-label="追加方法">
              <span className="muted">追加方法</span>
              <label><input type="radio" name="candidate-mode" checked={!range} disabled={busy} onChange={() => setRange(false)} />単一日</label>
              <label><input type="radio" name="candidate-mode" checked={range} disabled={busy} onChange={() => setRange(true)} />範囲</label>
            </div>
            {range && (
              <>
                <div className="planning-inline planning-weekdays" role="group" aria-label="追加する曜日">
                  <span className="muted">曜日</span>
                  {'日月火水木金土'.split('').map((label, i) => (
                    <label key={label}>
                      <input type="checkbox" disabled={busy} checked={weekdays[i]} onChange={(e) => setWeekdays(weekdays.map((w, j) => (j === i ? e.target.checked : w)))} />
                      {label}
                    </label>
                  ))}
                </div>
              </>
            )}
            <div className="planning-inline planning-calendar-options">
              <label>
                追加する時刻
                <input className="planning-time-input" disabled={busy} value={time} onChange={(e) => setTime(e.target.value)} placeholder="19:00〜" />
              </label>
            </div>
            <div className="planning-calendar-heading">
              <button
                type="button"
                className="btn secondary sm"
                aria-label="前の月"
                onClick={() => shift(-1)}
              >
                ‹
              </button>
              <strong aria-live="polite">
                {y}年{m}月
              </strong>
              <button
                type="button"
                className="btn secondary sm"
                aria-label="次の月"
                onClick={() => shift(1)}
              >
                ›
              </button>
            </div>
            <div className="planning-calendar-grid">
              {'日月火水木金土'.split('').map((day) => (
                <span className="planning-calendar-weekday" key={day}>
                  {day}
                </span>
              ))}
              {Array.from({ length: first }, (_, i) => (
                <span key={`blank${i}`} />
              ))}
              {Array.from({ length: count }, (_, i) => {
                const date = `${month}-${String(i + 1).padStart(2, '0')}`;
                const candidateCount = selected.get(date) ?? 0;
                const inRange = range && !!start && date >= start && date <= (end || start);
                const edge = range && (date === start || date === end);
                const skipped = inRange && !weekdays[weekdayOf(date)];
                return (
                  <button
                    type="button"
                    key={date}
                    className={`planning-calendar-day${inRange || (!range && selected.has(date)) ? ' selected' : ''}${edge ? ' range-edge' : ''}${skipped ? ' skipped' : ''}`}
                    aria-label={`${date}${range ? 'を範囲に選択' : 'を候補に追加'}${candidateCount ? `（候補${candidateCount}件）` : ''}${skipped ? '（曜日により除外）' : ''}`}
                    aria-pressed={range ? inRange : selected.has(date)}
                    aria-current={date === today ? 'date' : undefined}
                    disabled={busy || date < today}
                    onClick={() => add(i + 1)}
                  >
                    {i + 1}
                    {candidateCount > 0 && <span className="planning-calendar-count" aria-hidden="true">{candidateCount}</span>}
                  </button>
                );
              })}
            </div>
            {range && (
              <div className="planning-calendar-foot">
                <button type="button" className="btn secondary" disabled={busy || !start || !end || start < today} onClick={() => addDates(start, end)}>
                  {!start ? '開始日と終了日をクリック' : !end ? '終了日をクリック' : '範囲を候補に追加'}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
      <p className="muted planning-help">1行に1候補・最大200件。年の省略時は{year}年です。</p>
      {data.state === 'open' && (
        <p className="planning-change-notice">
          追加候補は未回答になります。既存の日時を変更した場合も、その候補への回答は引き継がれません。
        </p>
      )}
      {error && (
        <p role="alert" className="planning-error">
          {error}
        </p>
      )}
      <div className="planning-candidate-actions">
        <div className="actions">
          <button
            className="btn secondary"
            disabled={busy}
            onClick={() => {
              const cs = parse();
              if (cs)
                update(
                  cs
                    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
                    .map((c) => candidateLine(c, year))
                    .join('\n'),
                );
            }}
          >
            重複整理・日付順
          </button>
          <button
            className="btn secondary"
            disabled={busy || value === undo}
            onClick={() => {
              setValue(undo);
              setUndo(value);
              setError('');
            }}
          >
            元に戻す
          </button>
        </div>
        {!onChange && <button
          className="btn"
          disabled={busy || !changed}
          onClick={async () => {
            const cs = parse();
            if (!cs) return;
            if (data.state === 'open') {
              const original = data.candidates.filter((c) => c.active);
              const added = cs.filter(
                (c) => !original.some((o) => o.date === c.date && o.time === c.time),
              ).length;
              const removed = original.filter(
                (o) => !cs.some((c) => o.date === c.date && o.time === c.time),
              ).length;
              if (
                !(await confirmDialog(
                  `候補を${cs.length}件に更新します（追加${added}件・取り下げ${removed}件）。\n\n追加・日時変更した候補は未回答になります。変更しない候補の回答は保持します。更新後、対象者向けチャンネルに回答案内を投稿します。`,
                  { title: '候補の更新と回答案内の投稿', okLabel: '更新して案内を投稿' },
                ))
              )
                return;
            }
            onSave?.(cs);
          }}
        >
          {data.state === 'open' ? '候補を更新して案内を投稿' : '候補を保存'}
        </button>}
      </div>
    </section>
  );
}
