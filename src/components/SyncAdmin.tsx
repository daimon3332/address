import { createElement, lazy, Suspense, useCallback, useEffect, useRef, useState, type ComponentType, type SyntheticEvent } from 'react';
import { LogOut, MapPin, Menu, PanelLeftClose, PanelLeftOpen, RefreshCw, SquareArrowOutUpRight } from 'lucide-react';
import { pathForLocale } from '../domain/locales';
import type { Locale } from '../domain/types';
import { Dashboard, DashboardLoading, SidebarStatus } from './admin/dashboard';
import { adminText, errorMessage, labelsFor, navGroups, shellText, sidebarStorageKey, viewIcons } from './admin/text';
import { adminViews } from './admin/types';
import type { AddressDataCountry, AddressDataWorkspace, AdminCountryShortcutConfig, AdminLocale, ApiTokenView, BlacklistViewData, CoverageNode, Credential, DashboardData, Mutate, ProviderViewData, RequestData, Reveal, SyncHistoryData, SyncQueueData, SystemStatus, View } from './admin/types';
import { localeText } from './admin/locale-text';
import { ConfirmProvider, LocaleMenu, Panel, useConfirm, usePolling } from './admin/ui';
import { preloadWorldMap, takeBootResponse } from './WorldCoverageMap';

// Each view's code loads with the view, so opening the dashboard does not download the other screens. A component
// first shown after its module arrived (a dialog of the open view) renders directly instead of suspending the view.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyComponent = ComponentType<any>;
const loadedModules = new Map<unknown, Record<string, AnyComponent>>();
const lazyNamed = <M extends Record<K, AnyComponent>, K extends keyof M & string>(load: () => Promise<M>, name: K): M[K] => {
  const Lazy = lazy(async () => {
    const module = await load();
    loadedModules.set(load, module);
    return { default: module[name] };
  });
  let suspends: boolean | undefined;
  return ((props: object) => {
    suspends ??= !loadedModules.has(load);
    return createElement(suspends ? Lazy : loadedModules.get(load)![name], props);
  }) as unknown as M[K];
};
const providersModule = () => import('./admin/providers');
const securityModule = () => import('./admin/security');
const shortcutsModule = () => import('./admin/shortcuts');
const syncModule = () => import('./admin/sync');
const viewModules: Partial<Record<View, () => Promise<unknown>>> = {
  providers: providersModule, access: securityModule, blacklist: securityModule, tokens: securityModule,
  shortcuts: shortcutsModule, addressData: syncModule, syncHistory: syncModule
};
const AmapBrowserDialog = lazyNamed(providersModule, 'AmapBrowserDialog');
const AmapBrowserSummary = lazyNamed(providersModule, 'AmapBrowserSummary');
const MapDisplayPanel = lazyNamed(providersModule, 'MapDisplayPanel');
const OpenAICompatibleCredentialDialog = lazyNamed(providersModule, 'OpenAICompatibleCredentialDialog');
const ProviderCredentialDialog = lazyNamed(providersModule, 'ProviderCredentialDialog');
const ProviderCredentialsPanel = lazyNamed(providersModule, 'ProviderCredentialsPanel');
const TranslationSettingsPanel = lazyNamed(providersModule, 'TranslationSettingsPanel');
const YoudaoCredentialDialog = lazyNamed(providersModule, 'YoudaoCredentialDialog');
const AccessSettingsForm = lazyNamed(securityModule, 'AccessSettingsForm');
const BlacklistSettings = lazyNamed(securityModule, 'BlacklistSettings');
const TokenEditorDialog = lazyNamed(securityModule, 'TokenEditorDialog');
const TokenSecretDialog = lazyNamed(securityModule, 'TokenSecretDialog');
const TokenTable = lazyNamed(securityModule, 'TokenTable');
const CountryShortcutSettings = lazyNamed(shortcutsModule, 'CountryShortcutSettings');
const CountryWorkspace = lazyNamed(syncModule, 'CountryWorkspace');
const SyncHistoryPanel = lazyNamed(syncModule, 'SyncHistoryPanel');
export type { AdminLocale } from './admin/types';
export type { AdminDictionary } from './admin/text';
export { adminErrorText, adminText, baseAdminErrorText, errorMessage, syncHistoryGoalChange, syncHistoryResultDetail } from './admin/text';

const viewFromLocation = (): View => {
  if (typeof window === 'undefined') return 'dashboard';
  const value = new URL(window.location.href).searchParams.get('view');
  if (value === 'syncQueue') return 'addressData';
  return value && adminViews.has(value as View) ? value as View : 'dashboard';
};
interface SyncAdminProps { locale: Locale }
const localDayStart = (): string => { const day = new Date(); day.setHours(0, 0, 0, 0); return day.toISOString(); };
const cookie = (name: string): string => document.cookie.split('; ').find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1) || '';
export default function SyncAdmin({ locale: pageLocale }: SyncAdminProps) {
  const locale = pageLocale;
  const t = adminText[locale];
  const [authenticated, setAuthenticated] = useState(false);
  const [sessionReady, setSessionReady] = useState(false);
  const [sessionRetry, setSessionRetry] = useState(0);
  const [initialized, setInitialized] = useState(true);
  const [passwordChangeRequired, setPasswordChangeRequired] = useState(false);
  const [password, setPassword] = useState('');
  const [view, setView] = useState<View>('dashboard');
  const [dataByView, setDataByView] = useState<Partial<Record<View, unknown>>>({});
  const [loadingView, setLoadingView] = useState<View | null>(null);
  const [mutating, setMutating] = useState(false);
  const mutationPending = useRef(false);
  const [loginBusy, setLoginBusy] = useState(false);
  const loginPending = useRef(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  // A floating result clears itself; an action still running keeps its notice until it finishes.
  useEffect(() => {
    if (!notice || mutating) return;
    const timer = window.setTimeout(() => setNotice(''), 6000);
    return () => window.clearTimeout(timer);
  }, [notice, mutating]);
  const [coverageTrail, setCoverageTrail] = useState<CoverageNode[]>([]);
  const loadIds = useRef<Record<View, number>>({ dashboard: 0, blacklist: 0, access: 0, providers: 0, addressData: 0, syncHistory: 0, shortcuts: 0, tokens: 0 });
  const loadControllers = useRef<Partial<Record<View, AbortController>>>({});
  const viewRef = useRef<View>('dashboard');
  const coverageParent = useRef('');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [systemStatus, setSystemStatus] = useState<SystemStatus>();

  useEffect(() => {
    try { setSidebarCollapsed(window.localStorage.getItem(sidebarStorageKey) === '1'); } catch { /* storage unavailable */ }
  }, []);
  const toggleSidebar = () => setSidebarCollapsed((current) => {
    try { window.localStorage.setItem(sidebarStorageKey, current ? '0' : '1'); } catch { /* storage unavailable */ }
    return !current;
  });
  useEffect(() => {
    if (!navOpen) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setNavOpen(false); };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [navOpen]);

  const changeLocale = (next: Locale) => {
    const target = pathForLocale(window.location.pathname, next);
    window.location.assign(`${target}${window.location.search}${window.location.hash}`);
  };

  useEffect(() => {
    document.documentElement.lang = pageLocale;
  }, [pageLocale]);

  const request = useCallback(async <T,>(path: string, options: RequestInit = {}): Promise<T> => {
    const csrf = cookie('address_admin_csrf');
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000);
    const response = (!options.method || options.method === 'GET') && await takeBootResponse('__adminBoot', path)
      || await fetch(`/admin/api${path}`, {
        ...options,
        signal,
        cache: 'no-store',
        headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...options.headers },
        credentials: 'same-origin'
      });
    const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` })) as { data?: T; error?: string; detail?: string };
    if (response.status === 401) setAuthenticated(false);
    if (!response.ok) throw new Error(errorMessage(body.detail || body.error || `HTTP ${response.status}`, locale));
    return body.data as T;
  }, [locale]);

  const reveal = useCallback(async (path: string): Promise<Record<string, string>> => {
    return request<Record<string, string>>(path, { method: 'POST' });
  }, [request]);

  const load = useCallback(async (selected: View, clearMessages = true, background = false): Promise<boolean> => {
    const id = ++loadIds.current[selected];
    loadControllers.current[selected]?.abort();
    const controller = new AbortController();
    loadControllers.current[selected] = controller;
    if (!background) { setLoadingView(selected); setError(''); }
    if (clearMessages) setNotice('');
    if (selected === 'dashboard') preloadWorldMap();
    else void viewModules[selected]?.().catch(() => undefined);
    try {
      const paths: Record<View, string> = {
        dashboard: `/dashboard/overview?${new URLSearchParams({ since: localDayStart(), ...(coverageParent.current ? { parent: coverageParent.current } : {}) })}`,
        blacklist: '/settings/blacklist', access: '/settings/access', providers: '/providers', addressData: '/address-data', syncHistory: '/sync/history', shortcuts: '/settings/country-shortcuts', tokens: '/tokens'
      };
      if (selected === 'addressData') {
        const [countries, queue] = await Promise.all([
          request<AddressDataCountry[]>(paths.addressData, { signal: controller.signal }),
          request<SyncQueueData>('/sync/queue', { signal: controller.signal }).catch((value) => { if (controller.signal.aborted) throw value; return null; })
        ]);
        if (id === loadIds.current[selected]) setDataByView((values) => ({ ...values, addressData: { countries, queue } satisfies AddressDataWorkspace }));
        return true;
      }
      if (selected === 'providers') {
        const parts = [['credentials', '/providers'], ['maps', '/settings/maps'], ['translation', '/settings/translation']] as const;
        const results = await Promise.allSettled(parts.map(async ([key, path]) => {
          const value = await request(path, { signal: controller.signal });
          if (id === loadIds.current[selected] && !controller.signal.aborted) {
            setDataByView((values) => ({ ...values, providers: { ...(values.providers as ProviderViewData), [key]: value } }));
          }
        }));
        const failure = results.find((result) => result.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
        return !controller.signal.aborted;
      }
      const result = await request(paths[selected], { signal: controller.signal });
      if (id === loadIds.current[selected]) setDataByView((values) => ({ ...values, [selected]: result }));
      return true;
    } catch (value) {
      if (controller.signal.aborted) return false;
      if (id === loadIds.current[selected] && selected === viewRef.current) setError(errorMessage(value, locale));
      return false;
    } finally {
      if (loadControllers.current[selected] === controller) delete loadControllers.current[selected];
      if (id === loadIds.current[selected] && !background) setLoadingView((value) => value === selected ? null : value);
    }
  }, [request, locale]);

  useEffect(() => () => Object.values(loadControllers.current).forEach((controller) => controller?.abort()), []);

  useEffect(() => {
    const controller = new AbortController();
    void request<{ initialized: boolean }>('/status', { signal: controller.signal })
      .then((value) => { if (!controller.signal.aborted) setInitialized(Boolean(value.initialized)); })
      .catch((value) => { if (!controller.signal.aborted) setError(errorMessage(value, locale)); });
    void request<{ authenticated: boolean; passwordChangeRequired?: boolean }>('/session', { signal: controller.signal }).then((body) => {
      if (controller.signal.aborted) return;
      const forceChange = Boolean(body.passwordChangeRequired);
      const selected: View = forceChange ? 'access' : viewFromLocation();
      viewRef.current = selected;
      setView(selected);
      const active = Boolean(body.authenticated);
      setAuthenticated(active);
      setPasswordChangeRequired(active && forceChange);
      if (active) void load(selected);
      else (globalThis as { __adminBoot?: unknown }).__adminBoot = undefined;
    }).catch((value) => { if (!controller.signal.aborted) setError(errorMessage(value, locale)); })
      .finally(() => { if (!controller.signal.aborted) setSessionReady(true); });
    return () => controller.abort();
  }, [load, locale, request, sessionRetry]);

  const selectView = useCallback((selected: View, history: 'push' | 'none' = 'push') => {
    if (passwordChangeRequired && selected !== 'access') return;
    if (selected !== viewRef.current) loadControllers.current[viewRef.current]?.abort();
    if (selected === 'dashboard') {
      coverageParent.current = ''; setCoverageTrail([]);
      setDataByView((values) => ({ ...values, dashboard: undefined }));
    }
    viewRef.current = selected; setView(selected);
    if (history === 'push') {
      const url = new URL(window.location.href);
      if (selected === 'dashboard') url.searchParams.delete('view');
      else url.searchParams.set('view', selected);
      url.searchParams.delete('country');
      window.history.pushState({}, '', url);
    }
    void load(selected);
  }, [load, passwordChangeRequired]);

  useEffect(() => {
    const restore = () => {
      const selected = viewFromLocation();
      if (selected !== viewRef.current) selectView(selected, 'none');
    };
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, [selectView]);

  usePolling(async (signal) => {
    if (!authenticated) return;
    const value = await request<SystemStatus>(`/system/status?${new URLSearchParams({ since: localDayStart() })}`, { signal });
    if (!signal.aborted) setSystemStatus(value);
  }, 60_000, [authenticated, request], true);

  const login = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (loginPending.current) return;
    loginPending.current = true;
    setLoginBusy(true); setError('');
    try {
      const body = await request<{ passwordChangeRequired?: boolean }>('/login', { method: 'POST', body: JSON.stringify({ password }) });
      const forceChange = Boolean(body.passwordChangeRequired);
      const selected: View = forceChange ? 'access' : viewRef.current;
      setAuthenticated(true); setPasswordChangeRequired(forceChange); setPassword('');
      viewRef.current = selected; setView(selected);
      setTimeout(() => void load(selected), 0);
    } catch (value) { setError(errorMessage(value, locale)); }
    finally { loginPending.current = false; setLoginBusy(false); }
  };

  const mutate: Mutate = async <T,>(path: string, method: string, body?: unknown, success = localeText[locale].ui.operationDone): Promise<T | undefined> => {
    if (mutationPending.current) { setNotice(localeText[locale].ui.busy); return undefined; }
    mutationPending.current = true;
    const selected = viewRef.current;
    loadIds.current[selected] += 1;
    loadControllers.current[selected]?.abort();
    setLoadingView(null);
    setMutating(true); setError(''); setNotice(/\/test$/u.test(path) ? localeText[locale].ui.testing : '');
    try {
      const result = await request<T>(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (path === '/settings/access' && result && typeof result === 'object' && 'passwordChangeRequired' in result) {
        setPasswordChangeRequired(Boolean((result as { passwordChangeRequired?: boolean }).passwordChangeRequired));
      }
      setDataByView((values) => {
        const providers = values.providers as ProviderViewData | undefined;
        const credentialId = /^\/providers\/([^/]+)$/.exec(path)?.[1];
        const tokenId = /^\/tokens\/([^/]+)$/.exec(path)?.[1];
        if (credentialId && providers) {
          const patch = body as { label?: string; enabled?: boolean } | undefined;
          return { ...values, providers: { ...providers, credentials: (providers.credentials || []).flatMap((item) => {
            if (item.id !== credentialId) return [item];
            if (method === 'DELETE') return [];
            return [{ ...item, ...(patch?.label !== undefined ? { label: patch.label } : {}),
              ...(patch?.enabled !== undefined ? { enabled: patch.enabled, status: patch.enabled ? (item.status === 'disabled' ? 'healthy' : item.status) : 'disabled' } : {}) }];
          }) } };
        }
        if (tokenId && method === 'DELETE') return { ...values, tokens: ((values.tokens || []) as ApiTokenView[]).filter((item) => item.id !== tokenId) };
        if (tokenId && method === 'PUT') return { ...values, tokens: result };
        if (path === '/settings/maps') return { ...values, providers: { ...providers, maps: result } };
        if (path === '/settings/translation') return { ...values, providers: { ...providers, translation: result } };
        if (path === '/maps/amap-browser') return { ...values, providers: { ...providers, maps: { ...providers?.maps, amapBrowser: result } } };
        if (path.startsWith('/settings/country-shortcuts/')) return { ...values, shortcuts: ((values.shortcuts || []) as AdminCountryShortcutConfig[]).map((item) => item.countryCode === path.split('/').at(-1) ? result : item) };
        if (path === '/settings/access') return { ...values, access: result };
        if (path === '/settings/blacklist') return { ...values, blacklist: { ...(values.blacklist as BlacklistViewData), ...(result as Pick<BlacklistViewData, 'keywords'>) } };
        return values;
      });
      if (selected === viewRef.current) setNotice(success);
      void load(selected, false, true);
      return result;
    } catch (value) {
      if (selected === viewRef.current) setError(errorMessage(value, locale));
      return undefined;
    }
    finally { mutationPending.current = false; setMutating(false); }
  };

  if (!sessionReady) return <main className="admin-login"><div className="admin-loading" role="status"><span className="loading-dot" />{t.loading}</div></main>;

  if (!authenticated) return <main className="admin-login">
    <div className="admin-backdrop" aria-hidden="true"><i /><i /></div>
    <form onSubmit={login}>
      <div className="admin-login-toolbar"><p><span className="brand-mark" aria-hidden="true"><MapPin size={16} strokeWidth={2.4} /></span>{t.brandName}{locale === 'zh-CN' ? '' : ' '}{t.brand}</p><LocaleMenu locale={pageLocale} change={changeLocale} className="locale-toggle" /></div>
      <h1>{t.loginTitle}</h1>
      {!initialized && <div className="admin-warning">{t.bootstrap}</div>}
      <label><span>{t.password}</span><input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
      <button disabled={loginBusy || !password}>{loginBusy ? t.loggingIn : t.login}</button>
      {error && <div className="admin-error admin-error-action" role="alert"><span>{error}</span>
        <button type="button" disabled={loginBusy} onClick={() => { setError(''); setSessionReady(false); setSessionRetry((value) => value + 1); }}>{t.retry}</button>
      </div>}
      <a href={`/${pageLocale}/`}>{t.backGenerator}</a>
    </form>
  </main>;

  const openCoverage = (node: CoverageNode) => {
    if (!node.childCount) return;
    coverageParent.current = node.key;
    setCoverageTrail((trail) => node.level === 0 ? [node] : [...trail, node]);
    setDataByView((values) => ({ ...values, dashboard: undefined }));
    void load('dashboard');
  };
  const returnCoverage = (index: number) => {
    const trail = coverageTrail.slice(0, index + 1);
    coverageParent.current = index < 0 ? '' : trail[index].key;
    setCoverageTrail(trail);
    setDataByView((values) => ({ ...values, dashboard: undefined }));
    void load('dashboard');
  };
  const logout = async () => {
    try { await request('/logout', { method: 'POST' }); location.reload(); }
    catch (value) { setError(errorMessage(value, locale)); }
  };
  const data = dataByView[view];
  const dashboardSnapshot = dataByView.dashboard as DashboardData | undefined;

  const labels = labelsFor(locale);
  const shell = shellText[locale];
  const activeGroup = navGroups.find((group) => group.views.includes(view))?.id || 'overview';
  const openView = (item: View) => { setNavOpen(false); selectView(item); };
  return <ConfirmProvider locale={locale}><div className={`admin-shell${sidebarCollapsed ? ' is-collapsed' : ''}${navOpen ? ' nav-open' : ''}`}>
    <div className="admin-backdrop" aria-hidden="true"><i /><i /></div>
    <aside className="admin-sidebar" id="admin-navigation">
      <div className="admin-brand"><span className="brand-mark"><MapPin size={20} strokeWidth={2.4} /></span><b>{t.brandName}</b><span>{t.brand}</span></div>
      <nav aria-label={t.brand}>{navGroups.map((group) => {
        const items = group.views.filter((item) => !passwordChangeRequired || item === 'access');
        if (!items.length) return null;
        return <div className="nav-group" key={group.id}>
          <p className="nav-group-label">{shell[group.id]}</p>
          {items.map((item) => {
            const Icon = viewIcons[item];
            return <button type="button" key={item} className={view === item ? 'active' : ''} aria-current={view === item ? 'page' : undefined} title={sidebarCollapsed ? labels[item] : undefined} onClick={() => openView(item)}><span className="nav-icon" aria-hidden="true"><Icon size={18} /></span><span className="nav-label">{labels[item]}</span></button>;
          })}
        </div>;
      })}</nav>
      <SidebarStatus metrics={systemStatus || dashboardSnapshot?.metrics} locale={locale} />
    </aside>
    {navOpen && <button type="button" className="nav-scrim" aria-label={t.close} onClick={() => setNavOpen(false)} />}
    <main className="admin-content">
      <header className="admin-topbar">
        <button type="button" className="topbar-icon menu-toggle" aria-label={shell.menu} aria-controls="admin-navigation" aria-expanded={navOpen} onClick={() => setNavOpen(true)}><Menu size={19} /></button>
        <button type="button" className="topbar-icon sidebar-toggle" aria-label={sidebarCollapsed ? shell.expand : shell.collapse} title={sidebarCollapsed ? shell.expand : shell.collapse} aria-controls="admin-navigation" aria-expanded={!sidebarCollapsed} onClick={toggleSidebar}>{sidebarCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}</button>
        <div className="topbar-heading"><span className="topbar-crumb">{shell[activeGroup]}</span><h1>{view === 'dashboard' ? t.dashboardTitle : labels[view]}</h1></div>
        <div className="admin-topbar-actions">
          <button type="button" className="topbar-icon" title={shell.refresh} aria-label={shell.refresh} disabled={mutating || loadingView === view} onClick={() => void load(view)}><RefreshCw size={17} className={loadingView === view ? 'is-spinning' : undefined} /></button>
          <LocaleMenu locale={pageLocale} change={changeLocale} className="language-control" />
          <a className="topbar-control generator-link" href={`/${pageLocale}/`}><SquareArrowOutUpRight size={15} aria-hidden="true" /><span>{t.backGenerator}</span></a>
          <button type="button" className="topbar-icon danger-control" title={t.logout} aria-label={t.logout} onClick={() => void logout()}><LogOut size={17} /></button>
        </div>
      </header>
      <div className="admin-page">
        {view === 'dashboard' && <p className="page-intro">{t.dashboardDescription}</p>}
        {/* Results float in view: an action far down the page (a provider test) still shows its outcome. */}
        {(error || notice) && <div className="admin-toasts">
          {error && <div className="admin-error admin-error-action" role="alert"><span>{error}</span><button disabled={mutating || loadingView === view} onClick={() => void load(view)}>{t.retry}</button></div>}
          {notice && <div className="admin-notice" role="status">{notice}</div>}
        </div>}
        {data === undefined ? (view === 'dashboard' ? <DashboardLoading label={t.loading} /> : <div className="admin-loading" role="status"><span className="loading-dot" />{t.loading}</div>) : <Suspense fallback={<div className="admin-loading" role="status"><span className="loading-dot" />{t.loading}</div>}><AdminView locale={locale} view={view} data={data} busy={mutating} mutate={mutate} reveal={reveal} request={request}
          coverageTrail={coverageTrail} openCoverage={openCoverage} returnCoverage={returnCoverage} /></Suspense>}
      </div>
    </main>
  </div></ConfirmProvider>;
}
function AdminView({ locale, view, data, busy, mutate, reveal, request, coverageTrail, openCoverage, returnCoverage }: {
  locale: AdminLocale; view: View; data: unknown; busy: boolean; mutate: Mutate; reveal: Reveal; request: RequestData;
  coverageTrail: CoverageNode[]; openCoverage: (node: CoverageNode) => void; returnCoverage: (index: number) => void;
}) {
  const confirm = useConfirm();
  const t = adminText[locale];
  const [providerDialog, setProviderDialog] = useState<'create' | Credential | null>(null);
  const [youdaoDialog, setYoudaoDialog] = useState<'create' | Credential | null>(null);
  const [openAICompatibleDialog, setOpenAICompatibleDialog] = useState<'create' | Credential | null>(null);
  const [newProvider, setNewProvider] = useState('amap');
  const [amapBrowserDialog, setAmapBrowserDialog] = useState(false);
  const [tokenEditor, setTokenEditor] = useState<{ mode: 'create' | 'edit'; value?: ApiTokenView } | null>(null);
  const [tokenSecret, setTokenSecret] = useState<string | null>(null);
  if (view === 'dashboard') {
    return <Dashboard value={data as DashboardData} locale={locale} coverageTrail={coverageTrail} openCoverage={openCoverage} returnCoverage={returnCoverage} />;
  }
  if (view === 'access') {
    const value = data as { frontendPasswordEnabled?: boolean } | undefined;
    return <Panel title={t.accessTitle}><AccessSettingsForm value={value} locale={locale} busy={busy} mutate={mutate} /></Panel>;
  }
  if (view === 'blacklist') {
    return <BlacklistSettings value={data as BlacklistViewData} locale={locale} busy={busy} mutate={mutate} />;
  }
  if (view === 'providers') {
    const value = data as ProviderViewData;
    const credentials = (value.credentials || []).filter((credential) => !['deepl', 'youdao', 'openai-compatible'].includes(credential.provider))
      .slice().sort((left, right) => left.provider.localeCompare(right.provider) || left.label.localeCompare(right.label));
    const youdaoCredentials = (value.credentials || []).filter((credential) => credential.provider === 'youdao')
      .slice().sort((left, right) => left.label.localeCompare(right.label));
    const openAICompatibleCredentials = (value.credentials || []).filter((credential) => credential.provider === 'openai-compatible')
      .slice().sort((left, right) => left.label.localeCompare(right.label));
    const maps = value.maps;
    return <>{maps && <><MapDisplayPanel value={maps} locale={locale} busy={busy} mutate={mutate} openAmapBrowser={() => setAmapBrowserDialog(true)} />
      <Panel title={t.amapBrowserTitle} actions={<button type="button" className="primary-action" onClick={() => setAmapBrowserDialog(true)}>{maps.amapBrowser.configured ? t.editAmapBrowser : t.configureAmapBrowser}</button>}>
        <AmapBrowserSummary value={maps.amapBrowser} locale={locale} busy={busy} mutate={mutate} reveal={reveal} openEditor={() => setAmapBrowserDialog(true)} />
      </Panel></>}
      <ProviderCredentialsPanel values={credentials} locale={locale} reveal={reveal} busy={busy} mutate={mutate} openEditor={setProviderDialog} openProvider={(provider) => { setNewProvider(provider); setProviderDialog('create'); }} />
      {value.translation && <TranslationSettingsPanel value={value.translation} request={request} credentials={youdaoCredentials} deeplCredentials={(value.credentials || []).filter((item) => item.provider === 'deepl')} openAICompatibleCredentials={openAICompatibleCredentials} locale={locale} busy={busy} mutate={mutate} reveal={reveal} openEditor={setYoudaoDialog} openDeepL={(item) => { setNewProvider('deepl'); setProviderDialog(item); }} openOpenAICompatible={setOpenAICompatibleDialog} />}
      {amapBrowserDialog && maps && <AmapBrowserDialog value={maps.amapBrowser} locale={locale} busy={busy} mutate={mutate} close={() => setAmapBrowserDialog(false)} />}
      {youdaoDialog && <YoudaoCredentialDialog value={youdaoDialog === 'create' ? undefined : youdaoDialog} locale={locale} busy={busy} mutate={mutate} close={() => setYoudaoDialog(null)} />}
      {openAICompatibleDialog && <OpenAICompatibleCredentialDialog value={openAICompatibleDialog === 'create' ? undefined : openAICompatibleDialog} locale={locale} busy={busy} mutate={mutate} request={request} close={() => setOpenAICompatibleDialog(null)} />}
      {providerDialog && <ProviderCredentialDialog value={providerDialog === 'create' ? undefined : providerDialog} initialProvider={newProvider} locale={locale} busy={busy} mutate={mutate} close={() => setProviderDialog(null)} />}</>;
  }
  if (view === 'addressData') {
    return <CountryWorkspace initialData={data as AddressDataWorkspace} locale={locale} busy={busy} mutate={mutate} request={request} />;
  }
  if (view === 'syncHistory') {
    return <SyncHistoryPanel initialData={data as SyncHistoryData} locale={locale} request={request} />;
  }
  if (view === 'shortcuts') {
    return <CountryShortcutSettings values={data as AdminCountryShortcutConfig[]} locale={locale} busy={busy} mutate={mutate} request={request} />;
  }
  if (view === 'tokens') {
    const tokens = ((data || []) as ApiTokenView[]).filter((token) => !token.revoked_at);
    return <><Panel title={t.tokensTitle} actions={<button className="primary-action" onClick={() => setTokenEditor({ mode: 'create' })}>+ {t.addToken}</button>}>
      <TokenTable values={tokens} locale={locale} reveal={reveal} edit={(value) => setTokenEditor({ mode: 'edit', value })} revoke={async (id) => {
        if (await confirm(t.confirmRevokeToken)) void mutate(`/tokens/${id}`, 'DELETE', undefined, t.revoked);
      }} />
    </Panel>{tokenEditor && <TokenEditorDialog mode={tokenEditor.mode} value={tokenEditor.value} locale={locale} busy={busy} mutate={mutate} close={() => setTokenEditor(null)} created={(value) => { setTokenEditor(null); setTokenSecret(value); }} />}{tokenSecret && <TokenSecretDialog value={tokenSecret} locale={locale} close={() => setTokenSecret(null)} />}</>;
  }
  return null;
}
