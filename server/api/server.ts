import { serve, type HttpBindings } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { resolve } from 'node:path';
import { Hono } from 'hono';
import app from './index';
import { openDatabase } from '../database/sqlite.mjs';

const integer = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value || String(fallback), 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) throw new Error('API_PORT must be between 1 and 65535');
  return parsed;
};

const databasePath = resolve(process.env.ADDRESS_DATABASE_PATH || 'data/address.sqlite');
const database = openDatabase(databasePath);
const port = integer(process.env.API_PORT, 8787);
const hostname = process.env.API_HOST || '0.0.0.0';
const staticRoot = resolve(process.env.STATIC_ROOT || 'dist');
const syncControlUrl = process.env.SYNC_CONTROL_URL || 'http://127.0.0.1:8791';
const syncControlPublic = process.env.SYNC_CONTROL_PUBLIC === 'true';

const staticApp = new Hono<{ Bindings: HttpBindings }>();
staticApp.use('*', serveStatic({ root: staticRoot }));
staticApp.get('*', serveStatic({ root: staticRoot, path: 'index.html' }));

const environment = {
  ADDRESS_DB: database,
  LOCATION_DB: database,
  ALLOWED_ORIGIN: process.env.ALLOWED_ORIGIN || '*',
  AMAP_API_KEY: process.env.AMAP_API_KEY,
  GEOAPIFY_API_KEY: process.env.GEOAPIFY_API_KEY,
  GOOGLE_GEOCODING_API_KEY: process.env.GOOGLE_GEOCODING_API_KEY,
  GOOGLE_TRANSLATION_ENABLED: process.env.GOOGLE_TRANSLATION_ENABLED,
  IP_GEOLOCATION_API_URL: process.env.IP_GEOLOCATION_API_URL,
  IP_GEOLOCATION_FALLBACK_API_URL: process.env.IP_GEOLOCATION_FALLBACK_API_URL,
  LIVE_API_MODES: process.env.LIVE_API_MODES,
  ONEMAP_ACCESS_TOKEN: process.env.ONEMAP_ACCESS_TOKEN,
  OS_DATA_HUB_API_KEY: process.env.OS_DATA_HUB_API_KEY,
  OVERPASS_API_URL: process.env.OVERPASS_API_URL,
  PHOTON_API_URL: process.env.PHOTON_API_URL,
  TRUST_PROXY: process.env.TRUST_PROXY,
  YOUDAO_APP_KEY: process.env.YOUDAO_APP_KEY,
  YOUDAO_APP_SECRET: process.env.YOUDAO_APP_SECRET
};

await Promise.all([
  Promise.resolve(app.fetch(new Request(
    'http://127.0.0.1/api/v1/generate?country=US&residential=false&strategy=instant&seed=startup-warmup&requestId=startup-warmup'
  ), environment)),
  Promise.resolve(app.fetch(new Request('http://127.0.0.1/api/v1/countries'), environment))
]).catch(() => undefined);

const server = serve({
  fetch: (request, node) => {
    const url = new URL(request.url);
    if (url.pathname === '/sync-control' || url.pathname.startsWith('/sync-control/')) {
      if (!syncControlPublic) return new Response('Not Found', { status: 404 });
      const target = new URL(`${url.pathname.slice('/sync-control'.length) || '/'}${url.search}`, syncControlUrl);
      return fetch(new Request(target, request));
    }
    return url.pathname.startsWith('/api/')
      ? app.fetch(request, { ...environment, ...node })
      : staticApp.fetch(request, node);
  },
  hostname,
  port
}, ({ address, port: listeningPort }) => {
  console.log(`Address service listening on http://${address}:${listeningPort}`);
});

let stopping = false;
const shutdown = (): void => {
  if (stopping) return;
  stopping = true;
  server.close((error) => {
    database.close();
    if (error) {
      console.error(error);
      process.exitCode = 1;
    }
  });
};

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
