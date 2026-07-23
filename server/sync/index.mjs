import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSyncApi } from './api.mjs';
import { SyncCoordinator } from './coordinator.mjs';
import { runAddressSync } from './run-address-sync.mjs';
import { startDailyScheduler, startInitialScheduler, triggerStartupSync } from './scheduler.mjs';

const integer = (value, fallback, minimum, maximum) => {
  const number = value === undefined || value === '' ? fallback : Number.parseInt(value, 10);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`Expected an integer between ${minimum} and ${maximum}`);
  }
  return number;
};

const stripPrefix = (request) => {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/sync-control')) return request;
  url.pathname = url.pathname.slice('/sync-control'.length) || '/';
  return new Request(url, request);
};

export const createSyncRuntime = async ({
  environment = process.env,
  runSync = runAddressSync,
  stateDir = resolve(environment.SYNC_STATE_DIR || '.data-cache/sync-control'),
  utcHour = integer(environment.SYNC_UTC_HOUR, 3, 0, 23),
  now = () => new Date()
} = {}) => {
  const scheduleStateFile = resolve(stateDir, 'daily-schedule.json');
  const initialStateFile = resolve(stateDir, 'initial-schedule.json');
  const coordinator = new SyncCoordinator({
    stateDir,
    now,
    runSync: ({ id, trigger, shards }) => runSync({
      releaseId: id,
      databasePath: resolve(environment.ADDRESS_DATABASE_PATH || 'data/address.sqlite'),
      environment: {
        ...environment,
        ADDRESS_SYNC_JOB_ID: id,
        ADDRESS_SYNC_TRIGGER: trigger,
        ADDRESS_SYNC_SHARDS: shards.join(',')
      }
    })
  });
  await coordinator.initialize();
  const handler = createSyncApi({
    coordinator,
    token: environment.SYNC_ADMIN_TOKEN,
    allowedOrigin: environment.SYNC_ADMIN_ORIGIN || ''
  });
  const api = (request) => handler(stripPrefix(request));
  let stopScheduler;
  let stopInitialScheduler;
  return {
    api,
    coordinator,
    startScheduler: ({ startup = true } = {}) => {
      if (stopScheduler) return stopScheduler;
      stopScheduler = startDailyScheduler({ coordinator, stateFile: scheduleStateFile, utcHour, now });
      if (startup) {
        stopInitialScheduler = startInitialScheduler({
          coordinator,
          stateFile: initialStateFile,
          now,
          retryBaseMs: integer(environment.SYNC_INITIAL_RETRY_MS, 5 * 60_000, 1_000, 24 * 60 * 60_000),
          onComplete: () => void triggerStartupSync(coordinator, {
            stateFile: scheduleStateFile,
            utcHour,
            now,
            maxAttempts: integer(environment.SYNC_DAILY_MAX_ATTEMPTS, 3, 1, 10),
            retryBaseMs: integer(environment.SYNC_DAILY_RETRY_MS, 60_000, 1_000, 60 * 60_000)
          }).catch((error) => {
            console.error('Address synchronization startup check failed', error);
          })
        });
      }
      return () => {
        stopInitialScheduler?.();
        stopInitialScheduler = undefined;
        stopScheduler?.();
        stopScheduler = undefined;
      };
    },
    close: async () => {
      stopScheduler?.();
      stopScheduler = undefined;
      stopInitialScheduler?.();
      stopInitialScheduler = undefined;
      await coordinator.waitForIdle();
    }
  };
};

const toWebRequest = async (request) => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
    else if (value !== undefined) headers.set(name, value);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('Request body is too large');
    chunks.push(chunk);
  }
  return new Request(new URL(request.url || '/', 'http://sync.internal'), {
    method: request.method,
    headers,
    ...(chunks.length ? { body: Buffer.concat(chunks) } : {})
  });
};

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const host = process.env.SYNC_HOST || '127.0.0.1';
  const port = integer(process.env.SYNC_PORT, 8791, 1, 65_535);
  const runtime = await createSyncRuntime();
  runtime.startScheduler();
  const server = createServer(async (request, response) => {
    try {
      const webResponse = await runtime.api(await toWebRequest(request));
      response.writeHead(webResponse.status, Object.fromEntries(webResponse.headers));
      response.end(Buffer.from(await webResponse.arrayBuffer()));
    } catch {
      response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ error: 'INTERNAL_ERROR' }));
    }
  });
  server.listen(port, host, () => console.log(`Address sync control listening on http://${host}:${port}`));
  let stopBackfill = () => {};
  if (/^(1|true|yes)$/iu.test(String(process.env.TRANSLATION_BACKFILL_ENABLED || ''))) {
    const { openDatabase } = await import('../database/sqlite.mjs');
    const { startTranslationBackfill } = await import('./translation-backfill.mjs');
    const backfillDb = openDatabase(resolve(process.env.ADDRESS_DATABASE_PATH || 'data/address.sqlite'));
    stopBackfill = startTranslationBackfill({
      database: backfillDb,
      isBusy: () => Boolean(runtime.coordinator.currentJob)
    });
    console.log('Translation backfill worker enabled');
  }
  const shutdown = async () => {
    stopBackfill();
    await new Promise((done) => server.close(done));
    await runtime.close();
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}
