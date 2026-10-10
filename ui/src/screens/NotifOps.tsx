// 定期／不定期／単発出欠確認は同じ一覧を使い、親スケジュールの種別で表示対象を絞る。
// 単発はテンプレートと開催回 1 件を同時に作る（作成・編集・複製・削除は行から・2026-10-02）。
// 未来の予定は RRULE から仮想導出し、中止した回だけ cancelled で実体化する（墓石方式）。
import { FlowGuide, type FlowRow } from '../components/FlowGuide';
import * as React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { api, type Guild } from '../api';
import { confirmDialog, withBusy } from '../lib/dialog';
import { FormDialog } from '../lib/FormDialog';
import { Switch } from '../../../design-system/src';
import { jstMs, jstToday, occurrenceLabel } from '../lib/rrule';
import { scheduleKind, SCHEDULE_LABELS, type ScheduleKind } from '../lib/route';
import type { ToastFn } from '../App';

type Notification = {
  uuid: string;
  type?: string;
  name: string;
  /** 自動送信の対象か（Bot 退出で 0 になる・単発の行のスイッチで戻す） */
  active?: 0 | 1 | boolean;
  duration_minutes: number | null;
  start_time?: string;
  requires_response?: number;
  /** null = 不定期（ルールなし。開催回はここで追加した行だけ） */
  rrule?: string | null;
  /** 0 = 募集/告知を自動では投稿しない（📣 今すぐ募集で手動投稿・ADR 0026） */
  recruit_enabled?: number;
  /** 雛形の回答締切（定期）。不定期は NULL（締切は開催回ごと・ADR 0032） */
  response_deadline_hours?: number | null;
  /** 送信時刻と投稿の流れ。単発では開催日時ごとの初期値になる（migration 0036） */
  send_hour?: number | null;
  recruit_days_before?: number | null;
  remind_unanswered_enabled?: number | null;
  remind_start_days?: number | null;
  remind_undecided_enabled?: number | null;
  remind_undecided_days?: number | null;
  remind_target?: 'dm' | 'channel' | null;
  remind_undecided_target?: 'dm' | 'channel' | null;
};
type Occurrence = {
  planning_id?: string|null;
  uuid: string;
  occurrence_date: string;
  start_time?: string | null;
  status?: string;
  /** この開催回の回答締切（開始の H 時間前）。NULL＝雛形に従う（ADR 0032） */
  response_deadline_hours?: number | null;
  /** この開催回の開催時間（分）。NULL＝雛形に従う */
  duration_minutes?: number | null;
  /** 単発の開催回ごとの募集の自動投稿（NULL＝雛形に従う・migration 0036）。📣 の締切ダイアログの判定に使う */
  recruit_enabled?: number | null;
};
/** 開催回に有効な開催時間（分）: 開催回の値 → 雛形の値。 */
const durOf = (o: Occurrence, n: Notification) => o.duration_minutes ?? n.duration_minutes;

/** 開催回の回答締切の時刻（開始の hours 時間前）。 */
function deadlineAt(o: Occurrence, fallbackTime: string | undefined, hours: number): Date {
  return new Date(jstMs(o.occurrence_date, o.start_time || fallbackTime || '00:00') - hours * 3_600_000);
}
/** JST の「M/D HH:MM」（端末のタイムゾーンに依らない） */
const fmtDT = (d: Date) => {
  const j = new Date(d.getTime() + 9 * 3_600_000);
  return `${j.getUTCMonth() + 1}/${j.getUTCDate()} ${String(j.getUTCHours()).padStart(2, '0')}:${String(j.getUTCMinutes()).padStart(2, '0')}`;
};
type Item = { n: Notification; o: Occurrence; virtual: boolean };

/** 表示用ステータス。中止=cancelled、終了=終了時刻（所要時間未設定なら当日末）が過去、
 * 投稿済み=募集/告知をチャンネルへ投稿済みで未終了、予定=未投稿かつ未終了
 * （保存は cancelled のみ・他は導出。時間と投稿状態を統合した1軸・2026-08-05 裁定。用語は CONTEXT.md）。 */
type Derived = '予定' | '投稿済み' | '終了' | '中止';

function occLabel(o: Occurrence, dur?: number | null): string {
  return occurrenceLabel(o.occurrence_date, o.start_time, dur);
}
function deriveStatus(o: Occurrence, dur: number | null | undefined, now: Date, posted: boolean): Derived {
  if (o.status === 'cancelled') return '中止';
  // 開催日時は JST で組み立てる（端末のタイムゾーンで組むと JST 以外で開催前の回が「終了」になる）
  const date = o.occurrence_date || '';
  // 所要時間があれば開始+所要時間、無ければ開催時間の終了が不明なので当日末を終了とみなす
  const end =
    dur && dur > 0
      ? jstMs(date, o.start_time || '23:59') + dur * 60000
      : jstMs(date, '23:59') + 59_000;
  if (now.getTime() >= end) return '終了';
  return posted ? '投稿済み' : '予定';
}
const itemKey = (it: Item) => it.o.uuid || `${it.n.uuid}|${it.o.occurrence_date}|${it.o.start_time || ''}`;
/** 開催日時の昇順（直近の回が先頭）。 */
const byDateAsc = (a: Item, b: Item) =>
  (a.o.occurrence_date + (a.o.start_time || '')).localeCompare(b.o.occurrence_date + (b.o.start_time || ''));

const STATUS_PILL: Record<Derived, string> = { 予定: 'pill accent', 投稿済み: 'pill on', 終了: 'pill', 中止: 'pill danger' };

/** 未来予定（仮想行）をスケジュールごとに何回先まで表示するか。表示だけの好みなので localStorage 保存。 */
const PLAN_COUNT_KEY = 'eventbot_plan_count';
const PLAN_COUNT_CHOICES = [1, 2, 4, 8] as const;
function loadPlanCount(): number {
  const v = Number(localStorage.getItem(PLAN_COUNT_KEY));
  return (PLAN_COUNT_CHOICES as readonly number[]).includes(v) ? v : 1;
}

/** ステータスフィルタも localStorage 保存（既知キーだけ取り込み・壊れた値は既定に戻す）。 */
const STATUS_FILTER_KEY = 'eventbot_status_filter';
const DEFAULT_STATUS_FILTER: Record<Derived, boolean> = { 予定: true, 投稿済み: true, 終了: false, 中止: false };
// 単発は 1 行＝1 件で、終了した行から「⧉ 複製」するので既定ですべて表示（定期・不定期と別に保存）
const ONEOFF_STATUS_FILTER_KEY = 'eventbot_status_filter_oneoff';
function loadStatusFilter(oneOff = false): Record<Derived, boolean> {
  const out = oneOff ? { 予定: true, 投稿済み: true, 終了: true, 中止: true } : { ...DEFAULT_STATUS_FILTER };
  try {
    const saved = JSON.parse(localStorage.getItem(oneOff ? ONEOFF_STATUS_FILTER_KEY : STATUS_FILTER_KEY) || '{}');
    for (const k of Object.keys(out) as Derived[]) if (typeof saved[k] === 'boolean') out[k] = saved[k];
    // 旧名「通知済み」（2026-08-03 改名）→「開始済み」（2026-08-05 改名）で保存された設定を引き継ぐ
    const legacy = typeof saved['開始済み'] === 'boolean' ? saved['開始済み'] : saved['通知済み'];
    if (typeof legacy === 'boolean' && typeof saved['投稿済み'] !== 'boolean') out['投稿済み'] = legacy;
  } catch {}
  return out;
}

/** 並び順も localStorage 保存。既定は新しい順（降順）＝直近終了した回が「終了」表示時にすぐ見える。 */
const SORT_ORDER_KEY = 'eventbot_occ_sort';
type SortOrder = 'desc' | 'asc';
function loadSortOrder(): SortOrder {
  return localStorage.getItem(SORT_ORDER_KEY) === 'asc' ? 'asc' : 'desc';
}

/** スケジュール絞り込みの保存キー（スケジュールは guild ごとなので guild.id を付ける）。 */
const NOTIF_FILTER_KEY = 'eventbot_notif_filter.';

export function NotifOps({ guild, scope, toast, onOpenGrouping, onOpenSettings, onCreateSchedule, onEditSchedule, onCopySchedule }: {
  guild: Guild;
  scope: ScheduleKind;
  toast: ToastFn;
  onOpenGrouping: (nuuid: string, ouuid: string) => void;
  onOpenSettings: () => void;
  onCreateSchedule: () => void;
  onEditSchedule: (nuuid: string) => void;
  onCopySchedule: (nuuid: string) => void;
}) {
  const oneOff = scope === 'oneoff';
  const filterKey = NOTIF_FILTER_KEY + guild.id + '.' + scope;
  const [notifs, setNotifs] = useState<Notification[] | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [filter, setFilter] = useState(() => localStorage.getItem(filterKey) ?? localStorage.getItem(NOTIF_FILTER_KEY + guild.id) ?? '');
  const [statusFilter, setStatusFilter] = useState<Record<Derived, boolean>>(() => loadStatusFilter(oneOff));
  const [planCount, setPlanCount] = useState(loadPlanCount);
  const [sortOrder, setSortOrder] = useState<SortOrder>(loadSortOrder);
  const [tallies, setTallies] = useState<Record<string, string>>({});
  // 開催回 uuid → 募集/告知を投稿済みか（/status の recruited）。「投稿済み」ステータスの判定に使う
  const [posted, setPosted] = useState<Record<string, boolean>>({});
  // ＋開催回ダイアログ（定期＝ルール外の臨時回／不定期＝その開催回そのもの。1 ダイアログ・1 API・ADR 0025）
  const [adhocOpen, setAdhocOpen] = useState(false);
  const [adhocNotif, setAdhocNotif] = useState('');
  const [adhocDate, setAdhocDate] = useState('');
  const [adhocTime, setAdhocTime] = useState('');
  const [adhocNote, setAdhocNote] = useState('');
  const [adhocDeadline, setAdhocDeadline] = useState('');
  const [adhocDuration, setAdhocDuration] = useState('');
  const [adhocDeadlineOn, setAdhocDeadlineOn] = useState(false);
  // 単発の送信時刻と投稿の流れ（開催日時ごと・migration 0036）。開くときにテンプレートの保存値を初期値にする
  const [adhocFlow, setAdhocFlow] = useState({ sendHour: '21', recruitOn: true, recruitDays: '7', unansweredOn: true, unansweredDays: '3', unansweredTarget: 'dm' as 'dm' | 'channel', undecidedOn: true, undecidedDays: '1', undecidedTarget: 'dm' as 'dm' | 'channel' });
  const flowFrom = (n: Notification | undefined) => ({
    sendHour: String(n?.send_hour ?? 21),
    recruitOn: n?.recruit_enabled !== 0,
    recruitDays: String(n?.recruit_days_before ?? 7),
    unansweredOn: n?.remind_unanswered_enabled !== 0,
    unansweredDays: String(n?.remind_start_days ?? 3),
    unansweredTarget: (n?.remind_target === 'channel' ? 'channel' : 'dm') as 'dm' | 'channel',
    undecidedOn: n?.remind_undecided_enabled !== 0,
    undecidedDays: String(n?.remind_undecided_days ?? 1),
    undecidedTarget: (n?.remind_undecided_target === 'channel' ? 'channel' : 'dm') as 'dm' | 'channel',
  });
  const patchFlow = (p: Partial<typeof adhocFlow>) => setAdhocFlow((f) => ({ ...f, ...p }));
  // 📣 今すぐ募集の締切ダイアログ（不定期×手動募集×出欠あり: 投稿の瞬間に締切を選ぶ・ADR 0032）
  const [dlAsk, setDlAsk] = useState<Item | null>(null);
  const [dlHours, setDlHours] = useState('');

  /** 開催回の投稿有無・集計を取得して posted/tallies に反映する（初回ロードと「今すぐ募集」後で共用） */
  function refreshStatus(notif: Notification, o: Occurrence, isAlive: () => boolean = () => true) {
    // 出欠確認なし（告知のみ）は回答が存在しないため集計を出さず、投稿の有無だけを示す
    const announceOnly = notif.requires_response === 0;
    return api(`/occurrences/${o.uuid}/status`).then(
      (s) => {
        if (!isAlive()) return;
        setPosted((p) => ({ ...p, [o.uuid]: !!s.recruited }));
        setTallies((t) => ({
          ...t,
          [o.uuid]: announceOnly
            ? s.recruited
              ? '告知済み'
              : 'まだ投稿されていません'
            : `${s.recruited ? '募集済み・' : ''}参加 ${s.参加.length}・不参加 ${s.不参加.length}・未定 ${s.未定.length}・未回答 ${s.未回答.length}`,
        }));
      },
      () => isAlive() && setTallies((t) => ({ ...t, [o.uuid]: '状態を取得できませんでした' })),
    );
  }

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const allNotifs: Notification[] = await api('/notifications?guild_id=' + encodeURIComponent(guild.id));
        const n = allNotifs.filter(x => scheduleKind(x) === scope);
        if (!alive) return;
        setNotifs(n);
        // 保存されていた絞り込みスケジュールが削除済みなら「すべてのスケジュール」へ戻す
        setFilter((cur) => (cur && !n.some((x) => x.uuid === cur) ? '' : cur));
        if (!n.length) return;
        // 1 件の失敗で一覧全体を止めないが、黙って「開催日時なし」に見せないよう最後に知らせる
        let failed = false;
        const orEmpty = (p: Promise<Occurrence[]>) => p.catch(() => ((failed = true), [] as Occurrence[]));
        const lists = await Promise.all(
          n.map(async (notif) => {
            const [occs, plan] = await Promise.all([
              orEmpty(api(`/notifications/${notif.uuid}/occurrences`)),
              orEmpty(api(`/notifications/${notif.uuid}/plan?count=${planCount}`)),
            ]);
            return [
              ...occs.map((o: Occurrence) => ({ n: notif, o, virtual: false })),
              ...plan.map((o: Occurrence) => ({ n: notif, o: { ...o, uuid: '', status: 'scheduled' }, virtual: true })),
            ] as Item[];
          }),
        );
        if (!alive) return;
        if (failed) toast('一部の開催日時を読み込めませんでした。再読み込みしてください。', true);
        const all = lists.flat().sort(byDateAsc);
        setItems(all);
        for (const { n: notif, o, virtual } of all) {
          if (!virtual) refreshStatus(notif, o, () => alive);
        }
      } catch (e) {
        if (alive) {
          setNotifs([]);
          toast(e instanceof Error ? e.message : String(e), true);
        }
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guild.id, scope, planCount]);

  /** 配信しない（仮想行は cancelled で実体化＝墓石、実体行は status 変更） */
  async function suppress(it: Item) {
    const label = occLabel(it.o, durOf(it.o, it.n));
    const ok = await confirmDialog(
      `${label}（${it.n.name}）を中止しますか？\n\nこの回の募集/告知・リマインドなどの自動送信が止まり、回答ボタンも無効になります。`,
      { title: 'この回を中止する', okLabel: '中止する', danger: true },
    );
    if (!ok) return;
    try {
      if (it.virtual) {
        const created: Occurrence = await api(`/notifications/${it.n.uuid}/occurrences`, {
          method: 'POST',
          body: JSON.stringify({ date: it.o.occurrence_date, start_time: it.o.start_time || '', status: 'cancelled', origin: 'rule' }),
        });
        setItems((cur) => cur.map((x) => (x === it ? { ...x, o: created, virtual: false } : x)));
        setTallies((t) => ({ ...t, [created.uuid]: '回答なし' }));
      } else {
        await api(`/occurrences/${it.o.uuid}`, { method: 'PUT', body: JSON.stringify({ status: 'cancelled' }) });
        setItems((cur) => cur.map((x) => (x === it ? { ...x, o: { ...x.o, status: 'cancelled' } } : x)));
      }
      toast('この回を中止しました');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), true);
    }
  }

  /** 開催回を追加（scheduled・origin=manual で実体化。cron が窓内で募集・リマインドを自動送信する） */
  async function addAdhoc(btn: HTMLElement | null) {
    const n = notifs?.find((x) => x.uuid === adhocNotif);
    // 単発のテンプレートは開始時刻を持たないので、開催日時ごとに必須（2026-09-23）
    if (!n || !adhocDate || (!n.rrule && !adhocTime)) {
      toast(n && adhocDate ? '開始時刻を指定してください' : 'テンプレートと日付を指定してください', true);
      return;
    }
    const date = adhocDate.replace(/-/g, '/');
    if (date < jstToday()) {
      toast('過去の日付には作成できません', true);
      return;
    }
    // 締切・開催時間は画面に出ている条件のときだけ送る（テンプレートを切り替えても入力値は残るため・P2-14）
    const askDeadline = !n.rrule && n.requires_response !== 0 && adhocFlow.recruitOn && adhocDeadlineOn;
    try {
      // 処理中はボタンを無効化し、二重クリックで 2 回送らない（P2-13）
      const created: Occurrence = await withBusy(btn, () => api(`/notifications/${n.uuid}/occurrences`, {
        method: 'POST',
        body: JSON.stringify({
          date,
          start_time: adhocTime || n.start_time || '',
          status: 'scheduled',
          note: adhocNote.trim(),
          response_deadline_hours: askDeadline && adhocDeadline.trim() !== '' ? Number(adhocDeadline) : null,
          duration_minutes: n.rrule || adhocDuration.trim() === '' ? null : Number(adhocDuration),
          ...(n.rrule
            ? {}
            : {
                send_hour: Number(adhocFlow.sendHour),
                recruit_enabled: adhocFlow.recruitOn ? 1 : 0,
                recruit_days_before: Number(adhocFlow.recruitDays) || 0,
                remind_unanswered_enabled: adhocFlow.unansweredOn ? 1 : 0,
                remind_start_days: Number(adhocFlow.unansweredDays) || 0,
                remind_undecided_enabled: adhocFlow.undecidedOn ? 1 : 0,
                remind_undecided_days: Number(adhocFlow.undecidedDays) || 0,
                remind_target: adhocFlow.unansweredTarget,
                remind_undecided_target: adhocFlow.undecidedTarget,
              }),
        }),
      }));
      setItems((cur) =>
        // 同じ日時の既存行（中止した回の登録し直し・二重クリック）はサーバーが同じ行を返すので置き換える
        [...cur.filter((x) => !(x.virtual && x.n.uuid === n.uuid && x.o.occurrence_date === date) && x.o.uuid !== created.uuid), { n, o: created, virtual: false }].sort(byDateAsc),
      );
      setTallies((t) => ({ ...t, [created.uuid]: '回答なし' }));
      setAdhocOpen(false);
      toast(`${date} の開催日時を追加しました`);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), true);
    }
  }

  /**
   * 開催回の即時募集/告知（旧「スケジュール一覧の今すぐ募集」はここに一本化・2026-08-23）。
   * 仮想行（未実体化の予定回）は scheduled で実体化してから投稿する。投稿済みの回は同じボタンが「再投稿」になり、確認のうえ force で投稿する。
   */
  // 送信中の行（📣・削除）。確認の後もボタンが押せて同じ POST/DELETE が重ねて送られていた
  const inFlight = React.useRef(new Set<string>());
  async function once(key: string, run: () => Promise<unknown>) {
    if (inFlight.current.has(key)) return;
    inFlight.current.add(key);
    try {
      await run();
    } finally {
      inFlight.current.delete(key);
    }
  }
  function recruitOne(it: Item) {
    return once(`recruit:${it.n.uuid}:${it.o.occurrence_date}:${it.o.start_time}`, () => recruitOneNow(it));
  }
  async function recruitOneNow(it: Item) {
    // 出欠確認なし（告知のみ）のスケジュールは操作名も「告知」で統一する（用語は CONTEXT.md）
    const noun = it.n.requires_response === 0 ? '告知' : '募集';
    // 不定期×手動募集×出欠あり: 締切は投稿の瞬間に選ぶ（確認ダイアログの代わりに締切ダイアログ・ADR 0032）
    if (it.n.rrule === null && (it.o.recruit_enabled ?? it.n.recruit_enabled) === 0 && noun === '募集' && it.o.response_deadline_hours == null && !posted[it.o.uuid]) {
      setDlHours('');
      setDlAsk(it);
      return;
    }
    // 投稿済み（開催前）＝同じボタンで再投稿。元の投稿は残るので確認のうえ force で新しく投稿する
    if (posted[it.o.uuid]) {
      const again = await confirmDialog(
        `${occLabel(it.o, durOf(it.o, it.n))}（${it.n.name}）の${noun}メッセージを、もう一度チャンネルへ投稿します。元の投稿は残るため、不要なら Discord 上で削除してください。`,
        { title: `${noun}を再投稿`, okLabel: '再投稿する' },
      );
      if (again) await postRecruit(it, it.o, noun, { force: true });
      return;
    }
    const ok = await confirmDialog(
      noun === '告知'
        ? `${occLabel(it.o, durOf(it.o, it.n))}（${it.n.name}）の開催告知を今すぐチャンネルへ投稿しますか？`
        : `${occLabel(it.o, durOf(it.o, it.n))}（${it.n.name}）の募集メッセージを今すぐチャンネルへ投稿しますか？`,
      { title: `今すぐ${noun}`, okLabel: '投稿する' },
    );
    if (!ok) return;
    let o = it.o;
    if (it.virtual) {
      // 実体化（UNIQUE(通知,日付,時刻) 上の upsert なので二重作成しない）。行もその場で実体行へ差し替える
      try {
        const created: Occurrence = await api(`/notifications/${it.n.uuid}/occurrences`, {
          method: 'POST',
          body: JSON.stringify({ date: it.o.occurrence_date, start_time: it.o.start_time || '', status: 'scheduled', origin: 'rule' }),
        });
        o = created;
        setItems((cur) => cur.map((x) => (x === it ? { ...x, o: created, virtual: false } : x)));
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e), true);
        return;
      }
    }
    await postRecruit(it, o, noun);
  }

  /** 投稿本体（📣 と締切ダイアログで共用）。409（投稿済み）は確認のうえ force 再送。投稿できたら true */
  async function postRecruit(it: Item, o: Occurrence, noun: string, extra: Record<string, unknown> = {}): Promise<boolean> {
    try {
      await api(`/occurrences/${o.uuid}/recruit`, { method: 'POST', body: JSON.stringify(extra) });
      toast(`${noun}メッセージを投稿しました`);
      return true;
    } catch (e) {
      // 投稿済み（409）: Discord 上で投稿を削除したケースを想定し、確認のうえ再送する
      if ((e as { status?: number }).status === 409) {
        const again = await confirmDialog(
          `この回の${noun}は既に投稿済みです。Discord 上の投稿を削除した場合など、もう一度投稿してよい場合のみ再送してください（元の投稿が残っていると${noun}が2つ並びます）。`,
          { title: `${noun}を再送`, okLabel: '再送する', danger: true },
        );
        if (!again) return false;
        try {
          await api(`/occurrences/${o.uuid}/recruit`, { method: 'POST', body: JSON.stringify({ ...extra, force: true }) });
          toast(`${noun}メッセージを再送しました`);
          return true;
        } catch (e2) {
          toast(e2 instanceof Error ? e2.message : String(e2), true);
          return false;
        }
      }
      toast(e instanceof Error ? e.message : String(e), true);
      return false;
    } finally {
      // 成否にかかわらずサーバーの投稿有無・集計を取り直す（成功→「投稿済み」、409→実は投稿済みだった、等を即反映）
      void refreshStatus(it.n, o);
    }
  }

  /** 単発の削除（テンプレートごと・開催回と回答も消える） */
  function removeOneOff(n: Notification) {
    return once(`delete:${n.uuid}`, () => removeOneOffNow(n));
  }
  async function removeOneOffNow(n: Notification) {
    const ok = await confirmDialog(`「${n.name}」を、回答・配置ごとすべて削除します。元に戻せません。`, { title: '単発出欠確認を削除', okLabel: '削除する', danger: true });
    if (!ok) return;
    try {
      await api('/notifications/' + n.uuid, { method: 'DELETE' });
      setItems((cur) => cur.filter((x) => x.n.uuid !== n.uuid));
      setNotifs((cur) => cur && cur.filter((x) => x.uuid !== n.uuid));
      toast('削除しました');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), true);
    }
  }

  /** 単発の行の「有効」スイッチ（テンプレート一覧の C03 と同じ API・P2-16）。失敗時は元に戻す */
  async function toggleActive(n: Notification, on: boolean) {
    const set = (v: 0 | 1) => {
      setNotifs((cur) => cur && cur.map((x) => (x.uuid === n.uuid ? { ...x, active: v } : x)));
      setItems((cur) => cur.map((x) => (x.n.uuid === n.uuid ? { ...x, n: { ...x.n, active: v } } : x)));
    };
    set(on ? 1 : 0);
    try {
      await api('/notifications/' + n.uuid + '/active', { method: 'POST', body: JSON.stringify({ active: on }) });
      toast(on ? '有効にしました（自動送信の対象）' : '無効にしました（自動送信の対象外）');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), true);
      set(on ? 0 : 1);
    }
  }

  /** 配信する（中止の取り消し） */
  async function resume(it: Item) {
    try {
      await api(`/occurrences/${it.o.uuid}`, { method: 'PUT', body: JSON.stringify({ status: 'scheduled' }) });
      setItems((cur) => cur.map((x) => (x === it ? { ...x, o: { ...x.o, status: 'scheduled' } } : x)));
      toast('この回を再開しました');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), true);
    }
  }

  const now = new Date();
  // 「YYYY/MM/DD」の今日（JST・過去回の判定用。0埋めなので文字列比較で日付比較になる）
  const todayStr = jstToday(now.getTime());
  const shown = useMemo(() => {
    // items は常に昇順で保持しているので、降順は filter 後の新しい配列を反転するだけでよい
    const list = items
      .filter((x) => (filter ? x.n.uuid === filter : true))
      .filter((x) => statusFilter[deriveStatus(x.o, durOf(x.o, x.n), now, !!posted[x.o.uuid])]);
    return sortOrder === 'asc' ? list : list.reverse();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, filter, statusFilter, sortOrder, posted]);

  if (notifs === null) return <p className="muted">読み込み中…</p>;

  if (notifs.length === 0) {
    return (
      <div className="flow-page">
        <ScheduleFlow kind={scope} />
        <div className="sec-head occurrence-head">
          <h2>{SCHEDULE_LABELS[scope]}</h2>
          {oneOff
            ? <button className="btn" onClick={onCreateSchedule}>＋ 新しく作る</button>
            : <button className="btn secondary" onClick={onOpenSettings}>⚙ テンプレート作成・編集</button>}
        </div>
        <div className="empty">
          {oneOff ? (
            <p>単発出欠確認はまだありません。「＋ 新しく作る」で、開催日時と内容を入れて 1 回分の出欠確認を作ります。</p>
          ) : (
            <>
              <p>{SCHEDULE_LABELS[scope]}のテンプレートがまだありません。</p>
              <button className="btn" onClick={onCreateSchedule}>＋ 最初のテンプレートを作成</button>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flow-page">
      <ScheduleFlow kind={scope} />
      <div className="sec-head occurrence-head">
        <div>
          <h2>{SCHEDULE_LABELS[scope]}</h2>
          <p className="muted occurrence-description">出欠確認・告知を管理します。開催日時ごとの出欠状況を確認し、募集の投稿やメンバー配置を行います。</p>
        </div>
        {oneOff
          ? <button className="btn" onClick={onCreateSchedule}>＋ 新しく作る</button>
          : <button className="btn secondary" onClick={onOpenSettings}>⚙ テンプレート作成・編集</button>}
      </div>
      {!oneOff && <div className="occurrence-actions">
          <select
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              localStorage.setItem(filterKey, e.target.value);
            }}
            style={{ maxWidth: 280 }}
            aria-label="テンプレートで絞り込み"
          >
            <option value="">すべてのテンプレート</option>
            {notifs.map((n) => (
              <option key={n.uuid} value={n.uuid}>
                {n.name}
              </option>
            ))}
          </select>
          <button
            className="btn sm"
            onClick={() => {
              const first = notifs[0];
              setAdhocNotif(filter || first.uuid);
              const base = notifs.find((x) => x.uuid === (filter || first.uuid));
              // 定期はテンプレートの開始時刻を初期値に、単発は空欄から（テンプレートに開始時刻の入力欄が無いため）
              setAdhocTime(base?.rrule ? base.start_time || '' : '');
              setAdhocFlow(flowFrom(base));
              setAdhocDate('');
              setAdhocNote('');
              setAdhocDeadline('');
              setAdhocDeadlineOn(false);
              setAdhocDuration('');
              setAdhocOpen(true);
            }}
          >
            ＋ 開催日時を追加
          </button>
      </div>}
      <div style={{ marginBottom: 12 }}>
        {(['予定', '投稿済み', '終了', '中止'] as Derived[]).map((s) => (
          <label key={s} className="inline">
            <input
              type="checkbox"
              checked={statusFilter[s]}
              onChange={(e) => {
                const next = { ...statusFilter, [s]: e.target.checked };
                setStatusFilter(next);
                localStorage.setItem(oneOff ? ONEOFF_STATUS_FILTER_KEY : STATUS_FILTER_KEY, JSON.stringify(next));
              }}
            />
            {s}
          </label>
        ))}
        {!oneOff && <label className="inline" style={{ marginLeft: 12 }}>
          先の予定
          <select
            value={planCount}
            onChange={(e) => {
              const v = Number(e.target.value);
              localStorage.setItem(PLAN_COUNT_KEY, String(v));
              setPlanCount(v);
            }}
            style={{ width: 'auto' }}
            aria-label="未来の予定をいくつ表示するか"
          >
            {PLAN_COUNT_CHOICES.map((c) => (
              <option key={c} value={c}>
                {c === 1 ? '次の1回' : `${c}回先まで`}
              </option>
            ))}
          </select>
        </label>}
        <label className="inline" style={{ marginLeft: 12 }}>
          並び順
          <select
            value={sortOrder}
            onChange={(e) => {
              const v = e.target.value === 'asc' ? 'asc' : 'desc';
              localStorage.setItem(SORT_ORDER_KEY, v);
              setSortOrder(v);
            }}
            style={{ width: 'auto' }}
            aria-label="出欠一覧の並び順"
          >
            <option value="desc">新しい順</option>
            <option value="asc">古い順</option>
          </select>
        </label>
      </div>
      {shown.length === 0 ? (
        <div className="empty">
          この条件に当てはまる出欠確認・告知がありません。
          <br />
          {filter && notifs.find((x) => x.uuid === filter && !x.rrule)
            ? 'このテンプレートは日時を指定して使います。「＋ 開催日時を追加」から登録してください。'
            : oneOff ? '上のステータスの絞り込みを変更するか、「＋ 新しく作る」から作成してください。' : '上のステータスやテンプレートの絞り込みを変更してみてください。'}
        </div>
      ) : (
        shown.map((it) => {
          const { n, o, virtual } = it;
          const st = deriveStatus(o, durOf(o, n), now, !!posted[o.uuid]);
          // 有効な締切＝開催回の値 ?? 雛形の値（ADR 0032）。締切を過ぎた未投稿の回は募集が出ない（cron 共通ルール 2）ので理由を表示
          const dlH = o.response_deadline_hours ?? n.response_deadline_hours ?? null;
          const dlAt = dlH != null && !virtual ? deadlineAt(o, n.start_time, dlH) : null;
          const dlPassed = dlAt != null && now.getTime() >= dlAt.getTime();
          const dlMissed = st === '予定' && dlPassed;
          return (
            <div className="pickrow occurrence-row" key={itemKey(it)}>
              <div>
                {occLabel(o, durOf(o, n))} <span className={STATUS_PILL[st]}>{st}</span>{' '}
                <span className="muted" style={{ fontSize: 12 }}>{n.name}</span>
                {st !== '中止' && (
                  <>
                    <br />
                    <span className="muted" style={{ fontSize: 12 }}>
                      {virtual
                        ? `${n.requires_response === 0 ? '告知' : '募集'}予定（まだ投稿されていません）`
                        : tallies[o.uuid] || '集計中…'}
                      {dlAt && o.response_deadline_hours != null && !dlMissed && `・回答締切 ${fmtDT(dlAt)}（開始の ${dlH} 時間前）`}
                    </span>
                    {dlMissed && (
                      <>
                        <br />
                        <span style={{ fontSize: 12, color: 'var(--danger, #b3261e)' }}>
                          回答締切（{fmtDT(dlAt!)}）を過ぎたため募集は投稿されません。{oneOff ? '中止して「⧉ 複製」で作り直してください。' : '中止して登録し直してください。'}
                        </span>
                      </>
                    )}
                  </>
                )}
              </div>
              <div className="actions">
                {o.planning_id && <a className="btn sm secondary" href={`#g/${guild.id}/planning/${o.planning_id}`}>開催計画で管理</a>}
                {!o.planning_id && st === '中止' && !virtual && o.occurrence_date >= todayStr && (
                  <button className="btn sm secondary" onClick={() => resume(it)}>
                    ▶ 再開
                  </button>
                )}
                {/* 募集・再投稿は締切まで（締切後の投稿はサーバーが拒否する＝cron 共通ルール 2。押してもエラーになるだけなので出さない） */}
                {!o.planning_id && ((st === '予定' && !dlMissed) || (st === '投稿済み' && !dlPassed)) && (
                  <button className="btn sm secondary" onClick={() => recruitOne(it)}>
                    {st === '投稿済み' ? '📣 再投稿' : `📣 今すぐ${n.requires_response === 0 ? '告知' : '募集'}`}
                  </button>
                )}
                {!o.planning_id && (st === '予定' || st === '投稿済み') && (
                  <button className="btn sm secondary" onClick={() => suppress(it)}>
                    🚫 中止
                  </button>
                )}
                {!virtual && (
                  <button className="btn sm secondary" onClick={() => onOpenGrouping(n.uuid, o.uuid)}>
                    {st === '予定' || st === '投稿済み' ? 'メンバー配置' : '配置を見る'}
                  </button>
                )}
                {oneOff && (
                  <>
                    <span className="muted" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }} title="オフにすると自動送信の対象外になります">
                      <Switch aria-label={`${n.name} を有効にする（自動送信の対象）`} checked={!!n.active} onChange={(e) => toggleActive(n, e.target.checked)} />
                      {n.active ? '有効' : '無効'}
                    </span>
                    <button className="btn sm secondary" onClick={() => onEditSchedule(n.uuid)}>✏️ 編集</button>
                    <button className="btn sm secondary" onClick={() => onCopySchedule(n.uuid)}>⧉ 複製</button>
                    <button className="btn sm secondary" onClick={() => removeOneOff(n)}>🗑 削除</button>
                  </>
                )}
              </div>
            </div>
          );
        })
      )}
      <FormDialog
        open={adhocOpen}
        title="開催日時を追加"
        onClose={() => setAdhocOpen(false)}
        footer={
          <>
            <button className="btn ghost" onClick={() => setAdhocOpen(false)}>
              キャンセル
            </button>
            <button className="btn" onClick={(e) => addAdhoc(e.currentTarget)}>
              追加する
            </button>
          </>
        }
      >
        {(() => {
          const base = notifs.find((x) => x.uuid === adhocNotif);
          const irregular = !!base && !base.rrule;
          const announceOnly = base?.requires_response === 0;
          const noun = announceOnly ? '告知' : '募集';
          const hours = Array.from({ length: 24 }, (_, h) => (
            <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>
          ));
          const days = (v: string, set: (s: string) => void) => (
            <input type="number" min={0} value={v} onChange={(e) => set(e.target.value)} />
          );
          const target = (label: string, v: 'dm' | 'channel', set: (t: 'dm' | 'channel') => void) => (
            <select aria-label={label} value={v} onChange={(e) => set(e.target.value as 'dm' | 'channel')}>
              <option value="dm">本人へDM</option>
              <option value="channel">投稿チャンネルに投稿（個別メンション）</option>
            </select>
          );
          // テンプレート編集の「投稿の流れ」と同じ工程カード（スイッチ＝自動で行うか）。onToggle が無いカードは案内だけ
          const card = (c: { icon: string; title: string; chip: string; on: boolean; onToggle?: (on: boolean) => void; offText: React.ReactNode; body: React.ReactNode }) => (
            <div className={`nf2-tl-node${c.on ? '' : ' off'}`}>
              <div className="nf2-tl-card">
                <div className="nf2-tl-title">
                  <span>{c.icon} {c.title}</span>
                  <span className="pill">{c.chip}</span>
                  {c.onToggle && (
                    <span className="nf2-tl-switch" title={c.on ? 'オン＝自動で行う' : 'オフ＝自動では行わない'}>
                      <Switch aria-label={`${c.title}を自動で行う`} checked={c.on} onChange={(e) => c.onToggle!(e.target.checked)} />
                    </span>
                  )}
                </div>
                {c.on ? c.body : <div className="nf2-tl-off">{c.offText}</div>}
              </div>
            </div>
          );
          const targetChip = (t: 'dm' | 'channel') => (t === 'channel' ? '📢 チャンネル投稿' : '✉️ 個別DM');
          return (
            <>
              <p className="muted adhoc-lead">
                {irregular
                  ? 'テンプレートの区分・ペア制約・配置設定を引き継いで開催日時を追加します。送信時刻と投稿の流れは、この開催日時の分だけここで決めます。'
                  : '定期のテンプレートに、振替・コラボなどの開催日時を追加します。区分・ペア制約・配置設定と投稿設定はテンプレートに従います。'}
              </p>

              <div className="subhead">🗓️ 開催日時</div>
              <label>
                対象のテンプレート
                <select
                  value={adhocNotif}
                  onChange={(e) => {
                    setAdhocNotif(e.target.value);
                    const next = notifs.find((x) => x.uuid === e.target.value);
                    // 定期はテンプレートの開始時刻を初期値に、単発は空欄から（テンプレートに開始時刻の入力欄が無いため）
                    setAdhocTime(next?.rrule ? next.start_time || '' : '');
                    setAdhocFlow(flowFrom(next));
                  }}
                >
                  {notifs.map((n) => (
                    <option key={n.uuid} value={n.uuid}>
                      {n.name}
                      {n.rrule ? '' : '（不定期）'}
                    </option>
                  ))}
                </select>
              </label>
              <div className={`row${irregular ? ' adhoc-when' : ''}`}>
                <label>
                  日付 <span className="req">✱</span>
                  <input type="date" value={adhocDate} onChange={(e) => setAdhocDate(e.target.value)} />
                </label>
                <label>
                  開始時刻 {irregular && <span className="req">✱</span>}
                  <input type="time" value={adhocTime} onChange={(e) => setAdhocTime(e.target.value)} />
                </label>
                {irregular && (
                  <label>
                    開催時間（分）
                    <input type="number" min={1} value={adhocDuration} onChange={(e) => setAdhocDuration(e.target.value)} placeholder="例: 120" />
                  </label>
                )}
              </div>
              {irregular && (
                <p className="muted adhoc-hint">
                  開催時間を入れると「21:00〜23:00」のように表示します。空欄なら「21:00〜」と表示し、開催日の終わりに「終了」になります。
                </p>
              )}
              <label>
                補足メッセージ <span className="muted">（任意・{noun}メッセージに掲載）</span>
                <textarea
                  value={adhocNote}
                  onChange={(e) => setAdhocNote(e.target.value)}
                  placeholder={'例: 〇〇さんとのコラボ回です！\n例: 〇〇の事前の練習会です！'}
                  rows={2}
                  maxLength={500}
                />
              </label>

              {irregular && (
                <>
                  <div className="subhead">📤 送信時刻と投稿の流れ</div>
                  <div className="setting-row">
                    <div className="setting-row-main">
                      <div className="setting-row-title">🕘 送信時刻</div>
                      <div className="setting-row-desc">{noun}・リマインドなど日単位の送信を、毎日この時刻（JST）にまとめて行います。</div>
                    </div>
                    <div className="setting-row-control">
                      <select aria-label="送信時刻" value={adhocFlow.sendHour} onChange={(e) => patchFlow({ sendHour: e.target.value })}>
                        {hours}
                      </select>
                    </div>
                  </div>
                  <div className="nf2-tl adhoc-tl">
                    {card({
                      icon: '📣', title: `${noun}を投稿`, chip: '📢 チャンネル投稿', on: adhocFlow.recruitOn,
                      onToggle: (on) => patchFlow({ recruitOn: on }),
                      offText: `自動では投稿しません。追加後に「📣 今すぐ${noun}」で投稿します${announceOnly ? '' : '（リマインドと回答締切はその投稿の後から）'}。`,
                      body: (
                        <div className="nf2-tl-inline">
                          <span>開催の</span>
                          {days(adhocFlow.recruitDays, (v) => patchFlow({ recruitDays: v }))}
                          <span>日前に投稿</span>
                          {Number(adhocFlow.recruitDays) === 0 && <span className="muted">＝ 当日</span>}
                        </div>
                      ),
                    })}
                    {!announceOnly && card({
                      icon: '✉️', title: '未回答者へリマインド', chip: targetChip(adhocFlow.unansweredTarget), on: adhocFlow.unansweredOn,
                      onToggle: (on) => patchFlow({ unansweredOn: on }),
                      offText: '送りません。',
                      body: (
                        <div className="nf2-tl-inline">
                          <span>開催の</span>
                          {days(adhocFlow.unansweredDays, (v) => patchFlow({ unansweredDays: v }))}
                          <span>日前から毎日、未回答のメンバーへ</span>
                          {target('未回答リマインドの送り先', adhocFlow.unansweredTarget, (t) => patchFlow({ unansweredTarget: t }))}
                        </div>
                      ),
                    })}
                    {!announceOnly && card({
                      icon: '✉️', title: '未定者へリマインド', chip: targetChip(adhocFlow.undecidedTarget), on: adhocFlow.undecidedOn,
                      onToggle: (on) => patchFlow({ undecidedOn: on }),
                      offText: '送りません。',
                      body: (
                        <div className="nf2-tl-inline">
                          <span>開催の</span>
                          {days(adhocFlow.undecidedDays, (v) => patchFlow({ undecidedDays: v }))}
                          <span>日前から毎日、「未定」回答のメンバーへ</span>
                          {target('未定リマインドの送り先', adhocFlow.undecidedTarget, (t) => patchFlow({ undecidedTarget: t }))}
                        </div>
                      ),
                    })}
                    {!announceOnly && (adhocFlow.recruitOn
                      ? card({
                          icon: '⏰', title: '回答締切', chip: '📢 チャンネル投稿', on: adhocDeadlineOn,
                          onToggle: (on) => { setAdhocDeadlineOn(on); if (on && adhocDeadline.trim() === '') setAdhocDeadline('24'); },
                          offText: '締め切りません（開催までいつでも回答できます）。',
                          body: (
                            <>
                              <div className="nf2-tl-inline">
                                <span>開始の</span>
                                {days(adhocDeadline, setAdhocDeadline)}
                                <span>時間前に締め切る</span>
                              </div>
                              <div className="nf2-tl-eventdesc">締切時刻に「回答を締め切りました」をチャンネルへ投稿し、以後の回答変更を管理者向けのチャンネルへ投稿します。募集の投稿予定より前の締切は登録できません。登録後は変更できません（中止→再登録）。</div>
                            </>
                          ),
                        })
                      : card({
                          icon: '⏰', title: '回答締切', chip: '📢 チャンネル投稿', on: false,
                          offText: '「📣 今すぐ募集」で投稿するときに選びます（募集の自動投稿がオフのため）。',
                          body: null,
                        }))}
                  </div>
                </>
              )}
            </>
          );
        })()}
      </FormDialog>
      <FormDialog
        open={!!dlAsk}
        title="今すぐ募集"
        onClose={() => setDlAsk(null)}
        footer={
          <>
            <button className="btn ghost" onClick={() => setDlAsk(null)}>
              キャンセル
            </button>
            <button
              className="btn"
              onClick={async () => {
                const it = dlAsk;
                if (!it) return;
                const hours = dlHours.trim() === '' ? null : Number(dlHours);
                setDlAsk(null);
                // 📣 と同じ送信中ガード（投稿中に 📣 を押し直して重ねて送らない）
                await once(`recruit:${it.n.uuid}:${it.o.occurrence_date}:${it.o.start_time}`, async () => {
                  // 締切は投稿できたときだけ画面に反映する（失敗後の再操作で締切入力を飛ばして締切なしで投稿しない・レビュー #8）
                  const sent = await postRecruit(it, it.o, '募集', { response_deadline_hours: hours });
                  if (sent && hours != null) setItems((cur) => cur.map((x) => (x === it ? { ...x, o: { ...x.o, response_deadline_hours: hours } } : x)));
                });
              }}
            >
              投稿する
            </button>
          </>
        }
      >
        <p className="muted" style={{ marginTop: 0 }}>
          {dlAsk ? `${occLabel(dlAsk.o, durOf(dlAsk.o, dlAsk.n))}（${dlAsk.n.name}）` : ''}の募集メッセージを今すぐチャンネルへ投稿します。
          回答締切を付ける場合は時間を入れてください。投稿後は締切も日時も変更できません（{oneOff ? '中止して「⧉ 複製」で作り直す' : '中止→再登録'}）。
        </p>
        <label>
          回答締切（開始の何時間前・空欄＝締切なし）
          <input type="number" min={0} value={dlHours} onChange={(e) => setDlHours(e.target.value)} placeholder="例: 24" autoFocus />
        </label>
      </FormDialog>
    </div>
  );
}

// 定期／単発出欠確認の「流れと、どこで何を決めるか」（日程調整の表と同じ形・2026-09-23）。運用一覧と基本設定の編集画面の見出しの上に置く。
// 行は「テンプレート作成・編集画面（一度決める設定）」と運用画面（開催日時ごとの作業）。文言は各画面の項目名に合わせて保つ。
// 定期の募集は常に自動（手動投稿は不定期だけ・NotificationFormV2 の effRecruitOn）。単発は開催日時を手で登録し、回答締切も開催日時ごと（ADR 0032）。
// 左端の群列と画面名（定期・単発で共通）
const PRESET = '事前設定', OPERATION = '出欠管理者の​画面操作';
const TEMPLATE_SCREEN = 'テンプレート作成・​編集画面', TEMPLATE_LEAD = '一度決めれば、毎回の開催日時で使い回せる設定', OPERATION_LEAD = '開催日時ごとに行う作業';
const MEMBER_SETTINGS = '配置結果の投稿先とペア制約（一覧の「メンバー配置設定」）';
const REMIND_SETTINGS = ['未回答・未定の人へリマインドする時期', 'リマインドの送り先（DM／チャンネル）', '参加間隔が空いた人への督促（ノルマ）'];
const SCHEDULE_FLOWS: Record<ScheduleKind, { steps: string[]; actors: string[]; rows: FlowRow[] }> = {
  regular: {
    steps: ['募集の投稿', '出欠の回答', 'リマインド', '回答締切', 'メンバー配置'],
    actors: ['Bot', 'イベントメンバー', 'Bot', 'Bot', '出欠管理者'],
    rows: [
      [OPERATION, '定期出欠確認画面', OPERATION_LEAD, [
        ['（イレギュラーケース）', '前倒しや出し直しは「📣 今すぐ募集」「📣 再投稿」', '臨時の開催日時の追加・中止'],
        [],
        [],
        [],
        ['「メンバー配置」で担当を決めて投稿する'],
      ]],
      [PRESET, TEMPLATE_SCREEN, TEMPLATE_LEAD, [
        ['開催日時と繰り返し', '投稿チャンネルとメンション', '見出しと本文', '何日前に募集を投稿するか'],
        ['回答してもらうメンバーの区分', '他の回答者の回答を見せるか'],
        REMIND_SETTINGS,
        ['回答締切（開始の何時間前）', '締切後の変更を知らせるチャンネル'],
        [MEMBER_SETTINGS],
      ]],
    ],
  },
  irregular: {
    steps: ['開催日時の登録', '募集の投稿', '出欠の回答', 'リマインド', '回答締切', 'メンバー配置'],
    actors: ['出欠管理者', 'Bot／出欠管理者', 'イベントメンバー', 'Bot', 'Bot', '出欠管理者'],
    rows: [
      [OPERATION, '不定期出欠確認画面', OPERATION_LEAD, [
        ['「＋ 開催日時を追加」で日付・開始時刻・開催時間・送信時刻・回答締切・未回答・未定の人へリマインドする時期と送り先・補足メッセージを登録する', '開催日時の中止'],
        ['募集を自動で投稿するか（何日前か）は開催日時の追加時に決める', '手動投稿や出し直しは「📣 今すぐ募集」「📣 再投稿」'],
        [],
        [],
        [],
        ['「メンバー配置」で担当を決めて投稿する'],
      ]],
      [PRESET, TEMPLATE_SCREEN, TEMPLATE_LEAD, [
        [],
        ['投稿チャンネルとメンション', '見出しと本文'],
        ['回答してもらうメンバーの区分', '他の回答者の回答を見せるか'],
        ['参加間隔が空いた人への督促（ノルマ）'],
        ['締切後の変更を知らせるチャンネル'],
        [MEMBER_SETTINGS],
      ]],
    ],
  },
  // 単発はテンプレート（事前設定）が無い。作成画面ですべて決める（2026-10-02）
  oneoff: {
    steps: ['作成', '募集の投稿', '出欠の回答', 'リマインド', '回答締切', 'メンバー配置'],
    actors: ['出欠管理者', 'Bot／出欠管理者', 'イベントメンバー', 'Bot', 'Bot', '出欠管理者'],
    rows: [
      [OPERATION, '単発出欠確認画面', '1 回分の出欠確認ごとに行う作業', [
        ['「＋ 新しく作る」で投稿先・メッセージ・開催日時・投稿の流れをまとめて登録する', '前回の内容を使うなら「⧉ 複製」'],
        ['募集を自動で投稿するか（何日前か）は作成時に決める', '手動投稿や出し直しは「📣 今すぐ募集」「📣 再投稿」'],
        [],
        ['リマインドの時期と送り先は作成時に決める'],
        ['回答締切は作成時に決める（手動投稿なら投稿時）'],
        ['「メンバー配置」で担当を決めて投稿する'],
      ]],
    ],
  },
};
export function ScheduleFlow({ kind }: { kind: ScheduleKind }) {
  const f = SCHEDULE_FLOWS[kind], label = SCHEDULE_LABELS[kind];
  return (
    <FlowGuide
      summary={`${label}の流れと、どこで何を決めるか`}
      lead={kind === 'oneoff'
        ? `1〜${f.steps.length} の順に進みます。テンプレートは使わず、作成画面で 1 回分の設定をすべて決めます。`
        : `開催日時ごとに 1〜${f.steps.length} の順に進みます。上の段は開催日時ごとに行うこと、下の段（点線の下）はテンプレートで一度だけ決めておくことです。`}
      corner={`${label}フロー`}
      steps={f.steps}
      actors={f.actors}
      rows={f.rows}
      storageKey={`eventbot_${kind}_flow_open`}
    />
  );
}
