import { describe, expect, it } from 'vitest';
import app from '../server/api/index';

const healthDatabase = ({ low = false }: { low?: boolean } = {}) => {
  const statements: string[] = [];
  const database = {
    prepare(sql: string) {
      statements.push(sql);
      const statement = {
        bind() { return statement; },
        async all() {
          if (sql.includes('FROM address_pool address')) {
            return { results: [
              { country_code: 'US', total: 20, residential: 12 },
              { country_code: 'JP', total: 16, residential: 9 }
            ] };
          }
          if (sql.includes('ready_slot_count')) {
            return { results: [
              { country_code: 'US', slot_count: 2, ready_slot_count: low ? 1 : 2, active_count: 20 },
              { country_code: 'JP', slot_count: 1, ready_slot_count: 1, active_count: 16 }
            ] };
          }
          return { results: low ? [{
            coverage_key: 'pool:US:pa:philadelphia:residential', country_code: 'US', admin1_key: 'pa',
            locality_key: 'philadelphia', property_type: 'residential', active_count: 3, minimum_count: 8,
            refresh_status: 'low', expires_at: null
          }] : [] };
        }
      };
      return statement;
    }
  };
  return { database, statements };
};

describe('data health hot-pool readiness', () => {
  it('reports ready coverage for all configured countries', async () => {
    const { database, statements } = healthDatabase();
    const response = await app.request('/api/v1/data-health', {}, {
      ALLOWED_ORIGIN: '*', ADDRESS_DB: database,
      HOT_POOL_COUNTRIES: 'US,JP', HOT_POOL_MIN_PER_SLOT: '8'
    });
    const payload = await response.json() as { data: Record<string, any> };

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(payload.data).toMatchObject({
      status: 'ready', requiredCountries: ['US', 'JP'], minimumPerSlot: 8,
      residentialRecords: 21,
      hotPool: {
        available: true, totalSlots: 3, readySlots: 3, lowWaterSlotCount: 0,
        coverageRate: 1, missingCountries: [], lowWaterSlots: [], lowWaterSlotsTruncated: false
      },
      configurationErrors: []
    });
    const countQuery = statements.find((sql) => sql.includes('FROM address_pool address'));
    expect(countQuery).toContain('COUNT(*) AS total');
    expect(countQuery).toContain("evidence_type='residential_use'");
    expect(statements.find((sql) => sql.includes('ready_slot_count'))).toContain(
      "THEN coverage.residential_count ELSE coverage.active_count END AS active_count"
    );
    expect(payload.data.perCountry.find(({ country }: { country: string }) => country === 'US')).toMatchObject({
      hotPoolRequired: true, hotPoolSlots: 2, readyHotPoolSlots: 2, lowWaterSlots: 0,
      hotPoolCoverageRate: 1
    });
  });

  it('reports missing countries and low-water slots as degraded', async () => {
    const { database } = healthDatabase({ low: true });
    const response = await app.request('/api/v1/data-health', {}, {
      ALLOWED_ORIGIN: '*', ADDRESS_DB: database,
      HOT_POOL_COUNTRIES: 'US,JP,CN', HOT_POOL_MIN_PER_SLOT: '8'
    });
    const payload = await response.json() as { data: Record<string, any> };

    expect(payload.data.status).toBe('degraded');
    expect(payload.data.hotPool).toMatchObject({
      totalSlots: 3, readySlots: 2, lowWaterSlotCount: 1,
      coverageRate: 2 / 3, missingCountries: ['CN'], lowWaterSlotsTruncated: false
    });
    expect(payload.data.hotPool.lowWaterSlots).toContainEqual(expect.objectContaining({
      coverageKey: 'pool:US:pa:philadelphia:residential', activeCount: 3,
      minimumCount: 8, deficit: 5, refreshStatus: 'low'
    }));
  });

  it('reports an unavailable hot pool as degraded', async () => {
    const response = await app.request('/api/v1/data-health', {}, {
      ALLOWED_ORIGIN: '*', HOT_POOL_COUNTRIES: 'US', HOT_POOL_MIN_PER_SLOT: '8'
    });
    const payload = await response.json() as { data: Record<string, any> };

    expect(payload.data.status).toBe('degraded');
    expect(payload.data.hotPool).toMatchObject({
      available: false, totalSlots: 0, readySlots: 0, coverageRate: 0,
      missingCountries: ['US']
    });
  });
});
