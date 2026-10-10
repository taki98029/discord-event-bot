import * as React from 'react';
import { useEffect, useState } from 'react';
import { pickable } from '../lib/channels';
import { api, type Guild } from '../api';
import { confirmDialog, withBusy } from '../lib/dialog';
import type { ToastFn } from '../App';
import type { FailureNotificationSettings } from '../../../src/db/types';

type SetupStatus = {
  secrets: Record<string, boolean>;
  interaction_endpoint_url: string;
  /** 招待 URL（DISCORD_APPLICATION_ID 未設定なら null） */
  invite_url?: string | null;
};

const SECRET_ROWS: [string, string][] = [
  ['DISCORD_PUBLIC_KEY', '署名検証用の公開鍵（Discord → General Information）'],
  ['DISCORD_APPLICATION_ID', 'アプリID（Discord → General Information）'],
  ['DISCORD_BOT_TOKEN', 'Bot のトークン（Discord → Bot）'],
  ['ADMIN_TOKEN', 'この管理画面のパスワード（自分で決めた文字列）'],
];

export function Setup({
  guild,
  toast,
  onLeft,
  mode,
  onDirtyChange,
}: {
  guild: Guild;
  toast: ToastFn;
  onLeft: () => void;
  mode: 'setup' | 'bot-settings';
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [st, setSt] = useState<SetupStatus | null>(null);
  const [registerResult, setRegisterResult] = useState('');

  const load = () =>
    api('/setup/status').then(setSt, (e) => toast(e instanceof Error ? e.message : String(e), true));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!st) return <p className="muted">読み込み中…</p>;

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast('コピーしました');
    } catch {
      toast('コピーできませんでした。URL を手動で選択してください', true);
    }
  };
  const copyEndpoint = () => copyText(st.interaction_endpoint_url);

  const registerCommands = async (btn: HTMLElement | null) => {
    setRegisterResult('登録中…');
    await withBusy(btn, async () => {
      try {
        const r = await api('/setup/register-commands', {
          method: 'POST',
          body: JSON.stringify({ guild_id: guild.id }),
        });
        if (r && r.ok) {
          setRegisterResult(`✅ 登録しました: ${(r.names || []).map((n: string) => '/' + n).join(' ')}`);
          toast('コマンドを登録しました');
        } else {
          setRegisterResult('⚠️ ' + ((r && r.error) || '登録に失敗しました'));
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setRegisterResult('⚠️ ' + msg);
        toast(msg, true);
      }
    });
  };

  const leave = async (btn: HTMLElement | null) => {
    const ok = await confirmDialog(
      `Bot を「${guild.name || guild.id}」から退出させます。\n\n` +
        'このサーバーのテンプレートはすべて停止し、サーバー一覧から消えます。\n' +
        'データ（区分・テンプレート設定・回答履歴）は残るため、再招待すれば元に戻せます。',
      { title: 'サーバーから退出', okLabel: '退出する', danger: true },
    );
    if (!ok) return;
    await withBusy(btn, async () => {
      try {
        const r = await api('/guilds/' + guild.id + '/leave', {
          method: 'POST',
        });
        toast(`退出しました（テンプレート ${r?.deactivated ?? 0} 件を停止）`);
        onLeft();
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e), true);
      }
    });
  };

  return (
    <>
      <h2>{mode === 'setup' ? '🔰 初回設定' : '⚙️ Bot設定'}</h2>
      {mode === 'setup' ? (
        <>
          <p className="muted">初めて使うときは、1〜4 を上から順に進めてください。</p>

          <fieldset>
            <legend>1. シークレットを確認</legend>
            <p className="muted" style={{ fontSize: 13 }}>
              Cloudflare の管理画面（Settings → Variables and Secrets）で設定します。未設定があると Bot
              は動きません。
            </p>
            {SECRET_ROWS.map(([key, label]) => {
              const ok = st.secrets[key];
              return (
                <div className="pickrow" key={key}>
                  <div>
                    <b>{key}</b>
                    <br />
                    <span className="muted" style={{ fontSize: 12 }}>
                      {label}
                    </span>
                  </div>
                  <span className={'pill ' + (ok ? 'on' : 'off')}>{ok ? '設定済み' : '未設定'}</span>
                </div>
              );
            })}
            <div className="actions" style={{ marginTop: 8 }}>
              <button className="btn sm secondary" onClick={load}>
                再読み込み
              </button>
            </div>
          </fieldset>

          <fieldset>
            <legend>2. スラッシュコマンドを登録</legend>
            <p className="muted" style={{ fontSize: 13 }}>
              /manage を Discord に登録します（このサーバーへ即時反映）。
            </p>
            <div className="actions">
              <button className="btn" onClick={(e) => registerCommands(e.currentTarget)}>
                コマンドを登録
              </button>
            </div>
            <div className="muted" style={{ fontSize: 13, marginTop: 8 }}>
              {registerResult}
            </div>
          </fieldset>

          <fieldset>
            <legend>3. Interactions Endpoint URL を設定</legend>
            <p className="muted" style={{ fontSize: 13 }}>
              下の URL をコピーし、Discord Developer Portal → General Information の「Interactions Endpoint
              URL」に貼り付けて保存してください。
            </p>
            <div className="pickrow">
              <code style={{ wordBreak: 'break-all' }}>{st.interaction_endpoint_url}</code>
              <button className="btn sm" onClick={copyEndpoint}>
                コピー
              </button>
            </div>
            <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>
              続けて Discord → Bot の <b>Server Members Intent</b> を ON
              にしてください（メンバー一覧の取得に必要）。
            </p>
          </fieldset>

          <fieldset>
            <legend>4. 区分とテンプレートを作成</legend>
            <p className="muted" style={{ fontSize: 13 }}>
              左メニューの「メンバー管理」で区分を作成してメンバーを登録します。「定期出欠確認」「不定期出欠確認」「定期日程調整」から利用する機能を開き、「⚙ テンプレート作成・編集」で設定してください（1 回だけなら「単発出欠確認」「単発日程調整」の「＋ 新しく作る」からテンプレートなしで作れます）。
            </p>
          </fieldset>
        </>
      ) : (
        <>
          <FailureNotifications guild={guild} toast={toast} onDirtyChange={onDirtyChange} />
          <fieldset>
            <legend>Bot を別のサーバーに招待</legend>
            <p className="muted" style={{ fontSize: 13 }}>
              別のサーバーでもこの Bot を使うとき、退出したサーバーに戻すときは下のリンクから招待してください
              （権限はセットアップガイドと同じ）。招待後にページを再読み込みすると、サーバー一覧に表示されます。
            </p>
            {st.invite_url ? (
              <div className="pickrow">
                <a href={st.invite_url} target="_blank" rel="noreferrer" style={{ wordBreak: 'break-all' }}>
                  {st.invite_url}
                </a>
                <button className="btn sm" onClick={() => copyText(st.invite_url!)}>
                  コピー
                </button>
              </div>
            ) : (
              <p className="muted" style={{ fontSize: 13 }}>
                DISCORD_APPLICATION_ID が未設定のため作成できません（「初回設定」の 1. を確認してください）。
              </p>
            )}
          </fieldset>

          <fieldset>
            <legend>このサーバーの管理をやめる</legend>
            <p className="muted" style={{ fontSize: 13 }}>
              Bot が <b>{guild.name || guild.id}</b> から退出し、サーバー一覧から消えます。
              退出前にこのサーバーのテンプレートをすべて停止するので、以降の募集・リマインドは送られません。
              <br />
              区分・テンプレート設定・回答履歴は<b>消えません</b>。もう一度 Bot を招待すればそのまま表示され、
              必要なテンプレートは「定期出欠確認」「不定期出欠確認」の「⚙ テンプレート作成・編集」を開いて、単発出欠確認は一覧の各行の「有効」スイッチで再開できます。
            </p>
            <div className="actions">
              <button className="btn danger" onClick={(e) => leave(e.currentTarget)}>
                Bot をこのサーバーから退出させる
              </button>
            </div>
          </fieldset>
        </>
      )}
    </>
  );
}

function FailureNotifications({
  guild,
  toast,
  onDirtyChange,
}: {
  guild: Guild;
  toast: ToastFn;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [settings, setSettings] = useState<FailureNotificationSettings | null>(null);
  const [saved, setSaved] = useState('');
  const [channels, setChannels] = useState<{ id: string; name: string; enabled?: boolean }[]>([]);
  const [targets, setTargets] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState('');
  const [targetError, setTargetError] = useState('');
  const [loadingTargets, setLoadingTargets] = useState(false);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');
  const [reload, setReload] = useState(0);
  const [reloadTargets, setReloadTargets] = useState(0);
  const path = `/guilds/${guild.id}/failure-notification`;
  useEffect(() => {
    let active = true;
    setError('');
    Promise.all([api(path), api(`/guilds/${guild.id}/channels`)]).then(
      ([s, cs]) => {
        if (!active) return;
        setSettings(s);
        setSaved(JSON.stringify(s));
        setChannels(cs);
      },
      (e) => {
        if (active) setError(e.message);
      },
    );
    return () => {
      active = false;
    };
  }, [guild.id, reload]);
  const mode = settings?.mention_mode;
  useEffect(() => {
    let active = true;
    setTargets([]);
    setTargetError('');
    setSearch('');
    if (!mode || mode === 'none') {
      setLoadingTargets(false);
      return;
    }
    setLoadingTargets(true);
    api(`/guilds/${guild.id}/${mode === 'roles' ? 'roles' : 'members'}`)
      .then(
        (xs) => {
          if (active)
            setTargets(
              xs.map((x: any) => ({
                id: x.id ?? x.user_id,
                name: x.name ?? x.display_name ?? x.user_name ?? x.user_id,
              })),
            );
        },
        (e) => {
          if (active) setTargetError(e.message);
        },
      )
      .finally(() => {
        if (active) setLoadingTargets(false);
      });
    return () => {
      active = false;
    };
  }, [guild.id, mode, reloadTargets]);
  const dirty = settings !== null && JSON.stringify(settings) !== saved;
  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);
  const patch = (value: Partial<FailureNotificationSettings>) => setSettings((s) => s && { ...s, ...value });
  const missingChannel = !!settings?.channel_id && !channels.some((c) => c.id === settings.channel_id);
  const missingTargets = settings?.mention_ids.filter((id) => !targets.some((t) => t.id === id)) ?? [];
  const invalid =
    missingChannel ||
    (mode !== 'none' &&
      (loadingTargets || !!targetError || !settings?.mention_ids.length || missingTargets.length > 0));
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving || invalid || !settings) return;
    setSaving(true);
    try {
      const result = await api(path, {
        method: 'PUT',
        body: JSON.stringify(settings),
      });
      setSettings(result);
      setSaved(JSON.stringify(result));
      toast('失敗通知の設定を保存しました');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), true);
    } finally {
      setSaving(false);
    }
  };
  return (
    <fieldset>
      <legend>メッセージの送信失敗通知</legend>
      <p className="muted">
        このサーバーの募集・告知・DM・日程調整などで送信に失敗したとき、指定したチャンネルに失敗箇所を投稿します。
      </p>
      {error ? (
        <>
          <p role="alert">{error}</p>
          <button className="btn secondary sm" onClick={() => setReload((n) => n + 1)}>
            再読み込み
          </button>
        </>
      ) : !settings ? (
        <p className="muted">読み込み中…</p>
      ) : (
        <form onSubmit={save}>
          <fieldset disabled={saving} className="failure-settings-fields">
            <div className="row">
              <label>
                失敗通知の投稿先
                <select
                  value={settings.channel_id ?? ''}
                  onChange={(e) =>
                    patch(
                      e.target.value
                        ? { channel_id: e.target.value }
                        : {
                            channel_id: null,
                            mention_mode: 'none',
                            mention_ids: [],
                          },
                    )
                  }
                >
                  <option value="">投稿しない</option>
                  {missingChannel && (
                    <option value={settings.channel_id!}>取得できないチャンネル（選び直してください）</option>
                  )}
                  {pickable(channels, settings.channel_id).map((c) => (
                    <option key={c.id} value={c.id}>
                      # {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                メンション方法
                <select
                  value={mode}
                  disabled={!settings.channel_id}
                  onChange={(e) =>
                    patch({
                      mention_mode: e.target.value as FailureNotificationSettings['mention_mode'],
                      mention_ids: [],
                    })
                  }
                >
                  <option value="none">メンションしない</option>
                  <option value="users">ユーザー</option>
                  <option value="roles">ロール</option>
                </select>
              </label>
            </div>
            {mode !== 'none' && (
              <fieldset>
                <legend>メンション先（複数選択・20件まで）</legend>
                {targetError ? (
                  <>
                    <p role="alert">{targetError}</p>
                    <button
                      type="button"
                      className="btn secondary sm"
                      onClick={() => setReloadTargets((n) => n + 1)}
                    >
                      再読み込み
                    </button>
                  </>
                ) : loadingTargets ? (
                  <p className="muted">読み込み中…</p>
                ) : (
                  <>
                    <input
                      type="search"
                      aria-label="メンション先を検索"
                      placeholder="名前で検索"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                    <div className="failure-mention-list">
                      {[
                        ...targets,
                        ...missingTargets.map((id) => ({
                          id,
                          name: `取得できない宛先（選択を外してください）: ${id}`,
                        })),
                      ]
                        .filter((t) => t.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
                        .map((t) => (
                          <label className="inline" key={t.id}>
                            <input
                              type="checkbox"
                              checked={settings.mention_ids.includes(t.id)}
                              disabled={
                                !settings.mention_ids.includes(t.id) && settings.mention_ids.length >= 20
                              }
                              onChange={(e) =>
                                patch({
                                  mention_ids: e.target.checked
                                    ? [...settings.mention_ids, t.id]
                                    : settings.mention_ids.filter((id) => id !== t.id),
                                })
                              }
                            />
                            {t.name}
                          </label>
                        ))}
                    </div>
                    <p className="muted">
                      {settings.mention_ids.length}件選択中
                      {!targets.length && !missingTargets.length ? ' · 選択できる宛先がありません' : ''}
                    </p>
                  </>
                )}
              </fieldset>
            )}
            <p className="muted">
              Bot
              が投稿できるチャンネルを選んでください。ロールをメンションする場合は、そのロールへのメンションを許可するか、Bot
              に「全員にメンション」の権限が必要です。
            </p>
            <div className="actions">
              <button className="btn" disabled={!dirty || invalid || saving}>
                {saving ? '保存中…' : '保存'}
              </button>
            </div>
          </fieldset>
        </form>
      )}
    </fieldset>
  );
}
