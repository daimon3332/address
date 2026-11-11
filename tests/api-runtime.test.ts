import { afterEach, describe, expect, it, vi } from 'vitest';
import { countryByCode } from '../src/domain/countries';
import type { VerifiedAddress } from '../src/domain/types';
import {
  filterCandidates,
  orderedCandidate,
  resolveCatalogTarget,
  type CatalogTarget
} from '../server/api/repositories/address-repository';
import { fetchWithTimeout } from '../server/api/services/fetch-timeout';
import { fetchOverpassCandidates } from '../server/api/services/overpass-provider';
import { eligibleAddresses } from './fixtures/catalog';
import { openTestDatabase } from './helpers/postgres-test-database.mjs';

const current = new Date('2026-07-20T00:00:00Z');
type Database = Parameters<typeof resolveCatalogTarget>[0];

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

const randomTargetDb = (): Database => ({
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
} as unknown as Database);

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
  it('prefers one exact city name over a City of alias collision', async () => {
    const db = openTestDatabase(':memory:');
    try {
      await db.prepare(`INSERT INTO catalog_regions(id,country_code,code,name,native_name,zh_name,type,path)
        VALUES (1,'GB','LND','Greater London','Greater London','大伦敦','region','GB/LND')`).run();
      await db.prepare(`INSERT INTO catalog_cities(id,country_code,region_id,name,native_name,zh_name,type)
        VALUES (10,'GB',1,'London','London','伦敦','city'),
          (11,'GB',1,'City of London','City of London','伦敦金融城','city')`).run();

      await expect(resolveCatalogTarget(db, 'GB', { city: 'London' }, 'london-exact'))
        .resolves.toMatchObject({ cityId: 10, city: 'London' });
      await expect(resolveCatalogTarget(db, 'GB', { city: 'City of London' }, 'city-of-london-exact'))
        .resolves.toMatchObject({ cityId: 11, city: 'City of London' });
    } finally {
      await db.close();
    }
  });

  it('chooses the largest exact city when the same name exists in several regions', async () => {
    const db = openTestDatabase(':memory:');
    try {
      await db.prepare(`INSERT INTO catalog_regions(id,country_code,code,name,native_name,zh_name,type,path)
        VALUES (1,'US','TX','Texas','Texas','得克萨斯州','region','US/TX'),
          (2,'US','PA','Pennsylvania','Pennsylvania','宾夕法尼亚州','region','US/PA')`).run();
      await db.prepare(`INSERT INTO catalog_cities(id,country_code,region_id,name,native_name,zh_name,type,population)
        VALUES (10,'US',1,'Houston','Houston','休斯顿','city',2304580),
          (11,'US',2,'Houston','Houston','休斯顿','city',1000)`).run();

      await expect(resolveCatalogTarget(db, 'US', { city: 'Houston' }, 'houston-exact'))
        .resolves.toMatchObject({ cityId: 10, regionId: 1, city: 'Houston' });
    } finally {
      await db.close();
    }
  });

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
