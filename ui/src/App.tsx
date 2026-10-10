import { Planning, PlanningSettings } from './screens/Planning';
// 管理UI SPA ルート。Gate → Picker → Workspace の遷移は旧 ui/index.html と同一契約
// （TOKEN_KEY / GUILD_KEY / ハッシュ #g/<gid>/... = ADR 0016）。
import * as React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Actions,
  Main,
  NavItem,
  ServerBadge,
  ServerRail,
  ServerRailItem,
  Shell,
  SideNav,
  Topbar,
} from '../../design-system/src';
import {
  AuthError,
  GUILD_KEY,
  api,
  clearToken,
  fetchGuilds,
  getToken,
  guildIconUrl,
  invalidateGuilds,
  saveToken,
  type Guild,
} from './api';
import { ConfirmHost, confirmDialog } from './lib/dialog';
import { parseHash, routeFromRest, sectionForRoute, scheduleKind, type Route, type Section } from './lib/route';
import { NotificationsScreen } from './screens/Notifications';
import { NotifOps } from './screens/NotifOps';
import { NotificationFormV2 } from './screens/NotificationFormV2';
import { GroupingDialog } from './screens/GroupingDialog';
import { GroupingSettings } from './screens/GroupingSettings';
import { Segments } from './screens/Segments';
import { SegmentMembers } from './screens/SegmentMembers';
import { Records } from './screens/Records';
import { Reports } from './screens/Reports';
import { SendLog } from './screens/SendLog';
import { Setup } from './screens/Setup';
import { Channels } from './screens/Channels';

// 絵文字はグループ見出しにだけ付ける。VS16（️）付きで統一（🛠・🗒 は無印だと環境によりモノクロ字形になる・M19）
// 再利用する設定は各運用画面の歯車から開く。メンバーは機能共通の入口。
// tip はマウスオーバーで出す一言説明（title 属性）。
const NAV_GROUPS: { label: string; icon: string; items: { key: Section; label: string; tip?: string }[] }[] = [
  {
    label: '出欠確認', icon: '🙋',
    items: [
      { key: 'regular', label: '定期', tip: '毎週・毎月など決まった周期の開催について、出欠を自動で募集します' },
      { key: 'irregular', label: '不定期', tip: 'テンプレートを用意しておき、開催日が決まるたびに追加して出欠を募集します' },
      { key: 'oneoff', label: '単発', tip: 'テンプレートを作らずに、1回だけの開催の出欠を募集します' },
    ],
  },
  {
    label: '日程調整', icon: '🗓️',
    items: [
      { key: 'planning', label: '定期', tip: 'テンプレートを使って、毎回の開催日をメンバーの回答から決めます' },
      { key: 'oneoff-planning', label: '単発', tip: 'テンプレートを作らずに、1回分の開催日をメンバーの回答から決めます' },
    ],
  },
  {
    label: '出欠確認記録', icon: '📊',
    items: [
      { key: 'reports', label: '出勤レポート' },
      { key: 'sendlog', label: '送信履歴' },
      { key: 'records', label: '回答履歴' },
    ],
  },
  {
    label: '設定', icon: '⚙️',
    items: [
      { key: 'segments', label: 'メンバー管理' },
      { key: 'channels', label: 'チャンネル管理', tip: '投稿先の選択肢に出すチャンネルを選びます' },
      { key: 'bot-settings', label: 'Bot設定' },
      { key: 'setup', label: '初回設定' },
    ],
  },
];

/** 旧 boot() と同じ復元規則: 保存 guild があり、ハッシュが無いか一致すれば workspace 直行 */
function restoreGuild(): Guild | null {
  const saved = localStorage.getItem(GUILD_KEY);
  if (!saved) return null;
  try {
    const g = JSON.parse(saved) as Guild;
    const { guildId } = parseHash(location.hash);
    if (!guildId || guildId === g.id) return g;
  } catch {}
  return null;
}

export type ToastFn = (msg: string, err?: boolean) => void;

export function App() {
  const [token, setToken] = useState(getToken());
  const [guild, setGuild] = useState<Guild | null>(() => (getToken() ? restoreGuild() : null));
  const [toast, setToast] = useState<{ msg: string; err: boolean } | null>(null);

  const showToast: ToastFn = useCallback((msg, err = false) => {
    setToast({ msg, err });
    window.setTimeout(() => setToast((t) => (t && t.msg === msg ? null : t)), 2800);
  }, []);

  // トーストは popover で top layer に出す。showModal のダイアログの暗幕より前に出すため、出すたびに開き直して最前面へ（P2-12）
  const toastRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = toastRef.current;
    if (!toast || !el || !el.showPopover) return;
    if (!el.hasAttribute('popover')) el.setAttribute('popover', 'manual');
    if (el.matches(':popover-open')) el.hidePopover();
    el.showPopover();
  }, [toast]);

  const onApiError = useCallback(
    (e: unknown) => {
      if (e instanceof AuthError) setToken('');
      showToast(e instanceof Error ? e.message : String(e), true);
    },
    [showToast],
  );

  const login = (t: string) => {
    const v = t.trim();
    saveToken(v);
    setToken(v);
  };
  const logout = () => {
    clearToken();
    invalidateGuilds();
    setToken('');
    setGuild(null);
  };
  const selectGuild = (g: Guild) => {
    localStorage.setItem(GUILD_KEY, JSON.stringify(g));
    setGuild(g);
    location.hash = 'g/' + g.id; // サーバー切替時は子ページパスをリセット（ADR 0016）
  };
  // 退出後はそのサーバーを開けない。選択を解除してサーバー選択へ戻す（一覧も再取得）。
  const leftGuild = () => {
    localStorage.removeItem(GUILD_KEY);
    invalidateGuilds();
    setGuild(null);
    location.hash = '';
  };

  return (
    <>
      {!token ? (
        <Gate onLogin={login} />
      ) : !guild ? (
        <Picker onSelect={selectGuild} onLogout={logout} onError={onApiError} />
      ) : (
        <Workspace key={guild.id} guild={guild} onSelectGuild={selectGuild} onLogout={logout} onLeftGuild={leftGuild} onError={onApiError} toast={showToast} />
      )}
      <div ref={toastRef} className={'toast' + (toast ? ' show' : '') + (toast?.err ? ' err' : '')}>{toast?.msg}</div>
      <ConfirmHost />
    </>
  );
}

function Gate({ onLogin }: { onLogin: (t: string) => void }) {
  const [v, setV] = useState('');
  return (
    <div style={{ maxWidth: 420, margin: '80px auto' }}>
      <div className="card" style={{ cursor: 'default' }}>
        <h1>管理トークン</h1>
        <p className="muted">ADMIN_TOKEN を入力してください。</p>
        <input
          type="password"
          placeholder="ADMIN_TOKEN"
          value={v}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && onLogin(v)}
        />
        <div style={{ marginTop: 12 }}>
          <button className="btn" onClick={() => onLogin(v)}>ログイン</button>
        </div>
      </div>
    </div>
  );
}

function Picker({
  onSelect,
  onLogout,
  onError,
}: {
  onSelect: (g: Guild) => void;
  onLogout: () => void;
  onError: (e: unknown) => void;
}) {
  const [guilds, setGuilds] = useState<Guild[] | null>(null);
  // 参加サーバーが 0 件（初回・全退出後）のときだけ招待リンクを出す
  const [invite, setInvite] = useState<string | null>(null);
  const load = () => {
    setGuilds(null);
    fetchGuilds().then(
      (g) => {
        setGuilds(g);
        if (g.length === 0) api('/setup/status').then((s) => setInvite(s?.invite_url ?? null), () => {});
      },
      (e) => {
        setGuilds([]);
        onError(e);
      },
    );
  };
  useEffect(load, [onError]);
  return (
    <div>
      <Topbar>
        <h1 style={{ margin: 0 }}>🗓️ EventBot 管理</h1>
        <button className="btn secondary" onClick={onLogout}>ログアウト</button>
      </Topbar>
      <main style={{ maxWidth: 760, margin: '0 auto' }}>
        <h2>管理するサーバーを選択</h2>
        <p className="muted">Bot が参加しているサーバーから選びます（Discord から自動取得）。</p>
        <div className="grid-cards">
          {guilds === null ? (
            <p className="muted">読み込み中…</p>
          ) : guilds.length === 0 ? (
            <div>
              <p className="muted">参加サーバーが取得できませんでした。bot トークン / 権限を確認してください。</p>
              {invite && (
                <p className="muted">
                  Bot をまだサーバーに招待していない場合は{' '}
                  <a href={invite} target="_blank" rel="noreferrer">
                    招待リンクを開く
                  </a>
                  （招待後に「再読み込み」）。
                </p>
              )}
              <button
                className="btn sm secondary"
                onClick={() => {
                  invalidateGuilds();
                  load();
                }}
              >
                再読み込み
              </button>
            </div>
          ) : (
            guilds.map((g) => (
              <button key={g.id} type="button" className="card" onClick={() => onSelect(g)}>
                <ServerBadge
                  name={<div style={{ fontWeight: 600 }}>{g.name}</div>}
                  subtitle={'ID: ' + g.id}
                  fallback={<GuildIcon g={g} />}
                />
              </button>
            ))
          )}
        </div>
      </main>
    </div>
  );
}

function GuildIcon({ g }: { g: Guild }) {
  const u = guildIconUrl(g);
  return u ? <img src={u} alt="" loading="lazy" /> : <>{(g.name || '?').slice(0, 1)}</>;
}

/** 表示中の Workspace のサーバー（Workspace は guild.id を key に作り直すので、古い画面の遅れた navigate を見分ける） */
let activeGuildId = '';
function Workspace({
  guild,
  onSelectGuild,
  onLogout,
  onLeftGuild,
  onError,
  toast,
}: {
  guild: Guild;
  onSelectGuild: (g: Guild) => void;
  onLogout: () => void;
  onLeftGuild: () => void;
  onError: (e: unknown) => void;
  toast: ToastFn;
}) {
  const [guilds, setGuilds] = useState<Guild[]>([]);
  const [rest, setRest] = useState<string[]>(() => parseHash(location.hash).rest);
  const [dirty, updateDirty] = useState(false);
  const [listKey, setListKey] = useState(0); // 一覧の再フェッチトリガ（子ページからの戻り時）
  const historyIndex = useRef<number>(history.state?.eventbotIndex ?? 0);
  const dirtyRef = useRef(dirty);
  const setDirty = useCallback((value: boolean) => {
    // 子画面で破棄・保存した直後の hashchange にも、最新の状態を渡す。
    dirtyRef.current = value;
    updateDirty(value);
  }, []);

  useEffect(() => {
    fetchGuilds().then(setGuilds, () => {}); // rail はベストエフォート（旧実装踏襲）
  }, []);

  useEffect(() => {
    history.replaceState({ ...history.state, eventbotIndex: historyIndex.current }, '', location.href);
    let confirming = false;
    let restored: (() => void) | undefined;
    const onHashChange = async () => {
      const next = location.hash;
      const parsed = parseHash(next);
      if (parsed.guildId !== guild.id) return;
      const nextIndex: number = history.state?.eventbotIndex ?? historyIndex.current + 1;
      history.replaceState({ ...history.state, eventbotIndex: nextIndex }, '', next);
      if (nextIndex === historyIndex.current) {
        restored?.();
        restored = undefined;
        return;
      }
      if (dirtyRef.current) {
        // URL の書き換えでは戻る履歴が消えるため、元の履歴位置へ戻してから確認する。
        const delta = nextIndex - historyIndex.current;
        const restoration = confirming ? null : new Promise<void>(resolve => { restored = resolve; });
        history.go(-delta);
        if (confirming) return;
        confirming = true;
        await restoration;
        const discard = await confirmDialog('未保存の変更があります。破棄して移動しますか？', { okLabel: '破棄する', danger: true });
        confirming = false;
        if (discard) {
          setDirty(false);
          history.go(delta);
        }
        return;
      }
      historyIndex.current = nextIndex;
      setRest(parsed.rest);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [guild.id]);

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  const route: Route = routeFromRest(rest);
  const sec = sectionForRoute(route);
  const scope = route.scope ?? (sec === 'irregular' || sec === 'oneoff' ? sec : 'regular');
  useEffect(() => {
    document.querySelector('.side .navitem.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [sec]);

  activeGuildId = guild.id;
  // サーバー選択画面へ戻ったとき（退出・ログアウト）も、前のサーバーの遅れた navigate を止める
  useEffect(() => () => {
    if (activeGuildId === guild.id) activeGuildId = '';
  }, [guild.id]);
  const navigate = useCallback(
    (subpath: string, replace = false) => {
      // 保存中にサーバーを切り替えたあと、前のサーバーの画面から遅れて呼ばれた移動は無視する（URL と表示が食い違っていた）
      if (activeGuildId !== guild.id) return;
      const base = 'g/' + guild.id;
      const next = '#' + (subpath ? base + '/' + subpath : base);
      if (replace) {
        history.replaceState(history.state, '', next);
        setRest(subpath ? subpath.split('/').filter(Boolean) : []);
      } else if (location.hash === next) setRest(subpath ? subpath.split('/').filter(Boolean) : []);
      else location.hash = next;
    },
    [guild.id],
  );

  const selectSection = async (s: Section) => {
    if (dirty) {
      const ok = await confirmDialog('未保存の変更があります。破棄して移動しますか？', { okLabel: '破棄する', danger: true });
      if (!ok) return;
    }
    setDirty(false);
    navigate(s);
  };

  // 保存済みの旧URLはスケジュールの実際の種別を読み、対応する入口へ引き継ぐ。
  const legacyUuid = !route.scope && 'nuuid' in route ? route.nuuid : undefined;
  const legacyPath = rest.join('/');
  const [legacyError, setLegacyError] = useState('');
  const [legacyRetry, setLegacyRetry] = useState(0);
  useEffect(() => {
    setLegacyError('');
    if (!legacyUuid) return;
    let alive = true;
    api(`/notifications/${legacyUuid}`).then(n => {
      if (alive) navigate(`${scheduleKind(n)}/${legacyPath}`, true);
    }, e => {
      if (alive) { setLegacyError(e.message); onError(e); }
    });
    return () => { alive = false; };
  }, [legacyUuid, legacyPath, legacyRetry, navigate, onError]);

  const backToList = () => {
    setListKey((k) => k + 1);
    // 単発は作成・編集のあとも出欠一覧へ戻る（テンプレート一覧を経由しない）
    navigate(route.kind === 'grouping' || scope === 'oneoff' ? scope : route.kind === 'seg-members' ? 'segments' : `${scope}/settings`);
  };

  const renderChildPage = (): React.ReactNode => {
    if (legacyUuid) return legacyError
      ? <div className="empty"><p>{legacyError}</p><button className="btn secondary" onClick={() => setLegacyRetry(x => x + 1)}>再読み込み</button></div>
      : <p className="muted">読み込み中…</p>;
    switch (route.kind) {
      case 'setup':
      case 'bot-settings':
        return <Setup key={guild.id + route.kind} mode={route.kind} guild={guild} toast={toast} onLeft={onLeftGuild} onDirtyChange={setDirty} />;
      case 'channels':
        return <Channels key={guild.id} guild={guild} toast={toast} onDirtyChange={setDirty} />;
      case 'planning-settings':
        return <PlanningSettings onBack={() => navigate('planning')} onDirtyChange={setDirty} key={guild.id} guild={guild} toast={toast}/>;
      case 'planning':
      {
        const base = route.oneOff ? 'oneoff-planning' : 'planning';
        return <Planning onOpenSettings={() => navigate('planning-settings')} onDirtyChange={setDirty} key={guild.id + base} guild={guild} toast={toast} planId={route.planId} view={route.view} oneOff={route.oneOff} onNavigate={(id, view)=>navigate(id?`${base}/${id}${view ? `/${view}` : ''}`:base)}/>;
      }
      case 'notification-list':
        return (
          <NotificationsScreen key={guild.id + scope + listKey} guild={guild} scope={scope} toast={toast} onError={onError}
            onBack={() => navigate(scope)} onNew={() => navigate(`${scope}/notifications/new`)}
            onEdit={uuid => navigate(`${scope}/notifications/${uuid}/edit`)}
            onCopy={uuid => navigate(`${scope}/notifications/${uuid}/copy`)}
            onGroupingSettings={uuid => navigate(`${scope}/notifications/${uuid}/grouping-settings`)} />
        );
      case 'notif-new':
        return (
          <NotificationFormV2
            key={route.copy ? 'copy-' + route.copy : route.oneOff ? 'new-oneoff' : route.irregular ? 'new-irregular' : 'new'}
            guild={guild}
            irregular={route.irregular}
            oneOff={route.oneOff}
            copyFrom={route.copy}
            toast={toast}
            onDirtyChange={setDirty}
            onClose={backToList}
            onSaved={backToList}
          />
        );
      case 'notif-edit':
        return (
          <NotificationFormV2
            key={route.nuuid}
            guild={guild}
            nuuid={route.nuuid}
            toast={toast}
            onDirtyChange={setDirty}
            onClose={backToList}
            onSaved={backToList}
          />
        );
      case 'grouping-settings':
        return <GroupingSettings key={route.nuuid} guild={guild} nuuid={route.nuuid} toast={toast} onClose={backToList} oneOff={scope === 'oneoff'} />;
      case 'grouping':
        return (
          <GroupingDialog
            key={route.nuuid + '/' + route.ouuid}
            guild={guild}
            nuuid={route.nuuid}
            ouuid={route.ouuid}
            toast={toast}
            onDirtyChange={setDirty}
            onClose={backToList}
            onNavigateConstraints={() => navigate(`${scope}/notifications/${route.nuuid}/grouping-settings`)}
            oneOff={scope === 'oneoff'}
          />
        );
      case 'seg-members':
        return <SegmentMembers key={route.suuid} guild={guild} segUuid={route.suuid} toast={toast} onClose={backToList} />;
      default:
        return null;
    }
  };

  const childPage = renderChildPage();

  return (
    <div className="ws-layout">
      <ServerRail aria-label="サーバー一覧">
        {guilds.map((g) => (
          <ServerRailItem
            key={g.id}
            active={g.id === guild.id}
            label={g.name}
            src={guildIconUrl(g) || undefined}
            onClick={async () => {
              if (g.id === guild.id) return;
              if (dirty && !(await confirmDialog('未保存の変更があります。破棄して移動しますか？', { okLabel: '破棄する', danger: true }))) return;
              setDirty(false);
              onSelectGuild(g);
            }}
          >
            {(g.name || '?').slice(0, 1)}
          </ServerRailItem>
        ))}
      </ServerRail>
      <div className="ws-body">
        <Topbar>
          <ServerBadge
            name={<div style={{ fontWeight: 600 }}>{guild.name}</div>}
            subtitle="サーバー"
            fallback={<GuildIcon g={guilds.find((g) => g.id === guild.id) || guild} />}
          />
          <Actions>
            <button className="btn secondary" onClick={onLogout}>ログアウト</button>
          </Actions>
        </Topbar>
        <Shell>
          <SideNav>
            {NAV_GROUPS.map((g) => (
              <React.Fragment key={g.label}>
                <div className="navgroup">{g.icon} {g.label}</div>
                {g.items.map((n) => (
                  <NavItem key={n.key} active={sec === n.key} onClick={() => selectSection(n.key)} title={n.tip} style={{ cursor: 'pointer' }}>
                    {n.label}
                  </NavItem>
                ))}
              </React.Fragment>
            ))}
          </SideNav>
          <Main>
            {childPage ? (
              childPage
            ) : sec === 'regular' || sec === 'irregular' || sec === 'oneoff' ? (
              <NotifOps key={guild.id + scope + listKey} guild={guild} scope={scope} toast={toast}
                onOpenSettings={() => navigate(`${scope}/settings`)}
                onCreateSchedule={() => navigate(`${scope}/notifications/new`)}
                onEditSchedule={(n) => navigate(`${scope}/notifications/${n}/edit`)}
                onCopySchedule={(n) => navigate(`${scope}/notifications/${n}/copy`)}
                onOpenGrouping={(n, o) => navigate(`${scope}/notifications/${n}/occurrences/${o}/grouping`)} />
            ) : sec === 'segments' ? (
              <Segments key={listKey} guild={guild} toast={toast} onOpenMembers={(uuid) => navigate(`segments/${uuid}/members`)} />
            ) : sec === 'records' ? (
              <Records guild={guild} toast={toast} />
            ) : sec === 'reports' ? (
              <Reports key={guild.id} guild={guild} toast={toast} />
            ) : sec === 'sendlog' ? (
              <SendLog guild={guild} toast={toast} />
            ) : (
              <Setup key={guild.id + sec} mode={sec === 'setup' ? 'setup' : 'bot-settings'} guild={guild} toast={toast} onLeft={onLeftGuild} onDirtyChange={setDirty} />
            )}
          </Main>
        </Shell>
      </div>
    </div>
  );
}
