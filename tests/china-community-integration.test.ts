import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { ChinaDataService } from '../server/china/service';
import { ControlStore } from '../server/control/store';
import { initializeTestDatabase, openTestDatabase, type PostgresDatabase } from './helpers/postgres-test-database.mjs';
import { chinaCommunityPublicationClause, countChinaCommunities, pickChinaCommunityAddress } from '../server/api/repositories/china-community';
import { updateCountryPolicy, upsertNodeTarget } from '../server/sync/address-policy.mjs';
import type { CommunityCandidate } from '../server/china/providers';
import { formatChinaPinyinPresentation } from '../src/domain/address-format';
import { validateAddressQuality } from '../src/domain/address-quality.mjs';
import app from '../server/api/index';
import { queryLocationCatalog } from '../server/api/repositories/location-catalog';

const candidate = (provider: CommunityCandidate['provider'], providerPoiId: string, address: string): CommunityCandidate => ({
  provider,
  providerPoiId,
  name: '光明小区',
  address,
  province: '河北省',
  city: '唐山市',
  district: '丰润区',
  township: '丰润镇',
  latitude: 39.832,
  longitude: 118.162,
  rawLatitude: 39.838,
  rawLongitude: 118.168,
  rawCrs: provider === 'baidu' ? 'BD-09' : 'GCJ-02',
  responseHash: `${provider}-${providerPoiId}`,
  typecode: provider === 'amap' ? '120302' : '住宅小区',
  adcode: '110105'
});

const upsertCandidate = (service: ChinaDataService, value: CommunityCandidate): Promise<number> =>
  (service as unknown as { upsertCandidate(candidate: CommunityCandidate): Promise<number> }).upsertCandidate(value);
const processCandidate = (service: ChinaDataService, value: CommunityCandidate): Promise<number> =>
  (service as unknown as { processCandidate(candidate: CommunityCandidate): Promise<number> }).processCandidate(value);
const targetCount = (service: ChinaDataService): Promise<number> =>
  (service as unknown as { targetCount(target: Record<string, unknown>): Promise<number> }).targetCount({
    id: '130208', province: '河北省', city: '唐山市', district: '丰润区', query: '唐山市丰润区', targetCount: 10
  });

const daysAgo = (days: number): string => new Date(Date.now() - days * 86400000).toISOString();

describe('China community storage integration', () => {
  let addressDb: PostgresDatabase;
  let controlDb: PostgresDatabase;
  let control: ControlStore;

  beforeEach(async () => {
    addressDb = openTestDatabase(':memory:');
    controlDb = openTestDatabase(':memory:', { migrate: false });
    await initializeTestDatabase(controlDb, new URL('../server/control/schema.sql', import.meta.url));
    control = new ControlStore(controlDb, Buffer.alloc(32, 9));
    await control.initialize('correct horse battery staple');
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      if (new URL(String(input)).pathname === '/v3/config/district') return Response.json({ status: '1', districts: [] });
      throw new Error('unexpected network request in test');
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    addressDb.close();
    controlDb.close();
  });

  const seedStaleCoverage = async (service: ChinaDataService): Promise<void> => {
    await processCandidate(service, { ...candidate('amap', 'coverage-fixture', '文化路18号'), postcode: '064000' });
    const now = new Date().toISOString();
    await addressDb.batch([
      addressDb.prepare(`INSERT INTO sync_country_state(country_code,status,address_count,residential_count,updated_at)
        VALUES ('CN','ready',9,9,?) ON CONFLICT(country_code) DO UPDATE SET address_count=9,residential_count=9`).bind(now),
      addressDb.prepare(`INSERT INTO admin_coverage_stats(node_key,parent_key,country_code,level,region_name,
        residential_count,total_count,updated_at) VALUES ('CN','','CN',0,'中国',9,9,?)`).bind(now)
    ]);
  };

  const expectChinaCoverage = async (count: number): Promise<void> => {
    expect(await addressDb.prepare("SELECT address_count,residential_count FROM sync_country_state WHERE country_code='CN'").first())
      .toEqual({ address_count: count, residential_count: count });
    expect(await addressDb.prepare("SELECT total_count,residential_count FROM admin_coverage_stats WHERE node_key='CN'").first())
      .toEqual({ total_count: count, residential_count: count });
  };

  it('generates from the synthetic city ID emitted for a published city missing from the catalog', async () => {
    const service = new ChinaDataService(addressDb, control);
    await processCandidate(service, { ...candidate('amap', 'synthetic-city', '文化路18号'), postcode: '064000' });
    await addressDb.exec(`INSERT INTO catalog_regions(id,country_code,code,name,native_name,zh_name,path) VALUES
      (1000,'CN','HE','Hebei','河北省','河北省','CN/HE'),
      (1001,'CN','SC','Sichuan','四川省','四川省','CN/SC');`);
    const options = await queryLocationCatalog(addressDb, { country: 'CN', field: 'city', regionId: '1000' });
    expect(options.options).toHaveLength(1);
    const cityId = options.options[0].id!;
    expect(cityId).toMatch(/^cn-city-/u);
    const env = { ADDRESS_DB: addressDb, LOCATION_DB: addressDb };
    const response = await app.request(`/api/v1/generate?country=CN&regionId=1000&cityId=${cityId}`, {}, env);
    expect(response.status).toBe(200);
    expect((await response.json()).data.result.address.components).toMatchObject({ admin1: '河北省', locality: '唐山市' });
    for (const query of [`country=CN&regionId=1001&cityId=${cityId}`, `country=US&cityId=${cityId}`,
      `country=CN&cityId=${cityId}&city=${encodeURIComponent('其他市')}`, 'country=CN&cityId=cn-city-ff']) {
      expect((await app.request(`/api/v1/generate?${query}`, {}, env)).status).not.toBe(200);
    }
  });

  it('honors numeric China city IDs even when no city name is supplied', async () => {
    const service = new ChinaDataService(addressDb, control);
    await processCandidate(service, { ...candidate('amap', 'numeric-city', '文化路18号'), postcode: '064000' });
    await addressDb.exec(`INSERT INTO catalog_regions(id,country_code,code,name,native_name,zh_name,path)
      VALUES (1000,'CN','HE','Hebei','河北省','河北省','CN/HE');
      INSERT INTO catalog_cities(id,country_code,region_id,name,native_name,zh_name) VALUES
      (1000,'CN',1000,'Tangshan','唐山市','唐山市'),(1001,'CN',1000,'Other City','其他市','其他市');`);
    const env = { ADDRESS_DB: addressDb, LOCATION_DB: addressDb };
    const covered = await app.request('/api/v1/generate?country=CN&cityId=1000', {}, env);
    expect(covered.status).toBe(200);
    expect((await covered.json()).data.result.address.components.locality).toBe('唐山市');
    const empty = await app.request('/api/v1/generate?country=CN&cityId=1001', {}, env);
    expect(empty.status).toBe(404);
  });

  it('generates near a Chinese IP whose location is named in English', async () => {
    const service = new ChinaDataService(addressDb, control);
    await processCandidate(service, { ...candidate('amap', 'ip-nearby', '文化路18号'), postcode: '064000' });
    vi.stubGlobal('fetch', async () => Response.json({
      country_code: 'CN', region: 'Hebei Sheng', region_code: 'HE', city: 'Tangshan', postal: '063000', latitude: 39.84, longitude: 118.17
    }));
    const env = { ADDRESS_DB: addressDb, LOCATION_DB: addressDb, IP_GEOLOCATION_API_URL: 'https://ip.test/{ip}', IP_GEOLOCATION_FALLBACK_API_URL: '' };
    const response = await app.request('/api/v1/generate?mode=ip-region&ip=1.24.0.1&strategy=instant', {}, env);
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.data).toMatchObject({ country: 'CN', ipMatchLevel: 'coordinate' });
    expect(payload.data.result.address.components).toMatchObject({ admin1: '河北省', locality: '唐山市', district: '丰润区' });
  });

  it('generates from a district alone instead of resolving an unrelated catalog city', async () => {
    const service = new ChinaDataService(addressDb, control);
    await processCandidate(service, { ...candidate('amap', 'district-only', '文化路18号'), postcode: '064000' });
    await addressDb.exec(`INSERT INTO catalog_regions(id,country_code,code,name,native_name,zh_name,path) VALUES
      (1000,'CN','HE','Hebei','河北省','河北省','CN/HE'),(1001,'CN','SC','Sichuan','四川省','四川省','CN/SC');
      INSERT INTO catalog_cities(id,country_code,region_id,name,native_name,zh_name,population,latitude,longitude)
      VALUES (1000,'CN',1001,'Chengdu','成都市','成都市',9000000,30.6,104.1);`);
    const env = { ADDRESS_DB: addressDb, LOCATION_DB: addressDb };
    const byName = await app.request(`/api/v1/generate?country=CN&district=${encodeURIComponent('丰润区')}`, {}, env);
    expect(byName.status).toBe(200);
    expect((await byName.json()).data.result.address.components).toMatchObject({ admin1: '河北省', locality: '唐山市', district: '丰润区' });
    const [option] = (await queryLocationCatalog(addressDb, { country: 'CN', field: 'district', query: '丰润' })).options;
    expect(option).toMatchObject({ value: '丰润区', parentValue: '唐山市', regionValue: '河北省', availableCount: 1 });
    const byId = await app.request(`/api/v1/generate?country=CN&districtId=${option.id}`, {}, env);
    expect(byId.status).toBe(200);
    expect((await byId.json()).data.result.address.components.district).toBe('丰润区');
  });

  it.each(['succeeded', 'paused_quota', 'failed'])('refreshes China coverage after a %s exit without a global pool scan', async (status) => {
    const service = new ChinaDataService(addressDb, control);
    await seedStaleCoverage(service);
    const batch = addressDb.batch.bind(addressDb);
    vi.spyOn(addressDb, 'batch').mockImplementation((statements) => {
      if (statements.some((statement) => String((statement as unknown as { query: string }).query).startsWith('INSERT INTO strict_pool_rows'))) {
        return Promise.reject(Object.assign(new Error('Global scan timeout'), { code: '57014' }));
      }
      return batch(statements);
    });
    await addressDb.prepare(`INSERT INTO cn_sync_checkpoints(provider,city,page,status,updated_at)
      VALUES ('amap','130208',1,'paused',?)`).bind(new Date().toISOString()).run();
    vi.spyOn(service as unknown as { fetchPage(): Promise<unknown> }, 'fetchPage').mockImplementation(async () => {
      await addressDb.prepare('UPDATE cn_communities_v2 SET active=0').run();
      if (status === 'failed') throw Object.assign(new Error('Fixture source failure'), { code: 'FIXTURE' });
      return status === 'paused_quota' ? null : { rawCount: 0, candidates: [], pageSignature: 'coverage-end' };
    });
    const runId = await control.createRun('china-communities', { providers: ['amap'] });
    await service.runSync(runId, [{ id: '130208', province: '河北省', city: '唐山市', district: '丰润区',
      query: '唐山市丰润区', targetCount: 5 }], ['amap']);
    expect((await control.runs(1))[0].status).toBe(status);
    expect(await countChinaCommunities(addressDb)).toBe(0);
    await expectChinaCoverage(0);
  });

  it.each(['wake', 'initializeTargets'])('repairs China coverage on %s without reopening source checkpoints', async (entry) => {
    const service = new ChinaDataService(addressDb, control);
    await seedStaleCoverage(service);
    await addressDb.prepare(`INSERT INTO cn_sync_checkpoints(provider,city,page,status,strategy_version,updated_at)
      VALUES ('amap','130208',8,'exhausted','fixture','2026-01-01T00:00:00.000Z')`).run();
    const checkpoints = (await addressDb.prepare('SELECT * FROM cn_sync_checkpoints').all()).results;
    const communities = (await addressDb.prepare('SELECT * FROM cn_communities_v2').all()).results;
    const credentials = await control.listCredentials();
    const fetch = vi.fn(() => { throw new Error('Unexpected upstream request'); });
    vi.stubGlobal('fetch', fetch);
    try {
      if (entry === 'wake') await service.wake(60_000);
      else await service.initializeTargets({ scheduleContinuation: false });
      await expectChinaCoverage(1);
      expect((await addressDb.prepare('SELECT * FROM cn_sync_checkpoints').all()).results).toEqual(checkpoints);
      expect((await addressDb.prepare('SELECT * FROM cn_communities_v2').all()).results).toEqual(communities);
      expect(await control.listCredentials()).toEqual(credentials);
      expect(await control.runs(1)).toEqual([]);
      expect(fetch).not.toHaveBeenCalled();
    } finally { await service.close(); }
  });

  it.each([['57014', 3], ['55P03', 3], ['FIXTURE', 1]] as const)('bounds and records coverage failure %s without retrying a source', async (code, attempts) => {
    const service = new ChinaDataService(addressDb, control);
    const batch = addressDb.batch.bind(addressDb);
    let refreshAttempts = 0;
    vi.spyOn(addressDb, 'batch').mockImplementation((statements) => {
      if (statements.some((statement) => String((statement as unknown as { query: string }).query).startsWith('DELETE FROM admin_coverage_stats'))) {
        refreshAttempts += 1;
        return Promise.reject(Object.assign(new Error('Fixture refresh failure'), { code }));
      }
      return batch(statements);
    });
    const audit = vi.spyOn(control, 'audit');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await service.wake(60_000);
      expect(refreshAttempts).toBe(attempts);
      expect(audit).toHaveBeenCalledWith('system', 'china.coverage.refresh_failed', 'CN', { code, attempts });
      expect(log).toHaveBeenCalledWith('[china-sync] coverage refresh failed', code);
      expect(await control.runs(1)).toEqual([]);
    } finally { log.mockRestore(); await service.close(); }
  });

  it('recovers a transient coverage failure before automatic scheduling without source requests', async () => {
    const service = new ChinaDataService(addressDb, control);
    await seedStaleCoverage(service);
    const batch = addressDb.batch.bind(addressDb);
    let refreshAttempts = 0;
    vi.spyOn(addressDb, 'batch').mockImplementation((statements) => {
      if (statements.some((statement) => String((statement as unknown as { query: string }).query).startsWith('DELETE FROM admin_coverage_stats'))
        && refreshAttempts++ === 0) return Promise.reject(Object.assign(new Error('Fixture lock wait'), { code: '55P03' }));
      return batch(statements);
    });
    try {
      await service.wake(60_000);
      await expectChinaCoverage(1);
      expect(refreshAttempts).toBe(2);
      expect(await control.runs(1)).toEqual([]);
    } finally { await service.close(); }
  });

  it('retains official same-name direct administration but renders each place once', async () => {
    const now = new Date().toISOString();
    await addressDb.batch([
      ['44', null, 'province', '广东省'], ['4419', '44', 'city', '东莞市'], ['441900', '4419', 'district', '东莞市']
    ].map(([code, parent, level, name]) => addressDb.prepare(`INSERT INTO cn_admin_areas(
      adcode,parent_adcode,level,name,full_path,source_version,updated_at) VALUES (?,?,?,?,?,'fixture',?)`)
      .bind(code, parent, level, name, String(name), now)));
    const service = new ChinaDataService(addressDb, control);
    await processCandidate(service, { ...candidate('amap', 'direct-admin-fixture', '文化路18号'),
      province: '广东省', city: '东莞市', district: '东莞市', township: '', adcode: '441900',
      latitude: 23.02, longitude: 113.75, postcode: '523000' });
    const address = await pickChinaCommunityAddress(addressDb, { city: '东莞市' }, 'direct-admin');
    expect(address).toBeDefined();
    expect(address!.components).toMatchObject({ locality: '东莞市', district: '东莞市' });
    expect(validateAddressQuality({ countryCode: 'CN', components: address!.components }).valid).toBe(true);
    expect(address!.nativeAddress.match(/东莞市/gu)).toHaveLength(1);
    expect(address!.addressVariants.en.match(/Dongguan City/gu)).toHaveLength(1);
    expect(formatChinaPinyinPresentation(address!.components, '').singleLine.match(/Dongguan Shi/gu)).toHaveLength(1);
    await addressDb.prepare("UPDATE cn_admin_areas SET name='Invalid District' WHERE adcode='441900'").run();
    expect(await countChinaCommunities(addressDb)).toBe(0);
  });

  it.each([
    ['文化路18号', 'Wenhua Road', '18'],
    ['雁栖镇十八路30号', 'Shiba Road, Yanqi Town', '30'],
    ['乐安街道金融大街55号', "Jinrong Street, Le'an Subdistrict", '55'],
    ['中山路18弄6号', 'Zhongshan Road', '6, Lane 18']
  ])('renders semantic English independently of Pinyin for %s', async (delivery, street, houseNumber) => {
    const service = new ChinaDataService(addressDb, control);
    await processCandidate(service, { ...candidate('amap', 'english-source', delivery), postcode: '064000' });
    const address = await pickChinaCommunityAddress(addressDb, { city: '唐山市' }, 'english-contract');
    expect(address).toBeDefined();
    expect(address!.componentVariants.en).toMatchObject({
      houseNumber, street, buildingName: 'Guangming Residential Community',
      admin1: 'Hebei Province', locality: 'Tangshan City', district: 'Fengrun District'
    });
    const transliteration = formatChinaPinyinPresentation(address!.components, '').singleLine;
    expect(transliteration).toContain('Guangming Xiaoqu');
    expect(transliteration).toContain('Hebei Sheng');
    expect(transliteration).not.toMatch(/Road|Street|Province|Residential Community|Lane/u);
    expect(transliteration).not.toMatch(/\p{Script=Han}/u);
  });

  it.each([
    [{ city: '厦门' }, 2, ['厦门', '厦门市']],
    [{ region: '福建' }, 2, ['福建', '福建省']],
    [{ district: '湖里' }, 2, ['湖里', '湖里区']],
    [{ region: '福建', city: '厦门', district: '湖里' }, 8, ['福建', '福建省', '厦门', '厦门市', '湖里', '湖里区']]
  ] as const)('bounds every administrative alias window before merging %j', async (filters, branches, aliases) => {
    // Every spelling is in use, so every alias combination gets its own window.
    const columns = { region: 'province', city: 'city', district: 'district' } as const;
    const used = Object.entries(filters).reduce<Array<Record<string, string>>>((rows, [filter, value]) => rows.flatMap((row) =>
      [value, `${value}${{ region: '省', city: '市', district: '区' }[filter as keyof typeof columns]}`]
        .map((alias) => ({ ...row, [columns[filter as keyof typeof columns]]: alias }))), [{}]);
    const bind = vi.fn((..._values: unknown[]) => ({ all: async () => ({ results: bind.mock.calls.length === 1 ? used : [] }) }));
    const prepare = vi.fn((_sql: string) => ({ bind }));
    await pickChinaCommunityAddress({ prepare } as never, filters, 'alias-index');
    expect(prepare.mock.calls[0][0]).toContain('SELECT DISTINCT');
    expect(bind.mock.calls[0]).toEqual(expect.arrayContaining([...aliases]));
    const sql = prepare.mock.calls[1][0];
    expect(sql.match(/UNION ALL/gu)).toHaveLength(branches - 1);
    expect(sql.match(/LIMIT 16/gu)).toHaveLength(branches + 1);
    expect(sql).not.toMatch(/community\.(province|city|district) IN \(\?/u);
    expect(sql).not.toContain('REPLACE(community.');
    expect(bind.mock.calls[1]).toEqual(expect.arrayContaining([...aliases]));
  });

  it('skips alias windows no community uses', async () => {
    const bind = vi.fn((..._values: unknown[]) => ({
      all: async () => ({ results: bind.mock.calls.length === 1 ? [{ province: '福建省', city: '厦门市' }] : [] })
    }));
    const prepare = vi.fn((_sql: string) => ({ bind }));
    await pickChinaCommunityAddress({ prepare } as never, { region: '福建', city: '厦门' }, 'alias-pruned');
    expect(prepare.mock.calls[1][0]).not.toContain('UNION ALL');
    expect(bind.mock.calls[1]).toEqual(expect.arrayContaining(['福建省', '厦门市']));
    expect(bind.mock.calls[1]).not.toContain('福建');
  });

  it('varies repeated IP picks among the nearby communities', async () => {
    const communities = Array.from({ length: 20 }, (_, index) => ({
      id: `near-${index}`, canonical_name: `小区${index}`, provider_address: `文化路${index}号`, province: '江苏省', city: '南京市',
      district: '玄武区', township: '', postcode: '210000', latitude: 32.06 + index / 100000, longitude: 118.79,
      source_count: 1, verification_level: 'single-source', last_seen_at: '2026-10-01T00:00:00Z'
    }));
    const prepare = vi.fn((sql: string) => ({
      bind: () => ({ all: async () => ({ results: sql.includes('SELECT DISTINCT provider') ? [{ provider: 'amap' }] : communities }) })
    }));
    const picks = new Set<string | undefined>();
    for (let index = 0; index < 20; index += 1) {
      picks.add((await pickChinaCommunityAddress({ prepare } as never, {}, `seed-${index}`, { latitude: 32.06, longitude: 118.79 }))?.id);
    }
    expect(picks.size).toBeGreaterThan(8);
    expect([...picks].every((id) => id?.startsWith('cn-community-near-'))).toBe(true);
  });

  it('passes over a community whose name the pinyin dictionary cannot romanize', async () => {
    const community = (id: string, name: string) => ({
      id, canonical_name: name, provider_address: '文化路1号', province: '江苏省', city: '南京市',
      district: '玄武区', township: '', postcode: '210000', latitude: 32.06, longitude: 118.79,
      source_count: 1, verification_level: 'single-source', last_seen_at: '2026-10-01T00:00:00Z'
    });
    const prepare = vi.fn((sql: string) => ({
      bind: () => ({ all: async () => ({ results: sql.includes('SELECT DISTINCT provider') ? [{ provider: 'amap' }]
        : [community('rare', '㙟头小区'), community('plain', '阳光花园')] }) })
    }));
    for (let index = 0; index < 8; index += 1) {
      const address = await pickChinaCommunityAddress({ prepare } as never, {}, `rare-${index}`, { latitude: 32.06, longitude: 118.79 });
      expect(address?.id).toBe('cn-community-plain');
      expect(address?.componentVariants.en.buildingName).toBe('Yangguang Garden');
    }
  });

  it('keeps coordinate matching separate from alias random windows', async () => {
    const bind = vi.fn((..._values: unknown[]) => ({ all: async () => ({ results: [] }) }));
    const prepare = vi.fn((_sql: string) => ({ bind }));
    await pickChinaCommunityAddress({ prepare } as never, { city: '厦门' }, 'nearby', { latitude: 24.48, longitude: 118.09 });
    expect(prepare.mock.calls[0][0]).toContain('community.city IN (');
    expect(prepare.mock.calls[0][0]).toContain('community.latitude BETWEEN ? AND ?');
    expect(prepare.mock.calls[0][0]).toContain('community.id LIMIT 50');
    // An empty area widens through every radius up to the 25 km limit.
    expect(prepare).toHaveBeenCalledTimes(4);
    expect(bind.mock.calls.map((values) => Math.round((Number(values.at(-9)) - Number(values.at(-10))) * 111.32 * 5) / 10))
      .toEqual([0.5, 2, 8, 25]);
    expect(prepare.mock.calls[0][0]).not.toContain('UNION ALL');
  });

  it('preserves ordered full-pool selection and wraparound across alias combinations', async () => {
    const now = new Date().toISOString();
    await addressDb.batch(Array.from({ length: 52 }, (_, index) => {
      const id = `alias-fixture-${index}`;
      return [
        addressDb.prepare(`INSERT INTO cn_communities_v2(id,canonical_name,normalized_name,province,city,district,
          postcode,provider_address,longitude,latitude,first_seen_at,last_seen_at,updated_at)
          VALUES (?,'测试小区',?,'河北省',?,?,'064000',?,118.16,39.83,?,?,?)`)
          .bind(id, id, index >= 48 ? '秦皇岛市' : index % 2 ? '唐山市' : '唐山',
            index % 4 < 2 ? '丰润区' : '丰润', `测试路${index + 1}号`, now, now, now),
        addressDb.prepare(`INSERT INTO cn_community_sources(provider,provider_poi_id,community_id,raw_name,
          raw_longitude,raw_latitude,raw_crs,response_hash,first_seen_at,last_seen_at)
          VALUES ('amap',?,?,'测试小区',118.16,39.83,'GCJ-02',?,?,?)`).bind(id, id, id, now, now)
      ];
    }).flat());
    const rows = (await addressDb.prepare(`SELECT community.id,community.city,
      (hashtextextended(community.id,0) & 2147483647) AS random_key FROM cn_communities_v2 community
      WHERE ${chinaCommunityPublicationClause('community')} AND community.city IN ('唐山','唐山市')
      ORDER BY random_key,community.id`).all<{ id: string; city: string; random_key: number }>()).results;
    expect(rows).toHaveLength(48);
    const hash = (value: string) => createHash('sha256').update(value).digest().readUInt32BE(0);
    const pivot = (seed: string) => hash(`${seed}:china-community`) & 0x7fffffff;
    const seeds = Array.from({ length: 12 }, (_, index) => `alias-${index}`);
    const wrapSeed = Array.from({ length: 1000 }, (_, index) => `wrap-${index}`)
      .find((seed) => pivot(seed) > Number(rows.at(-1)!.random_key));
    expect(wrapSeed).toBeDefined();
    seeds.push(wrapSeed!);
    const selectedCities = new Set<string>();
    for (const seed of seeds) {
      const key = pivot(seed);
      const window = [...rows.filter((row) => Number(row.random_key) >= key),
        ...rows.filter((row) => Number(row.random_key) < key)].slice(0, 16);
      const expected = window[hash(`${seed}:candidate`) % window.length];
      for (const filters of [{ city: '唐山' },
        { region: '河北省', city: '唐山市', district: '丰润', postcode: '064000', q: '测试路' }]) {
        const address = await pickChinaCommunityAddress(addressDb, filters, seed);
        expect(address?.id).toBe(`cn-community-${expected.id}`);
        expect(address?.components.postcode).toBe('064000');
        selectedCities.add(address!.components.locality);
      }
    }
    expect(selectedCities).toEqual(new Set(['唐山', '唐山市']));
  }, 60_000);

  it('labels the earliest provider recovery as cooldown instead of a later quota reset', async () => {
    const nextAvailableAt = new Date(Date.now() + 60_000).toISOString();
    vi.stubGlobal('fetch', async () => Response.json({ providers: {
      amap: { known: true, available: false, nextResetAt: nextAvailableAt, waitState: 'cooldown_wait' },
      baidu: { known: true, available: false, nextResetAt: new Date(Date.now() + 3_600_000).toISOString(), waitState: 'quota_wait' },
      tencent: { known: false, available: false, nextResetAt: null, waitState: 'blocked' }
    } }));
    const service = new ChinaDataService(addressDb, control, undefined, {
      postgresUrl: 'postgresql://fixture', masterKey: Buffer.alloc(32, 7),
      credentialBroker: { url: 'https://broker.example.test', token: 'fixture-broker-token-for-tests' }
    });
    const state = await (service as unknown as { credentialState(): Promise<unknown> }).credentialState();
    expect(state).toMatchObject({ eligible: false, reason: 'cooldown', nextAvailableAt });
  });

  it('rejects ambiguous China postcode candidates in both indexed and direct lookup', () => {
    const service = new ChinaDataService(addressDb, control);
    const rows = ['064000', '064001'].map((code) => ({
      code, locality_name: '丰润区', region_name: 'Hebei', region_native_name: '河北省',
      region_zh_name: '河北省', latitude: null, longitude: null
    }));
    const resolver = (service as unknown as {
      resolveChinaPostcode(value: CommunityCandidate, catalog: typeof rows, index?: Map<string, typeof rows>): string;
    }).resolveChinaPostcode.bind(service);
    const value = candidate('amap', 'postcode-ambiguity', '文化路18号');
    expect(resolver(value, rows)).toBe('064000');
    Object.assign(service, { districtPostcode: () => '' });
    expect(resolver(value, rows)).toBe('');
    expect(resolver(value, rows, new Map([['河北\u0000丰润', rows]]))).toBe('');
    expect(resolver(value, [rows[0]])).toBe('064000');
    expect(resolver(value, [rows[0], { ...rows[0] }])).toBe('064000');
  });

  it.each([10, -10])('continues the same China page after a short broker pacing wait (%i ms)', async (waitMs) => {
    let calls = 0;
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      if (!String(input).includes('/v1/requests')) return Response.json({ providers: {} });
      calls += 1;
      return calls === 1 ? Response.json({ code: 'SOURCE_RATE_LIMITED',
        nextAvailableAt: new Date(Date.now() + waitMs).toISOString() }, { status: 429 })
        : Response.json({ data: { status: '1', pois: [] } });
    });
    const service = new ChinaDataService(addressDb, control, undefined, {
      postgresUrl: 'postgresql://fixture', masterKey: Buffer.alloc(32, 7),
      credentialBroker: { url: 'https://broker.example.test', token: 'fixture-broker-token-for-tests' }
    });
    const runId = await control.createRun('china-communities', { providers: ['amap'] });
    await service.runSync(runId, [{ id: '130208', province: '河北省', city: '唐山市', district: '丰润区',
      query: '唐山市丰润区', targetCount: 5 }], ['amap']);
    expect(calls).toBe(2);
    expect((await control.runs(1))[0].status).toBe('succeeded');
  });

  it('bounds repeated broker pacing waits instead of spinning on the same page', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls += 1;
      return Response.json({ code: 'SOURCE_RATE_LIMITED',
        nextAvailableAt: new Date(Date.now() + 10).toISOString() }, { status: 429 });
    });
    const service = new ChinaDataService(addressDb, control, undefined, {
      postgresUrl: 'postgresql://fixture', masterKey: Buffer.alloc(32, 7),
      credentialBroker: { url: 'https://broker.example.test', token: 'fixture-broker-token-for-tests' }
    });
    const runId = await control.createRun('china-communities', { providers: ['amap'] });
    await service.runSync(runId, [{ id: '130208', province: '河北省', city: '唐山市', district: '丰润区',
      query: '唐山市丰润区', targetCount: 5 }], ['amap']);
    expect(calls).toBe(3);
    expect((await control.runs(1))[0].status).toBe('paused_quota');
    const history = await control.syncHistory(1, 'CN') as { items: Array<Record<string, unknown>> };
    expect(history.items[0]).toMatchObject({ completedAt: expect.any(String), candidateCount: 0,
      acceptedCount: 0, rejectedCount: 0, beforeCount: 0, afterCount: 0, netGrowth: 0 });
  });

  it('records China raw candidates, valid duplicates and rejection reasons independently of net growth', async () => {
    const service = new ChinaDataService(addressDb, control);
    const duplicate = candidate('amap', 'existing-community', '文化路18号');
    await processCandidate(service, duplicate);
    const value = candidate('amap', 'new-community', '建设路20号');
    const roadOnly = candidate('amap', 'missing-number', '文化路');
    const page = vi.spyOn(service as unknown as { fetchPage(): Promise<unknown> }, 'fetchPage');
    page.mockResolvedValueOnce({ rawCount: 4, candidates: [duplicate, value, roadOnly], pageSignature: 'history-page' })
      .mockResolvedValue({ rawCount: 0, candidates: [], pageSignature: 'history-end' });
    const runId = await control.createRun('china-communities', { providers: ['amap'] });
    await service.runSync(runId, [{ id: '130208', province: '河北省', city: '唐山市', district: '丰润区',
      query: '唐山市丰润区', targetCount: 10 }], ['amap']);
    const history = await control.syncHistory(1, 'CN') as { items: Array<Record<string, unknown>> };
    expect(history.items[0]).toMatchObject({ candidateCount: 4, acceptedCount: 3, rejectedCount: 1,
      beforeCount: 1, afterCount: 2, netGrowth: 1, completedAt: expect.any(String),
      rejectionReasons: { adapter_rejected: 1 },
      metrics: { rawCount: 4, duplicateCount: 2, insertedCount: 1 } });
  });

  it('does not invent growth or candidate statistics from incomplete legacy progress', async () => {
    const runId = await control.createRun('china-communities', { providers: ['amap'] });
    await control.updateRun(runId, 'paused_quota', { accepted: 7 });
    const history = await control.syncHistory(1, 'CN') as { items: Array<Record<string, unknown>> };
    expect(history.items[0]).toMatchObject({ completedAt: expect.any(String), candidateCount: null,
      acceptedCount: null, rejectedCount: null, beforeCount: null, afterCount: null, netGrowth: null });
  });

  it('exposes missing postcode rejection in China history without publishing the candidate', async () => {
    const service = new ChinaDataService(addressDb, control);
    Object.assign(service, { districtPostcode: () => '' });
    vi.spyOn(service as unknown as { chinaPostcodeCatalog(): Promise<unknown[]> }, 'chinaPostcodeCatalog')
      .mockResolvedValue([{ code: '100000', locality_name: '海淀区', region_name: 'Beijing',
        region_native_name: '北京市', region_zh_name: '北京市', latitude: null, longitude: null }]);
    vi.spyOn(service as unknown as { fetchPage(): Promise<unknown> }, 'fetchPage')
      .mockResolvedValueOnce({ rawCount: 1, candidates: [candidate('amap', 'missing-postcode', '文化路18号')], pageSignature: 'postcode-page' })
      .mockResolvedValue({ rawCount: 0, candidates: [], pageSignature: 'postcode-end' });
    const runId = await control.createRun('china-communities', { providers: ['amap'] });
    await service.runSync(runId, [{ id: '130208', province: '河北省', city: '唐山市', district: '丰润区',
      query: '唐山市丰润区', targetCount: 10 }], ['amap']);
    const history = await control.syncHistory(1, 'CN') as { items: Array<Record<string, unknown>> };
    expect(history.items[0]).toMatchObject({ candidateCount: 1, acceptedCount: 0, rejectedCount: 1,
      beforeCount: 0, afterCount: 0, netGrowth: 0, rejectionReasons: { missing_postcode: 1 } });
    expect(await countChinaCommunities(addressDb)).toBe(0);
  });

  it.each(['baidu', 'tencent'] as const)('stops %s at a repeated tail page and persists the completed window', async (provider) => {
    await control.addCredential({ provider, label: 'tail-test', secret: 'tail-fixture', qpsLimit: 100 });
    const calls: number[] = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      const url = new URL(String(input));
      calls.push(Number(url.searchParams.get(provider === 'baidu' ? 'page_num' : 'page_index')));
      return Response.json(provider === 'baidu'
        ? { status: 0, results: [{ uid: 'repeated-rejected-result' }] }
        : { status: 0, data: [{ id: 'repeated-rejected-result' }] });
    });
    const service = new ChinaDataService(addressDb, control);
    const runId = await control.createRun('china-communities', { providers: [provider] });
    await service.runSync(runId, [{ id: '130208', province: '河北省', city: '唐山市', district: '丰润区',
      query: '唐山市丰润区', targetCount: 5 }], [provider]);
    expect(calls).toEqual(provider === 'baidu' ? [0, 1] : [1, 2]);
    expect(await addressDb.prepare('SELECT status,page,last_error,page_signature FROM cn_sync_checkpoints WHERE provider=?')
      .bind(provider).first()).toMatchObject({ status: 'exhausted', page: 2,
        last_error: 'repeated_page_signature', page_signature: expect.any(String) });
  });

  it('selects unfiltered communities through the full-pool hash index', async () => {
    const statements: string[] = [];
    const community = {
      id: 'community-1', canonical_name: '测试小区', province: '北京市', city: '北京市',
      district: '朝阳区', township: '', provider_address: '测试路1号', latitude: 39.9,
      longitude: 116.4, verification_level: 'L1', source_count: 1,
      last_seen_at: '2026-08-24T00:00:00Z'
    };
    const database = {
      prepare(sql: string) {
        statements.push(sql);
        const statement = {
          bind() { return statement; },
          async all() {
            return { results: sql.includes('SELECT DISTINCT provider FROM cn_community_sources')
              ? [{ provider: 'amap' }]
              : [community] };
          }
        };
        return statement;
      }
    };

    await expect(pickChinaCommunityAddress(database as never, {}, 'full-pool'))
      .resolves.toMatchObject({ id: 'cn-community-community-1' });
    expect(statements[0]).toContain('hashtextextended');
    expect(statements[0]).not.toContain('source_count DESC');
    expect(statements[0]).not.toContain('LIMIT 500');
  });

  it('imports AreaCity hierarchy and builds automatic district targets', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify([{
      code: '110000', name: '北京市', level: 'province', children: [{
        code: '110100', name: '北京市', level: 'city', children: [{ code: '110105', name: '朝阳区', level: 'district' }]
      }]
    }]), { status: 200, headers: { 'content-type': 'application/json' } }));
    const service = new ChinaDataService(addressDb, control);
    expect(await service.importAreaCity('https://example.test/areas.json', 'test-1')).toBe(3);
    expect(await addressDb.prepare('SELECT full_path FROM cn_admin_areas WHERE adcode=?').bind('110105').first('full_path'))
      .toBe('北京市/北京市/朝阳区');
    vi.stubGlobal('fetch', async () => new Response('\uFEFFid,pid,deep,name,ext_name\n11,0,0,北京,北京市\n1101,11,1,北京,北京市\n110105,1101,2,朝阳,朝阳区\n', { status: 200 }));
    expect(await service.importAreaCity('https://example.test/areas.csv', 'test-2')).toBe(3);
    expect(await addressDb.prepare('SELECT full_path FROM cn_admin_areas WHERE adcode=?').bind('110105').first('full_path'))
      .toBe('北京市/北京市/朝阳区');
    expect(await addressDb.prepare('SELECT query FROM cn_sync_area_targets WHERE adcode=?').bind('110105').first('query'))
      .toBe('北京市朝阳区');
    await expect(service.start()).rejects.toThrow('NO_AVAILABLE_KEY');
  });

  it('reports fallback city coverage before AreaCity data is imported', async () => {
    const service = new ChinaDataService(addressDb, control);
    await service.initializeTargets();
    const status = await service.status() as {
      usingFallback: boolean;
      coverage: { districts_total: number; districts_covered: number; communities_needed: number };
    };
    expect(status.usingFallback).toBe(true);
    expect(status.coverage.districts_total).toBeGreaterThan(0);
    expect(status.coverage.districts_covered).toBe(0);
    expect(status.coverage.communities_needed).toBe(status.coverage.districts_total * 5);
  });

  it('automatically resumes when the earliest credential cooldown expires', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(new Date('2026-08-01T00:00:00.000Z'));
    try {
      const id = await control.addCredential({ provider: 'amap', label: 'resume-key', secret: 'resume-key-secret' });
      await control.reportCredential(id, 'qps', { retryAt: '2026-08-01T00:00:02.000Z' });
      const service = new ChinaDataService(addressDb, control);
      const start = vi.fn(async () => 'run-after-cooldown');
      (service as unknown as { start: typeof start }).start = start;
      await service.wake(0);
      expect(await service.status()).toMatchObject({
        syncState: 'cooldown_wait', nextAttemptAt: '2026-08-01T00:00:02.000Z'
      });
      await vi.advanceTimersByTimeAsync(2_100);
      expect(start).toHaveBeenCalledOnce();
      await service.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('tries every available key until a later key succeeds', async () => {
    const keys = ['key-1', 'key-2', 'key-3', 'key-4'];
    for (const key of keys) await control.addCredential({ provider: 'amap', label: key, secret: key, qpsLimit: 100 });
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      const key = new URL(String(input)).searchParams.get('key') || '';
      calls.push(key);
      return Response.json(key === 'key-4'
        ? { status: '1', pois: [] }
        : { status: '0', infocode: '10020', info: 'QPS_LIMIT' });
    });
    const service = new ChinaDataService(addressDb, control);
    const fetchPage = (service as unknown as {
      fetchPage(provider: 'amap', target: Record<string, unknown>, page: number, accepted: number, requested: () => Promise<void>): Promise<unknown>;
    }).fetchPage.bind(service);
    let requests = 0;
    expect(await fetchPage('amap', {
      id: '110105', province: '北京市', city: '北京市', district: '朝阳区', query: '北京市朝阳区', targetCount: 5
    }, 1, 0, async () => { requests += 1; })).toMatchObject({ rawCount: 0 });
    expect(calls).toEqual(keys);
    expect(requests).toBe(4);
    expect(await control.listCredentials()).toEqual([
      expect.objectContaining({ label: 'key-1', status: 'cooldown' }),
      expect.objectContaining({ label: 'key-2', status: 'cooldown' }),
      expect.objectContaining({ label: 'key-3', status: 'cooldown' }),
      expect.objectContaining({ label: 'key-4', status: 'healthy' })
    ]);
  });

  it('keeps an all-network provider failure retryable instead of pausing it as quota', async () => {
    await control.addCredential({ provider: 'amap', label: 'network-only', secret: 'network-only-key', qpsLimit: 100 });
    vi.stubGlobal('fetch', async () => { throw Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' }); });
    const service = new ChinaDataService(addressDb, control);
    const fetchPage = (service as unknown as {
      fetchPage(provider: 'amap', target: Record<string, unknown>, page: number, accepted: number, requested: () => Promise<void>): Promise<unknown>;
    }).fetchPage.bind(service);
    await expect(fetchPage('amap', {
      id: '110105', province: '北京市', city: '北京市', district: '朝阳区', query: '北京市朝阳区', targetCount: 5
    }, 1, 0, async () => undefined)).resolves.toBeNull();
    expect(await addressDb.prepare('SELECT status,last_error FROM cn_sync_checkpoints WHERE provider=? AND city=?')
      .bind('amap', '110105').first()).toMatchObject({ status: 'failed' });
  });

  it('routes worker page requests through the credential broker without a local provider key', async () => {
    const token = 'china-broker-client-token-fixture-0001';
    const calls: Array<{ url: string; authorization: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      calls.push({
        url: request.url,
        authorization: request.headers.get('authorization') || '',
        body: await request.json() as Record<string, unknown>
      });
      return Response.json({ data: { status: '1', pois: [] } });
    });
    const service = new ChinaDataService(addressDb, control, undefined, {
      postgresUrl: 'postgresql://fixture', masterKey: Buffer.alloc(32, 8),
      credentialBroker: { url: 'http://credential-broker.internal', token }
    });
    const fetchPage = (service as unknown as {
      fetchPage(provider: 'amap', target: Record<string, unknown>, page: number, accepted: number, requested: () => Promise<void>): Promise<unknown>;
    }).fetchPage.bind(service);
    let requests = 0;
    expect(await fetchPage('amap', {
      id: '110105', province: '北京市', city: '北京市', district: '朝阳区', query: '北京市朝阳区', targetCount: 5
    }, 1, 0, async () => { requests += 1; })).toMatchObject({ rawCount: 0 });
    expect(requests).toBe(1);
    expect(calls).toEqual([expect.objectContaining({
      url: 'http://credential-broker.internal/v1/requests',
      authorization: `Bearer ${token}`,
      body: expect.objectContaining({
        operation: 'amap.place-search', parameters: { region: '110105', page: 1, subdivision: '' }
      })
    })]);
    expect(await control.listCredentials()).toEqual([]);
    await service.close();
  });

  it('accounts for exactly one HTTP request per direct Amap credential use', async () => {
    const id = await control.addCredential({ provider: 'amap', label: 'fallback', secret: 'fallback-key', qpsLimit: 100 });
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      const url = new URL(String(input));
      urls.push(url.pathname);
      return url.pathname.startsWith('/v5/')
        ? new Response('<html>blocked</html>', { status: 200 })
        : Response.json({ status: '1', pois: [] });
    });
    const service = new ChinaDataService(addressDb, control);
    const fetchPage = (service as unknown as {
      fetchPage(provider: 'amap', target: Record<string, unknown>, page: number, accepted: number, requested: () => Promise<void>): Promise<unknown>;
    }).fetchPage.bind(service);
    let requests = 0;
    expect(await fetchPage('amap', {
      id: '110105', province: '北京市', city: '北京市', district: '朝阳区', query: '北京市朝阳区', targetCount: 5
    }, 1, 0, async () => { requests += 1; })).toMatchObject({ rawCount: 0 });
    expect(urls).toEqual(['/v3/place/text']);
    expect(requests).toBe(urls.length);
    expect(await control.listCredentials()).toEqual([
      expect.objectContaining({ id, status: 'healthy', failureCount: 0, quotaUsed: urls.length })
    ]);
  });

  it('filters and paginates strict district coverage by administrative adcode', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify([{
      code: '110000', name: '北京市', level: 'province', children: [{
        code: '110100', name: '北京市', level: 'city', children: [
          { code: '110105', name: '朝阳区', level: 'district' },
          { code: '110106', name: '丰台区', level: 'district' }
        ]
      }]
    }]), { status: 200, headers: { 'content-type': 'application/json' } }));
    const service = new ChinaDataService(addressDb, control);
    expect(await service.importAreaCity('https://example.test/areas.json', 'test-list')).toBe(4);
    const first = await service.listAreas({ provinceAdcode: '110000', cityAdcode: '110100', page: 1, pageSize: 1 });
    expect(first).toMatchObject({ total: 2, page: 1, pageSize: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.items[0]).toMatchObject({ province_adcode: '110000', city_adcode: '110100', current_count: 0 });
    expect(first.options.provinces).toContainEqual({ adcode: '110000', name: '北京市' });
    expect(first.options.cities).toContainEqual({ adcode: '110100', name: '北京市' });
    expect((await service.listAreas({ districtAdcode: '110106', page: 1, pageSize: 25 })).items)
      .toEqual([expect.objectContaining({ district_adcode: '110106', district: '丰台区' })]);
  });

  it('reads generated China addresses only from the map POI community tables', async () => {
    const now = new Date().toISOString();
    await addressDb.prepare(`INSERT INTO cn_communities_v2(id,canonical_name,normalized_name,province,city,district,township,
      provider_address,longitude,latitude,verification_level,source_count,first_seen_at,last_seen_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      'community-1', '望京花园', '望京', '北京市', '北京市', '朝阳区', '望京街道',
      '阜通东大街6号', 116.463, 39.989, 'L2', 2, now, now, now
    ).run();
    await addressDb.prepare(`INSERT INTO cn_community_sources(provider,provider_poi_id,community_id,raw_name,raw_address,
      raw_longitude,raw_latitude,raw_crs,response_hash,first_seen_at,last_seen_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(
      'amap', 'poi-1', 'community-1', '望京花园', '阜通东大街6号', 116.47, 39.995, 'GCJ-02', 'hash', now, now
    ).run();
    await addressDb.prepare(`INSERT INTO cn_community_sources(provider,provider_poi_id,community_id,raw_name,raw_address,
      raw_longitude,raw_latitude,raw_crs,response_hash,first_seen_at,last_seen_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(
      'tencent', 'poi-2', 'community-1', '望京花园', '阜通东大街6号', 116.47, 39.995, 'GCJ-02', 'hash-2', now, now
    ).run();
    const address = await pickChinaCommunityAddress(addressDb, { region: '北京市', city: '北京市' }, 'seed');
    expect(address).toMatchObject({
      countryCode: 'CN', propertyType: 'apartment', coordinates: { latitude: 39.989, longitude: 116.463 },
      components: { houseNumber: '6号', street: '阜通东大街', buildingName: '望京花园', district: '朝阳区' },
      componentVariants: {
        native: { houseNumber: '6号', street: '阜通东大街' },
        en: { houseNumber: '6', street: 'Futongdong Street' },
        'zh-CN': { houseNumber: '6号', street: '阜通东大街' }
      }
    });
    expect(address?.nativeAddress).toContain('阜通东大街6号');
    expect(address?.verificationLevel).toBe('L2');
    expect(new Set(address?.evidence.map((item) => item.sourceId))).toEqual(new Set(['amap', 'tencent']));
    expect(await pickChinaCommunityAddress(addressDb, { region: '北京市', city: '北京市', district: '朝阳区' }, 'seed'))
      .toMatchObject({ components: { district: '朝阳区' } });
    expect(await pickChinaCommunityAddress(addressDb, { district: '朝阳' }, 'seed'))
      .toMatchObject({ components: { district: '朝阳区' } });
    expect(await pickChinaCommunityAddress(addressDb, { region: '北京市', city: '北京市', district: '海淀区' }, 'seed'))
      .toBeUndefined();
  }, 15_000);

  it('publishes a provider address that repeats the community name without duplicating it', async () => {
    const now = new Date().toISOString();
    await addressDb.prepare(`INSERT INTO cn_communities_v2(id,canonical_name,normalized_name,province,city,district,township,
      provider_address,longitude,latitude,verification_level,source_count,first_seen_at,last_seen_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      'community-ambiguous-delivery', '光明小区', '光明', '河北省', '唐山市', '丰润区', '丰润镇',
      '文化路18号光明小区', 118.162, 39.832, 'L1', 1, now, now, now
    ).run();
    await addressDb.prepare(`INSERT INTO cn_community_sources(provider,provider_poi_id,community_id,raw_name,raw_address,
      raw_longitude,raw_latitude,raw_crs,response_hash,first_seen_at,last_seen_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(
      'amap', 'ambiguous-delivery', 'community-ambiguous-delivery', '光明小区', '文化路18号光明小区',
      118.168, 39.838, 'GCJ-02', 'ambiguous-hash', now, now
    ).run();

    expect(await countChinaCommunities(addressDb)).toBe(1);
    expect(await pickChinaCommunityAddress(addressDb, { city: '唐山市' }, 'ambiguous-delivery')).toMatchObject({
      nativeAddress: '河北省唐山市丰润区丰润镇文化路18号光明小区', components: { street: '文化路', houseNumber: '18号' }
    });
  });

  it('does not publish Taiwan communities through the mainland China pool', async () => {
    const now = new Date().toISOString();
    await addressDb.prepare(`INSERT INTO cn_communities_v2(id,canonical_name,normalized_name,province,city,district,township,
      provider_address,longitude,latitude,verification_level,source_count,first_seen_at,last_seen_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      'community-taiwan', '明驼新城', '明驼新城', '台湾省', '台中市', '潭子区', '',
      '台中市潭子区明驼新城1号', 120.7, 24.2, 'L1', 1, now, now, now
    ).run();
    await addressDb.prepare(`INSERT INTO cn_community_sources(provider,provider_poi_id,community_id,raw_name,raw_address,
      raw_longitude,raw_latitude,raw_crs,response_hash,first_seen_at,last_seen_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(
      'amap', 'poi-community-taiwan', 'community-taiwan', '明驼新城', '台中市潭子区明驼新城1号',
      120.7, 24.2, 'GCJ-02', 'hash-community-taiwan', now, now
    ).run();

    expect(await countChinaCommunities(addressDb)).toBe(0);
    expect(await pickChinaCommunityAddress(addressDb, {}, 'strict-mainland')).toBeUndefined();
  });

  it('publishes China block identifiers but rejects mixed-language names and streets', async () => {
    const now = new Date().toISOString();
    const rows = [
      ['mixed-name', 'OASIS绿洲', '文昌街8号'],
      ['mixed-street', '长林花园', '六O南大道109号'],
      ['block-label', '学府悦园F组团', '崇贤路1号']
    ];
    for (const [id, name, providerAddress] of rows) {
      await addressDb.prepare(`INSERT INTO cn_communities_v2(id,canonical_name,normalized_name,province,city,district,township,
        provider_address,longitude,latitude,verification_level,source_count,first_seen_at,last_seen_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
        id, name, name, '重庆市', '重庆市', '沙坪坝区', '', providerAddress,
        106.45, 29.55, 'L1', 1, now, now, now
      ).run();
      await addressDb.prepare(`INSERT INTO cn_community_sources(provider,provider_poi_id,community_id,raw_name,raw_address,
        raw_longitude,raw_latitude,raw_crs,response_hash,first_seen_at,last_seen_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(
        'amap', `poi-${id}`, id, name, providerAddress, 106.45, 29.55, 'GCJ-02', `hash-${id}`, now, now
      ).run();
    }

    expect(await countChinaCommunities(addressDb)).toBe(1);
    expect(await pickChinaCommunityAddress(addressDb, {}, 'strict-native-language'))
      .toMatchObject({ components: { buildingName: '学府悦园F组团', street: '崇贤路' } });
  });

  it('publishes one strict Amap record without treating duplicate POIs as cross-provider evidence', async () => {
    const now = new Date().toISOString();
    await addressDb.prepare(`INSERT INTO cn_communities_v2(id,canonical_name,normalized_name,province,city,district,township,
      provider_address,longitude,latitude,verification_level,source_count,first_seen_at,last_seen_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      'community-single-provider', '望京花园', '望京', '北京市', '北京市', '朝阳区', '望京街道',
      '阜通东大街6号', 116.463, 39.989, 'L1', 1, now, now, now
    ).run();
    for (const id of ['poi-1', 'poi-2']) {
      await addressDb.prepare(`INSERT INTO cn_community_sources(provider,provider_poi_id,community_id,raw_name,raw_address,
        raw_longitude,raw_latitude,raw_crs,response_hash,first_seen_at,last_seen_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(
        'amap', id, 'community-single-provider', '望京花园', '阜通东大街6号', 116.47, 39.995,
        'GCJ-02', `hash-${id}`, now, now
      ).run();
    }
    const address = await pickChinaCommunityAddress(addressDb, { city: '北京市' }, 'seed');
    expect(address).toMatchObject({ verificationLevel: 'L1', components: { buildingName: '望京花园' } });
    expect(new Set(address?.evidence.map((item) => item.sourceId))).toEqual(new Set(['amap']));
  });

  it('keeps accepted and rejected provider candidates with their decisions', async () => {
    const service = new ChinaDataService(addressDb, control);
    expect(await processCandidate(service, candidate('amap', 'accepted-poi', '文化路18号'))).toBe(1);
    expect(await processCandidate(service, { ...candidate('amap', 'rejected-poi', '文化路'), typecode: '060100' })).toBe(0);

    const rows = (await addressDb.prepare(`SELECT provider_poi_id,decision,rejection_reason,strategy_version
      FROM cn_ingest_candidates ORDER BY provider_poi_id`).all<Record<string, unknown>>()).results;
    expect(rows).toEqual([
      expect.objectContaining({ provider_poi_id: 'accepted-poi', decision: 'accepted', rejection_reason: '', strategy_version: 'community-poi-v11-amap-community' }),
      expect.objectContaining({ provider_poi_id: 'rejected-poi', decision: 'rejected', rejection_reason: 'non_residential_provider_type', strategy_version: 'community-poi-v11-amap-community' })
    ]);
  });

  it('publishes a current strict Baidu or Tencent residential candidate without requiring Amap', async () => {
    const service = new ChinaDataService(addressDb, control);
    expect(await processCandidate(service, candidate('baidu', 'baidu-only', '文化路18号'))).toBe(1);
    expect(await countChinaCommunities(addressDb)).toBe(1);
    expect(await pickChinaCommunityAddress(addressDb, { city: '唐山市' }, 'baidu-only')).toMatchObject({
      verificationLevel: 'L1', components: { buildingName: '光明小区' }
    });
  });

  it('keeps accepted source evidence when a refresh is missing a required postcode', async () => {
    const service = new ChinaDataService(addressDb, control);
    const value = { ...candidate('baidu', 'incomplete-refresh', '文化路18号'), postcode: '064000' };
    expect(await processCandidate(service, value)).toBe(1);
    expect(await countChinaCommunities(addressDb)).toBe(1);
    Object.assign(service, { districtPostcode: () => '', postcodeCatalogPromise: Promise.resolve([{ code: '100000', locality_name: 'Other district',
      region_name: 'Other province', region_native_name: '', region_zh_name: '', latitude: null, longitude: null }]) });
    expect(await processCandidate(service, { ...value, postcode: '' })).toBe(0);
    expect(await addressDb.prepare("SELECT decision FROM cn_ingest_candidates WHERE provider_poi_id='incomplete-refresh'").first('decision')).toBe('rejected');
    expect(await countChinaCommunities(addressDb)).toBe(1);
  });

  it('does not publish a non-residential provider category even when other fields look valid', async () => {
    const service = new ChinaDataService(addressDb, control);
    const invalid = { ...candidate('tencent', 'shopping-poi', '文化路18号'), typecode: '购物;商场' };
    expect(await processCandidate(service, invalid)).toBe(0);
    expect(await countChinaCommunities(addressDb)).toBe(0);
    expect(await addressDb.prepare('SELECT rejection_reason FROM cn_ingest_candidates WHERE provider_poi_id=?')
      .bind('shopping-poi').first('rejection_reason')).toBe('non_residential_provider_type');
  });

  it('rebuilds the publication layer from permanent accepted candidates', async () => {
    const service = new ChinaDataService(addressDb, control);
    await processCandidate(service, candidate('amap', 'replay-poi', '文化路18号'));
    await addressDb.prepare('DELETE FROM cn_communities_v2').run();

    expect(await addressDb.prepare('SELECT COUNT(*) AS total FROM cn_ingest_candidates').first('total')).toBe(1);
    expect(await addressDb.prepare('SELECT COUNT(*) AS total FROM cn_community_sources').first('total')).toBe(0);
    await service.initializeTargets();
    expect(await addressDb.prepare('SELECT COUNT(*) AS total FROM cn_communities_v2').first('total')).toBe(1);
    expect(await addressDb.prepare('SELECT COUNT(*) AS total FROM cn_community_sources').first('total')).toBe(1);
    expect(await countChinaCommunities(addressDb)).toBe(1);
  });

  it.each([
    ['a conflicting house number', '文化路18号', '文化路88号', 1, 2],
    ['a conflicting lane premise', '虹桥路18弄1号', '虹桥路88弄1号', 1, 2]
  ])('does not merge or cross-verify %s', async (_label, firstAddress, secondAddress, secondAccepted, rowCount) => {
    const service = new ChinaDataService(addressDb, control);
    expect(await upsertCandidate(service, candidate('amap', 'amap-18', firstAddress))).toBe(1);
    expect(await upsertCandidate(service, candidate('baidu', 'baidu-other', secondAddress))).toBe(secondAccepted);

    const rows = (await addressDb.prepare(`SELECT provider_address,verification_level,source_count
      FROM cn_communities_v2 ORDER BY provider_address`).all<Record<string, unknown>>()).results;
    expect(rows).toHaveLength(rowCount);
    expect(rows.every((row) => row.verification_level === 'L1' && row.source_count === 1)).toBe(true);
    expect(await countChinaCommunities(addressDb)).toBe(1);
    const expected = firstAddress.match(/^(.+?)([0-9]+(?:(?:弄|巷)[0-9]+)?(?:[-之][0-9]+)?号)$/u);
    expect(await pickChinaCommunityAddress(addressDb, { city: '唐山市' }, 'conflict')).toMatchObject({
      verificationLevel: 'L1', components: { street: expected?.[1], houseNumber: expected?.[2] }
    });
  });

  it.each([['a road without a number', '文化路'], ['no provider address', '']])(
    'merges a same-named nearby community with %s and keeps the numbered address', async (_label, address) => {
      const service = new ChinaDataService(addressDb, control);
      expect(await upsertCandidate(service, candidate('amap', 'amap-18', '文化路18号'))).toBe(1);
      expect(await upsertCandidate(service, candidate('baidu', 'baidu-plain', address))).toBe(0);
      expect((await addressDb.prepare('SELECT provider_address,verification_level,source_count FROM cn_communities_v2')
        .all<Record<string, unknown>>()).results).toEqual([{ provider_address: '文化路18号', verification_level: 'L2', source_count: 2 }]);
    });

  it('publishes a community identified only by its name and district', async () => {
    const service = new ChinaDataService(addressDb, control);
    expect(await processCandidate(service, candidate('amap', 'name-only', '阜通东大街与望京街交叉口东40米'))).toBe(1);
    expect(await countChinaCommunities(addressDb)).toBe(1);
    const address = await pickChinaCommunityAddress(addressDb, { city: '唐山市' }, 'name-only');
    expect(address).toMatchObject({ matchLevel: 'premise', components: { street: '', houseNumber: '', buildingName: '光明小区', district: '丰润区' } });
    expect(address?.nativeAddress).toBe('河北省唐山市丰润区丰润镇光明小区 064000');
  });

  it('merges independent providers only when the road and house number agree', async () => {
    const service = new ChinaDataService(addressDb, control);
    await upsertCandidate(service, candidate('amap', 'amap-18', '丰润区文化路18号'));
    expect(await upsertCandidate(service, candidate('baidu', 'baidu-18', '文化路18号院'))).toBe(0);

    expect(await addressDb.prepare('SELECT COUNT(*) AS total FROM cn_communities_v2').first('total')).toBe(1);
    expect(await addressDb.prepare('SELECT verification_level FROM cn_communities_v2').first('verification_level')).toBe('L2');
    expect(await countChinaCommunities(addressDb)).toBe(1);
    expect(await pickChinaCommunityAddress(addressDb, { city: '唐山市' }, 'matching')).toMatchObject({
      components: { street: '丰润区文化路', houseNumber: '18号', buildingName: '光明小区' }, verificationLevel: 'L2'
    });
  });

  it('moves a changed provider POI away from its former conflicting premise', async () => {
    const service = new ChinaDataService(addressDb, control);
    await upsertCandidate(service, candidate('amap', 'amap-18', '文化路18号'));
    await upsertCandidate(service, candidate('baidu', 'baidu-moving', '文化路18号'));
    expect(await countChinaCommunities(addressDb)).toBe(1);

    await upsertCandidate(service, candidate('baidu', 'baidu-moving', '文化路88号'));
    const rows = (await addressDb.prepare(`SELECT provider_address,verification_level,source_count
      FROM cn_communities_v2 ORDER BY provider_address`).all<Record<string, unknown>>()).results;
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.verification_level === 'L1' && row.source_count === 1)).toBe(true);
    expect(await countChinaCommunities(addressDb)).toBe(1);
  });

  it.each([
    ['an expired community', daysAgo(181), daysAgo(1), daysAgo(1), 'L2', 1],
    ['an invalid community date', 'not-a-date', daysAgo(1), daysAgo(1), 'L2', 0],
    ['one expired secondary source', daysAgo(1), daysAgo(1), daysAgo(181), 'L2', 1],
    ['one invalid secondary source date', daysAgo(1), daysAgo(1), 'not-a-date', 'L1', 1]
  ])('applies source freshness correctly for %s', async (_label, communitySeen, firstSeen, secondSeen, expectedLevel, published) => {
    await addressDb.prepare(`INSERT INTO cn_communities_v2(id,canonical_name,normalized_name,province,city,district,township,
      provider_address,longitude,latitude,verification_level,source_count,first_seen_at,last_seen_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      'freshness-community', '光明小区', '光明', '河北省', '唐山市', '丰润区', '丰润镇',
      '文化路18号', 118.162, 39.832, 'L2', 2, daysAgo(300), communitySeen, daysAgo(1)
    ).run();
    for (const [provider, seen] of [['amap', firstSeen], ['baidu', secondSeen]] as const) {
      await addressDb.prepare(`INSERT INTO cn_community_sources(provider,provider_poi_id,community_id,raw_name,raw_address,
        raw_longitude,raw_latitude,raw_crs,response_hash,first_seen_at,last_seen_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(
        provider, `${provider}-freshness`, 'freshness-community', '光明小区', '文化路18号', 118.168, 39.838,
        provider === 'baidu' ? 'BD-09' : 'GCJ-02', `${provider}-hash`, daysAgo(300), seen
      ).run();
    }

    const service = new ChinaDataService(addressDb, control);
    await service.initializeTargets();
    expect(await addressDb.prepare('SELECT verification_level FROM cn_communities_v2 WHERE id=?')
      .bind('freshness-community').first('verification_level')).toBe(expectedLevel);
    expect(await countChinaCommunities(addressDb)).toBe(published);
    if (published) expect(await pickChinaCommunityAddress(addressDb, { city: '唐山市' }, 'stale')).toMatchObject({ verificationLevel: expectedLevel });
    else expect(await pickChinaCommunityAddress(addressDb, { city: '唐山市' }, 'stale')).toBeUndefined();
    expect(await targetCount(service)).toBe(published);
    expect(await service.status()).toMatchObject({
      total: published,
      cross_verified: published && expectedLevel === 'L2' ? 1 : 0,
      cities: published
    });
  });

  it('publishes and counts a community backed by two fresh independent providers', async () => {
    const service = new ChinaDataService(addressDb, control);
    await upsertCandidate(service, candidate('amap', 'amap-fresh', '文化路18号'));
    await upsertCandidate(service, candidate('tencent', 'tencent-fresh', '文化路18号'));
    await service.initializeTargets();

    expect(await countChinaCommunities(addressDb)).toBe(1);
    expect(await pickChinaCommunityAddress(addressDb, { city: '唐山市' }, 'fresh')).toMatchObject({ verificationLevel: 'L2' });
    expect(await targetCount(service)).toBe(1);
    expect(await service.status()).toMatchObject({ total: 1, cross_verified: 1, cities: 1 });
  });

  it('waits through a temporary key pacing interval instead of pausing the sync', async () => {
    const now = new Date().toISOString();
    await addressDb.batch([
      addressDb.prepare(`INSERT INTO cn_admin_areas(adcode,parent_adcode,level,name,full_path,source_version,updated_at)
        VALUES (?,?,?,?,?,?,?)`).bind('110000', null, 'province', '北京市', '北京市', 'test', now),
      addressDb.prepare(`INSERT INTO cn_admin_areas(adcode,parent_adcode,level,name,full_path,source_version,updated_at)
        VALUES (?,?,?,?,?,?,?)`).bind('110100', '110000', 'city', '北京市', '北京市/北京市', 'test', now),
      addressDb.prepare(`INSERT INTO cn_admin_areas(adcode,parent_adcode,level,name,full_path,source_version,updated_at)
        VALUES (?,?,?,?,?,?,?)`).bind('110105', '110100', 'district', '朝阳区', '北京市/北京市/朝阳区', 'test', now)
    ]);
    await control.addCredential({ provider: 'amap', label: 'test', secret: 'test-key', qpsLimit: 5 });
    let requests = 0;
    const paths: string[] = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/v3/config/district') {
        return Response.json({ status: '1', districts: [{ name: '朝阳区', center: '116.443,39.921', districts: [] }] });
      }
      requests += 1;
      paths.push(url.pathname);
      const page = Number(url.searchParams.get('page'));
      return new Response(JSON.stringify({ status: '1', pois: page === 1 ? [{
        id: 'poi-1', name: '望京花园', address: '阜通东大街6号', location: '116.47,39.995',
        pname: '北京市', cityname: '北京市', adname: '朝阳区', adcode: '110105', typecode: '120302'
      }] : [] }), { status: 200 });
    });
    const service = new ChinaDataService(addressDb, control);
    const runId = await service.start();
    let status = '';
    for (let attempt = 0; attempt < 40; attempt += 1) {
      status = String((await control.runs(10)).find((run) => run.id === runId)?.status || '');
      if (['succeeded', 'failed', 'paused_quota'].includes(status)) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    expect(status, JSON.stringify((await control.runs(10)).find((run) => run.id === runId))).toBe('succeeded');
    expect(requests).toBe(2);
    expect(paths).toEqual(['/v3/place/around', '/v3/place/around']);
    await service.close();
  });

  it('uses all configured China map providers during a district sync', async () => {
    const now = new Date().toISOString();
    await addressDb.batch([
      addressDb.prepare(`INSERT INTO cn_admin_areas(adcode,parent_adcode,level,name,full_path,source_version,updated_at)
        VALUES (?,?,?,?,?,?,?)`).bind('110000', null, 'province', '北京市', '北京市', 'test', now),
      addressDb.prepare(`INSERT INTO cn_admin_areas(adcode,parent_adcode,level,name,full_path,source_version,updated_at)
        VALUES (?,?,?,?,?,?,?)`).bind('110100', '110000', 'city', '北京市', '北京市/北京市', 'test', now),
      addressDb.prepare(`INSERT INTO cn_admin_areas(adcode,parent_adcode,level,name,full_path,source_version,updated_at)
        VALUES (?,?,?,?,?,?,?)`).bind('110105', '110100', 'district', '朝阳区', '北京市/北京市/朝阳区', 'test', now)
    ]);
    for (const provider of ['amap', 'baidu', 'tencent'] as const) {
      await control.addCredential({ provider, label: provider, secret: `${provider}-test`, qpsLimit: 10 });
    }
    const requested = new Set<string>();
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const provider = url.hostname.includes('amap') ? 'amap' : url.hostname.includes('baidu') ? 'baidu' : 'tencent';
      requested.add(provider);
      const page = provider === 'amap' ? Number(url.searchParams.get('page')) : provider === 'baidu'
        ? Number(url.searchParams.get('page_num')) + 1 : Number(url.searchParams.get('page_index'));
      if (provider === 'amap') return Response.json({ status: '1', pois: page === 1 ? [{
        id: 'amap-poi', name: '望京花园', address: '阜通东大街6号', location: '116.47,39.995',
        pname: '北京市', cityname: '北京市', adname: '朝阳区', adcode: '110105', typecode: '120302'
      }] : [] });
      if (provider === 'baidu') return Response.json({ status: 0, results: page === 1 ? [{
        uid: 'baidu-poi', name: '望京花园', address: '阜通东大街6号', location: { lat: 40.001, lng: 116.4765 },
        province: '北京市', city: '北京市', area: '朝阳区', adcode: '110105', detail_info: { tag: '房地产;住宅区' }
      }] : [] });
      return Response.json({ status: 0, data: page === 1 ? [{
        id: 'tencent-poi', title: '望京花园', address: '阜通东大街6号', category: '房产小区:住宅区',
        location: { lat: 39.995, lng: 116.47 }, ad_info: { province: '北京市', city: '北京市', district: '朝阳区', adcode: '110105' }
      }] : [] });
    });
    const service = new ChinaDataService(addressDb, control);
    const runId = await service.start();
    let status = '';
    for (let attempt = 0; attempt < 80; attempt += 1) {
      status = String((await control.runs(10)).find((run) => run.id === runId)?.status || '');
      if (['succeeded', 'failed', 'paused_quota', 'needs_review'].includes(status)) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    expect(status, JSON.stringify((await control.runs(10)).find((run) => run.id === runId))).toBe('succeeded');
    expect(requested).toEqual(new Set(['amap', 'baidu', 'tencent']));
    expect((await addressDb.prepare('SELECT DISTINCT provider FROM cn_ingest_candidates ORDER BY provider')
      .all<{ provider: string }>()).results.map((row) => row.provider)).toEqual(['amap', 'baidu', 'tencent']);
    const run = (await control.runs(10)).find((value) => value.id === runId) as { progress?: { published?: number } } | undefined;
    expect(run?.progress?.published).toBe(await countChinaCommunities(addressDb));
    await service.close();
  });

  it('yields the event loop and tracks published counts in memory during a large sync', async () => {
    await control.addCredential({ provider: 'amap', label: 'bulk', secret: 'bulk-key', qpsLimit: 100 });
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      const page = Number(new URL(String(input)).searchParams.get('page'));
      return Response.json({ status: '1', pois: page === 1 ? Array.from({ length: 30 }, (_, index) => ({
        id: `bulk-poi-${index}`, name: `光明${index}小区`, address: `文化路${index + 1}号`, location: '118.162,39.832',
        pname: '河北省', cityname: '唐山市', adname: '丰润区', adcode: '130208', typecode: '120302'
      })) : [] });
    });
    const service = new ChinaDataService(addressDb, control);
    const runId = await control.createRun('china-communities', { mode: 'test', targets: 1, providers: ['amap'] });
    let ticks = 0;
    let pumping = true;
    const pump = (): void => { ticks += 1; if (pumping) setImmediate(pump); };
    setImmediate(pump);
    try {
      await (service as unknown as {
        execute(runId: string, targets: Record<string, unknown>[], providers: string[]): Promise<void>;
      }).execute(runId, [{
        id: '130208', province: '河北省', city: '唐山市', district: '丰润区', query: '唐山市丰润区', targetCount: 40
      }], ['amap']);
    } finally {
      pumping = false;
    }
    expect(ticks).toBeGreaterThan(0);
    const run = (await control.runs(10)).find((value) => value.id === runId) as {
      status: string; progress?: { published?: number; accepted?: number };
    } | undefined;
    expect(run?.status).toBe('succeeded');
    expect(run?.progress?.accepted).toBe(30);
    expect(run?.progress?.published).toBe(30);
    expect(await countChinaCommunities(addressDb)).toBe(30);
  }, 15_000);

  describe('dual completion criteria', () => {
    const hex = (value: string): string => Buffer.from(value, 'utf8').toString('hex');
    const areaCandidate = (
      province: string, city: string, district: string, adcode: string, index: number,
      provider: CommunityCandidate['provider'] = 'amap'
    ): CommunityCandidate => ({
      provider,
      providerPoiId: `${provider}-${adcode}-${index}`,
      name: `光明${adcode}${index}小区`,
      address: `文化路${index + 1}号`,
      province, city, district, township: '',
      latitude: 39.6 + index * 0.01, longitude: 118.1 + index * 0.01,
      rawLatitude: 39.606 + index * 0.01, rawLongitude: 118.106 + index * 0.01,
      rawCrs: 'GCJ-02', responseHash: `${provider}-${adcode}-${index}`,
      typecode: provider === 'amap' ? '120302' : '住宅小区', adcode
    });
    const insertAreaTarget = (adcode: string, province: string, city: string, district: string, targetCount: number) =>
      addressDb.prepare(`INSERT INTO cn_sync_area_targets(adcode,province,city,district,query,target_count,priority,enabled,updated_at)
        VALUES (?,?,?,?,?,?,?,1,?)`)
        .bind(adcode, province, city, district, `${city}${district}`, targetCount, Number(adcode), new Date().toISOString()).run();
    const seedDistrict = async (
      service: ChinaDataService, province: string, city: string, district: string, adcode: string, count: number
    ): Promise<void> => {
      for (let index = 0; index < count; index += 1) {
        expect(await upsertCandidate(service, areaCandidate(province, city, district, adcode, index))).toBe(1);
      }
    };
    const syncTarget = (adcode: string, province: string, city: string, district: string, targetCount: number) =>
      ({ id: adcode, province, city, district, query: `${city}${district}`, targetCount });
    const execute = (service: ChinaDataService, runId: string, targets: unknown[], providers: string[]) =>
      (service as unknown as {
        execute(runId: string, targets: unknown[], providers: string[]): Promise<void>;
      }).execute(runId, targets, providers);
    const amapPage = (adcode: string, adname: string, count: number) => ({
      status: '1',
      pois: Array.from({ length: count }, (_, index) => ({
        id: `poi-${adcode}-${index}`, name: `新城${adcode}${index}小区`, address: `新华路${index + 1}号`,
        location: `${(118.18 + index * 0.01).toFixed(4)},${(39.63 + index * 0.01).toFixed(4)}`,
        pname: '河北省', cityname: '唐山市', adname, adcode, typecode: '120302'
      }))
    });

    it('uses the CN min_per_node policy for automatic district baselines', async () => {
      await updateCountryPolicy(addressDb, 'CN', { minPerNode: 7 });
      vi.stubGlobal('fetch', async () => new Response(JSON.stringify([{
        code: '110000', name: '北京市', level: 'province', children: [{
          code: '110100', name: '北京市', level: 'city', children: [{ code: '110105', name: '朝阳区', level: 'district' }]
        }]
      }]), { status: 200 }));
      const service = new ChinaDataService(addressDb, control);
      await service.importAreaCity('https://example.test/areas.json', 'min-per-node');
      expect(await addressDb.prepare('SELECT target_count FROM cn_sync_area_targets WHERE adcode=?')
        .bind('110105').first('target_count')).toBe(7);
    });

    it('syncs only uncovered districts and exceeds the country minimum to satisfy coverage', async () => {
      await updateCountryPolicy(addressDb, 'CN', {
        targetCount: 2, minPerNode: 2, coverageRatio: 1, level1Min: 0, level2Min: 0
      });
      await insertAreaTarget('130208', '河北省', '唐山市', '丰润区', 2);
      await insertAreaTarget('130202', '河北省', '唐山市', '路南区', 2);
      const service = new ChinaDataService(addressDb, control);
      await seedDistrict(service, '河北省', '唐山市', '丰润区', '130208', 2);
      await control.addCredential({ provider: 'amap', label: 'coverage', secret: 'coverage-key', qpsLimit: 100 });
      const requestedRegions: string[] = [];
      vi.stubGlobal('fetch', async (input: string | URL | Request) => {
        const url = new URL(String(input));
        const region = url.searchParams.get('city') || '';
        requestedRegions.push(region);
        const page = Number(url.searchParams.get('page'));
        return Response.json(page === 1 && region === '130202' ? amapPage('130202', '路南区', 5) : { status: '1', pois: [] });
      });
      const runId = await control.createRun('china-communities', { mode: 'test', targets: 2, providers: ['amap'] });
      await execute(service, runId, [
        syncTarget('130208', '河北省', '唐山市', '丰润区', 2),
        syncTarget('130202', '河北省', '唐山市', '路南区', 2)
      ], ['amap']);
      expect(requestedRegions.length).toBeGreaterThan(0);
      expect(requestedRegions.every((region) => region === '130202')).toBe(true);
      expect(await addressDb.prepare('SELECT COUNT(*) AS total FROM cn_communities_v2 WHERE active=1').first('total')).toBe(4);
      expect(await addressDb.prepare("SELECT COUNT(*) AS total FROM cn_communities_v2 WHERE district='路南区' AND active=1")
        .first('total')).toBe(2);
      expect((await control.runs(10)).find((run) => run.id === runId)?.status).toBe('succeeded');
    });

    it('continues to later provider pages when an earlier raw page has no publishable candidates', async () => {
      await updateCountryPolicy(addressDb, 'CN', {
        targetCount: 1, minPerNode: 1, coverageRatio: 1, level1Min: 0, level2Min: 0
      });
      await insertAreaTarget('130208', '河北省', '唐山市', '丰润区', 1);
      await control.addCredential({ provider: 'amap', label: 'pagination', secret: 'pagination-key', qpsLimit: 100 });
      const pages: number[] = [];
      vi.stubGlobal('fetch', async (input: string | URL | Request) => {
        const page = Number(new URL(String(input)).searchParams.get('page'));
        pages.push(page);
        if (page === 1) return Response.json({
          status: '1',
          pois: [{
            id: 'rejected-page-one', name: '丰润商场', address: '建设路1号', location: '118.18,39.63',
            pname: '河北省', cityname: '唐山市', adname: '丰润区', adcode: '130208', typecode: '060100'
          }]
        });
        return Response.json(page === 2 ? amapPage('130208', '丰润区', 1) : { status: '1', pois: [] });
      });
      const service = new ChinaDataService(addressDb, control);
      const runId = await control.createRun('china-communities', { mode: 'test', targets: 1, providers: ['amap'] });
      await service.runSync(runId, [syncTarget('130208', '河北省', '唐山市', '丰润区', 1)], ['amap']);
      expect(pages).toEqual([1, 2]);
      expect(await countChinaCommunities(addressDb)).toBe(1);
      expect(await addressDb.prepare("SELECT page,status FROM cn_sync_checkpoints WHERE provider='amap' AND city='130208'")
        .first()).toMatchObject({ page: 3, status: 'baseline' });
    });

    it('resumes a legacy rejected-page checkpoint from the following page', async () => {
      await updateCountryPolicy(addressDb, 'CN', {
        targetCount: 1, minPerNode: 1, coverageRatio: 1, level1Min: 0, level2Min: 0
      });
      await insertAreaTarget('130208', '河北省', '唐山市', '丰润区', 1);
      await control.addCredential({ provider: 'amap', label: 'legacy-page', secret: 'legacy-page-key', qpsLimit: 100 });
      await addressDb.prepare(`INSERT INTO cn_sync_checkpoints(provider,city,page,status,accepted_count,updated_at,strategy_version)
        VALUES ('amap','130208',1,'adapter_rejected_all',0,?,'community-poi-v11-amap-community')`).bind(new Date().toISOString()).run();
      const pages: number[] = [];
      vi.stubGlobal('fetch', async (input: string | URL | Request) => {
        const page = Number(new URL(String(input)).searchParams.get('page'));
        pages.push(page);
        return Response.json(page === 2 ? amapPage('130208', '丰润区', 1) : { status: '1', pois: [] });
      });
      const service = new ChinaDataService(addressDb, control);
      const runId = await control.createRun('china-communities', { mode: 'test', targets: 1, providers: ['amap'] });
      await service.runSync(runId, [syncTarget('130208', '河北省', '唐山市', '丰润区', 1)], ['amap']);
      expect(pages).toEqual([2]);
      expect(await countChinaCommunities(addressDb)).toBe(1);
    });

    it('does not exhaust China while a configured provider is only waiting for quota', async () => {
      await updateCountryPolicy(addressDb, 'CN', {
        targetCount: 1, minPerNode: 2, coverageRatio: 1, level1Min: 0, level2Min: 0
      });
      await insertAreaTarget('130208', '河北省', '唐山市', '丰润区', 2);
      const service = new ChinaDataService(addressDb, control);
      await seedDistrict(service, '河北省', '唐山市', '丰润区', '130208', 1);
      await control.addCredential({ provider: 'amap', label: 'scanned', secret: 'scanned-key', qpsLimit: 100 });
      const baiduId = await control.addCredential({ provider: 'baidu', label: 'waiting', secret: 'waiting-key', qpsLimit: 100 });
      await control.reportCredential(baiduId, 'quota');
      await addressDb.prepare(`INSERT INTO cn_sync_checkpoints(provider,city,page,status,accepted_count,updated_at,strategy_version)
        VALUES ('amap','130208',1,'exhausted',0,?,'community-poi-v11-amap-community')`).bind(new Date().toISOString()).run();
      const runId = await control.createRun('china-communities', { mode: 'test', targets: 1, providers: ['amap'] });
      const result = await service.runSync(runId, [syncTarget('130208', '河北省', '唐山市', '丰润区', 2)], ['amap']);
      expect(result).toEqual({ syncState: 'below_target', waitReason: '' });
      await (service as unknown as { scheduleContinuation(): Promise<void> }).scheduleContinuation();
      const status = await service.status() as { syncState: string; waitReason: string; nextAttemptAt: string | null };
      expect(status).toMatchObject({ syncState: 'quota_wait', waitReason: 'quota' });
      expect(status.nextAttemptAt).not.toBeNull();
      await service.close();
    });

    it('schedules healthy Amap v5 capacity when only its legacy v3 checkpoint is terminal', async () => {
      await updateCountryPolicy(addressDb, 'CN', {
        targetCount: 1, minPerNode: 2, coverageRatio: 1, level1Min: 0, level2Min: 0
      });
      await insertAreaTarget('130208', '河北省', '唐山市', '丰润区', 2);
      const service = new ChinaDataService(addressDb, control);
      await seedDistrict(service, '河北省', '唐山市', '丰润区', '130208', 1);
      await control.addCredential({ provider: 'amap', label: 'v5-ready', secret: 'v5-ready-key', qpsLimit: 100 });
      const tencentId = await control.addCredential({
        provider: 'tencent', label: 'waiting', secret: 'waiting-key', qpsLimit: 100
      });
      await control.reportCredential(tencentId, 'quota');
      await addressDb.prepare(`INSERT INTO cn_sync_checkpoints(provider,city,page,status,accepted_count,updated_at,strategy_version)
        VALUES ('amap','130208',1,'exhausted',0,?,'community-poi-v7')`).bind(new Date().toISOString()).run();

      await (service as unknown as { scheduleContinuation(delayMs: number): Promise<void> }).scheduleContinuation(60_000);

      expect(await service.status()).toMatchObject({ syncState: 'below_target', waitReason: 'ready' });
      await service.close();
    });

    it('stops immediately without requests when count and coverage targets are both met', async () => {
      await updateCountryPolicy(addressDb, 'CN', {
        targetCount: 2, minPerNode: 1, coverageRatio: 1, level1Min: 0, level2Min: 0
      });
      await insertAreaTarget('130208', '河北省', '唐山市', '丰润区', 1);
      await insertAreaTarget('130202', '河北省', '唐山市', '路南区', 1);
      const service = new ChinaDataService(addressDb, control);
      await seedDistrict(service, '河北省', '唐山市', '丰润区', '130208', 1);
      await seedDistrict(service, '河北省', '唐山市', '路南区', '130202', 1);
      await control.addCredential({ provider: 'amap', label: 'met', secret: 'met-key', qpsLimit: 100 });
      let requests = 0;
      vi.stubGlobal('fetch', async () => {
        requests += 1;
        return Response.json({ status: '1', pois: [] });
      });
      const runId = await control.createRun('china-communities', { mode: 'test', targets: 2, providers: ['amap'] });
      await execute(service, runId, [
        syncTarget('130208', '河北省', '唐山市', '丰润区', 1),
        syncTarget('130202', '河北省', '唐山市', '路南区', 1)
      ], ['amap']);
      expect(requests).toBe(0);
      expect((await control.runs(10)).find((run) => run.id === runId)?.status).toBe('succeeded');
    });

    it('prioritizes larger deficits and reports coverage_sources_exhausted without endless retries', async () => {
      await updateCountryPolicy(addressDb, 'CN', {
        targetCount: 3, minPerNode: 2, coverageRatio: 1, level1Min: 0, level2Min: 0
      });
      await insertAreaTarget('130208', '河北省', '唐山市', '丰润区', 2);
      await insertAreaTarget('130203', '河北省', '唐山市', '路北区', 2);
      await insertAreaTarget('130202', '河北省', '唐山市', '路南区', 2);
      const service = new ChinaDataService(addressDb, control);
      await seedDistrict(service, '河北省', '唐山市', '丰润区', '130208', 2);
      await seedDistrict(service, '河北省', '唐山市', '路北区', '130203', 1);
      await control.addCredential({ provider: 'amap', label: 'dry', secret: 'dry-key', qpsLimit: 100 });
      const requestedRegions: string[] = [];
      vi.stubGlobal('fetch', async (input: string | URL | Request) => {
        requestedRegions.push(new URL(String(input)).searchParams.get('city') || '');
        return Response.json({ status: '1', pois: [] });
      });
      const runId = await control.createRun('china-communities', { mode: 'test', targets: 3, providers: ['amap'] });
      const result = await service.runSync(runId, [
        syncTarget('130208', '河北省', '唐山市', '丰润区', 2),
        syncTarget('130203', '河北省', '唐山市', '路北区', 2),
        syncTarget('130202', '河北省', '唐山市', '路南区', 2)
      ], ['amap']);
      expect(requestedRegions).toEqual(['130202', '130203']);
      expect(result).toEqual({ syncState: 'source_limited', waitReason: 'coverage_sources_exhausted' });
      await (service as unknown as { scheduleContinuation(): Promise<void> }).scheduleContinuation();
      const status = await service.status() as { nextAttemptAt: string | null };
      expect(status).toMatchObject({ syncState: 'source_limited', waitReason: 'coverage_sources_exhausted' });
      expect(status.nextAttemptAt).toBeNull();
      await service.close();
    });

    it('keeps syncing districts of an under-floor province beyond min_per_node until the floor is met', async () => {
      await updateCountryPolicy(addressDb, 'CN', {
        targetCount: 7, minPerNode: 1, coverageRatio: 1, level1Min: 4, level2Min: 0
      });
      await insertAreaTarget('130208', '河北省', '唐山市', '丰润区', 1);
      await insertAreaTarget('130202', '河北省', '唐山市', '路南区', 1);
      await insertAreaTarget('370102', '山东省', '济南市', '历下区', 1);
      const service = new ChinaDataService(addressDb, control);
      await seedDistrict(service, '河北省', '唐山市', '丰润区', '130208', 2);
      await seedDistrict(service, '河北省', '唐山市', '路南区', '130202', 1);
      await seedDistrict(service, '山东省', '济南市', '历下区', '370102', 4);
      await control.addCredential({ provider: 'amap', label: 'floor', secret: 'floor-key', qpsLimit: 100 });
      const requestedRegions: string[] = [];
      vi.stubGlobal('fetch', async (input: string | URL | Request) => {
        const url = new URL(String(input));
        const region = url.searchParams.get('city') || '';
        requestedRegions.push(region);
        const page = Number(url.searchParams.get('page'));
        const district = region === '130208' ? '丰润区' : '路南区';
        return Response.json(page === 1 ? amapPage(region, district, 1) : { status: '1', pois: [] });
      });
      const runId = await control.createRun('china-communities', { mode: 'test', targets: 3, providers: ['amap'] });
      await execute(service, runId, [
        syncTarget('370102', '山东省', '济南市', '历下区', 1),
        syncTarget('130208', '河北省', '唐山市', '丰润区', 1),
        syncTarget('130202', '河北省', '唐山市', '路南区', 1)
      ], ['amap']);
      expect(requestedRegions).toEqual(['130208']);
      expect(await addressDb.prepare('SELECT COUNT(*) AS total FROM cn_communities_v2 WHERE active=1').first('total')).toBe(8);
      expect((await control.runs(10)).find((run) => run.id === runId)?.status).toBe('succeeded');
    });

    it('settles a zero-request coverage run into source_limited with a quota-boundary horizon', async () => {
      await updateCountryPolicy(addressDb, 'CN', {
        targetCount: 1, minPerNode: 2, coverageRatio: 1, level1Min: 0, level2Min: 0
      });
      await insertAreaTarget('130208', '河北省', '唐山市', '丰润区', 2);
      const service = new ChinaDataService(addressDb, control);
      await seedDistrict(service, '河北省', '唐山市', '丰润区', '130208', 1);
      await control.addCredential({ provider: 'amap', label: 'noop', secret: 'noop-key', qpsLimit: 100 });
      // All 8 pages consumed on a previous run without a terminal status: page overflow, not 'exhausted'.
      await addressDb.prepare(`INSERT INTO cn_sync_checkpoints(provider,city,page,status,accepted_count,updated_at,strategy_version)
        VALUES ('amap','130208',9,'baseline',0,?,'community-poi-v11-amap-community')`).bind(new Date().toISOString()).run();
      let requests = 0;
      vi.stubGlobal('fetch', async () => {
        requests += 1;
        return Response.json({ status: '1', pois: [] });
      });
      const runId = await control.createRun('china-communities', { mode: 'test', targets: 1, providers: ['amap'] });
      const result = await service.runSync(runId, [syncTarget('130208', '河北省', '唐山市', '丰润区', 2)], ['amap']);
      expect(requests).toBe(0);
      expect(result).toEqual({ syncState: 'source_limited', waitReason: 'coverage_sources_exhausted' });
      expect((await control.runs(10)).find((run) => run.id === runId)?.status).toBe('succeeded');
      await (service as unknown as { scheduleContinuation(): Promise<void> }).scheduleContinuation();
      const status = await service.status() as { nextAttemptAt: string | null };
      expect(status).toMatchObject({ syncState: 'source_limited', waitReason: 'coverage_sources_exhausted' });
      expect(status.nextAttemptAt).toBeNull();
      await service.close();
    });

    it('retries an amap-exhausted district with tencent before baidu on fresh per-provider checkpoints', async () => {
      await updateCountryPolicy(addressDb, 'CN', {
        targetCount: 1, minPerNode: 2, coverageRatio: 1, level1Min: 0, level2Min: 0
      });
      await insertAreaTarget('130208', '河北省', '唐山市', '丰润区', 2);
      const service = new ChinaDataService(addressDb, control);
      await seedDistrict(service, '河北省', '唐山市', '丰润区', '130208', 1);
      for (const provider of ['amap', 'baidu', 'tencent'] as const) {
        await control.addCredential({ provider, label: provider, secret: `${provider}-key`, qpsLimit: 100 });
      }
      await addressDb.prepare(`INSERT INTO cn_sync_checkpoints(provider,city,page,status,accepted_count,updated_at,strategy_version)
        VALUES ('amap','130208',3,'exhausted',0,?,'community-poi-v11-amap-community')`).bind(new Date().toISOString()).run();
      const order: string[] = [];
      vi.stubGlobal('fetch', async (input: string | URL | Request) => {
        const url = new URL(String(input));
        const provider = url.hostname.includes('amap') ? 'amap' : url.hostname.includes('baidu') ? 'baidu' : 'tencent';
        order.push(provider);
        if (provider === 'amap') return Response.json({ status: '1', pois: [] });
        if (provider === 'tencent') return Response.json({ status: 0, data: [] });
        const page = Number(url.searchParams.get('page_num')) + 1;
        return Response.json({ status: 0, results: page === 1 ? [{
          uid: 'baidu-fill', name: '幸福小区', address: '建设路8号', location: { lat: 39.845, lng: 118.175 },
          province: '河北省', city: '唐山市', area: '丰润区', adcode: '130208', detail_info: { tag: '房地产;住宅区' }
        }] : [] });
      });
      const runId = await control.createRun('china-communities', { mode: 'test', targets: 1, providers: ['amap', 'baidu', 'tencent'] });
      const result = await service.runSync(runId, [syncTarget('130208', '河北省', '唐山市', '丰润区', 2)], ['amap', 'baidu', 'tencent']);
      expect(order).toEqual(['tencent', 'baidu']);
      expect(result.syncState).not.toBe('source_limited');
      expect(await addressDb.prepare("SELECT decision FROM cn_ingest_candidates WHERE provider='baidu' AND provider_poi_id='baidu-fill'")
        .first('decision')).toBe('accepted');
      expect(await countChinaCommunities(addressDb)).toBe(2);
      const checkpoints = (await addressDb.prepare("SELECT provider,status FROM cn_sync_checkpoints WHERE city='130208' ORDER BY provider")
        .all<{ provider: string; status: string }>()).results;
      expect(checkpoints).toEqual([
        { provider: 'amap', status: 'exhausted' },
        { provider: 'baidu', status: 'baseline' },
        { provider: 'tencent', status: 'exhausted' }
      ]);
      expect((await control.runs(10)).find((run) => run.id === runId)?.status).toBe('succeeded');
    });

    it('keeps filling uncovered districts after the former 1.2x threshold', async () => {
      await updateCountryPolicy(addressDb, 'CN', {
        targetCount: 5, minPerNode: 2, coverageRatio: 1, level1Min: 0, level2Min: 0
      });
      await insertAreaTarget('130208', '河北省', '唐山市', '丰润区', 2);
      await insertAreaTarget('130202', '河北省', '唐山市', '路南区', 2);
      const service = new ChinaDataService(addressDb, control);
      await seedDistrict(service, '河北省', '唐山市', '丰润区', '130208', 6);
      await control.addCredential({ provider: 'amap', label: 'cap', secret: 'cap-key', qpsLimit: 100 });
      let requests = 0;
      vi.stubGlobal('fetch', async () => {
        requests += 1;
        return Response.json({ status: '1', pois: [] });
      });
      const runId = await control.createRun('china-communities', { mode: 'test', targets: 2, providers: ['amap'] });
      const result = await service.runSync(runId, [
        syncTarget('130208', '河北省', '唐山市', '丰润区', 2),
        syncTarget('130202', '河北省', '唐山市', '路南区', 2)
      ], ['amap']);
      expect(requests).toBeGreaterThan(0);
      expect(result).toEqual({ syncState: 'source_limited', waitReason: 'coverage_sources_exhausted' });
      await (service as unknown as { scheduleContinuation(): Promise<void> }).scheduleContinuation();
      expect(await service.status()).toMatchObject({
        syncState: 'source_limited', waitReason: 'coverage_sources_exhausted', nextAttemptAt: null
      });
      await service.close();
    });

    it('treats overridden node targets as minimums without retiring valid communities', async () => {
      await updateCountryPolicy(addressDb, 'CN', {
        targetCount: 1, minPerNode: 1, coverageRatio: 1, level1Min: 0, level2Min: 0
      });
      await insertAreaTarget('130208', '河北省', '唐山市', '丰润区', 1);
      const service = new ChinaDataService(addressDb, control);
      await seedDistrict(service, '河北省', '唐山市', '丰润区', '130208', 3);
      expect(await upsertCandidate(service, {
        ...areaCandidate('河北省', '唐山市', '丰润区', '130208', 0, 'tencent'),
        providerPoiId: 'tencent-cross-0'
      })).toBe(0);
      const districtKey = `CN:dist:${hex('河北省')}:${hex('唐山市')}:${hex('丰润区')}`;
      await addressDb.prepare(`INSERT INTO admin_coverage_stats(node_key,parent_key,country_code,level,region_name,total_count,updated_at)
        VALUES (?,?,?,?,?,?,?)`)
        .bind(districtKey, `CN:loc:${hex('河北省')}:${hex('唐山市')}`, 'CN', 3, '丰润区', 3, new Date().toISOString()).run();
      await upsertNodeTarget(addressDb, districtKey, 1);
      const runId = await control.createRun('china-communities', { mode: 'test', targets: 0, providers: ['amap'] });
      await execute(service, runId, [], ['amap']);
      const survivors = (await addressDb.prepare(`SELECT canonical_name,verification_level FROM cn_communities_v2
        WHERE active=1 ORDER BY canonical_name`).all<Record<string, unknown>>()).results;
      expect(survivors).toHaveLength(3);
      expect(survivors).toContainEqual(expect.objectContaining({ canonical_name: '光明1302080小区', verification_level: 'L2' }));
      expect(await addressDb.prepare('SELECT COUNT(*) AS total FROM cn_communities_v2 WHERE active=0').first('total')).toBe(0);
      const audit = (await control.audits(20)).find((entry) => entry.action === 'china.communities.prune');
      expect(audit).toBeUndefined();
      expect((await control.runs(10)).find((run) => run.id === runId)?.status).toBe('succeeded');
    });
  });

  describe('township-level query subdivision', () => {
    const insertAdminArea = (adcode: string, parent: string | null, level: string, name: string) =>
      addressDb.prepare(`INSERT INTO cn_admin_areas(adcode,parent_adcode,level,name,full_path,source_version,updated_at)
        VALUES (?,?,?,?,?,?,?)`).bind(adcode, parent, level, name, name, 'test', new Date().toISOString()).run();
    const insertAreaTarget = (adcode: string, province: string, city: string, district: string, targetCount: number) =>
      addressDb.prepare(`INSERT INTO cn_sync_area_targets(adcode,province,city,district,query,target_count,priority,enabled,updated_at)
        VALUES (?,?,?,?,?,?,?,1,?)`)
        .bind(adcode, province, city, district, `${city}${district}`, targetCount, Number(adcode), new Date().toISOString()).run();
    const insertCheckpoint = (provider: string, city: string, page: number, status: string) =>
      addressDb.prepare(`INSERT INTO cn_sync_checkpoints(provider,city,page,status,accepted_count,updated_at,strategy_version)
        VALUES (?,?,?,?,0,?,?)`).bind(provider, city, page, status, new Date().toISOString(),
        provider === 'amap' ? 'community-poi-v11-amap-community' : 'community-poi-v8-community').run();
    const fengrunAreas = async (): Promise<void> => {
      await insertAdminArea('130000', null, 'province', '河北省');
      await insertAdminArea('1302', '130000', 'city', '唐山市');
      await insertAdminArea('130208', '1302', 'district', '丰润区');
      await insertAdminArea('130208001', '130208', 'township', '甲镇');
      await insertAdminArea('130208002', '130208', 'township', '乙镇');
      await insertAdminArea('130208003', '130208', 'township', '丙镇');
      await insertAreaTarget('130208', '河北省', '唐山市', '丰润区', 3);
    };
    const fengrunTarget = { id: '130208', province: '河北省', city: '唐山市', district: '丰润区', query: '唐山市丰润区', targetCount: 3 };
    const fengrunCenters = [['', 118.16, 39.83], ['甲镇', 118.05, 39.75], ['乙镇', 118.3, 39.9]] as const;
    // Answers the AMap district lookup and labels each radius search with the township nearest its center.
    const stubAmapAround = (handler: (township: string, page: number, url: URL) => unknown) => {
      const lookups: string[] = [];
      vi.stubGlobal('fetch', async (input: string | URL | Request) => {
        const url = new URL(String(input));
        if (url.pathname === '/v3/config/district') {
          lookups.push(url.searchParams.get('keywords') || '');
          return Response.json({ status: '1', districts: [{ name: '丰润区', center: '118.16,39.83', districts: fengrunCenters
            .filter(([name]) => name).map(([name, longitude, latitude]) => ({ name, center: `${longitude},${latitude}`, level: 'street' })) }] });
        }
        const [longitude, latitude] = String(url.searchParams.get('location')).split(',').map(Number);
        const [township] = [...fengrunCenters].sort((left, right) =>
          Math.hypot(left[1] - longitude, left[2] - latitude) - Math.hypot(right[1] - longitude, right[2] - latitude))[0];
        return Response.json(handler(township, Number(url.searchParams.get('page')), url));
      });
      return lookups;
    };
    const townshipPois = (prefix: string, count: number, road = '建设路') => ({
      status: '1',
      pois: Array.from({ length: count }, (_, index) => ({
        id: `${prefix}-${index}`, name: `${prefix}${index}小区`, address: `${road}${index + 1}号`,
        location: `${(118.2 + index * 0.01).toFixed(4)},${(39.65 + index * 0.01).toFixed(4)}`,
        pname: '河北省', cityname: '唐山市', adname: '丰润区', adcode: '130208', typecode: '120302'
      }))
    });

    it('subdivides a terminal district window into resumable round-robin township queries', async () => {
      await updateCountryPolicy(addressDb, 'CN', { targetCount: 50, minPerNode: 3, coverageRatio: 1, level1Min: 0, level2Min: 0 });
      await fengrunAreas();
      await control.addCredential({ provider: 'amap', label: 'township', secret: 'township-key', qpsLimit: 100 });
      await insertCheckpoint('amap', '130208', 9, 'enrichment');
      await insertCheckpoint('amap', '130208001', 2, 'baseline');
      const calls: Array<{ township: string; page: number; path: string; radius: string }> = [];
      const lookups = stubAmapAround((township, page, url) => {
        calls.push({ township, page, path: url.pathname, radius: url.searchParams.get('radius') || '' });
        if (township === '甲镇' && page === 2) return townshipPois('甲', 2);
        if (township === '乙镇' && page === 1) return townshipPois('乙', 1, '振兴路');
        return { status: '1', pois: [] };
      });
      const service = new ChinaDataService(addressDb, control);
      const runId = await control.createRun('china-communities', { mode: 'test', targets: 1, providers: ['amap'] });
      const result = await service.runSync(runId, [fengrunTarget], ['amap']);
      const around = { path: '/v3/place/around', radius: '5000' };
      expect(lookups).toEqual(['130208']);
      expect(calls).toEqual([
        { township: '甲镇', page: 2, ...around },
        { township: '乙镇', page: 1, ...around },
        { township: '甲镇', page: 3, ...around },
        { township: '乙镇', page: 2, ...around }
      ]);
      expect(result).toEqual({ syncState: 'source_limited', waitReason: 'validated_sources_exhausted' });
      expect(await countChinaCommunities(addressDb)).toBe(3);
      const checkpoints = (await addressDb.prepare(`SELECT city,page,status FROM cn_sync_checkpoints
        WHERE provider='amap' AND city IN ('130208001','130208002') ORDER BY city`).all<Record<string, unknown>>()).results;
      expect(checkpoints).toEqual([
        { city: '130208001', page: 3, status: 'exhausted' },
        { city: '130208002', page: 2, status: 'exhausted' }
      ]);
      expect(await addressDb.prepare("SELECT page,status FROM cn_sync_checkpoints WHERE provider='amap' AND city='130208003'")
        .first()).toEqual({ page: 1, status: 'exhausted' });
      const run = (await control.runs(10)).find((value) => value.id === runId) as {
        progress?: { requests?: number; accepted?: number };
      } | undefined;
      expect(run?.progress).toMatchObject({ requests: 4, accepted: 3 });
    });

    it('publishes overlapping township results once via the provider POI identity', async () => {
      await updateCountryPolicy(addressDb, 'CN', { targetCount: 50, minPerNode: 3, coverageRatio: 1, level1Min: 0, level2Min: 0 });
      await fengrunAreas();
      await control.addCredential({ provider: 'amap', label: 'overlap', secret: 'overlap-key', qpsLimit: 100 });
      await insertCheckpoint('amap', '130208', 9, 'enrichment');
      const shared = townshipPois('共享', 1);
      const calls: Array<{ township: string; page: number }> = [];
      stubAmapAround((township, page) => {
        calls.push({ township, page });
        return page === 1 ? shared : { status: '1', pois: [] };
      });
      const service = new ChinaDataService(addressDb, control);
      const runId = await control.createRun('china-communities', { mode: 'test', targets: 1, providers: ['amap'] });
      await service.runSync(runId, [fengrunTarget], ['amap']);
      expect(calls).toEqual([
        { township: '甲镇', page: 1 }, { township: '乙镇', page: 1 },
        { township: '甲镇', page: 2 }, { township: '乙镇', page: 2 }
      ]);
      expect(await countChinaCommunities(addressDb)).toBe(1);
      expect(await addressDb.prepare('SELECT COUNT(*) AS total FROM cn_ingest_candidates').first('total')).toBe(1);
      expect(await addressDb.prepare('SELECT COUNT(*) AS total FROM cn_community_sources').first('total')).toBe(1);
    });

    it('keeps querying unconsumed townships before settling coverage_sources_exhausted', async () => {
      await updateCountryPolicy(addressDb, 'CN', { targetCount: 1, minPerNode: 3, coverageRatio: 1, level1Min: 0, level2Min: 0 });
      await fengrunAreas();
      const service = new ChinaDataService(addressDb, control);
      expect(await upsertCandidate(service, candidate('amap', 'seed-poi', '文化路18号'))).toBe(1);
      await control.addCredential({ provider: 'amap', label: 'terminal', secret: 'terminal-key', qpsLimit: 100 });
      await insertCheckpoint('amap', '130208', 9, 'baseline');
      await insertCheckpoint('amap', '130208001', 1, 'exhausted');
      let requests = 0;
      const lookups = stubAmapAround(() => {
        requests += 1;
        return { status: '1', pois: [] };
      });
      const first = await service.runSync(
        await control.createRun('china-communities', { mode: 'test', targets: 1, providers: ['amap'] }),
        [fengrunTarget], ['amap']
      );
      expect(requests).toBe(1);
      expect(first).toEqual({ syncState: 'source_limited', waitReason: 'coverage_sources_exhausted' });
      const second = await service.runSync(
        await control.createRun('china-communities', { mode: 'test', targets: 1, providers: ['amap'] }),
        [fengrunTarget], ['amap']
      );
      expect(requests).toBe(1);
      expect(lookups).toEqual(['130208']);
      expect(second).toEqual({ syncState: 'source_limited', waitReason: 'coverage_sources_exhausted' });
    });

    it('skips township radius windows when the district radius window ran dry before the page cap', async () => {
      await updateCountryPolicy(addressDb, 'CN', { targetCount: 1, minPerNode: 3, coverageRatio: 1, level1Min: 0, level2Min: 0 });
      await fengrunAreas();
      const service = new ChinaDataService(addressDb, control);
      expect(await upsertCandidate(service, candidate('amap', 'seed-poi', '文化路18号'))).toBe(1);
      await control.addCredential({ provider: 'amap', label: 'dry', secret: 'dry-key', qpsLimit: 100 });
      await insertCheckpoint('amap', '130208', 3, 'exhausted');
      let requests = 0;
      const lookups = stubAmapAround(() => {
        requests += 1;
        return { status: '1', pois: [] };
      });
      const result = await service.runSync(
        await control.createRun('china-communities', { mode: 'test', targets: 1, providers: ['amap'] }),
        [fengrunTarget], ['amap']
      );
      expect([requests, lookups]).toEqual([0, []]);
      expect(result).toEqual({ syncState: 'source_limited', waitReason: 'coverage_sources_exhausted' });
    });

    it('searches county-level city pseudo-districts by radius using the AMap city adcode', async () => {
      await updateCountryPolicy(addressDb, 'CN', { targetCount: 50, minPerNode: 3, coverageRatio: 1, level1Min: 0, level2Min: 0 });
      await insertAdminArea('650000', null, 'province', '新疆维吾尔自治区');
      await insertAdminArea('659005', '650000', 'city', '北屯市');
      await insertAdminArea('659005000', '659005', 'district', '北屯市');
      await control.addCredential({ provider: 'amap', label: 'beitun', secret: 'beitun-key', qpsLimit: 100 });
      const urls: URL[] = [];
      vi.stubGlobal('fetch', async (input: string | URL | Request) => {
        const url = new URL(String(input));
        urls.push(url);
        if (url.pathname === '/v3/config/district') {
          return Response.json({ status: '1', districts: [{ name: '北屯市', center: '87.83,47.36', districts: [] }] });
        }
        return Response.json({ status: '1', pois: url.searchParams.get('page') === '1' ? [
          { id: 'bt-1', name: '北屯小区', address: '解放路8号', location: '87.83,47.36', pname: '新疆维吾尔自治区',
            cityname: '北屯市', adname: '北屯市', adcode: '659005', typecode: '120302' },
          { id: 'other', name: '外市小区', address: '解放路9号', location: '87.9,47.4', pname: '新疆维吾尔自治区',
            cityname: '阿勒泰地区', adname: '阿勒泰市', adcode: '654301', typecode: '120302' }
        ] : [] });
      });
      const service = new ChinaDataService(addressDb, control);
      await service.runSync(await control.createRun('china-communities', { mode: 'test', targets: 1, providers: ['amap'] }),
        [{ id: '659005000', province: '新疆维吾尔自治区', city: '北屯市', district: '北屯市', query: '北屯市北屯市', targetCount: 3 }], ['amap']);
      expect(urls[0].pathname).toBe('/v3/config/district');
      expect(urls[0].searchParams.get('keywords')).toBe('659005');
      expect(urls.slice(1).map((url) => url.pathname)).toEqual(['/v3/place/around', '/v3/place/around']);
      expect((await addressDb.prepare('SELECT provider_poi_id FROM cn_ingest_candidates').all<{ provider_poi_id: string }>())
        .results.map((row) => row.provider_poi_id)).not.toContain('other');
    });

    it('accepts municipality candidates whose provider city is the province itself', async () => {
      await insertAdminArea('50', null, 'province', '重庆市');
      await insertAdminArea('5002', '50', 'city', '重庆郊县');
      await insertAdminArea('500101', '5002', 'district', '万州区');
      const service = new ChinaDataService(addressDb, control);
      const target = { id: '500101', province: '重庆市', city: '重庆郊县', district: '万州区', query: '重庆郊县万州区', targetCount: 5 };
      const chongqing: CommunityCandidate = {
        provider: 'amap', providerPoiId: 'cq-1', name: '滨江小区', address: '滨江路12号',
        province: '重庆市', city: '重庆市', district: '万州区', township: '', latitude: 30.81, longitude: 108.4,
        rawLatitude: 30.815, rawLongitude: 108.405, rawCrs: 'GCJ-02', responseHash: 'cq-hash', typecode: '120302', adcode: '500101'
      };
      const internals = service as unknown as {
        processCandidate(value: CommunityCandidate, target: Record<string, unknown>): Promise<number>;
        targetCount(target: Record<string, unknown>): Promise<number>;
      };
      expect(await internals.processCandidate(chongqing, target)).toBe(1);
      expect(await internals.targetCount(target)).toBe(1);
    });

    it('re-accepts stored administrative_mismatch candidates without spending quota', async () => {
      await insertAdminArea('50', null, 'province', '重庆市');
      await insertAdminArea('5002', '50', 'city', '重庆郊县');
      await insertAdminArea('500101', '5002', 'district', '万州区');
      const now = new Date().toISOString();
      await addressDb.prepare(`INSERT INTO cn_ingest_candidates(provider,provider_poi_id,target_adcode,name,address,province,city,
        district,township,longitude,latitude,raw_longitude,raw_latitude,raw_crs,typecode,adcode,response_hash,decision,
        rejection_reason,strategy_version,first_seen_at,last_seen_at)
        VALUES ('amap','cq-replay','500101','江畔人家','滨江路8号','重庆市','重庆市','万州区','',108.41,30.82,108.415,30.825,
          'GCJ-02','120302','500101','hash-replay','rejected','administrative_mismatch','community-poi-v6',?,?)`)
        .bind(now, now).run();
      const service = new ChinaDataService(addressDb, control);
      await service.initializeTargets();
      await service.close();
      expect(await addressDb.prepare("SELECT decision,rejection_reason FROM cn_ingest_candidates WHERE provider_poi_id='cq-replay'")
        .first<Record<string, unknown>>()).toMatchObject({ decision: 'accepted', rejection_reason: '' });
      expect(await countChinaCommunities(addressDb)).toBe(1);
    });

    it('re-accepts stored missing_postcode candidates with the district postcode without spending quota', async () => {
      await insertAdminArea('50', null, 'province', '重庆市');
      await insertAdminArea('5001', '50', 'city', '重庆城区');
      await insertAdminArea('500101', '5001', 'district', '万州区');
      await addressDb.prepare(`INSERT INTO catalog_postcodes(id,country_code,region_id,city_id,code,locality_name)
        VALUES (900001,'CN',NULL,NULL,'100010','东城')`).run();
      const now = new Date().toISOString();
      await addressDb.prepare(`INSERT INTO cn_ingest_candidates(provider,provider_poi_id,target_adcode,name,address,province,city,
        district,township,longitude,latitude,raw_longitude,raw_latitude,raw_crs,typecode,adcode,response_hash,decision,
        rejection_reason,strategy_version,first_seen_at,last_seen_at)
        VALUES ('tencent','cq-postcode','500101','江畔人家','滨江路8号','重庆市','重庆市','万州区','',108.41,30.82,108.415,30.825,
          'GCJ-02','房产小区;住宅区','500101','hash-postcode','rejected','missing_postcode','community-poi-v7',?,?)`)
        .bind(now, now).run();
      const service = new ChinaDataService(addressDb, control);
      await service.initializeTargets();
      await service.close();
      expect(await addressDb.prepare("SELECT decision,rejection_reason,postcode FROM cn_ingest_candidates WHERE provider_poi_id='cq-postcode'")
        .first<Record<string, unknown>>()).toMatchObject({ decision: 'accepted', rejection_reason: '', postcode: '404100' });
      expect(await countChinaCommunities(addressDb)).toBe(1);
    });
  });
});
