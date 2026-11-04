import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ensureLocationCatalog } from '../server/database/bootstrap';
import type { PostgresDatabase } from '../server/database/postgres.mjs';

const databaseWithCounts = (...counts: Array<Record<string, number>>): PostgresDatabase => ({
  prepare: () => ({
    first: async () => counts.shift() || { regions: 0, cities: 0, postcodes: 0 }
  })
} as unknown as PostgresDatabase);

describe('database bootstrap', () => {
  const expected = { regions: 10, cities: 20, postcodes: 30 };

  it('does not rebuild an already complete location catalog', async () => {
    const runScript = vi.fn(async () => undefined);
    await expect(ensureLocationCatalog(databaseWithCounts(expected), {}, { expected, runScript }))
      .resolves.toEqual(expected);
    expect(runScript).not.toHaveBeenCalled();
  });

  it('builds and verifies a missing location catalog in dependency order', async () => {
    const scripts: string[] = [];
    const runScript = vi.fn(async (script: string) => { scripts.push(script); });
    await expect(ensureLocationCatalog(
      databaseWithCounts({ regions: 0, cities: 0, postcodes: 0 }, expected),
      {},
      { expected, runScript }
    )).resolves.toEqual(expected);
    expect(scripts).toEqual([
      'scripts/sync-location-catalog.mjs',
      'scripts/import-location-catalog.mjs'
    ]);
  });

  it('accepts an upstream catalog that shrank since release when the import loaded its whole seed', async () => {
    const runScript = vi.fn(async () => undefined);
    const shrunk = { regions: 10, cities: 20, postcodes: 26 };
    await expect(ensureLocationCatalog(
      databaseWithCounts({ regions: 0, cities: 0, postcodes: 0 }, shrunk),
      {},
      { expected, runScript, seeded: async () => shrunk }
    )).resolves.toEqual(shrunk);
    // Present on the next start: no second download.
    await expect(ensureLocationCatalog(databaseWithCounts(shrunk), {}, { expected, runScript })).resolves.toEqual(shrunk);
    expect(runScript).toHaveBeenCalledTimes(2);
  });

  it('fails an import that loaded less than its seed or far less than the shipped catalog', async () => {
    const runScript = vi.fn(async () => undefined);
    await expect(ensureLocationCatalog(
      databaseWithCounts({ regions: 0, cities: 0, postcodes: 0 }, { regions: 10, cities: 20, postcodes: 25 }),
      {},
      { expected, runScript, seeded: async () => ({ regions: 10, cities: 20, postcodes: 27 }) }
    )).rejects.toThrow('Location catalog bootstrap incomplete: postcodes');
    await expect(ensureLocationCatalog(
      databaseWithCounts({ regions: 0, cities: 0, postcodes: 0 }, { regions: 10, cities: 20, postcodes: 5 }),
      {},
      { expected, runScript, seeded: async () => ({ regions: 10, cities: 20, postcodes: 5 }) }
    )).rejects.toThrow('Location catalog bootstrap incomplete: postcodes');
  });

  it('indexes staging identifiers before anti-join catalog reconciliation', () => {
    const source = readFileSync(resolve('scripts/sync-location-catalog.mjs'), 'utf8');
    expect(source).toContain('CREATE UNIQUE INDEX catalog_postcodes_staging_id_idx');
    expect(source).toContain('WHERE NOT EXISTS (SELECT 1 FROM catalog_postcodes_staging');
    expect(source).not.toContain('id NOT IN (SELECT id FROM catalog_postcodes_staging)');
  });
});
