import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import type { PlanningAnswerSnapshot as Snapshot } from '../../src/planning/model';
import { ANSWER_TYPES, ANSWER_SYMBOLS } from './lib/planningAnswers';

type Draft = { version: string; values: Record<string, string>; comment: string };
const params = new URLSearchParams(location.search);
const plan = params.get('plan') ?? '';
let linkKey = location.hash.slice(1);
// Remove the bearer key before any fetch and never persist it in browser storage.
history.replaceState(null, '', location.pathname + location.search);
const endpoint = `/api/planning/answers/${encodeURIComponent(plan)}`;

async function request<T = Snapshot>(body?: object, action = ''): Promise<T> {
  const response = await fetch(endpoint + action, {
    method: body ? 'POST' : 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    signal: AbortSignal.timeout(20_000),
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok)
    throw Object.assign(new Error(data.error ?? '処理結果を確認できませんでした。'), {
      discordUrl: data.discordUrl,
    });
  return data;
}
const fromSnapshot = (s: Snapshot): Draft => ({
  version: s.version,
  values: Object.fromEntries(s.candidates.filter((c) => c.value).map((c) => [c.id, c.value!])),
  comment: s.comment,
});
const storageKey = (s: Snapshot) => `planning-draft:${s.id}:${s.person.id}`;
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
/**
 * Sunday-to-Saturday weeks from the first candidate's week to the last one's, so answers are chosen on a calendar
 * (the user's figure, 2026-09-23). Candidates arrive sorted by date and time.
 */
function calendarWeeks(candidates: Snapshot['candidates']) {
  if (!candidates.length) return [];
  const day = 86400000, at = (date: string) => Date.parse(`${date}T00:00:00Z`);
  const first = at(candidates[0].date), last = at(candidates[candidates.length - 1].date);
  const start = first - new Date(first).getUTCDay() * day, end = last + (6 - new Date(last).getUTCDay()) * day;
  const weeks: { date: string; label: string; dow: number; items: Snapshot['candidates'] }[][] = [];
  for (let t = start; t <= end; t += day) {
    const d = new Date(t), date = d.toISOString().slice(0, 10);
    if (d.getUTCDay() === 0) weeks.push([]);
    weeks[weeks.length - 1].push({ date, label: `${d.getUTCMonth() + 1}/${d.getUTCDate()}`, dow: d.getUTCDay(), items: candidates.filter((c) => c.date === date) });
  }
  return weeks;
}
/** Per-candidate totals of everyone's answers (only when the plan shares answers). */
const totals = (others: NonNullable<Snapshot['others']>, id: string) =>
  ANSWER_TYPES.map((value) => [value, others.filter((o) => o.values[id] === value).length] as const);

function Answer() {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [draft, setDraft] = useState<Draft>();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [signInUrl, setSignInUrl] = useState('');
  const [now, setNow] = useState(Date.now());
  const othersDialog = useRef<HTMLDialogElement>(null);
  const dirty = !!snapshot && !!draft && JSON.stringify(draft) !== JSON.stringify(fromSnapshot(snapshot));
  const closed = !!snapshot && (snapshot.closed || now >= Date.parse(snapshot.deadline));
  const shown = closed && snapshot ? fromSnapshot(snapshot) : draft;
  const answered = snapshot?.candidates.filter((c) => shown?.values[c.id]).length ?? 0;

  function showError(e: unknown, fallback: string) {
    setError(e instanceof Error ? e.message : fallback);
    if (e instanceof Error && 'discordUrl' in e && typeof e.discordUrl === 'string')
      setSignInUrl(e.discordUrl);
  }

  function accept(s: Snapshot, restore = false) {
    const next = fromSnapshot(s);
    setSnapshot(s);
    setSignInUrl('');
    setDraft(next);
    document.title = `${s.name} · 日程調整の回答`;
    if (restore && !s.closed) {
      try {
        const saved = JSON.parse(sessionStorage.getItem(storageKey(s)) ?? 'null');
        if (saved?.version === s.version && saved.values && typeof saved.comment === 'string') {
          setDraft(saved);
          setNotice('このタブで入力していた内容を復元しました。最後に「回答を送信」を押してください。');
        }
      } catch {
        /* Storage is optional, including in private browsing. */
      }
    }
  }
  useEffect(() => {
    const key = linkKey;
    linkKey = '';
    (async () => {
      try {
        if (!/^[a-f0-9-]{36}$/.test(plan)) throw new Error('Discordの案内から回答画面を開いてください。');
        const s = await request(key ? { key } : undefined, key ? '/exchange' : '');
        accept(s, true);
      } catch (e) {
        showError(e, '回答画面を開けませんでした。Discordの案内から開き直してください。');
      } finally {
        setBusy(false);
      }
    })();
    // A browser may reuse the already-open answer tab for a new personal link.
    const onLink = () => {
      if (location.hash.length > 1) location.reload();
    };
    window.addEventListener('hashchange', onLink);
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('hashchange', onLink);
    };
  }, []);
  useEffect(() => {
    if (!snapshot || !draft) return;
    try {
      if (dirty) sessionStorage.setItem(storageKey(snapshot), JSON.stringify(draft));
      else sessionStorage.removeItem(storageKey(snapshot));
    } catch {
      /* Saving the final answer does not depend on storage availability. */
    }
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [snapshot, draft, dirty]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || closed || !draft) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      accept(await request(draft));
      setNotice(
        `回答を送信しました（${new Date().toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' })}）。締切までは変更して再送信できます。`,
      );
    } catch (e) {
      showError(e, '送信結果を確認できませんでした。');
      setNotice('入力内容はこの画面に保持しています。');
    } finally {
      setBusy(false);
    }
  }
  async function reload() {
    if (dirty && !window.confirm('この画面の未送信の入力を破棄し、保存済みの回答を読み込みますか？')) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      accept(await request());
    } catch (e) {
      showError(e, '読み込みに失敗しました。');
    } finally {
      setBusy(false);
    }
  }

  async function forget() {
    if (dirty && !window.confirm('未送信の入力を破棄し、このブラウザーの回答者の記憶を解除しますか？'))
      return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await request<{ discordUrl: string }>({}, '/forget');
      try {
        for (const key of Object.keys(sessionStorage))
          if (key.startsWith('planning-draft:')) sessionStorage.removeItem(key);
      } catch {
        /* Clearing identity does not depend on draft storage. */
      }
      setSnapshot(undefined);
      setDraft(undefined);
      setSignInUrl(result.discordUrl);
      setNotice('このブラウザーの記憶を解除しました。送信済みの回答は保存されています。');
      document.title = '日程調整の回答';
    } catch (e) {
      showError(e, '記憶を解除できませんでした。もう一度お試しください。');
    } finally {
      setBusy(false);
    }
  }

  const feedback = (
    <div className="answer-feedback">
      <div className={`answer-notice${!busy && !error && notice.startsWith('回答を送信しました') ? ' is-success' : ''}`} role="status" aria-live="polite" aria-atomic="true">
        {busy ? (snapshot ? '処理しています…' : '回答画面を開いています…') : notice}
      </div>
      {error && (snapshot || !signInUrl) && (
        <div className="alert danger answer-error" role="alert">
          <p>{error}</p>
          <p className="muted">Discordの案内の「初回利用」から、回答者を確認し直せます。</p>
          {signInUrl && (
            <a className="btn secondary" href={signInUrl}>
              Discordの案内に戻る
            </a>
          )}
          {snapshot && (
            <button type="button" className="btn secondary" disabled={busy} onClick={reload}>
              最新の回答を読み込む
            </button>
          )}
        </div>
      )}
    </div>
  );

  return (
    <>
      <header className="topbar">
        <div className="answer-topbar-inner">
          <div className="srv">
            <span className="ava" aria-hidden="true">
              🗓️
            </span>
            <strong>日程調整</strong>
          </div>
          <span className="muted">回答画面</span>
        </div>
      </header>
      <main className="answer-page">
        <header className="answer-heading">
          <h1>{snapshot?.name ?? '日程調整の回答'}</h1>
          {snapshot && (
            <span className={`pill ${closed ? 'off' : 'accent'}`}>
              {snapshot.cancelled ? '中止' : closed ? '受付終了' : '回答受付中'}
            </span>
          )}
        </header>
        {!snapshot && signInUrl && (
          <section className="card answer-overview" aria-labelledby="answer-identity-heading">
            <h2 id="answer-identity-heading">はじめに回答者を確認してください</h2>
            {error && <p>{error}</p>}
            <ol>
              <li>Discordの案内で「初回利用」を押します。</li>
              <li>あなただけに表示される「回答画面を開く」を押します。</li>
            </ol>
            <p className="answer-help">
              このブラウザーに回答者を30日間記憶します。同じサーバーでは、次回から案内の「回答画面を開く」で直接回答できます。
            </p>
            <a className="btn" href={signInUrl}>
              Discordの案内に戻る
            </a>
          </section>
        )}
        {snapshot && (
          <section className="card answer-overview" aria-label="日程調整の概要">
            <dl className="answer-meta">
              <div>
                <dt>回答者</dt>
                <dd>
                  {snapshot.person.name}
                  <span className="muted"> さん</span>
                </dd>
              </div>
              <div>
                <dt>回答締切</dt>
                <dd>{snapshot.deadlineLabel}</dd>
              </div>
            </dl>
            {snapshot.note && <p className="answer-note">{snapshot.note}</p>}
            <p className="answer-help">
              {snapshot.others ? '回答は運営と、この日程調整の他の回答者も確認できます。' : '回答はあなたと運営が確認できます。'}
              「〇（可）」は参加確定ではありません。
            </p>
            <div className="answer-identity">
              <p className="answer-help">
                このブラウザーは上の回答者を記憶しています（本人確認から30日間）。Discordのアカウントを変更しても自動では切り替わりません。共有端末では回答後に記憶を解除してください。
              </p>
              <button type="button" className="btn secondary" disabled={busy} onClick={forget}>
                記憶を解除
              </button>
            </div>
          </section>
        )}
        {(!snapshot || closed) && feedback}
        {snapshot && draft && shown && (
          <form onSubmit={submit}>
            {closed && (
              <p className="alert warn">
                {snapshot.cancelled ? 'この日程調整は中止されました。' : '回答受付は終了しました。'}
                変更は運営担当者へ個別に連絡してください。
              </p>
            )}
            <section className="card" aria-labelledby="answer-candidates-heading">
              <div className="sec-head">
                <h2 id="answer-candidates-heading">{closed ? '保存済みの回答' : '日程候補'}</h2>
                <span className="pill">{snapshot.candidates.length}件</span>
                {snapshot.others && (
                  <button type="button" className="btn xs secondary answer-others-open" onClick={() => othersDialog.current?.showModal()}>
                    回答状況を見る
                  </button>
                )}
              </div>
              <p className="answer-help">〇＝可 ／ △＝未定 ／ ×＝不可</p>
              {!closed && (
                <p className="answer-help">
                  全候補を選び、最後に「回答を送信」を押してください。選択だけでは送信されません。
                </p>
              )}
              <div className="answer-calendar">
                {WEEKDAYS.map((w) => (
                  <div key={w} className="answer-weekday" aria-hidden="true">{w}</div>
                ))}
                {calendarWeeks(snapshot.candidates).map((week) => (
                  <div key={week[0].date} className="answer-week">
                    {week.map((day) => (
                      <div key={day.date} className="answer-day">
                        <span className="answer-day-label" aria-hidden="true">
                          {day.label}
                          <span className="answer-day-dow">({WEEKDAYS[day.dow]})</span>
                        </span>
                        {day.items.length > 0 && (
                          <div className="answer-chips">
                            {day.items.map((candidate) => {
                              const value = shown.values[candidate.id];
                              return (
                                <fieldset key={candidate.id} className={`answer-chip${value ? ` a-${value}` : ''}`} disabled={busy || closed}>
                                  <legend>{candidate.label}</legend>
                                  <span className="answer-chip-time" aria-hidden="true">
                                    {candidate.time ? `${candidate.time}〜` : '時刻未定'}
                                  </span>
                                  <span className="answer-chip-options">
                                    {ANSWER_TYPES.map((option) => (
                                      <label key={option}>
                                        <input
                                          type="radio"
                                          aria-label={`${ANSWER_SYMBOLS[option]}（${option}）`}
                                          name={candidate.id}
                                          value={option}
                                          required
                                          checked={value === option}
                                          onChange={() => {
                                            setDraft({ ...draft, values: { ...draft.values, [candidate.id]: option } });
                                            setNotice('');
                                          }}
                                        />
                                        <span aria-hidden="true">{ANSWER_SYMBOLS[option]}</span>
                                      </label>
                                    ))}
                                  </span>
                                </fieldset>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </section>
            <section className="card answer-comment">
              <h2>
                <label htmlFor="answer-comment">運営への補足（任意）</label>
              </h2>
              <p className="answer-help">
                参加できる時間帯など、伝えておきたいことがあれば入力してください。
              </p>
              <textarea
                id="answer-comment"
                rows={3}
                maxLength={500}
                disabled={busy || closed}
                value={shown.comment}
                onChange={(e) => {
                  setDraft({ ...draft, comment: e.target.value });
                  setNotice('');
                }}
              />
            </section>
            {!closed && (
              <footer className="answer-submit">
                {feedback}
                <div className="answer-progress" aria-live="polite">
                  <strong>
                    {answered} / {snapshot.candidates.length}件を選択
                  </strong>
                  <span className="answer-help">
                    {dirty
                      ? '未送信の変更があります'
                      : answered
                        ? '保存済みの回答です'
                        : 'すべての候補を選んでください'}
                  </span>
                </div>
                <button type="submit" className="btn" disabled={busy || !snapshot.candidates.length}>
                  回答を送信
                </button>
              </footer>
            )}
          </form>
        )}
        {snapshot?.others && (
          <dialog ref={othersDialog} className="modal-lg" aria-labelledby="answer-others-heading">
            <div className="modal-head">
              <h3 id="answer-others-heading">回答状況（{snapshot.others.length}人）</h3>
              <button type="button" className="modal-close" aria-label="閉じる" onClick={() => othersDialog.current?.close()}>
                ×
              </button>
            </div>
            <div className="modal-body">
              <p className="answer-help">〇＝可 ／ △＝未定 ／ ×＝不可 ／ –＝未回答。運営への補足は表示しません。</p>
              <div className="table-wrap">
                <table className="answer-others">
                  <thead>
                    <tr>
                      <th scope="col">名前</th>
                      {snapshot.candidates.map((c) => (
                        <th scope="col" key={c.id}>
                          {c.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {snapshot.others.map((o, i) => (
                      <tr key={i}>
                        <th scope="row">{o.name}</th>
                        {snapshot.candidates.map((c) => (
                          <td key={c.id}>{o.values[c.id] ? ANSWER_SYMBOLS[o.values[c.id]] : <span className="muted">–</span>}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                  {/* The totals live here only: the answer calendar stays uncluttered (2026-09-23). */}
                  <tfoot>
                    <tr>
                      <th scope="row">集計</th>
                      {snapshot.candidates.map((c) => (
                        <td key={c.id} className="answer-others-total">
                          {totals(snapshot.others!, c.id).map(([value, n]) => (
                            <span key={value}>{ANSWER_SYMBOLS[value]}{n}</span>
                          ))}
                        </td>
                      ))}
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          </dialog>
        )}
      </main>
    </>
  );
}
createRoot(document.getElementById('root')!).render(<Answer />);
