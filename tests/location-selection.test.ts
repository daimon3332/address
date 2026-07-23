import { describe, expect, it } from 'vitest';
import { filterLocationOptions } from '../src/components/App';
import { resolveCatalogTarget } from '../server/api/repositories/address-repository';
import { queryLocationCatalog } from '../server/api/repositories/location-catalog';

type TargetDb = Parameters<typeof resolveCatalogTarget>[0];
type CatalogDb = Parameters<typeof queryLocationCatalog>[0];

const philadelphia = {
  id: 124126,
  region_id: 1422,
  city_id: 124126,
  postcode: null,
  city_name: 'Philadelphia',
  city_native: 'Philadelphia',
  city_zh: '费城',
  region_name: 'Pennsylvania',
  region_native: 'Pennsylvania',
  region_zh: '宾夕法尼亚州',
  region_code: 'PA',
  latitude: 39.95233,
  longitude: -75.16379
};

const pennsylvania = {
  id: 1422,
  region_id: 1422,
  city_id: null,
  postcode: null,
  city_name: null,
  city_native: null,
  city_zh: null,
  region_name: 'Pennsylvania',
  region_native: 'Pennsylvania',
  region_zh: '宾夕法尼亚州',
  region_code: 'PA',
  latitude: 40.96999,
  longitude: -77.72788
};

const targetDb = (): TargetDb => ({
  prepare(sql: string) {
    let bindings: unknown[] = [];
    const statement = {
      bind(...values: unknown[]) { bindings = values; return statement; },
      async first<T>() {
        if (sql.includes('SELECT r.id FROM catalog_regions') && sql.includes('r.id = ?')) {
          const id = Number(bindings[1]);
          return (id === 1422 || id === 1452 ? { id } : null) as T;
        }
        if (sql.includes('NULL AS city_id') && sql.includes('FROM catalog_regions r') && sql.includes('WHERE r.id = ?')) {
          return (Number(bindings[0]) === 1422 ? pennsylvania : null) as T;
        }
        if (sql.includes('SELECT c.id, c.region_id FROM catalog_cities') && sql.includes('c.id = ?')) {
          const cityId = Number(bindings[1]);
          const regionId = bindings.length > 2 ? Number(bindings[2]) : undefined;
          return (cityId === 124126 && (regionId === undefined || regionId === 1422)
            ? { id: 124126, region_id: 1422 }
            : null) as T;
        }
        if (sql.includes('WHERE c.id = ?')) return philadelphia as T;
        if (sql.includes('SELECT COUNT(*) AS total FROM catalog_cities')) return { total: 1 } as T;
        if (sql.includes('FROM catalog_cities c') && sql.includes('ORDER BY c.id')) return philadelphia as T;
        return null;
      }
    };
    return statement;
  }
} as unknown as TargetDb);

describe('stable location selection', () => {
  it('keeps parent metadata without adding the parent region to city labels', async () => {
    const rows = [
      {
        id: 124126, region_id: 1422, name: 'Philadelphia', native_name: 'Philadelphia', zh_name: '费城',
        region_name: 'Pennsylvania', region_native_name: 'Pennsylvania', region_zh_name: '宾夕法尼亚州', region_code: 'PA'
      },
      {
        id: 124127, region_id: 1452, name: 'Philadelphia', native_name: 'Philadelphia', zh_name: '费城',
        region_name: 'New York', region_native_name: 'New York', region_zh_name: '纽约州', region_code: 'NY'
      }
    ];
    const db = {
      prepare(sql: string) {
        const statement = {
          bind() { return statement; },
          async first<T>() { return { total: rows.length } as T; },
          async all<T>() { return { results: sql.includes('SELECT c.id') ? rows : [] } as T; }
        };
        return statement;
      }
    } as unknown as CatalogDb;

    const result = await queryLocationCatalog(db, { country: 'US', field: 'city', query: 'Philadelphia' });

    expect(result.options).toEqual([
      expect.objectContaining({
        id: '124126', value: 'Philadelphia', parentId: '1422', parentValue: 'Pennsylvania',
        regionId: '1422', regionValue: 'Pennsylvania', regionCode: 'PA'
      }),
      expect.objectContaining({
        id: '124127', value: 'Philadelphia', parentId: '1452', parentValue: 'New York',
        regionId: '1452', regionValue: 'New York', regionCode: 'NY'
      })
    ]);
    expect(result.options[0].label).toBe('Philadelphia · 费城');
    expect(result.options[1].label).toBe('Philadelphia · 费城');
    expect(result.options[0].label).not.toContain('Pennsylvania');
    expect(result.options[1].label).not.toContain('New York');
  });

  it('shows only the Chinese city name for China, including Xiamen', async () => {
    const rows = [{
      id: 201, region_id: 20, name: 'Xiamen', native_name: '厦门市', zh_name: '厦门市',
      region_name: 'Fujian', region_native_name: '福建省', region_zh_name: '福建省', region_code: 'FJ'
    }];
    const db = {
      prepare(sql: string) {
        const statement = {
          bind() { return statement; },
          async first<T>() { return { total: rows.length } as T; },
          async all<T>() { return { results: sql.includes('SELECT c.id') ? rows : [] } as T; }
        };
        return statement;
      }
    } as unknown as CatalogDb;

    const result = await queryLocationCatalog(db, { country: 'CN', field: 'city', regionId: '20', limit: 20_000 });

    expect(result.options[0]).toMatchObject({
      value: 'Xiamen', label: '厦门市', native: '厦门市', en: 'Xiamen', zhCN: '厦门市',
      regionId: '20', regionValue: 'Fujian'
    });
  });

  it.each([
    ['HK', '九龍', 'Kowloon', '九龙'],
    ['TW', '臺北市', 'Taipei', '台北市']
  ] as const)('shows only the native Chinese city name for %s', async (country, nativeName, englishName, chineseName) => {
    const rows = [{
      id: 201, region_id: 20, name: englishName, native_name: nativeName, zh_name: chineseName,
      region_name: 'Region', region_native_name: '地区', region_zh_name: '地区', region_code: 'R'
    }];
    const db = {
      prepare(sql: string) {
        const statement = {
          bind() { return statement; },
          async first<T>() { return { total: rows.length } as T; },
          async all<T>() { return { results: sql.includes('SELECT c.id') ? rows : [] } as T; }
        };
        return statement;
      }
    } as unknown as CatalogDb;

    const result = await queryLocationCatalog(db, { country, field: 'city', limit: 20_000 });

    expect(result.options[0].label).toBe(nativeName);
    expect(result.options[0].label).not.toContain('Region');
  });

  it('shows native, English and Chinese names without the parent region for non-Chinese cities', async () => {
    const rows = [{
      id: 201, region_id: 20, name: 'Mexico City', native_name: 'Ciudad de México', zh_name: '墨西哥城',
      region_name: 'Ciudad de México', region_native_name: 'Ciudad de México', region_zh_name: '墨西哥城', region_code: 'CMX'
    }];
    const db = {
      prepare(sql: string) {
        const statement = {
          bind() { return statement; },
          async first<T>() { return { total: rows.length } as T; },
          async all<T>() { return { results: sql.includes('SELECT c.id') ? rows : [] } as T; }
        };
        return statement;
      }
    } as unknown as CatalogDb;

    const result = await queryLocationCatalog(db, { country: 'MX', field: 'city', limit: 20_000 });

    expect(result.options[0].label).toBe('Ciudad de México · Mexico City · 墨西哥城');
    expect(result.options[0].label).not.toContain('CMX');
  });

  it('allows city parents to be loaded in one request up to 20,000 rows', async () => {
    let selectBindings: unknown[] = [];
    const db = {
      prepare(sql: string) {
        const statement = {
          bind(...bindings: unknown[]) {
            if (sql.includes('SELECT c.id')) selectBindings = bindings;
            return statement;
          },
          async first<T>() { return { total: 0 } as T; },
          async all<T>() { return { results: [] } as T; }
        };
        return statement;
      }
    } as unknown as CatalogDb;

    await queryLocationCatalog(db, { country: 'CN', field: 'city', regionId: '20', limit: 50_000 });

    expect(selectBindings[selectBindings.length - 2]).toBe(20_000);
    expect(selectBindings[selectBindings.length - 1]).toBe(0);
  });

  it('uses the default page size when a limit is not finite', async () => {
    let selectBindings: unknown[] = [];
    const db = {
      prepare(sql: string) {
        const statement = {
          bind(...bindings: unknown[]) {
            if (sql.includes('SELECT c.id')) selectBindings = bindings;
            return statement;
          },
          async first<T>() { return { total: 0 } as T; },
          async all<T>() { return { results: [] } as T; }
        };
        return statement;
      }
    } as unknown as CatalogDb;

    await queryLocationCatalog(db, { country: 'US', field: 'city', limit: Number.NaN });

    expect(selectBindings[selectBindings.length - 2]).toBe(100);
  });

  it('resolves Philadelphia by stable IDs to Pennsylvania and PA', async () => {
    const target = await resolveCatalogTarget(targetDb(), 'US', {
      region: 'Pennsylvania', regionId: '1422', city: 'Philadelphia', cityId: '124126'
    }, 'philadelphia');

    expect(target).toMatchObject({
      regionId: 1422,
      region: 'Pennsylvania',
      regionCode: 'PA',
      cityId: 124126,
      city: 'Philadelphia',
      bucket: 'city-124126'
    });
  });

  it('resolves a region-only filter to the region instead of a random city', async () => {
    const target = await resolveCatalogTarget(targetDb(), 'US', {
      region: 'Pennsylvania', regionId: '1422'
    }, 'pennsylvania');

    expect(target).toMatchObject({
      regionId: 1422,
      region: 'Pennsylvania',
      regionCode: 'PA',
      bucket: 'region-1422'
    });
    expect(target?.cityId).toBeUndefined();
    expect(target?.city).toBeUndefined();
  });

  it('rejects a city ID outside the selected region hierarchy', async () => {
    await expect(resolveCatalogTarget(targetDb(), 'US', {
      regionId: '1452', cityId: '124126'
    }, 'cross-region')).resolves.toBeUndefined();
  });
});

describe('client-side city filtering', () => {
  const options = [
    { value: 'Xiamen', label: '厦门市', native: '厦门市', en: 'Xiamen', zhCN: '厦门市' },
    { value: 'Sao Paulo', label: 'São Paulo · 圣保罗', native: 'São Paulo', en: 'Sao Paulo', zhCN: '圣保罗' },
    { value: 'Munich', label: 'München', native: 'München', en: 'Munich', zhCN: '慕尼黑' }
  ];

  it.each([
    ['XIA', 'Xiamen'],
    ['厦门', 'Xiamen'],
    ['厦门市', 'Xiamen'],
    ['sao', 'Sao Paulo'],
    ['SAOPAULO', 'Sao Paulo'],
    ['MUNICH', 'Munich'],
    ['mun-ich', 'Munich'],
    ['慕尼', 'Munich']
  ])('matches %s against the loaded label/native/en/zhCN values', (query, expected) => {
    expect(filterLocationOptions(options, query).map(({ value }) => value)).toContain(expected);
  });
});
