import { afterEach, describe, expect, it, vi } from 'vitest';
import { countryByCode } from '../src/domain/countries';
import type { VerifiedAddress } from '../src/domain/types';
import {
  filterCandidates,
  orderedCandidate,
  resolveCatalogTarget,
  type CatalogTarget
} from '../server/api/repositories/address-repository';
import { pickAddressPoolAddress } from '../server/api/repositories/address-pool';
import { fetchWithTimeout } from '../server/api/services/fetch-timeout';
import { fetchOverpassCandidates } from '../server/api/services/overpass-provider';
import { eligibleAddresses } from './fixtures/catalog';

const current = new Date('2026-07-20T00:00:00Z');
type SqliteDatabase = Parameters<typeof resolveCatalogTarget>[0];

interface CityRow {
  id: number;
  city_id: number;
  postcode: null;
  city_name: string;
  city_native: string;
  city_zh: string;
  region_name: string;
  region_native: string;
  region_zh: string;
  region_code: string;
  latitude: number;
  longitude: number;
}

const cityRows: CityRow[] = [
  { id: 10, city_id: 10, postcode: null, city_name: 'Los Angeles', city_native: 'Los Angeles', city_zh: '洛杉矶', region_name: 'California', region_native: 'California', region_zh: '加利福尼亚州', region_code: 'CA', latitude: 34.0522, longitude: -118.2437 },
  { id: 20, city_id: 20, postcode: null, city_name: 'Chicago', city_native: 'Chicago', city_zh: '芝加哥', region_name: 'Illinois', region_native: 'Illinois', region_zh: '伊利诺伊州', region_code: 'IL', latitude: 41.8781, longitude: -87.6298 },
  { id: 30, city_id: 30, postcode: null, city_name: 'Seattle', city_native: 'Seattle', city_zh: '西雅图', region_name: 'Washington', region_native: 'Washington', region_zh: '华盛顿州', region_code: 'WA', latitude: 47.6062, longitude: -122.3321 }
];

const randomTargetDb = (): SqliteDatabase => ({
  prepare(sql: string) {
    let bindings: unknown[] = [];
    const statement = {
      bind(...values: unknown[]) { bindings = values; return statement; },
      async first<T>() {
        if (sql.includes('COUNT(*) AS total') && sql.includes('catalog_cities')) return { total: cityRows.length } as T;
        if (sql.includes('COUNT(*) AS total') && sql.includes('catalog_postcodes')) return { total: 0 } as T;
        if (sql.includes('FROM catalog_cities') && sql.includes('OFFSET ?')) {
          return cityRows[Number(bindings.at(-1))] as T;
        }
        return null;
      }
    };
    return statement;
  }
} as unknown as SqliteDatabase);

const withComponents = (
  source: VerifiedAddress,
  components: Partial<VerifiedAddress['components']>,
  id: string
): VerifiedAddress => {
  const merged = { ...source.components, ...components };
  return {
    ...source,
    id,
    components: merged,
    componentVariants: { native: merged, en: merged, 'zh-CN': merged }
  };
};

afterEach(() => vi.useRealTimers());

describe('seeded catalog targets and strict matching', () => {
  it('selects the same nationwide target and cache bucket for the same seed', async () => {
    const db = randomTargetDb();
    const first = await resolveCatalogTarget(db, 'US', {}, 'same-seed');
    const second = await resolveCatalogTarget(db, 'US', {}, 'same-seed');
    expect(second).toEqual(first);
    expect(first?.bucket).toMatch(/^city-\d+$/);
    expect(first?.coordinates).toEqual(expect.objectContaining({ latitude: expect.any(Number), longitude: expect.any(Number) }));
  });

  it('uses different seeds to cover multiple cities and regions instead of one fallback center', async () => {
    const db = randomTargetDb();
    const targets = await Promise.all(Array.from({ length: 24 }, (_, index) =>
      resolveCatalogTarget(db, 'US', {}, `nationwide-${index}`)
    ));
    expect(new Set(targets.map((target) => target?.city)).size).toBeGreaterThan(1);
    expect(new Set(targets.map((target) => target?.region)).size).toBeGreaterThan(1);
    expect(new Set(targets.map((target) => target?.bucket)).size).toBeGreaterThan(1);
  });

  it('strictly applies region, city and postcode aliases together', () => {
    const source = eligibleAddresses('US', false, current)[0];
    const matching = withComponents(source, { admin1: 'California', locality: 'Los Angeles', postcode: '90001' }, 'matching');
    const wrongRegion = withComponents(source, { admin1: 'Nevada', locality: 'Los Angeles', postcode: '90001' }, 'wrong-region');
    const wrongCity = withComponents(source, { admin1: 'California', locality: 'San Diego', postcode: '90001' }, 'wrong-city');
    const wrongPostcode = withComponents(source, { admin1: 'California', locality: 'Los Angeles', postcode: '90002' }, 'wrong-postcode');
    const target: CatalogTarget = {
      coordinates: { latitude: 34.0522, longitude: -118.2437 },
      region: 'California', regionAliases: ['California', 'CA', '加利福尼亚州'],
      city: 'Los Angeles', cityAliases: ['Los Angeles', '洛杉矶'],
      postcode: '90001', bucket: 'postcode-90001'
    };
    expect(filterCandidates(
      [matching, wrongRegion, wrongCity, wrongPostcode],
      { region: 'CA', city: '洛杉矶', postcode: '90001' },
      target
    ).map(({ id }) => id)).toEqual(['matching']);
  });

  it('orders candidates deterministically without collapsing all seeds to one record', () => {
    const candidates = eligibleAddresses('US', false, current);
    expect(orderedCandidate(candidates, 'stable', 0)).toEqual(orderedCandidate(candidates, 'stable', 0));
    expect(new Set(Array.from({ length: 20 }, (_, index) => orderedCandidate(candidates, `seed-${index}`, 0).id)).size).toBeGreaterThan(1);
  });
});

describe('provider integrity and timeout behavior', () => {
  it('preserves missing locality and admin fields instead of inserting a popular city or region', async () => {
    const country = countryByCode.get('MX')!;
    const mock = JSON.stringify({ elements: [{
      type: 'way', id: 77, center: { lat: 20.67, lon: -103.35 },
      tags: { 'addr:housenumber': '12', 'addr:street': 'Calle Fuente', building: 'house' }
    }] });
    const candidates = await fetchOverpassCandidates(country, false, {}, undefined, undefined, mock);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].components.locality).toBe('');
    expect(candidates[0].components.admin1).toBeUndefined();
    expect(candidates[0].components.locality).not.toBe(country.popularCities[0]?.value);
    expect(candidates[0].components.admin1).not.toBe(country.adminShortcuts[0]?.value);
  });

  it('aborts an upstream fetch when its deadline expires', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    const fetcher = fetchMock as unknown as typeof fetch;
    const pending = fetchWithTimeout(fetcher, 'https://provider.test/', {}, 25);
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
});

describe('local SQLite address pool', () => {
  it('selects a filtered residential record by random-key pivot and preserves provenance', async () => {
    const row = {
      id: 'fixture-address', country_code: 'US', admin1: 'California', admin1_code: 'CA',
      locality: 'Los Angeles', postal_locality: 'Los Angeles', district: 'Los Angeles County',
      postcode: '90001', street: 'Main Street', house_number: '12', building_name: '',
      latitude: 34.0522, longitude: -118.2437, property_type: 'residential',
      source_id: 'fixture', source_name: 'Fixture Source', source_url: 'https://example.test/source',
      source_record_id: 'record-1', source_updated_at: '2026-07-01', imported_at: '2026-07-15T00:00:00Z'
    };
    const statements: string[] = [];
    const bindingCounts: number[] = [];
    const db = {
      prepare(sql: string) {
        statements.push(sql);
        const statement = {
          bind(...values: unknown[]) { bindingCounts.push(values.length); return statement; },
          async all<T>() { return { results: sql.includes('random_key >=') ? [row as T] : [] }; }
        };
        return statement;
      }
    } as unknown as Parameters<typeof pickAddressPoolAddress>[0];
    const target: CatalogTarget = {
      coordinates: { latitude: row.latitude, longitude: row.longitude },
      region: row.admin1, regionAliases: [row.admin1, row.admin1_code],
      city: row.locality, cityAliases: [row.locality], postcode: row.postcode, bucket: 'postcode-90001'
    };

    const address = await pickAddressPoolAddress(
      db, 'US', true, { region: 'CA', city: 'Los Angeles', postcode: '90001' }, target, 'pool-seed', current
    );

    expect(address?.id).toBe('pool-fixture-address');
    expect(address?.components).toEqual(expect.objectContaining({ admin1Code: 'CA', postalLocality: 'Los Angeles' }));
    expect(address?.evidence.map(({ type }) => type)).toEqual(['address_existence', 'coordinate', 'residential_use']);
    expect(address?.coordinates).toEqual({ latitude: row.latitude, longitude: row.longitude });
    expect(statements[0]).toContain('random_key >= ?');
    expect(bindingCounts[0]).toBe((statements[0].match(/\?/g) || []).length);
  });

  it('falls through cleanly before the address-pool schema is initialized', async () => {
    const db = {
      prepare() { throw new Error('no such table: address_pool'); }
    } as unknown as Parameters<typeof pickAddressPoolAddress>[0];
    await expect(pickAddressPoolAddress(db, 'JP', false, {}, undefined, 'seed')).resolves.toBeUndefined();
  });

  it('rejects a non-residential record from the legacy address pool', async () => {
    const row = {
      id: 'legacy-police', country_code: 'CN', admin1: '河北省', admin1_code: '13',
      locality: '唐山市', postal_locality: '唐山市', district: '丰润区', postcode: '064000',
      street: '文化路', house_number: '10号', building_name: '丰润区公安局', latitude: 39.83,
      longitude: 118.16, property_type: 'unknown', source_id: 'legacy', source_name: 'Legacy',
      source_url: 'https://example.test/source', source_record_id: 'police', source_updated_at: '2026-07-01',
      imported_at: '2026-07-15T00:00:00Z'
    };
    const eligible = { ...row, id: 'legacy-home', building_name: '文化家园', house_number: '12号' };
    const db = {
      prepare() {
        const statement = { bind() { return statement; }, async all() { return { results: [row, eligible] }; } };
        return statement;
      }
    } as unknown as Parameters<typeof pickAddressPoolAddress>[0];

    await expect(pickAddressPoolAddress(db, 'CN', false, {}, undefined, 'seed')).resolves.toMatchObject({
      id: 'pool-legacy-home', components: { buildingName: '文化家园' }
    });
  });

  it('skips a legacy US row whose state field contains Philadelphia', async () => {
    const base = {
      country_code: 'US', locality: 'Philadelphia', postal_locality: 'Philadelphia', district: '',
      postcode: '19103', street: 'Market Street', house_number: '10', building_name: '',
      latitude: 39.95, longitude: -75.16, property_type: 'residential', source_id: 'legacy',
      source_name: 'Legacy', source_url: 'https://example.test/source', source_updated_at: '2026-07-01',
      imported_at: '2026-07-15T00:00:00Z'
    };
    const invalid = { ...base, id: 'bad-state', admin1: 'Philadelphia', admin1_code: '' };
    const valid = { ...base, id: 'valid-state', admin1: 'Pennsylvania', admin1_code: 'PA' };
    const db = {
      prepare() {
        const statement = { bind() { return statement; }, async all() { return { results: [invalid, valid] }; } };
        return statement;
      }
    } as unknown as Parameters<typeof pickAddressPoolAddress>[0];

    await expect(pickAddressPoolAddress(db, 'US', false, {}, undefined, 'seed')).resolves.toMatchObject({
      id: 'pool-valid-state', components: { locality: 'Philadelphia', admin1: 'Pennsylvania', admin1Code: 'PA' }
    });
  });
});
