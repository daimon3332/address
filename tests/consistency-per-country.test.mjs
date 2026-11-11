import { describe, expect, it } from 'vitest';
import { refreshStaleAddressGenerationIndexes } from '../server/database/generation-index.mjs';
import { reconcilePublishedPoolProjections } from '../server/database/published-pool.mjs';

// One country's query timing out must not stop the others from being checked; the failure is still reported.
const fakeDatabase = (rows) => {
  const checked = [];
  const statement = (sql, values = []) => ({
    bind: (...next) => statement(sql, next),
    all: async () => ({ results: /FROM sync_country_policies/u.test(sql) ? [{ country_code: 'AA' }, { country_code: 'BB' }]
      : /DISTINCT country_code FROM address_pool/u.test(sql) ? [{ country_code: 'AA' }, { country_code: 'BB' }] : [] }),
    first: async () => {
      if (/country_code>\?/u.test(sql)) return { '': 'AA', AA: 'BB' }[values[0]];
      checked.push(values[0]);
      if (values[0] === 'AA' && /address_pool_runtime/u.test(sql)) throw Object.assign(new Error('canceled'), { code: '57014' });
      return rows(sql);
    }
  });
  return { checked, prepare: (sql) => statement(sql) };
};

describe('per-country consistency checks', () => {
  it('keeps checking generation indexes after one country times out', async () => {
    const database = fakeDatabase((sql) => /address_pool_runtime/u.test(sql)
      ? { source_count: 3, matched_index_count: 3 } : { index_count: 3, missing_ranks: 0, missing_residential_ranks: 0 });
    await expect(refreshStaleAddressGenerationIndexes(database)).rejects.toThrow('AA:57014');
    expect(database.checked).toContain('BB');
  });

  it('keeps reconciling projections after one country times out', async () => {
    const database = fakeDatabase((sql) => /address_pool_runtime/u.test(sql) ? { total: 3, residential: 1 }
      : /address_generation_index/u.test(sql) ? { total: 3, residential: 1 }
        : /admin_coverage_stats/u.test(sql) ? { total_count: 3, residential_count: 1 } : { address_count: 3, residential_count: 1 });
    await expect(reconcilePublishedPoolProjections(database)).rejects.toThrow('AA:57014');
    expect(database.checked).toContain('BB');
  });
});
