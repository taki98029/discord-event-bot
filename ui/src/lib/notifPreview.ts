// スケジュールフォームの「募集/告知メッセージ簡易プレビュー」と「送信タイムライン整合性チェック」。
// 旧 buildRecruitPreviewText()/notifPreview() の純関数移植（DOM 非依存）。
// 次回開催日はサーバー POST /notifications/preview-plan の先頭日（フォームが渡す）。無ければ相対表示。

export type PreviewInput = {
  title: string;
  body: string;
  /** 次回の開催日 'YYYY/MM/DD'（preview-plan の dates[0]）。null=未確定（不定期・計算前） */
  nextDate: string | null;
  startTime: string;
  duration: number | null;
  deadlineHours: number | null;
  mention: 'role' | 'members' | 'none';
  requireResponse: boolean;
};

/** 日時・締切の計算済みテキスト */
export type PreviewParts = {
  mention: string | null;
  dateText: string;
  deadline: string | null;
};

/** 完全再現ではなく、フォーム入力に即時追従する部分のみの近似（メンションは簡略化）。 */
export function buildRecruitPreviewParts(v: PreviewInput): PreviewParts {
  let mention: string | null = null;
  if (v.mention === 'role') mention = '@ロール or @everyone';
  else if (v.mention === 'members') mention = '@対象メンバー全員';

  let dateStr = '(次回開催日)';
  if (v.nextDate) {
    const [y, m, d] = v.nextDate.split('/').map(Number);
    dateStr = `${v.nextDate} (${'日月火水木金土'[new Date(y, m - 1, d).getDay()]})`;
  }

  let timeStr = v.startTime || '--:--';
  if (v.startTime && Number.isInteger(v.duration) && (v.duration as number) > 0) {
    const [h, m] = v.startTime.split(':').map(Number);
    const total = h * 60 + m + (v.duration as number);
    const eh = Math.floor(total / 60) % 24;
    const em = total % 60;
    timeStr = `${v.startTime}〜${String(eh).padStart(2, '0')}:${String(em).padStart(2, '0')}`;
  } else if (v.startTime) {
    timeStr = `${v.startTime}〜`;
  }
  let deadline: string | null = null;
  if (v.requireResponse && Number.isFinite(v.deadlineHours) && (v.deadlineHours as number) > 0 && v.nextDate && v.startTime) {
    const [yy, mm, dd] = v.nextDate.split('/').map(Number);
    const [hh, mi] = v.startTime.split(':').map(Number);
    const evt = new Date(yy, mm - 1, dd, hh, mi);
    evt.setHours(evt.getHours() - (v.deadlineHours as number));
    deadline = `${evt.getFullYear()}/${String(evt.getMonth() + 1).padStart(2, '0')}/${String(evt.getDate()).padStart(2, '0')} ${String(evt.getHours()).padStart(2, '0')}:${String(evt.getMinutes()).padStart(2, '0')}`;
  }

  // 日付も時刻も無い＝単発出欠確認のテンプレート（開催日時ごとに登録する）
  return { mention, dateText: !v.nextDate && !v.startTime ? '(開催日時)' : `${dateStr} ${timeStr}`, deadline };
}

export type TimelineInput = {
  requireResponse: boolean;
  /** null＝工程オフ（募集は手動投稿・リマインドは送らない）。未入力は NaN（「—」表示・警告は出さない） */
  recruitDays: number | null;
  remindStartDays: number | null;
  remindUndecidedDays: number | null;
  /** null＝締切なし */
  deadlineHours: number | null;
  sendHour: number;
  scheduleText: string;
};

/** 配信タイムラインの自然文プレビュー。オフの工程は文から省く（募集オフは「手動投稿」と明記）。整合性警告は flowWarnings()。 */
export function notifPreviewSummary(v: TimelineInput): string {
  const show = (n: number | null) => (n != null && isFinite(n) ? n : '—');
  const sh = String(v.sendHour).padStart(2, '0');
  const send = `毎日 ${sh}:00 に送信`;
  if (!v.requireResponse) {
    const recruit = v.recruitDays == null ? '告知は手動投稿' : `${show(v.recruitDays)}日前に告知`;
    return `${recruit} → 🎉 開催（${v.scheduleText}）／${send}`;
  }
  const parts = [v.recruitDays == null ? '募集は手動投稿' : `${show(v.recruitDays)}日前に募集`];
  if (v.remindStartDays != null)
    parts.push(`${show(v.remindStartDays)}日前から${v.deadlineHours != null ? '締切まで' : ''}毎日 未回答へ催促`);
  if (v.remindUndecidedDays != null)
    parts.push(`${show(v.remindUndecidedDays)}日前から${v.deadlineHours != null ? '締切まで' : ''}毎日 未定へ催促`);
  if (v.deadlineHours != null) parts.push(`開始${v.deadlineHours}時間前に締切`);
  parts.push(`🎉 開催（${v.scheduleText}）`);
  return parts.join(' → ') + `／${send}`;
}

// 順序ルール（flowWarnings・E1〜E6）は src/lib/flowRules.ts へ移設（admin の保存時検証と共用・2026-08-24）。
// 既存の import 先を保つためここから再エクスポートする。
export { FLOW_STEP_NAMES, flowWarnings } from '../../../src/lib/flowRules';
export type { FlowCheckInput, FlowStep, FlowWarning } from '../../../src/lib/flowRules';
