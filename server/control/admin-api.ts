import { indexTranslate, INDEX_TRANSLATE_SETTINGS_KEY, normalizeIndexTranslateSettings } from '../translation/index-translate.mjs';
import { Worker } from 'node:worker_threads';
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Database } from '../database/database.mjs';
import type { ChinaDataService } from '../china/service';
import { providerFetcher, ProviderRequestError } from '../china/providers';
import { safeEqual } from './security';
import {
  ADMIN_SESSION_MS, credentialProviderNames, parseYoudaoSecret,
  type BrowserMapCredentialInput, type BrowserMapCredentialUpdate, type ControlStore, type CredentialInput,
  type CredentialProviderName, type MapDisplayConfig, type ProviderName, type ProviderQuotaObservation, type ServiceProviderName
} from './store';
import { translateYoudaoBatch } from '../api/services/youdao-translator.ts';
import { listAddressCoverage } from './coverage';
import { listAddressData } from './address-data';
import { nonResidentialRules } from '../../src/domain/non-residential-rules.mjs';
import { isCountryCode } from '../../src/domain/countries.ts';
import { customBlacklistKeywords, replaceCustomBlacklist } from '../lib/custom-blacklist.mjs';
import { originAllowed, parseAllowedOrigins } from '../lib/origin-policy';
import {
  deleteNodeTarget, listCountryNodeTargets, listCountryPolicies, updateCountryPolicy, upsertNodeTarget
} from '../sync/address-policy.mjs';
import { evaluateCountryGoals } from '../sync/country-goals.mjs';
import { queryLocationCatalog, resolveCountryShortcuts, type CatalogField } from '../api/repositories/location-catalog';
import {
  diagnoseOpenAICompatible, fetchOpenAICompatibleModelCatalog, OPENAI_COMPATIBLE_DIAGNOSTIC_VALUES, resolveOpenAICompatibleBaseUrl, translateOpenAICompatible
} from '../credential-broker/openai-compatible.mjs';
import { preservesAddressIdentifiers, preservesAddressNumbers } from '../../src/domain/address-localization.mjs';

const adminCookie = 'address_admin_session';
const adminCsrfCookie = 'address_admin_csrf';
const frontCookie = 'address_front_session';
const secureCookie = { httpOnly: true, secure: process.env.COOKIE_SECURE !== 'false', sameSite: 'Strict' as const, path: '/' };
const csrfCookie = { ...secureCookie, httpOnly: false };
const adminCookieMaxAge = ADMIN_SESSION_MS / 1000;
const bearer = (value: string | undefined): string => value?.startsWith('Bearer ') ? value.slice(7).trim() : '';
type RequestBindings = { remoteAddress?: string };

export const requestClientAddress = (request: Request, remoteAddress = '', trustProxy = false): string => {
  const realIp = trustProxy ? request.headers.get('x-real-ip')?.trim() : '';
  const forwarded = trustProxy ? request.headers.get('x-forwarded-for')?.split(',').at(-1)?.trim() : '';
  return (realIp || forwarded || remoteAddress.trim() || 'local').slice(0, 64);
};

export const createAmapProxyRateLimiter = (limit = 1200, windowMs = 60_000) => {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  return (client: string, now = Date.now()): boolean => {
    const current = buckets.get(client);
    if (!current || current.resetAt <= now) {
      if (buckets.size > 5000) {
        for (const [key, value] of buckets) if (value.resetAt <= now) buckets.delete(key);
      }
      if (buckets.size >= 10_000 && !buckets.has(client)) return false;
      buckets.set(client, { count: 1, resetAt: now + windowMs });
      return true;
    }
    current.count += 1;
    return current.count <= limit;
  };
};

export const testOneMapCredential = async (token: string, fetcher: typeof fetch = fetch) => {
  const url = new URL('https://www.onemap.gov.sg/api/common/elastic/search');
  Object.entries({ searchVal: '1 Raffles Place', returnGeom: 'Y', getAddrDetails: 'Y', pageNum: '1' })
    .forEach(([name, value]) => url.searchParams.set(name, value));
  let response: Response;
  try {
    response = await fetcher(url, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15000)
    });
  } catch {
    throw new ProviderRequestError('network', 'NETWORK_ERROR');
  }
  if (response.status === 429) throw new ProviderRequestError('qps', 'RATE_LIMITED');
  if (!response.ok) {
    throw new ProviderRequestError(response.status === 401 || response.status === 403 ? 'auth' : 'network', `HTTP_${response.status}`);
  }
  let body: { found?: number; totalNumPages?: number; results?: unknown[] };
  try { body = await response.json() as typeof body; }
  catch { throw new ProviderRequestError('invalid', 'INVALID_JSON'); }
  if (!Array.isArray(body.results)) throw new ProviderRequestError('invalid', 'INVALID_RESPONSE');
  return {
    success: true,
    resultCount: body.results.length,
    totalResults: Number(body.found || 0),
    totalPages: Number(body.totalNumPages || 0)
  };
};

const isMapProvider = (provider: CredentialProviderName): provider is ProviderName =>
  provider === 'amap' || provider === 'baidu' || provider === 'tencent';

export const testServiceCredential = async (
  provider: ServiceProviderName,
  secret: string,
  fetcher: typeof fetch = fetch,
  options: { prompt?: string } = {}
): Promise<{ success: boolean; resultCount: number }> => {
  if (provider === 'deepl') throw new ProviderRequestError('invalid', 'DEEPL_REQUIRES_BROKER');
  if (provider === 'openai-compatible') {
    const values = ['Beijing', 'Block D1-12', '100000'];
    let translations: string[];
    try {
      translations = await translateOpenAICompatible(secret, values, 'en', fetcher, undefined, { prompt: options.prompt });
    } catch (error) {
      const cause = error as { outcome?: string; code?: string; retryAt?: string | null };
      const outcome = ['qps', 'quota', 'auth', 'network', 'invalid'].includes(cause.outcome || '')
        ? cause.outcome as 'qps' | 'quota' | 'auth' | 'network' | 'invalid' : 'invalid';
      throw new ProviderRequestError(outcome, String(cause.code || 'OPENAI_COMPATIBLE_TEST_FAILED'),
        String(cause.code || ''), cause.retryAt || null, outcome === 'quota' ? 'day' : undefined);
    }
    if (translations.length !== values.length || translations.some((value, index) =>
      !preservesAddressNumbers(values[index], value) || !preservesAddressIdentifiers(values[index], value))) {
      throw new ProviderRequestError('invalid', 'INVALID_RESPONSE');
    }
    return { success: true, resultCount: translations.length };
  }
  if (provider === 'youdao') {
    const credentials = parseYoudaoSecret(secret);
    if (!credentials) throw new ProviderRequestError('invalid', 'INVALID_PROVIDER_CREDENTIAL');
    let translations: string[] | undefined;
    try {
      translations = await translateYoudaoBatch(['地址'], 'auto', 'en', credentials, fetcher);
    } catch {
      throw new ProviderRequestError('network', 'NETWORK_ERROR');
    }
    if (!translations?.length) throw new ProviderRequestError('auth', 'INVALID_RESPONSE');
    return { success: true, resultCount: translations.length };
  }
  const url = new URL(provider === 'geoapify'
    ? 'https://api.geoapify.com/v1/geocode/reverse?lat=51.50735&lon=-0.12776&limit=1&format=json'
    : provider === 'mappls'
      ? 'https://search.mappls.com/search/places/nearby/json?keywords=coffee&refLocation=28.631460,77.217423&region=IND&radius=500'
      : 'https://geocode.googleapis.com/v4/geocode/location?location.latitude=37.4219999&location.longitude=-122.0840575&languageCode=en&regionCode=US&types=street_address&types=premise&types=subpremise&granularity=ROOFTOP&granularity=GEOMETRIC_CENTER');
  if (provider !== 'google-geocoding') url.searchParams.set(provider === 'geoapify' ? 'apiKey' : 'access_token', secret);
  let response: Response;
  try {
    response = await fetcher(url, { headers: {
      Accept: 'application/json',
      ...(provider === 'google-geocoding' ? {
        'X-Goog-Api-Key': secret,
        'X-Goog-FieldMask': 'results.placeId,results.types,results.addressComponents,results.postalAddress,results.location,results.granularity'
      } : {})
    }, signal: AbortSignal.timeout(15000) });
  } catch {
    throw new ProviderRequestError('network', 'NETWORK_ERROR');
  }
  if (response.status === 429) throw new ProviderRequestError('qps', 'RATE_LIMITED');
  if (response.status === 401 || response.status === 403) throw new ProviderRequestError('auth', `HTTP_${response.status}`);
  if (!response.ok) throw new ProviderRequestError('network', `HTTP_${response.status}`);
  if (provider === 'google-geocoding') {
    const body = await response.json().catch(() => ({})) as { results?: unknown[] };
    if (!Array.isArray(body.results)) throw new ProviderRequestError('invalid', 'INVALID_RESPONSE');
    return { success: true, resultCount: body.results.length };
  }
  if (provider === 'mappls') {
    const body = await response.json().catch(() => null) as { suggestedLocations?: unknown[] } | null;
    if (!body || !Array.isArray(body.suggestedLocations)) throw new ProviderRequestError('invalid', 'INVALID_RESPONSE');
    return { success: true, resultCount: body.suggestedLocations.length };
  }
  return { success: true, resultCount: 1 };
};

const amapServicePrefix = '/_AMapService';
const allowedAmapResponseTypes = new Set([
  'application/json', 'application/javascript', 'application/xml',
  'text/javascript', 'text/plain', 'text/xml'
]);
const allowedAmapVectorTypes = new Set([
  'application/octet-stream', 'application/protobuf', 'application/x-protobuf',
  'application/vnd.mapbox-vector-tile', 'image/jpeg', 'image/png', 'image/webp'
]);
const sameOrigin = (value: string | null, expectedOrigin: string): boolean => {
  if (!value) return true;
  try { return new URL(value).origin === expectedOrigin; } catch { return false; }
};
const proxyError = (status: number, error: string): Response => Response.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } });

export const proxyAmapServiceRequest = async (
  control: ControlStore,
  request: Request,
  fetcher: typeof fetch = fetch,
  allowedOrigins?: string
): Promise<Response> => {
  if (request.method !== 'GET') return proxyError(405, 'METHOD_NOT_ALLOWED');
  const requestUrl = new URL(request.url);
  // The SDK loads its own telemetry (/v3/log/init) as keyless scripts, often without a referrer. Nothing is
  // forwarded: an empty script ends the request locally.
  if (requestUrl.pathname.startsWith(`${amapServicePrefix}/v3/log/`)) {
    return new Response('', { headers: { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' } });
  }
  const origin = request.headers.get('origin');
  const referer = request.headers.get('referer');
  let allowed;
  try { allowed = parseAllowedOrigins(allowedOrigins); }
  catch { return proxyError(403, 'FORBIDDEN'); }
  if (!originAllowed(allowed, requestUrl.origin) || (!origin && !referer)
    || !sameOrigin(origin, requestUrl.origin) || !sameOrigin(referer, requestUrl.origin)) {
    return proxyError(403, 'FORBIDDEN');
  }
  const config = await control.mapDisplayConfig();
  if (!config.amap.china && !config.amap.international) return proxyError(404, 'NOT_FOUND');
  const credential = await control.acquireBrowserMapCredential();
  if (!credential) return proxyError(404, 'NOT_FOUND');
  const path = requestUrl.pathname.slice(amapServicePrefix.length);
  if (!path.startsWith('/') || /%(?:2e|2f|5c)/iu.test(path)) return proxyError(400, 'INVALID_AMAP_SERVICE_PATH');
  const customStyle = /^\/v4\/map\/styles(?:\/|$)/u.test(path);
  const vectorMap = path === '/v3/vectormap';
  if (!vectorMap && /^\/v3\/vectormap(?:\/|$)/u.test(path)) return proxyError(404, 'NOT_FOUND');
  if (!customStyle && !/^\/(?:v3|v4|v5|ws)\//u.test(path)) return proxyError(404, 'NOT_FOUND');
  const suppliedKey = requestUrl.searchParams.get('key') || '';
  if (!suppliedKey || !safeEqual(suppliedKey, credential.apiKey)) return proxyError(403, 'FORBIDDEN');
  const upstream = new URL(path, customStyle
    ? 'https://webapi.amap.com'
    : vectorMap ? 'https://fmap01.amap.com' : 'https://restapi.amap.com');
  requestUrl.searchParams.forEach((value, name) => {
    if (name !== 'jscode' && name !== 'key') upstream.searchParams.append(name, value);
  });
  upstream.searchParams.set('key', credential.apiKey);
  upstream.searchParams.set('jscode', credential.securityCode);
  try {
    const response = await fetcher(upstream, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: { Accept: 'application/json,text/javascript,*/*;q=0.8' }
    });
    const contentType = response.headers.get('content-type') || 'application/json';
    const mediaType = contentType.split(';', 1)[0].trim().toLowerCase();
    const textResponse = allowedAmapResponseTypes.has(mediaType);
    if (!textResponse && !(vectorMap && allowedAmapVectorTypes.has(mediaType))) {
      return proxyError(502, 'INVALID_AMAP_SERVICE_RESPONSE');
    }
    const headers = new Headers({
      'Cache-Control': 'private, no-store',
      'Content-Type': contentType,
      Expires: '0',
      Pragma: 'no-cache'
    });
    const body = textResponse
      ? (await response.text()).split(credential.securityCode).join('')
      : await response.arrayBuffer();
    return new Response(body, { status: response.status, headers });
  } catch {
    return proxyError(502, 'AMAP_SERVICE_UNAVAILABLE');
  }
};

export const createAdminApi = ({
  control, china, addressDb, trustProxy = false, triggerCountrySync, warmReadModels = false, credentialBroker
}: {
  control: ControlStore; china: ChinaDataService; addressDb: Database; trustProxy?: boolean;
  triggerCountrySync?: (countryCode: string) => Promise<Record<string, unknown>>;
  warmReadModels?: boolean;
  credentialBroker?: { request: (operation: string, parameters: Record<string, unknown>, options?: Record<string, unknown>) => Promise<unknown> } | null;
}) => {
  const app = new Hono<{ Bindings: RequestBindings }>();
  const modelFetchRateLimiter = createAmapProxyRateLimiter(30, 10 * 60_000);
  const wakeChina = async (): Promise<void> => {
    if (typeof china.wake === 'function') await china.wake(0);
  };
  let credentialWake: Promise<void> | undefined;
  let credentialWakeRequested = false;
  const notifyCredentialChange = (provider: CredentialProviderName): void => {
    if (!isMapProvider(provider)) return;
    credentialWakeRequested = true;
    credentialWake ||= Promise.resolve().then(async () => {
      while (credentialWakeRequested) {
        credentialWakeRequested = false;
        try { await wakeChina(); }
        catch { console.error('CHINA_CREDENTIAL_WAKE_FAILED'); }
      }
    }).finally(() => { credentialWake = undefined; });
  };
  interface SyncQueueUpstream { generatedAt?: string; job?: unknown; entries?: Array<Record<string, unknown>>; stale?: boolean }
  const syncQueueFreshMs = 3 * 60_000;
  const fetchSyncQueueUpstream = async (): Promise<SyncQueueUpstream | null> => {
    const syncToken = process.env.SYNC_ADMIN_TOKEN?.trim();
    if (!syncToken) return null;
    try {
      const response = await fetch(new URL('/api/v1/sync/queue', process.env.SYNC_CONTROL_URL || 'http://127.0.0.1:8791'), {
        headers: { Authorization: `Bearer ${syncToken}` }, signal: AbortSignal.timeout(5_000)
      });
      return response.ok ? ((await response.json()) as { data?: SyncQueueUpstream }).data || null : null;
    } catch {
      return null;
    }
  };
  const loadSyncQueueUpstream = async (): Promise<SyncQueueUpstream | null> => {
    const row = await addressDb.prepare(`SELECT queue_snapshot_json,queue_snapshot_at FROM sync_scheduler_state
      WHERE scheduler_id='address-sync'`).first<{ queue_snapshot_json: string | null; queue_snapshot_at: string | null }>()
      .catch(() => null);
    if (!row?.queue_snapshot_json) return fetchSyncQueueUpstream();
    try {
      const value = JSON.parse(row.queue_snapshot_json) as SyncQueueUpstream;
      const generatedAt = Date.parse(value.generatedAt || row.queue_snapshot_at || '');
      return { ...value, stale: !Number.isFinite(generatedAt) || Date.now() - generatedAt > syncQueueFreshMs };
    } catch {
      return null;
    }
  };
  const coverageMaxAgeMs = 5 * 60_000;
  let coverageRefresh: Promise<void> | undefined;
  const startCoverageRefresh = (): Promise<void> => {
    coverageRefresh ||= new Promise<void>((resolveRefresh, rejectRefresh) => {
      const worker = new Worker(new URL('./coverage-worker.ts', import.meta.url), {
        execArgv: ['--import', 'tsx'], workerData: { postgresUrl: process.env.POSTGRES_URL || process.env.DATABASE_URL }
      });
      let settled = false;
      const settle = (error?: Error): void => {
        if (settled) return;
        settled = true;
        if (error) rejectRefresh(error);
        else resolveRefresh();
      };
      worker.once('message', () => settle());
      worker.once('error', (error) => settle(error instanceof Error ? error : new Error(String(error))));
      worker.once('exit', (code) => {
        if (code !== 0) settle(new Error(`COVERAGE_REFRESH_WORKER_EXIT_${code}`));
      });
    }).finally(() => { coverageRefresh = undefined; });
    return coverageRefresh;
  };
  const ensureCoverage = async (force = false): Promise<void> => {
    const snapshot = await addressDb.prepare(`SELECT COUNT(*) AS total,MAX(updated_at) AS updated_at
      FROM admin_coverage_stats`).first<{ total: number; updated_at: string | null }>();
    if (!Number(snapshot?.total || 0)) {
      void startCoverageRefresh().catch(() => undefined);
      return;
    }
    if (force) await startCoverageRefresh();
    else {
      const updatedAt = Date.parse(snapshot?.updated_at || '');
      if (!Number.isFinite(updatedAt) || Date.now() - updatedAt >= coverageMaxAgeMs) {
        void startCoverageRefresh().catch(() => undefined);
      }
    }
  };
  type AddressDataValue = Awaited<ReturnType<typeof listAddressData>>;
  let addressDataValue: AddressDataValue | undefined;
  let syncQueueValue: Record<string, unknown> | undefined;
  // A stale read model is served while it refreshes only if it is recent; after a quiet period the caller waits,
  // so counts never come from hours ago.
  const STALE_READ_MODEL_MS = 120_000;
  let addressDataValueAt = 0;
  let syncQueueValueAt = 0;
  let addressDataSnapshot: { expiresAt: number; promise: Promise<AddressDataValue> } | undefined;
  let syncQueueSnapshot: { expiresAt: number; promise: Promise<Record<string, unknown>> } | undefined;
  const invalidateAdminReadModels = (): void => {
    addressDataValue = undefined;
    syncQueueValue = undefined;
    addressDataSnapshot = undefined;
    syncQueueSnapshot = undefined;
  };
  const loadAddressDataSnapshot = (): ReturnType<typeof listAddressData> => {
    if (addressDataSnapshot && addressDataSnapshot.expiresAt > Date.now()) return addressDataSnapshot.promise;
    const stale = addressDataValue;
    const promise = (async () => {
      await ensureCoverage();
      const [queue, chinaStatus] = await Promise.all([loadSyncQueueUpstream(), china.status()]);
      const queueStates = new Map((queue?.entries || []).map((entry) => [String(entry.countryCode), {
        state: String(entry.state),
        reason: entry.reason == null ? null : String(entry.reason),
        nextAttemptAt: entry.nextAttemptAt == null ? null : String(entry.nextAttemptAt)
      }]));
      return listAddressData(addressDb, chinaStatus, queueStates);
    })();
    addressDataSnapshot = { expiresAt: Number.POSITIVE_INFINITY, promise };
    void promise.then((value) => {
      addressDataValue = value;
      addressDataValueAt = Date.now();
      if (addressDataSnapshot?.promise === promise) addressDataSnapshot.expiresAt = Date.now() + 10_000;
    }, () => {
      if (addressDataSnapshot?.promise === promise) addressDataSnapshot = undefined;
    });
    return stale === undefined || Date.now() - addressDataValueAt > STALE_READ_MODEL_MS ? promise : Promise.resolve(stale);
  };
  const loadSyncQueueSnapshot = (): Promise<Record<string, unknown>> => {
    if (syncQueueSnapshot && syncQueueSnapshot.expiresAt > Date.now()) return syncQueueSnapshot.promise;
    const stale = syncQueueValue;
    const promise = (async () => {
      const [upstream, chinaStatus, goals] = await Promise.all([
        loadSyncQueueUpstream(),
        china.status().catch(async (): Promise<Record<string, unknown>> => {
          const runtime = await addressDb.prepare(`SELECT execution_state,next_attempt_at,reason
            FROM sync_country_runtime WHERE country_code='CN'`).first<Record<string, unknown>>();
          return runtime ? {
            syncState: runtime.execution_state,
            nextAttemptAt: runtime.next_attempt_at,
            waitReason: runtime.reason
          } : {};
        }),
        evaluateCountryGoals(addressDb)
      ]);
      let chinaEntry: Record<string, unknown> | null = null;
      const goal = goals.get('CN');
      if (goal?.enabled) {
        const syncState = String(chinaStatus.syncState || '');
        const state = syncState === 'running' ? 'running'
          : syncState === 'quota_wait' ? 'quota_wait'
            : syncState === 'cooldown_wait' ? 'cooldown_wait'
              : ['source_limited', 'blocked', 'failed'].includes(syncState) ? syncState
                : goal.complete ? 'done' : 'queued';
        const waitReason = (chinaStatus.waitReason as string | null) || null;
        chinaEntry = {
          countryCode: 'CN', state, deficit: goal.deficit, target: goal.target, current: goal.current,
          unmetRules: goal.unmetRules, rules: goal.rules,
          position: null,
          nextAttemptAt: (chinaStatus.nextAttemptAt as string | null) ?? null,
          reason: state === 'blocked' && ['unconfigured', 'missing_credentials'].includes(String(waitReason || ''))
            ? 'missing_api_key:china_maps' : waitReason || (state === 'queued' ? 'china_worker' : null),
          engine: 'china-worker'
        };
      }
      const staleEntries = Array.isArray(syncQueueValue?.entries)
        ? syncQueueValue.entries as Array<Record<string, unknown>> : [];
      const upstreamEntries = upstream?.entries || staleEntries.filter((entry) => entry.countryCode !== 'CN');
      const genericEntries: Array<Record<string, unknown>> = upstreamEntries.map((entry): Record<string, unknown> => {
        const countryGoal = goals.get(String(entry.countryCode));
        return countryGoal ? {
          ...entry,
          current: countryGoal.current,
          target: countryGoal.target,
          deficit: countryGoal.deficit,
          unmetRules: countryGoal.unmetRules,
          rules: countryGoal.rules
        } : entry;
      });
      const entries: Array<Record<string, unknown>> = [...(chinaEntry ? [chinaEntry] : []), ...genericEntries]
        .sort((left, right) => {
          const countryPriority = Number(String(left.countryCode) !== 'CN') - Number(String(right.countryCode) !== 'CN');
          if (countryPriority) return countryPriority;
          const ranks: Record<string, number> = {
            running: 0, queued: 1, retry_wait: 2, cooldown_wait: 3, quota_wait: 4, scheduled_wait: 5,
            source_limited: 6, suspended: 7, no_source: 8, blocked: 9, failed: 10, done: 11
          };
          return (ranks[String(left.state)] ?? 9) - (ranks[String(right.state)] ?? 9)
            || Number(left.position ?? Number.MAX_SAFE_INTEGER) - Number(right.position ?? Number.MAX_SAFE_INTEGER)
            || String(left.countryCode).localeCompare(String(right.countryCode));
        });
      let position = 0;
      for (const entry of entries) if (entry.state === 'queued') entry.position = ++position;
      return {
        available: Boolean(upstream && !upstream.stale),
        generatedAt: upstream?.generatedAt || null,
        job: upstream?.job ?? null,
        entries
      };
    })();
    syncQueueSnapshot = { expiresAt: Number.POSITIVE_INFINITY, promise };
    void promise.then((value) => {
      syncQueueValue = value;
      syncQueueValueAt = Date.now();
      if (syncQueueSnapshot?.promise === promise) syncQueueSnapshot.expiresAt = Date.now() + 10_000;
    }, () => {
      if (syncQueueSnapshot?.promise === promise) syncQueueSnapshot = undefined;
    });
    return stale === undefined || !stale.available || Date.now() - syncQueueValueAt > STALE_READ_MODEL_MS
      ? promise : Promise.resolve(stale);
  };

  if (warmReadModels) queueMicrotask(() => {
    void Promise.all([loadAddressDataSnapshot(), loadSyncQueueSnapshot()]).catch(() => undefined);
  });

  app.onError((error, context) => {
    context.header('Cache-Control', 'no-store');
    const code = error.message || 'INTERNAL_ERROR';
    const clientError = /^(?:INVALID_|PASSWORD_LENGTH|PASSWORD_CONFIRM_MISMATCH|FRONTEND_PASSWORD_REQUIRED|TOKEN_NAME_REQUIRED|TOKEN_ALREADY_EXISTS|API_TOKEN_|AREACITY_SOURCE_|AREACITY_DATA_|SOURCE_AND_VERSION_REQUIRED|POLICY_)/u.test(code);
    const status = ['CHINA_SYNC_BUSY', 'NO_AVAILABLE_KEY', 'BROWSER_MAP_CREDENTIAL_EXISTS', 'TOKEN_ALREADY_EXISTS'].includes(code) ? 409
      : ['CREDENTIAL_NOT_FOUND', 'BROWSER_MAP_CREDENTIAL_NOT_FOUND', 'API_TOKEN_NOT_FOUND', 'POLICY_NODE_NOT_FOUND'].includes(code) ? 404
        : ['API_TOKEN_SECRET_UNAVAILABLE'].includes(code) ? 409 : clientError ? 400 : 500;
    return context.json({ error: status < 500 ? code : 'INTERNAL_ERROR' }, status);
  });
  app.use('/admin/api/*', async (context, next) => {
    context.header('Cache-Control', 'no-store');
    const publicRoute = ['/admin/api/status', '/admin/api/login', '/admin/api/session'].includes(context.req.path);
    if (!publicRoute) {
      const token = getCookie(context, adminCookie) || '';
      const csrf = context.req.method === 'GET' ? undefined : context.req.header('x-csrf-token') || '';
      if (!await control.session(token, 'admin', csrf)) return context.json({ error: 'UNAUTHORIZED' }, 401);
      if (await control.renewAdminSession(token)) {
        setCookie(context, adminCookie, token, { ...secureCookie, maxAge: adminCookieMaxAge });
        const csrfToken = getCookie(context, adminCsrfCookie);
        if (csrfToken) setCookie(context, adminCsrfCookie, csrfToken, { ...csrfCookie, maxAge: adminCookieMaxAge });
      }
      const passwordRoute = ['/admin/api/logout', '/admin/api/settings/access'].includes(context.req.path);
      if (!passwordRoute && await control.setting('admin_password_change_required', false)) {
        return context.json({ error: 'ADMIN_PASSWORD_CHANGE_REQUIRED' }, 403);
      }
    }
    await next();
  });

  app.get('/admin/api/status', async (context) => context.json({ data: await control.status() }));
  app.post('/admin/api/login', async (context) => {
    const ip = requestClientAddress(context.req.raw, context.env?.remoteAddress, trustProxy);
    if (await control.loginBlocked(ip)) return context.json({ error: 'LOGIN_RATE_LIMITED' }, 429);
    const input = await context.req.json<{ password?: string }>().catch((): { password?: string } => ({}));
    if (!await control.verifyIdentity('admin', String(input.password || ''))) {
      await control.recordLoginFailure(ip);
      return context.json({ error: 'INVALID_CREDENTIALS' }, 401);
    }
    await control.clearLoginFailures(ip);
    const session = await control.createSession('admin', ip);
    const status = await control.status();
    setCookie(context, adminCookie, session.token, { ...secureCookie, maxAge: adminCookieMaxAge });
    setCookie(context, adminCsrfCookie, session.csrf, { ...csrfCookie, maxAge: adminCookieMaxAge });
    await control.audit('admin', 'session.login', 'admin');
    return context.json({ data: {
      csrfToken: session.csrf,
      expiresAt: session.expiresAt,
      passwordChangeRequired: status.passwordChangeRequired
    } });
  });
  app.post('/admin/api/logout', async (context) => {
    await control.deleteSession(getCookie(context, adminCookie) || '');
    deleteCookie(context, adminCookie, { path: '/' });
    deleteCookie(context, adminCsrfCookie, { path: '/' });
    return context.json({ data: { success: true } });
  });
  app.get('/admin/api/session', async (context) => {
    const token = getCookie(context, adminCookie) || '';
    let csrf = getCookie(context, adminCsrfCookie) || '';
    if (!csrf || !await control.session(token, 'admin', csrf)) csrf = await control.refreshSessionCsrf(token, 'admin') || '';
    if (!csrf) return context.json({ data: { authenticated: false } });
    if (await control.renewAdminSession(token)) setCookie(context, adminCookie, token, { ...secureCookie, maxAge: adminCookieMaxAge });
    setCookie(context, adminCsrfCookie, csrf, { ...csrfCookie, maxAge: adminCookieMaxAge });
    return context.json({ data: {
      authenticated: true,
      passwordChangeRequired: await control.setting('admin_password_change_required', false)
    } });
  });

  const dayStart = (value: string | undefined): string => {
    const parsed = Date.parse(value || '');
    const now = Date.now();
    if (Number.isFinite(parsed) && parsed <= now && now - parsed <= 48 * 60 * 60_000) return new Date(parsed).toISOString();
    const today = new Date();
    return new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())).toISOString();
  };
  const systemStatus = async (since: string) => {
    const [growth, lastUpdatedAt, scheduler, databaseBytes, apiRequestsToday] = await Promise.all([
      addressDb.prepare(`SELECT COALESCE(SUM(net_growth),0) AS total FROM sync_run_countries
        WHERE net_growth IS NOT NULL AND completed_at>=?`).bind(since).first<number>('total').catch(() => null),
      addressDb.prepare(`SELECT MAX(completed_at) AS updated_at FROM sync_run_countries
        WHERE net_growth IS NOT NULL AND net_growth<>0`).first<string>('updated_at').catch(() => null),
      addressDb.prepare(`SELECT heartbeat_at FROM sync_scheduler_state WHERE scheduler_id='address-sync'`)
        .first<string>('heartbeat_at').catch(() => null),
      addressDb.prepare('SELECT pg_database_size(current_database()) AS total').first<number>('total').catch(() => null),
      control.providerRequestsToday().catch(() => null)
    ]);
    const heartbeat = Date.parse(String(scheduler || ''));
    const databaseHealthy = databaseBytes !== null;
    const schedulerHealthy = Number.isFinite(heartbeat) && Date.now() - heartbeat <= 3 * 60_000;
    return {
      todayGrowth: Number(growth || 0),
      apiRequestsToday: Number(apiRequestsToday || 0),
      databaseBytes: Number(databaseBytes || 0),
      lastUpdatedAt: lastUpdatedAt || null,
      schedulerHeartbeatAt: scheduler || null,
      databaseHealthy,
      schedulerHealthy,
      serviceHealthy: databaseHealthy && schedulerHealthy
    };
  };
  app.get('/admin/api/system/status', async (context) => context.json({ data: await systemStatus(dayStart(context.req.query('since'))) }));
  app.get('/admin/api/dashboard/overview', async (context) => {
    const parent = String(context.req.query('parent') || '');
    if (parent.length > 512) return context.json({ error: 'INVALID_COVERAGE_PARENT' }, 400);
    await ensureCoverage(context.req.query('refresh') === 'true');
    const [nodes, status] = await Promise.all([
      listAddressCoverage(addressDb, parent),
      systemStatus(dayStart(context.req.query('since')))
    ]);
    const countryNodes = parent ? await listAddressCoverage(addressDb) : nodes.filter((node) => node.level === 0);
    const lowestLevels = countryNodes.map((node) => node.coverageLevels?.at(-1)).filter(Boolean);
    const coveredLowest = lowestLevels.reduce((total, level) => total + Number(level?.covered || 0), 0);
    const totalLowest = lowestLevels.reduce((total, level) => total + Number(level?.total || 0), 0);
    return context.json({ data: {
      nodes,
      countries: countryNodes,
      metrics: {
        ...status,
        countryCount: countryNodes.length,
        addressTotal: countryNodes.reduce((total, node) => total + node.totalCount, 0),
        residentialTotal: countryNodes.reduce((total, node) => total + node.residentialCount, 0),
        coveredLowest,
        totalLowest,
        coverageRate: totalLowest ? coveredLowest / totalLowest : 0
      }
    } });
  });
  app.put('/admin/api/sync/policies/countries/:country', async (context) => {
    const countryCode = context.req.param('country').toUpperCase();
    const value = await updateCountryPolicy(addressDb, countryCode, await context.req.json<Record<string, unknown>>());
    invalidateAdminReadModels();
    await control.audit('admin', 'sync_policy.country.update', countryCode, value);
    let sync: Record<string, unknown> = { accepted: false, reason: value.enabled ? 'unavailable' : 'disabled' };
    if (value.enabled) {
      if (countryCode === 'CN') {
        await wakeChina();
        sync = { accepted: true };
      } else if (triggerCountrySync) {
        sync = await triggerCountrySync(countryCode).catch(() => ({ accepted: false, reason: 'unavailable' }));
      }
    }
    return context.json({ data: { ...value, sync } });
  });
  app.get('/admin/api/sync/policies/countries/:country/nodes', async (context) => {
    await ensureCoverage();
    return context.json({ data: await listCountryNodeTargets(addressDb, context.req.param('country').toUpperCase()) });
  });
  app.put('/admin/api/sync/policies/countries/:country/nodes/:nodeKey', async (context) => {
    const countryCode = context.req.param('country').toUpperCase();
    const nodeKey = context.req.param('nodeKey');
    if (!nodeKey || nodeKey.length > 512 || !nodeKey.startsWith(`${countryCode}:`)) {
      return context.json({ error: 'INVALID_POLICY_NODE' }, 400);
    }
    const input = await context.req.json<{ minCount?: number }>();
    const value = await upsertNodeTarget(addressDb, nodeKey, input.minCount);
    invalidateAdminReadModels();
    await control.audit('admin', 'sync_policy.node_target.update', nodeKey, { minCount: value.minCount });
    if (countryCode === 'CN') await wakeChina();
    return context.json({ data: value });
  });
  app.delete('/admin/api/sync/policies/countries/:country/nodes/:nodeKey', async (context) => {
    const countryCode = context.req.param('country').toUpperCase();
    const nodeKey = context.req.param('nodeKey');
    if (!nodeKey || nodeKey.length > 512 || !nodeKey.startsWith(`${countryCode}:`)) {
      return context.json({ error: 'INVALID_POLICY_NODE' }, 400);
    }
    await deleteNodeTarget(addressDb, nodeKey);
    invalidateAdminReadModels();
    await control.audit('admin', 'sync_policy.node_target.delete', nodeKey);
    return context.json({ data: { success: true } });
  });

  app.get('/admin/api/sync/queue', async (context) => context.json({ data: await loadSyncQueueSnapshot() }));
  app.get('/admin/api/sync/history', async (context) => {
    const limit = Number.parseInt(context.req.query('limit') || '100', 10);
    const offset = Number.parseInt(context.req.query('offset') || '0', 10);
    return context.json({ data: await control.syncHistory(limit, context.req.query('country') || '', offset) });
  });

  app.get('/admin/api/settings/access', async (context) => context.json({ data: await control.status() }));
  app.get('/admin/api/settings/blacklist', (context) => context.json({ data: {
    keywords: customBlacklistKeywords(),
    builtIn: Object.entries(nonResidentialRules).map(([category, rule]) => ({
      category,
      terms: [...new Set([...(rule.terms.zh || []), ...(rule.terms.en || [])])]
    }))
  } }));
  app.put('/admin/api/settings/blacklist', async (context) => {
    const input = await context.req.json<{ keywords?: unknown[] }>();
    const keywords = replaceCustomBlacklist(input.keywords ?? []);
    await control.audit('admin', 'settings.blacklist.update', 'address-filter', { keywordCount: keywords.length });
    return context.json({ data: { keywords } });
  });
  app.put('/admin/api/settings/access', async (context) => {
    const input = await context.req.json<{
      frontendPasswordEnabled?: boolean; frontendPassword?: string; frontendPasswordConfirmation?: string;
      apiAuthEnabled?: boolean; adminPassword?: string; adminPasswordConfirmation?: string;
    }>();
    delete input.apiAuthEnabled;
    await control.updateAccessSettings(input, getCookie(context, adminCookie) || '');
    return context.json({ data: await control.status() });
  });

  app.get('/admin/api/settings/country-shortcuts', async (context) => {
    return context.json({ data: await control.countryShortcutAdminSettings() });
  });
  app.get('/admin/api/settings/country-shortcuts/:country/options', async (context) => {
    const country = context.req.param('country').toUpperCase();
    const field = context.req.query('field') as CatalogField;
    if (!isCountryCode(country)) return context.json({ error: 'INVALID_COUNTRY' }, 400);
    if (!['region', 'city', 'postcode'].includes(field)) return context.json({ error: 'INVALID_FIELD' }, 400);
    const query = (context.req.query('q') || '').trim().slice(0, 100);
    const catalog = await queryLocationCatalog(addressDb, {
      country,
      field,
      query,
      residential: country === 'CN',
      cursor: context.req.query('cursor') || undefined,
      limit: 100
    });
    return context.json({ data: catalog });
  });
  app.put('/admin/api/settings/country-shortcuts/:country', async (context) => {
    const countryCode = context.req.param('country').toUpperCase();
    if (!isCountryCode(countryCode)) return context.json({ error: 'INVALID_COUNTRY' }, 400);
    const input = await context.req.json<unknown>().catch(() => undefined);
    try {
      const value = await control.updateCountryShortcuts(countryCode, input);
      await control.audit('admin', 'settings.country_shortcuts.update', countryCode, {
        popularCities: value.popularCities.length,
        adminShortcuts: value.adminShortcuts.length,
        specialAreas: value.specialAreas.length
      });
      return context.json({ data: { ...value, customized: true } });
    } catch (error) {
      const code = error instanceof Error ? error.message : 'INVALID_COUNTRY_SHORTCUTS';
      if (code === 'INVALID_COUNTRY_SHORTCUTS' || code === 'DUPLICATE_COUNTRY_SHORTCUT') {
        return context.json({ error: code }, 400);
      }
      throw error;
    }
  });
  app.delete('/admin/api/settings/country-shortcuts/:country', async (context) => {
    const countryCode = context.req.param('country').toUpperCase();
    if (!isCountryCode(countryCode)) return context.json({ error: 'INVALID_COUNTRY' }, 400);
    const value = await control.resetCountryShortcuts(countryCode);
    await control.audit('admin', 'settings.country_shortcuts.reset', countryCode);
    return context.json({ data: { ...value, customized: false } });
  });

  const indexTranslateSettings = async () => {
    try { return normalizeIndexTranslateSettings(await control.setting(INDEX_TRANSLATE_SETTINGS_KEY, {})); } catch { return normalizeIndexTranslateSettings({}); }
  };
  const translationSettings = async () => ({
    googleTranslationEnabled: Boolean(await control.setting('google_translation_enabled', true)),
    googleTranslationConcurrency: Number(await control.setting('google_translation_concurrency', 1)),
    indexTranslate: await indexTranslateSettings(),
    routes: await control.translationRoutes()
  });
  app.get('/admin/api/settings/translation', async (context) => context.json({ data: await translationSettings() }));
  app.put('/admin/api/settings/translation', async (context) => {
    const input = await context.req.json<{ googleTranslationEnabled?: unknown; googleTranslationConcurrency?: unknown; indexTranslate?: unknown }>();
    const hasEnabled = input.googleTranslationEnabled !== undefined;
    const hasConcurrency = input.googleTranslationConcurrency !== undefined;
    let indexTranslateUpdate: ReturnType<typeof normalizeIndexTranslateSettings> | undefined;
    if (input.indexTranslate !== undefined) {
      try { indexTranslateUpdate = normalizeIndexTranslateSettings(input.indexTranslate, await indexTranslateSettings()); }
      catch { return context.json({ error: 'INVALID_TRANSLATION_CONFIG' }, 400); }
    }
    if ((!hasEnabled && !hasConcurrency && !indexTranslateUpdate) || (hasEnabled && typeof input.googleTranslationEnabled !== 'boolean')
      || (hasConcurrency && !(Number.isInteger(input.googleTranslationConcurrency)
        && Number(input.googleTranslationConcurrency) >= 1 && Number(input.googleTranslationConcurrency) <= 50))) {
      return context.json({ error: 'INVALID_TRANSLATION_CONFIG' }, 400);
    }
    if (hasEnabled) {
      const googleRoute = (await control.translationRoutes()).find((route) => route.provider === 'google');
      if (googleRoute) await control.updateTranslationRoutes([{ id: googleRoute.id, priority: googleRoute.priority, enabled: Boolean(input.googleTranslationEnabled) }]);
      await control.setSetting('google_translation_enabled', input.googleTranslationEnabled);
    }
    if (hasConcurrency) await control.setSetting('google_translation_concurrency', input.googleTranslationConcurrency);
    if (indexTranslateUpdate) await control.setSetting(INDEX_TRANSLATE_SETTINGS_KEY, indexTranslateUpdate);
    await control.audit('admin', 'settings.translation.update', 'translation', {
      ...(hasEnabled ? { googleTranslationEnabled: input.googleTranslationEnabled } : {}),
      ...(hasConcurrency ? { googleTranslationConcurrency: input.googleTranslationConcurrency } : {}),
      ...(indexTranslateUpdate ? { indexTranslate: indexTranslateUpdate } : {})
    });
    return context.json({ data: await translationSettings() });
  });
  // Translates the diagnostic values with the saved settings or the unsaved ones in the form; nothing is stored.
  app.post('/admin/api/settings/translation/index-translate/test', async (context) => {
    const input: Record<string, unknown> = await context.req.json<Record<string, unknown>>().catch(() => ({}));
    let settings;
    try { settings = normalizeIndexTranslateSettings({ ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}) }, await indexTranslateSettings()); }
    catch { return context.json({ error: 'INVALID_TRANSLATION_CONFIG' }, 400); }
    const started = Date.now();
    try {
      const translations = await indexTranslate([...OPENAI_COMPATIBLE_DIAGNOSTIC_VALUES], 'zh-CN', settings, fetch);
      const intact = Boolean(translations?.every((item, index) => preservesAddressNumbers(OPENAI_COMPATIBLE_DIAGNOSTIC_VALUES[index], item)
        && preservesAddressIdentifiers(OPENAI_COMPATIBLE_DIAGNOSTIC_VALUES[index], item)));
      await control.audit('admin', 'settings.translation.index_translate.test', 'index-translate', { success: intact });
      return intact
        ? context.json({ data: { success: true, translations, durationMs: Date.now() - started } })
        : context.json({ error: 'PROVIDER_TEST_FAILED', detail: 'INDEX_TRANSLATE_IDENTIFIERS_CHANGED', translations }, 502);
    } catch (error) {
      return context.json({ error: 'PROVIDER_TEST_FAILED', detail: (error as { code?: string }).code || 'INDEX_TRANSLATE_FAILED' }, 502);
    }
  });
  app.put('/admin/api/settings/translation/routes', async (context) => {
    const input = await context.req.json<{ routes?: unknown }>().catch(() => ({ routes: undefined }));
    if (!Array.isArray(input.routes)) return context.json({ error: 'INVALID_TRANSLATION_ROUTES' }, 400);
    const routes = await control.updateTranslationRoutes(input.routes);
    await control.audit('admin', 'settings.translation.routes.update', 'translation', { routeCount: routes.length });
    return context.json({ data: routes });
  });

  app.get('/admin/api/settings/youdao', async (context) => context.json({ data: await control.youdaoCredentialStatus() }));
  app.put('/admin/api/settings/youdao', async (context) => {
    const input = await context.req.json<{ appKey?: string; appSecret?: string }>();
    await control.upsertYoudaoCredential(String(input.appKey || ''), String(input.appSecret || ''));
    await control.audit('admin', 'settings.youdao.update', 'youdao');
    return context.json({ data: await control.youdaoCredentialStatus() });
  });

  app.get('/admin/api/settings/maps', async (context) => context.json({ data: {
    ...await control.mapDisplayConfig(),
    amapBrowser: await control.browserMapCredentialStatus()
  } }));
  app.put('/admin/api/settings/maps', async (context) => {
    const input = await context.req.json<MapDisplayConfig>();
    const value = await control.updateMapDisplayConfig(input);
    await control.audit('admin', 'settings.maps.update', 'maps', { google: value.google, amap: value.amap });
    return context.json({ data: { ...value, amapBrowser: await control.browserMapCredentialStatus() } });
  });
  app.post('/admin/api/maps/amap-browser', async (context) => {
    const input = await context.req.json<BrowserMapCredentialInput>();
    await control.createBrowserMapCredential(input);
    const status = await control.browserMapCredentialStatus();
    await control.audit('admin', 'browser_map_credential.create', 'amap', { enabled: status.enabled });
    return context.json({ data: status }, 201);
  });
  app.put('/admin/api/maps/amap-browser', async (context) => {
    const input = await context.req.json<BrowserMapCredentialUpdate>();
    await control.updateBrowserMapCredential(input);
    await control.audit('admin', 'browser_map_credential.update', 'amap', {
      labelChanged: Boolean(input.label?.trim()), apiKeyChanged: Boolean(input.apiKey?.trim()),
      securityCodeChanged: Boolean(input.securityCode?.trim()), enabled: input.enabled
    });
    return context.json({ data: await control.browserMapCredentialStatus() });
  });
  app.delete('/admin/api/maps/amap-browser', async (context) => {
    await control.deleteBrowserMapCredential();
    await control.audit('admin', 'browser_map_credential.delete', 'amap');
    return context.json({ data: await control.browserMapCredentialStatus() });
  });
  app.post('/admin/api/maps/amap-browser/reveal', async (context) => {
    return context.json({ data: await control.revealBrowserMapCredential() });
  });

  app.get('/admin/api/tokens', async (context) => context.json({ data: await control.listApiTokens() }));
  app.post('/admin/api/tokens', async (context) => {
    const input = await context.req.json<{ name?: string; token?: string; scopes?: string[]; rateLimit?: number; expiresAt?: string | null }>();
    if (!input.name?.trim()) return context.json({ error: 'TOKEN_NAME_REQUIRED' }, 400);
    const rateLimit = Number(input.rateLimit ?? 60);
    if (!Number.isInteger(rateLimit) || rateLimit < 1 || rateLimit > 100000) return context.json({ error: 'INVALID_TOKEN_RATE_LIMIT' }, 400);
    const created = await control.createApiToken({ name: input.name, token: input.token, scopes: input.scopes, rateLimit, expiresAt: input.expiresAt });
    await control.audit('admin', 'api_token.create', created.id, { name: input.name, scopes: input.scopes || ['*'], hasCustomToken: Boolean(input.token?.trim()) });
    return context.json({ data: created }, 201);
  });
  app.put('/admin/api/tokens/:id', async (context) => {
    const input = await context.req.json<{ scopes?: string[]; rateLimit?: number; expiresAt?: string | null }>();
    await control.updateApiToken(context.req.param('id'), input);
    await control.audit('admin', 'api_token.update', context.req.param('id'), {
      scopesChanged: input.scopes !== undefined, rateLimitChanged: input.rateLimit !== undefined, expiresAtChanged: Object.hasOwn(input, 'expiresAt')
    });
    return context.json({ data: await control.listApiTokens() });
  });
  app.post('/admin/api/tokens/:id/reveal', async (context) => {
    return context.json({ data: await control.revealApiToken(context.req.param('id')) });
  });
  app.delete('/admin/api/tokens/:id', async (context) => {
    await control.revokeApiToken(context.req.param('id'));
    await control.audit('admin', 'api_token.revoke', context.req.param('id'));
    return context.json({ data: { success: true } });
  });

  app.get('/admin/api/providers', async (context) => context.json({ data: await control.listCredentials() }));
  const resolveOpenAIBase = async <T extends Record<string, unknown>>(input: T, existingId?: string): Promise<T> => {
    if (typeof input.baseUrl !== 'string' || !input.baseUrl.trim()) return input;
    const apiKey = typeof input.apiKey === 'string' && input.apiKey.trim() ? input.apiKey.trim()
      : existingId ? (await control.revealOpenAICompatibleCredential(existingId).catch(() => null))?.apiKey : undefined;
    const baseUrl = await resolveOpenAICompatibleBaseUrl({ apiKey: apiKey || 'unresolved-key-placeholder', baseUrl: input.baseUrl });
    return baseUrl ? { ...input, baseUrl } : input;
  };
  app.post('/admin/api/providers', async (context) => {
    const raw = await context.req.json<CredentialInput>();
    const input = raw.provider === 'openai-compatible' ? await resolveOpenAIBase(raw as CredentialInput & Record<string, unknown>) : raw;
    const id = await control.addCredential(input);
    await control.audit('admin', 'provider_key.create', id, { provider: input.provider });
    notifyCredentialChange(input.provider);
    return context.json({ data: { id } }, 201);
  });
  app.put('/admin/api/providers/:id', async (context) => {
    const id = context.req.param('id');
    const raw = await context.req.json<Record<string, unknown>>();
    const existing = typeof raw.baseUrl === 'string' ? await control.credentialForDiagnostics(id) : null;
    const input = existing?.provider === 'openai-compatible' ? await resolveOpenAIBase(raw, id) : raw;
    const provider = await control.updateCredential(id, input);
    await control.audit('admin', 'provider_key.update', context.req.param('id'));
    notifyCredentialChange(provider);
    return context.json({ data: { success: true } });
  });
  app.delete('/admin/api/providers/:id', async (context) => {
    const provider = await control.deleteCredential(context.req.param('id'));
    await control.audit('admin', 'provider_key.delete', context.req.param('id'));
    notifyCredentialChange(provider);
    return context.json({ data: { success: true } });
  });
  app.post('/admin/api/providers/:id/reveal', async (context) => {
    return context.json({ data: await control.revealCredential(context.req.param('id')) });
  });
  app.post('/admin/api/providers/:id/reveal-fields', async (context) => {
    return context.json({ data: await control.revealCredentialFields(context.req.param('id')) });
  });
  app.post('/admin/api/providers/openai-compatible/models', async (context) => {
    const client = requestClientAddress(context.req.raw, context.env?.remoteAddress, trustProxy);
    if (!modelFetchRateLimiter(client)) return context.json({ error: 'MODEL_FETCH_RATE_LIMITED' }, 429, { 'Retry-After': '600' });
    const input = await context.req.json<Record<string, unknown>>().catch(() => undefined);
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some((key) => !['credentialId', 'apiKey', 'baseUrl', 'model', 'reasoningEffort'].includes(key))) {
      return context.json({ error: 'INVALID_MODEL_FETCH_REQUEST' }, 400);
    }
    const credentialId = typeof input.credentialId === 'string' ? input.credentialId.trim() : '';
    if (credentialId && !/^[a-f\d-]{36}$/iu.test(credentialId)) return context.json({ error: 'INVALID_MODEL_FETCH_REQUEST' }, 400);
    try {
      const stored = credentialId ? await control.revealOpenAICompatibleCredential(credentialId) : undefined;
      const apiKey = typeof input.apiKey === 'string' && input.apiKey.trim() ? input.apiKey.trim() : stored?.apiKey;
      const baseUrl = typeof input.baseUrl === 'string' && input.baseUrl.trim() ? input.baseUrl.trim() : stored?.baseUrl;
      const catalog = await fetchOpenAICompatibleModelCatalog({ apiKey, baseUrl }, fetch);
      await control.audit('admin', 'provider_models.fetch', credentialId || 'temporary', { modelCount: catalog.models.length });
      return context.json({ data: catalog });
    } catch (error) {
      const cause = error as { code?: string; outcome?: string; retryAt?: string | null };
      const code = cause.code || 'MODEL_FETCH_FAILED';
      const status = code === 'INVALID_OPENAI_COMPATIBLE_CREDENTIAL' ? 400
        : cause.outcome === 'qps' ? 429 : 502;
      return context.json({ error: code, ...(cause.outcome ? { outcome: cause.outcome } : {}) }, status,
        cause.retryAt ? { 'Retry-After': String(Math.max(1, Math.ceil((Date.parse(cause.retryAt) - Date.now()) / 1000))) } : undefined);
    }
  });
  app.post('/admin/api/providers/:credential/test', async (context) => {
    const value = context.req.param('credential');
    const selected = (await control.listCredentials()).find((item) => item.id === value);
    if (value === 'deepl' || selected?.provider === 'deepl') {
      if (!credentialBroker) return context.json({ error: 'DEEPL_REQUIRES_BROKER' }, 503);
      try {
        const quota = await credentialBroker.request('deepl.usage', selected ? { credentialId: value } : {}, { maxDispatches: 1 });
        await control.audit('admin', 'provider_key.test', value);
        return context.json({ data: { success: true, resultCount: 0, quota } });
      } catch {
        return context.json({ error: 'PROVIDER_TEST_FAILED' }, 502);
      }
    }
    if (selected?.provider === 'openai-compatible') {
      const credential = await control.credentialForDiagnostics(value);
      if (!credential) return context.json({ error: 'NO_AVAILABLE_KEY' }, 409);
      const prompt = (await control.translationRouteForCredential(credential.id))?.prompt || undefined;
      const result = await diagnoseOpenAICompatible(credential.secret, { mode: 'translate', prompt });
      const intact = Boolean(result.translations?.every((item, index) => preservesAddressNumbers(OPENAI_COMPATIBLE_DIAGNOSTIC_VALUES[index], item)
        && preservesAddressIdentifiers(OPENAI_COMPATIBLE_DIAGNOSTIC_VALUES[index], item)));
      if (result.success && intact) await control.reportCredential(credential.id, 'success');
      else if (['auth', 'quota', 'qps', 'network'].includes(result.outcome)) await control.reportCredential(credential.id, result.outcome as 'auth' | 'quota' | 'qps' | 'network');
      notifyCredentialChange(credential.provider);
      return result.success && intact
        ? context.json({ data: { success: true, resultCount: result.translations?.length || 0 } })
        : context.json({ error: 'PROVIDER_TEST_FAILED', detail: result.code || 'OPENAI_COMPATIBLE_IDENTIFIERS_CHANGED', outcome: result.outcome }, 502);
    }
    const provider = value as CredentialProviderName;
    const credential = (credentialProviderNames as readonly string[]).includes(provider)
      ? await control.acquireCredential(provider)
      : await control.acquireCredentialById(value);
    if (!credential) return context.json({ error: 'NO_AVAILABLE_KEY' }, 409);
    try {
      let resolved: { success: boolean; resultCount: number; quota?: ProviderQuotaObservation };
      if (credential.provider === 'onemap') resolved = await testOneMapCredential(credential.secret);
      else if (isMapProvider(credential.provider)) {
        let quota: ProviderQuotaObservation | undefined;
        const result = await providerFetcher[credential.provider]('北京市', 1, credential.secret, fetch, (value) => { quota = value; });
        resolved = { success: true, resultCount: result.candidates.length, quota };
      } else resolved = await testServiceCredential(credential.provider, credential.secret, fetch,
        credential.provider === 'openai-compatible'
          ? { prompt: (await control.translationRouteForCredential(credential.id))?.prompt || undefined } : {});
      await control.reportCredential(credential.id, 'success', 'quota' in resolved ? resolved.quota : undefined);
      notifyCredentialChange(credential.provider);
      return context.json({ data: resolved });
    } catch (error) {
      const outcome = error instanceof ProviderRequestError ? error.outcome : 'network';
      await control.reportCredential(credential.id, outcome, error instanceof ProviderRequestError
        ? { retryAt: error.retryAt, period: error.quotaPeriod } : undefined);
      notifyCredentialChange(credential.provider);
      return context.json({ error: 'PROVIDER_TEST_FAILED', outcome }, 502);
    }
  });

  app.post('/admin/api/providers/:credential/diagnose', async (context) => {
    const input = await context.req.json<{ mode?: string }>().catch((): { mode?: string } => ({}));
    const mode = input.mode === 'translate' ? 'translate' : 'chat';
    const credential = await control.credentialForDiagnostics(context.req.param('credential'));
    if (!credential || credential.provider !== 'openai-compatible') return context.json({ error: 'PROVIDER_NOT_FOUND' }, 404);
    const prompt = (await control.translationRouteForCredential(credential.id))?.prompt || undefined;
    const result = await diagnoseOpenAICompatible(credential.secret, { mode, prompt });
    if (result.success && result.translations && mode === 'translate') {
      const intact = result.translations.every((value, index) => preservesAddressNumbers(OPENAI_COMPATIBLE_DIAGNOSTIC_VALUES[index], value)
        && preservesAddressIdentifiers(OPENAI_COMPATIBLE_DIAGNOSTIC_VALUES[index], value));
      if (!intact) Object.assign(result, { success: false, outcome: 'request', code: 'OPENAI_COMPATIBLE_IDENTIFIERS_CHANGED',
        steps: [...result.steps, { kind: 'error', key: 'identifiersChanged' }] });
      else result.steps.push({ kind: 'success', key: 'done' });
    }
    if (result.success) await control.reportCredential(credential.id, 'success');
    else if (['auth', 'quota', 'qps', 'network'].includes(result.outcome)) await control.reportCredential(credential.id, result.outcome as 'auth' | 'quota' | 'qps' | 'network');
    notifyCredentialChange(credential.provider);
    await control.audit('admin', 'provider_key.diagnose', credential.id, { mode, success: result.success, code: result.code || null });
    return context.json({ data: result });
  });

  app.get('/admin/api/address-data', async (context) => {
    return context.json({ data: await loadAddressDataSnapshot() });
  });
  app.post('/admin/api/address-data/:country/sync', async (context) => {
    const countryCode = context.req.param('country').toUpperCase();
    const policy = (await listCountryPolicies(addressDb)).find((value) => value.countryCode === countryCode);
    if (!policy) return context.json({ error: 'INVALID_POLICY_COUNTRY' }, 400);
    if (!policy.enabled) return context.json({ error: 'POLICY_COUNTRY_DISABLED' }, 409);
    let result: Record<string, unknown>;
    if (countryCode === 'CN') {
      await wakeChina();
      result = { accepted: true, countryCode };
    } else {
      if (!triggerCountrySync) return context.json({ error: 'SYNC_CONTROL_UNAVAILABLE' }, 503);
      result = await triggerCountrySync(countryCode);
    }
    invalidateAdminReadModels();
    await control.audit('admin', 'address_data.sync.start', countryCode);
    return context.json({ data: result }, 202);
  });
  app.get('/admin/api/china/areas', async (context) => {
    const readAdcode = (name: string): string | undefined => {
      const value = String(context.req.query(name) || '').trim();
      if (!value) return undefined;
      if (!/^\d{6}$/u.test(value)) throw new Error('INVALID_CHINA_ADCODE');
      return value;
    };
    const page = Number(context.req.query('page') || 1);
    const pageSize = Number(context.req.query('pageSize') || 25);
    if (!Number.isInteger(page) || page < 1 || page > 100000 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      return context.json({ error: 'INVALID_PAGINATION' }, 400);
    }
    try {
      return context.json({ data: await china.listAreas({
        provinceAdcode: readAdcode('provinceAdcode'), cityAdcode: readAdcode('cityAdcode'),
        districtAdcode: readAdcode('districtAdcode'), page, pageSize
      }) });
    } catch (error) {
      if (error instanceof Error && error.message === 'INVALID_CHINA_ADCODE') return context.json({ error: error.message }, 400);
      throw error;
    }
  });
  app.post('/admin/api/china/areacity', async (context) => {
    const input = await context.req.json<{ source?: string; version?: string }>();
    if (!input.source || !input.version) return context.json({ error: 'SOURCE_AND_VERSION_REQUIRED' }, 400);
    if (input.source.length > 2048 || input.version.length > 80) return context.json({ error: 'INVALID_AREACITY_INPUT' }, 400);
    const count = await china.importAreaCity(input.source.trim(), input.version.trim());
    return context.json({ data: { count } });
  });
  app.get('/admin/api/china/quality', async (context) => {
    const rows = (await addressDb.prepare(`SELECT city,district,COUNT(*) AS total,
      SUM(CASE WHEN source_count>=2 THEN 1 ELSE 0 END) AS cross_verified
      FROM cn_communities_v2 WHERE active=1 GROUP BY city,district ORDER BY city,district`).all()).results;
    return context.json({ data: rows });
  });
  return app;
};

export const createAccessApi = (control: ControlStore, {
  trustProxy = false, addressDb
}: { trustProxy?: boolean; addressDb?: Database } = {}) => {
  const app = new Hono<{ Bindings: RequestBindings }>();
  const attempts = new Map<string, { count: number; resetAt: number }>();
  const monitorRequests = new Map<string, { count: number; resetAt: number }>();
  const monitorCache = new Map<string, { expiresAt: number; data: unknown }>();
  app.get('/web-api/v1/config/country-shortcuts', async (context) => {
    if (!await authorizeWebRequest(control, context.req.raw)) {
      return context.json({ error: 'FRONTEND_AUTH_REQUIRED' }, 401, { 'Cache-Control': 'no-store' });
    }
    context.header('Cache-Control', 'no-store');
    const shortcuts = await control.countryShortcuts();
    return context.json({ data: addressDb ? resolveCountryShortcuts(addressDb, shortcuts) : shortcuts });
  });
  app.get('/web-api/v1/public-monitor', async (context) => {
    if (!await authorizeWebRequest(control, context.req.raw)) {
      return context.json({ error: 'FRONTEND_AUTH_REQUIRED' }, 401, { 'Cache-Control': 'no-store' });
    }
    if (!addressDb) return context.json({ error: 'MONITOR_UNAVAILABLE' }, 503);
    const ip = requestClientAddress(context.req.raw, context.env?.remoteAddress, trustProxy);
    const requestState = monitorRequests.get(ip);
    if (requestState && requestState.resetAt > Date.now() && requestState.count >= 90) {
      return context.json({ error: 'RATE_LIMITED' }, 429, { 'Cache-Control': 'no-store', 'Retry-After': '60' });
    }
    monitorRequests.set(ip, {
      count: requestState?.resetAt && requestState.resetAt > Date.now() ? requestState.count + 1 : 1,
      resetAt: requestState?.resetAt && requestState.resetAt > Date.now() ? requestState.resetAt : Date.now() + 60_000
    });
    if (monitorRequests.size > 5000) monitorRequests.clear();
    const parent = String(context.req.query('parent') || '');
    if (parent.length > 512) return context.json({ error: 'INVALID_COVERAGE_PARENT' }, 400);
    const cached = monitorCache.get(parent);
    if (cached && cached.expiresAt > Date.now()) {
      context.header('Cache-Control', 'private, max-age=60');
      return context.json({ data: cached.data });
    }
    const [nodes, rootNodes, lastUpdatedAt] = await Promise.all([
      listAddressCoverage(addressDb, parent),
      parent ? listAddressCoverage(addressDb) : Promise.resolve(undefined),
      addressDb.prepare('SELECT MAX(updated_at) AS updated_at FROM admin_coverage_stats').first<string>('updated_at')
    ]);
    const countries = (rootNodes || nodes).filter((node) => node.level === 0);
    const lowestLevels = countries.map((node) => node.coverageLevels?.at(-1)).filter(Boolean);
    const coveredLowest = lowestLevels.reduce((total, level) => total + Number(level?.covered || 0), 0);
    const totalLowest = lowestLevels.reduce((total, level) => total + Number(level?.total || 0), 0);
    const data = {
      nodes,
      countries,
      metrics: {
        countryCount: countries.length,
        addressTotal: countries.reduce((total, node) => total + node.totalCount, 0),
        residentialTotal: countries.reduce((total, node) => total + node.residentialCount, 0),
        coveredLowest,
        totalLowest,
        coverageRate: totalLowest ? coveredLowest / totalLowest : 0,
        lastUpdatedAt: lastUpdatedAt || null
      }
    };
    monitorCache.set(parent, { expiresAt: Date.now() + 60_000, data });
    if (monitorCache.size > 500) monitorCache.clear();
    context.header('Cache-Control', 'private, max-age=60');
    return context.json({ data });
  });
  app.get('/web-api/v1/config/maps', async (context) => {
    if (!await authorizeWebRequest(control, context.req.raw)) {
      return context.json({ error: 'FRONTEND_AUTH_REQUIRED' }, 401, { 'Cache-Control': 'no-store' });
    }
    const countryCode = String(context.req.query('country') || '').trim().toUpperCase();
    if (!/^[A-Z]{2}$/u.test(countryCode)) return context.json({ error: 'INVALID_COUNTRY' }, 400);
    const config = await control.mapDisplayConfig();
    const china = countryCode === 'CN';
    const googleEnabled = china ? config.google.china : config.google.international;
    const amapRequested = china ? config.amap.china : config.amap.international;
    const amapStatus = await control.browserMapCredentialStatus();
    const credential = amapRequested && amapStatus.enabled ? await control.acquireBrowserMapCredential() : null;
    context.header('Cache-Control', 'no-store');
    return context.json({ data: {
      countryCode,
      googleEnabled,
      amapEnabled: Boolean(credential),
      amapConfigured: amapStatus.configured,
      ...(credential ? { amapApiKey: credential.apiKey, serviceHost: amapServicePrefix } : {})
    } });
  });
  app.get('/web-api/v1/auth/status', async (context) => {
    const status = await control.status();
    const authenticated = !status.frontendPasswordEnabled || await control.session(getCookie(context, frontCookie) || '', 'frontend');
    return context.json({ data: { enabled: status.frontendPasswordEnabled, authenticated } });
  });
  app.post('/web-api/v1/auth/login', async (context) => {
    const status = await control.status();
    if (!status.frontendPasswordEnabled) return context.json({ data: { authenticated: true } });
    const ip = requestClientAddress(context.req.raw, context.env?.remoteAddress, trustProxy);
    if (attempts.size > 5000) attempts.clear();
    const attempt = attempts.get(ip);
    if (attempt && attempt.resetAt > Date.now() && attempt.count >= 12) return context.json({ error: 'LOGIN_RATE_LIMITED' }, 429);
    const input = await context.req.json<{ password?: string }>().catch((): { password?: string } => ({}));
    if (!await control.verifyIdentity('frontend', String(input.password || ''))) {
      attempts.set(ip, { count: attempt?.resetAt && attempt.resetAt > Date.now() ? attempt.count + 1 : 1, resetAt: Date.now() + 15 * 60000 });
      return context.json({ error: 'INVALID_CREDENTIALS' }, 401);
    }
    attempts.delete(ip);
    const session = await control.createSession('frontend');
    setCookie(context, frontCookie, session.token, { ...secureCookie, maxAge: 24 * 60 * 60 });
    return context.json({ data: { authenticated: true } });
  });
  app.post('/web-api/v1/auth/logout', async (context) => {
    await control.deleteSession(getCookie(context, frontCookie) || '');
    deleteCookie(context, frontCookie, { path: '/' });
    return context.json({ data: { success: true } });
  });
  return app;
};

export const authorizeWebRequest = async (control: ControlStore, request: Request): Promise<boolean> => {
  if (!await control.setting('frontend_password_enabled', false)) return true;
  const cookie = request.headers.get('cookie') || '';
  const match = cookie.match(/(?:^|;\s*)address_front_session=([^;]+)/u);
  if (!match) return false;
  try { return control.session(decodeURIComponent(match[1]), 'frontend'); }
  catch { return false; }
};

export const apiScopeForPath = (pathname: string): 'read' | 'generate' =>
  (pathname === '/api/v1/generate' || pathname.startsWith('/api/v1/generate/') || pathname.endsWith('/address-translation'))
    ? 'generate' : 'read';

export const authorizeApiRequest = async (control: ControlStore, request: Request): Promise<boolean> => {
  const value = bearer(request.headers.get('authorization') || undefined);
  return (await control.authorizeApiTokenDetailed(value, apiScopeForPath(new URL(request.url).pathname))).status === 'authorized';
};

export const apiAuthorization = async (control: ControlStore, request: Request) => {
  const value = bearer(request.headers.get('authorization') || undefined);
  return control.authorizeApiTokenDetailed(value, apiScopeForPath(new URL(request.url).pathname));
};
