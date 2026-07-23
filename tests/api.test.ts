import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GeneratedBundle, LocationOption } from '../src/domain/types';
import app from '../server/api/index';

const overpassMock = (country: string, city: string, index = 1) => JSON.stringify({ elements: [{
  type: 'way', id: Number(`${country.charCodeAt(0)}${country.charCodeAt(1)}${index}`),
  center: { lat: 34 + index / 100, lon: -118 - index / 100 },
  tags: {
    'addr:housenumber': String(100 + index), 'addr:street': `Dynamic Street ${index}`,
    'addr:city': city, 'addr:state': 'Dynamic Region', 'addr:postcode': `9000${index}`,
    building: 'apartments'
  }
}] });
const mockBindings = { ALLOWED_ORIGIN: '*', GOOGLE_TRANSLATION_ENABLED: false } as const;

afterEach(() => vi.unstubAllGlobals());

describe('synchronized address registry', () => {
  it('reports countries that still require a synchronized snapshot', async () => {
    const response = await app.request('/api/v1/countries', {}, { ALLOWED_ORIGIN: '*' });
    const payload = await response.json() as { data: Array<{ code: string; addressCount: null; generationMode: string }> };
    expect(response.status).toBe(200);
    expect(payload.data).toHaveLength(27);
    expect(payload.data.every((country) => country.addressCount === null && country.generationMode === 'sync-required')).toBe(true);
  });

  it('reports v2 address and residential coverage from ADDRESS_DB', async () => {
    const statements: string[] = [];
    const addressDb = {
      prepare: (sql: string) => {
        statements.push(sql);
        const statement = {
          bind: () => statement,
          all: async () => ({ results: [{ country_code: 'US', total: 10, residential: 8 }] })
        };
        return statement;
      }
    };
    const response = await app.request('/api/v1/countries', {}, { ALLOWED_ORIGIN: '*', ADDRESS_DB: addressDb });
    const payload = await response.json() as { data: Array<{ code: string; addressCount: number; residentialCount: number; residentialAvailable: boolean; generationMode: string }> };
    expect(payload.data.find(({ code }) => code === 'US')).toMatchObject({
      addressCount: 10, residentialCount: 8, residentialAvailable: false, generationMode: 'synchronized-pool'
    });
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('FROM address_pool address');
    expect(statements[0]).not.toContain('address_pool_runtime');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('marks residential mode available once the evidence-backed pool clears the floor', async () => {
    const addressDb = {
      prepare: () => {
        const statement = {
          bind: () => statement,
          all: async () => ({ results: [{ country_code: 'US', total: 5000, residential: 250 }] })
        };
        return statement;
      }
    };
    const response = await app.request('/api/v1/countries', {}, { ALLOWED_ORIGIN: '*', ADDRESS_DB: addressDb });
    const payload = await response.json() as { data: Array<{ code: string; residentialAvailable: boolean }> };
    expect(payload.data.find(({ code }) => code === 'US')).toMatchObject({ residentialAvailable: true });
  });

  it('aggregates v2 counts from the active address pool', async () => {
    const statements: string[] = [];
    const addressDb = {
      prepare: (sql: string) => {
        statements.push(sql);
        const statement = {
          bind: () => statement,
          all: async () => ({ results: [{ country_code: 'US', total: 7, residential: 3 }] })
        };
        return statement;
      }
    };
    const response = await app.request('/api/v1/countries', {}, { ALLOWED_ORIGIN: '*', ADDRESS_DB: addressDb });
    const payload = await response.json() as { data: Array<{ code: string; addressCount: number; residentialCount: number }> };

    expect(payload.data.find(({ code }) => code === 'US')).toMatchObject({ addressCount: 7, residentialCount: 3 });
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('FROM address_pool address');
    expect(statements[0]).toContain('residential_use');
  });

  it('does not advertise legacy residential coverage when the active pool has none', async () => {
    const legacyDb = {
      prepare: (sql: string) => {
        const statement = {
          bind: () => statement,
          all: async () => ({ results: sql.includes('residential_coverage')
            ? [{ country_code: 'US', total: 13 }]
            : [{ country_code: 'US', total: 50 }] })
        };
        return statement;
      }
    };
    const addressDb = {
      prepare: () => {
        const statement = {
          bind: () => statement,
          all: async () => ({ results: [{ country_code: 'US', total: 10, residential: 0 }] })
        };
        return statement;
      }
    };
    const response = await app.request('/api/v1/countries', {}, {
      ALLOWED_ORIGIN: '*', LOCATION_DB: legacyDb, ADDRESS_DB: addressDb
    });
    const payload = await response.json() as { data: Array<{ code: string; addressCount: number; residentialCount: number; residentialAvailable: boolean }> };
    expect(payload.data.find(({ code }) => code === 'US')).toMatchObject({
      addressCount: 10, residentialCount: 0, residentialAvailable: false
    });
  });

  it('returns configured region and city discovery options without reading address snapshots', async () => {
    const regions = await app.request('/api/v1/locations/search?country=US&field=region', {}, { ALLOWED_ORIGIN: '*' });
    const regionPayload = await regions.json() as { data: { regions: LocationOption[] } };
    const cities = await app.request('/api/v1/locations/search?country=US&field=city', {}, { ALLOWED_ORIGIN: '*' });
    const cityPayload = await cities.json() as { data: { cities: LocationOption[] } };
    expect(regionPayload.data.regions).toContainEqual({ value: 'California', label: 'California（CA）加利福尼亚州' });
    expect(cityPayload.data.cities.map((item) => item.value)).toContain('Los Angeles');
    expect(cityPayload.data.cities.map((item) => item.value)).toContain('Chicago');
  });
});

describe('pool-only and IP address generation', () => {
  it('does not enter an online provider when a regular synchronized pool misses', async () => {
    const response = await app.request('/api/v1/generate?country=US&residential=false&city=Chicago', {}, {
      ...mockBindings, OVERPASS_MOCK: overpassMock('US', 'Chicago')
    });
    const payload = await response.json() as { error: { code: string } };
    expect(response.status).toBe(404);
    expect(payload.error.code).toBe('NO_POOL_COVERAGE');
  });

  it('uses a live nearby provider only for an explicit IP-region request', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      country_code: 'US', region: 'Dynamic Region', city: 'Chicago',
      latitude: 41.8781, longitude: -87.6298
    })));
    const response = await app.request('/api/v1/generate?mode=ip-region&ip=8.8.8.8&residential=true&requestId=res-1', {}, {
      ...mockBindings, OVERPASS_MOCK: overpassMock('US', 'Chicago')
    });
    const payload = await response.json() as { data: { requestId: string; mode: string; country: string; result: GeneratedBundle } };
    expect(payload.data).toMatchObject({ requestId: 'res-1', mode: 'ip-region', country: 'US' });
    expect(payload.data.result.address.evidence.some((item) => item.type === 'residential_use')).toBe(true);
  });

  it('returns prelocalized v2 rows without entering the localization network path', async () => {
    const components = { houseNumber: '4-27-7', street: '永福', locality: '杉並区', admin1: '東京都', admin1Code: '13', postcode: '168-0064' };
    const row = {
      id: 'jp-hot', country_code: 'JP', admin1: '東京都', admin1_code: '13', locality: '杉並区', postal_locality: '杉並区',
      district: '永福', postcode: '168-0064', street: '永福', house_number: '4-27-7', building_name: '', latitude: 35.676,
      longitude: 139.642, native_language: 'ja', property_type: 'residential', generation: 'test', quality_score: 0.95,
      first_seen_at: '2026-07-15T00:00:00Z', expires_at: '2027-07-15T00:00:00Z',
      component_variants_json: JSON.stringify({ native: components, en: { ...components, street: 'Eifuku', locality: 'Suginami' }, 'zh-CN': { ...components, locality: '杉并区' } }),
      address_variants_json: JSON.stringify({ native: '東京都杉並区永福4-27-7', en: '4-27-7 Eifuku, Suginami, Tokyo 168-0064', 'zh-CN': '东京都杉并区永福4-27-7' }),
      source_id: 'fixture', source_name: 'Fixture', source_url: 'https://example.test', source_record_id: 'jp-hot',
      observed_at: '2026-07-15T00:00:00Z', evidence_type: 'address_existence', dataset_id: 'fixture-v2', dataset_version: 'test',
      source_updated_at: '2026-07-15T00:00:00Z', imported_at: '2026-07-16T00:00:00Z', residential_evidence: 1
    };
    const addressDb = {
      prepare: (sql: string) => {
        const statement = {
          bind: () => statement,
          all: async () => ({ results: sql.startsWith('SELECT id FROM address_pool')
            ? sql.includes('random_key >=') ? [{ id: row.id }] : []
            : sql.includes('FROM address_pool_runtime') ? [row] : [] })
        };
        return statement;
      }
    };
    const response = await app.request('/api/v1/generate?country=JP&strategy=instant&seed=hot&requestId=hot', {}, {
      ...mockBindings, ADDRESS_DB: addressDb
    });
    const payload = await response.json() as { data: { sourcesTried: string[]; result: GeneratedBundle } };
    expect(payload.data.sourcesTried).toEqual(['address-pool-v2']);
    expect(payload.data.result.address.addressVariants.en).toContain('Eifuku');
    expect(response.headers.get('Server-Timing')).toMatch(/localize;dur=0\.0/);
  });

  it('returns a dedicated coverage error instead of a generic provider timeout', async () => {
    const response = await app.request('/api/v1/generate?country=US&city=Chicago', {}, {
      ...mockBindings, OVERPASS_MOCK: JSON.stringify({ elements: [] })
    });
    const payload = await response.json() as { error: { code: string } };
    expect(response.status).toBe(404);
    expect(payload.error.code).toBe('NO_POOL_COVERAGE');
  });
});
