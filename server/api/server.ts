import { serve, type HttpBindings } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { resolve } from 'node:path';
import { Hono } from 'hono';
import app from './index';
import { openRuntimeDatabases } from '../database/runtime';
import { masterKeyFrom } from '../control/security';
import { ControlStore, createServiceCredentialResolver, credentialsFromEnvironment, parseYoudaoSecret } from '../control/store';
import {
  apiAuthorization, authorizeWebRequest, coverageNodes, createAccessApi, createAdminApi,
  createAmapProxyRateLimiter, proxyAmapServiceRequest, requestClientAddress
} from '../control/admin-api';
import { ChinaDataService } from '../china/service';
import { createCredentialBrokerClient } from '../credential-broker/client.mjs';
import { OPENAI_COMPATIBLE_TIMEOUT_MS } from '../credential-broker/openai-compatible.mjs';
import { InFlightLimiter, isGenerationPath } from './in-flight-limiter';
import { parseAllowedOrigins } from '../lib/origin-policy';
import { TranslationRouteScheduler } from '../translation/routing.mjs';
import { translateGoogleBatch } from './services/google-translator.ts';
import { indexTranslate, INDEX_TRANSLATE_SETTINGS_KEY, normalizeIndexTranslateSettings } from '../translation/index-translate.mjs';
import { prewarmLocationCatalog, resolveCountryShortcuts } from './repositories/location-catalog';
import { matchLocale } from '../../src/domain/locales';
import { countries } from '../../src/domain/countries';

const integer = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value || String(fallback), 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) throw new Error('API_PORT must be between 1 and 65535');
  return parsed;
};

const runtimeDatabases = await openRuntimeDatabases();
const dataRoot = resolve(process.env.ADDRESS_DATA_ROOT || 'data');
const database = runtimeDatabases.address;
const controlDatabase = runtimeDatabases.control;
const masterKey = masterKeyFrom(process.env.CONFIG_MASTER_KEY);
const control = new ControlStore(controlDatabase, masterKey);
await control.initialize(process.env.ADMIN_BOOTSTRAP_PASSWORD, process.env);
await Promise.all(credentialsFromEnvironment(process.env).map((credential) => control.ensureCredential(credential)));
const credentialBroker = await createCredentialBrokerClient(process.env);
const china = new ChinaDataService(database, control, dataRoot, {
  postgresUrl: runtimeDatabases.postgresUrl,
  masterKey,
  credentialBroker: credentialBroker ? { url: credentialBroker.url, token: credentialBroker.token } : undefined
});
const port = integer(process.env.API_PORT, 8787);
const hostname = process.env.API_HOST || '0.0.0.0';
const trustProxy = process.env.TRUST_PROXY === 'true';
const staticRoot = resolve(process.env.STATIC_ROOT || 'dist');
const syncControlUrl = process.env.SYNC_CONTROL_URL || 'http://127.0.0.1:8791';
const syncControlPublic = process.env.SYNC_CONTROL_PUBLIC === 'true';
const releaseId = process.env.ADDRESS_RELEASE?.trim() || 'development';
const generationInFlightLimit = integer(process.env.API_MAX_INFLIGHT_GENERATIONS, 4);
const generationLimiter = new InFlightLimiter(Math.min(generationInFlightLimit, 128));
const batchGenerationLimiter = new InFlightLimiter(Math.min(
  Math.max(1, Number.parseInt(process.env.BATCH_GENERATION_CONCURRENCY || '4', 10) || 4), 32
));
const allowedOrigins = process.env.ALLOWED_ORIGINS?.trim() || process.env.ALLOWED_ORIGIN?.trim() || '*';
parseAllowedOrigins(allowedOrigins);
// Background prefetches from the web app have their own smaller limit so they can never take the slots that
// user-initiated generation needs.
const prefetchLimiter = new InFlightLimiter(Math.max(1, Math.floor(Math.min(generationInFlightLimit, 128) / 2)));
const runGenerationRequest = async (path: string, task: () => Promise<Response>, prefetch = false): Promise<Response> => {
  if (!isGenerationPath(path) || path.endsWith('/batch')) return task();
  const limiter = prefetch ? prefetchLimiter : generationLimiter;
  if (!limiter.tryAcquire()) {
    return Response.json({ error: 'GENERATION_BUSY' }, {
      status: 429,
      headers: { 'Cache-Control': 'no-store', 'Retry-After': '2' }
    });
  }
  try {
    return await task();
  } finally {
    limiter.release();
  }
};
const triggerCountrySync = async (countryCode: string): Promise<Record<string, unknown>> => {
  const token = process.env.SYNC_ADMIN_TOKEN?.trim();
  if (!token) throw new Error('SYNC_CONTROL_UNAVAILABLE');
  const response = await fetch(new URL('/api/v1/sync/jobs', syncControlUrl), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'manual', shards: [countryCode] }),
    signal: AbortSignal.timeout(15_000)
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (response.status === 409) return { ...body, running: true };
  if (!response.ok) throw new Error('SYNC_CONTROL_UNAVAILABLE');
  return body;
};
const adminApi = createAdminApi({
  control, china, addressDb: database, trustProxy, triggerCountrySync,
  warmReadModels: true, credentialBroker
});
const accessApi = createAccessApi(control, { trustProxy, addressDb: database });
const amapProxyRateLimit = createAmapProxyRateLimiter();
const securityHeaders = (response: Response): Response => {
  response.headers.set('X-Address-Release', releaseId);
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  return response;
};

const staticApp = new Hono<{ Bindings: HttpBindings }>();
staticApp.use('*', serveStatic({ root: staticRoot }));
staticApp.get('*', serveStatic({ root: staticRoot, path: 'index.html' }));

const environment = {
  ADDRESS_DB: database,
  LOCATION_DB: database,
  BATCH_GENERATION_CONCURRENCY: process.env.BATCH_GENERATION_CONCURRENCY || '4',
  GENERATION_SLOT: { tryAcquire: () => generationLimiter.tryAcquire(), release: () => generationLimiter.release() },
  BATCH_GENERATION_SLOT: { tryAcquire: () => batchGenerationLimiter.tryAcquire(), release: () => batchGenerationLimiter.release() },
  ALLOWED_ORIGINS: allowedOrigins,
  AMAP_API_KEY: process.env.AMAP_API_KEY,
  GEOAPIFY_API_KEY: process.env.GEOAPIFY_API_KEY,
  GOOGLE_GEOCODING_API_KEY: process.env.GOOGLE_GEOCODING_API_KEY,
  GOOGLE_TRANSLATION_ENABLED: process.env.GOOGLE_TRANSLATION_ENABLED,
  HOT_POOL_COUNTRIES: process.env.HOT_POOL_COUNTRIES,
  HOT_POOL_MIN_PER_SLOT: process.env.HOT_POOL_MIN_PER_SLOT,
  IP_GEOLOCATION_API_URL: process.env.IP_GEOLOCATION_API_URL,
  IP_GEOLOCATION_FALLBACK_API_URL: process.env.IP_GEOLOCATION_FALLBACK_API_URL,
  ONEMAP_ACCESS_TOKEN: process.env.ONEMAP_ACCESS_TOKEN,
  TRUST_PROXY: process.env.TRUST_PROXY,
  YOUDAO_APP_KEY: process.env.YOUDAO_APP_KEY,
  YOUDAO_APP_SECRET: process.env.YOUDAO_APP_SECRET
};

// Service credentials live in the control store (admin console) with the
// environment as fallback; the 60-second resolver cache keeps request latency flat.
const serviceCredential = createServiceCredentialResolver(control, process.env);
const translationRouteScheduler = new TranslationRouteScheduler();
const requestEnvironment = async () => {
  const youdao = credentialBroker ? undefined : parseYoudaoSecret(await serviceCredential('youdao'));
  const googleTranslationEnabled = Boolean(await control.setting('google_translation_enabled', true));
  let indexSettings = normalizeIndexTranslateSettings({});
  try { indexSettings = normalizeIndexTranslateSettings(await control.setting(INDEX_TRANSLATE_SETTINGS_KEY, {})); } catch { /* defaults stay disabled */ }
  const translationRoutes = credentialBroker
    ? translationRouteScheduler.order((await control.translationRoutes()).filter((route) => route.enabled
      && !['disabled', 'needs_review', 'unconfigured'].includes(route.status)
      && (route.provider !== 'google' || googleTranslationEnabled)
      && (route.provider !== 'index-translate' || indexSettings.enabled))).map((route) => ({
        id: route.id, provider: route.provider,
        translate: async (values: string[], target: string) => {
          if (route.provider === 'google') return translateGoogleBatch(values, 'auto', target, fetch);
          if (route.provider === 'index-translate') return await indexTranslate(values, target, indexSettings, fetch) ?? undefined;
          if (route.provider === 'deepl') {
            const result = await credentialBroker.request('deepl.translate', { values, target, credentialId: route.credentialId }, { maxDispatches: 2 }) as { translations: Array<{ text: string }> };
            return result.translations.map((item: { text: string }) => item.text);
          }
          if (route.provider === 'youdao') {
            const result = await credentialBroker.request('youdao.translate', { values, target, credentialId: route.credentialId }, { maxDispatches: 1 }) as {
              errorCode?: string; translateResults?: Array<{ translation?: string }>;
            };
            if (result.errorCode !== '0' || result.translateResults?.length !== values.length) return undefined;
            return result.translateResults.map((item) => String(item.translation || '').trim());
          }
          if (!route.credentialId) return undefined;
            const result = await credentialBroker.request('openai-compatible.translate', {
              values, target, credentialId: route.credentialId,
              ...(route.prompt ? { prompt: route.prompt } : {})
            }, { maxDispatches: 1, timeoutMs: OPENAI_COMPATIBLE_TIMEOUT_MS + 5_000 }) as { translations?: unknown };
          return Array.isArray(result.translations) && result.translations.every((item) => typeof item === 'string')
            ? result.translations as string[] : undefined;
        }
      }))
    : undefined;
  return {
    ...environment,
    GEOAPIFY_API_KEY: await serviceCredential('geoapify'),
    GOOGLE_GEOCODING_API_KEY: await serviceCredential('google-geocoding'),
    GOOGLE_TRANSLATION_ENABLED: googleTranslationEnabled,
    DEEPL_TRANSLATE: credentialBroker ? async (values: string[], target: string) => {
      const result = await credentialBroker.request('deepl.translate', { values, target }, { maxDispatches: 2 }) as { translations: Array<{ text: string }> };
      return result.translations.map((item: { text: string }) => item.text);
    } : undefined,
    OPENAI_COMPATIBLE_TRANSLATE: credentialBroker ? async (values: string[], target: string) => {
      const result = await credentialBroker.request('openai-compatible.translate', { values, target }, { maxDispatches: 2, timeoutMs: OPENAI_COMPATIBLE_TIMEOUT_MS + 5_000 }) as { translations?: unknown };
      if (!Array.isArray(result?.translations) || result.translations.some((item) => typeof item !== 'string')) {
        throw new Error('OPENAI_COMPATIBLE_INVALID_RESPONSE');
      }
      return result.translations;
    } : undefined,
    YOUDAO_APP_KEY: youdao?.appKey,
    YOUDAO_APP_SECRET: youdao?.appSecret,
    SERVICE_CREDENTIALS: serviceCredential,
    ...(translationRoutes ? { TRANSLATION_ROUTES: translationRoutes } : {})
  };
};

await Promise.all([
  Promise.resolve(app.fetch(new Request('http://127.0.0.1/api/v1/countries'), environment)),
  Promise.resolve(app.fetch(new Request(
    'http://127.0.0.1/api/v1/locations/search?country=US&field=region&residential=true&limit=200'
  ), environment)),
  Promise.resolve(app.fetch(new Request(
    'http://127.0.0.1/api/v1/locations/search?country=CN&field=region&residential=true&limit=200'
  ), environment))
]).catch(() => undefined);

const server = serve({
  fetch: async (request, node) => {
    const url = new URL(request.url);
    const remoteAddress = node.incoming.socket?.remoteAddress || '';
    const requestBindings = { remoteAddress };
    if (url.pathname.startsWith('/admin/api/')) return securityHeaders(await adminApi.fetch(request, requestBindings));
    if (url.pathname === '/_AMapService' || url.pathname.startsWith('/_AMapService/')) {
      if (!amapProxyRateLimit(requestClientAddress(request, remoteAddress, trustProxy))) {
        return securityHeaders(Response.json({ error: 'RATE_LIMITED' }, {
          status: 429, headers: { 'Cache-Control': 'no-store', 'Retry-After': '60' }
        }));
      }
      if (!await authorizeWebRequest(control, request)) {
        return securityHeaders(Response.json({ error: 'FRONTEND_AUTH_REQUIRED' }, { status: 401, headers: { 'Cache-Control': 'no-store' } }));
      }
      return securityHeaders(await proxyAmapServiceRequest(control, request, fetch, allowedOrigins));
    }
    if (url.pathname.startsWith('/web-api/v1/auth/') || url.pathname.startsWith('/web-api/v1/config/')
      || url.pathname === '/web-api/v1/public-monitor') {
      return securityHeaders(await accessApi.fetch(request, requestBindings));
    }
    if (url.pathname === '/sync-control' || url.pathname.startsWith('/sync-control/')) {
      if (!syncControlPublic) return securityHeaders(new Response('Not Found', { status: 404 }));
      const target = new URL(`${url.pathname.slice('/sync-control'.length) || '/'}${url.search}`, syncControlUrl);
      return securityHeaders(await fetch(new Request(target, request)));
    }
    if (url.pathname.startsWith('/web-api/v1/')) {
      if (!await authorizeWebRequest(control, request)) return securityHeaders(Response.json({ error: 'FRONTEND_AUTH_REQUIRED' }, { status: 401 }));
      const target = new URL(request.url);
      target.pathname = target.pathname.replace(/^\/web-api\/v1/u, '/api/v1');
      return securityHeaders(await runGenerationRequest(
        target.pathname,
        async () => app.fetch(new Request(target, request), { ...await requestEnvironment(), ...node }),
        request.headers.get('x-generation-prefetch') === '1'
      ));
    }
    if (url.pathname.startsWith('/api/')) {
      if (request.method === 'OPTIONS') {
        return securityHeaders(await app.fetch(request, { ...environment, ...node }));
      }
      if (!['/api/v1/health', '/api/v1/ready', '/api/v1/openapi.json'].includes(url.pathname)) {
        const authorization = await apiAuthorization(control, request);
        if (authorization.status !== 'authorized') {
          const rateLimited = authorization.status === 'rate_limited';
          return securityHeaders(Response.json({ error: rateLimited ? 'RATE_LIMITED' : 'UNAUTHORIZED' }, {
            status: rateLimited ? 429 : 401,
            headers: rateLimited ? { 'Retry-After': '60' } : undefined
          }));
        }
      }
      return securityHeaders(await runGenerationRequest(
        url.pathname,
        async () => app.fetch(request, { ...await requestEnvironment(), ...node, API_TOKEN_AUTHENTICATED: true })
      ));
    }
    // The bare entry pages only pick a language; answering with the redirect saves loading a page that does it in script.
    const entryPage = url.pathname.match(/^\/(admin|access)?\/?$/u);
    if (entryPage && (request.method === 'GET' || request.method === 'HEAD')) {
      const locale = matchLocale([request.headers.get('accept-language') || '']);
      return securityHeaders(new Response(null, { status: 302, headers: {
        Location: `/${locale}/${entryPage[1] ? `${entryPage[1]}/` : ''}${url.search}`, 'Cache-Control': 'no-store', Vary: 'Accept-Language'
      } }));
    }
    const localizedPublicPage = /^\/(?:en|zh-CN|zh-TW|ja|ko|de|fr|es|pt)\/(?:admin|access)(?:\/|$)/u.test(url.pathname);
    const publicStatic = url.pathname.startsWith('/admin') || url.pathname.startsWith('/access') || localizedPublicPage
      || url.pathname.startsWith('/_astro/') || /\.(?:css|js|svg|png|jpg|jpeg|webp|ico|woff2?|geojson)$/iu.test(url.pathname);
    if (!publicStatic) {
      const requestedLocale = url.pathname.match(/^\/(en|zh-CN|zh-TW|ja|ko|de|fr|es|pt)(?:\/|$)/u)?.[1];
      const accessUrl = new URL(requestedLocale ? `/${requestedLocale}/access/` : '/access/', request.url);
      accessUrl.searchParams.set('next', `${url.pathname}${url.search}`);
      return securityHeaders(await authorizeWebRequest(control, request)
        ? await staticApp.fetch(request, node)
        : Response.redirect(accessUrl, 302));
    }
    const response = await staticApp.fetch(request, node);
    if (url.pathname.startsWith('/_astro/')) response.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    // Hono has no GeoJSON type; served as octet-stream the 270 KB world map was neither compressed nor cached.
    if (url.pathname.endsWith('.geojson') && response.ok) {
      response.headers.set('Content-Type', 'application/geo+json');
      response.headers.set('Cache-Control', 'public, max-age=86400');
    }
    return securityHeaders(response);
  },
  hostname,
  port
}, ({ address, port: listeningPort }) => {
  console.log(`Address service listening on http://${address}:${listeningPort}`);
  // The first visitor after a start would otherwise wait on each of these read models.
  void coverageNodes(database).catch(() => undefined);
  void Promise.resolve(app.fetch(new Request('http://127.0.0.1/api/v1/coverage'), environment)).catch(() => undefined);
  void prewarmLocationCatalog(database, countries.map((country) => ({
    country: country.code, postcode: country.addressSchema.filters.includes('postcode')
  }))).then(async () => resolveCountryShortcuts(database, await control.countryShortcuts())).catch(() => undefined);
});

void china.wake(0).catch((error) => console.error('[china-sync] automatic scheduling failed', error));

let stopping = false;
const shutdown = (): void => {
  if (stopping) return;
  stopping = true;
  server.close((error) => {
    void china.close().finally(() => {
      void runtimeDatabases.close().finally(() => {
        if (error) {
          console.error(error);
          process.exitCode = 1;
        }
      });
    });
  });
};

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
