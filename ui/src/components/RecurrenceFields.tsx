import * as React from 'react';
import { Select, TextField } from '../../../design-system/src';
import { INTERVAL_MAX, MONTH_MAX_DAY, NTH, WEEKDAYS, WEEKDAYS_MON_FRI, type Freq, type RuleForm } from '../lib/rrule';

/** スケジュールと日程調整の作成リマインドで共有する周期入力。 */
const CARDS: { key: RuleForm['freq']; label: string; desc: string }[] = [
  { key: 'DAILY', label: '毎日', desc: 'N日ごとも' },
  { key: 'WEEKLY', label: '毎週', desc: '隔週・平日・複数曜日' },
  { key: 'MONTHLY', label: '毎月', desc: '第N曜 または 日付' },
  { key: 'YEARLY', label: '毎年', desc: '月日を指定' },
];
/** 間隔は数字ひとつ（1＝毎、2＝隔、N＝N…ごと）。全画面共通。 */
const INTERVAL_UNIT: Record<Freq, string> = { DAILY: '日', WEEKLY: '週', MONTHLY: 'か月', YEARLY: '年' };
const intervalHint = (freq: Freq, n: number) =>
  n === 1 ? { DAILY: '毎日', WEEKLY: '毎週', MONTHLY: '毎月', YEARLY: '毎年' }[freq]
  : n === 2 && freq === 'WEEKLY' ? '隔週'
  : n === 2 && freq === 'MONTHLY' ? '隔月'
  : '';

export function RecurrenceFields({
  rule,
  onChange: patchRule,
  unreadable = false,
  showErrors = false,
}: {
  rule: RuleForm;
  onChange: (patch: Partial<RuleForm>) => void;
  unreadable?: boolean;
  showErrors?: boolean;
}) {
  const freq = rule.freq === 'IRREGULAR' ? 'WEEKLY' : rule.freq;
  // 毎年: 月を変えて日がその月に無くなったら最終日に寄せ、その旨を一言出す（実在しない月日は保存させない）
  const [dayClamped, setDayClamped] = React.useState<{ month: number; day: number } | null>(null);
  const yearMaxDay = MONTH_MAX_DAY[rule.yearMonth - 1] ?? 31;
  const intervalBad =
    !Number.isInteger(rule.interval) || rule.interval < 1 || rule.interval > INTERVAL_MAX[freq];
  const fieldErr = (condition: boolean, message: string) =>
    condition && showErrors ? (
      <p className="nf2-field-err" role="alert">
        {message}
      </p>
    ) : null;
  return (
    <>
      <label>繰り返し</label>
      <div className="nf2-modes nf2-modes-5" role="radiogroup" aria-label="繰り返し">
        {CARDS.map((c) => (
          <button
            type="button"
            key={c.key}
            role="radio"
            aria-checked={!unreadable && rule.freq === c.key}
            className={'nf2-mode' + (!unreadable && rule.freq === c.key ? ' on' : '')}
            onClick={() => patchRule({ freq: c.key, interval: 1 })}
          >
            <span className="nf2-mode-title">{c.label}</span>
            <span className="nf2-mode-desc">{c.desc}</span>
          </button>
        ))}
      </div>
      {rule.freq === 'WEEKLY' && (
        <>
          <label>
            曜日 <span className="muted">（複数選択可）</span>
          </label>
          <div className="nf2-chips" role="group" aria-label="曜日">
            {WEEKDAYS.map(([v, l]) => {
              const on = rule.weekdays.includes(v);
              return (
                <button
                  type="button"
                  key={v}
                  role="checkbox"
                  aria-checked={on}
                  className={'nf2-chip' + (on ? ' on' : '')}
                  onClick={() =>
                    patchRule({ weekdays: on ? rule.weekdays.filter((x) => x !== v) : [...rule.weekdays, v] })
                  }
                >
                  {l}
                </button>
              );
            })}
            <button
              type="button"
              className="btn xs ghost"
              onClick={() => patchRule({ weekdays: [...WEEKDAYS_MON_FRI] })}
            >
              平日
            </button>
            <button
              type="button"
              className="btn xs ghost"
              onClick={() => patchRule({ weekdays: ['SA', 'SU'] })}
            >
              週末
            </button>
          </div>
          {fieldErr(!rule.weekdays.length, '曜日を 1 つ以上選んでください')}
        </>
      )}

      {rule.freq === 'MONTHLY' && (
        <>
          <label>指定方法</label>
          <div className="nf2-seg" role="radiogroup" aria-label="毎月の指定方法">
            {(
              [
                ['byday', '第N曜'],
                ['bymonthday', '日付'],
              ] as const
            ).map(([k, l]) => (
              <button
                type="button"
                key={k}
                role="radio"
                aria-checked={rule.monthlyMode === k}
                className={'nf2-seg-btn' + (rule.monthlyMode === k ? ' on' : '')}
                onClick={() => patchRule({ monthlyMode: k })}
              >
                {l}
              </button>
            ))}
          </div>
          {rule.monthlyMode === 'byday' ? (
            <div>
              <label>日程（第N × 曜日・複数可）</label>
              <div className="timechips">
                {rule.monthlyRules.map((r, i) => (
                  <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <Select
                      style={{ width: 'auto' }}
                      aria-label="第N"
                      value={r.nth}
                      onChange={(e) =>
                        patchRule({
                          monthlyRules: rule.monthlyRules.map((x, xi) =>
                            xi === i ? { ...x, nth: e.target.value } : x,
                          ),
                        })
                      }
                    >
                      {NTH.map(([v, l]) => (
                        <option key={v} value={v}>
                          {l}
                        </option>
                      ))}
                    </Select>
                    <Select
                      style={{ width: 'auto' }}
                      aria-label="曜日"
                      value={r.byday}
                      onChange={(e) =>
                        patchRule({
                          monthlyRules: rule.monthlyRules.map((x, xi) =>
                            xi === i ? { ...x, byday: e.target.value } : x,
                          ),
                        })
                      }
                    >
                      {WEEKDAYS.map(([v, l]) => (
                        <option key={v} value={v}>
                          {l}曜
                        </option>
                      ))}
                    </Select>
                    <button
                      type="button"
                      className="btn xs ghost"
                      aria-label="この繰り返しを削除"
                      disabled={rule.monthlyRules.length <= 1}
                      onClick={() =>
                        patchRule({ monthlyRules: rule.monthlyRules.filter((_, xi) => xi !== i) })
                      }
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
              <button
                type="button"
                className="btn sm secondary"
                style={{ marginTop: 4 }}
                onClick={() => patchRule({ monthlyRules: [...rule.monthlyRules, { nth: '1', byday: 'SU' }] })}
              >
                ＋ 繰り返しを追加
              </button>
              <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                例: 第1・第3・第5 日曜／第1日曜＋第3火曜。「第5」は5週ある月のみ・「最終」は常に最後の週。
              </p>
            </div>
          ) : (
            <div>
              <label>
                日付 <span className="muted">（複数選択可）</span>
              </label>
              <div className="nf2-chips" role="group" aria-label="日付">
                {[...Array.from({ length: 31 }, (_, i) => i + 1), -1].map((d) => {
                  const on = rule.monthDays.includes(d);
                  return (
                    <button
                      type="button"
                      key={d}
                      role="checkbox"
                      aria-checked={on}
                      className={'nf2-chip' + (d === -1 ? ' wide' : '') + (on ? ' on' : '')}
                      onClick={() =>
                        patchRule({
                          monthDays: on ? rule.monthDays.filter((x) => x !== d) : [...rule.monthDays, d],
                        })
                      }
                    >
                      {d === -1 ? '月末' : d}
                    </button>
                  );
                })}
              </div>
              {rule.monthDays.some((d) => d >= 29) && (
                <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                  29〜31日は、その日が無い月はスキップされます。毎月末に指定するなら「月末」を選んでください。
                </p>
              )}
              {fieldErr(!rule.monthDays.length, '日付を 1 つ以上選んでください')}
            </div>
          )}
        </>
      )}

      {rule.freq === 'YEARLY' && (
        <>
          <label>月日</label>
          <div className="nf2-inline">
            <Select
              style={{ width: 'auto' }}
              aria-label="月"
              value={rule.yearMonth}
              onChange={(e) => {
                const month = Number(e.target.value);
                const max = MONTH_MAX_DAY[month - 1];
                setDayClamped(rule.yearDay > max ? { month, day: max } : null);
                patchRule(rule.yearDay > max ? { yearMonth: month, yearDay: max } : { yearMonth: month });
              }}
            >
              {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                <option key={m} value={m}>
                  {m}月
                </option>
              ))}
            </Select>
            <Select
              style={{ width: 'auto' }}
              aria-label="日"
              value={rule.yearDay}
              onChange={(e) => {
                setDayClamped(null);
                patchRule({ yearDay: Number(e.target.value) });
              }}
            >
              {Array.from({ length: yearMaxDay }, (_, i) => i + 1).map((d) => (
                <option key={d} value={d}>
                  {d}日
                </option>
              ))}
            </Select>
          </div>
          {rule.yearMonth === 2 && rule.yearDay === 29 && (
            <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
              2月29日はうるう年（4年に1回）だけ開催されます。
            </p>
          )}
          {dayClamped && dayClamped.month === rule.yearMonth && dayClamped.day === rule.yearDay && (
            <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
              {dayClamped.month}月は{dayClamped.day}日までなので、{dayClamped.day}日にしました。
            </p>
          )}
        </>
      )}

      {rule.freq !== 'IRREGULAR' && !unreadable && (
        <>
          <label>間隔</label>
          <div className="nf2-inline">
            <TextField
              type="number"
              min={1}
              max={INTERVAL_MAX[freq]}
              aria-label="間隔"
              style={{ width: 80 }}
              value={Number.isFinite(rule.interval) ? String(rule.interval) : ''}
              onChange={(e) => patchRule({ interval: e.target.value === '' ? NaN : Number(e.target.value) })}
            />
            <span className="muted">
              {INTERVAL_UNIT[freq]}ごと（1〜{INTERVAL_MAX[freq]}）
              {intervalHint(freq, rule.interval) && ` ＝ ${intervalHint(freq, rule.interval)}`}
            </span>
          </div>
          {fieldErr(intervalBad, `間隔は 1〜${INTERVAL_MAX[freq]} で指定してください`)}
        </>
      )}
    </>
  );
}
