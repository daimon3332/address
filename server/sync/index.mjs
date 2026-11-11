import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSyncApi } from './api.mjs';
import { createSyncArtifactCleanup } from './artifact-cleanup.mjs';
import { createPostgresPool, initializePostgres, PostgresDatabase } from '../database/postgres.mjs';
import { SyncCoordinator } from './coordinator.mjs';
import { SyncHistoryStore } from './history-store.mjs';
import { createSyncQueue } from './queue.mjs';
import { runAddressSync, syncPostgresStatementTimeout } from './run-address-sync.mjs';
import { startDailyScheduler } from './scheduler.mjs';
import { createSourceAdapters, loadSourceCatalog } from './source-adapters.mjs';
import { ensureAddressPolicies } from './address-policy.mjs';
import { reconcilePublishedPoolProjections, validatePublishedPoolBatch } from '../database/published-pool.mjs';
import { refreshStaleAddressGenerationIndexes } from '../database/generation-index.mjs';
import { refreshIndexedResidentialCoverage } from '../database/residential-coverage.mjs';
import { refreshAddressCoverage } from '../control/coverage';
import { runPostcodeInference } from './postcode-inference.mjs';
import { repairChineseAddressStrings } from './chinese-address-repair.mjs';
import { repairTaiwanOfficialNames } from './taiwan-name-repair.mjs';
import { repairCatalogNativeAddresses } from './catalog-native-repair.mjs';
import { repairIndiaEnglishAddresses } from './india-english-repair.mjs';
import { repairAddressStructure } from './address-structure-repair.mjs';
import { repairAdministrativeNames } from './administrative-names-repair.mjs';
import { ensureEvidenceDatasetIndex } from '../database/evidence-dataset-index.mjs';
import { masterKeyFrom } from '../control/security';
import { ControlStore } from '../control/store';
import { ChinaDataService } from '../china/service';

const POOL_CLOSE_GRACE_MS = 10_000;

const integer = (value, fallback, minimum, maximum) => {
  const number = value === undefined || value === '' ? fallback : Number.parseInt(value, 10);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`Expected an integer between ${minimum} and ${maximum}`);
  }
  return number;
};
const enabled = (value) => /^(1|true|yes)$/iu.test(String(value || ''));

const ensureChinaTargets = async (database, environment, postgresUrl) => {
  if (String(environment.NODE_ENV || '').toLowerCase() === 'test'
    || !String(environment.CONFIG_MASTER_KEY || '').trim()) return;
  const count = Number(await database.prepare('SELECT COUNT(*) AS total FROM cn_sync_targets').first('total') || 0);
  const control = new ControlStore(database, masterKeyFrom(environment.CONFIG_MASTER_KEY));
  const china = new ChinaDataService(database, control, resolve(environment.ADDRESS_DATA_ROOT || 'data'), {
    postgresUrl,
    masterKey: masterKeyFrom(environment.CONFIG_MASTER_KEY)
  });
  if (count === 0) {
    await china.initializeTargets({ scheduleContinuation: false });
    await china.close();
    return;
  }
  void china.replayRecoverableCandidates()
    .catch((error) => console.error('[china-sync] candidate replay failed', error))
    .finally(() => china.close());
};

export const createPublicationValidationWorker = ({
  validate,
  intervalMs = 1_000,
  log = console
}) => {
  let stopped = true;
  let completed = false;
  let timer;
  let running;

  const run = async () => {
    if (stopped || completed || running) return;
    running = Promise.resolve()
      .then(validate)
      .then((result) => {
        if (result.retired || result.countryCompleted) {
          log.log?.(`[publication-validation] country=${result.countryCode} scanned=${result.scanned} retired=${result.retired}`);
        }
        completed = Boolean(result.completed);
      })
      .catch((error) => log.error?.('[publication-validation] batch failed', error))
      .finally(() => { running = undefined; });
    await running;
    if (!stopped && !completed) timer = setTimeout(() => { void run(); }, intervalMs);
  };

  return {
    start: () => {
      if (!stopped) return;
      stopped = false;
      void run();
    },
    stop: async () => {
      stopped = true;
      clearTimeout(timer);
      await running;
    }
  };
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
  database: providedDatabase,
  stateDir = resolve(environment.SYNC_STATE_DIR || '.data-cache/sync-control'),
  utcHour = integer(environment.SYNC_UTC_HOUR, 3, 0, 23),
  now = () => new Date()
} = {}) => {
  let testDatabase;
  if (!providedDatabase && environment.NODE_ENV === 'test' && environment.ADDRESS_TEST_DATABASE === 'memory') {
    const { initializeTestDatabase, openTestDatabase } = await import('../../tests/helpers/postgres-test-database.mjs');
    testDatabase = openTestDatabase(':memory:');
    await initializeTestDatabase(testDatabase, new URL('../control/schema.sql', import.meta.url));
    providedDatabase = testDatabase;
  }
  const postgresPool = providedDatabase ? undefined : createPostgresPool({
    environment,
    statement_timeout: syncPostgresStatementTimeout(environment),
    application_name: 'address-sync'
  });
  if (postgresPool) await initializePostgres(postgresPool);
  const database = providedDatabase || new PostgresDatabase(postgresPool);
  const queueDatabase = providedDatabase || new PostgresDatabase(postgresPool);
  await ensureAddressPolicies(database);
  // A full projection check scans every published address; it must not delay the health endpoint.
  // Each startup step is independent: one timeout must not skip the others.
  let closing = false;
  // Startup checks stop at the next step once the service is closing instead of holding database connections.
  const startupStep = (name, task) => (closing ? Promise.resolve() : task()).catch((error) => {
    console.error(`[address-sync] startup ${name} failed`, error?.code || error?.message || error);
  });
  const startupReconciliation = (async () => {
    if (environment.NODE_ENV === 'test') {
      await startupStep('projection reconciliation', () => reconcilePublishedPoolProjections(database));
      return;
    }
    // Runs beside the other startup steps: a concurrent build waits for running import transactions.
    if (postgresPool) void startupStep('evidence dataset index', async () => {
      const client = await postgresPool.connect();
      try { await ensureEvidenceDatasetIndex(client); } finally { client.release(); }
    });
    if (postgresPool) void startupStep('storage compaction', async () => {
      const { dropRedundantEvidenceIndex, purgeCompletedRecovery } = await import('./storage-compaction.mjs');
      const client = await postgresPool.connect();
      try { await dropRedundantEvidenceIndex(client); } finally { client.release(); }
      const deleted = await purgeCompletedRecovery({ database });
      if (deleted) console.log(`[address-sync] removed ${deleted} completed translation recovery rows`);
    });
    await startupStep('postcode inference', async () => {
      const countries = (await database.prepare("SELECT country_code FROM sync_country_policies WHERE enabled=1 AND country_code<>'CN' ORDER BY country_code").all()).results;
      for (const { country_code: countryCode } of countries) {
        const summary = await runPostcodeInference({ database, countryCode, cacheDir: environment.ADDRESS_SYNC_CACHE_DIR || resolve('.data-cache'),
          pythonBin: environment.PYTHON_BIN }).catch((error) => ({ countryCode, error: error?.message || String(error) }));
        if (summary.checked || summary.error) console.log(JSON.stringify({ event: 'postcode_inference', ...summary }));
        if (summary.filledIds?.length) {
          const names = await repairAdministrativeNames({ database, countryCode, addressIds: summary.filledIds,
            cacheDir: environment.ADDRESS_SYNC_CACHE_DIR || resolve('.data-cache'), pythonBin: environment.PYTHON_BIN || 'python3' })
            .catch((error) => ({ countryCode, error: error?.code || error?.message || String(error) }));
          if (names.changed || names.retired || names.duplicates || names.error) console.log(JSON.stringify({ event: 'administrative_names_repair', scoped: true, ...names }));
        }
      }
    });
    await startupStep('chinese address spacing', async () => {
      const countries = (await database.prepare("SELECT country_code FROM sync_country_policies WHERE enabled=1 AND country_code<>'CN' ORDER BY country_code").all()).results;
      for (const { country_code: countryCode } of countries) {
        const summary = await repairChineseAddressStrings({ database, countryCode });
        if (summary.repaired) console.log(JSON.stringify({ event: 'chinese_address_repair', ...summary }));
      }
    });
    await startupStep('english-first republication', async () => {
      const { republishEnglishReadyRows } = await import('./translation-backfill.mjs');
      const countries = (await database.prepare("SELECT country_code FROM sync_country_policies WHERE enabled=1 AND country_code<>'CN' ORDER BY country_code").all()).results;
      for (const { country_code: countryCode } of countries) {
        const summary = await republishEnglishReadyRows({ database, countryCode });
        if (summary.republished) console.log(JSON.stringify({ event: 'english_first_republication', ...summary }));
      }
    });
    await startupStep('taiwan official names', async () => {
      const summary = await repairTaiwanOfficialNames({ database });
      if (summary.renamed || summary.duplicates) console.log(JSON.stringify({ event: 'taiwan_official_name_repair', ...summary }));
    });
    await startupStep('catalog native names', async () => {
      for (const summary of await repairCatalogNativeAddresses({ database })) {
        console.log(JSON.stringify({ event: 'catalog_native_name_repair', ...summary }));
      }
    });
    await startupStep('india english addresses', async () => {
      const summary = await repairIndiaEnglishAddresses({ database });
      if (summary.cleaned || summary.retired || summary.duplicates) console.log(JSON.stringify({ event: 'india_english_repair', ...summary }));
    });
    await startupStep('address structure', async () => {
      const countries = (await database.prepare("SELECT country_code FROM sync_country_policies WHERE enabled=1 AND country_code<>'CN' ORDER BY country_code").all()).results;
      for (const { country_code: countryCode } of countries) {
        const summary = await repairAddressStructure({ database, countryCode,
          cacheDir: environment.ADDRESS_SYNC_CACHE_DIR || resolve('.data-cache'), pythonBin: environment.PYTHON_BIN || 'python3' })
          .catch((error) => ({ countryCode, error: error?.code || error?.message || String(error) }));
        if (summary.changed || summary.retired || summary.duplicates || summary.error) console.log(JSON.stringify({ event: 'address_structure_repair', ...summary }));
      }
    });
    await startupStep('administrative names', async () => {
      const countries = (await database.prepare("SELECT country_code FROM sync_country_policies WHERE enabled=1 AND country_code<>'CN' ORDER BY country_code").all()).results;
      for (const { country_code: countryCode } of countries) {
        const summary = await repairAdministrativeNames({ database, countryCode,
          cacheDir: environment.ADDRESS_SYNC_CACHE_DIR || resolve('.data-cache'), pythonBin: environment.PYTHON_BIN || 'python3' })
          .catch((error) => ({ countryCode, error: error?.code || error?.message || String(error) }));
        if (summary.changed || summary.retired || summary.duplicates || summary.error) console.log(JSON.stringify({ event: 'administrative_names_repair', ...summary }));
      }
    });
    await startupStep('postcode requirement', async () => {
      const { retirePostcodeLessRows } = await import('./postcode-requirement.mjs');
      const countries = (await database.prepare("SELECT country_code FROM sync_country_policies WHERE enabled=1 ORDER BY country_code").all()).results;
      for (const { country_code: countryCode } of countries) {
        const summary = await retirePostcodeLessRows({ database, countryCode });
        if (summary.retired) console.log(JSON.stringify({ event: 'postcode_required_repair', ...summary }));
      }
    });
    // Permanently retired rows are deleted; rows retired for a missing postcode only once their country's official
    // postcode sources ran. Korea waits for its postcode-area application (2026-10-27).
    await startupStep('retired address purge', async () => {
      const { PERMANENT_RETIREMENT_PREFIXES, purgePermanentRetirements, vacuumAddressTables } = await import('./retired-purge.mjs');
      const { postcodeRecoveryDone } = await import('./postcode-inference.mjs');
      const countries = (await database.prepare("SELECT country_code FROM sync_country_policies WHERE enabled=1 ORDER BY country_code").all()).results;
      let deleted = 0;
      for (const { country_code: countryCode } of countries) {
        const keepPostcode = countryCode === 'KR' || !await postcodeRecoveryDone(database, countryCode);
        const prefixes = PERMANENT_RETIREMENT_PREFIXES.filter((prefix) => !keepPostcode || prefix !== 'postcode-required-');
        const summary = await purgePermanentRetirements({ database, countryCode, prefixes });
        deleted += summary.deleted;
        if (summary.deleted) console.log(JSON.stringify({ event: 'retired_address_purge', ...summary }));
      }
      if (deleted >= 100_000 && postgresPool) {
        const client = await postgresPool.connect();
        try { await vacuumAddressTables(client); } finally { client.release(); }
      }
    });
    // A full recount of every country takes hours on a large pool, so restarts within a day skip it; publication and
    // backfill keep the projections current in between.
    await startupStep('projection reconciliation', async () => {
      const key = 'projection-reconciliation';
      const last = JSON.parse(await database.prepare('SELECT value_json FROM translation_backfill_progress WHERE key=?')
        .bind(key).first('value_json') || '{}');
      if (Date.now() - Date.parse(last.checkedAt || 0) < 24 * 60 * 60_000) return;
      const reconciled = await reconcilePublishedPoolProjections(database);
      const checkedAt = new Date().toISOString();
      await database.prepare(`INSERT INTO translation_backfill_progress(key,value_json,updated_at) VALUES (?,?,?)
        ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`)
        .bind(key, JSON.stringify({ checkedAt, reconciled }), checkedAt).run();
    });
    await startupStep('generation index refresh', () => refreshStaleAddressGenerationIndexes(database));
    await startupStep('residential coverage', () => refreshIndexedResidentialCoverage(database, undefined, { skipLocked: true }));
    await startupStep('address coverage', () => refreshAddressCoverage(database, { useGenerationIndex: true }));
    console.log(JSON.stringify({ event: 'startup_coverage_ready', at: new Date().toISOString() }));
  })();
  await ensureChinaTargets(database, environment, environment.POSTGRES_URL || environment.DATABASE_URL || '');
  const scheduleStateFile = resolve(stateDir, 'daily-schedule.json');
  let catalogPromise;
  const catalogShards = () => {
    if (!catalogPromise) {
      catalogPromise = loadSourceCatalog(undefined, environment)
        .then((catalog) => catalog.shards)
        .catch((error) => {
          catalogPromise = null;
          throw error;
        });
    }
    return catalogPromise;
  };
  const history = new SyncHistoryStore(queueDatabase, { catalogShards, now });
  await history.repairInterruptedRuns();
  await history.repairFailedRunGrowth();
  await history.repairLegacyProjections();
  const coordinator = new SyncCoordinator({
    stateDir,
    now,
    history,
    jobTimeoutMs: integer(environment.SYNC_JOB_TIMEOUT_MS, 150 * 60_000, 60_000, 24 * 60 * 60_000),
    cancelGraceMs: integer(environment.SYNC_CANCEL_GRACE_MS, 30_000, 5_000, 10 * 60_000),
    runSync: ({ id, trigger, shards, signal, onProgress }) => runSync({
      releaseId: id,
      signal,
      onProgress,
      database,
      environment: {
        ...environment,
        ADDRESS_SYNC_JOB_ID: id,
        ADDRESS_SYNC_TRIGGER: trigger,
        ADDRESS_SYNC_SHARDS: shards.join(',')
      }
    })
  });
  await coordinator.initialize();
  const artifactCleanup = environment.ADDRESS_SYNC_CACHE_DIR ? createSyncArtifactCleanup({
    cacheDir: environment.ADDRESS_SYNC_CACHE_DIR,
    isBusy: () => Boolean(coordinator.currentJob),
    staleMs: integer(environment.ADDRESS_SYNC_ARTIFACT_STALE_MS, 6 * 60 * 60_000, 60_000, 30 * 24 * 60 * 60_000),
    intervalMs: integer(environment.ADDRESS_SYNC_CLEANUP_INTERVAL_MS, 15 * 60_000, 60_000, 24 * 60 * 60_000),
    retainRaw: enabled(environment.ADDRESS_SYNC_RETAIN_RAW)
  }) : null;
  artifactCleanup?.start();
  const publicationValidationWorker = createPublicationValidationWorker({
    validate: () => validatePublishedPoolBatch(queueDatabase),
    intervalMs: integer(environment.PUBLICATION_VALIDATION_INTERVAL_MS, 1_000, 100, 60_000)
  });
  const runIdleMaintenance = async () => {
    await artifactCleanup?.runOnce();
  };
  const queue = createSyncQueue({
    environment,
    coordinator,
    stateDir,
    now,
    addressDatabase: queueDatabase,
    controlDatabase: queueDatabase,
    history,
    loadCatalog: async () => ({ shards: await catalogShards() }),
    probeSource: async (shard) => createSourceAdapters({ environment, processConcurrency: 1 })
      .discover(shard, {
        includeAssetSizes: false,
        syncMode: 'probe',
        cacheDir: environment.ADDRESS_SYNC_CACHE_DIR
      }),
    onIdle: runIdleMaintenance
  });
  const handler = createSyncApi({
    coordinator,
    queue,
    token: environment.SYNC_ADMIN_TOKEN,
    allowedOrigin: environment.SYNC_ADMIN_ORIGIN || ''
  });
  const api = (request) => handler(stripPrefix(request));
  let stopScheduler;
  let stopQueue;
  return {
    startupReconciliation,
    api,
    database,
    coordinator,
    queue,
    startScheduler: ({ startup = true } = {}) => {
      if (!enabled(environment.SYNC_SCHEDULER_ENABLED)) return () => {};
      if (stopScheduler) return stopScheduler;
      publicationValidationWorker.start();
      stopQueue = queue.start();
      stopScheduler = startDailyScheduler({
        coordinator,
        stateFile: scheduleStateFile,
        utcHour,
        now,
        wakePlanner: async () => {
          await history.schedulerHeartbeat(coordinator.currentJob?.id || null);
          queue.poke();
        }
      });
      if (startup) queue.poke();
      return () => {
        stopScheduler?.();
        stopScheduler = undefined;
        stopQueue?.();
        stopQueue = undefined;
      };
    },
    close: async () => {
      closing = true;
      stopScheduler?.();
      stopScheduler = undefined;
      stopQueue = undefined;
      await artifactCleanup?.stop();
      const queueStop = queue.stop();
      await coordinator.cancelActive();
      await queueStop;
      await publicationValidationWorker.stop();
      testDatabase?.close();
      // A long consistency query still holding a client must not keep the service from stopping; the process exit
      // closes that connection and PostgreSQL rolls back its work.
      if (postgresPool) await Promise.race([postgresPool.end(), new Promise((done) => setTimeout(done, POOL_CLOSE_GRACE_MS).unref())]);
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
  let stopBackfill = async () => {};
  if (!/^(0|false|no)$/iu.test(String(process.env.TRANSLATION_BACKFILL_ENABLED || ''))) {
    const { startTranslationBackfill } = await import('./translation-backfill.mjs');
    stopBackfill = startTranslationBackfill({
      database: runtime.database,
      isBusy: () => Boolean(runtime.coordinator.currentJob)
    });
    console.log('Translation backfill worker enabled');
  }
  const shutdown = async () => {
    try {
      await stopBackfill();
      await new Promise((done) => server.close(done));
      await runtime.close();
      process.exit(0);
    } catch (error) {
      console.error('[address-sync] shutdown failed', error);
      process.exit(1);
    }
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}
