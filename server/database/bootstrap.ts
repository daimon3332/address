import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type { PostgresDatabase } from './postgres.mjs';

const execFileAsync = promisify(execFile);
const appRoot = resolve(import.meta.dirname, '..', '..');

type CatalogCounts = { regions: number; cities: number; postcodes: number };
type BootstrapOptions = {
  expected?: CatalogCounts;
  seeded?: () => Promise<CatalogCounts | undefined>;
  runScript?: (script: string) => Promise<void>;
};

// The catalog is built from the upstream files current at install time, which shrink as well as grow (the postcode
// files lost 13% between July and November 2026), so a catalog counts as present at this share of the shipped totals.
// A fresh import must load every row its own seed holds.
const PRESENT_SHARE = 0.8;
const shortOf = (counts: CatalogCounts, required: CatalogCounts, share = 1): string[] =>
  (Object.keys(required) as Array<keyof CatalogCounts>).filter((key) => counts[key] < Math.floor(Number(required[key]) * share));
const seededTotals = async (environment: NodeJS.ProcessEnv): Promise<CatalogCounts | undefined> => {
  const directory = String(environment.LOCATION_CATALOG_CACHE_DIR || '').trim();
  if (!directory) return undefined;
  try {
    return (JSON.parse(await readFile(resolve(directory, 'location-catalog.meta.json'), 'utf8')) as { totals: CatalogCounts }).totals;
  } catch {
    return undefined;
  }
};

const catalogCounts = async (database: PostgresDatabase): Promise<CatalogCounts> => {
  const row = await database.prepare(`SELECT
    (SELECT COUNT(*) FROM catalog_regions) AS regions,
    (SELECT COUNT(*) FROM catalog_cities) AS cities,
    (SELECT COUNT(*) FROM catalog_postcodes) AS postcodes`).first() as Record<string, unknown>;
  return {
    regions: Number(row?.regions || 0),
    cities: Number(row?.cities || 0),
    postcodes: Number(row?.postcodes || 0)
  };
};

export const ensureLocationCatalog = async (
  database: PostgresDatabase,
  environment: NodeJS.ProcessEnv = process.env,
  options: BootstrapOptions = {}
): Promise<CatalogCounts> => {
  const expected = options.expected || (JSON.parse(
    await readFile(resolve(appRoot, 'src/domain/location-catalog.meta.json'), 'utf8')
  ) as { totals: CatalogCounts }).totals;
  const current = await catalogCounts(database);
  if (!shortOf(current, expected, PRESENT_SHARE).length) return current;

  for (const script of ['scripts/sync-location-catalog.mjs', 'scripts/import-location-catalog.mjs']) {
    if (options.runScript) await options.runScript(script);
    else {
      await execFileAsync(process.execPath, [resolve(appRoot, script)], {
        cwd: appRoot,
        env: environment,
        timeout: 60 * 60_000,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true
      });
    }
  }
  const imported = await catalogCounts(database);
  const seeded = await (options.seeded ? options.seeded() : seededTotals(environment));
  const missing = [...new Set([...shortOf(imported, expected, PRESENT_SHARE), ...seeded ? shortOf(imported, seeded) : []])];
  if (missing.length) {
    throw new Error(`Location catalog bootstrap incomplete: ${missing.join(', ')} (imported ${JSON.stringify(imported)}, seed ${
      JSON.stringify(seeded || null)}, shipped ${JSON.stringify(expected)})`);
  }
  return imported;
};
