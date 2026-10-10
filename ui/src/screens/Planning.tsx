import { PlanningCandidates as Candidates } from './PlanningCandidates';
import * as React from 'react';
import { useEffect, useState } from 'react';
import { Switch } from '../../../design-system/src';
import { RecurrenceFields } from '../components/RecurrenceFields';
import { Tip } from '../components/InfoTip';
import { FlowGuide, useStickyHeight, type FlowRow } from '../components/FlowGuide';
import { api, type Guild } from '../api';
import type { ToastFn } from '../App';
import { confirmDialog } from '../lib/dialog';
import { ANSWER_TYPES, ANSWER_SYMBOLS } from '../lib/planningAnswers';
import { candidateLine, type CandidateInput } from '../lib/planningCandidates';
import { planningCsv } from '../lib/planningCsv';
import { announcementText, DEFAULT_ANNOUNCEMENT_TEMPLATE, withoutRetiredTokens } from '../../../src/planning/announcement';
import type { PlanningView } from '../lib/route';
import {
  DEFAULT_RULE_FORM,
  describeRule,
  ruleFormFromModel,
  parseRule,
  rruleFromRuleForm,
  type RuleForm,
} from '../lib/rrule';
import {
  blankPlan,
  DEFAULT_ANSWER_REMINDER,
  planningGroups,
  timeValue,
  type Plan,
  type PlanData,
  type CycleData,
  type Slot,
  type Availability,
} from '../../../src/planning/model';

type Schedule = { id: number; name: string; duration_minutes?: number | null };
type Channel = { id: string; name: string; type: number; tags: { id: string; name: string }[]; enabled?: boolean };
type Props = {
  guild: Guild;
  toast: ToastFn;
  planId?: string;
  view?: PlanningView;
  onNavigate: (id?: string, view?: PlanningView) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onOpenSettings: () => void;
  /** 単発日程調整の一覧（data.oneOff の日程調整だけ・テンプレートなしで作る・2026-10-02） */
  oneOff?: boolean;
};
const STATES = { draft: '下書き', open: '回答受付', confirmed: '確定', cancelled: '中止' };
function PlanningStatus({ data }: { data: PlanData }) {
  const closed = data.state === 'open' && Date.now() >= Date.parse(data.deadline);
  const tone = closed ? '' : { draft: '', open: 'on', confirmed: 'accent', cancelled: 'danger' }[data.state];
  return <span className={`pill ${tone}`}>{closed ? '回答受付終了' : STATES[data.state]}</span>;
}
const VIEWS = {
  prepare: '日程候補・回答案内',
  details: '名前・締切・補足',
  answers: '回答確認・開催決定',
  history: '投稿・変更履歴',
};
const dt = (x: string) => (x ? new Date(Date.parse(x) + 9 * 3600000).toISOString().slice(0, 16) : '');
const jst = (x: string) => (x ? new Date(x + ':00+09:00').toISOString() : '');
function downloadPlanningCsv(data: PlanData) {
  const url = URL.createObjectURL(new Blob([planningCsv(data)], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${data.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 80)}_回答表.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function AnnouncementPreview({ data, slot }: { data: PlanData; slot: Slot }) {
  const text = announcementText(data, slot);
  return <details className="planning-note">
    <summary>開催案内のプレビュー（{text.length} / 4096文字）</summary>
    <pre className="planning-announcement-preview">{text.replace(/<@(\w+)>/g, (match, id) => `@${data.people.find((p) => p.id === id)?.name ?? id}`)}</pre>
    {text.length > 4096 && <p className="planning-error" role="alert">開催案内が長すぎます。定型文または連絡事項を短くしてください。</p>}
  </details>;
}
const TEMPLATE_TOKENS = ['{{計画名}}', '{{日時}}', '{{名簿}}'];
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  const labelId = React.useId();
  return (
    <label className="planning-field">
      <span id={labelId}>{label}</span>
      {React.Children.map(children, (child) =>
        React.isValidElement<any>(child) ? React.cloneElement(child, { 'aria-labelledby': labelId }) : child,
      )}
    </label>
  );
}
function ScheduleChoices({
  items,
  value,
  onChange,
  segments = false,
}: {
  segments?: boolean;
  items: Schedule[];
  value: number[];
  onChange: (x: number[]) => void;
}) {
  return (
    <fieldset>
      <legend>{segments ? '回答対象のメンバー区分（複数選択可）' : '対象テンプレート（複数選択可）'}</legend>
      <div className="planning-inline">
        {items.map((s) => (
          <label key={s.id}>
            <input
              type="checkbox"
              checked={value.includes(s.id)}
              onChange={(e) =>
                onChange(e.target.checked ? [...value, s.id] : value.filter((v) => v !== s.id))
              }
            />
            {s.name}
          </label>
        ))}
      </div>
      {!items.length && (
        <p>
          {segments
            ? '「メンバー管理」で回答対象者のメンバー区分を作成してください。'
            : '対象のテンプレートがありません。'}
        </p>
      )}
    </fieldset>
  );
}
function ChannelChoice({
  label,
  items,
  value,
  onChange,
  forum = false,
}: {
  label: string;
  items: Channel[];
  value: string;
  onChange: (x: string) => void;
  forum?: boolean;
}) {
  return (
    <Field label={label}>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">選択してください</option>
        {items
          .filter((c) => (forum ? c.type === 15 : c.type !== 15) && (c.enabled !== false || c.id === value))
          .map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
      </select>
    </Field>
  );
}
export function Planning({ guild, toast, planId, view, onNavigate, onDirtyChange, onOpenSettings, oneOff = false }: Props) {
  const [plans, setPlans] = useState<Plan[] | null>(null),
    [p, setP] = useState<Plan | null>(null),
    [schedules, setSchedules] = useState<Schedule[]>([]),
    [channels, setChannels] = useState<Channel[]>([]),
    [segments, setSegments] = useState<Schedule[]>([]),
    [profiles, setProfiles] = useState<any[]>([]);
  const label = oneOff ? '単発日程調整' : '定期日程調整';
  // 単発の「⧉ 複製」: この日程調整の設定を初期値にした新規作成
  const [draftFrom, setDraftFrom] = useState<PlanData | undefined>(undefined);
  const [creating, setCreating] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [listFilter, setListFilter] = useState('active');
  const [search, setSearch] = useState('');
  const [dirty, setDirty] = useState(false);
  const [editingCandidates, setEditingCandidates] = useState(false);
  const [audienceResult, setAudienceResult] = useState('');
  const audienceAbort = React.useRef<AbortController | null>(null);
  useEffect(() => {
    setAudienceResult('');
    return () => { audienceAbort.current?.abort(); };
  }, [planId, guild.id]);
  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);
  const currentView =
    view ??
    (p?.data.state === 'draft' ? 'prepare' : 'answers');
  async function move(next: PlanningView) {
    if (busy) return;
    if (
      dirty &&
      !(await confirmDialog('未保存の入力があります。破棄して画面を切り替えますか？', {
        okLabel: '破棄して移動',
      }))
    )
      return;
    setDirty(false);
    onNavigate(planId, next);
  }
  async function leave() {
    if (busy) return;
    if (
      dirty &&
      !(await confirmDialog('未保存の入力があります。破棄して一覧へ戻りますか？', {
        okLabel: '一覧へ戻る',
      }))
    )
      return;
    setDirty(false);
    setCreating(false);
    setDraftFrom(undefined);
    // 作成画面は一覧と同じ URL なので、effect では消えない作成失敗のエラーをここで消す
    setError('');
    onNavigate();
  }
  // null = 一覧の読み込み中（読み込み前に「0 件・まだありません」と出していた）
  const kindPlans = (plans ?? []).filter((plan) => !!plan.data.oneOff === oneOff);
  const visiblePlans = kindPlans.filter(
    (plan) =>
      (!search || plan.data.name.includes(search)) &&
      (listFilter === 'all' ||
        (listFilter === 'active'
          ? ['draft', 'open'].includes(plan.data.state)
          : plan.data.state === listFilter)),
  );
  const [jobs, setJobs] = useState<any[]>([]),
    [history, setHistory] = useState<any[]>([]);
  const canRepost = p && ['open', 'confirmed'].includes(p.data.state);
  const announcementUnresolved = jobs.some(
    (j) =>
      ['publish', 'repost', 'candidates'].includes(j.kind) &&
      ['pending', 'sending', 'failed', 'unknown'].includes(j.status),
  );
  const fail = (e: unknown) => {
    // The toast and the error line live outside the fullscreen table, so leave fullscreen to show them.
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    setError((e as Error).message);
    toast((e as Error).message, true);
  };
  async function reload() {
    if (planId) {
      const [plan, j, h] = await Promise.all([
        api(`/planning/${planId}`),
        api(`/planning/${planId}/deliveries`),
        api(`/planning/${planId}/history`),
      ]);
      setP(plan);
      setJobs(j);
      setHistory(h);
    } else {
      setPlans(await api(`/planning?guild_id=${guild.id}`));
    }
  }
  // 作成の途中で失敗して下書きへ移るとき、そのエラーを移った先の画面に残す（下の 2 つの effect が消さないように）
  const carriedError = React.useRef('');
  useEffect(() => {
    setP(null);
    setDirty(false);
    setError(carriedError.current);
    if (planId) setCreating(false);
    reload().catch(fail);
  }, [planId, guild.id]);
  useEffect(() => {
    setDirty(false);
    setError(carriedError.current);
    carriedError.current = '';
    setEditingCandidates(false);
  }, [view, planId]);
  useEffect(() => {
    Promise.all([
      api(`/planning/schedules?guild_id=${guild.id}`),
      api(`/planning/channels?guild_id=${guild.id}`),
      api(`/planning/segments?guild_id=${guild.id}`),
      api(`/planning/profiles?guild_id=${guild.id}`),
    ])
      .then(([s, c, groups, templates]) => {
        setSchedules(s);
        setChannels(c);
        setSegments(groups);
        setProfiles(templates);
      })
      .catch(fail);
  }, [guild.id]);
  async function mutate(action: string, body: unknown, target = p) {
    if (!target || busy) return false;
    const controller = action === 'audience-refresh' ? new AbortController() : undefined;
    if (controller) {
      audienceAbort.current = controller;
      setAudienceResult('');
    }
    setBusy(true);
    setError('');
    try {
      let updated: any, token: string | undefined;
      do {
        updated = await api(`/planning/${target.id}/${action}`, {
          method: 'POST',
          body: JSON.stringify({ ...(body as object), version: target.version, ...(token ? { token } : {}) }),
          signal: controller?.signal,
        });
        token = controller ? updated.token : undefined;
      } while (token && !controller?.signal.aborted);
      if (controller?.signal.aborted) return false;
      setDirty(false);
      if (action === 'cancel') setPlans((current) => current && current.map((plan) => plan.id === target.id ? updated : plan));
      if (['publish', 'confirm', 'confirm-selection', 'cancel'].includes(action)) {
        setListFilter(
          action === 'cancel' ? 'cancelled' : action.startsWith('confirm') ? 'confirmed' : 'active',
        );
        onNavigate();
        toast(
          action === 'publish'
            ? '回答案内の投稿を受け付けました。回答が集まったら「回答確認・開催決定」を開いてください。'
            : action.startsWith('confirm')
              ? '開催枠を確定しました。開催案内はBotがフォーラムへ投稿します。'
              : action === 'cancel' ? '日程調整を中止しました' : '保存しました',
        );
        return true;
      }
      await reload();
      const audienceMessage = controller
        ? `対象者を更新しました。追加${updated.added}人・対象外${updated.removed}人（現在${updated.total}人）`
        : '';
      if (controller) setAudienceResult(audienceMessage);
      if (action === 'settings') onNavigate(target.id, 'prepare');
      toast(
        audienceMessage || (action === 'repost'
          ? '回答案内の再投稿を受け付けました'
          : action === 'candidates' && target.data.state === 'open'
            ? '候補を更新し、回答案内の投稿を受け付けました'
            : '保存しました'),
      );
      return true;
    } catch (e) {
      if (!controller?.signal.aborted) fail(e);
      return false;
    } finally {
      if (controller === audienceAbort.current) audienceAbort.current = null;
      setBusy(false);
    }
  }
  // 単発の新規は候補と回答案内の投稿まで続けて行う（2026-10-05）。途中で失敗したら、作れた下書きの日程候補画面へ移る
  async function create({ candidates, ...data }: PlanData | (PlanData & { candidates?: { date: string; time: string }[] }), publish = false) {
    setBusy(true);
    let plan: any;
    let stage = '';
    const step = (action: string, body: object) =>
      api(`/planning/${plan.id}/${action}`, { method: 'POST', body: JSON.stringify({ ...body, version: plan.version }) });
    try {
      plan = await api('/planning', {
        method: 'POST',
        body: JSON.stringify({ ...data, guild_id: guild.id }),
      });
      stage = 'candidates';
      if (candidates?.length) plan = await step('candidates', { candidates });
      stage = 'publish';
      if (publish) plan = await step('publish', {});
      setDirty(false);
      setCreating(false);
      setDraftFrom(undefined);
      if (publish) {
        setListFilter('active');
        onNavigate();
        // 一覧の URL のままなので effect では読み直されない。作った日程調整を一覧に出す
        reload().catch(fail);
        toast('回答案内の投稿を受け付けました。回答が集まったら「回答確認・開催決定」を開いてください。');
      } else {
        onNavigate(plan.id, 'prepare');
        if (oneOff) toast('下書きを保存しました');
      }
      return true;
    } catch (e) {
      if (plan) {
        setDirty(false);
        setCreating(false);
        setDraftFrom(undefined);
        carriedError.current = `${(e as Error).message} ${stage === 'candidates'
          ? '下書きは作成しましたが、日程候補は保存されていません。日程候補を入力し直してから投稿してください。'
          : '下書きと日程候補は保存しました。内容を確認して、回答案内を投稿し直してください。'}`;
        onNavigate(plan.id, 'prepare');
      }
      fail(e);
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function repost() {
    if (!p || busy || dirty) return;
    const closed = p.data.state !== 'open' || Date.now() >= Date.parse(p.data.deadline);
    const channel = channels.find((c) => c.id === p.data.channel);
    if (
      await confirmDialog(
        `「${p.data.name}」の回答案内を${channel ? ` #${channel.name} ` : '元のチャンネル'}に再投稿します。日程候補・回答済みの内容・回答締切はそのままです。\n\n${closed ? '回答受付は終了しているため、回答の確認用として投稿します。受付は再開しません。' : '回答済みの方も、同じ回答の確認・変更を続けられます。'}\n\n通常は次の自動処理（2分ごと）で投稿されます。`,
        { title: '回答案内を再投稿', okLabel: '再投稿する' },
      )
    )
      await mutate('repost', {});
  }
  return (
    <div className={`planning${p ? ' planning-detail' : ''}`}>
      <PlanningFlow oneOff={oneOff} />
      <div className="sec-head occurrence-head">
        <div>
          {(p || creating) && (
            <div className="page-crumb">
              <a
                href={`#g/${guild.id}/${oneOff ? 'oneoff-planning' : 'planning'}`}
                onClick={(e) => {
                  e.preventDefault();
                  leave();
                }}
              >
                {label}
              </a>
              <span>›</span>
              <span>{creating && !planId ? '新規' : p?.data.name}</span>
            </div>
          )}
          <h2>
            {p
              ? p.data.oneOff && p.data.state === 'draft' && currentView === 'details' ? '設定の編集' : VIEWS[currentView]
              : creating ? (oneOff ? '単発日程調整を作成' : '新しい日程調整') : plans ? `${label} (${kindPlans.length})` : label}
          </h2>
          <p className="muted occurrence-description">
            {p
              ? <><PlanningStatus data={p.data} /> · 回答締切 {dt(p.data.deadline).replace('T', ' ') || '未設定'}（日本時間）</>
              : creating
                ? oneOff ? '名前・回答締切・回答対象・日程候補・投稿先・催促・開催案内をまとめて入力してください。' : '使う設定と今回の内容を入力してください。'
                : oneOff ? 'テンプレートを使わずに 1 回分の日程調整を作り、開催日時と参加者を決めます。' : '日程候補の回答を集め、開催日時と参加者を決めます。'}
          </p>
        </div>
        <div className="actions">
          {planId || creating ? (
            <button className="page-back" disabled={busy} onClick={leave}>
              ← {label}一覧へ
            </button>
          ) : oneOff ? (
            <button className="btn" disabled={busy} onClick={() => setCreating(true)}>＋ 新しく作る</button>
          ) : (
            <button className="btn secondary" disabled={busy} onClick={onOpenSettings}>⚙ テンプレート作成・編集</button>
          )}
          {planId && !dirty && (
            <button className="btn sm ghost" disabled={busy} onClick={() => reload().catch(fail)}>
              画面を再読み込み
            </button>
          )}
          {dirty && <span className="muted">未保存の入力あり</span>}
        </div>
      </div>
      {error && (
        <p role="alert" className="planning-error">
          {error}
        </p>
      )}
      {!planId && creating && oneOff && (
        <Cycles
          oneOff={{ initial: draftFrom, isNew: true, onSubmit: create }}
          onDirtyChange={setDirty}
          guild={guild}
          schedules={segments}
          channels={channels}
          toast={toast}
        />
      )}
      {!planId && creating && !oneOff && (
        <div className="nf2-layout">
          {/* Only step 2 exists before the plan is created. */}
          <StepRail label="日程調整の工程" steps={PLAN_STEPS} active="prepare" onPick={() => {}} disabled />
          <section className="card nf2-main">
            <div onChange={() => setDirty(true)}>
              <CreatePlanning profiles={profiles} schedules={segments} channels={channels} guild={guild} busy={busy} onSave={create} />
            </div>
          </section>
        </div>
      )}
      {!planId && !creating && (
        <div className="occurrence-actions planning-filters">
          <select aria-label="表示する日程調整" value={listFilter} onChange={(e) => setListFilter(e.target.value)}>
            <option value="active">進行中（未確定）</option>
            <option value="confirmed">確定</option>
            <option value="cancelled">中止</option>
            <option value="all">すべて</option>
          </select>
          <input type="search" aria-label="名前で検索" placeholder="名前で検索" value={search} onChange={(e) => setSearch(e.target.value)} />
          {!oneOff && <button className="btn sm" disabled={busy} onClick={() => setCreating(true)}>＋ 日程調整を作成</button>}
          <button className="btn sm ghost" disabled={busy} onClick={() => reload().catch(fail)}>画面を再読み込み</button>
        </div>
      )}
      {!planId && !creating && (
        <div className="planning-list">
          {kindPlans.length > 0 && visiblePlans.length === 0 && (
            <div className="empty">この条件に一致する日程調整はありません。</div>
          )}
          {!plans ? (
            <p>{error ? '一覧を読み込めませんでした。「画面を再読み込み」を押してください。' : '読み込み中…'}</p>
          ) : kindPlans.length === 0 ? (
            <div className="empty">
              {oneOff ? (
                <>まだ単発日程調整がありません。<br />「＋ 新しく作る」で、回答対象や投稿先も含めてその場で入力して始められます。</>
              ) : (
                <>
                  まだ日程調整がありません。<br />
                  「⚙ テンプレート作成・編集」で回答対象と投稿先を保存し、「＋ 日程調整を作成」から始めてください。
                </>
              )}
            </div>
          ) : (
            visiblePlans.map((plan) => (
              <div className="pickrow occurrence-row planning-task-row" key={plan.id}>
                <div>
                  <div className="planning-title">
                    <strong>{plan.data.name}</strong>
                    <PlanningStatus data={plan.data} />
                  </div>
                  <div className="muted planning-meta">
                    {plan.data.candidates.filter((c) => c.active).length}候補 ·{' '}
                    {plan.data.slots.length}開催枠 ·{' '}
                    {plan.data.deadline
                      ? `回答締切 ${dt(plan.data.deadline).replace('T', ' ')}`
                      : '締切未設定'}
                  </div>
                </div>
                <div className="actions">
                  <button
                    className="btn sm secondary"
                    disabled={busy}
                    onClick={() => onNavigate(plan.id, 'prepare')}
                  >
                    {VIEWS.prepare}
                  </button>
                  <button
                    className="btn sm secondary"
                    disabled={busy || plan.data.state === 'draft'}
                    onClick={() => onNavigate(plan.id, 'answers')}
                  >
                    {VIEWS.answers}
                  </button>
                  <button
                    className="btn sm ghost"
                    disabled={busy}
                    onClick={() => onNavigate(plan.id, 'history')}
                  >
                    {VIEWS.history}
                  </button>
                  {oneOff && (
                    <button className="btn sm ghost" disabled={busy} onClick={() => { setDraftFrom(plan.data); setCreating(true); }}>
                      ⧉ 複製
                    </button>
                  )}
                  {plan.data.state !== 'cancelled' && (
                    <button
                      className="btn sm ghost danger"
                      disabled={busy}
                      onClick={async () => {
                        if (await confirmDialog(`「${plan.data.name}」を中止します。確定した開催枠も中止します。`, {
                          title: '日程調整を中止',
                          danger: true,
                          okLabel: '中止する',
                        })) await mutate('cancel', { reason: '管理画面から日程調整を中止' }, plan);
                      }}
                    >
                      日程調整を中止
                    </button>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      )}
      {planId && !p && !error && <p>読み込み中…</p>}
      {/* 単発は下書きのうちだけ全設定を直せる。投稿後は定期と同じ「名前・締切・補足」の画面（サーバーも同じ） */}
      {planId && p && p.data.oneOff && p.data.state === 'draft' && currentView === 'details' && (
        <>
          <p>
            <button className="btn sm ghost" onClick={() => move('prepare')}>
              ← 日程候補の作成へ
            </button>
          </p>
          <Cycles
            key={`${p.id}:${p.version}`}
            oneOff={{ initial: p.data, isNew: false, onSubmit: (b) => mutate('settings', b) }}
            onDirtyChange={setDirty}
            guild={guild}
            schedules={segments}
            channels={channels}
            toast={toast}
          />
        </>
      )}
      {planId && p && !(p.data.oneOff && p.data.state === 'draft' && currentView === 'details') && (
        <div className="nf2-layout">
        <StepRail
          label="日程調整の工程"
          steps={p.data.oneOff ? ONEOFF_PLAN_STEPS : PLAN_STEPS}
          active={currentView === 'details' ? 'prepare' : currentView}
          onPick={(key) => move(key as PlanningView)}
        />
        <div className="planning-workspace">
          {(announcementUnresolved || jobs.some((j) => ['failed', 'unknown'].includes(j.status))) &&
            currentView !== 'history' && (
              <div className="planning-attention">
                {announcementUnresolved
                  ? '再投稿する前に、未完了の回答案内の投稿状況を確認してください。'
                  : 'Discordへの投稿に確認が必要です。'}
                <button
                  className="btn secondary sm"
                  disabled={busy}
                  onClick={() => move('history')}
                >
                  投稿・変更履歴を確認
                </button>
              </div>
            )}
          <div
            className="planning-workspace"
            onChange={(e) => {
              if ((e.target as HTMLElement).closest('.planning-matrix, .planning-candidate-form'))
                return;
              const label = (e.target as HTMLElement).closest('label')?.textContent ?? '';
              if (
                [
                  '区分を絞る',
                  '代理変更する回答者',
                  '追加する時刻',
                ].some((x) => label.startsWith(x))
              )
                return;
              setDirty(true);
            }}
          >
            {currentView === 'prepare' && (
              <>
                <section className="planning-prepare-summary" aria-label="今回の内容">
                  <dl className="planning-facts">
                    <div>
                      <dt>対象者</dt>
                      <dd>{p.data.people.filter((u) => u.active !== false).length}人</dd>
                    </div>
                    <div>
                      <dt>使用した設定</dt>
                      <dd>{p.data.oneOff ? 'なし（単発日程調整）' : p.data.profileName || '従来の日程調整'}</dd>
                    </div>
                    <div>
                      <dt>回答案内の投稿先</dt>
                      <dd>
                        {channels.find((c) => c.id === p.data.channel)?.name ||
                          (p.data.channel ? '取得できないチャンネル' : '未設定')}
                      </dd>
                    </div>
                  </dl>
                  {p.data.note && (
                    <details className="planning-note">
                      <summary>回答案内の補足</summary>
                      <p>{p.data.note}</p>
                    </details>
                  )}
                  {(p.data.state === 'draft' || p.data.state === 'open') && (
                    <button className="btn secondary sm" onClick={() => move('details')}>
                      {p.data.oneOff ? (p.data.state === 'draft' ? '設定を編集' : '名前・補足を編集') : '名前・締切・補足を編集'}
                    </button>
                  )}
                </section>
                {p.data.state === 'draft' ||
                (editingCandidates &&
                  p.data.state === 'open' &&
                  Date.now() < Date.parse(p.data.deadline)) ? (
                  <Candidates
                    key={`c:${p.id}:${p.version}`}
                    onDirty={setDirty}
                    data={p.data}
                    busy={busy}
                    onSave={async (c) => {
                      if (await mutate('candidates', { candidates: c }))
                        setEditingCandidates(false);
                    }}
                    onCancel={
                      p.data.state === 'draft'
                        ? undefined
                        : async () => {
                            if (
                              dirty &&
                              !(await confirmDialog('未保存の候補の変更を破棄しますか？', {
                                okLabel: '変更を破棄',
                              }))
                            )
                              return;
                            setDirty(false);
                            setEditingCandidates(false);
                          }
                    }
                  />
                ) : (
                  <section className="card planning-candidates-summary">
                    <div className="planning-section-heading">
                      <h2>
                        日程候補 ({p.data.candidates.filter((c) => c.active).length})
                      </h2>
                      {p.data.state === 'open' && Date.now() < Date.parse(p.data.deadline) && (
                        <button
                          className="btn secondary sm"
                          disabled={busy}
                          onClick={() => setEditingCandidates(true)}
                        >
                          候補を変更
                        </button>
                      )}
                    </div>
                    <p className="muted">
                      {p.data.state === 'open' && Date.now() < Date.parse(p.data.deadline)
                        ? '回答受付中です。候補を変更すると、回答案内が再投稿されます。'
                        : '回答受付が終了したため、日程候補は変更できません。'}
                    </p>
                    <ul className="planning-candidate-list">
                      {p.data.candidates
                        .filter((c) => c.active)
                        .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
                        .map((c) => (
                          <li key={c.id}>
                            <time dateTime={c.date}>{candidateLine({ ...c, time: '' }, 0)}</time>
                            <span className={c.time ? '' : 'muted'}>{c.time || '時刻未定'}</span>
                          </li>
                        ))}
                    </ul>
                  </section>
                )}
                {p.data.state === 'draft' && (
                  <div className="planning-publish-bar">
                    <p className="muted">候補を保存してから、対象者に回答案内を投稿します。</p>
                    <button
                      className="btn"
                      disabled={
                        busy ||
                        dirty ||
                        !p.data.candidates.some((c) => c.active) ||
                        !(Date.parse(p.data.deadline) > Date.now())
                      }
                      onClick={async () => {
                        if (
                          await confirmDialog(
                            '対象者向けチャンネルに日程候補の回答案内を投稿します。',
                            {
                              okLabel: '回答案内を投稿',
                            },
                          )
                        )
                          await mutate('publish', {});
                      }}
                    >
                      回答案内を投稿
                    </button>
                  </div>
                )}
              </>
            )}
            {currentView === 'details' && (
              <section className="card nf2-main">
                <button className="btn secondary" disabled={busy} onClick={() => move('prepare')}>
                  日程候補・回答案内へ戻る
                </button>
                <fieldset
                  className="planning-roster-form"
                  disabled={!['draft', 'open'].includes(p.data.state)}
                >
                  <Settings
                    key={`${p.id}:${p.version}`}
                    initial={p.data}
                    schedules={schedules}
                    channels={channels}
                    busy={busy}
                    onSave={(d) => mutate('settings', d)}
                  />
                </fieldset>
              </section>
            )}
            {currentView === 'answers' && p.data.state === 'draft' && (
              <p>
                回答案内の投稿後に使う画面です。一覧の「日程候補・回答案内」から投稿を準備してください。
              </p>
            )}
            {currentView === 'answers' && !p.data.candidates.some((c) => c.active) && (
              <p>まだ候補がありません。一覧の「日程候補・回答案内」で確認してください。</p>
            )}
            {currentView === 'answers' &&
              p.data.state !== 'draft' &&
              p.data.candidates.some((c) => c.active) && (
                <Matrix
                  key={`m:${p.id}:${p.version}`}
                  onDirtyChange={setDirty}
                  plan={p}
                  schedules={
                    p.data.standalone
                      ? planningGroups(p.data).map((id) => ({
                          id,
                          name:
                            p.data.scheduleNames?.[id] ??
                            segments.find((s) => s.id === id)?.name ??
                            String(id),
                        }))
                      : schedules
                  }
                  busy={busy}
                  mutate={mutate}
                  audienceResult={audienceResult}
                  audienceUpdating={busy && !!audienceAbort.current}
                />
              )}
            {currentView === 'history' && (
              <section className="card">
                <h2>Discordへの投稿</h2>
                <p className="muted">
                  通常は次の自動処理（2分ごと）で投稿されます。結果不明の場合はDiscord上の投稿を確認して関連付けます。
                </p>
                {canRepost && (
                  <button
                    className="btn secondary"
                    disabled={busy || dirty || announcementUnresolved}
                    onClick={repost}
                  >
                    回答案内を再投稿
                  </button>
                )}
                {!jobs.length && <p>まだ投稿履歴はありません。</p>}
                {jobs.map((job) => (
                  <Delivery key={job.id + job.status} job={job} busy={busy} mutate={mutate} />
                ))}
              </section>
            )}
            {currentView === 'history' && (
              <section className="card">
                <h2>変更履歴</h2>
                {history.length === 0 && <p>まだ変更履歴はありません。</p>}
                {history.map((h) => (
                  <History key={h.id} item={h} people={p.data.people} />
                ))}
              </section>
            )}
          </div>
        </div>
        </div>
      )}
    </div>
  );
}
export function PlanningSettings({
  guild,
  toast,
  onDirtyChange,
  onBack,
}: {
  guild: Guild;
  toast: ToastFn;
  onDirtyChange?: (dirty: boolean) => void;
  onBack: () => void;
}) {
  const [groups, setGroups] = useState<Schedule[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [legacySchedules, setLegacySchedules] = useState<Schedule[]>([]);
  const [hasLegacy, setHasLegacy] = useState(false);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    Promise.all([
      api(`/planning/segments?guild_id=${guild.id}`),
      api(`/planning/channels?guild_id=${guild.id}`),
      api(`/planning/cycles?guild_id=${guild.id}`),
      api(`/planning/schedules?guild_id=${guild.id}`),
    ])
      .then(([g, c, cycles, s]) => {
        setGroups(g);
        setChannels(c);
        setHasLegacy(cycles.some((x: any) => !x.data.standalone));
        setLegacySchedules(s);
        setReady(true);
      })
      .catch((e) => toast(e.message, true));
  }, [guild.id]);
  return (
    <div className="planning">
      <PlanningFlow />
      {ready ? (
        <Cycles
          onBack={onBack}
          onDirtyChange={onDirtyChange}
          guild={guild}
          schedules={groups}
          channels={channels}
          toast={toast}
        />
      ) : (
        <p>読み込み中…</p>
      )}
      {ready && hasLegacy && (
        <details>
          <summary>以前のテンプレート連携リマインドを管理</summary>
          <Cycles
            onDirtyChange={onDirtyChange}
            legacy
            guild={guild}
            schedules={legacySchedules}
            channels={channels}
            toast={toast}
          />
        </details>
      )}
    </div>
  );
}
/**
 * [key, number, label]: the number is the column of the planning flow guide, so both editors read against it; S and E are the
 * steps outside the flow. An empty key is a step with nothing to do on that screen: shown for the whole flow, but not clickable.
 */
type StepItem = [string, string, string];
function StepRail({ label, steps, active, onPick, disabled }: { label: string; steps: StepItem[]; active: string; onPick: (key: string) => void; disabled?: boolean }) {
  const ref = React.useRef<HTMLElement>(null);
  useStickyHeight(ref, '.sec-head', '--planning-head-h');
  return (
    <nav ref={ref} className="nf2-steps" aria-label={label}>
      {steps.map(([key, no, text]) => (
        <button
          key={no}
          className={`nf2-step-item${key === active ? ' active' : ''}`}
          aria-current={key === active ? 'step' : undefined}
          disabled={!key || (disabled && key !== active)}
          onClick={() => onPick(key)}
        >
          <span className="nf2-step-no">{no}</span>
          <span className="nf2-step-label">{text}</span>
        </button>
      ))}
    </nav>
  );
}
// The 日程調整 screen's rail (the user's figure, 2026-09-23): steps 1 and 5 are the Bot's and 3 the members', so 回答確認・開催決定 is step 4.
const PLAN_STEPS: StepItem[] = [
  ['', '1', '日程候補作成の​リマインド'],
  ['prepare', '2', '日程候補の作成・​回答依頼'],
  ['', '3', '日程回答'],
  ['answers', '4', '開催日の決定'],
  ['', '5', '開催日ごとの​フォーラム作成'],
  ['history', 'E', '投稿・変更履歴'],
];
// 一覧の先頭の説明「日程調整の流れと、どこで何を決めるか」: 工程（列）× 画面（行）の表（ユーザーの図・2026-09-23）。
// 日程調整の全画面（一覧・作成・各日程調整・テンプレート）の見出しの上に置く。初期は開き、開閉は画面共通の1つの値でブラウザーに覚える（2026-09-23）。文言は各画面の項目名に合わせて保つ。
// Zero-width spaces mark the only break points of the chevron labels and row titles (word-break: keep-all), so they wrap as 日程候補作成の／リマインド.
const FLOW_STEPS = ['日程候補作成の​リマインド', '日程候補の作成・​回答依頼', '日程回答', '開催日の決定', '開催日ごとの​フォーラム作成'];
// Who acts at each step (the user's figure, 2026-09-23). Cells stay one short line each: the table is for the overview, not details.
const FLOW_ACTORS = ['Bot', '出欠管理者', 'イベントメンバー', '出欠管理者', 'Bot'];
// Rows: [群, 画面名, 説明, cells]. An empty cell (no work on that screen at that step) shows a plain dash.
const FLOW_ROWS: FlowRow[] = [
  ['出欠管理者の​画面操作', '日程調整作成画面', '日程調整のたびに行う作業', [
    [],
    ['テンプレートを選び、名前と回答締切を決める', '日程候補を入力し、回答案内を投稿する'],
    [],
    ['回答一覧から開催日時と参加者を選んで確定する'],
    [],
  ]],
  ['事前設定', 'テンプレート作成・​編集画面', '一度決めれば、毎回の日程調整で使い回せる設定', [
    ['日程候補を作る時期になったら、担当者に Bot から知らせるか', 'リマインド開始時期', 'リマインドの宛先', 'リマインドを投稿するチャンネル'],
    [],
    ['回答してもらうメンバーの区分', '回答案内を投稿するチャンネル', '未回答の人へ催促するか'],
    [],
    ['開催案内を投稿するフォーラム', '開催案内の文面', '開催前にリマインドするか'],
  ]],
];
const FLOW_OPEN_KEY = 'eventbot_planning_flow_open';
// 単発日程調整はテンプレート（事前設定）が無く、作成画面ですべて決める。日程候補作成のリマインドは無いので工程は 1 から振り直す（2026-10-05）
const ONEOFF_FLOW_STEPS = ['日程候補の作成', ...FLOW_STEPS.slice(2)];
const ONEOFF_FLOW_ACTORS = FLOW_ACTORS.slice(1);
const ONEOFF_PLAN_STEPS: StepItem[] = [
  ['prepare', '1', '日程候補の作成'],
  ['', '2', '日程回答'],
  ['answers', '3', '開催日の決定'],
  ['', '4', '開催日ごとの​フォーラム作成'],
  ['history', 'E', '投稿・変更履歴'],
];
const ONEOFF_FLOW_ROWS: FlowRow[] = [
  ['出欠管理者の​画面操作', '単発日程調整画面', '日程調整のたびに行う作業', [
    ['「＋ 新しく作る」で名前・回答締切・回答対象・投稿先・催促・開催案内と日程候補をまとめて決める', '「確認・日程調整依頼を投稿」で回答案内を投稿する', '前回の内容を使うなら「⧉ 複製」', '投稿前は「設定を編集」で全設定を直せる。投稿後に変えられるのは名前・補足と日程候補だけ（ほかは中止して「⧉ 複製」で作り直す）'],
    [],
    ['回答一覧から開催日時と参加者を選んで確定する'],
    [],
  ]],
];
function PlanningFlow({ oneOff = false }: { oneOff?: boolean }) {
  return (
    <FlowGuide
      summary={oneOff ? '単発日程調整の流れと、どこで何を決めるか' : '日程調整の流れと、どこで何を決めるか'}
      lead={oneOff
        ? '1〜4 の順に進みます。テンプレートは使わず、作成画面で 1 回分の設定と日程候補をすべて決めます。'
        : '日程調整は 1〜5 の順に進みます。上の段は日程調整のたびに行うこと、下の段（点線の下）はテンプレートで一度だけ決めておくことです。'}
      corner="日程調整フロー"
      steps={oneOff ? ONEOFF_FLOW_STEPS : FLOW_STEPS}
      actors={oneOff ? ONEOFF_FLOW_ACTORS : FLOW_ACTORS}
      rows={oneOff ? ONEOFF_FLOW_ROWS : FLOW_ROWS}
      storageKey={FLOW_OPEN_KEY}
    />
  );
}
function CreatePlanning({
  profiles,
  schedules,
  channels,
  guild,
  busy,
  onSave,
}: {
  profiles: any[];
  schedules: Schedule[];
  channels: Channel[];
  guild: Guild;
  busy: boolean;
  onSave: (d: PlanData) => unknown;
}) {
  const [profileId, setProfileId] = useState('');
  const [name, setName] = useState('');
  const [deadline, setDeadline] = useState('');
  const [note, setNote] = useState('');
  const profile = profiles.find((p) => p.id === profileId)?.data;
  const channelName = (id: string) => channels.find((c) => c.id === id)?.name ?? (id ? '取得できないチャンネル' : '未設定');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSave({ ...blankPlan(name), standalone: true, profileId, deadline: jst(deadline), note });
      }}
    >
      <Field label="使用するテンプレート">
        <select required value={profileId} onChange={(e) => setProfileId(e.target.value)}>
          <option value="">選択してください</option>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.data.name}
            </option>
          ))}
        </select>
      </Field>
      {!profiles.length && (
        <p>
          先に<a href={`#g/${guild.id}/planning-settings`}>日程調整のテンプレート</a>
          で回答対象と投稿先を保存してください。
        </p>
      )}
      {profile && (
        <>
          {/* What this plan inherits from the profile, so the poster and audience are known before anything is created. */}
          <dl className="planning-facts" aria-label="この設定の内容">
            <div>
              <dt>回答対象</dt>
              <dd>{(profile.segments ?? []).map((id: number) => schedules.find((s) => s.id === id)?.name ?? '未取得').join('・') || '未設定'}</dd>
            </div>
            <div>
              <dt>回答案内の投稿先</dt>
              <dd>{channelName(profile.channel)}</dd>
            </div>
            <div>
              <dt>未回答者へ催促</dt>
              <dd>{profile.answerReminder?.enabled ? `締切の${profile.answerReminder.beforeDays}日前から毎日` : 'なし'}</dd>
            </div>
            <div>
              <dt>開催案内</dt>
              <dd>{channelName(profile.forum)}</dd>
            </div>
          </dl>
          <Field label="今回の名前">
            <input
              required
              maxLength={150}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例：10・11月の日程調整"
            />
          </Field>
          <Field label="今回の回答締切（日本時間）">
            <input
              required
              type="datetime-local"
              value={deadline}
              onChange={(e) => setDeadline(e.target.value)}
            />
          </Field>
          <Field label="今回の回答案内の補足">
            <textarea maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <button className="btn" disabled={busy}>
            作成して日程候補を入力
          </button>
        </>
      )}
    </form>
  );
}
function Settings({
  initial,
  schedules,
  channels,
  busy,
  onSave,
}: {
  initial: PlanData;
  schedules: Schedule[];
  channels: Channel[];
  busy: boolean;
  onSave: (d: PlanData) => unknown;
}) {
  const [d, setD] = useState(structuredClone(initial));
  const patch = (x: Partial<PlanData>) => setD({ ...d, ...x });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSave(d);
      }}
    >
      <div className="planning-grid">
        <Field label="日程調整の名前">
          <input required maxLength={150} value={d.name} onChange={(e) => patch({ name: e.target.value })} />
        </Field>
        <Field label="回答締切（日本時間）">
          <input
            type="datetime-local"
            disabled={d.state === 'open'}
            value={dt(d.deadline)}
            onChange={(e) => patch({ deadline: jst(e.target.value) })}
          />
        </Field>
      </div>
      {!d.standalone && d.state === 'draft' && (
        <ScheduleChoices items={schedules} value={d.schedules} onChange={(s) => patch({ schedules: s })} />
      )}
      {!d.standalone && (
        <>
          <div className="planning-grid">
            <ChannelChoice
              label="回答案内の投稿先"
              items={channels}
              value={d.channel}
              onChange={(channel) => patch({ channel })}
            />
            <ChannelChoice
              label="開催案内を投稿するフォーラム"
              items={channels}
              value={d.forum}
              onChange={(forum) => patch({ forum, tag: '' })}
              forum
            />
            <Field label="投稿に付けるタグ">
              <select value={d.tag} onChange={(e) => patch({ tag: e.target.value })}>
                <option value="">指定なし</option>
                {channels
                  .find((c) => c.id === d.forum)
                  ?.tags.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="未回答者への催促間隔（日・0で無効）">
              <input
                type="number"
                min={0}
                max={30}
                value={d.remindDays}
                onChange={(e) => patch({ remindDays: Number(e.target.value) })}
              />
            </Field>
          </div>
        </>
      )}
      <Field label="回答案内の補足">
        <textarea maxLength={1000} value={d.note} onChange={(e) => patch({ note: e.target.value })} />
      </Field>
      {d.oneOff && d.state === 'open' && (
        <p className="muted">回答案内の投稿後は、回答対象・投稿先・催促などの設定は変更できません。変えるときは日程調整を中止し、一覧の「⧉ 複製」で作り直してください。</p>
      )}
      <button className="btn" disabled={busy}>
        設定を保存
      </button>
    </form>
  );
}
// Per-browser table display settings (Excel-like view). Hidden keys: `a:${answer}` | 'selection' | 'checks' | `p:${user}` | `c:${plan}:${candidate}`.
// Candidate ids (c1, c2…) restart per plan, so their keys carry the plan id; legacy `c:c1` keys are simply ignored.
// Column and person keys are shared across plans on purpose (Discord user ids are unique).
// ponytail: hidden candidate keys from old plans accumulate; 「表示を元に戻す」 clears them.
const VIEW_KEY = 'planning-table-view';
type TableView = { zoom: number; hidden: string[]; transposed: boolean };
const DEFAULT_VIEW: TableView = { zoom: 100, hidden: [], transposed: false };
function loadView(): TableView {
  try {
    const v = JSON.parse(localStorage.getItem(VIEW_KEY) || '{}') ?? {};
    return {
      zoom: Number.isFinite(v.zoom) ? Math.min(150, Math.max(50, v.zoom)) : DEFAULT_VIEW.zoom,
      hidden: Array.isArray(v.hidden) ? v.hidden.filter((k: unknown) => typeof k === 'string') : [],
      transposed: v.transposed === true,
    };
  } catch {
    return DEFAULT_VIEW;
  }
}
// iPhone Safari has no element fullscreen API.
const canFullscreen = typeof document !== 'undefined' && !!document.documentElement.requestFullscreen;
// Person-column sort: 〇 ranks highest.
const ANSWER_RANK = ['未回答', '不可', '未定', '可'];
function Matrix({
  plan,
  schedules,
  busy,
  mutate,
  onDirtyChange,
  audienceResult,
  audienceUpdating,
}: {
  plan: Plan;
  schedules: Schedule[];
  busy: boolean;
  mutate: (a: string, b: unknown) => Promise<boolean>;
  onDirtyChange: (dirty: boolean) => void;
  audienceResult: string;
  audienceUpdating: boolean;
}) {
  const d = plan.data,
    [slots, setSlots] = useState<Slot[]>(structuredClone(d.slots)),
    [filter, setFilter] = useState(''),
    [person, setPerson] = useState(''),
    [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null),
    [minOk, setMinOk] = useState(''),
    [answerFilter, setAnswerFilter] = useState<Record<string, string>>({}),
    [view, setView] = useState(loadView),
    [full, setFull] = useState(false),
    [showAll, setShowAll] = useState(false),
    sectionRef = React.useRef<HTMLElement>(null);
  useEffect(() => {
    try {
      localStorage.setItem(VIEW_KEY, JSON.stringify(view));
    } catch {}
  }, [view]);
  useEffect(() => {
    const on = () => setFull(!!sectionRef.current && document.fullscreenElement === sectionRef.current);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);
  const shown = (key: string) => !view.hidden.includes(key);
  const toggleShown = (key: string, on: boolean) =>
    setView((v) => ({ ...v, hidden: on ? v.hidden.filter((k) => k !== key) : [...v.hidden, key] }));
  const sortDir = (key: string) => (sort?.key === key ? sort.dir : 0);
  const nextSort = (key: string) => {
    const dir = sortDir(key);
    setSort(dir === 0 ? { key, dir: -1 } : dir < 0 ? { key, dir: 1 } : null);
  };
  const cs = d.candidates
    .filter((c) => c.active)
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  const editable = d.state === 'draft' || d.state === 'open';
  const activePeople = d.people.filter((u) => u.active !== false);
  const canRefreshAudience = d.standalone && d.state === 'open' && Date.now() < Date.parse(d.deadline);
  const people = activePeople.filter((u) => !filter || u.schedules.includes(Number(filter)));
  const groups = schedules.filter((s) => planningGroups(d).includes(s.id));
  const complete = activePeople.filter((u) => cs.every((c) => d.answers[u.id]?.values[c.id])).length;
  const selectedSlots = slots
    .map((s) => ({ ...s, members: s.members.filter((m) => m.status !== '除外') }))
    .filter((s) => s.members.length);
  const validMember = (s: Slot, m: Slot['members'][number]) =>
    d.answers[m.user]?.values[s.candidate] === '可' &&
    activePeople.some((u) => u.id === m.user && u.schedules.includes(m.schedule));
  const invalidSelection = selectedSlots.some((s) => s.members.some((m) => !validMember(s, m)));
  const shownGroups = groups.filter((s) => !filter || Number(filter) === s.id);
  const count = (c: string, answer: string) => people.filter((u) => d.answers[u.id]?.values[c] === answer).length;
  const selectedOf = (c: string) =>
    slots.find((s) => s.candidate === c)?.members.filter((m) => m.status !== '除外') ?? [];
  const answerOf = (u: string, c: string) => d.answers[u]?.values[c] ?? '未回答';
  const shownPeople = people.filter((u) => shown(`p:${u.id}`));
  const sortValue = (c: string, key: string) =>
    key.startsWith('p:') ? ANSWER_RANK.indexOf(answerOf(key.slice(2), c)) : count(c, key);
  // Filters never drop a selected candidate; only an explicit row hide does.
  const rows = cs
    .filter((c) => showAll || shown(`c:${plan.id}:${c.id}`))
    .filter(
      (c) =>
        selectedOf(c.id).length ||
        ((!minOk || count(c.id, '可') >= Number(minOk)) &&
          shownPeople.every((u) => !answerFilter[u.id] || answerOf(u.id, c.id) === answerFilter[u.id])),
    )
    .sort((a, b) => (sort ? (sortValue(a.id, sort.key) - sortValue(b.id, sort.key)) * sort.dir : 0));
  const filtering = !!minOk || shownPeople.some((u) => answerFilter[u.id]);
  const tableHelp = React.useId();
  const [proxyDirty, setProxyDirty] = useState(false);
  const selectionDirty = JSON.stringify(slots) !== JSON.stringify(d.slots);
  useEffect(
    () => onDirtyChange(selectionDirty || proxyDirty),
    [selectionDirty, proxyDirty, onDirtyChange],
  );
  async function save(action: string, body: unknown) {
    const discarded =
      action === 'answer' ? (selectionDirty ? '選定' : '') : proxyDirty ? '回答の代理変更' : '';
      const confirming = action === 'confirm-selection';
    if (
      (discarded || confirming) &&
      !(await confirmDialog(
        (discarded ? `未保存の${discarded}の入力は破棄されます。\n\n` : '') +
          (confirming
            ? `${selectedSlots.length}開催枠を確定し、開催枠ごとのフォーラム投稿で参加者を案内します。未選定の人への結果投稿や再回答の依頼はありません。`
            : `${action === 'answer' ? '回答の代理変更' : '選定'}を保存しますか？`),
        { okLabel: confirming ? '選定を保存して確定' : '破棄して保存' },
      ))
    )
      return false;
    return mutate(action, body);
  }
  function choose(candidate: string, user: string, schedule: number, checked: boolean) {
    const out = structuredClone(slots);
    let s = out.find((s) => s.candidate === candidate);
    if (!s) {
      s = { id: '', candidate, members: [], cancelled: false, gather: '', note: '' };
      out.push(s);
    }
    s.members = s.members.filter((m) => m.user !== user || m.schedule !== schedule);
    if (checked) s.members.push({ user, schedule, status: '参加', duty: '' });
    setSlots(out.filter((s) => s.members.length));
  }
  const conflicts = d.people.filter((u) => {
    const assigned = selectedSlots.filter((s) => s.members.some((m) => m.user === u.id));
    return (
      assigned.some((s) => s.members.filter((m) => m.user === u.id).length > 1) ||
      assigned.some((s, i) =>
        assigned.slice(i + 1).some((t) => {
          const a = cs.find((c) => c.id === s.candidate)!,
            b = cs.find((c) => c.id === t.candidate)!;
          if (!a.time || !b.time) return a.date === b.date;
          const startA = Date.parse(`${a.date}T${a.time}:00+09:00`),
            startB = Date.parse(`${b.date}T${b.time}:00+09:00`);
          const duration = (x: Slot) =>
            Math.max(
              ...x.members
                .filter((m) => m.user === u.id)
                .map((m) => schedules.find((n) => n.id === m.schedule)?.duration_minutes ?? 60),
            ) * 60000;
          return startA < startB + duration(t) && startB < startA + duration(s);
        }),
      )
    );
  });
  type Candidate = (typeof cs)[number];
  const ariaSort = (key: string) => {
    const dir = sortDir(key);
    return dir ? (dir < 0 ? 'descending' : 'ascending') : 'none';
  };
  const sortMark = (key: string) => (sortDir(key) ? (sortDir(key) < 0 ? '▼' : '▲') : '');
  const candidateHead = (c: Candidate) => (
    <>
      <time dateTime={c.date}>{candidateLine({ ...c, time: '' }, 0)}</time>
      <span className="planning-column-note">{c.time || '時刻未定'}</span>
    </>
  );
  // One definition per field; rendered as columns, or as rows when transposed.
  const allCols: { key: string; hideKey: string; label: string; className: string; sortKey?: string; head: React.ReactNode; cell: (c: Candidate) => React.ReactNode }[] = [
    ...ANSWER_TYPES.map((answer) => ({
          key: answer,
          hideKey: `a:${answer}`,
          label: `${ANSWER_SYMBOLS[answer]}の人数`,
          className: `planning-answer-count a-${answer}`,
          sortKey: answer,
          head: (
            <button
              type="button"
              className="planning-sort"
              aria-label={`${ANSWER_SYMBOLS[answer]}（${answer}）の回答人数で並べ替え`}
              title={`${answer}の人数で並べ替え（多い順→少ない順→日付順）`}
              onClick={() => nextSort(answer)}
            >
              {ANSWER_SYMBOLS[answer]}
              {sortMark(answer)}
            </button>
          ),
          cell: (c: Candidate) => `${count(c.id, answer)}人`,
        })),
    {
            key: 'selection',
            hideKey: 'selection',
            label: '選定人数',
            className: 'planning-selection-count',
            head: (
              <>
                選定人数<span className="planning-column-note">{filter ? '表示中の区分' : '区分別'}</span>
              </>
            ),
            cell: (c: Candidate) => (
              <dl className="planning-counts">
                {shownGroups.map((s) => (
                  <div key={s.id}>
                    <dt>{s.name}</dt>
                    <dd>{selectedOf(c.id).filter((m) => m.schedule === s.id).length}人</dd>
                  </div>
                ))}
              </dl>
            ),
    },
    ...people.map((u) => ({
      key: u.id,
      hideKey: `p:${u.id}`,
      label: u.name,
      className: 'planning-person',
      sortKey: `p:${u.id}`,
      head: (
        // ponytail: native CSS resize for width; widths reset on reload.
        <div className="planning-col-resize">
          <button
            type="button"
            className="planning-sort"
            title={`${u.name}の回答で並べ替え（〇が上→〇が下→日付順）`}
            onClick={() => nextSort(`p:${u.id}`)}
          >
            {u.name}
            {sortMark(`p:${u.id}`)}
          </button>
          <select
            className="planning-col-filter"
            aria-label={`${u.name}の回答で絞り込み`}
            value={answerFilter[u.id] ?? ''}
            onChange={(e) => setAnswerFilter((f) => ({ ...f, [u.id]: e.target.value }))}
          >
            <option value="">すべて</option>
            {(['可', '未定', '不可', '未回答'] as const).map((a) => (
              <option key={a} value={a}>
                {ANSWER_SYMBOLS[a]} {a}
              </option>
            ))}
          </select>
          {d.answers[u.id]?.comment && (
            <details>
              <summary>補足</summary>
              {d.answers[u.id].comment}
            </details>
          )}
        </div>
      ),
      cell: (c: Candidate) => {
        const answer = answerOf(u.id, c.id);
        const selected = selectedOf(c.id);
        return (
          <>
            <span className={`planning-answer a-${answer}`} role="img" aria-label={answer} title={answer}>
              {ANSWER_SYMBOLS[answer as keyof typeof ANSWER_SYMBOLS]}
            </span>
            {/* One row per shown group, blank where not a member, so rows line up with the counts column. */}
            {shown('checks') &&
              shownGroups.map(({ id: n, name }) =>
                u.schedules.includes(n) ? (
                  <label className="planning-check" key={n} title={answer === '可' ? undefined : '代理変更で〇にすると選べます'}>
                    <input
                      aria-label={`${c.date} ${c.time} ${u.name} ${name}を選定`}
                      type="checkbox"
                      disabled={!editable || busy || answer !== '可'}
                      checked={selected.some((m) => m.user === u.id && m.schedule === n)}
                      onChange={(e) => choose(c.id, u.id, n, e.target.checked)}
                    />
                    {name}
                  </label>
                ) : (
                  <span className="planning-check" key={n} aria-hidden="true" />
                ),
              )}
          </>
        );
      },
    })),
  ];
  const cols = allCols.filter((col) => showAll || shown(col.hideKey));
  const hiddenCount = allCols.filter((col) => !shown(col.hideKey)).length + cs.filter((c) => !shown(`c:${plan.id}:${c.id}`)).length;
  const hiddenClass = (key: string) => (shown(key) ? '' : ' planning-hidden-item');
  const hideButton = (key: string, label: string) => (
    <button
      type="button"
      className="planning-hide"
      aria-label={`${label}を${shown(key) ? '非表示にする' : '表示する'}`}
      onClick={() => toggleShown(key, !shown(key))}
    >
      {shown(key) ? '非表示' : '表示する'}
    </button>
  );
  return (
    <section ref={sectionRef} className="card planning-matrix" aria-busy={audienceUpdating}>
      <div className="planning-section-heading">
        <h2>回答一覧・開催枠の選定</h2>
        <div className="planning-response-progress">
          <span>
            全候補に回答済み{' '}
            <strong>
              {complete} / {activePeople.length}人
            </strong>
          </span>
          <progress aria-label="全候補への回答完了" value={complete} max={activePeople.length || 1} />
        </div>
      </div>
      <p className="muted">
        {editable
          ? '回答を比較し、参加してもらう人の区分にチェックを入れてください。'
          : '確定時の選定を表示しています。確定後の名簿の変更は、Discordのフォーラムで行ってください。'}
      </p>
      <div className="planning-matrix-toolbar">
        <div className="actions">
          {canRefreshAudience && <button type="button" className="btn secondary sm"
            disabled={busy || selectionDirty || proxyDirty} onClick={() => mutate('audience-refresh', {})}>
            {audienceUpdating ? '対象者を更新中…' : '対象者を更新'}
          </button>}
          <button type="button" className="btn secondary sm" disabled={busy} onClick={() => downloadPlanningCsv(d)}>回答表をCSV出力</button>
          {canFullscreen && <button type="button" className="btn sm"
            onClick={() => (full ? document.exitFullscreen() : sectionRef.current?.requestFullscreen())}>
            {full ? '⤡ 全画面を終了' : '⛶ 全画面で表を見る'}
          </button>}
          <details className="planning-view-menu">
            <summary>表示設定</summary>
            <div className="planning-view-panel">
              <label>
                文字サイズ {view.zoom}%
                <input type="range" min={50} max={150} step={10} value={view.zoom}
                  onChange={(e) => setView((v) => ({ ...v, zoom: Number(e.target.value) }))} />
              </label>
              <label>
                <input type="checkbox" checked={view.transposed}
                  onChange={(e) => setView((v) => ({ ...v, transposed: e.target.checked }))} />
                行と列を入れ替える（日程候補を横に並べる）
              </label>
              <label>
                <input type="checkbox" checked={shown('checks')} onChange={(e) => toggleShown('checks', e.target.checked)} />
                選定チェック欄を表示する
              </label>
              <button type="button" className="btn secondary sm" onClick={() => setView(DEFAULT_VIEW)}>
                表示を元に戻す
              </button>
            </div>
          </details>
          <label className="planning-show-all">
            <input type="checkbox" checked={showAll} disabled={!hiddenCount && !showAll}
              onChange={(e) => setShowAll(e.target.checked)} />
            すべての行・列を表示{hiddenCount ? `（非表示 ${hiddenCount}件）` : '（非表示なし）'}
          </label>
        </div>
        <div className="planning-answer-legend" aria-label="回答の凡例">
          <span>
            <b className="a-可">〇</b> 可
          </span>
          <span>
            <b className="a-未定">△</b> 未定
          </span>
          <span>
            <b>×</b> 不可
          </span>
          <span>
            <b>—</b> 未回答
          </span>
        </div>
        <Field label="〇が何人以上">
          <input type="number" min={0} inputMode="numeric" value={minOk} placeholder="すべて"
            onChange={(e) => setMinOk(e.target.value)} />
        </Field>
        {groups.length > 1 && (
          <Field label="区分を絞る">
            <select disabled={busy} value={filter} onChange={(e) => setFilter(e.target.value)}>
              <option value="">すべて</option>
              {groups.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>
      {canRefreshAudience && <p className="muted">
        {audienceUpdating ? '更新しています。この画面を開いたままお待ちください。'
          : selectionDirty || proxyDirty ? '対象者を更新する前に、入力中の選定・代理回答を保存してください。'
          : 'ロール・区分を変更したら「対象者を更新」を押してください。過去の回答は保持します。'}
      </p>}
      {audienceResult && <p className="muted" role="status">{audienceResult}</p>}
      <div className="planning-table-help" id={tableHelp}>
        <span>
          〇・△・×や名前の見出しで並べ替え、名前の下の欄で回答を絞り込めます。選定済みの候補は絞り込んでも表示します。
          見出しの「非表示」で行・列を隠せます。隠した行・列は「すべての行・列を表示」で薄く表示され、「表示する」で戻せます。
          {filtering && ' 絞り込み中です。'}
        </span>
        <span>名前の見出しの右下をドラッグで幅を変更。表は縦・横にスクロールできます →</span>
      </div>
      <div
        className="planning-table-wrap"
        tabIndex={0}
        role="region"
        aria-label="日程候補ごとの回答と参加者選定"
        aria-describedby={tableHelp}
      >
        <table className={`planning-table${view.transposed ? ' planning-transposed' : ''}`} style={{ zoom: view.zoom / 100 }}>
          {view.transposed ? (
            <>
              <thead>
                <tr>
                  <th scope="col">項目</th>
                  {rows.map((c) => (
                    <th scope="col" key={c.id}
                      className={(selectedOf(c.id).length ? 'planning-selected-col' : '') + hiddenClass(`c:${plan.id}:${c.id}`)}>
                      {candidateHead(c)}
                      {hideButton(`c:${plan.id}:${c.id}`, candidateLine(c, 0))}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {cols.map((col) => (
                  <tr key={col.key} className={col.className + hiddenClass(col.hideKey)}>
                    <th scope="row" aria-sort={col.sortKey ? ariaSort(col.sortKey) : undefined}>
                      {col.head}
                      {hideButton(col.hideKey, col.label)}
                    </th>
                    {rows.map((c) => (
                      <td key={c.id}
                        className={(selectedOf(c.id).length ? 'planning-selected-col' : '') + hiddenClass(`c:${plan.id}:${c.id}`)}>
                        {col.cell(c)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </>
          ) : (
            <>
              <thead>
                <tr>
                  <th scope="col">日程候補</th>
                  {cols.map((col) => (
                    <th scope="col" key={col.key} className={col.className + hiddenClass(col.hideKey)}
                      aria-sort={col.sortKey ? ariaSort(col.sortKey) : undefined}>
                      {col.head}
                      {hideButton(col.hideKey, col.label)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id}
                    className={(selectedOf(c.id).length ? 'planning-selected' : '') + hiddenClass(`c:${plan.id}:${c.id}`)}>
                    <th scope="row">
                      {candidateHead(c)}
                      {hideButton(`c:${plan.id}:${c.id}`, candidateLine(c, 0))}
                    </th>
                    {cols.map((col) => (
                      <td key={col.key} className={col.className + hiddenClass(col.hideKey)}>
                        {col.cell(c)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </>
          )}
        </table>
      </div>
      {editable && (
        <>
          {invalidSelection && <div className="planning-change-notice" role="alert">
            <p>対象者・区分や回答の変更で、〇以外・対象外になった選定が残っています。除外して選び直してください。過去の回答は保持されています。</p>
            <button className="btn secondary" disabled={busy} onClick={() => setSlots(slots.map((s) => ({ ...s, members: s.members.filter((m) => m.status === '除外' || validMember(s, m)) })).filter((s) => s.members.length))}>対象外の選定を除外</button>
          </div>}
          {conflicts.length > 0 && (
            <p className="planning-change-notice" role="status">
              兼務・時間帯の重なりを確認してください：{conflicts.map((u) => u.name).join('、')}
              （所要時間未設定は60分として確認）
            </p>
          )}
          {d.announcementTemplate !== undefined && selectedSlots.map((s) => <AnnouncementPreview key={s.candidate} data={d} slot={s} />)}
          {!!d.eventReminderHours && <p className="muted">開始の{d.eventReminderHours}時間前から、参加予定者へこの開催枠のフォーラムで順次リマインドします。時刻未定の枠は対象外です。</p>}
          <div className="planning-selection-bar">
            <div className="planning-selection-summary" role="status">
              <strong>
                {selectedSlots.length}開催枠 / 延べ
                {selectedSlots.reduce((n, s) => n + new Set(s.members.map((m) => m.user)).size, 0)}
                人を選定
              </strong>
              <span className="muted">確定すると参加予定の人へ開催枠を案内します。</span>
            </div>
            <div className="actions">
              <button
                className="btn secondary"
                disabled={busy || invalidSelection}
                onClick={() => save('selection', { slots: selectedSlots })}
              >
                選定を保存
              </button>
              <button
                className="btn"
                disabled={busy || invalidSelection || !selectedSlots.length || (d.announcementTemplate !== undefined && selectedSlots.some((s) => announcementText(d, s).length > 4096))}
                onClick={() => save('confirm-selection', { slots: selectedSlots })}
              >
                開催枠を確定
              </button>
            </div>
          </div>
        </>
      )}
      {d.state === 'open' && (
        <details className="planning-proxy">
          <summary>回答を代理変更する</summary>
          <p className="muted">本人から確認した内容で回答を修正します。</p>
          <Field label="代理変更する回答者">
            <select
              disabled={busy}
              value={person}
              onChange={async (e) => {
                const next = e.target.value;
                if (
                  proxyDirty &&
                  !(await confirmDialog('未保存の代理変更を破棄して、回答者を切り替えますか？', {
                    okLabel: '破棄して切り替え',
                  }))
                )
                  return;
                setProxyDirty(false);
                setPerson(next);
              }}
            >
              <option value="">選択してください</option>
              {activePeople.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </Field>
          {person && (
            <Proxy
              key={person}
              plan={plan}
              user={person}
              busy={busy}
              mutate={save}
              onDirtyChange={setProxyDirty}
            />
          )}
        </details>
      )}
    </section>
  );
}
function Proxy({
  plan,
  user,
  busy,
  mutate,
  onDirtyChange,
}: {
  plan: Plan;
  user: string;
  busy: boolean;
  mutate: (a: string, b: unknown) => Promise<boolean>;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [values, setValues] = useState<Record<string, Availability>>({
      ...plan.data.answers[user]?.values,
    }),
    [comment, setComment] = useState(plan.data.answers[user]?.comment ?? ''),
    [reason, setReason] = useState('');
  useEffect(() => {
    onDirtyChange(
      JSON.stringify(values) !== JSON.stringify(plan.data.answers[user]?.values ?? {}) ||
        comment !== (plan.data.answers[user]?.comment ?? '') ||
        reason !== '',
    );
  }, [values, comment, reason, plan, user, onDirtyChange]);
  return (
    <details open className="planning-inset">
      <summary>回答を代理変更</summary>
      <div className="planning-grid">
        {plan.data.candidates
          .filter((c) => c.active)
          .map((c) => (
            <Field key={c.id} label={`${c.date} ${c.time}`}>
              <select
                value={values[c.id] ?? ''}
                disabled={busy}
                onChange={(e) => setValues({ ...values, [c.id]: e.target.value as Availability })}
              >
                <option value="" disabled>
                  未回答
                </option>
                {ANSWER_TYPES.map((v) => (
                  <option key={v} value={v}>
                    {ANSWER_SYMBOLS[v]}（{v}）
                  </option>
                ))}
              </select>
            </Field>
          ))}
      </div>
      <Field label="補足">
        <textarea
          disabled={busy}
          value={comment}
          maxLength={500}
          onChange={(e) => setComment(e.target.value)}
        />
      </Field>
      <Field label="変更理由">
        <input
          disabled={busy}
          value={reason}
          maxLength={500}
          onChange={(e) => setReason(e.target.value)}
        />
      </Field>
      <button
        className="btn"
        disabled={busy}
        onClick={() => mutate('answer', { user, values, comment, reason })}
      >
        代理変更を保存
      </button>
    </details>
  );
}
const KINDS: Record<string, string> = {
  publish: '回答案内',
  repost: '回答案内の再投稿',
  candidates: '候補変更案内',
  forum: '開催案内',
  task: '日程候補作成のリマインド',
  reminder: '未回答の催促',
  'answer-dm': '未回答の催促DM',
  'event-reminder': '開催前リマインド',
};
const JOBS: Record<string, string> = {
  pending: '投稿待ち',
  sending: '投稿中',
  sent: '投稿済み',
  failed: '失敗',
  unknown: '結果不明',
  cancelled: '取り消し',
};
function Delivery({
  job,
  busy,
  mutate,
}: {
  job: any;
  busy: boolean;
  mutate: (a: string, b: unknown) => Promise<boolean>;
}) {
  const [thread, setThread] = useState(''),
    [message, setMessage] = useState(''),
    [reason, setReason] = useState('');
  return (
    <div className="planning-job">
      <strong>
        {KINDS[job.kind] ?? job.kind} · {job.kind === 'answer-dm' ? ({ pending: '送信待ち', sending: '送信中', sent: '送信済み' } as Record<string, string>)[job.status] ?? JOBS[job.status] : JOBS[job.status]}
      </strong>
      {job.error && <p>{job.error}</p>}
      {job.message_id && job.kind !== 'answer-dm' && (
        <a
          href={`https://discord.com/channels/${job.guild_id ?? '@me'}/${job.thread_id ?? job.channel_id}/${job.message_id}`}
          target="_blank"
          rel="noreferrer"
        >
          投稿を開く
        </a>
      )}
      {job.status === 'failed' && (
        <button
          className="btn secondary"
          disabled={busy}
          onClick={() => mutate('retry', { delivery: job.id })}
        >
          再試行
        </button>
      )}
      {['unknown', 'failed'].includes(job.status) && (
        <details>
          <summary>投稿の確認・復旧</summary>
          <p>{job.kind === 'answer-dm' ? '本人とDMの送信結果を確認してください。既存メッセージを確認できる場合はIDを入力してください。' : 'Discordで投稿リンクをコピーし、末尾のチャンネルIDとメッセージIDを入力してください。'}</p>
          <Field label="投稿先チャンネル・スレッドID">
            <input value={thread} onChange={(e) => setThread(e.target.value)} />
          </Field>
          <Field label="メッセージID">
            <input value={message} onChange={(e) => setMessage(e.target.value)} />
          </Field>
          <button
            className="btn secondary"
            disabled={busy || !thread || !message}
            onClick={() => mutate('associate', { delivery: job.id, thread, message })}
          >
            既存の投稿を関連付ける
          </button>
          <Field label="Discord上で確認した結果（復旧の記録）">
            <input maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          {job.status === 'unknown' && (
            <button
              className="btn secondary"
              disabled={busy || !reason.trim()}
              onClick={async () => {
                if (
                  await confirmDialog(
                    'Discordを確認し、投稿が作成されていないことを確認しましたか？ 既存の投稿がある場合は関連付けてください。',
                    { okLabel: '未作成を確認して再試行' },
                  )
                )
                  await mutate('retry-verified', { delivery: job.id, verified: true, reason });
              }}
            >
              未作成を確認して再試行
            </button>
          )}
          {job.kind === 'forum' && job.error === 'Discord 404' && (
            <button
              className="btn secondary"
              disabled={busy || !reason.trim()}
              onClick={async () => {
                if (
                  await confirmDialog(
                    '関連付けた投稿が削除されたことを確認し、現在の名簿で新しく投稿します。',
                    { okLabel: '削除を確認して再作成' },
                  )
                )
                  await mutate('recreate', { delivery: job.id, verified: true, reason });
              }}
            >
              削除された投稿を再作成
            </button>
          )}
        </details>
      )}
    </div>
  );
}
function History({ item, people }: { item: any; people: PlanData['people'] }) {
  const before: PlanData = JSON.parse(item.before_data),
    after: PlanData = JSON.parse(item.after_data);
  const kinds: Record<string, string> = {
    'admin-answer': '管理画面で代理変更',
    'participant-answer': '本人が回答',
    confirm: '開催枠を確定',
    selection: '参加者を選定',
    roster: '確定名簿・開催枠を変更',
    settings: '共通設定を変更',
    'repair-memberships': '所属区分の補正',
    'audience-sync': '回答対象者を自動更新',
    'audience-refresh': '回答対象者を更新',
    candidates: '候補を変更',
    cancel: '日程調整を中止',
    publish: '回答案内を投稿待ちに登録',
    repost: '回答案内の再投稿を受け付け',
    skip: '今回を見送り',
    associate: '既存投稿を関連付け',
    retry: '投稿を再試行',
    'retry-verified': '未作成を確認して再試行',
    recreate: '削除された投稿を再作成',
  };
  const name = (id: string) => people.find((u) => u.id === id)?.name ?? id;
  function describe(d: PlanData) {
    if (['repair-memberships', 'audience-sync'].includes(item.kind))
      return d.people.map((u) => `${u.name}${u.active === false ? '（対象外）' : ''}：${u.schedules.map((id) => d.scheduleNames?.[id] ?? id).join('、')}`).join('\n');
    if (item.user_id) {
      const a = d.answers[item.user_id];
      return (
        d.candidates
          .filter((c) => c.active)
          .map((c) => `${c.date} ${c.time}：${a?.values[c.id] ?? '未回答'}`)
          .join('\n') + `\n補足：${a?.comment || 'なし'}`
      );
    }
    if (item.kind === 'candidates')
      return (
        d.candidates
          .filter((c) => c.active)
          .map((c) => `${c.date} ${c.time}`)
          .join('\n') || '候補なし'
      );
    if (['selection', 'confirm', 'roster', 'cancel'].includes(item.kind))
      return (
        d.slots
          .map((s) => {
            const c = d.candidates.find((c) => c.id === s.candidate);
            return `${c?.date} ${c?.time}${s.cancelled ? '（中止）' : ''}\n${s.members.map((m) => `${name(m.user)} / ${d.scheduleNames?.[m.schedule] ?? '対象テンプレート'}：${m.status === '参加' ? '参加予定' : m.status}${m.duty ? ' / ' + m.duty : ''}`).join('\n')}${s.gather ? `\n集合：${s.gather}` : ''}${s.note ? `\n連絡事項：${s.note}` : ''}`;
          })
          .join('\n\n') || '選定なし'
      );
    const reminder = d.answerReminder
      ? d.answerReminder.enabled ? `締切${d.answerReminder.beforeDays}日前から${d.answerReminder.intervalDays}日ごと ${d.answerReminder.time}（日本時間）に${d.answerReminder.target === 'channel' ? 'チャンネルへ投稿' : 'DM'}` : 'なし'
      : d.remindDays ? `${d.remindDays}日ごとにチャンネルへ投稿` : 'なし';
    return `名前：${d.name}\n状態：${STATES[d.state]}\n回答締切：${dt(d.deadline).replace('T', ' ') || '未設定'}\n未回答催促：${reminder}\n補足：${d.note || 'なし'}`;
  }
  return (
    <details className="planning-job">
      <summary>
        {dt(item.changed_at).replace('T', ' ')} · {kinds[item.kind] ?? item.kind}
        {item.user_id ? ` · ${name(item.user_id)}` : ''}
      </summary>
      <p>{item.reason || '理由の記載なし'}</p>
      <div className="planning-grid">
        <div>
          <strong>変更前</strong>
          <pre>{describe(before)}</pre>
        </div>
        <div>
          <strong>変更後</strong>
          <pre>{describe(after)}</pre>
        </div>
      </div>
    </details>
  );
}

/** 単発日程調整の作成・編集（テンプレートの編集画面を、日程候補作成のリマインドを除いて使う・2026-10-02） */
type OneOffEditor = {
  /** 編集なら元の日程調整・複製なら写す元。新規は undefined */
  initial?: PlanData;
  /** true = 新しく作る（新規・複製） */
  isNew: boolean;
  /** 保存できたら true（失敗時は入力を残す）。publish = 新規で回答案内まで投稿する */
  onSubmit: (body: any, publish?: boolean) => Promise<boolean>;
};
function Cycles({
  guild,
  schedules,
  channels,
  toast,
  legacy = false,
  oneOff,
  onDirtyChange,
  onBack,
}: {
  oneOff?: OneOffEditor;
  onBack?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  legacy?: boolean;
  guild: Guild;
  schedules: Schedule[];
  channels: Channel[];
  toast: ToastFn;
}) {
  const empty: CycleData = {
    name: '',
    standalone: !legacy,
    segments: [],
    remindDays: 0,
    ...(!legacy ? { autoAudience: false, answerReminder: { ...DEFAULT_ANSWER_REMINDER }, eventReminderHours: 2, announcementTemplate: DEFAULT_ANNOUNCEMENT_TEMPLATE, announceMention: 'role' as const, shareAnswers: false } : {}),
    schedules: [],
    channel: '',
    forum: '',
    tag: '',
    rrule: 'FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=1',
    anchor: '',
    time: '21:00',
    adminChannel: '',
    mentionMode: 'users',
    mentions: [],
    taskReminderDays: 3,
    origin: '',
  };
  const fromPlan = (x: PlanData): CycleData => ({
    ...empty,
    name: oneOff?.isNew ? `${x.name}のコピー` : x.name,
    segments: x.segments ?? [],
    channel: x.channel,
    forum: x.forum,
    tag: x.tag,
    answerReminder: x.answerReminder ?? { ...DEFAULT_ANSWER_REMINDER },
    announcementTemplate: withoutRetiredTokens(x.announcementTemplate ?? DEFAULT_ANNOUNCEMENT_TEMPLATE),
    eventReminderHours: x.eventReminderHours ?? 0,
    announceMention: x.announceMention ?? 'none',
    shareAnswers: !!x.shareAnswers,
    time: x.answerReminder?.time ?? '21:00',
  });
  const [items, setItems] = useState<any[]>([]),
    [id, setId] = useState(''),
    [d, setD] = useState(() => (oneOff?.initial ? fromPlan(oneOff.initial) : empty)),
    [enabled, setEnabled] = useState(false),
    [rule, setRule] = useState<RuleForm>({
      ...DEFAULT_RULE_FORM,
      freq: 'MONTHLY',
      interval: 2,
      monthlyMode: 'bymonthday',
      monthDays: [1],
    }),
    [targets, setTargets] = useState<{ users: { id: string; name: string }[]; roles: { id: string; name: string }[] }>({ users: [], roles: [] }),
    [preview, setPreview] = useState<string[]>([]),
    [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(!!oneOff);
  const [step, setStep] = useState('basic');
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState('');
  // Every posting target, reminder and announcement lives on the step of the thing it belongs to.
  const [eventOn, setEventOn] = useState(() => (oneOff?.initial?.eventReminderHours ?? 0) > 0);
  // 単発だけ: 回答締切と補足は日程調整そのものの値（複製では締切を写さない）。回答案内の投稿後は締切を変えられない（サーバーも同じ）
  const [oneOffDeadline, setOneOffDeadline] = useState(oneOff?.initial && !oneOff.isNew ? dt(oneOff.initial.deadline) : '');
  const [oneOffNote, setOneOffNote] = useState(oneOff?.initial?.note ?? '');
  const deadlineLocked = !!oneOff && !oneOff.isNew && oneOff.initial?.state !== 'draft';
  // 単発の新規だけ: 日程候補（複製でも写さない）。null = 読めない入力
  const [candidates, setCandidates] = useState<CandidateInput[] | null>([]);
  const blank = React.useMemo(() => blankPlan(''), []);
  const templateRef = React.useRef<HTMLTextAreaElement>(null);
  // The recurrence editor opens in a dialog so the card stays one line (no accordion). Cancel restores the snapshot.
  const ruleDialog = React.useRef<HTMLDialogElement>(null);
  const ruleSnapshot = React.useRef<{ rule: RuleForm; anchor: string } | null>(null);
  const openRuleDialog = () => {
    ruleSnapshot.current = { rule, anchor: d.anchor };
    ruleDialog.current?.showModal();
  };
  const cancelRuleDialog = () => {
    const snapshot = ruleSnapshot.current;
    if (snapshot) {
      setRule(snapshot.rule);
      setD((current) => ({ ...current, anchor: snapshot.anchor }));
    }
    ruleDialog.current?.close();
  };
  const insertToken = (token: string) => {
    const el = templateRef.current;
    const current = d.announcementTemplate ?? DEFAULT_ANNOUNCEMENT_TEMPLATE;
    const start = el?.selectionStart ?? current.length, end = el?.selectionEnd ?? current.length;
    patch({ announcementTemplate: current.slice(0, start) + token + current.slice(end) });
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  };
  // Steps follow one 日程調整 in time order (候補作成のリマインド → 回答案内 → 催促 → 開催案内 → 開催前リマインド), the way the
  // process is explained to operators (2026-09-23). No 配信設定 timeline: its three anchors (投稿期限・回答締切・開催日時) are set in
  // three different places, so each send sits next to what it belongs to (2026-09-20).
  // Numbers match the columns of the planning flow guide (PlanningFlow); 2 and 4 have no settings, S and E sit outside the flow (2026-09-23).
  // The zero-width space is the only break opportunity, so the rail wraps as 日程候補作成の／リマインド (word-break: keep-all).
  const steps: StepItem[] = oneOff
    ? [
        // 単発は日程候補作成のリマインドを持たず 1 から振る。新規では候補もここで入れ、E で回答案内を投稿する（2026-10-05）
        ['basic', 'S', '基本設定'],
        [oneOff.isNew ? 'candidates' : '', '1', '日程候補の作成'],
        ['guide', '2', '日程回答'],
        ['', '3', '開催日の決定'],
        ['announce', '4', '開催日ごとの​フォーラム作成'],
        ['confirm', 'E', oneOff.isNew ? '確認・日程調整​依頼を投稿' : '確認・保存'],
      ]
    : [
        ['basic', 'S', 'テンプレート設定'],
        ['task', '1', '日程候補作成の​リマインド'],
        ['', '2', '日程候補の作成・​回答依頼'],
        ['guide', '3', '日程回答'],
        ['', '4', '開催日の決定'],
        ['announce', '5', '開催日ごとの​フォーラム作成'],
        ['confirm', 'E', '確認・保存'],
      ];
  const pages = steps.filter(([key]) => key);
  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const firstOfNextMonth = () => {
    const n = new Date(), f = new Date(n.getFullYear(), n.getMonth() + 1, 1);
    return `${f.getFullYear()}-${String(f.getMonth() + 1).padStart(2, '0')}-01`;
  };
  /** Role ids carry a `role:` prefix in `mentions`; rows saved before 2026-09-20 used mentionMode 'roles' with bare ids. */
  const withRolePrefix = (data: CycleData): CycleData =>
    data.mentionMode === 'roles' ? { ...data, mentionMode: 'users', mentions: data.mentions.map((x) => (x.startsWith('role:') ? x : `role:${x}`)) } : data;
  function edit(row?: any) {
    // A new profile starts from the one saved most recently (channels, time, assignees, recurrence), so only the name and segments are new.
    const last = items[items.length - 1]?.data;
    const base: CycleData = row?.data ?? (last
      ? { ...empty, channel: last.channel, adminChannel: last.adminChannel, forum: last.forum, tag: last.tag, time: last.time, mentionMode: last.mentionMode, mentions: last.mentions, rrule: last.rrule, anchor: last.anchor }
      : { ...empty, anchor: firstOfNextMonth() });
    setId(row?.id ?? '');
    const loaded = withRolePrefix(structuredClone(base));
    if (loaded.announcementTemplate !== undefined) loaded.announcementTemplate = withoutRetiredTokens(loaded.announcementTemplate);
    setD(loaded);
    setEnabled(row ? !!row.enabled : true);
    setEventOn((base.eventReminderHours ?? 0) > 0);
    const form = ruleFormFromModel(parseRule(base.rrule || empty.rrule));
    setRule(form);
    setStep('basic');
    setPreview([]);
    setError('');
    setDirty(false);
    setEditing(true);
  }
  async function back() {
    if (
      dirty &&
      !(await confirmDialog('未保存の入力があります。破棄して一覧へ戻りますか？', {
        okLabel: '破棄して戻る',
      }))
    )
      return;
    setDirty(false);
    setEditing(false);
  }
  const patch = (x: Partial<CycleData>) => {setDirty(true);setD({ ...d, ...x });};
  const endpoint = legacy ? '/planning/cycles' : '/planning/profiles';
  const load = () =>
    api(`${endpoint}?guild_id=${guild.id}`).then((xs) =>
      setItems(legacy ? xs.filter((x: any) => !x.data.standalone) : xs),
    );
  useEffect(() => {
    if (oneOff) return;
    load().catch((e) => toast(e.message, true));
  }, [guild.id]);
  // People and roles are one list (role ids carry the role: prefix), so both are fetched once.
  useEffect(() => {
    if (oneOff) return; // 担当者は日程候補作成のリマインドだけで使う
    const label = (x: any) => x.name ?? x.display_name ?? x.nick ?? x.user?.global_name ?? x.user?.username ?? x.user_name ?? x.id;
    Promise.all([api(`/guilds/${guild.id}/members`), api(`/guilds/${guild.id}/roles`)])
      .then(([members, roles]) =>
        setTargets({
          users: members.map((x: any) => ({ id: x.id ?? x.user_id ?? x.user?.id, name: label(x) })),
          roles: roles.map((x: any) => ({ id: `role:${x.id}`, name: label(x) })),
        }),
      )
      .catch((e) => toast(e.message, true));
  }, [guild.id]);
  const rrule = rruleFromRuleForm(rule);
  const rp = (x: Partial<RuleForm>) => {setDirty(true);setRule({ ...rule, ...x });};
  const [previewError, setPreviewError] = useState('');
  // The next due dates follow the rule, first due date and send time without a button; stale replies are dropped.
  useEffect(() => {
    if (!rrule || !d.anchor) {
      setPreview([]);
      setPreviewError('');
      return;
    }
    let stale = false;
    const timer = setTimeout(() => {
      api('/notifications/preview-plan', {
        method: 'POST',
        body: JSON.stringify({ rrule, anchor_date: d.anchor.replace(/-/g, '/'), start_time: d.time, count: 5 }),
      })
        .then((x) => {
          if (stale) return;
          if (x.error) throw new Error(x.error);
          setPreview(x.dates);
          setPreviewError('');
        })
        .catch((e) => {
          if (stale) return;
          setPreview([]);
          setPreviewError((e as Error).message);
        });
    }, 300);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [rrule, d.anchor, d.time]);
  const issues = [
    !d.name.trim() ? (oneOff ? '名前を入力してください。' : '設定名を入力してください。') : '',
    oneOff && !oneOffDeadline ? '回答締切を入力してください。' : '',
    oneOff?.isNew && !candidates?.length ? (candidates ? '日程候補を1件以上入力してください。' : '日程候補の書き方と件数（1〜200件）を確認してください（各候補に開始時刻が必要です。「重複整理・日付順」で理由が出ます）。') : '',
    oneOff && !deadlineLocked && oneOffDeadline && Date.parse(jst(oneOffDeadline)) <= Date.now() ? '回答締切は今より後にしてください。' : '',
    !(legacy ? d.schedules : (d.segments ?? [])).length ? '回答対象の区分を選択してください。' : '',
    enabled && (!rrule || !d.anchor || !d.adminChannel || !d.mentions.length)
      ? '日程候補作成のリマインドの繰り返し・最初の期限・投稿先・担当者を設定してください。'
      : '',
    !d.channel ? '回答案内の投稿先を選択してください。' : '',
    !d.forum ? '開催案内を投稿するフォーラムを選択してください。' : '',
    !timeValue(d.time) ? '送信時刻を入力してください。' : '',
    !legacy && eventOn && !(Number.isInteger(d.eventReminderHours) && d.eventReminderHours! >= 1 && d.eventReminderHours! <= 168)
      ? '開催前リマインドは開始の1〜168時間前で入力してください。'
      : '',
  ].filter(Boolean);
  // Both reminders share the schedule flow's shape: a due date, "N days before", daily at one send time (ADR 0026).
  const taskDays = d.taskReminderDays ?? 0;
  const answerOn = !!d.answerReminder?.enabled;
  const answerDays = d.answerReminder?.beforeDays ?? DEFAULT_ANSWER_REMINDER.beforeDays;
  const nextDue = preview[0] ?? '';
  const ruleText = rrule ? describeRule(parseRule(rrule), null, null).replace(/\s*〜$/, '') : '繰り返し未設定';
  const dayBefore = (ymd: string, days: number) => {
    const t = Date.parse(ymd.replace(/\//g, '-'));
    return Number.isNaN(t) ? ymd : new Date(t - days * 86400000).toISOString().slice(0, 10).replace(/-/g, '/');
  };
  const dueLabel = (ymd: string) => {
    const [y, m, day] = ymd.split('/').map(Number);
    return `${ymd}（${'日月火水木金土'[new Date(y, m - 1, day).getDay()]}）`;
  };
  const daysInput = (value: number, onChange: (n: number) => void) => (
    <input type="number" min={0} max={30} value={value} onChange={(e) => onChange(Number(e.target.value))} />
  );
  const duePreview = (
    <>
      {preview.length > 0 && (
        <div className="planning-due-preview" role="list" aria-label="次の5回の期限">
          <span className="muted" role="presentation">次の期限</span>
          {preview.map((ymd, i) => (
            <span key={ymd} role="listitem" className={`pill${i === 0 ? ' accent' : ''}`}>
              {i === 0 ? '次回 ' : ''}
              {dueLabel(ymd)}
            </span>
          ))}
        </div>
      )}
      {previewError && (
        <p className="nf2-field-err" role="alert">
          {previewError}
        </p>
      )}
    </>
  );
  const forumTags = channels.find((c) => c.id === d.forum)?.tags ?? [];
  // A flow-step card (switch + "N days before", ADR 0026) without the timeline spine; the existing .nf2-tl-node styles apply.
  const switchCard = (n: { icon: string; title: string; chip: string; on: boolean; onToggle: (on: boolean) => void; offText: string; body: React.ReactNode }) => (
    <div className={`nf2-tl-node${n.on ? '' : ' off'}`}>
      <div className="nf2-tl-card">
        <div className="nf2-tl-title">
          <span>
            {n.icon} {n.title}
          </span>
          <span className="pill">{n.chip}</span>
          <span className="nf2-tl-switch" title={n.on ? 'オン＝自動で行う' : 'オフ＝自動では行わない'}>
            <Switch aria-label={`${n.title.replace(/​/g, '')}を自動で行う`} checked={n.on} onChange={(e) => n.onToggle(e.target.checked)} />
          </span>
        </div>
        {n.on ? n.body : <div className="nf2-tl-off">{n.offText}</div>}
      </div>
    </div>
  );
  const answerTarget = d.answerReminder?.target === 'channel' ? 'channel' : 'dm';
  const answerCard = switchCard({
    icon: '✉️', title: '未回答者へ催促', chip: answerTarget === 'channel' ? '📢 チャンネル投稿' : '✉️ 個別DM', on: answerOn,
    onToggle: (on) => patch({ answerReminder: { ...(d.answerReminder ?? DEFAULT_ANSWER_REMINDER), enabled: on }, remindDays: 0 }),
    offText: d.remindDays ? '送りません。（保存すると、従来のチャンネル催促も止まります）' : '送りません。',
    body: (
      <div className="nf2-tl-inline">
        <span>回答締切の</span>
        {daysInput(answerDays, (n) => patch({ answerReminder: { ...(d.answerReminder ?? DEFAULT_ANSWER_REMINDER), beforeDays: n } }))}
        <span>日前から締切まで毎日、未回答のメンバーへ</span>
        <select aria-label="催促の送り先" value={answerTarget} onChange={(e) => patch({ answerReminder: { ...(d.answerReminder ?? DEFAULT_ANSWER_REMINDER), target: e.target.value as 'dm' | 'channel' } })}>
          <option value="dm">本人へDM</option>
          <option value="channel">回答案内のチャンネルに投稿</option>
        </select>
        {answerDays === 0 && <span className="muted">＝ 締切当日のみ</span>}
        <Tip text="回答締切は日程調整を作るときに入力します。回答した人には送らず、締切を過ぎると回答の受付と催促を止めます。チャンネルに投稿する場合は、未回答のメンバーを個別メンションした投稿を回答案内のチャンネルに出します（40人ごとに1投稿）。" />
      </div>
    ),
  });
  const eventReminderCard = switchCard({
    icon: '🔔', title: '開催前リマインド', chip: '📢 フォーラム投稿', on: eventOn,
    onToggle: (on) => {
      setDirty(true);
      setEventOn(on);
      if (on && !((d.eventReminderHours ?? 0) > 0)) patch({ eventReminderHours: 2 });
    },
    offText: '投稿しません。',
    body: (
      <div className="nf2-tl-inline">
        <span>開始の</span>
        <input type="number" min={1} max={168} value={d.eventReminderHours ?? 0} onChange={(e) => patch({ eventReminderHours: Number(e.target.value) })} />
        <span>時間前に、この開催案内の投稿で @everyone をメンション</span>
        <Tip text="日付をまたいでも指定時間前に投稿します。スレッド内の @everyone は、そのスレッドの参加者だけに通知されます。開始時刻未定・開始後の枠と、中止した日程調整には投稿しません。" />
      </div>
    ),
  });
  const taskCard = switchCard({
    // Zero-width space: narrow widths wrap the title as 日程候補作成の／リマインド (word-break: keep-all), like the step rail.
    icon: '📣', title: '日程候補作成の​リマインド', chip: '📢 チャンネル投稿', on: enabled,
    onToggle: (on) => { setDirty(true); setEnabled(on); },
    offText: 'リマインドしません。',
    body: (
      <div className="nf2-tl-inline">
        <span>回答案内の投稿期限の</span>
        {daysInput(taskDays, (n) => patch({ taskReminderDays: n }))}
        <span>日前から期限まで毎日 {d.time || '送信時刻'} に、担当者へ</span>
        {taskDays === 0 && <span className="muted">＝ 期限当日から</span>}
        {nextDue && <span className="muted">次回は {dayBefore(nextDue, taskDays)} から</span>}
        <Tip text="送信時刻は「3 日程回答」の設定と共通です。このテンプレートで回答案内を投稿すると、その期限のリマインドは止まります。期限を過ぎると、次の期限に向けて再開します。日程調整は「＋ 日程調整を作成」から作ります。" />
      </div>
    ),
  });
  const mentionUsers = d.mentions.filter((x) => !x.startsWith('role:')).length, mentionRoles = d.mentions.length - mentionUsers;
  const mentionSummary = [mentionUsers ? `担当者 ${mentionUsers}名` : '', mentionRoles ? `ロール ${mentionRoles}件` : ''].filter(Boolean).join('・') || '担当者 未選択';
  // A sample forum post (two people per selected segment, next Saturday 20:00) so the template can be judged before any plan exists.
  const sampleAnnouncement = (() => {
    const groups = (legacy ? d.schedules : (d.segments ?? [])).map((id) => ({ id, name: schedules.find((s) => s.id === id)?.name ?? `区分 ${id}` }));
    const people = groups.flatMap((g, i) => ['メンバーA', 'メンバーB'].map((name, j) => ({ id: `sample-${i}-${j}`, name, schedule: g.id })));
    const n = new Date(), sat = new Date(n.getFullYear(), n.getMonth(), n.getDate() + ((6 - n.getDay() + 7) % 7 || 7));
    const data = {
      standalone: !legacy, name: d.name || '○月の日程調整', segments: groups.map((g) => g.id), schedules: legacy ? groups.map((g) => g.id) : [],
      scheduleNames: Object.fromEntries(groups.map((g) => [String(g.id), g.name])),
      candidates: [{ id: 'sample', date: `${sat.getFullYear()}/${String(sat.getMonth() + 1).padStart(2, '0')}/${String(sat.getDate()).padStart(2, '0')}`, time: '20:00', active: true }],
      announcementTemplate: d.announcementTemplate ?? DEFAULT_ANNOUNCEMENT_TEMPLATE,
    } as unknown as PlanData;
    const slot: Slot = { id: 'sample', candidate: 'sample', cancelled: false, gather: '', note: '', members: people.map((p) => ({ user: p.id, schedule: p.schedule, status: '参加', duty: '' })) };
    return announcementText(data, slot).replace(/<@([\w-]+)>/g, (match, id) => `@${people.find((p) => p.id === id)?.name ?? id}`);
  })();
  // 単発: 日程調整そのものを作る／保存する（Planning 側で POST /planning か settings）。publish = 新規で回答案内まで投稿
  async function submitOneOff(publish: boolean) {
    if (!oneOff) return;
    if (publish && oneOff.isNew && !(await confirmDialog('回答対象のメンバー向けチャンネルに、日程候補の回答案内を投稿します。', { okLabel: '日程調整依頼を投稿' })))
      return;
    setBusy(true);
    try {
      const saved = await oneOff.onSubmit({
        ...d,
        oneOff: true,
        deadline: jst(oneOffDeadline),
        note: oneOffNote,
        remindDays: 0,
        eventReminderHours: eventOn ? d.eventReminderHours : 0,
        answerReminder: { ...(d.answerReminder ?? DEFAULT_ANSWER_REMINDER), enabled: answerOn, intervalDays: 1, time: d.time },
        ...(oneOff.isNew ? { candidates } : {}),
      }, publish && oneOff.isNew);
      if (saved) setDirty(false);
    } finally {
      setBusy(false);
    }
  }
  if (!editing)
    return (
      <>
        {onBack && <>
          <div className="page-crumb">
            <a href={`#g/${guild.id}/planning`} onClick={(e) => { e.preventDefault(); onBack(); }}>定期日程調整</a>
            <span>›</span><span>テンプレート</span>
          </div>
          <button className="page-back" onClick={onBack}>← 定期日程調整へ戻る</button>
        </>}
        <div className="sec-head occurrence-head">
          <h2>{legacy ? '以前のテンプレート連携リマインド' : `日程調整のテンプレート (${items.length})`}</h2>
          {!legacy && (
            <button className="btn" onClick={() => edit()}>
              ＋ 新規設定
            </button>
          )}
        </div>
        <p className="muted">
          誰に聞くか・どこへ投稿するか・いつ催促するかを保存し、日程調整を作るたびに使います。毎回の日程候補と回答締切は「定期日程調整」で入力します。
        </p>
        {!items.length && (
          <div className="empty">設定がありません。「＋ 新規設定」から作成してください。</div>
        )}
        <div className="planning-list">
          {items.map((row) => (
            <div className="listrow" key={row.id}>
              <div>
                <strong>{row.data.name}</strong>
                <div className="muted planning-meta">
                  {(legacy ? row.data.schedules : (row.data.segments ?? []))
                    .map((id: number) => schedules.find((s) => s.id === id)?.name ?? '未取得')
                    .join('・')}{' '}
                  · #{channels.find((c) => c.id === row.data.channel)?.name ?? '未取得'}
                  {' · '}日程候補作成のリマインド{row.enabled ? 'あり' : 'なし'}
                </div>
              </div>
              <div className="actions">
                <button className="btn sm ghost" onClick={() => edit(row)}>
                  編集
                </button>
              </div>
            </div>
          ))}
        </div>
      </>
    );
  return (
    <div className="planning-settings-editor">
      {!oneOff && <div className="sec-head occurrence-head">
        <div>
          <div className="page-crumb">
            <a
              href={`#g/${guild.id}/planning-settings`}
              onClick={(e) => {
                e.preventDefault();
                back();
              }}
            >
              日程調整のテンプレート
            </a>
            <span>›</span>
            <span>{id ? '編集' : '新規'}</span>
          </div>
          <h2>{id ? '日程調整のテンプレートを編集' : '日程調整のテンプレートを新規作成'}</h2>
        </div>
        <button className="page-back" onClick={back}>
          ← 戻る
        </button>
      </div>}
      <div className="nf2-layout">
        <StepRail label="設定の入力ステップ" steps={steps} active={step} onPick={setStep} />
        <div className="nf2-main" onChange={() => setDirty(true)}>
          {error && (
            <p className="planning-error" role="alert">
              {error}
            </p>
          )}
          <section hidden={step !== 'basic'}>
            <h3>{oneOff ? '基本設定' : 'テンプレート設定'}</h3>
            {/* Discord-side prerequisites at the top of step 1 (wording confirmed by the user, 2026-09-20). */}
            {!legacy && (
              <div className="nf2-prereq" role="note" aria-label="Discord 側で用意しておくもの">
                <div className="nf2-prereq-title">
                  Discord 側で用意しておくもの<span className="muted">初回設定の Bot 招待と Server Members Intent は済んでいる前提</span>
                </div>
                <ul>
                  <li><b>対象メンバーのロール</b>: 日程を聞く人に付けるロール（Everyone でも可）。「メンバー管理」で区分として登録します。</li>
                  <li>
                    <b>回答案内を投稿するチャンネル</b>: テキストチャンネル。Bot がそのチャンネルを見て投稿できること。
                    <Tip text="非公開チャンネルの場合は、チャンネルの権限で Bot のロールに「チャンネルを見る」「メッセージを送信」を許可してください。" />
                  </li>
                  <li>
                    <b>開催案内を投稿するフォーラム</b>: フォーラムチャンネル（テキストチャンネルは使えません）。Bot に「チャンネルを見る」「投稿を作成」「スレッドでメッセージを送信」の権限が必要です。
                    <Tip text="開催前リマインドは開催案内の投稿内に送るため「スレッドでメッセージを送信」が要ります。2026-09-23 以降の招待リンクには含まれています。それより前に招待した Bot は、Bot設定の招待リンクを踏み直すか、サーバー設定で Bot のロールに許可してください。投稿を分類したい場合は、フォーラムの設定でタグを作っておきます（任意）。" />
                  </li>
                  <li><b>メンバーの DM 設定</b>: 未回答者への催促を本人への DM で送る場合。受け取る側が「サーバーメンバーからのダイレクトメッセージを許可」にしていないと届きません（チャンネルへの投稿にすれば不要）。</li>
                  {!oneOff && <li><b>日程候補作成のリマインドを使う場合</b>: 運営向けのテキストチャンネルと、知らせる担当者（個人またはロール）。ロールをメンションするなら、Bot に「@everyone・全ロールへのメンション」権限があるか、ロールの設定で @mention を許可しておくこと。</li>}
                </ul>
              </div>
            )}
            <p className="nf2-lead">
              {oneOff ? 'この日程調整の名前・回答締切と、日程の可否を聞くメンバー区分を決めます。' : 'この設定の名前と、日程の可否を聞くメンバー区分を決めます。'}
              {!legacy && <Tip text="回答を聞く人は、回答案内を投稿した時点のメンバーで決まります。あとでロールや区分を変えたときは、その日程調整の「回答確認・開催決定」にある「対象者を更新」を押してください。" />}
            </p>
            <Field label={oneOff ? '名前' : '設定名'}>
              <input value={d.name} onChange={(e) => patch({ name: e.target.value })} maxLength={150} placeholder={oneOff ? '例：10・11月の日程調整' : undefined} />
            </Field>
            {oneOff && (
              <>
                <Field label={deadlineLocked ? '回答締切（日本時間・回答案内の投稿後は変更できません）' : '回答締切（日本時間）'}>
                  <input type="datetime-local" disabled={deadlineLocked} value={oneOffDeadline} onChange={(e) => { setDirty(true); setOneOffDeadline(e.target.value); }} />
                </Field>
                <Field label="回答案内の補足">
                  <textarea maxLength={1000} value={oneOffNote} onChange={(e) => { setDirty(true); setOneOffNote(e.target.value); }} />
                </Field>
              </>
            )}
            <ScheduleChoices
              segments={!legacy}
              items={schedules}
              value={legacy ? d.schedules : (d.segments ?? [])}
              onChange={(ids) => patch(legacy ? { schedules: ids } : { segments: ids })}
            />
          </section>
          <section hidden={step !== 'task'}>
            <h3>日程候補作成のリマインド</h3>
            <p className="nf2-lead">毎回の日程候補の作成と回答案内の投稿を忘れないよう、期限を決めて担当者に自動で知らせる設定です。</p>
            {taskCard}
            {/* Greyed out while the reminder is off, so unused fields do not compete for attention. */}
            <fieldset className="planning-step-fields" disabled={!enabled}>
              <div className="subhead">回答案内の投稿期限（繰り返し）</div>
              <RecurrenceFields rule={rule} onChange={rp} showErrors />
              <Field label="最初の期限（繰り返しに当てはまる日）">
                <input type="date" value={d.anchor} onChange={(e) => patch({ anchor: e.target.value })} />
              </Field>
              {duePreview}
              <div className="subhead">日程候補の作成を依頼する担当者</div>
              <ChannelChoice label="リマインドを投稿するチャンネル" items={channels} value={d.adminChannel} onChange={(adminChannel) => patch({ adminChannel })} />
              <fieldset>
                <legend>担当者（複数選択可）</legend>
                {(['users', 'roles'] as const).map((kind) => (
                  <div key={kind} className="planning-targets-group">
                    <div className="planning-targets-title">{kind === 'users' ? '個人' : 'ロール'}</div>
                    <div className="planning-targets">
                      {targets[kind].map((t) => (
                        <label key={t.id}>
                          <input
                            type="checkbox"
                            checked={d.mentions.includes(t.id)}
                            onChange={(e) => patch({ mentions: e.target.checked ? [...d.mentions, t.id] : d.mentions.filter((x) => x !== t.id) })}
                          />
                          {t.name}
                        </label>
                      ))}
                      {!targets[kind].length && <span className="muted">{kind === 'users' ? '選べるメンバーがいません' : '選べるロールがありません'}</span>}
                    </div>
                  </div>
                ))}
              </fieldset>
            </fieldset>
          </section>
          {oneOff?.isNew && (
            <section hidden={step !== 'candidates'}>
              <h3>日程候補の作成</h3>
              <p className="nf2-lead">回答してもらう日程候補を入力します。回答案内は最後の「確認・日程調整依頼を投稿」で投稿します。</p>
              <Candidates data={blank} busy={busy} onChange={setCandidates} onDirty={(x) => { if (x) setDirty(true); }} />
            </section>
          )}
          <section hidden={step !== 'guide'}>
            <h3>日程回答</h3>
            <p className="nf2-lead">日程候補に可否をつけてもらうために、運営がチャンネルへ投稿する案内が「回答案内」です。その投稿先と、未回答のメンバーへの催促を決めます。</p>
            <ChannelChoice
              label="回答案内の投稿先"
              items={channels}
              value={d.channel}
              onChange={(channel) => patch({ channel, ...(d.adminChannel ? {} : { adminChannel: channel }) })}
            />
            {!legacy && (
              <Field label="回答案内のメンション">
                <select value={d.announceMention ?? 'none'} onChange={(e) => patch({ announceMention: e.target.value as 'none' | 'role' })}>
                  <option value="role">対象区分のロール</option>
                  <option value="none">なし</option>
                </select>
              </Field>
            )}
            {!legacy && answerCard}
            {!legacy && (
              <div className="setting-row">
                <div className="setting-row-main">
                  <div className="setting-row-title">
                    回答者に他の回答者の回答を見せる
                    <Tip text="オンにすると、回答画面に候補ごとの可・未定・不可の人数と、「回答状況を見る」で全員の名前と回答の一覧を表示します。運営への補足は見せません。オフでは本人と運営だけが回答を見られます。作成済みの日程調整には影響しません。" />
                  </div>
                  <div className="setting-row-desc">{d.shareAnswers ? '回答画面に集計と全員の回答を表示します。' : '本人と運営だけが回答を確認できます。'}</div>
                </div>
                <div className="setting-row-control">
                  <Switch aria-label="回答者に他の回答者の回答を見せる" checked={!!d.shareAnswers} onChange={(e) => patch({ shareAnswers: e.target.checked })} />
                </div>
              </div>
            )}
            <div className="setting-row">
              <div className="setting-row-main">
                <div className="setting-row-title">
                  🕘 送信時刻（日本時間）
                  <Tip text="催促やリマインドは、毎日この時刻に送ります。日程候補作成のリマインドにも使います。DMは人数分を順に送ります。" />
                </div>
              </div>
              <div className="setting-row-control">
                <input type="time" aria-label="送信時刻（日本時間）" value={d.time} onChange={(e) => patch({ time: e.target.value })} />
              </div>
            </div>
          </section>
          <section hidden={step !== 'announce'}>
            <h3>開催日ごとのフォーラム作成</h3>
            <p className="nf2-lead">
              参加者を確定したときに、開催枠ごとにフォーラムへ投稿する開催案内の設定です。
              <Tip text="タグはフォーラムの投稿を分類するラベルで、回答対象者を決めるDiscordのロールとは別です。" />
            </p>
            <div className="planning-grid">
              <ChannelChoice label="開催案内を投稿するフォーラム" items={channels} value={d.forum} onChange={(forum) => patch({ forum, tag: '' })} forum />
              <Field label="投稿に付けるタグ">
                <select value={d.tag} onChange={(e) => patch({ tag: e.target.value })}>
                  <option value="">指定なし</option>
                  {forumTags.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            {!legacy && (
              <>
                <Field label="開催案内の本文（定型文）">
                  <textarea ref={templateRef} rows={12} maxLength={3000} value={d.announcementTemplate ?? DEFAULT_ANNOUNCEMENT_TEMPLATE} onChange={(e) => patch({ announcementTemplate: e.target.value })} />
                </Field>
                <div className="planning-tokens" role="group" aria-label="差し込み項目">
                  <span className="muted">差し込み項目</span>
                  {TEMPLATE_TOKENS.map((token) => (
                    <button key={token} type="button" className="nf2-chip wide" onClick={() => insertToken(token)}>
                      {token}
                    </button>
                  ))}
                  <Tip text="押した位置に差し込みます。{{名簿}} は必須で、区分ごとに参加者の名前が入ります。集合場所や開場時刻などは文章で追記できます。確定前に、参加者を入れた本文を確認できます。確定後の参加者の追加・削除や連絡は、Discordのフォーラムで行ってください。" />
                  {d.announcementTemplate === undefined && (
                    <button type="button" className="btn xs secondary" onClick={() => patch({ announcementTemplate: DEFAULT_ANNOUNCEMENT_TEMPLATE })}>この定型文を使用する</button>
                  )}
                </div>
                <div className="subhead">投稿のプレビュー（例）</div>
                <pre className="planning-announcement-preview" aria-label="開催案内のプレビュー">{sampleAnnouncement}</pre>
                <p className="muted">名前・日時・参加者は例です。実際は各日程調整で確定した内容が入ります。</p>
                {eventReminderCard}
              </>
            )}
          </section>
          <section hidden={step !== 'confirm'}>
            <h3>設定内容の確認</h3>
            {/* Rows in step order, so the summary reads like the steps just filled in. */}
            <dl className="nf2-sum-card">
              <div className="nf2-sum-row">
                <dt className="nf2-sum-label">{oneOff ? '名前' : '設定名'}</dt>
                <dd className="nf2-sum-value">{d.name || '未入力'}</dd>
              </div>
              {oneOff && (
                <div className="nf2-sum-row">
                  <dt className="nf2-sum-label">回答締切</dt>
                  <dd className="nf2-sum-value">{oneOffDeadline ? `${oneOffDeadline.replace('T', ' ')}（日本時間）` : '未入力'}{oneOffNote ? ' · 補足あり' : ''}</dd>
                </div>
              )}
              {oneOff?.isNew && (
                <div className="nf2-sum-row">
                  <dt className="nf2-sum-label">日程候補</dt>
                  <dd className="nf2-sum-value">{candidates ? `${candidates.length}件` : '入力を確認してください'}</dd>
                </div>
              )}
              <div className="nf2-sum-row">
                <dt className="nf2-sum-label">回答対象</dt>
                <dd className="nf2-sum-value">
                  {(legacy ? d.schedules : (d.segments ?? []))
                    .map((id) => schedules.find((s) => s.id === id)?.name ?? id)
                    .join('・') || '未選択'}
                </dd>
              </div>
              {!oneOff && <div className="nf2-sum-row">
                <dt className="nf2-sum-label">日程候補作成の​リマインド</dt>
                <dd className="nf2-sum-value">
                  {enabled
                    ? `${ruleText}${nextDue ? ` ・ 次回 ${dueLabel(nextDue)}` : ''} ・ 期限の${taskDays}日前から毎日 · 投稿先 ${channels.find((c) => c.id === d.adminChannel)?.name || '未選択'} · ${mentionSummary}`
                    : 'なし（手動で作成）'}
                </dd>
              </div>}
              <div className="nf2-sum-row">
                <dt className="nf2-sum-label">回答案内の投稿先</dt>
                <dd className="nf2-sum-value">{`${channels.find((c) => c.id === d.channel)?.name || '未選択'}${legacy ? '' : d.announceMention === 'role' ? ' · 対象区分のロールをメンション' : ' · メンションなし'}`}</dd>
              </div>
              <div className="nf2-sum-row">
                <dt className="nf2-sum-label">{legacy ? '未回答催促' : '未回答者へ催促'}</dt>
                <dd className="nf2-sum-value">
                  {legacy
                    ? d.remindDays ? `${d.remindDays}日ごとにチャンネルへ投稿` : 'なし'
                    : answerOn ? `回答締切の${answerDays}日前から締切まで毎日、${answerTarget === 'channel' ? '回答案内のチャンネルへ投稿' : '本人へDM'}` : '送らない'}
                </dd>
              </div>
              {!legacy && (
                <div className="nf2-sum-row">
                  <dt className="nf2-sum-label">他の回答者の回答</dt>
                  <dd className="nf2-sum-value">{d.shareAnswers ? '回答者に見せる（集計と一覧）' : '見せない（本人と運営だけ）'}</dd>
                </div>
              )}
              <div className="nf2-sum-row">
                <dt className="nf2-sum-label">送信時刻</dt>
                <dd className="nf2-sum-value">{d.time ? `${d.time}（日本時間）` : '未設定'}</dd>
              </div>
              <div className="nf2-sum-row">
                <dt className="nf2-sum-label">開催案内</dt>
                <dd className="nf2-sum-value">{`フォーラム ${channels.find((c) => c.id === d.forum)?.name || '未選択'}${d.tag ? `（タグ: ${forumTags.find((t) => t.id === d.tag)?.name ?? d.tag}）` : ''}${legacy ? '' : ` · 本文${d.announcementTemplate === undefined || d.announcementTemplate === DEFAULT_ANNOUNCEMENT_TEMPLATE ? '（初期の定型文）' : '（変更あり）'}`}`}</dd>
              </div>
              {!legacy && (
                <div className="nf2-sum-row">
                  <dt className="nf2-sum-label">開催前リマインド</dt>
                  <dd className="nf2-sum-value">{eventOn ? `開始の${d.eventReminderHours}時間前に @everyone をメンション` : '投稿しない'}</dd>
                </div>
              )}
            </dl>
            {issues.map((issue) => (
              <p key={issue} className="planning-error">
                {issue}
              </p>
            ))}
            <p className="muted">
              {oneOff
                ? oneOff.isNew ? '「日程調整依頼を投稿」で、回答対象のメンバーへ回答案内を投稿します。「下書き保存」なら投稿せずに保存し、あとで日程候補の画面から投稿できます。' : '保存した内容は、これからの投稿・催促から使います。'
                : '変更は次に作る日程調整から適用されます。作成済みの日程調整は変わりません。'}
            </p>
          </section>
          <div className="nf2-nav">
            {step !== 'basic' ? (
              <button
                className="btn secondary"
                onClick={() => setStep(pages[pages.findIndex((s) => s[0] === step) - 1][0])}
              >
                前へ
              </button>
            ) : <span />}
            {step !== 'confirm' && (
              <button
                className="btn"
                onClick={() => setStep(pages[pages.findIndex((s) => s[0] === step) + 1][0])}
              >
                次へ
              </button>
            )}

            {oneOff?.isNew && step === 'confirm' && (
              <button className="btn secondary" disabled={busy || issues.length > 0} onClick={() => submitOneOff(false)}>
                下書き保存
              </button>
            )}
            <button
              className="btn"
              style={step !== 'confirm' ? {display:'none'} : undefined}
              disabled={busy || issues.length > 0 || (legacy && !id) || (oneOff?.isNew && !candidates?.length)}
              onClick={async () => {
                if (oneOff) return submitOneOff(true);
                setBusy(true);
                try {
                  const result = await api(endpoint, {
                    method: 'POST',
                    body: JSON.stringify({
                      id: id || undefined,
                      guild_id: guild.id,
                      data: {
                        ...d,
                        rrule,
                        taskReminderDays: taskDays,
                        // One send time for both reminders; the legacy channel reminder is retired on save.
                        ...(legacy
                          ? {}
                          : { remindDays: 0, eventReminderHours: eventOn ? d.eventReminderHours : 0, answerReminder: { ...(d.answerReminder ?? DEFAULT_ANSWER_REMINDER), enabled: answerOn, intervalDays: 1, time: d.time } }),
                      },
                      enabled,
                    }),
                  });
                  setId(result.id);
                  await load();
                  setDirty(false);
                  setEditing(false);
                  toast('設定を保存しました');
                } catch (e) {
                  setError((e as Error).message);
                  toast((e as Error).message, true);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {oneOff ? (oneOff.isNew ? '日程調整依頼を投稿' : '保存する') : '設定を保存'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
