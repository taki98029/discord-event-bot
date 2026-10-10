// スケジュールの新規作成・編集ページ（ウィザード型・ルート notifications/new[/irregular]・<uuid>/edit）。
// 設計: 左にステップレール、右に1ステップずつ表示。新規=基本情報から順に、編集=確認（サマリー）から各項目へジャンプ。
// 種別（定期／不定期）は入口から引き継いで固定（irregular prop・切替 UI は無い・ADR 0025/0040）。
// 定期の「開催日時」は 4 カード（毎日／毎週／毎月／毎年）＋間隔＋次回の開催日（間隔 ≥ 2）。
// 不定期（rrule NULL）は開催日を持たず（開催回は「単発出欠確認」で都度追加）、配信設定は募集の自動/手動のみ（flow-settings-spec §3）。
// 保存形は RRULE サブセット文法（src/lib/rruleGrammar.ts・不定期は null）。開催日の列挙はサーバー
// POST /notifications/preview-plan（cron と同じ評価関数）。設計: docs/dev/schedule-recurrence-redesign.md §6。
import * as React from 'react';
import { useEffect, useState } from 'react';
import { RecurrenceFields } from '../components/RecurrenceFields';
import { Tip } from '../components/InfoTip';
import { Pill, Select, Switch, TextField, Textarea } from '../../../design-system/src';
import { pickable } from '../lib/channels';
import { api, type Guild } from '../api';
import { confirmDialog, withBusy } from '../lib/dialog';
import { FLOW_STEP_NAMES, buildRecruitPreviewParts, flowWarnings, notifPreviewSummary } from '../lib/notifPreview';
import { DEFAULT_QUOTA_MESSAGE, QUOTA_MESSAGE_FIELDS, QUOTA_MESSAGE_MAX, quotaMessage, quotaMessageError } from '../../../src/lib/quotaMessage';
import {
  DEFAULT_RULE_FORM,
  INTERVAL_MAX,
  daysFromToday,
  jstToday,
  dedupeMonthlyRules,
  describeRule,
  formatRule,
  modelFromRuleForm,
  occurrenceLabel,
  parseRule,
  ruleFormFromModel,
  shortDateWithWeekday,
  type Freq,
  type RuleForm,
} from '../lib/rrule';
import type { ToastFn } from '../App';
import { useStickyHeight } from '../components/FlowGuide';
import { ScheduleFlow } from './NotifOps';
import { SCHEDULE_LABELS } from '../lib/route';

type Channel = { id: string; name: string; enabled?: boolean };
type Segment = { id: string; uuid: string; name: string; mention_role_id?: string | null };
type NotifDetail = {
  uuid: string;
  type: string;
  name: string;
  message_title: string;
  message_body: string | null;
  channel_id: string;
  segment_id: string;
  rrule: string | null;
  anchor_date: string | null;
  start_time: string | null;
  duration_minutes: number | null;
  recruit_days_before: number;
  remind_start_days: number;
  remind_undecided_days: number;
  /** 配信の流れの工程スイッチ（ADR 0026）。0=自動では行わない（日数は保持） */
  recruit_enabled?: 0 | 1 | boolean;
  remind_unanswered_enabled?: 0 | 1 | boolean;
  remind_undecided_enabled?: 0 | 1 | boolean;
  remind_target?: 'dm' | 'channel';
  remind_undecided_target?: 'dm' | 'channel';
  share_answers?: 0 | 1 | boolean;
  quota_enabled: 0 | 1 | boolean;
  quota_interval_days: number | null;
  quota_message?: string | null;
  mention_mode: 'role' | 'members' | 'none';
  requires_response: 0 | 1 | boolean | null;
  send_hour: number | null;
  response_deadline_hours: number | null;
  change_alert_channel_id: string | null;
  active: 0 | 1 | boolean;
};

const numOrNull = (s: string) => (s.trim() === '' ? null : Number(s));
/** リマインドの送り先の表示名（カードの選択肢と確認ステップで共用） */
const TARGET_LABEL = { dm: '本人へDM', channel: '投稿チャンネルに投稿' } as const;

type StepKey = 'basic' | 'when' | 'message' | 'flow' | 'confirm';
const STEPS: { key: StepKey; icon: string; label: string }[] = [
  { key: 'basic', icon: '📌', label: '基本情報' },
  { key: 'when', icon: '🗓️', label: '開催日時' },
  { key: 'message', icon: '📝', label: '投稿メッセージ' },
  { key: 'flow', icon: '📤', label: '投稿設定' },
  { key: 'confirm', icon: '✅', label: '確認して保存' },
];
const ALL_STEPS = STEPS.map((s) => s.key);


type PreviewPlan = { dates: string[]; anchor_candidates: string[]; error?: string };

export function NotificationFormV2({
  guild,
  nuuid,
  irregular: irregularNew,
  oneOff: oneOffNew,
  toast,
  onDirtyChange,
  onClose,
  onSaved,
  copyFrom,
}: {
  guild: Guild;
  nuuid?: string; // 未指定 = 新規
  copyFrom?: string; // 指定 = その行の内容を初期値にした新規作成（複製・2026-09-20）。開催回・回答は写さない
  irregular?: boolean; // 新規作成の種別（true=不定期）。編集時は読み込んだ行の rrule で決まる
  oneOff?: boolean; // 新規作成が単発か（irregular も true）。編集・複製時は読み込んだ行の type で決まる
  toast: ToastFn;
  onDirtyChange: (dirty: boolean) => void;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [segs, setSegs] = useState<Segment[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  // ---- フォーム状態（v1 と同一の既定値） ----
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [segmentUuid, setSegmentUuid] = useState('');
  const [channelId, setChannelId] = useState('');
  const [extraChannelOpt, setExtraChannelOpt] = useState<Channel | null>(null);
  // 種別は作成時に固定: 不定期の新規は freq='IRREGULAR' で始まり、カード UI が無いため以後変わらない
  const [rule, setRule] = useState<RuleForm>(() =>
    !nuuid && irregularNew ? { ...DEFAULT_RULE_FORM, freq: 'IRREGULAR' } : DEFAULT_RULE_FORM,
  );
  const [ruleUnreadable, setRuleUnreadable] = useState(false); // 既存の rrule が文法外（再選択するまで保存不可）
  const [anchorDate, setAnchorDate] = useState(''); // 次回の開催日（間隔 ≥ 2 のときだけ保存）
  const [plan, setPlan] = useState<PreviewPlan | null>(null); // サーバー preview-plan の結果
  const [startTime, setStartTime] = useState('21:00');
  const [duration, setDuration] = useState('');
  const [mention, setMention] = useState<'role' | 'members' | 'none'>('role');
  const [requireResponse, setRequireResponse] = useState(true);
  const [deadlineHours, setDeadlineHours] = useState('');
  const [recruitDays, setRecruitDays] = useState('7');
  const [remindStartDays, setRemindStartDays] = useState('3');
  const [remindUndecidedDays, setRemindUndecidedDays] = useState('1');
  // 配信の流れの工程スイッチ（案A・ADR 0026）。OFF でも日数の入力値は保持する（ON に戻すと復帰）。
  // 締切だけは response_deadline_hours の有無（NULL=締切なし）がそのままスイッチ。
  // 募集スイッチ（自動/手動）は不定期専用（定期は常時 ON・flow-settings-spec §3）。
  const [recruitOn, setRecruitOn] = useState(true);
  const [saving, setSaving] = useState(false);
  const [remindUnansweredOn, setRemindUnansweredOn] = useState(true);
  const [remindUndecidedOn, setRemindUndecidedOn] = useState(true);
  // 未回答／未定リマインドの送り先（C02 2026-09-20・2026-09-23 に個別化。カードの中で選ぶ）
  const [remindTarget, setRemindTarget] = useState<'dm' | 'channel'>('dm');
  const [remindUndecidedTarget, setRemindUndecidedTarget] = useState<'dm' | 'channel'>('dm');
  // 📊 状況確認で全員の回答を見せるか（初期値=公開・2026-09-23）
  const [shareAnswers, setShareAnswers] = useState(true);
  const [deadlineOn, setDeadlineOn] = useState(false);
  const [quotaEnabled, setQuotaEnabled] = useState(false);
  const [quotaInterval, setQuotaInterval] = useState('');
  const [quotaText, setQuotaText] = useState(DEFAULT_QUOTA_MESSAGE);
  const [sendHour, setSendHour] = useState('21');
  const [alertChannelId, setAlertChannelId] = useState('');
  const [extraAlertChannelOpt, setExtraAlertChannelOpt] = useState<Channel | null>(null);
  const [active, setActive] = useState(true);
  // 単発（type 'oneoff'）: テンプレートと開催回 1 件を同時に作る（2026-10-02）。開催日はこの画面で入れ、
  // 開催日・開始時刻・回答締切は作成後は変えない（不定期の開催回と同じ・ADR 0032）。送信時刻と投稿の流れはテンプレートに保存し、開催回は NULL＝それに従う
  const [oneOff, setOneOff] = useState(!!oneOffNew);
  const [eventDate, setEventDate] = useState(''); // 'YYYY-MM-DD'（input[type=date] の値）
  const [occLocked, setOccLocked] = useState(false); // 編集時＝開催回は登録済み
  const [formErr, setFormErr] = useState('');
  const [dirty, setDirty] = useState(false);

  // ---- ウィザード状態 ----
  const [step, setStep] = useState<StepKey>(nuuid ? 'confirm' : 'basic');
  const [visited, setVisited] = useState<Set<StepKey>>(() => new Set(nuuid || copyFrom ? ALL_STEPS : ['basic']));
  const [attempted, setAttempted] = useState(false); // 保存を試みた後は未入力を強調表示

  const markDirty = () => {
    if (!dirty) {
      setDirty(true);
      onDirtyChange(true);
    }
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [s, c] = await Promise.all([
          api('/segments?guild_id=' + encodeURIComponent(guild.id)),
          api(`/guilds/${guild.id}/channels`).catch(() => []),
        ]);
        if (!alive) return;
        setSegs(s);
        setChannels(c);
        const source = nuuid ?? copyFrom;
        if (source) {
          const n: NotifDetail = await api('/notifications/' + source);
          if (!alive) return;
          fillForm(n, s, c);
          if (copyFrom) setName(`${n.name || ''}のコピー`);
          // 単発は開始時刻と回答締切を開催日時の側に持つ。編集では読み込んでロックし、複製では開催日だけ空のまま引き継ぐ
          if (n.type === 'oneoff') {
            const occs: { occurrence_date: string; start_time?: string | null; response_deadline_hours?: number | null }[] =
              await api(`/notifications/${source}/occurrences`);
            if (!alive) return;
            const o = occs[0];
            if (o) {
              if (o.start_time) setStartTime(o.start_time);
              setDeadlineOn(o.response_deadline_hours != null);
              setDeadlineHours(o.response_deadline_hours == null ? '' : String(o.response_deadline_hours));
              if (nuuid) {
                setEventDate(o.occurrence_date.replace(/\//g, '-'));
                setOccLocked(true);
              }
            }
          }
        }
      } catch (e) {
        if (nuuid || copyFrom) {
          toast('テンプレートが見つかりません', true);
          setNotFound(true);
        } else {
          toast(e instanceof Error ? e.message : String(e), true);
        }
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nuuid, copyFrom, guild.id]);

  function fillForm(n: NotifDetail, s: Segment[], c: Channel[]) {
    setName(n.name || '');
    setOneOff(n.type === 'oneoff');
    setTitle(n.message_title || '');
    setBody(n.message_body || '');
    if (n.channel_id && !c.some((x) => x.id === n.channel_id)) setExtraChannelOpt({ id: n.channel_id, name: 'ID: ' + n.channel_id });
    setChannelId(n.channel_id || '');
    const seg = s.find((x) => x.id === n.segment_id);
    setSegmentUuid(seg ? seg.uuid : '');
    const model = parseRule(n.rrule);
    if (n.rrule && !model) {
      // 文法外（旧形式・未対応）。黙って既定値に丸めず、設定し直すまで保存できない（P5 対策）
      setRuleUnreadable(true);
      setRule({ ...DEFAULT_RULE_FORM });
    } else {
      const f = ruleFormFromModel(model);
      setRule(f);
    }
    setAnchorDate(n.anchor_date || '');
    setStartTime(n.start_time || '21:00');
    setDuration(n.duration_minutes == null ? '' : String(n.duration_minutes));
    setRecruitDays(String(n.recruit_days_before));
    setRemindStartDays(String(n.remind_start_days));
    setRemindUndecidedDays(String(n.remind_undecided_days));
    setRecruitOn(n.recruit_enabled == null ? true : !!n.recruit_enabled);
    setRemindUnansweredOn(n.remind_unanswered_enabled == null ? true : !!n.remind_unanswered_enabled);
    setRemindUndecidedOn(n.remind_undecided_enabled == null ? true : !!n.remind_undecided_enabled);
    setRemindTarget(n.remind_target === 'channel' ? 'channel' : 'dm');
    setRemindUndecidedTarget(n.remind_undecided_target === 'channel' ? 'channel' : 'dm');
    setShareAnswers(n.share_answers == null ? true : !!n.share_answers);
    setDeadlineOn(n.response_deadline_hours != null);
    setQuotaInterval(n.quota_interval_days == null ? '' : String(n.quota_interval_days));
    setQuotaEnabled(!!n.quota_enabled);
    setQuotaText(n.quota_message || DEFAULT_QUOTA_MESSAGE);
    setMention((n.mention_mode as any) || 'role');
    setRequireResponse(n.requires_response == null ? true : !!n.requires_response);
    // 単発の複製は有効で作る（作成画面に有効／無効の項目が無く、無効のまま何も送らない回ができていた）
    setActive(copyFrom && n.type === 'oneoff' ? true : !!n.active);
    setSendHour(String(n.send_hour == null ? 21 : n.send_hour));
    setDeadlineHours(n.response_deadline_hours == null ? '' : String(n.response_deadline_hours));
    if (n.change_alert_channel_id && !c.some((x) => x.id === n.change_alert_channel_id)) {
      setExtraAlertChannelOpt({ id: n.change_alert_channel_id, name: 'ID: ' + n.change_alert_channel_id });
    }
    setAlertChannelId(n.change_alert_channel_id || '');
  }

  const patchRule = (patch: Partial<RuleForm>) => {
    setRule((r) => ({ ...r, ...patch }));
    markDirty();
  };
  // 不定期＝rrule NULL。新規は irregular prop・編集は読み込んだ行の rrule で決まり、切替 UI が無いため以後固定
  const irregular = rule.freq === 'IRREGULAR';
  // 不定期のテンプレート（開催日時・送信時刻・投稿の流れは開催日時ごと）。単発はこの画面で全部決めるので含めない
  const tmpl = irregular && !oneOff;
  const kind = oneOff ? 'oneoff' : irregular ? 'irregular' : 'regular';
  const nameLabel = oneOff ? '名前' : 'テンプレート名';
  const eventDateSlash = eventDate ? eventDate.replace(/-/g, '/') : '';
  const todaySlash = jstToday();
  // 編集画面は流れの表 → 見出し → ステップ一覧の順にスクロールしても残す（日程調整と同じ・2026-09-23 試作）
  const pageRef = React.useRef<HTMLDialogElement>(null);
  useStickyHeight(pageRef, '.modal-head', '--planning-head-h', [loading, irregular]);
  const model = ruleUnreadable ? null : modelFromRuleForm(rule);
  const rrule = model ? formatRule(model) : null;
  const needsAnchor = !!model && model.interval >= 2;
  const intervalBad =
    !irregular && (!Number.isInteger(rule.interval) || rule.interval < 1 || rule.interval > INTERVAL_MAX[rule.freq as Freq]);

  // サーバープレビュー（cron と同じ評価）: 次の開催日・次回の開催日の候補・anchor の整合。入力が落ち着いてから取得。
  // 間隔 ≥ 2 で次回の開催日が未選択／ルールと不一致なら、候補の先頭に取り直す（曜日変更で旧起点が残らないように）。
  useEffect(() => {
    if (!rrule) {
      setPlan(null);
      return;
    }
    let alive = true;
    const t = window.setTimeout(async () => {
      try {
        const r: PreviewPlan = await api('/notifications/preview-plan', {
          method: 'POST',
          body: JSON.stringify({ rrule, anchor_date: needsAnchor ? anchorDate || null : null, start_time: startTime || '21:00', count: 10 }),
        });
        if (!alive) return;
        setPlan(r);
        if (needsAnchor && r.anchor_candidates?.length && (!anchorDate || r.error)) setAnchorDate(r.anchor_candidates[0]);
      } catch {
        if (alive) setPlan(null);
      }
    }, 250);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rrule, anchorDate, startTime, needsAnchor]);
  const nextDate = oneOff ? eventDateSlash || null : plan?.dates[0] ?? null;
  const anchorCandidates = plan?.anchor_candidates ?? [];
  const anchorOptions = anchorDate && !anchorCandidates.includes(anchorDate) ? [anchorDate, ...anchorCandidates] : anchorCandidates;

  const durationNum = duration.trim() === '' ? null : Number(duration);
  const deadlineNum = deadlineOn && deadlineHours.trim() !== '' ? Number(deadlineHours) : null;
  const announceOnly = !requireResponse;
  // 間隔 ≥ 2 の「次回」はサーバー計算の先頭日（anchor が過去でも実際の次回を出す）。未取得の間は anchor
  // 単発出欠確認のテンプレートは開始時刻・開催時間を持たない（開催日時ごとに「＋ 開催日時を追加」で入れる・2026-09-23）。
  // 保存値は触らずに送り返し（既存行の値は残る・新規はサーバー既定）、表示と入力欄からだけ外す
  const shownStart = tmpl ? '' : startTime;
  const shownDuration = tmpl ? null : durationNum;
  const scheduleText = ruleUnreadable
    ? '⚠️ 繰り返し設定を読み取れません（設定し直してください）'
    : oneOff
      ? eventDateSlash ? occurrenceLabel(eventDateSlash, startTime, durationNum) : '開催日 未入力'
      : irregular
      ? '不定期'
      : describeRule(model, startTime, durationNum, needsAnchor ? nextDate ?? (anchorDate || null) : null);
  // 定期は「募集/告知を投稿」常時 ON（手動投稿は不定期専用・flow-settings-spec §3）。不定期だけスイッチを出す
  const effRecruitOn = irregular ? recruitOn : true;
  // 工程オフは null（文から省く／判定から外す）・未入力は NaN（「—」・判定しない）
  const flowInput = {
    requireResponse,
    recruitDays: effRecruitOn ? (numOrNull(recruitDays) ?? NaN) : null,
    remindStartDays: remindUnansweredOn ? (numOrNull(remindStartDays) ?? NaN) : null,
    remindUndecidedDays: remindUndecidedOn ? (numOrNull(remindUndecidedDays) ?? NaN) : null,
    // 不定期の締切は開催回ごと（ADR 0032）。単発は開催回の締切をここで決める（手動募集なら 📣 の投稿時に選ぶので無し）
    deadlineHours: tmpl || (irregular && !effRecruitOn) ? null : deadlineNum,
    sendHour: Number(sendHour),
  };
  const timelineText = notifPreviewSummary({ ...flowInput, scheduleText });
  // 順序ルール E1〜E6（判定は src/lib/flowRules に一本化）。違反は種別を問わず保存不可（flow-settings-spec §4。
  // 不定期は④を雛形に持たないため E3/E5/E6 は出ない。募集が手動なら①が無いので E1/E2 も出ない）
  // 単発は開始時刻を開催日時ごとに持つので、当日×開始時刻の E4 はテンプレートでは判定しない（サーバーの validateFlow と同じ）
  // 単発は投稿の流れを開催日時ごとに持つ（テンプレートに入力欄なし）ので、テンプレートでは判定しない
  const flowIssues = tmpl ? [] : flowWarnings({ ...flowInput, startTime: startTime || '21:00' });
  const warnOf = (step: 'recruit' | 'remind' | 'undecided' | 'deadline') => flowIssues.find((w) => w.step === step) ?? null;
  const previewParts = buildRecruitPreviewParts({
    title,
    body,
    nextDate,
    startTime: shownStart,
    duration: shownDuration,
    // 手動募集の締切は 📣 の投稿時に選ぶ（ここでは付かない）
    deadlineHours: effRecruitOn ? deadlineNum : null,
    mention,
    requireResponse,
  });
  const mentionSeg = segs.find((s) => s.uuid === segmentUuid);
  const quotaError = quotaMessageError(quotaText);
  const quotaPreviewText = quotaMessage(
    { quota_interval_days: numOrNull(quotaInterval) ?? 30, quota_message: quotaText },
    { user_id: 'sample', user_name: 'サンプル', display_name: '田中太郎', lastDateStr: '2026/08/01', daysSinceLast: (Number(quotaInterval) || 30) + 7 },
    guild.name || guild.id,
  );
  const mentionWarn = mention === 'members' && !!mentionSeg && mentionSeg.mention_role_id === '@everyone';
  const chLabel = (id: string) => {
    const all = extraChannelOpt ? [extraChannelOpt, ...channels] : channels;
    const c = all.find((x) => x.id === id);
    return c ? '#' + c.name : id;
  };

  // ---- ④配信設定: 実時系列タイムライン ----
  // 入力値から各送信の「開催何分前か」を出し、実際に送られる順に並べる。
  // 次回開催日（サーバー preview-plan の先頭）があれば具体日を例示（未計算の間は相対表示）。
  const WD_JP = ['日', '月', '火', '水', '木', '金', '土'];
  const shNum = Number(sendHour);
  const [evH, evM] = (startTime || '21:00').split(':').map((x) => Number(x) || 0);
  const exampleEventDate = nextDate;
  // 密度警告（Q9）: 募集窓（今日〜募集 N 日前・両端含む）に入るルール回が 3 件以上なら常に複数回が並行する
  const rDaysForDense = effRecruitOn ? numOrNull(recruitDays) : null;
  const denseCount =
    plan && rDaysForDense != null && isFinite(rDaysForDense)
      ? plan.dates.filter((d) => {
          const k = daysFromToday(d);
          return k >= 0 && k <= rDaysForDense;
        }).length
      : 0;
  const denseWarn =
    denseCount >= 3
      ? `この設定では常に約 ${denseCount} 回分の募集／リマインドが並行します。募集日数を短く（例: 1 日前）すると 1 回ずつになります。`
      : null;
  const fmtDt = (d: Date) =>
    `${d.getMonth() + 1}/${d.getDate()}(${WD_JP[d.getDay()]}) ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const whenDay = (days: number | null): string => {
    if (days == null || !isFinite(days)) return '—';
    if (exampleEventDate) {
      const [y, mo, dd] = exampleEventDate.split('/').map(Number);
      return fmtDt(new Date(y, mo - 1, dd - days, shNum, 0));
    }
    return `${days}日前 ${String(shNum).padStart(2, '0')}:00`;
  };
  const whenDeadline = (hours: number | null): string => {
    if (hours == null || !isFinite(hours)) return '—';
    if (exampleEventDate) {
      const [y, mo, dd] = exampleEventDate.split('/').map(Number);
      const d = new Date(y, mo - 1, dd, evH, evM);
      d.setMinutes(d.getMinutes() - hours * 60);
      return fmtDt(d);
    }
    return `開始${hours}時間前`;
  };
  // ソートキー = 開催開始からさかのぼった分数（日単位送信は送信時刻を加味）。未入力は既定値の位置に置く
  const minBeforeDay = (days: number | null, fallbackDays: number) =>
    (days != null && isFinite(days) ? days : fallbackDays) * 1440 + (evH * 60 + evM) - shNum * 60;
  const rDaysN = numOrNull(recruitDays);
  const rsDaysN = numOrNull(remindStartDays);
  const ruDaysN = numOrNull(remindUndecidedDays);
  const eventWhen = exampleEventDate
    ? (() => {
        const [y, mo, dd] = exampleEventDate.split('/').map(Number);
        return fmtDt(new Date(y, mo - 1, dd, evH, evM));
      })()
    : null;
  const flowTimeline = (() => {
    const num = (v: string, set: (s: string) => void, placeholder?: string) => (
      <TextField type="number" min={0} placeholder={placeholder} value={v} onChange={(e) => set(e.target.value)} />
    );
    // 送り先はカードの中で選ぶ（日程調整の「未回答者へ催促」と同じ形・2026-09-23）。チャンネルなら該当メンバーを個別メンションして投稿する
    const targetSelect = (label: string, v: 'dm' | 'channel', set: (t: 'dm' | 'channel') => void) => (
      <select aria-label={label} value={v} onChange={(e) => { set(e.target.value as 'dm' | 'channel'); markDirty(); }}>
        <option value="dm">{TARGET_LABEL.dm}</option>
        <option value="channel">{TARGET_LABEL.channel}（該当メンバーを個別メンション）</option>
      </select>
    );
    type FlowNode = {
      key: string;
      sort: number;
      when: string;
      icon: string;
      title: string;
      chip: 'ch' | 'dm' | null;
      /** 整合性警告（flowWarnings・見出し＋詳細）。オフの工程には出ない */
      warn: { head: string; detail: string } | null;
      body: React.ReactNode;
      /** 工程スイッチ（案A・ADR 0026）。on=false なら body の代わりに offText を出し、点を白抜きにする。開催ノードは無し */
      on: boolean;
      offText?: string;
      onToggle?: (on: boolean) => void;
    };
    // 「やる／やらない」はスイッチ、「いつ」は数字。OFF の工程は位置（並び）は数字のまま・薄く残す（行が飛び回らない）
    const recruitWord = announceOnly ? '告知' : '募集';
    const nodes: FlowNode[] = [
      {
        key: 'recruit',
        sort: minBeforeDay(rDaysN, 7),
        when: effRecruitOn ? whenDay(rDaysN) : '手動',
        icon: '📣',
        title: `${recruitWord}を投稿`,
        chip: 'ch' as const,
        warn: warnOf('recruit'),
        on: effRecruitOn,
        // 単発で締切を登録済みなら募集の自動/手動は変えない（締切は自動募集が前提・ADR 0032）
        onToggle: irregular && !(occLocked && deadlineOn) ? setRecruitOn : undefined,
        offText: `自動では投稿しません。「${SCHEDULE_LABELS[kind]}」の「📣 今すぐ${recruitWord}」で手動投稿します。`,
        body: (
          <div className="nf2-tl-inline">
            <span>開催の</span>
            {num(recruitDays, setRecruitDays)}
            <span>日前に投稿</span>
            {rDaysN === 0 && <span className="muted">＝ 当日の {String(shNum).padStart(2, '0')}:00 に投稿</span>}
          </div>
        ),
      },
      // 告知（回答不要）は②③④を持たない。不定期は②③を持ち、④（締切）は雛形ではなく開催回ごと（ADR 0032）
      ...(announceOnly
        ? []
        : ([
            {
              key: 'remind',
              sort: minBeforeDay(rsDaysN, 3),
              when: remindUnansweredOn ? whenDay(rsDaysN) : '送らない',
              icon: '✉️',
              title: '未回答者へリマインド',
              chip: remindTarget === 'channel' ? 'ch' : 'dm',
              warn: warnOf('remind'),
              on: remindUnansweredOn,
              onToggle: setRemindUnansweredOn,
              offText: '送りません。',
              body: (
                <div className="nf2-tl-inline">
                  <span>開催の</span>
                  {num(remindStartDays, setRemindStartDays)}
                  <span>日前から{deadlineOn && effRecruitOn ? '締切まで' : ''}毎日、未回答のメンバーへ</span>
                  {targetSelect('未回答リマインドの送り先', remindTarget, setRemindTarget)}
                  {rsDaysN === 0 && <span className="muted">＝ 当日のみ</span>}
                </div>
              ),
            },
            {
              key: 'undecided',
              sort: minBeforeDay(ruDaysN, 1),
              when: remindUndecidedOn ? whenDay(ruDaysN) : '送らない',
              icon: '✉️',
              title: '未定者へリマインド',
              chip: remindUndecidedTarget === 'channel' ? 'ch' : 'dm',
              warn: warnOf('undecided'),
              on: remindUndecidedOn,
              onToggle: setRemindUndecidedOn,
              offText: '送りません。',
              body: (
                <div className="nf2-tl-inline">
                  <span>開催の</span>
                  {num(remindUndecidedDays, setRemindUndecidedDays)}
                  <span>日前から{deadlineOn && effRecruitOn ? '締切まで' : ''}毎日、「未定」回答のメンバーへ</span>
                  {targetSelect('未定リマインドの送り先', remindUndecidedTarget, setRemindUndecidedTarget)}
                  {ruDaysN === 0 && <span className="muted">＝ 当日</span>}
                </div>
              ),
            },
            ...(tmpl
              ? []
              : irregular && !effRecruitOn
              ? [
                  // 単発×手動募集: 締切は 📣 今すぐ募集で投稿するときに選ぶ（ADR 0032）
                  {
                    key: 'deadline', sort: 0, when: '投稿時', icon: '⏰', title: '回答締切', chip: 'ch', warn: null, on: false,
                    body: null,
                    offText: occLocked && deadlineOn
                      ? `開始の ${deadlineHours} 時間前（登録後は変更できません）。`
                      : '「📣 今すぐ募集」で投稿するときに選びます（募集の自動投稿がオフのため）。',
                  },
                ]
              : [
                  {
              key: 'deadline',
              sort: deadlineNum != null && isFinite(deadlineNum) ? deadlineNum * 60 : 0,
              when: deadlineOn ? whenDeadline(deadlineNum) : '締切なし',
              icon: '⏰',
              title: '回答締切',
              chip: 'ch',
              warn: warnOf('deadline'),
              on: deadlineOn,
              // 単発の締切は開催回に保存し、登録後は変えない（不定期の開催回と同じ・ADR 0032）
              onToggle: occLocked ? undefined : setDeadlineOn,
              offText: occLocked ? '締め切りません（登録後は変更できません）。' : '締め切りません（開催までいつでも回答できます）。',
              body: (
                <div className="nf2-tl-inline">
                  <span>開始の</span>
                  {occLocked ? <b>{deadlineHours}</b> : num(deadlineHours, setDeadlineHours)}
                  <span>時間前</span>
                  <span className="muted">（締切時刻に「回答を締め切りました」をチャンネルへ投稿）</span>
                </div>
              ),
                  },
                ]),
          ] as FlowNode[])),
    ].sort((a, b) => b.sort - a.sort);
    nodes.push({
      key: 'event',
      sort: -1,
      when: eventWhen ?? (tmpl || (oneOff && !eventDate) ? '開催日' : `開催日 ${startTime}`),
      icon: '🎉',
      title: '開催',
      chip: null,
      warn: null,
      on: true,
      body: <div className="nf2-tl-eventdesc">{scheduleText}</div>,
    });
    return nodes;
  })();

  // ---- ステップごとの必須未入力（レール表示・保存前チェックで共用） ----
  const missing: Record<StepKey, string[]> = {
    basic: [!name.trim() && nameLabel, !segmentUuid && '対象区分', !channelId && '投稿チャンネル'].filter(
      (x): x is string => !!x,
    ),
    when: oneOff
      ? [
          !eventDate && '日付',
          !occLocked && eventDateSlash && eventDateSlash < todaySlash && '日付（過去の日付は不可）',
          !startTime.trim() && '開始時刻',
        ].filter((x): x is string => !!x)
      : ruleUnreadable
      ? ['繰り返し（設定し直してください）']
      : [
          rule.freq === 'WEEKLY' && !rule.weekdays.length && '曜日',
          rule.freq === 'MONTHLY' && rule.monthlyMode === 'byday' && !dedupeMonthlyRules(rule.monthlyRules).length && '第N曜',
          rule.freq === 'MONTHLY' && rule.monthlyMode === 'bymonthday' && !rule.monthDays.length && '日付',
          intervalBad && '間隔',
          needsAnchor && !anchorDate && '次回の開催日',
          // 不定期のテンプレートは開始時刻の欄が無い（開催日時ごとに指定）
          !tmpl && !startTime.trim() && '開始時刻',
        ].filter((x): x is string => !!x),
    message: !title.trim() ? ['見出し'] : [],
    flow: [
      ...(!tmpl && !(irregular && !effRecruitOn) && deadlineOn && deadlineNum == null ? ['回答締切の時間'] : []),
      ...(quotaError && !oneOff ? ['ノルマのメッセージ'] : []),
      ...flowIssues.map((w) => w.head),
    ],
    confirm: [],
  };

  // 未入力エラーは解消され次第フッターから消す（API エラーは保持）
  const allOk = ALL_STEPS.every((k) => missing[k].length === 0);
  useEffect(() => {
    if (allOk && formErr.startsWith('保存できません')) setFormErr('');
  }, [allOk, formErr]);

  const goto = (next: StepKey) => {
    // 保存中はステップを移らない（レール・確認の「編集」・前へ のどこから直しても、送信成功後に黙って捨てられていた）
    if (saving) return;
    setVisited((v) => new Set(v).add(step).add(next));
    setStep(next);
  };
  const stepIdx = ALL_STEPS.indexOf(step);

  const attemptClose = async () => {
    if (dirty) {
      const ok = await confirmDialog('未保存の変更があります。破棄して閉じますか？', { okLabel: '破棄する', danger: true });
      if (!ok) return;
    }
    onDirtyChange(false);
    onClose();
  };

  const save = async (btn: HTMLElement | null) => {
    const firstBad = ALL_STEPS.find((k) => missing[k].length > 0);
    if (firstBad) {
      setAttempted(true);
      setFormErr(`保存できません: ${missing[firstBad].join('・')}`);
      goto(firstBad);
      return;
    }
    setFormErr('');
    const payload = {
      guild_id: guild.id,
      name: name.trim(),
      channel_id: channelId.trim(),
      segment_uuid: segmentUuid,
      type: oneOff ? 'oneoff' : 'recurring',
      rrule, // 正規形の RRULE。不定期・単発は null
      anchor_date: needsAnchor ? anchorDate || null : null,
      start_time: startTime.trim() || '21:00',
      duration_minutes: durationNum,
      message_title: title.trim(),
      message_body: body.trim() || null,
      recruit_days_before: numOrNull(recruitDays) ?? 7,
      remind_start_days: numOrNull(remindStartDays) ?? 3,
      remind_undecided_days: numOrNull(remindUndecidedDays) ?? 1,
      recruit_enabled: effRecruitOn ? 1 : 0,
      remind_unanswered_enabled: remindUnansweredOn ? 1 : 0,
      remind_target: remindTarget,
      remind_undecided_target: remindUndecidedTarget,
      share_answers: shareAnswers ? 1 : 0,
      remind_undecided_enabled: remindUndecidedOn ? 1 : 0,
      quota_enabled: quotaEnabled && !oneOff ? 1 : 0,
      quota_interval_days: numOrNull(quotaInterval),
      quota_message: quotaText.trim() === DEFAULT_QUOTA_MESSAGE ? null : quotaText.trim() || null,
      assignment_enabled: 1,
      grouping_enabled: 1,
      mention_mode: mention,
      requires_response: requireResponse ? 1 : 0,
      send_hour: Number(sendHour),
      response_deadline_hours: irregular ? null : deadlineNum,
      change_alert_channel_id: alertChannelId.trim() || null,
      active: active ? 1 : 0,
    };
    // 送信中は「← 前へ」を止める（戻って直した入力が、送信成功後に黙って捨てられていた）
    setSaving(true);
    await withBusy(btn, async () => {
      try {
        // 不定期は保存しただけでは何も起きない（開催回が無い）ため、次の操作へ誘導する
        let msg = tmpl ? '作成しました。開催日時は「不定期出欠確認」の「＋ 開催日時を追加」で登録してください' : '作成しました';
        if (nuuid) {
          // ルール変更時はサーバーが未投稿のルール回を掃除して作り直す（投稿済みは残す）。件数を案内する
          const r = (await api('/notifications/' + nuuid, { method: 'PUT', body: JSON.stringify(payload) })) as {
            pruned?: number;
            kept_posted?: number;
          } | null;
          const kept = r?.kept_posted ?? 0;
          const pruned = r?.pruned ?? 0;
          msg =
            kept > 0
              ? `更新しました。投稿済みの ${kept} 件はそのまま残しています（不要なら出欠一覧で中止）`
              : pruned > 0
                ? `更新しました（未投稿の予定 ${pruned} 件を新しい繰り返しで作り直します）`
                : '更新しました';
        } else {
          const created = (await api('/notifications', { method: 'POST', body: JSON.stringify(payload) })) as { uuid: string };
          if (oneOff) {
            // 単発: 開催回 1 件を続けて作る。送信時刻・投稿の流れ・開催時間は NULL＝テンプレートの値に従う（編集で直せる）。
            // 開催回を作れなかったら（締切ガード等）テンプレートも消して、何も作らなかった状態に戻す
            try {
              await api(`/notifications/${created.uuid}/occurrences`, {
                method: 'POST',
                body: JSON.stringify({
                  date: eventDateSlash,
                  start_time: startTime.trim(),
                  status: 'scheduled',
                  response_deadline_hours: !announceOnly && effRecruitOn ? deadlineNum : null,
                }),
              });
            } catch (e) {
              const reason = e instanceof Error ? e.message : String(e);
              // 後始末の DELETE は 1 回だけ再試行する。それでも消せなければ黙らずに伝える（P2-18）。
              // 開催回の無い単発は一覧に出ず、何も送信されない（不定期と同じく開催回が無ければ cron は動かない）
              const del = () => api('/notifications/' + created.uuid, { method: 'DELETE' }).then(() => true, () => false);
              if (!(await del()) && !(await del())) {
                throw new Error(`開催日時を登録できませんでした（${reason}）。作成途中のデータを削除できませんでしたが、開催日時が無いため一覧には表示されず、何も送信されません。原因を確認して、もう一度「この内容で作成する」を押してください。`);
              }
              throw e;
            }
          }
        }
        onDirtyChange(false);
        setDirty(false);
        onSaved();
        toast(msg);
      } catch (e) {
        setFormErr(e instanceof Error ? e.message : String(e));
      }
    });
    setSaving(false);
  };

  if (notFound) return null;
  if (loading) return <p className="muted">読み込み中…</p>;

  const segOptions = segs.map((s) => (
    <option key={s.uuid} value={s.uuid}>
      {s.name}
    </option>
  ));
  const channelOptions = (extraChannelOpt ? [extraChannelOpt, ...pickable(channels, channelId)] : pickable(channels, channelId)).map((c) => (
    <option key={c.id} value={c.id}>
      #{c.name}
    </option>
  ));
  const alertChannelOptions = (extraAlertChannelOpt ? [extraAlertChannelOpt, ...pickable(channels, alertChannelId)] : pickable(channels, alertChannelId)).map((c) => (
    <option key={c.id} value={c.id}>
      #{c.name}
    </option>
  ));

  // 保存試行後 or 訪問済みステップにのみ「未入力」を出す（初見のステップを赤くしない）
  const showBad = (k: StepKey) => missing[k].length > 0 && (attempted || (visited.has(k) && k !== step));

  const fieldErr = (cond: boolean, msg: string) =>
    cond && attempted ? (
      <p className="nf2-field-err" role="alert">
        {msg}
      </p>
    ) : null;

  // 保存は確認ステップの 1 か所だけ（モーダル殻のフッター「キャンセル／保存」は 2026-08-23 に撤去。閉じるはヘッダーの「← 戻る」）。
  // 新規: 前へ／次へ で直線に進み、最後に「この内容で作成する」。
  // 編集: 確認がハブ（開くと確認から始まる）。各ステップからは「← 確認に戻る」で戻って「保存する」。
  // 未入力／API エラーはナビ直下に出す（未入力時は該当ステップへ飛ぶので、どのステップでも同じ位置に見える）。
  // 先頭ステップでは前が無い（STEPS[-1]）ので評価しない
  const prevStep = STEPS[stepIdx - 1];
  const prevBtn = prevStep ? (
    <button type="button" className="btn ghost" disabled={saving} onClick={() => goto(prevStep.key)}>
      ← {prevStep.label}
    </button>
  ) : (
    <span />
  );
  const stepNav = (
    <>
      <div className="nf2-nav">
        {step === 'confirm' ? (
          <>
            {nuuid ? <span /> : prevBtn}
            <button type="button" className="btn" onClick={(e) => save(e.currentTarget)}>
              {nuuid ? '保存する' : 'この内容で作成する'}
            </button>
          </>
        ) : nuuid ? (
          <>
            <span />
            <button type="button" className="btn" onClick={() => goto('confirm')}>
              ← 確認に戻る
            </button>
          </>
        ) : (
          <>
            {prevBtn}
            <button type="button" className="btn" onClick={() => goto(ALL_STEPS[stepIdx + 1])}>
              次へ: {STEPS[stepIdx + 1].label} →
            </button>
          </>
        )}
      </div>
      {formErr && (
        <p className="nf2-field-err" role="alert" style={{ marginTop: 10 }}>
          {formErr}
        </p>
      )}
    </>
  );

  const discordPreview = (
    <div className="nf2-discord" aria-label={announceOnly ? '告知メッセージのプレビュー' : '募集メッセージのプレビュー'}>
      <div className="nf2-dc-msg">
        <div className="nf2-dc-ava">🤖</div>
        <div className="nf2-dc-main">
          <div className="nf2-dc-head">
            <b>EventBot</b>
            <span className="nf2-dc-app">APP</span>
            <span className="nf2-dc-time">送信日 {String(Number(sendHour)).padStart(2, '0')}:00</span>
          </div>
          {mention !== 'none' && (
            <div className="nf2-dc-mentions">
              {mention === 'members' ? (
                <>
                  {/* バイネーム＝対象メンバー1人ずつの個別メンション。サンプル名で雰囲気を再現 */}
                  {['田中太郎', '鈴木花子', '佐藤次郎'].map((n) => (
                    <span key={n} className="nf2-dc-mention">@{n}</span>
                  ))}
                  <span className="nf2-dc-mention-note">…対象メンバー全員（名前はサンプル）</span>
                </>
              ) : (
                <span className="nf2-dc-mention">
                  {mentionSeg ? (mentionSeg.mention_role_id === '@everyone' ? '@everyone' : '@' + mentionSeg.name) : '@ロール'}
                </span>
              )}
            </div>
          )}
          <div className="nf2-dc-title">{title || '（見出しを入力）'}</div>
          {body && <div className="nf2-dc-body">{body}</div>}
          <div className="nf2-dc-line">
            日時: <b>{previewParts.dateText}</b>
          </div>
          {previewParts.deadline && (
            <div className="nf2-dc-line">
              回答締切: <b>{previewParts.deadline}</b>
            </div>
          )}
          {requireResponse && (
            <div className="nf2-dc-btns">
              <span className="ok">参加</span>
              <span className="no">不参加</span>
              <span>未定</span>
              <span>状況確認</span>
            </div>
          )}
        </div>
      </div>
      <p className="preview-note">※ @メンションは投稿時に展開されます。日付は次回の開催日（サーバー計算）の例です。</p>
    </div>
  );

  const summaryRow = (label: string, value: React.ReactNode) => (
    <div className="nf2-sum-row">
      <span className="nf2-sum-label">{label}</span>
      <span className="nf2-sum-value">{value}</span>
    </div>
  );

  const summaryCard = (key: StepKey, children: React.ReactNode) => {
    const meta = STEPS.find((s) => s.key === key)!;
    return (
      <section className={'nf2-sum-card' + (missing[key].length ? ' bad' : '')}>
        <header>
          <span>
            {meta.icon} {meta.label}
          </span>
          <button type="button" className="btn xs ghost" disabled={saving} onClick={() => goto(key)}>
            編集
          </button>
        </header>
        {children}
      </section>
    );
  };

  return (
    <dialog ref={pageRef} className="modal-lg as-page flow-page" open aria-labelledby="nFormTitle">
      <ScheduleFlow kind={kind} />
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
              {oneOff ? SCHEDULE_LABELS.oneoff : 'テンプレート'}
            </a>{' '}
            <span>›</span> <span>{nuuid ? '編集' : copyFrom ? '複製' : '新規'}</span>
          </div>
          <h3 id="nFormTitle">
            {oneOff
              ? `${SCHEDULE_LABELS.oneoff}を${nuuid ? '編集' : copyFrom ? '複製' : '作成'}`
              : `${nuuid ? 'テンプレートを編集' : copyFrom ? 'テンプレートを複製' : '新規テンプレート'}（${SCHEDULE_LABELS[kind]}）`}
          </h3>
        </div>
        <button type="button" className="page-back" aria-label="戻る" onClick={attemptClose}>
          ← 戻る
        </button>
      </div>

      <div className="modal-body" onInput={markDirty} onChange={markDirty}>
        <div className="nf2-layout">
          <nav className="nf2-steps" aria-label="入力ステップ">
            {STEPS.map((s, i) => {
              const done = visited.has(s.key) && missing[s.key].length === 0 && s.key !== 'confirm';
              return (
                <button
                  type="button"
                  key={s.key}
                  className={'nf2-step-item' + (step === s.key ? ' active' : '') + (showBad(s.key) ? ' bad' : '')}
                  aria-current={step === s.key ? 'step' : undefined}
                  disabled={saving}
                  onClick={() => goto(s.key)}
                >
                  <span className={'nf2-step-no' + (done ? ' done' : '')}>{done ? '✓' : i + 1}</span>
                  <span className="nf2-step-label">
                    {s.icon} {s.label}
                  </span>
                  {showBad(s.key) && <span className="nf2-step-alert">要修正</span>}
                </button>
              );
            })}
          </nav>

          <div className="nf2-main">
            {step === 'basic' && (
              <>
                {/* Discord-side prerequisites at the top of step 1; the same text for 定期 and 単発 (wording confirmed by the user, 2026-09-20). */}
                <div className="nf2-prereq" role="note" aria-label="Discord 側で用意しておくもの">
                  <div className="nf2-prereq-title">
                    Discord 側で用意しておくもの<span className="muted">初回設定の Bot 招待と Server Members Intent は済んでいる前提</span>
                  </div>
                  <ul>
                    <li><b>対象メンバーのロール</b>: 出欠を聞く人に付けるロール（Everyone でも可）。「メンバー管理」で区分として登録します。</li>
                    <li>
                      <b>投稿チャンネル</b>: 募集・告知を投稿するテキストチャンネル。Bot がそのチャンネルを見て投稿できること。
                      <Tip text="非公開チャンネルの場合は、チャンネルの権限で Bot のロールに「チャンネルを見る」「メッセージを送信」を許可してください。" />
                    </li>
                    <li><b>メンバーの DM 設定</b>: 未回答・未定リマインド（送り先が DM のとき）とノルマは本人への DM です。受け取る側が「サーバーメンバーからのダイレクトメッセージを許可」にしていないと届きません。</li>
                    <li>
                      <b>ロールでメンションする場合</b>: Bot に「@everyone・全ロールへのメンション」権限があるか、ロールの設定で @mention を許可しておくこと。
                      <Tip text="初回設定の招待リンクで招待した Bot には付与済みです。投稿や DM に失敗すると、Bot設定で指定したチャンネルにお知らせが投稿されます。" />
                    </li>
                    <li><b>任意</b>: 締切後の変更通知を出すチャンネル。送信失敗を知らせるチャンネルは「Bot設定」で指定します。</li>
                  </ul>
                </div>
                <p className="nf2-lead">{oneOff ? 'この出欠確認' : 'このテンプレート'}の名前と、誰に・どこに投稿するかを決めます。</p>
                <label>
                  {nameLabel} <span className="req">✱</span> <span className="muted">（管理用の名前・投稿には表示されません）</span>
                </label>
                <TextField placeholder="例: 土曜定例・キャスト出欠" value={name} onChange={(e) => setName(e.target.value)} />
                {fieldErr(!name.trim(), `${nameLabel}を入力してください`)}
                <label>
                  対象区分 <span className="req">✱</span> <span className="muted">（出欠を聞くメンバーのグループ）</span>
                </label>
                <Select value={segmentUuid} onChange={(e) => setSegmentUuid(e.target.value)}>
                  <option value="" />
                  {segOptions}
                </Select>
                {fieldErr(!segmentUuid, '対象区分を選択してください')}
                {!segs.length && <p className="muted">先に<a href={`#g/${guild.id}/segments`}>メンバー管理</a>でメンバー区分を作成してください。</p>}
                <label>
                  投稿チャンネル <span className="req">✱</span> <span className="muted">（募集・告知を投稿する場所）</span>
                </label>
                <Select value={channelId} onChange={(e) => setChannelId(e.target.value)}>
                  <option value="" />
                  {channelOptions}
                </Select>
                {fieldErr(!channelId, '投稿チャンネルを選択してください')}
                {stepNav}
              </>
            )}

            {step === 'when' && (
              <>
                <p className="nf2-lead">
                  {oneOff
                    ? occLocked
                      ? '開催日と開始時刻は作成後は変更できません（変える場合は中止して作り直すか、「⧉ 複製」から作ります）。開催時間は変更できます。'
                      : 'いつ開催するかを決めます。募集やリマインドの日程はこの日から逆算します。'
                    : irregular
                    ? '不定期のテンプレートは開催日時を持ちません。開催日時ごとに日付と開始時刻を登録します。'
                    : 'いつ開催するかを決めます。開催日はここから自動で計算され、募集やリマインドの日程の基準になります。'}
                </p>
                {ruleUnreadable && (
                  <p className="nf2-field-err" role="alert">
                    この繰り返し設定は読み取れません（旧形式または未対応の形式）。下から設定し直してください。
                  </p>
                )}
                {!irregular && <RecurrenceFields
                  rule={rule}
                  unreadable={ruleUnreadable}
                  showErrors={attempted}
                  onChange={(patch) => {
                    if (patch.freq) setRuleUnreadable(false);
                    patchRule(patch);
                  }}
                />}
                {oneOff && (
                  <div>
                    <label>
                      日付 <span className="req">✱</span>
                    </label>
                    <TextField type="date" value={eventDate} min={occLocked ? undefined : todaySlash.replace(/\//g, '-')} disabled={occLocked}
                      onChange={(e) => setEventDate(e.target.value)} />
                    {fieldErr(!eventDate, '日付を入力してください')}
                  </div>
                )}
                {tmpl && (
                  <p className="muted" style={{ fontSize: 13, margin: '2px 0 10px' }}>
                    保存後に「不定期出欠確認」の「＋ 開催日時を追加」で日付と開始時刻を登録します（1 回だけでも可）。
                    募集/告知は登録した開催日時に合わせて、投稿設定どおり自動で投稿されます（手動投稿にもできます）。
                  </p>
                )}

                {needsAnchor && (
                  <div>
                    <label>
                      次にこのテンプレートで開催する日 <span className="muted">（間隔の起点）</span>
                    </label>
                    <Select
                      value={anchorDate}
                      onChange={(e) => {
                        setAnchorDate(e.target.value);
                        markDirty();
                      }}
                    >
                      {!anchorOptions.length && <option value="">（計算中…）</option>}
                      {anchorOptions.map((d) => (
                        <option key={d} value={d}>
                          {shortDateWithWeekday(d)}
                          {!anchorCandidates.includes(d) ? '（現在の設定）' : ''}
                        </option>
                      ))}
                    </Select>
                    {rule.freq === 'WEEKLY' && rule.weekdays.length > 1 && (
                      <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                        この日より前の、同じ週の曜日は開催に含まれません。
                      </p>
                    )}
                    {fieldErr(!anchorDate, '次回の開催日を選んでください')}
                  </div>
                )}

                {!tmpl && <div className="row">
                  <div>
                    <label>
                      開始時刻 <span className="req">✱</span>
                    </label>
                    <TextField type="time" value={startTime} disabled={occLocked} onChange={(e) => setStartTime(e.target.value)} />
                  </div>
                  <div>
                    <label>
                      開催時間（分）<span className="muted">（任意）</span>
                    </label>
                    <TextField type="number" min={0} placeholder="例: 120（2時間）" value={duration} onChange={(e) => setDuration(e.target.value)} />
                  </div>
                </div>}

                <div className="nf2-live">
                  🗓️ <b>{scheduleText}</b>
                  {tmpl && <div className="nf2-live-dates">開催日時は保存後に「不定期出欠確認」で追加</div>}
                  {plan && plan.dates.length > 0 && (
                    <div className="nf2-live-dates">
                      次の開催日: {plan.dates.slice(0, 6).map((d) => shortDateWithWeekday(d)).join('　')}
                      {plan.dates.length > 6 ? '　…' : ''}
                    </div>
                  )}
                  {plan?.error && <div className="nf2-field-err">{plan.error}</div>}
                </div>
                {stepNav}
              </>
            )}

            {step === 'message' && (
              <>
                <p className="nf2-lead">チャンネルに投稿されるメッセージを作ります。下のプレビューに即時反映されます。</p>
                {/* 項目順はプレビューの表示順（メンション→見出し→本文）に合わせる */}
                <label>メンション方法 <span className="muted">（投稿の冒頭で呼びかける相手）</span></label>
                <Select value={mention} onChange={(e) => setMention(e.target.value as any)}>
                  <option value="role">ロール（区分のロール / @everyone）</option>
                  <option value="members">バイネーム（メンバーを個別に呼ぶ）</option>
                  <option value="none">なし</option>
                </Select>
                {mentionWarn && (
                  <p className="muted" style={{ fontSize: 12, color: 'var(--warn)', marginTop: 6 }}>
                    ⚠️ @everyone 区分でバイネームは全員への個別メンションになり、人数が多いと「ほかN名」で省略されます。
                  </p>
                )}
                <label>
                  見出し <span className="req">✱</span> <span className="muted">（投稿の1行目・太字で表示）</span>
                </label>
                <TextField
                  maxLength={100}
                  placeholder="例: 第1・3・5日曜キャスト 開催のお知らせ"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
                {fieldErr(!title.trim(), '見出しを入力してください')}
                <label>
                  本文 <span className="muted">（任意・複数行可。日時と回答ボタンは自動で付きます）</span>
                </label>
                <Textarea rows={3} maxLength={1500} placeholder="補足メッセージ（任意）" value={body} onChange={(e) => setBody(e.target.value)} />
                {/* 回答ボタンの有無＝メッセージの見た目に直結するため、プレビュー直前に置く */}
                <div className="setting-row">
                  <div className="setting-row-main">
                    <div className="setting-row-title">出欠確認（参加/不参加/未定の回答を集める）</div>
                    <div className="setting-row-desc">オフ＝出欠をとらず、開催告知の投稿だけを行います。リマインド・締切・ノルマは無効になります。</div>
                  </div>
                  <div className="setting-row-control">
                    <Switch
                      aria-label="出欠確認（参加/不参加/未定の回答を集める）"
                      checked={requireResponse}
                      onChange={(e) => setRequireResponse(e.target.checked)}
                    />
                  </div>
                </div>
                {requireResponse && (
                  <div className="setting-row">
                    <div className="setting-row-main">
                      <div className="setting-row-title">回答者に他の回答者の回答を見せる</div>
                      <div className="setting-row-desc">
                        {shareAnswers ? '📊 状況確認で、全員の名前と回答を表示します。' : '📊 状況確認では、本人の回答だけを表示します。'}
                      </div>
                    </div>
                    <div className="setting-row-control">
                      <Switch aria-label="回答者に他の回答者の回答を見せる" checked={shareAnswers} onChange={(e) => setShareAnswers(e.target.checked)} />
                    </div>
                  </div>
                )}
                <div className="subhead">📺 プレビュー</div>
                {discordPreview}
                {stepNav}
              </>
            )}

            {step === 'flow' && (
              <>
                <p className="nf2-lead">
                  {tmpl
                    ? '不定期出欠確認では、送信時刻・募集の自動投稿・未回答／未定リマインド・回答締切を開催日時ごとに「＋ 開催日時を追加」で決めます。ここではそれ以外を設定します。'
                    : 'いつ・何が・誰に届くかの流れです。日数を変えると、下のタイムラインが実際に送られる順で並び替わります。各工程のスイッチをオフにすると、その工程は自動では行いません（0 日前＝開催当日）。'}
                  {!tmpl && announceOnly ? '（出欠確認オフのため告知の投稿のみ）' : ''}
                </p>
                {/* 単発は送信時刻と投稿の流れを開催日時ごとに持つ（「＋ 開催日時を追加」・migration 0036）。テンプレートには出さない */}
                {!tmpl && (
                  <>
                <div className="setting-row">
                  <div className="setting-row-main">
                    <div className="setting-row-title">🕘 送信時刻</div>
                    <div className="setting-row-desc">募集・リマインドなど日単位の送信は、毎日この時刻（JST）にまとめて行われます。</div>
                  </div>
                  <div className="setting-row-control">
                    <Select value={sendHour} onChange={(e) => setSendHour(e.target.value)}>
                      {Array.from({ length: 24 }, (_, h) => (
                        <option key={h} value={h}>
                          {String(h).padStart(2, '0')}:00
                        </option>
                      ))}
                    </Select>
                  </div>
                </div>
                <div className="subhead">
                  📤 投稿の流れ{' '}
                  <span className="muted" style={{ fontWeight: 400 }}>
                    {eventWhen ? `（次回 ${eventWhen} 開催の場合の例）` : '（開催日からの逆算・実際の日付は投稿時に確定）'}
                  </span>
                </div>
                <div className="nf2-tl">
                  {flowTimeline.map((n) => (
                    <div
                      key={n.key}
                      className={
                        'nf2-tl-node' + (n.warn ? ' err' : '') + (n.key === 'event' ? ' event' : '') + (n.on ? '' : ' off')
                      }
                    >
                      <div className="nf2-tl-when">{n.when}</div>
                      <div className="nf2-tl-spine">
                        <span className="nf2-tl-dot" />
                      </div>
                      <div className="nf2-tl-card">
                        <div className="nf2-tl-title">
                          <span>
                            {n.icon} {n.title}
                          </span>
                          {n.chip && <span className="pill">{n.chip === 'ch' ? '📢 チャンネル投稿' : '✉️ 個別DM'}</span>}
                          {n.onToggle && (
                            <span className="nf2-tl-switch" title={n.on ? 'オン＝自動で行う' : 'オフ＝自動では行わない'}>
                              <Switch aria-label={`${n.title}を自動で行う`} checked={n.on} onChange={(e) => n.onToggle!(e.target.checked)} />
                            </span>
                          )}
                        </div>
                        {n.on ? n.body : <div className="nf2-tl-off">{n.offText}</div>}
                        {n.warn && (
                          <div className="nf2-tl-err">
                            <span className="nf2-tip" tabIndex={0} role="note" aria-label={n.warn.detail} data-tip={n.warn.detail}>
                              ⚠️ {n.warn.head}（保存できません）
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>

                {denseWarn && <div className="tl-warn">⚠️ {denseWarn}</div>}
                  </>
                )}

                {/* 折りたたみにしない: 「ノルマ」の状態が隠れると気づけないため常時表示（2026-08-03 裁定）。「有効」は設定一覧の行で切り替える（2026-09-20） */}
                <div className="nf2-flow-more">
                  {!announceOnly && (
                      <div>
                        {/* 締切後の変更通知は④回答締切とセット。不定期の締切は開催回ごと（ADR 0032）なのでここでも通知先を持つ */}
                        {(
                          <>
                            <div className="subhead">締切後の変更通知</div>
                            {tmpl && (
                              <p className="muted" style={{ margin: '0 0 8px', fontSize: 13 }}>
                                回答締切の時間（開始の何時間前か）は「＋ 開催日時を追加」で開催日時ごとに設定します（募集の自動投稿がオフなら「📣 今すぐ募集」で投稿するときに選びます）。ここでは締切後に回答が変わったときのお知らせの投稿先だけを決めます。
                              </p>
                            )}
                            <label>
                              変更通知チャンネル{' '}
                              <span className="muted">
                                {/* 回答非公開で空欄なら、投稿チャンネルに名前と回答を出さず失敗通知の投稿先へ回す（サーバー側と同じ・P2-01） */}
                                {shareAnswers ? '（締切後の変更を投稿・空欄＝投稿チャンネル）' : '（締切後の変更を投稿・空欄＝Bot設定の失敗通知の投稿先。未設定なら投稿しない）'}
                              </span>
                            </label>
                            <Select value={alertChannelId} onChange={(e) => setAlertChannelId(e.target.value)}>
                              <option value="">{shareAnswers ? '（投稿チャンネルと同じ）' : '（失敗通知の投稿先と同じ）'}</option>
                              {alertChannelOptions}
                            </Select>
                            <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                              締切後に回答が変更されると、上のチャンネルへメンションなしで記録投稿し、回答履歴に「締切後変更」として残ります。
                            </p>
                          </>
                        )}
                        {/* 単発は開催回が 1 件だけで前回の参加が無く、ノルマは働かないので出さない（2026-10-11） */}
                        {!oneOff && (<>
                        <div className="subhead">機能</div>
                        <div className="setting-row">
                          <div className="setting-row-main">
                            <div className="setting-row-title">ノルマ（参加間隔の督促）</div>
                            <div className="setting-row-desc">
                              前回参加から指定日数を超えたメンバーへ DM で参加を促します（募集を投稿した日に送ります。手動投稿なら 📣 で投稿した日）。
                            </div>
                          </div>
                          <div className="setting-row-control">
                            <Switch
                              aria-label="ノルマ（参加間隔の督促）"
                              checked={quotaEnabled}
                              onChange={(e) => setQuotaEnabled(e.target.checked)}
                            />
                          </div>
                        </div>
                        {quotaEnabled && (
                          <>
                            <div style={{ maxWidth: 280 }}>
                              <label htmlFor="quota-interval">ノルマ間隔（日数）</label>
                              <TextField id="quota-interval" type="number" placeholder="例: 30" value={quotaInterval} onChange={(e) => setQuotaInterval(e.target.value)} />
                            </div>
                            <label htmlFor="quota-message">ノルマのメッセージ（DM）</label>
                            <Textarea id="quota-message" rows={9} maxLength={QUOTA_MESSAGE_MAX} value={quotaText}
                              aria-describedby={quotaError ? 'quota-message-help quota-message-error' : 'quota-message-help'} aria-invalid={!!quotaError}
                              onChange={(e) => setQuotaText(e.target.value)} />
                            <p className="muted" id="quota-message-help">
                              {QUOTA_MESSAGE_FIELDS.map((key) => `{{${key}}}`).join('・')} を差し込めます。空欄で保存すると標準の文面を使います。
                            </p>
                            <button type="button" className="btn sm secondary" onClick={() => { setQuotaText(DEFAULT_QUOTA_MESSAGE); markDirty(); }}>標準の文面に戻す</button>
                            <p className="muted">{quotaText.length} / {QUOTA_MESSAGE_MAX}文字</p>
                            <div className="subhead">送信内容のプレビュー</div>
                            <div className="nf2-discord" aria-label="ノルマのメッセージのプレビュー">
                              <div className="nf2-dc-msg">
                                <div className="nf2-dc-ava">🤖</div>
                                <div className="nf2-dc-main">
                                  <div className="nf2-dc-head"><b>EventBot</b><span className="nf2-dc-app">APP</span><span className="nf2-dc-time">DM</span></div>
                                  <div className="nf2-dc-body">{quotaPreviewText.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
                                    part.startsWith('**') && part.endsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : part)}</div>
                                </div>
                              </div>
                              <p className="preview-note">名前・最終参加日・経過日数はサンプルです。</p>
                            </div>
                          </>
                        )}
                        {quotaError && <p className="nf2-field-err" id="quota-message-error" role="alert">{quotaError}</p>}
                        </>)}
                      </div>
                    )}
                </div>
                {stepNav}
              </>
            )}

            {step === 'confirm' && (
              <>
                <p className="nf2-lead">内容を確認して{nuuid ? '保存' : '作成'}してください。各カードの「編集」から修正できます。</p>
                {summaryCard(
                  'basic',
                  <>
                    {summaryRow(nameLabel, name.trim() || <span className="nf2-unset">未入力</span>)}
                    {summaryRow('対象区分', mentionSeg ? mentionSeg.name : <span className="nf2-unset">未選択</span>)}
                    {summaryRow('投稿チャンネル', channelId ? chLabel(channelId) : <span className="nf2-unset">未選択</span>)}
                  </>,
                )}
                {summaryCard(
                  'when',
                  <>
                    {summaryRow('開催日時', scheduleText)}
                    {tmpl && summaryRow('開催日時', '保存後に「不定期出欠確認」で追加')}
                    {plan && plan.dates.length > 0 && summaryRow('次の開催日', plan.dates.slice(0, 4).map((d) => shortDateWithWeekday(d)).join('　'))}
                  </>,
                )}
                {summaryCard(
                  'message',
                  <>
                    {summaryRow(
                      'メンション',
                      mention === 'role' ? 'ロール' : mention === 'members' ? 'バイネーム' : 'なし',
                    )}
                    {summaryRow('見出し', title.trim() || <span className="nf2-unset">未入力</span>)}
                    {summaryRow('本文', body.trim() ? `${body.trim().split('\n')[0].slice(0, 30)}${body.trim().length > 30 ? '…' : ''}` : 'なし')}
                    {summaryRow('出欠確認', requireResponse ? 'あり（募集）' : 'なし（告知のみ）')}
                    {requireResponse && summaryRow('回答の公開', shareAnswers ? 'する' : 'しない')}
                  </>,
                )}
                {summaryCard(
                  'flow',
                  <>
                    {tmpl ? summaryRow('投稿の流れ', '開催日時ごとに「＋ 開催日時を追加」で設定') : summaryRow('投稿', timelineText)}
                    {!announceOnly && !tmpl && summaryRow('リマインドの送り先', `未回答: ${TARGET_LABEL[remindTarget]}／未定: ${TARGET_LABEL[remindUndecidedTarget]}`)}
                    {!announceOnly && !oneOff && summaryRow('ノルマ', quotaEnabled ? `あり（${quotaInterval || '—'}日間隔）` : 'なし')}
                  </>,
                )}
                {[
                  ...flowIssues.map((w) => ({ text: `${FLOW_STEP_NAMES[w.step]}: ${w.head}。${w.detail}（保存できません）`, err: true })),
                  ...(denseWarn ? [{ text: denseWarn, err: false }] : []),
                ].map((w, i) => (
                  <div key={i} className={w.err ? 'tl-err' : 'tl-warn'}>
                    ⚠️ {w.text}
                  </div>
                ))}
                <div className="subhead">📺 投稿されるメッセージ</div>
                {discordPreview}
                {stepNav}
              </>
            )}
          </div>
        </div>
      </div>
    </dialog>
  );
}
