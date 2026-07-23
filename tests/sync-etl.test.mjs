import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { localizeAddressRecords, normalizeSourceRecord, runAddressEtl } from '../server/sync/address-etl.mjs';
import { openDatabase } from '../server/database/sqlite.mjs';
import { SqliteAddressImporter } from '../server/sync/sqlite-address-importer.mjs';
import { createSourceAdapters, loadSourceCatalog } from '../server/sync/source-adapters.mjs';
import { runAddressSync } from '../server/sync/run-address-sync.mjs';

const directories = [];
afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const source = {
  id: 'fixture', adapter: 'overture', name: 'Fixture', homepageUrl: 'https://example.test',
  dataUrl: 'https://example.test/data', licenseCode: 'CC0-1.0', licenseName: 'CC0',
  licenseUrl: 'https://example.test/license', attributionText: 'Fixture',
  attributionUrl: 'https://example.test', termsUrl: 'https://example.test/terms',
  shareAlike: false, redistributionAllowed: true, updateCadence: 'monthly'
};

describe('address source shard catalog', () => {
  it('expands only independently supported country shards with a 30-day default', async () => {
    const catalog = await loadSourceCatalog();
    expect(catalog.shards).toHaveLength(27);
    expect(catalog.shards.every((shard) => shard.intervalDays === 30)).toBe(true);
    expect(catalog.shards.findIndex((shard) => shard.countryCode === 'CN'))
      .toBeLessThan(catalog.shards.findIndex((shard) => shard.countryCode === 'RU'));
    expect(catalog.shards.find((shard) => shard.countryCode === 'MY')).toMatchObject({ extractId: 'malaysia-singapore-brunei', boundaryIso3: 'MYS' });
    expect(catalog.shards.find((shard) => shard.countryCode === 'SA')).toMatchObject({ extractId: 'gcc-states', boundaryIso3: 'SAU' });
  });

  it('stores localized variants, evidence and coordinates in the SQLite hot pool schema', async () => {
    const schema = await readFile('server/database/schema.sql', 'utf8');
    expect(schema).toContain('component_variants_json TEXT NOT NULL');
    expect(schema).toContain('address_variants_json TEXT NOT NULL');
    expect(schema).toContain('CREATE VIRTUAL TABLE IF NOT EXISTS address_coordinate_index USING rtree');
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS address_pool_evidence');
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS pool_coverage');
    expect(schema).toContain('idx_address_pool_coverage ON address_pool(coverage, active, property_type)');
  });

  it('rejects HTML metadata with a structured URL-aware error after bounded retries', async () => {
    let requests = 0;
    const adapters = createSourceAdapters({
      fetchImpl: async () => {
        requests += 1;
        return new Response('<html>not json</html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
      }
    });
    await expect(adapters.discover({ countryCode: 'US', source: { adapter: 'overture' } })).rejects.toMatchObject({
      code: 'SOURCE_METADATA_CONTENT_TYPE',
      url: 'https://stac.overturemaps.org/catalog.json',
      status: 200
    });
    expect(requests).toBe(3);
  });

  it('adds the Overture Buildings source only when residential classification is enabled', async () => {
    const fetchImpl = async (input) => {
      const url = String(input);
      if (url.endsWith('/catalog.json')) return Response.json({ latest: '2026-06-17.0' });
      if (url.endsWith('/collection.json')) return Response.json({ links: [{ rel: 'item', href: './00000.json' }] });
      return Response.json({
        bbox: [-180, -90, 180, 90],
        assets: { aws: { href: 'https://example.test/address.parquet' } }
      });
    };
    const shard = { countryCode: 'US', source: { adapter: 'overture' } };
    const enabled = await createSourceAdapters({ fetchImpl, enableOvertureResidential: true }).discover(shard);
    const disabled = await createSourceAdapters({ fetchImpl, enableOvertureResidential: false }).discover(shard);
    expect(enabled.buildingAssets).toEqual(['https://example.test/address.parquet']);
    expect(enabled.buildingAssetEntries).toEqual([{
      url: 'https://example.test/address.parquet', bbox: [-180, -90, 180, 90]
    }]);
    expect(disabled.buildingAssets).toEqual([]);
  });

  it('reuses a complete one-day-old Geofabrik PBF only during initial bootstrap', async () => {
    const cacheDir = resolve('.data-cache', `recent-bootstrap-${process.pid}-${Date.now()}`);
    const rawDir = resolve(cacheDir, 'raw');
    directories.push(cacheDir);
    await mkdir(rawDir, { recursive: true });
    const fileName = 'geofabrik-osm-cn-2026-07-15-oldetag-china-latest.osm.pbf';
    const candidate = resolve(rawDir, fileName);
    await writeFile(candidate, Buffer.alloc(96));
    await writeFile(`${candidate}.part`, Buffer.alloc(96));
    await writeFile(`${candidate}.prefetch`, Buffer.alloc(96));
    const fetchImpl = async (input, init = {}) => {
      const url = String(input);
      if (url.endsWith('index-v1-nogeom.json')) {
        return Response.json({ features: [{
          properties: { id: 'china', urls: { pbf: 'https://download.geofabrik.de/asia/china-latest.osm.pbf' } }
        }] });
      }
      if (init.method === 'HEAD') {
        return new Response(null, { status: 200, headers: {
          'last-modified': 'Thu, 16 Jul 2026 00:00:00 GMT', etag: 'newetag', 'content-length': '100'
        } });
      }
      throw new Error(`Unexpected request: ${url}`);
    };
    const adapters = createSourceAdapters({ fetchImpl });
    const shard = {
      id: 'geofabrik-osm-cn', countryCode: 'CN', extractId: 'china',
      source: { adapter: 'geofabrik' }
    };
    await expect(adapters.discover(shard, { syncMode: 'initial', cacheDir })).resolves.toMatchObject({
      version: '2026-07-15-oldetag', publishedAt: '2026-07-15T00:00:00.000Z',
      sourceBytes: 96, estimateMethod: 'recent-bootstrap-raw', bootstrapRawFile: candidate
    });
    await expect(adapters.discover(shard, { syncMode: 'daily', cacheDir })).resolves.toMatchObject({
      version: '2026-07-16-newetag', sourceBytes: 100, estimateMethod: 'http-content-length', bootstrapRawFile: null
    });
  });
});

describe('source record normalization', () => {
  it('normalizes Overture fields without inventing translated components', () => {
    const record = normalizeSourceRecord({
      id: 'overture-1', country: 'US', admin1: 'Pennsylvania', locality: 'Philadelphia',
      postal_city: 'Philadelphia', postcode: '19103', street: 'Market Street', number: '1700',
      longitude: -75.169, latitude: 39.953, source_dataset: 'OpenAddresses fixture'
    }, { id: 'fixture-us', countryCode: 'US', source }, 'overture-jsonl');
    expect(record).toMatchObject({
      countryCode: 'US', admin1: 'Pennsylvania', locality: 'Philadelphia',
      street: 'Market Street', houseNumber: '1700', propertyType: 'unknown'
    });
    expect(record.formattedAddress).toContain('Philadelphia');
  });

  it('accepts only explicit Overture residential building evidence', () => {
    const base = {
      id: 'overture-residential', country: 'US', admin1: 'Pennsylvania', locality: 'Philadelphia',
      postal_city: 'Philadelphia', postcode: '19103', street: 'Market Street', number: '1700',
      longitude: -75.169, latitude: 39.953
    };
    expect(normalizeSourceRecord({
      ...base, property_type: 'residential', residential_building_id: 'building-42', residential_building_class: 'house'
    }, { id: 'fixture-us', countryCode: 'US', source }, 'overture-jsonl')).toMatchObject({
      propertyType: 'residential', residentialSourceRecordId: 'building-42', residentialSourceClass: 'house'
    });
    expect(normalizeSourceRecord({ ...base, id: 'overture-unknown', property_type: 'commercial' },
      { id: 'fixture-us', countryCode: 'US', source }, 'overture-jsonl')).toMatchObject({ propertyType: 'unknown' });
  });

  it('uses explicit OSM building tags as residential evidence', () => {
    const record = normalizeSourceRecord({
      id: 'node/1', geometry: { type: 'Point', coordinates: [116.4, 39.9] },
      properties: { '@id': 'node/1', 'addr:housenumber': '8', 'addr:street': '文化路', 'addr:city': '北京市', building: 'apartments' }
    }, { id: 'fixture-cn', countryCode: 'CN', source: { ...source, adapter: 'geofabrik' } }, 'geofabrik-geojsonseq');
    expect(record).toMatchObject({ propertyType: 'apartment', postcode: '', nativeLanguage: 'zh-CN' });
  });

  it('keeps residential evidence from addressed OSM ways and areas', () => {
    const record = normalizeSourceRecord({
      id: 'way/88', geometry: { type: 'Point', coordinates: [-75.16, 39.95] },
      properties: { '@type': 'way', '@id': 'way/88', 'addr:housenumber': '10', 'addr:street': 'Bank Street', 'addr:city': 'Philadelphia', building: 'house' }
    }, { id: 'fixture-us', countryCode: 'US', source: { ...source, adapter: 'geofabrik' } }, 'geofabrik-geojsonseq');
    expect(record).toMatchObject({ sourceRecordId: 'way/88', propertyType: 'residential', houseNumber: '10' });
  });

  it('splits Hong Kong bilingual source components before translation', async () => {
    const record = normalizeSourceRecord({
      id: 'hk-bilingual', admin1: '九龍 Kowloon', locality: '黃大仙 Wong Tai Sin', postal_city: '黃大仙 Wong Tai Sin',
      street: '正德街 Ching Tak Street', number: '103', unit: '龍安樓 Lung On House', longitude: 114.19278, latitude: 22.34135
    }, { id: 'fixture-hk', countryCode: 'HK', source }, 'overture-jsonl');
    const [localized] = await localizeAddressRecords([record], {
      environment: { GOOGLE_TRANSLATION_ENABLED: 'true' },
      fetchImpl: async () => { throw new Error('translation should not duplicate bilingual hints'); }
    });
    expect(localized.localizations.native.components).toMatchObject({ admin1: '九龍', street: '正德街', buildingName: '龍安樓' });
    expect(localized.localizations.en.components).toMatchObject({ admin1: 'Kowloon', street: 'Ching Tak Street', buildingName: 'Lung On House' });
    expect(localized.localizations.en.components.buildingName).not.toMatch(/[\p{Script=Han}]/u);
  });

  it('builds verified-ready English and Chinese address variants before database insertion', async () => {
    const record = normalizeSourceRecord({
      id: 'overture-2', admin1: 'Pennsylvania', locality: 'Philadelphia', postal_city: 'Philadelphia',
      postcode: '19103', street: 'Market Street', number: '1700', longitude: -75.169, latitude: 39.953
    }, { id: 'fixture-us', countryCode: 'US', source }, 'overture-jsonl');
    const dictionary = new Map([
      ['Pennsylvania', '宾夕法尼亚州'], ['Philadelphia', '费城'], ['Market Street', '市场街']
    ]);
    const localized = await localizeAddressRecords([record], {
      environment: { ADDRESS_SYNC_TRANSLATION_ENABLED: 'true', GOOGLE_TRANSLATION_ENABLED: 'true' },
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        const boundary = '[[[ADDRESS_COMPONENT_BOUNDARY]]]';
        const translated = url.searchParams.get('q').split(`\n${boundary}\n`).map((value) => dictionary.get(value)).join(`\n${boundary}\n`);
        return Response.json([[[translated]]]);
      }
    });
    expect(localized[0].localizations.en.formattedAddress).toContain('Philadelphia');
    expect(localized[0].localizations['zh-CN'].components).toMatchObject({ admin1: '宾夕法尼亚州', locality: '费城', street: '市场街' });
    expect(localized[0].localizations['zh-CN'].formattedAddress).toBe('美国宾夕法尼亚州费城市场街170019103');
  });

  it('keeps source components when translation providers are unavailable', async () => {
    const record = normalizeSourceRecord({
      id: 'overture-fallback', admin1: 'Victoria', locality: 'Melbourne', postal_city: 'Melbourne',
      postcode: '3000', street: 'King Street', number: '10', longitude: 144.956, latitude: -37.817
    }, { id: 'fixture-au', countryCode: 'AU', source }, 'overture-jsonl');
    const [localized] = await localizeAddressRecords([record], {
      environment: { GOOGLE_TRANSLATION_ENABLED: 'true' },
      fetchImpl: async () => { throw new Error('translator unavailable'); }
    });
    expect(localized.localizations.en.components.admin1).toBe('Victoria');
    expect(localized.localizations['zh-CN'].components.admin1).toBe('Victoria');
  });

  it('supports deferred translation during the initial bulk import', async () => {
    const record = normalizeSourceRecord({
      id: 'overture-deferred', admin1: 'Victoria', locality: 'Melbourne', postal_city: 'Melbourne',
      postcode: '3000', street: 'King Street', number: '10', longitude: 144.956, latitude: -37.817
    }, { id: 'fixture-au', countryCode: 'AU', source }, 'overture-jsonl');
    const fetchImpl = vi.fn();
    const [localized] = await localizeAddressRecords([record], {
      environment: { ADDRESS_SYNC_TRANSLATION_ENABLED: 'false' }, fetchImpl
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(localized.localizations['zh-CN'].source).toBe('local-postal-fallback');
  });

  it('uses deterministic local CN and HK variants while bulk translation is deferred', async () => {
    const china = normalizeSourceRecord({
      id: 'cn-deferred', admin1: '河北省', locality: '唐山市', postal_city: '唐山市',
      street: '文化路', number: '30', longitude: 118.18, latitude: 39.63
    }, { id: 'fixture-cn', countryCode: 'CN', source }, 'overture-jsonl');
    const hongKong = normalizeSourceRecord({
      id: 'hk-deferred', admin1: '九龍 Kowloon', locality: '黃大仙 Wong Tai Sin', postal_city: '黃大仙 Wong Tai Sin',
      street: '正德街 Ching Tak Street', number: '103', unit: '龍安樓 Lung On House', longitude: 114.19, latitude: 22.34
    }, { id: 'fixture-hk', countryCode: 'HK', source }, 'overture-jsonl');
    const taiwan = normalizeSourceRecord({
      id: 'tw-deferred', admin1: '臺北市', locality: '中正區', postal_city: '中正區',
      street: '忠孝東路', number: '100', longitude: 121.52, latitude: 25.04
    }, { id: 'fixture-tw', countryCode: 'TW', source }, 'overture-jsonl');
    const [localizedChina, localizedHongKong, localizedTaiwan] = await localizeAddressRecords([china, hongKong, taiwan], {
      environment: { ADDRESS_SYNC_TRANSLATION_ENABLED: 'false' }, fetchImpl: vi.fn()
    });
    expect(localizedChina.localizations.en.components).toMatchObject({ admin1: 'Hebei Province', locality: 'Tangshan City', street: 'Wenhua Road' });
    expect(localizedChina.localizations['zh-CN'].formattedAddress).toBe('中国河北省唐山市文化路30');
    expect(localizedHongKong.localizations.en.components).toMatchObject({ admin1: 'Kowloon', street: 'Ching Tak Street', buildingName: 'Lung On House' });
    expect(localizedHongKong.localizations['zh-CN'].components).toMatchObject({ admin1: '九龙', street: '正德街', buildingName: '龙安楼' });
    expect(localizedTaiwan.localizations.en.components).toMatchObject({ admin1: 'Taibei Municipality', locality: 'Zhongzheng District', street: 'Zhongxiaodong Road' });
  });

  it('allows online translation for selected countries during fast initialization', async () => {
    const record = normalizeSourceRecord({
      id: 'hk-english-only', admin1: 'HK', locality: 'EASTERN DISTRICT', postal_city: 'EASTERN DISTRICT',
      street: 'OI SHUN ROAD', number: '33', longitude: 114.225, latitude: 22.282
    }, { id: 'fixture-hk', countryCode: 'HK', source }, 'overture-jsonl');
    const dictionary = new Map([
      ['HK', '香港'], ['EASTERN DISTRICT', '东区'], ['OI SHUN ROAD', '爱信道']
    ]);
    const fetchImpl = vi.fn(async (input) => {
      const url = new URL(String(input));
      const boundary = '[[[ADDRESS_COMPONENT_BOUNDARY]]]';
      const values = url.searchParams.get('q').split(`\n${boundary}\n`);
      const translated = url.searchParams.get('tl') === 'zh-CN'
        ? values.map((value) => dictionary.get(value) || value)
        : values;
      return Response.json([[[translated.join(`\n${boundary}\n`)]]]);
    });
    const [localized] = await localizeAddressRecords([record], {
      environment: {
        ADDRESS_SYNC_TRANSLATION_ENABLED: 'false', ADDRESS_SYNC_TRANSLATION_COUNTRIES: 'HK',
        GOOGLE_TRANSLATION_ENABLED: 'true'
      },
      fetchImpl
    });
    expect(fetchImpl).toHaveBeenCalled();
    expect(localized.localizations['zh-CN'].components).toMatchObject({ admin1: '香港', locality: '东区', street: '爱信道' });
  });
});

describe('built-in ETL planning and publishing', () => {
  it('uses bounded region/locality-balanced Overture sampling and addressed OSM ways', async () => {
    const overture = (await readFile('server/sync/overture-export.py', 'utf8')).replace(/\r\n/g, '\n');
    const geofabrik = (await readFile('server/sync/geofabrik-export.py', 'utf8')).replace(/\r\n/g, '\n');
    expect(geofabrik).toContain('--communities-file');
    expect(geofabrik).toContain('landuse') && expect(geofabrik).toContain('COMMUNITY_PLACE_TYPES');
    expect(overture).toContain('candidate_limit');
    expect(overture).toContain('USING SAMPLE system(25 PERCENT)');
    expect(overture).toContain('AND bbox.xmin >= {minimum_longitude}');
    expect(overture).toContain('AND bbox.ymax <= {maximum_latitude}');
    expect(overture).toContain('--building-assets-file');
    expect(overture).toContain('--candidate-jsonl');
    expect(overture).toContain("FROM read_json_auto({sql_string(str(candidate_file))}");
    expect(overture).toContain('ST_Intersects(address_probes.geometry, residential_buildings.geometry)');
    expect(overture).toContain('residential_probe_limit = min(args.max_records, 15000)');
    expect(overture).toContain('residential_grid_limit = min(24');
    expect(overture).toContain('residential_grid_scale = 4');
    expect(overture).toContain('count(*) AS address_count');
    expect(overture).toContain('ORDER BY address_count DESC, grid_latitude, grid_longitude');
    expect(overture).toContain('building_grid_predicate = " OR ".join(');
    expect(overture).toContain('address_grid_predicate = " OR ".join(');
    expect(overture).toContain('AND ({building_grid_predicate})');
    expect(overture).toContain('WHERE {address_grid_predicate}');
    expect(overture).not.toContain('AND bbox.xmax >= {minimum_longitude}');
    expect(overture).toContain('FROM address_candidates\n  LEFT JOIN classified');
    expect(overture).toContain('Residential building classification failed; exporting address-only fallback');
    expect(overture.indexOf('WHERE country = {country}')).toBeLessThan(
      overture.indexOf('USING SAMPLE system(25 PERCENT)')
    );
    expect(overture).toContain('PARTITION BY coalesce(nullif(trim(admin1)');
    expect(overture).toContain('locality_rank');
    expect(geofabrik).toContain('def way(self, way)');
    expect(geofabrik).not.toContain('def area(self, area)');
    expect(geofabrik).toContain('osmium.FileProcessor(args.input).with_locations(location_storage).with_filter(KeyFilter(');
    expect(geofabrik).toContain('sparse_file_array,{location_index}');
    expect(geofabrik).toContain('minimum_longitude <= longitude <= maximum_longitude');
    expect(geofabrik).toContain('self.capture(');
    expect(geofabrik).toContain('self.residential_limit = min(max_records, 1000)');
    expect(geofabrik).toContain('max_records / 10');
    expect(geofabrik).toContain('self.group_limit = max(1, min(per_locality, max_records))');
    expect(geofabrik).toContain('is_residential = building in RESIDENTIAL_BUILDINGS');
    expect(geofabrik).toContain('residential_selected = sorted(');
    expect(geofabrik).toContain('residential_selected + selected');
  });

  it('atomically imports localized records, evidence and coverage into SQLite', async () => {
    const directory = resolve('.data-cache', 'sync-etl-tests', randomUUID());
    directories.push(directory);
    await mkdir(directory, { recursive: true });
    const file = resolve(directory, 'fixture.jsonl');
    await writeFile(file, `${JSON.stringify({
      id: 'overture-1', admin1: 'Pennsylvania', locality: 'Philadelphia', postal_city: 'Philadelphia',
      postcode: '19103', street: 'Market\u2028Street', number: '1700', longitude: -75.169, latitude: 39.953,
      property_type: 'residential', residential_building_id: 'building-1', residential_building_class: 'house'
    })}\n`, 'utf8');
    const database = openDatabase(':memory:');
    const importer = new SqliteAddressImporter({
      database,
      normalizeRecord: normalizeSourceRecord,
      hash: (value) => createHash('sha256').update(value).digest('hex'),
      localizeRecords: async (records) => records.map((record) => ({
        ...record,
        localizations: Object.fromEntries(['native', 'en', 'zh-CN'].map((language) => [language, {
          components: record.components,
          formattedAddress: record.formattedAddress,
          source: language === 'native' ? 'source' : 'fixture-translator'
        }]))
      }))
    });
    const result = await importer.importShard({
      shard: { id: 'fixture-us', countryCode: 'US', source },
      discovery: { version: '2026-06-17.0', publishedAt: '2026-06-17T00:00:00Z', dataUrl: source.dataUrl, sourceBytes: 1234 },
      materialized: { file, format: 'overture-jsonl', checksum: 'b'.repeat(64), cacheBytes: 321 },
      maxRecords: 10,
      perLocality: 2
    });
    expect(result).toMatchObject({ acceptedCount: 1, rejectedCount: 0, localityCount: 1, skipped: false });
    expect(await database.prepare('SELECT status,active_count FROM address_datasets WHERE id=?').bind(result.datasetId).first())
      .toMatchObject({ status: 'active', active_count: 1 });
    expect(await database.prepare('SELECT COUNT(*) AS count FROM address_pool_runtime').first('count')).toBe(1);
    expect(await database.prepare('SELECT COUNT(*) AS count FROM address_pool_evidence WHERE is_current=1').first('count')).toBe(2);
    expect(await database.prepare("SELECT source_record_id FROM address_pool_evidence WHERE evidence_type='residential_use'").first('source_record_id'))
      .toBe('building-1');
    expect(await database.prepare('SELECT COUNT(*) AS count FROM pool_coverage').first('count')).toBe(1);
    await writeFile(file, `${JSON.stringify({
      id: 'overture-2', admin1: 'Pennsylvania', locality: 'Philadelphia', postal_city: 'Philadelphia',
      postcode: '19103', street: 'Market Street', number: '1800', longitude: -75.17, latitude: 39.954
    })}\n`, 'utf8');
    const replacementSource = { ...source, id: 'replacement-source', name: 'Replacement source' };
    const replacement = await importer.importShard({
      shard: { id: 'replacement-us', countryCode: 'US', source: replacementSource },
      discovery: { version: '2026-07-17.0', publishedAt: '2026-07-17T00:00:00Z', dataUrl: replacementSource.dataUrl, sourceBytes: 1234 },
      materialized: { file, format: 'overture-jsonl', checksum: 'd'.repeat(64), cacheBytes: 321 },
      maxRecords: 10,
      perLocality: 2
    });
    expect(replacement).toMatchObject({ acceptedCount: 1, skipped: false });
    expect(await database.prepare("SELECT COUNT(*) AS count FROM address_datasets WHERE status='active'").first('count')).toBe(1);
    expect(await database.prepare("SELECT COUNT(*) AS count FROM address_datasets WHERE status='retired'").first('count')).toBe(1);
    expect(await database.prepare("SELECT source_id FROM address_datasets WHERE status='active'").first('source_id')).toBe('replacement-source');
    expect(await database.prepare('SELECT COUNT(*) AS count FROM address_pool_runtime').first('count')).toBe(1);
    database.close();
  });

  it('rejects a sharply degraded candidate snapshot and preserves the active pool', async () => {
    const directory = resolve('.data-cache', 'sync-etl-tests', randomUUID());
    directories.push(directory);
    await mkdir(directory, { recursive: true });
    const file = resolve(directory, 'quality.jsonl');
    const database = openDatabase(':memory:');
    const importer = new SqliteAddressImporter({
      database, normalizeRecord: normalizeSourceRecord,
      hash: (value) => createHash('sha256').update(value).digest('hex'),
      localizeRecords: async (records) => records.map((record) => ({
        ...record,
        localizations: Object.fromEntries(['native', 'en', 'zh-CN'].map((language) => [language, {
          components: record.components, formattedAddress: record.formattedAddress, source: 'fixture'
        }]))
      }))
    });
    const rows = [
      ['1', 'Pennsylvania', 'Philadelphia'], ['2', 'Pennsylvania', 'Pittsburgh'],
      ['3', 'New York', 'New York'], ['4', 'New York', 'Buffalo']
    ].map(([id, admin1, locality]) => ({
      id, admin1, locality, postal_city: locality, street: 'Main Street', number: id,
      longitude: -75 + Number(id) / 100, latitude: 40 + Number(id) / 100
    }));
    await writeFile(file, `${rows.map(JSON.stringify).join('\n')}\n`, 'utf8');
    const shard = { id: 'quality-us', countryCode: 'US', source, qualityGate: {
      minimumRecords: 2, minimumAdmin1: 2, minimumCountRatio: 0.75, minimumAdmin1Ratio: 0.75
    } };
    const first = await importer.importShard({
      shard, discovery: { version: 'v1', dataUrl: source.dataUrl },
      materialized: { file, format: 'overture-jsonl', checksum: '1'.repeat(64) }, maxRecords: 10, perLocality: 10
    });
    await writeFile(file, `${JSON.stringify(rows[0])}\n`, 'utf8');
    await expect(importer.importShard({
      shard, discovery: { version: 'v2', dataUrl: source.dataUrl },
      materialized: { file, format: 'overture-jsonl', checksum: '2'.repeat(64) }, maxRecords: 10, perLocality: 10
    })).rejects.toMatchObject({ code: 'SNAPSHOT_QUALITY_FAILED' });
    expect(await database.prepare("SELECT id FROM address_datasets WHERE status='active'").first('id')).toBe(first.datasetId);
    expect(await database.prepare('SELECT COUNT(*) count FROM address_pool_runtime').first('count')).toBe(4);
    database.close();
  });

  it('uses ADDRESS_DATABASE_PATH-compatible SQLite storage by default', async () => {
    const directory = resolve('.data-cache', 'sync-etl-tests', randomUUID());
    directories.push(directory);
    await mkdir(directory, { recursive: true });
    const file = resolve(directory, 'fixture.jsonl');
    const databasePath = resolve(directory, 'address.sqlite');
    await writeFile(file, `${JSON.stringify({
      id: 'overture-default', admin1: 'Pennsylvania', locality: 'Philadelphia', postal_city: 'Philadelphia',
      postcode: '19103', street: 'Market Street', number: '1700', longitude: -75.169, latitude: 39.953
    })}\n`, 'utf8');
    const localizeRecords = async (records) => records.map((record) => ({
      ...record,
      localizations: Object.fromEntries(['native', 'en', 'zh-CN'].map((language) => [language, {
        components: record.components,
        formattedAddress: record.formattedAddress,
        source: language === 'native' ? 'source' : 'fixture-translator'
      }]))
    }));
    const result = await runAddressEtl({
      databasePath,
      cacheDir: resolve(directory, 'cache'),
      dataRoot: directory,
      catalog: { schemaVersion: 1, shards: [{ id: 'fixture-us', countryCode: 'US', intervalDays: 30, source }] },
      syncMode: 'manual',
      maxRecords: 10,
      perLocality: 2,
      localizeRecords,
      adapters: {
        discover: async () => ({ adapter: 'overture', version: 'fixture', dataUrl: source.dataUrl, sourceBytes: 0 }),
        materialize: async () => ({ file, format: 'overture-jsonl', checksum: 'c'.repeat(64), cacheBytes: 1 })
      }
    });
    expect(result).toMatchObject({ changed: true, selectedShards: ['fixture-us'] });
    const database = openDatabase(databasePath, { readOnly: true });
    expect(await database.prepare('SELECT COUNT(*) AS count FROM address_pool_runtime').first('count')).toBe(1);
    expect(await database.prepare('SELECT status FROM sync_country_state WHERE country_code=?').bind('US').first('status')).toBe('ready');
    database.close();
  });

  it('supports a single-shard dry run without opening SQLite or changing cache state', async () => {
    const cacheDir = resolve('.data-cache', 'sync-etl-tests', randomUUID());
    directories.push(cacheDir);
    const catalog = { schemaVersion: 1, shards: [{ id: 'fixture-us', countryCode: 'US', intervalDays: 30, source }] };
    const result = await runAddressEtl({
      cacheDir,
      catalog,
      requestedShards: ['US'],
      dryRun: true,
      now: () => new Date('2026-07-16T00:00:00.000Z'),
      adapters: {
        discover: async () => ({ adapter: 'overture', version: '2026-06-17.0', publishedAt: '2026-06-17T00:00:00Z', dataUrl: source.dataUrl, sourceBytes: 1234, estimateMethod: 'fixture' })
      }
    });
    expect(result).toMatchObject({ dryRun: true, changed: false, selectedShards: ['fixture-us'] });
    expect(result.reports[0]).toMatchObject({ intervalDays: 30, sourceVersion: '2026-06-17.0', sourceBytes: 1234, status: 'planned' });
  });

  it('selects only one due country for an automatic daily run', async () => {
    const cacheDir = resolve('.data-cache', 'sync-etl-tests', randomUUID());
    directories.push(cacheDir);
    const catalog = { schemaVersion: 1, shards: [
      { id: 'fixture-us', countryCode: 'US', intervalDays: 30, source },
      { id: 'fixture-ca', countryCode: 'CA', intervalDays: 30, source }
    ] };
    const result = await runAddressEtl({
      cacheDir,
      catalog,
      dryRun: true,
      maxShardsPerRun: 1,
      adapters: { discover: async () => ({ adapter: 'overture', version: '2026-06-17.0', sourceBytes: 100, estimateMethod: 'fixture' }) }
    });
    expect(result.selectedShards).toHaveLength(1);
    expect(result.reports.filter(({ status }) => status === 'planned')).toHaveLength(1);
    expect(result.reports.filter(({ status }) => status === 'deferred')).toHaveLength(1);
  });

  it('persists incremental shard metadata and skips a shard inside its interval', async () => {
    const cacheDir = resolve('.data-cache', 'sync-etl-tests', randomUUID());
    directories.push(cacheDir);
    const catalog = { schemaVersion: 1, shards: [{ id: 'fixture-us', countryCode: 'US', intervalDays: 30, source }] };
    let discoveries = 0;
    const adapters = {
      discover: async () => {
        discoveries += 1;
        return { adapter: 'overture', version: '2026-06-17.0', publishedAt: '2026-06-17T00:00:00Z', dataUrl: source.dataUrl, sourceBytes: 1234, estimateMethod: 'fixture' };
      },
      materialize: async () => ({
        file: resolve(cacheDir, 'normalized', 'fixture.jsonl'), format: 'overture-jsonl',
        cacheBytes: 321, checksum: 'a'.repeat(64), cacheHit: false
      })
    };
    const importer = { importShard: async () => ({ datasetId: 'fixture-dataset', acceptedCount: 10, rejectedCount: 1, localityCount: 2, skipped: false }) };
    await runAddressEtl({ cacheDir, catalog, adapters, importer, now: () => new Date('2026-07-16T00:00:00Z') });
    const second = await runAddressEtl({ cacheDir, catalog, adapters, importer, now: () => new Date('2026-07-17T00:00:00Z') });
    const manifest = JSON.parse(await readFile(resolve(cacheDir, 'manifest.json'), 'utf8'));
    expect(discoveries).toBe(1);
    expect(second.reports[0].status).toBe('not-due');
    expect(manifest.shards['fixture-us']).toMatchObject({
      intervalDays: 30,
      lastChecked: '2026-07-16T00:00:00.000Z',
      sourceVersion: '2026-06-17.0',
      sourceBytes: 1234,
      checksumSha256: 'a'.repeat(64),
      cacheBytes: 321
    });
  });

  it('keeps initial synchronization incomplete until residential evidence exists', async () => {
    const cacheDir = resolve('.data-cache', 'sync-etl-tests', randomUUID());
    directories.push(cacheDir);
    const catalog = { schemaVersion: 1, shards: [{ id: 'fixture-us', countryCode: 'US', intervalDays: 30, source }] };
    let imports = 0;
    const adapters = {
      discover: async () => ({
        adapter: 'overture', version: '2026-06-17.0', publishedAt: '2026-06-17T00:00:00Z',
        dataUrl: source.dataUrl, sourceBytes: 1234, estimateMethod: 'fixture'
      }),
      materialize: async () => ({
        file: resolve(cacheDir, 'normalized', 'fixture.jsonl'), format: 'overture-jsonl',
        cacheBytes: 321, checksum: 'b'.repeat(64), cacheHit: imports > 0
      })
    };
    const importer = {
      importShard: async () => {
        imports += 1;
        return {
          datasetId: `fixture-dataset-${imports}`, acceptedCount: 10, rejectedCount: 0,
          localityCount: 2, residentialCount: imports === 1 ? 0 : 3, skipped: false
        };
      }
    };

    await expect(runAddressEtl({ cacheDir, catalog, adapters, importer, syncMode: 'initial', requireResidential: true }))
      .rejects.toThrow('Initial residential sync incomplete for: US');
    await expect(runAddressEtl({ cacheDir, catalog, adapters, importer, syncMode: 'initial', requireResidential: true }))
      .resolves.toMatchObject({ selectedShards: ['fixture-us'] });
    expect(imports).toBe(2);
  });

  it('continues an estimate after one shard metadata failure', async () => {
    const cacheDir = resolve('.data-cache', 'sync-etl-tests', randomUUID());
    directories.push(cacheDir);
    const catalog = {
      schemaVersion: 1,
      shards: [
        { id: 'fixture-us', countryCode: 'US', intervalDays: 30, source },
        { id: 'fixture-ca', countryCode: 'CA', intervalDays: 30, source }
      ]
    };
    const adapters = {
      discover: async (shard) => {
        if (shard.countryCode === 'US') throw Object.assign(new Error('metadata failed'), { code: 'SOURCE_METADATA_HTTP', url: 'https://example.test/us', status: 503 });
        return { adapter: 'overture', version: '2026-06-17.0', sourceBytes: 100, estimateMethod: 'fixture' };
      }
    };
    const result = await runAddressEtl({ cacheDir, catalog, adapters, estimate: true });
    expect(result.reports).toEqual([
      expect.objectContaining({ countryCode: 'US', status: 'failed', errorCode: 'SOURCE_METADATA_HTTP', errorStatus: 503 }),
      expect.objectContaining({ countryCode: 'CA', status: 'planned', sourceVersion: '2026-06-17.0' })
    ]);
  });

  it('publishes through the SQLite ETL transaction without an external release phase', async () => {
    const result = await runAddressSync({
      releaseId: 'release-built-in',
      environment: {},
      runEtl: async () => ({ changed: true, dryRun: false, requiredCountries: ['US'] })
    });
    expect(result).toMatchObject({ releaseId: 'release-built-in', changed: true });
  });

  it('returns independently imported country targets from the SQLite ETL result', async () => {
    const result = await runAddressSync({
      releaseId: 'release-shards',
      environment: {},
      runEtl: async () => ({
        changed: true,
        dryRun: false,
        requiredCountries: ['CA', 'US'],
        releaseTargets: [
          { shardKey: 'fixture-us', sourceId: 'fixture', countryCode: 'US' },
          { shardKey: 'fixture-ca', sourceId: 'fixture', countryCode: 'CA' }
        ]
      })
    });
    expect(result.etl.releaseTargets).toHaveLength(2);
  });

  it('forces a manually selected country to check upstream immediately', async () => {
    let options;
    await runAddressSync({
      releaseId: 'release-manual',
      environment: { ADDRESS_SYNC_TRIGGER: 'manual' },
      runEtl: async (value) => { options = value; return { changed: false, dryRun: false, requiredCountries: ['US'] }; }
    });
    expect(options.force).toBe(true);
    expect(options.maxShardsPerRun).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('reports unchanged without invoking another publication system', async () => {
    const result = await runAddressSync({
      releaseId: 'release-unchanged',
      environment: {},
      runEtl: async () => ({ changed: false, dryRun: false, requiredCountries: ['US'] })
    });
    expect(result.changed).toBe(false);
  });
});
