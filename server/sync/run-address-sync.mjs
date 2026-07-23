import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../database/sqlite.mjs';
import { runAddressEtl } from './address-etl.mjs';
import { SqliteCountryStateStore } from './sqlite-country-state.mjs';
import { loadSourceCatalog } from './source-adapters.mjs';

const validReleaseId = (value) => {
  const id = String(value || `sync-${Date.now()}`).trim();
  if (!/^[a-zA-Z0-9._:-]{1,120}$/u.test(id)) throw new Error('Invalid address sync job id');
  return id;
};

const enabled = (value) => /^(1|true|yes)$/iu.test(String(value || ''));
const integer = (value, fallback, minimum, maximum) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
};
const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

export const runAddressSync = async ({
  releaseId = process.env.ADDRESS_SYNC_JOB_ID,
  databasePath = resolve(process.env.ADDRESS_DATABASE_PATH || 'data/address.sqlite'),
  database: providedDatabase,
  environment = process.env,
  runEtl = runAddressEtl,
  catalog: providedCatalog,
  wait = delay
} = {}) => {
  const id = validReleaseId(releaseId);
  const syncMode = environment.ADDRESS_SYNC_MODE
    || (environment.ADDRESS_SYNC_TRIGGER === 'initial' ? 'initial' : environment.ADDRESS_SYNC_TRIGGER === 'manual' ? 'manual' : 'daily');
  const usesBuiltInEtl = runEtl === runAddressEtl;
  const database = providedDatabase || (usesBuiltInEtl ? openDatabase(databasePath) : undefined);
  const ownsDatabase = Boolean(database && !providedDatabase);
  try {
    const catalog = providedCatalog || (usesBuiltInEtl ? await loadSourceCatalog() : undefined);
    const stateStore = database && catalog ? new SqliteCountryStateStore({ database, shards: catalog.shards }) : undefined;
    const options = {
      databasePath,
      database,
      catalog,
      stateStore,
      requestedShards: environment.ADDRESS_SYNC_SHARDS ? [environment.ADDRESS_SYNC_SHARDS] : ['all'],
      dryRun: enabled(environment.ADDRESS_SYNC_DRY_RUN),
      estimate: enabled(environment.ADDRESS_SYNC_ESTIMATE),
      force: enabled(environment.ADDRESS_SYNC_FORCE) || environment.ADDRESS_SYNC_TRIGGER === 'manual',
      syncMode,
      requireResidential: enabled(environment.ADDRESS_SYNC_REQUIRE_RESIDENTIAL),
      maxShardsPerRun: syncMode === 'manual' || syncMode === 'initial' ? Number.MAX_SAFE_INTEGER : 1
    };
    const attempts = integer(environment.ADDRESS_SYNC_RETRY_ATTEMPTS, 3, 1, 10);
    const baseDelayMs = integer(environment.ADDRESS_SYNC_RETRY_BASE_MS, 1_000, 1, 60_000);
    let etl;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        etl = await runEtl(options);
        break;
      } catch (error) {
        if (attempt === attempts) throw error;
        const waitMs = Math.min(60_000, baseDelayMs * 2 ** (attempt - 1));
        console.warn(`Address synchronization attempt ${attempt}/${attempts} failed; retrying in ${waitMs}ms`, error);
        await wait(waitMs);
      }
    }
    return { releaseId: id, changed: Boolean(etl.changed), etl };
  } finally {
    if (ownsDatabase) database.close();
  }
};

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const result = await runAddressSync();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
