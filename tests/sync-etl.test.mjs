import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { strToU8, zipSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { localizeAddressRecords, normalizeSourceRecord, runAddressEtl } from '../server/sync/address-etl.mjs';
import { openTestDatabase } from './helpers/postgres-test-database.mjs';
import { PostgresAddressImporter } from '../server/sync/postgres-address-importer.mjs';
import { reconcilePublishedPool, validatePublishedPoolBatch } from '../server/database/published-pool.mjs';
import {
  canonicalizeHtmlText, countryBoundBoxes, countryBounds, createSourceAdapters, loadSourceCatalog, normalizedCachePolicyIdentity,
  overtureBoundsArgs, parseGeofabrikMd5, sourceAdapterRevisions, sourceSizeMatches, stableHtmlFingerprint
} from '../server/sync/source-adapters.mjs';
import { runAddressSync } from '../server/sync/run-address-sync.mjs';
import { runProcess } from '../server/sync/process.mjs';
import { createSyncArtifactCleanup } from '../server/sync/artifact-cleanup.mjs';
import { evaluateMapplsResidentialResult, requestMapplsReverse } from '../server/sync/mappls-residential-enrichment.mjs';

const execFileAsync = promisify(execFile);
const directories = [];
afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('synchronization process diagnostics', () => {
  it('passes every multi-region country bounding box to the Overture exporter', () => {
    const france = countryBoundBoxes({ countryCode: 'FR' });
    expect(france.length).toBeGreaterThan(1);
    expect(countryBounds.FR).toEqual([
      Math.min(...france.map((box) => box[0])),
      Math.min(...france.map((box) => box[1])),
      Math.max(...france.map((box) => box[2])),
      Math.max(...france.map((box) => box[3]))
    ]);
    const args = overtureBoundsArgs(france);
    expect(args.slice(0, 5)).toEqual(['--bounds', ...france[0].map(String)]);
    expect(args.filter((value) => value === '--bounds-extra')).toHaveLength(france.length - 1);
    const explicit = countryBoundBoxes({ countryCode: 'FR', bounds: [1, 2, 3, 4] });
    expect(explicit).toEqual([[1, 2, 3, 4]]);
  });

  it('captures bounded stderr when a child process fails', async () => {
    const failure = await runProcess({
      file: process.execPath,
      args: ['-e', "process.stderr.write('fixture failure detail\\n'); process.exit(3)"]
    }).catch((error) => error);
    expect(failure).toMatchObject({ code: 'SYNC_PROCESS_FAILED', stderr: 'fixture failure detail' });
    expect(failure.message).toContain('fixture failure detail');
  });

  it('does not report a timeout until the child process has closed', async () => {
    const child = new EventEmitter();
    child.pid = undefined;
    child.stderr = null;
    child.kill = vi.fn(() => true);
    let settled = false;
    const result = runProcess({
      file: 'fixture-child',
      timeoutMs: 1_000,
      terminationGraceMs: 20,
      spawnImpl: () => child
    }).catch((error) => error).finally(() => { settled = true; });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_050));
    expect(settled).toBe(false);
    child.emit('close', null, 'SIGKILL');
    await expect(result).resolves.toMatchObject({ code: 'SYNC_PROCESS_TIMEOUT' });
  });

  it('cancels a materialization waiting for a process slot', async () => {
    const cacheDir = resolve('.data-cache', `process-slot-cancel-${process.pid}-${Date.now()}`);
    directories.push(cacheDir);
    const controller = new AbortController();
    let startedResolve;
    const started = new Promise((resolve) => { startedResolve = resolve; });
    let releaseFirst;
    const firstRelease = new Promise((resolve) => { releaseFirst = resolve; });
    let executions = 0;
    const execute = async ({ args }) => {
      executions += 1;
      if (executions === 1) { startedResolve(); await firstRelease; }
      await writeFile(args[args.indexOf('--output') + 1], '{}\n', 'utf8');
    };
    const adapters = createSourceAdapters({ processConcurrency: 1, signal: controller.signal, execute, pythonBin: 'python-fixture' });
    const discovery = {
      adapter: 'overture', version: '2026-09-01.1', dataUrl: 'https://example.test/catalog',
      assets: [], buildingAssets: [], buildingAssetEntries: []
    };
    const options = { cacheDir, maxBytes: 1024, maxRecords: 1, perLocality: 1, retainRaw: false };
    const first = adapters.materialize({ id: 'slot-first', countryCode: 'NL', source: {} }, discovery, options);
    await started;
    const second = adapters.materialize({ id: 'slot-second', countryCode: 'NL', source: {} }, discovery, options);
    const reason = Object.assign(new Error('fixture cancellation'), { code: 'SYNC_JOB_TIMEOUT' });
    controller.abort(reason);
    releaseFirst();
    await expect(second).rejects.toMatchObject({ code: 'SYNC_JOB_TIMEOUT' });
    await first;
  });
});

describe('PostgreSQL publication query shape', () => {
  it('limits import finalization to the addresses the import touched', async () => {
    const source = await readFile(new URL('../server/sync/postgres-address-importer.mjs', import.meta.url), 'utf8');
    expect(source).not.toMatch(/active=1 AND id NOT IN/u);
    expect(source).not.toMatch(/active=0\s+AND id NOT IN/u);
    expect(source.match(/LEFT JOIN[\s\S]+?\.address_id IS NULL/gu)).toHaveLength(1);
    expect(source).not.toContain('WHERE address.country_code=? AND candidate.is_current=1');
    expect(source).toContain('WHERE target.id IN (${placeholders(ids)}) AND target.active=0');
  });

  it('reactivates current evidence and retires rows that fail the publication gate', async () => {
    const source = await readFile(new URL('../server/database/published-pool.mjs', import.meta.url), 'utf8');
    expect(source).toContain('ORDER BY dataset.country_code');
    expect(source).not.toContain('WHERE address.active=0 ORDER BY dataset.country_code');
    expect(source).toContain("evidence.is_current=1 AND evidence.evidence_type='address_existence'");
    expect(source).toContain('storedAddressPoolV2RowIsPublishable');
    expect(source).toContain('SET active=0,retired_at=?');
    expect(source).toContain('WHERE id IN');
  });
});

const source = {
  id: 'fixture', adapter: 'overture', name: 'Fixture', homepageUrl: 'https://example.test',
  dataUrl: 'https://example.test/data', licenseCode: 'CC0-1.0', licenseName: 'CC0',
  licenseUrl: 'https://example.test/license', attributionText: 'Fixture',
  attributionUrl: 'https://example.test', termsUrl: 'https://example.test/terms',
  shareAlike: false, redistributionAllowed: true, updateCadence: 'monthly'
};

describe('address source shard catalog', () => {
  it('expands independently supported country shards with explicit refresh intervals', async () => {
    const catalog = await loadSourceCatalog();
    expect(catalog.shards).toHaveLength(237);
    expect(catalog.shards.filter((shard) => shard.id !== 'korea-kapt-residential')
      .every((shard) => shard.intervalDays === 30)).toBe(true);
    expect(catalog.shards.some((shard) => shard.countryCode === 'CN')).toBe(false);
    expect(catalog.shards.filter((shard) => shard.countryCode === 'NG').map((shard) => shard.source.adapter).sort())
      .toEqual(['geofabrik', 'google-residential-enrichment']);
    expect(catalog.shards.filter((shard) => shard.countryCode === 'IT')).toHaveLength(2);
    // Australia adds one Overture shard per state so no single import holds the whole country in memory.
    const australia = catalog.shards.filter((shard) => shard.countryCode === 'AU');
    expect(australia).toHaveLength(10);
    expect(australia.filter((shard) => shard.admin1).map((shard) => shard.admin1).sort())
      .toEqual(['ACT', 'NSW', 'NT', 'QLD', 'SA', 'TAS', 'VIC', 'WA']);
    expect(australia.reduce((total, shard) => total + (shard.maxRecords || 0), 0)).toBe(1_980_000);
    expect(catalog.shards.find((shard) => shard.id === 'geofabrik-osm-gb-england').maxRecords).toBe(600_000);
    expect(catalog.shards.filter((shard) => shard.source.adapter === 'overture' && ['BR', 'SG'].includes(shard.countryCode))).toHaveLength(2);
    expect(catalog.shards.filter((shard) => shard.countryCode === 'ES')).toHaveLength(5);
    expect(catalog.shards.filter((shard) => shard.countryCode === 'CA')).toHaveLength(15);
    expect(catalog.shards.filter((shard) => shard.countryCode === 'FR')).toHaveLength(32);
    expect(catalog.shards.filter((shard) => [
      'france-bdnb-gironde-residential', 'france-bdnb-rhone-residential', 'france-bdnb-paris-residential'
    ].includes(shard.id))).toHaveLength(3);
    expect(catalog.shards.filter((shard) => shard.countryCode === 'NL')).toHaveLength(2);
    expect(catalog.shards.filter((shard) => shard.countryCode === 'HK')).toHaveLength(2);
    expect(catalog.shards.some((shard) => shard.id === 'overture-addresses-hk')).toBe(false);
    expect(catalog.shards.filter((shard) => shard.countryCode === 'TW')).toHaveLength(3);
    expect(catalog.shards.filter((shard) => shard.countryCode === 'MX')).toHaveLength(3);
    expect(catalog.shards.filter((shard) => shard.countryCode === 'SA')).toHaveLength(2);
    expect(catalog.shards.filter((shard) => shard.countryCode === 'TH')).toHaveLength(3);
    expect(catalog.shards.find((shard) => shard.id === 'google-residential-enrichment-ng')).toMatchObject({
      countryCode: 'NG', maxRecords: 10000, quotaProvider: 'google-geocoding',
      source: {
        adapter: 'google-residential-enrichment', maxRequestsPerRun: 1000,
        pilotRequests: 50, minimumPilotAccepted: 1
      }
    });
    expect(catalog.shards.filter((shard) => shard.countryCode === 'JP')).toHaveLength(1);
    expect(catalog.shards.find((shard) => shard.id === 'japan-abr-residential')).toMatchObject({
      countryCode: 'JP', extractId: 'japan', maxRecords: 200000,
      source: {
        adapter: 'japan-abr', postalDataUrl: expect.stringContaining('utf_ken_all.zip'),
        useOsmSupplement: true,
        plateauBundles: expect.arrayContaining([expect.objectContaining({ cityCode: '13113', bytes: 42731104 })])
      }
    });
    expect(catalog.shards.find((shard) => shard.id === 'japan-abr-residential').source.plateauBundles).toHaveLength(29);
    expect(catalog.shards.find((shard) => shard.id === 'singapore-hdb-residential')).toMatchObject({
      countryCode: 'SG', maxRecords: 12000,
      source: {
        adapter: 'singapore-hdb',
        propertyDatasetId: 'd_17f5382f26140b1fdae0ba2ef6239d2f',
        buildingDatasetId: 'd_16b157c52ed637edd6ba1232e026258d'
      }
    });
    expect(catalog.shards.find((shard) => shard.id === 'korea-kapt-residential')).toMatchObject({
      countryCode: 'KR', maxRecords: 20000, intervalDays: 1, quotaProvider: 'geoapify',
      source: { adapter: 'korea-kapt', quotaProvider: 'geoapify' }
    });
    expect(catalog.shards.find((shard) => shard.id === 'ethekwini-za-residential')).toMatchObject({
      countryCode: 'ZA', maxRecords: 50000,
      source: {
        adapter: 'ethekwini-residential',
        postalDataUrl: 'https://www.postoffice.co.za/Questions/postalcodes.txt'
      }
    });
    expect(catalog.shards.find((shard) => shard.id === 'cape-town-za-residential')).toMatchObject({
      countryCode: 'ZA', maxRecords: 50000,
      source: {
        adapter: 'cape-town-residential',
        parcelUrl: expect.stringContaining('Property/FeatureServer/0'),
        postalDataUrl: 'https://www.postoffice.co.za/Questions/postalcodes.txt'
      }
    });
    expect(catalog.shards.find((shard) => shard.id === 'thailand-dpt-residential')).toMatchObject({
      countryCode: 'TH', maxRecords: 100000,
      source: {
        adapter: 'thailand-dpt-residential',
        dataUrl: expect.stringContaining('dptc_bldg/MapServer/2')
      }
    });
    expect(catalog.shards.find((shard) => shard.id === 'canada-statcan-nar-residential')).toMatchObject({
      countryCode: 'CA', maxRecords: 300000,
      source: {
        adapter: 'canada-nar-residential', release: '202606',
        dataUrl: expect.stringContaining('/202606.zip')
      }
    });
    expect(catalog.shards.find((shard) => shard.id === 'taiwan-official-residential')).toMatchObject({
      countryCode: 'TW', maxRecords: 100000,
      source: {
        adapter: 'taiwan-residential', archives: [
          { sourceVersion: '115S2', archiveCacheName: 'tw-molit-lvr-115S2.zip' },
          { sourceVersion: '115S1', archiveCacheName: 'tw-molit-lvr-115S1.zip' }
        ],
        openAddressesDataUrl: expect.stringContaining('openaddr-collected-asia.zip'),
        postcodeCacheName: 'taiwan-postcode-cache.jsonl', postcodeConcurrency: 6
      }
    });
    expect(catalog.shards.find((shard) => shard.id === 'inegi-mx-residential')).toMatchObject({
      countryCode: 'MX', maxRecords: 100000,
      source: {
        adapter: 'inegi-residential', normalizedArchiveMember: 'produto_final.csv',
        sha256: 'd0b51cdba97f9c04eb7e8e4c17695770d66730b895308543781729851e0bd67e'
      }
    });
    expect(catalog.shards.some((shard) => shard.id === 'openaddresses-sa-national')).toBe(false);
    expect(catalog.shards.find((shard) => shard.id === 'openaddresses-kr-juso')).toMatchObject({
      countryCode: 'KR', maxRecords: 100000,
      source: { adapter: 'openaddresses-archive', archiveMembers: expect.arrayContaining([
        'kr/11/provincewide.csv', 'kr/50/provincewide.csv'
      ]) }
    });
    expect(catalog.shards.find((shard) => shard.id === 'openaddresses-kr-juso').source.archiveMembers)
      .toHaveLength(17);
    expect(catalog.shards.find((shard) => shard.id === 'hong-kong-official-residential'))
      .toMatchObject({ countryCode: 'HK', maxRecords: 100000 });
    expect(catalog.shards.find((shard) => shard.id === 'taiwan-official-residential'))
      .toMatchObject({
        countryCode: 'TW', maxRecords: 100000,
        source: { dataUrl: 'https://plvr.land.moi.gov.tw/DownloadSeason?season=115S2&type=zip&fileName=lvr_landcsv.zip' }
      });
    expect(catalog.shards.find((shard) => shard.id === 'geofabrik-osm-au')).toMatchObject({
      countryCode: 'AU', extractId: 'australia'
    });
    expect(catalog.shards.find((shard) => shard.id === 'geofabrik-osm-ca-ontario')).toMatchObject({
      countryCode: 'CA', extractId: 'ontario', priority: 1, maxRecords: 150000, source: { id: 'geofabrik-osm-ca-ontario' }
    });
    expect(catalog.shards.filter((shard) => shard.source.id.startsWith('geofabrik-osm-ca-'))).toHaveLength(13);
    expect(catalog.shards.filter((shard) => shard.source.id.startsWith('geofabrik-osm-ru-'))).toHaveLength(9);
    expect(catalog.shards.find((shard) => shard.id === 'geofabrik-osm-gb-northern-ireland')).toMatchObject({
      countryCode: 'GB', extractId: 'ireland-and-northern-ireland', boundaryIso3: 'GBR'
    });
    expect(catalog.shards.some((shard) => ['geofabrik-osm-gb', 'geofabrik-osm-ru', 'geofabrik-osm-ca'].includes(shard.id))).toBe(false);
    expect(catalog.shards.find((shard) => shard.id === 'geofabrik-osm-es')).toMatchObject({
      countryCode: 'ES', extractId: 'spain'
    });
    expect(catalog.shards.filter((shard) => shard.countryCode === 'US')).toHaveLength(105);
    expect(catalog.shards.filter((shard) => shard.countryCode === 'DE')).toHaveLength(17);
    expect(catalog.shards.filter((shard) => shard.countryCode === 'FR')).toHaveLength(32);
    expect(catalog.shards.find((shard) => shard.id === 'geofabrik-osm-us-ca')).toMatchObject({
      extractId: 'us/california', maxRecords: 50000,
      source: { id: 'geofabrik-osm-us-ca' }
    });
    expect(catalog.shards.find((shard) => shard.id === 'geofabrik-osm-de-hb')).toMatchObject({
      extractId: 'bremen', maxRecords: 50000, source: { id: 'geofabrik-osm-de-hb' }
    });
    expect(catalog.shards.find((shard) => shard.id === 'geofabrik-osm-fr-corse')).toMatchObject({
      extractId: 'corse', maxRecords: 50000,
      qualityGate: expect.objectContaining({ minimumRecords: 10, minimumAdmin1: 0 })
    });
    expect(catalog.shards.find((shard) => shard.countryCode === 'MY')).toMatchObject({ extractId: 'malaysia-singapore-brunei', boundaryIso3: 'MYS' });
    expect(catalog.shards.find((shard) => shard.id === 'geofabrik-osm-sa')).toMatchObject({ extractId: 'gcc-states', boundaryIso3: 'SAU' });
    expect(catalog.shards.find((shard) => shard.id === 'geofabrik-osm-ph')).toMatchObject({
      countryCode: 'PH', extractId: 'philippines',
      postcodeDataUrl: 'https://phlpost.gov.ph/zip-code-locator/',
      postcodeMetadataUrl: expect.stringContaining('/wp-sitemap-posts-page-1.xml'),
      postcodeMetadataFormat: 'sitemap',
      postcodeMetadataMatchUrl: 'https://phlpost.gov.ph/zip-code-locator/'
    });
    expect(catalog.shards.find((shard) => shard.id === 'geofabrik-osm-vn')).toMatchObject({
      countryCode: 'VN', extractId: 'vietnam', postcodeDataFormat: 'pdf',
      postcodeDataUrl: expect.stringContaining('danh-muc-ma-buu-chinh-quoc-gia')
    });
  });

  it('keeps licensed sources disabled until their explicit activation flags are set', async () => {
    const base = await loadSourceCatalog(undefined, {});
    expect(base.shards.some((shard) => shard.id === 'mappls-in-residential')).toBe(false);
    expect(base.shards.some((shard) => shard.id === 'openaddresses-sa-national')).toBe(false);
    const enabled = await loadSourceCatalog(undefined, {
      ADDRESS_SYNC_MAPPLS_ENABLED: 'true'
    });
    expect(enabled.shards.find((shard) => shard.id === 'mappls-in-residential'))
      .toMatchObject({ countryCode: 'IN', extractId: 'india', boundaryIso3: 'IND', quotaProvider: 'mappls' });
    expect(enabled.shards.find((shard) => shard.id === 'mappls-in-residential')?.source.redistributionAllowed)
      .toBe(false);
    const saEnabled = await loadSourceCatalog(undefined, {
      ADDRESS_SYNC_SA_OPENADDRESSES_ENABLED: 'true'
    });
    expect(saEnabled.shards.find((shard) => shard.id === 'openaddresses-sa-national'))
      .toMatchObject({ countryCode: 'SA', source: { redistributionAllowed: false } });
    const licensed = await loadSourceCatalog(undefined, {
      ADDRESS_SYNC_MAPPLS_ENABLED: 'true', ADDRESS_SYNC_MAPPLS_REDISTRIBUTION_ALLOWED: 'true'
    });
    expect(licensed.shards.find((shard) => shard.id === 'mappls-in-residential')?.source.redistributionAllowed)
      .toBe(true);
    const saLicensed = await loadSourceCatalog(undefined, {
      ADDRESS_SYNC_SA_OPENADDRESSES_ENABLED: 'true',
      ADDRESS_SYNC_SA_OPENADDRESSES_LICENSE_CONFIRMED: 'true',
      ADDRESS_SYNC_SA_OPENADDRESSES_REDISTRIBUTION_ALLOWED: 'true'
    });
    expect(saLicensed.shards.find((shard) => shard.id === 'openaddresses-sa-national')?.source.redistributionAllowed)
      .toBe(true);
  });

  it('combines an OSM residential source address with Mappls administrative fields', () => {
    const seed = {
      building_id: 'way/42', building_class: 'house', number: '18', street: 'MG Road',
      latitude: 28.632, longitude: 77.219,
      ring: [[77.2189, 28.6319], [77.2191, 28.6319], [77.2191, 28.6321], [77.2189, 28.6321], [77.2189, 28.6319]]
    };
    const result = evaluateMapplsResidentialResult({
      responseCode: 200, version: 'fixture-v1', results: [{
        area: 'India', district: 'Central Delhi', city: 'New Delhi', state: 'Delhi',
        pincode: '110001', lat: '28.632', lng: '77.219'
      }]
    }, seed);
    expect(result.record).toMatchObject({
      source_record_id: 'way/42:fixture-v1', number: '18', street: 'MG Road',
      district: 'Central Delhi', locality: 'New Delhi', admin1: 'Delhi', postcode: '110001',
      property_type: 'residential'
    });
  });

  it('rotates Mappls credentials while using only Reverse Geocoding', async () => {
    const credentials = [
      { id: 'quota', secret: 'quota-key' },
      { id: 'working', secret: 'working-key' }
    ];
    const reports = [];
    const requested = [];
    const payload = await requestMapplsReverse({
      latitude: 28.632,
      longitude: 77.219,
      credentialPool: {
        acquire: async (_provider, { excludeIds }) => credentials.find(({ id }) => !excludeIds.has(id)) || null,
        report: async (...values) => reports.push(values)
      },
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        requested.push(url);
        return url.searchParams.get('access_token') === 'quota-key'
          ? new Response(null, { status: 429 })
          : Response.json({ responseCode: 200, results: [] });
      }
    });
    expect(payload).toEqual({ responseCode: 200, results: [] });
    expect(reports.map(([, outcome]) => outcome)).toEqual(['quota', 'success']);
    expect(requested.map(({ pathname }) => pathname)).toEqual([
      '/search/address/rev-geocode', '/search/address/rev-geocode'
    ]);
  });

  it('rounds the PDOK page size up so 400 seeds can satisfy a 50000-record target', async () => {
    const cacheDir = resolve('.data-cache', `pdok-capacity-${process.pid}-${Date.now()}`);
    directories.push(cacheDir);
    const requested = [];
    const adapters = createSourceAdapters({
      fetchImpl: async (input) => {
        requested.push(new URL(String(input)));
        throw new Error('stop after observing the requested page size');
      },
      environment: { PDOK_BAG_MAX_PAGES_PER_SEED: '2' },
      loadSeedLocations: async () => Array.from({ length: 400 }, (_, index) => ({
        latitude: 50.4 + Math.floor(index / 20) * 0.1,
        longitude: 3.2 + (index % 20) * 0.15
      }))
    });
    const shard = {
      id: 'pdok-bag-nl', countryCode: 'NL',
      source: { id: 'pdok-bag-nl', adapter: 'pdok-bag', name: 'PDOK BAG fixture' },
      qualityGate: { minimumRecords: 50_000 }
    };
    await expect(adapters.materialize(shard, {
      adapter: 'pdok-bag', version: 'fixture-v1', dataUrl: 'https://api.example.test/items'
    }, { cacheDir, maxBytes: 10_000_000, maxRecords: 50_000, perLocality: 10, retainRaw: false }))
      .rejects.toThrow('Source metadata request failed');
    expect(requested[0].searchParams.get('limit')).toBe('63');
  });

  it('rejects a PDOK checkpoint whose accepted candidates disappeared', async () => {
    const cacheDir = resolve('.data-cache', `pdok-state-invalid-${process.pid}-${Date.now()}`);
    directories.push(cacheDir);
    const rawRoot = resolve(cacheDir, 'raw');
    await mkdir(rawRoot, { recursive: true });
    const identity = normalizedCachePolicyIdentity(1, 1);
    const checkpoint = resolve(rawRoot, `pdok-bag-nl-fixture-v1-${identity}-checkpoint.json`);
    await writeFile(checkpoint, JSON.stringify({
      version: 'fixture-v1', round: 0, seedIndex: 0, nextBySeed: {}, complete: false, acceptedCount: 1
    }), 'utf8');
    let requests = 0;
    const adapters = createSourceAdapters({
      fetchImpl: async () => { requests += 1; return Response.json({ type: 'FeatureCollection', features: [] }); },
      loadSeedLocations: async () => [{ latitude: 52.1, longitude: 5.1 }]
    });
    const shard = {
      id: 'pdok-bag-nl', countryCode: 'NL',
      source: { id: 'pdok-bag-nl', adapter: 'pdok-bag', name: 'PDOK BAG fixture' },
      qualityGate: { minimumRecords: 1 }
    };
    await expect(adapters.materialize(shard, {
      adapter: 'pdok-bag', version: 'fixture-v1', dataUrl: 'https://api.example.test/items'
    }, { cacheDir, maxBytes: 10_000_000, maxRecords: 1, perLocality: 1, retainRaw: false }))
      .rejects.toMatchObject({ code: 'SOURCE_STATE_INVALID' });
    expect(requests).toBe(0);
  });

  it('does not treat an empty normalized source output as a cache hit', async () => {
    const cacheDir = resolve('.data-cache', `empty-output-cache-${process.pid}-${Date.now()}`);
    directories.push(cacheDir);
    let materializations = 0;
    const adapters = createSourceAdapters({
      execute: async ({ args }) => {
        materializations += 1;
        await writeFile(args[args.indexOf('--output') + 1], '{"id":"fixture"}\n', 'utf8');
      },
      pythonBin: 'python-fixture'
    });
    const shard = { id: 'empty-output', countryCode: 'US', source: {} };
    const discovery = {
      adapter: 'overture', version: 'fixture-v1', dataUrl: 'https://example.test/catalog',
      assets: [], buildingAssets: [], buildingAssetEntries: []
    };
    const options = { cacheDir, maxBytes: 1024, maxRecords: 1, perLocality: 1, retainRaw: false };
    const first = await adapters.materialize(shard, discovery, options);
    await writeFile(first.file, '', 'utf8');
    const second = await adapters.materialize(shard, discovery, options);
    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(false);
    expect(materializations).toBe(2);
  });

  it('rejects a chunked source response that exceeds the cache budget', async () => {
    const cacheDir = resolve('.data-cache', `chunked-budget-${process.pid}-${Date.now()}`);
    directories.push(cacheDir);
    const execute = vi.fn();
    const adapters = createSourceAdapters({
      fetchImpl: async () => new Response('oversized'), execute, pythonBin: 'python-fixture'
    });
    await expect(adapters.materialize(
      { id: 'fixture-geofabrik', countryCode: 'US', source: {} },
      { adapter: 'geofabrik', version: 'fixture', dataUrl: 'https://example.test/source.pbf', sourceBytes: null },
      { cacheDir, maxRecords: 1, perLocality: 1, maxBytes: 3, retainRaw: false }
    )).rejects.toThrow('Source download size mismatch');
    expect(execute).not.toHaveBeenCalled();
  });

  it('includes output limits in normalized cache identities', () => {
    expect(normalizedCachePolicyIdentity(20_000, 2_000)).toBe('m20000-p2000');
    expect(normalizedCachePolicyIdentity(10_000, 2_000))
      .not.toBe(normalizedCachePolicyIdentity(20_000, 2_000));
    expect(normalizedCachePolicyIdentity(20_000, 300))
      .not.toBe(normalizedCachePolicyIdentity(20_000, 2_000));
  });

  it('discovers the official Vietnam postcode PDF as binary content', async () => {
    const pdf = Buffer.alloc(120_000, 7);
    const fetchImpl = async (input, init = {}) => {
      const url = String(input);
      if (url.endsWith('index-v1-nogeom.json')) return Response.json({ features: [{
        properties: { id: 'vietnam', urls: { pbf: 'https://download.geofabrik.de/asia/vietnam-latest.osm.pbf' } }
      }] });
      if (init.method === 'HEAD') return new Response(null, { status: 200, headers: {
        'last-modified': 'Thu, 31 Jul 2026 00:00:00 GMT', etag: 'vn', 'content-length': '100'
      } });
      if (url.endsWith('.pdf')) return new Response(pdf, { status: 200, headers: { 'content-type': 'application/pdf' } });
      throw new Error(`Unexpected request: ${url}`);
    };
    const discovery = await createSourceAdapters({ fetchImpl }).discover({
      id: 'geofabrik-osm-vn', countryCode: 'VN', extractId: 'vietnam',
      postcodeDataUrl: 'https://example.test/vietnam-postcodes.pdf', postcodeDataFormat: 'pdf',
      source: { adapter: 'geofabrik' }
    });
    expect(discovery).toMatchObject({
      postcodeDataFormat: 'pdf', postcodeBytes: pdf.byteLength,
      postcodeDataUrl: 'https://example.test/vietnam-postcodes.pdf'
    });
    expect(discovery.version).toContain('-p');
  });

  it('keeps Geofabrik metadata probes lightweight when a postcode source is configured', async () => {
    const requested = [];
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const url = String(input);
      requested.push({ url, method: init.method || 'GET' });
      if (url.endsWith('index-v1-nogeom.json')) return Response.json({ features: [{
        properties: { id: 'vietnam', urls: { pbf: 'https://download.geofabrik.de/asia/vietnam-latest.osm.pbf' } }
      }] });
      if (init.method === 'HEAD') return new Response(null, { status: 200, headers: {
        'last-modified': 'Thu, 31 Jul 2026 00:00:00 GMT', etag: 'vn', 'content-length': '100'
      } });
      throw new Error(`Unexpected request: ${url}`);
    });
    const discovery = await createSourceAdapters({ fetchImpl }).discover({
      id: 'geofabrik-osm-vn', countryCode: 'VN', extractId: 'vietnam',
      postcodeDataUrl: 'https://example.test/vietnam-postcodes.pdf', postcodeDataFormat: 'pdf',
      source: { adapter: 'geofabrik' }
    }, { syncMode: 'probe' });

    expect(discovery).toMatchObject({
      version: expect.stringMatching(/^2026-07-31-vn-p[a-f\d]{16}$/u), estimateMethod: 'metadata-probe'
    });
    expect(requested).toEqual([
      { url: expect.stringContaining('index-v1-nogeom.json'), method: 'GET' },
      { url: 'https://download.geofabrik.de/asia/vietnam-latest.osm.pbf', method: 'HEAD' },
      { url: 'https://example.test/vietnam-postcodes.pdf', method: 'HEAD' }
    ]);
  });

  it('uses the official Philippine page metadata endpoint without downloading the postcode page', async () => {
    const requested = [];
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const url = String(input);
      requested.push({ url, method: init.method || 'GET' });
      if (url.endsWith('index-v1-nogeom.json')) return Response.json({ features: [{
        properties: { id: 'philippines', urls: { pbf: 'https://download.geofabrik.de/asia/philippines-latest.osm.pbf' } }
      }] });
      if (url.endsWith('/wp-sitemap-posts-page-1.xml')) return new Response(
        '<urlset><url><loc>https://phlpost.gov.ph/zip-code-locator/</loc><lastmod>2026-08-01T04:00:00+08:00</lastmod></url></urlset>'
      );
      if (init.method === 'HEAD') return new Response(null, { status: 200, headers: {
        'last-modified': 'Thu, 31 Jul 2026 00:00:00 GMT', etag: 'ph', 'content-length': '100'
      } });
      throw new Error(`Unexpected request: ${url}`);
    });
    const discovery = await createSourceAdapters({ fetchImpl }).discover({
      id: 'geofabrik-osm-ph', countryCode: 'PH', extractId: 'philippines',
      postcodeDataUrl: 'https://phlpost.gov.ph/zip-code-locator/',
      postcodeMetadataUrl: 'https://phlpost.gov.ph/wp-sitemap-posts-page-1.xml',
      postcodeMetadataFormat: 'sitemap',
      postcodeMetadataMatchUrl: 'https://phlpost.gov.ph/zip-code-locator/',
      source: { adapter: 'geofabrik' }
    }, { syncMode: 'probe' });

    expect(discovery.version).toMatch(/^2026-07-31-ph-p[a-f\d]{16}$/u);
    expect(requested.some(({ url }) => url === 'https://phlpost.gov.ph/zip-code-locator/')).toBe(false);
    expect(requested.at(-1)).toEqual({
      url: 'https://phlpost.gov.ph/wp-sitemap-posts-page-1.xml', method: 'GET'
    });
  });

  it('fingerprints postcode HTML by stable visible content and reuses the discovered artifact', async () => {
    const cacheDir = resolve('.data-cache', `postcode-html-${process.pid}-${Date.now()}`);
    directories.push(cacheDir);
    const first = `<html><head><script nonce="one">window.requestId='one'</script></head>
      <body><table><tr><td>Metro Manila</td><td>1000</td></tr></table></body></html>`;
    const second = `<html data-request="two"><head><script nonce="two">window.requestId='two'</script></head>
      <body><table class="changed"><tr><td>Metro Manila</td><td>1000</td></tr></table></body></html>`;
    const firstFile = resolve(cacheDir, 'first.html');
    const secondFile = resolve(cacheDir, 'second.html');
    await mkdir(cacheDir, { recursive: true });
    await writeFile(firstFile, first.repeat(1000));
    await writeFile(secondFile, second.repeat(1000));
    expect(canonicalizeHtmlText(first)).toBe(canonicalizeHtmlText(second));
    expect(await stableHtmlFingerprint(firstFile)).toBe(await stableHtmlFingerprint(secondFile));
  });

  it('stores localized variants, evidence and coordinates in the PostgreSQL hot pool schema', async () => {
    const schema = await readFile('server/database/schema.sql', 'utf8');
    expect(schema).toContain('component_variants_json TEXT NOT NULL');
    expect(schema).toContain('address_variants_json TEXT NOT NULL');
    expect(schema).toContain('idx_address_pool_coordinates');
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

  it('enables Overture residential classification by default and allows an explicit opt-out', async () => {
    expect(sourceAdapterRevisions.overture).toBe('addresses-streets-residential-subset-v8-popular-ranks+capacity-20261003');
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
    const defaulted = await createSourceAdapters({ fetchImpl, environment: {} }).discover(shard);
    const enabled = await createSourceAdapters({ fetchImpl, enableOvertureResidential: true }).discover(shard);
    const disabled = await createSourceAdapters({ fetchImpl, enableOvertureResidential: false }).discover(shard);
    expect(defaulted.buildingAssets).toEqual(['https://example.test/address.parquet']);
    expect(enabled.buildingAssets).toEqual(['https://example.test/address.parquet']);
    expect(enabled.buildingAssetEntries).toEqual([{
      url: 'https://example.test/address.parquet', bbox: [-180, -90, 180, 90]
    }]);
    expect(disabled.buildingAssets).toEqual([]);
  });

  it('pairs each US state partition with its USA Structures archive instead of Overture buildings', async () => {
    const fetchImpl = async (input) => {
      const url = String(input);
      if (url.endsWith('/catalog.json')) return Response.json({ latest: '2026-09-23.1' });
      if (url.endsWith('/collection.json')) return Response.json({ links: [{ rel: 'item', href: './00000.json' }] });
      if (url.startsWith('https://fema-femadata.s3.amazonaws.com/')) {
        const key = (value) => `<Key>Partners/ORNL/USA_Structures/${value}</Key>`;
        return new Response(new URL(url).searchParams.has('continuation-token')
          ? key('Mississippi/MS_Structures_20260913.zip') + key('Tennessee/Deliverable20250606TN.zip')
          : key('Mississippi/Deliverable20250606MS.zip') + key('Mississippi/Deliverable202496MS.zip')
            + '<NextContinuationToken>next</NextContinuationToken>');
      }
      return Response.json({ bbox: [-92, 30, -88, 35], assets: { aws: { href: 'https://example.test/address.parquet' } } });
    };
    const catalog = await loadSourceCatalog(undefined, {});
    const shard = catalog.shards.find((value) => value.id === 'overture-usa-structures-ms');
    expect(shard).toMatchObject({ countryCode: 'US', admin1: 'MS', maxRecords: 20000, source: { id: 'overture-usa-structures-ms' } });
    const discovery = await createSourceAdapters({ fetchImpl, environment: {} }).discover(shard);
    expect(discovery).toMatchObject({
      version: '2026-09-23.1+usa-structures-20260913',
      structuresUrl: 'https://fema-femadata.s3.amazonaws.com/Partners/ORNL/USA_Structures/Mississippi/MS_Structures_20260913.zip',
      residentialBuildingAvailable: true,
      buildingAssets: []
    });
    const exporter = (await readFile('server/sync/overture-export.py', 'utf8')).replace(/\r\n/g, '\n');
    expect(exporter).toContain("WHERE building_rank = 1 AND occupancy = 'Residential'");
    expect(exporter).toContain('ST_DWithin(address_candidates.geometry, structures.geometry, 0.0003)');
  });

  it('keeps a US state without a USA Structures archive instead of failing the country', async () => {
    const fetchImpl = async (input) => {
      const url = String(input);
      if (url.endsWith('/catalog.json')) return Response.json({ latest: '2026-09-23.1' });
      if (url.endsWith('/collection.json')) return Response.json({ links: [{ rel: 'item', href: './00000.json' }] });
      if (url.startsWith('https://fema-femadata.s3.amazonaws.com/')) {
        return new Response('<Key>Partners/ORNL/USA_Structures/Mississippi/MS_Structures_20260913.zip</Key>');
      }
      return Response.json({ bbox: [-170, 50, -130, 72], assets: { aws: { href: 'https://example.test/address.parquet' } } });
    };
    const shard = (await loadSourceCatalog(undefined, {})).shards.find((value) => value.id === 'overture-usa-structures-ak');
    const discovery = await createSourceAdapters({ fetchImpl, environment: {} }).discover(shard);
    expect(discovery.structuresUrl ?? null).toBeNull();
    expect(discovery.version).not.toContain('usa-structures');
  });

  it('reads one or many OpenAddresses archive members with cross-member deduplication', async () => {
    const cacheDir = resolve('.data-cache', `openaddresses-members-${process.pid}-${Date.now()}`);
    directories.push(cacheDir);
    await mkdir(cacheDir, { recursive: true });
    const header = 'LON,LAT,NUMBER,STREET,DISTRICT,CITY,REGION,POSTCODE,ID\n';
    const first = `${header}126.9704,37.5844,94,자하문로,청운동,종로구,서울특별시,03047,a1\n`
      + '127.0000,37.5000,10,테헤란로,역삼동,강남구,서울특별시,06236,a2\n'
      + '127.1000,37.6000,11,테헤란로,역삼동,강남구,서울특별시,,invalid\n';
    const second = `${header}126.9704,37.5844,94,자하문로,청운동,종로구,서울특별시,03047,duplicate\n`
      + '129.0756,35.1796,20,중앙대로,중앙동,중구,부산광역시,48924,b1\n';
    const archive = resolve(cacheDir, 'fixture.zip');
    const mapping = resolve(cacheDir, 'mapping.json');
    const oneMemberOutput = resolve(cacheDir, 'one.jsonl');
    const manyMemberOutput = resolve(cacheDir, 'many.jsonl');
    await writeFile(archive, zipSync({
      'kr/11/provincewide.csv': strToU8(first),
      'kr/26/provincewide.csv': strToU8(second)
    }));
    await writeFile(mapping, JSON.stringify({
      id: 'ID', number: 'NUMBER', street: 'STREET', district: 'DISTRICT', locality: 'CITY',
      admin1: 'REGION', postcode: 'POSTCODE', longitude: 'LON', latitude: 'LAT'
    }));
    const common = ['server/sync/openaddresses-export.py', '--input', archive,
      '--mapping-file', mapping, '--country', 'KR', '--max-records', '10', '--per-locality', '5'];
    const python = process.platform === 'win32' ? 'python' : 'python3';
    await execFileAsync(python, [...common, '--member', 'kr/11/provincewide.csv', '--output', oneMemberOutput]);
    await execFileAsync(python, [...common, '--member', 'kr/11/provincewide.csv',
      '--member', 'kr/26/provincewide.csv', '--output', manyMemberOutput]);
    const oneMember = (await readFile(oneMemberOutput, 'utf8')).trim().split('\n').map(JSON.parse);
    const manyMembers = (await readFile(manyMemberOutput, 'utf8')).trim().split('\n').map(JSON.parse);
    expect(oneMember).toHaveLength(3);
    expect(manyMembers).toHaveLength(4);
    expect(new Set(manyMembers.map((record) => record.id)).size).toBe(4);
    expect(manyMembers.every((record) => record.district && record.locality)).toBe(true);
    expect(manyMembers.filter((record) => !record.postcode)).toEqual([expect.objectContaining({ number: '11' })]);
  });

  it('discovers OpenAddresses archives with Overture residential building assets', async () => {
    const catalog = await loadSourceCatalog(undefined, {
      ADDRESS_SYNC_SA_OPENADDRESSES_ENABLED: 'true',
      ADDRESS_SYNC_SA_OPENADDRESSES_LICENSE_CONFIRMED: 'true',
      ADDRESS_SYNC_SA_OPENADDRESSES_REDISTRIBUTION_ALLOWED: 'true'
    });
    const shard = catalog.shards.find((entry) => entry.id === 'openaddresses-sa-national');
    const fetchImpl = async (input, init = {}) => {
      const url = String(input);
      if (url === shard.source.dataUrl) {
        return new Response(null, { status: 206, headers: {
          'content-range': 'bytes 0-0/181901121', 'last-modified': 'Mon, 23 Jun 2025 13:13:06 GMT'
        } });
      }
      if (url.endsWith('/catalog.json')) return Response.json({ latest: '2026-07-22.0' });
      if (url.endsWith('/collection.json')) return Response.json({ links: [{ rel: 'item', href: './00000.json' }] });
      return Response.json({
        bbox: [-180, -90, 180, 90],
        assets: { aws: { href: 'https://example.test/building.parquet' } }
      });
    };
    const discovered = await createSourceAdapters({ fetchImpl }).discover(shard);
    expect(discovered).toMatchObject({
      adapter: 'openaddresses-archive', version: '2025-06-23', sourceBytes: 181901121,
      buildingAssets: ['https://example.test/building.parquet']
    });
  });

  it('discovers both preserved INEGI dwelling artifacts without a residential inference source', async () => {
    const catalog = await loadSourceCatalog();
    const shard = catalog.shards.find((entry) => entry.id === 'inegi-mx-residential');
    const fetchImpl = async (input) => new Response(null, {
      status: 200,
      headers: {
        'content-length': String(String(input) === shard.source.dataUrl ? 639926884 : 683565189),
        'last-modified': 'Thu, 11 Apr 2024 00:00:00 GMT'
      }
    });
    const discovered = await createSourceAdapters({ fetchImpl }).discover(shard);
    expect(discovered).toMatchObject({
      adapter: 'inegi-residential',
      version: 'inegi-address-frame-preserved-2024-04-11-official-dwelling-v1',
      sourceBytes: 639926884,
      normalizedSourceBytes: 683565189
    });
    expect(discovered).not.toHaveProperty('buildingAssets');
  });

  it('accepts a complete rolling-source download within the discovery size window', () => {
    expect(sourceSizeMatches(21_091_815, 21_092_996)).toBe(true);
    expect(sourceSizeMatches(5_000_000, 21_092_996)).toBe(false);
    expect(sourceSizeMatches(21_091_815, null)).toBe(true);
  });

  it('parses only a valid Geofabrik MD5 checksum', () => {
    expect(parseGeofabrikMd5('0123456789abcdef0123456789ABCDEF  japan-latest.osm.pbf'))
      .toBe('0123456789abcdef0123456789abcdef');
    expect(parseGeofabrikMd5('missing')).toBeNull();
  });

  it('uses strict Japan PLATEAU evidence when the optional OSM source is unavailable', async () => {
    const cacheDir = resolve('.data-cache', `japan-abr-${process.pid}-${Date.now()}`);
    directories.push(cacheDir);
    const catalog = await loadSourceCatalog();
    const catalogShard = catalog.shards.find((entry) => entry.id === 'japan-abr-residential');
    const plateauPayload = 'plateau';
    const shard = {
      ...catalogShard,
      source: {
        ...catalogShard.source,
        plateauBundles: [{
          cityCode: '13113', year: 2023, url: 'https://example.test/plateau.tar.zst',
          sha256: createHash('sha256').update(plateauPayload).digest('hex'), bytes: plateauPayload.length
        }]
      }
    };
    const calls = [];
    const fetchImpl = async (input, init = {}) => {
      const url = String(input);
      if (url === shard.source.dataUrl) return Response.json({ meta: { updated: 1_735_102_668 }, data: [] });
      if (url.endsWith('index-v1-nogeom.json')) return Response.json({ features: [{
        properties: { id: 'japan', urls: { pbf: 'https://example.test/japan.osm.pbf' } }
      }] });
      if (init.method === 'HEAD' && url.endsWith('.pbf')) return new Response(null, { status: 503 });
      if (init.method === 'HEAD') return new Response(null, { status: 200, headers: {
        'last-modified': 'Tue, 30 Jun 2026 00:00:00 GMT',
        'content-length': url.endsWith('.zip') ? '7' : '8'
      } });
      if (url.endsWith('.zip')) return new Response('postal!');
      if (url.endsWith('.pbf')) return new Response('osm-data');
      if (url.endsWith('.tar.zst')) return new Response(plateauPayload);
      throw new Error(`Unexpected request: ${url}`);
    };
    const checkpoint = {
      version: 1, abr_complete: false, abr_completed_cities: [], plateau_completed: [],
      osm_scanned_ways: 0, osm_complete: false, final_complete: false
    };
    const execute = async ({ file, args, phase, timeoutMs }) => {
      calls.push({ file, args, phase, timeoutMs });
      if (phase.startsWith('extract:')) {
        const directory = args[args.indexOf('-C') + 1];
        await mkdir(directory, { recursive: true });
        await writeFile(resolve(directory, 'buildings.parquet'), plateauPayload, 'utf8');
      } else {
        const stage = args[args.indexOf('--stage') + 1];
        if (stage === 'abr') await writeFile(args[args.indexOf('--store-file') + 1], 'fixture-candidate-store', 'utf8');
        if (stage === 'abr') checkpoint.abr_complete = true;
        if (stage === 'plateau') checkpoint.plateau_completed = ['13113'];
        if (stage === 'osm') checkpoint.osm_complete = true;
        if (stage === 'final') {
          checkpoint.final_complete = true;
          await writeFile(args[args.indexOf('--output') + 1], `${JSON.stringify({ id: 'fixture-jp' })}\n`, 'utf8');
        }
        await writeFile(args[args.indexOf('--checkpoint-file') + 1], JSON.stringify(checkpoint));
      }
    };
    const adapters = createSourceAdapters({ fetchImpl, execute, pythonBin: 'python-fixture' });
    const discovery = await adapters.discover(shard);
    expect(discovery).toMatchObject({
      adapter: 'japan-abr',
        version: '1735102668-plateau-only-2026-06-30-abr-rsdt-plateau-osm-chiban-v14',
      sourceBytes: 14, osmUrl: null, osmVersion: 'plateau-only', osmBytes: null,
      postalVersion: '2026-06-30', postalBytes: 7, plateauBytes: 7
    });
    const options = {
      cacheDir, maxRecords: 60000, perLocality: 200, maxBytes: 1024, retainRaw: false, sharedRaw: false
    };
    for (let stage = 0; stage < 3; stage += 1) {
      await expect(adapters.materialize(shard, discovery, options)).resolves.toMatchObject({
        sourceComplete: false, checkpointToken: expect.any(String)
      });
    }
    const materialized = await adapters.materialize(shard, discovery, options);
    expect(materialized).toMatchObject({ format: 'overture-jsonl', cacheHit: false });
    expect(materialized.file).toContain('-m60000-p200.jsonl');
    expect(calls.filter(({ phase }) => phase.startsWith('extract:'))).toHaveLength(1);
    const materializeCall = calls.find(({ args }) => args.includes('plateau'));
    expect(materializeCall).toMatchObject({ file: 'python-fixture' });
    expect(materializeCall.timeoutMs).toBe(90 * 60_000);
    expect(materializeCall.args).toEqual(expect.arrayContaining([
      expect.stringContaining('japan-abr-export.py'), '--abr-url', shard.source.dataUrl,
      '--checkpoint-file', expect.stringContaining('checkpoint.json'),
      '--store-file', expect.stringContaining('candidates.duckdb'),
      '--max-records', '60000', '--per-locality', '200', '--plateau-parquet',
      expect.stringContaining('buildings.parquet')
    ]));
    expect(materializeCall.args).toEqual(expect.arrayContaining(['--plateau-city-code', '13113']));
    expect(materializeCall.args).toContain('--land-lot');
    expect(materializeCall.args).not.toContain('--osm-pbf');
    await expect(readFile(dirname(materializeCall.args[materializeCall.args.indexOf('--checkpoint-file') + 1]), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses a verified Geofabrik checksum when Japan PBF metadata HEAD is unavailable', async () => {
    const catalog = await loadSourceCatalog();
    const shard = catalog.shards.find((entry) => entry.id === 'japan-abr-residential');
    const checksum = '0123456789abcdef0123456789abcdef';
    const fetchImpl = async (input, init = {}) => {
      const url = String(input);
      if (url === shard.source.dataUrl) return Response.json({ meta: { updated: 1_735_102_668 }, data: [] });
      if (url.endsWith('index-v1-nogeom.json')) return Response.json({ features: [{
        properties: { id: 'japan', urls: { pbf: 'https://example.test/japan.osm.pbf' } }
      }] });
      if (url.endsWith('.pbf.md5')) return new Response(`${checksum}  japan.osm.pbf`);
      if (init.method === 'HEAD' && url.endsWith('.pbf')) return new Response(null, { status: 502 });
      if (init.method === 'HEAD' && url.endsWith('.zip')) return new Response(null, { status: 200, headers: {
        'last-modified': 'Tue, 30 Jun 2026 00:00:00 GMT', 'content-length': '7'
      } });
      throw new Error(`Unexpected request: ${url}`);
    };
    const discovery = await createSourceAdapters({ fetchImpl }).discover(shard);
    expect(discovery).toMatchObject({
      osmUrl: 'https://example.test/japan.osm.pbf', osmMd5: checksum,
      osmVersion: checksum, osmBytes: null,
      version: `1735102668-${checksum}-2026-06-30-abr-rsdt-plateau-osm-chiban-v14`
    });
  });

  it('turns a Japan timeout with durable progress into an automatic resumable checkpoint', async () => {
    const cacheDir = resolve('.data-cache', `japan-resume-${process.pid}-${Date.now()}`);
    directories.push(cacheDir);
    const catalog = await loadSourceCatalog();
    const catalogShard = catalog.shards.find((entry) => entry.id === 'japan-abr-residential');
    const plateauPayload = 'plateau';
    const shard = {
      ...catalogShard,
      source: {
        ...catalogShard.source,
        useOsmSupplement: false,
        plateauBundles: [{
          cityCode: '13113', year: 2023, url: 'https://example.test/plateau.tar.zst',
          sha256: createHash('sha256').update(plateauPayload).digest('hex'), bytes: plateauPayload.length
        }]
      }
    };
    const fetchImpl = async (input, init = {}) => {
      const url = String(input);
      if (url === shard.source.dataUrl) return Response.json({ meta: { updated: 1_735_102_668 }, data: [] });
      if (init.method === 'HEAD') return new Response(null, { status: 200, headers: {
        'last-modified': 'Tue, 30 Jun 2026 00:00:00 GMT',
        'content-length': url.endsWith('.zip') ? '7' : '8'
      } });
      if (url.endsWith('.zip')) return new Response('postal!');
      if (url.endsWith('.tar.zst')) return new Response(plateauPayload);
      throw new Error(`Unexpected request: ${url}`);
    };
    const calls = [];
    let attempt = 0;
    const execute = async ({ args, phase }) => {
      calls.push({ args, phase });
      if (phase.startsWith('extract:')) {
        const directory = args[args.indexOf('-C') + 1];
        await mkdir(directory, { recursive: true });
        await writeFile(resolve(directory, 'buildings.parquet'), plateauPayload);
        return;
      }
      attempt += 1;
      const stage = args[args.indexOf('--stage') + 1];
      const checkpointFile = args[args.indexOf('--checkpoint-file') + 1];
      if (stage === 'abr') await writeFile(args[args.indexOf('--store-file') + 1], 'fixture-candidate-store', 'utf8');
      const state = JSON.parse(await readFile(checkpointFile, 'utf8').catch(() => JSON.stringify({
        version: 1, abr_complete: false, abr_completed_cities: [], plateau_completed: [],
        osm_scanned_ways: 0, osm_complete: false, final_complete: false
      })));
      if (stage === 'abr') state.abr_complete = true;
      if (stage === 'plateau') state.plateau_completed = ['13113'];
      if (stage === 'osm') state.osm_complete = true;
      if (stage === 'final') state.final_complete = true;
      await writeFile(checkpointFile, JSON.stringify(state));
      if (attempt === 1) {
        throw Object.assign(new Error('fixture timeout'), { code: 'SYNC_PROCESS_TIMEOUT' });
      }
      if (stage === 'final') {
        await writeFile(args[args.indexOf('--output') + 1], `${JSON.stringify({ id: 'fixture-jp' })}\n`);
      }
    };
    const adapters = createSourceAdapters({ fetchImpl, execute, pythonBin: 'python-fixture' });
    const discovery = await adapters.discover(shard);
    const options = {
      cacheDir, maxRecords: 60000, perLocality: 200, maxBytes: 1024,
      retainRaw: false, sharedRaw: false
    };

    await expect(adapters.materialize(shard, discovery, options)).rejects.toMatchObject({
      code: 'SOURCE_PARTIAL', sourceComplete: false, checkpointToken: expect.any(String)
    });
    await expect(adapters.materialize(shard, discovery, options)).resolves.toMatchObject({ sourceComplete: false });
    await expect(adapters.materialize(shard, discovery, options)).resolves.toMatchObject({ sourceComplete: false });
    await expect(adapters.materialize(shard, discovery, options)).resolves.toMatchObject({
      format: 'overture-jsonl', cacheHit: false
    });

    expect(calls.filter(({ phase }) => phase.startsWith('extract:'))).toHaveLength(1);
    const materializeCalls = calls.filter(({ phase }) => phase === 'materialize:japan-abr-residential');
    expect(materializeCalls).toHaveLength(4);
    expect(materializeCalls[1].args).toContain('--plateau-parquet');
    expect(materializeCalls[2].args).not.toContain('--plateau-parquet');
  });

  it('discovers and materializes the official Singapore HDB residential source', async () => {
    const cacheDir = resolve('.data-cache', `singapore-hdb-${process.pid}-${Date.now()}`);
    directories.push(cacheDir);
    const catalog = await loadSourceCatalog();
    const shard = catalog.shards.find((entry) => entry.id === 'singapore-hdb-residential');
    expect(shard.quotaProvider).toBe('onemap');
    const calls = [];
    const fetchImpl = async (input, init = {}) => {
      const url = String(input);
      if (url.includes('initiate-download')) {
        const property = url.includes(shard.source.propertyDatasetId);
        return Response.json({ data: { url: property
          ? 'https://example.test/property.csv' : 'https://example.test/buildings.geojson' } });
      }
      if (init.method === 'HEAD') return new Response(null, { status: 200, headers: {
        'last-modified': 'Wed, 29 Jul 2026 00:00:00 GMT',
        'content-length': url.endsWith('.csv') ? '8' : '9'
      } });
      if (url.endsWith('.csv')) return new Response('property');
      if (url.endsWith('.geojson')) return new Response('buildings');
      throw new Error(`Unexpected request: ${url}`);
    };
    const execute = async ({ file, args, phase, env }) => {
      calls.push({ file, args, phase, env });
      await writeFile(args[args.indexOf('--output') + 1], `${JSON.stringify({ id: 'fixture-sg' })}\n`, 'utf8');
      await writeFile(args[args.indexOf('--state-output') + 1], JSON.stringify({
        version: 1, source_complete: true, checkpoint_token: 'complete-fixture'
      }), 'utf8');
    };
    const brokerCalls = [];
    const adapters = createSourceAdapters({
      fetchImpl, execute, pythonBin: 'python-fixture',
      environment: { ONEMAP_ACCESS_TOKEN: 'must-not-reach-child' },
      credentialBrokerClient: {
        request: async (...args) => { brokerCalls.push(args); return { results: [] }; }
      }
    });
    const discovery = await adapters.discover(shard);
    expect(discovery).toMatchObject({
      adapter: 'singapore-hdb', version: `2026-07-29-${sourceAdapterRevisions['singapore-hdb']}`,
      sourceBytes: 17, propertyBytes: 8, buildingBytes: 9, residentialBuildingAvailable: true
    });
    const materialized = await adapters.materialize(shard, discovery, {
      cacheDir, maxRecords: 12000, perLocality: 1000, maxBytes: 1024, retainRaw: false
    });
    expect(materialized).toMatchObject({ format: 'overture-jsonl', cacheHit: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ file: 'python-fixture', phase: 'materialize:singapore-hdb-residential' });
    expect(calls[0].args).toEqual(expect.arrayContaining([
      expect.stringContaining('singapore-hdb-export.py'), '--onemap-bridge-url',
      expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\//u), '--onemap-cache',
      expect.stringContaining('singapore-hdb-residential-onemap-cache.jsonl'),
      '--state-output', expect.stringContaining('singapore-hdb-residential'),
      '--max-records', '12000', '--per-locality', '1000', '--max-onemap-requests', '500'
    ]));
    expect(calls[0].env.ONEMAP_ACCESS_TOKEN).toBeUndefined();
    expect(Object.keys(calls[0].env).some((name) => name.startsWith('CREDENTIAL_BROKER_'))).toBe(false);
  });

  it('preserves Singapore inputs and publishes the strict part of a checkpointed snapshot', async () => {
    const cacheDir = resolve('.data-cache', `singapore-hdb-partial-${process.pid}-${Date.now()}`);
    directories.push(cacheDir);
    const catalog = await loadSourceCatalog();
    const shard = catalog.shards.find((entry) => entry.id === 'singapore-hdb-residential');
    const fetchImpl = async (input, init = {}) => {
      const url = String(input);
      if (url.includes('initiate-download')) return Response.json({ data: { url: url.includes(shard.source.propertyDatasetId)
        ? 'https://example.test/property.csv' : 'https://example.test/buildings.geojson' } });
      if (init.method === 'HEAD') return new Response(null, { status: 200, headers: {
        'last-modified': 'Wed, 29 Jul 2026 00:00:00 GMT', 'content-length': '8'
      } });
      return new Response('fixture!');
    };
    const execute = async ({ args }) => {
      await writeFile(args[args.indexOf('--output') + 1], `${JSON.stringify({ id: 'must-not-publish' })}\n`);
      await writeFile(args[args.indexOf('--state-output') + 1], JSON.stringify({
        version: 1, source_complete: false, checkpoint_token: 'checkpoint-sg-1',
        temporary_failure: 'quota', next_available_at: '2026-08-11T00:00:00Z',
        candidate_count: 2, resolved_count: 1, publishable_count: 1, selected_count: 1
      }));
    };
    const adapters = createSourceAdapters({
      fetchImpl, execute, pythonBin: 'python-fixture',
      credentialBrokerClient: { request: async () => ({ results: [] }) }
    });
    const discovery = await adapters.discover(shard);
    const materialized = await adapters.materialize(shard, discovery, {
      cacheDir, maxRecords: 12000, perLocality: 1000, maxBytes: 1024, retainRaw: false
    });
    expect(materialized).toMatchObject({
      file: expect.stringContaining('-partial-'), format: 'overture-jsonl', sourceComplete: false,
      checkpointToken: 'checkpoint-sg-1', checkpointStage: 'quota',
      nextAttemptAt: '2026-08-11T00:00:00Z',
      metrics: { candidateCount: 2, resolvedCount: 1, publishableCount: 1, selectedCount: 1 }
    });
    await expect(readFile(resolve(cacheDir, 'raw', `singapore-hdb-residential-${discovery.version}-property.csv`), 'utf8'))
      .resolves.toBe('fixture!');
  });

  it('discovers and materializes the official K-apt apartment source', async () => {
    const cacheDir = resolve('.data-cache', `korea-kapt-${process.pid}-${Date.now()}`);
    directories.push(cacheDir);
    const sourceCatalog = await loadSourceCatalog();
    const shard = sourceCatalog.shards.find((entry) => entry.id === 'korea-kapt-residential');
    const calls = [];
    const reports = [];
    const requestedKeys = [];
    const credentials = [{ id: 'geoapify-a', secret: 'secret-a' }, { id: 'geoapify-b', secret: 'secret-b' }];
    const credentialPool = {
      acquire: async (provider, { excludeIds = [] } = {}) => {
        expect(provider).toBe('geoapify');
        return credentials.find(({ id }) => !new Set(excludeIds).has(id)) || null;
      },
      report: async (id, outcome) => reports.push([id, outcome])
    };
    const fetchImpl = async (input) => {
      const url = new URL(String(input));
      if (url.href === shard.source.dataUrl) return new Response('<title>K-apt</title>', { status: 200,
        headers: { 'last-modified': 'Thu, 30 Jul 2026 00:00:00 GMT' } });
      requestedKeys.push(url.searchParams.get('apiKey'));
      if (url.searchParams.get('apiKey') === 'secret-a') return new Response(null, { status: 401 });
      return Response.json({ results: [{ country_code: 'kr', state: '서울특별시', postcode: '03000' }] });
    };
    const catalogData = `${JSON.stringify({
      source_record_id: 'kapt-fixture', admin1: '서울특별시', locality: '종로구', district: '내수동',
      address_levels: ['서울특별시', '종로구', '내수동'], latitude: 37.574, longitude: 126.977,
      source_rank: 'fixture'
    })}\n`;
    const catalogChecksum = createHash('sha256').update(catalogData).digest('hex');
    const execute = async ({ file, args, env, phase }) => {
      calls.push({ file, args, env, phase });
      if (args.includes('--catalog-output')) {
        await writeFile(args[args.indexOf('--catalog-output') + 1], catalogData, 'utf8');
        return;
      }
      expect(env.GEOAPIFY_API_KEY).toBeUndefined();
      expect(env.ADDRESS_SYNC_GEOAPIFY_BRIDGE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//u);
      const response = await fetch(env.ADDRESS_SYNC_GEOAPIFY_BRIDGE_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ latitude: 37.574, longitude: 126.977 })
      });
      expect(await response.json()).toMatchObject({ results: [{ postcode: '03000' }] });
      await writeFile(args[args.indexOf('--output') + 1], `${JSON.stringify({
        id: 'kapt-fixture', country: 'KR', postcode: '03000', street: '종로', number: '1',
        property_type: 'apartment', residential_building_id: 'A1'
      })}\n`, 'utf8');
      await writeFile(args[args.indexOf('--state-output') + 1], JSON.stringify({
        version: 2, source_complete: true, checkpoint_token: null,
        catalog_fingerprint: catalogChecksum, candidate_count: 1, resolved_count: 1,
        publishable_count: 1, selected_count: 1
      }), 'utf8');
    };
    const adapters = createSourceAdapters({
      fetchImpl, execute, pythonBin: 'python-fixture', credentialPool,
      environment: { GEOAPIFY_API_KEY: 'must-not-reach-python' }
    });
    const discovery = await adapters.discover(shard, { cacheDir });
    expect(discovery).toMatchObject({
      adapter: 'korea-kapt', version: `${catalogChecksum.slice(0, 24)}-${sourceAdapterRevisions['korea-kapt']}`,
      sourceChecksum: catalogChecksum
    });
    const materialized = await adapters.materialize(shard, discovery, {
      cacheDir, maxRecords: 60000, perLocality: 500, maxBytes: 1024, retainRaw: false
    });
    expect(materialized).toMatchObject({ format: 'overture-jsonl', cacheHit: false });
    expect(materialized.file).toContain('-m20000-p500-output-');
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ phase: 'discover:korea-kapt-residential' });
    expect(calls[0].args).toEqual(expect.arrayContaining(['--catalog-output']));
    expect(calls[1].args).toEqual(expect.arrayContaining([
      expect.stringContaining('korea-kapt-export.py'), '--postcode-cache',
      expect.stringContaining('korea-kapt-residential-postcode-cache.jsonl'),
      '--catalog-input', expect.stringContaining(`korea-kapt-residential-catalog-${catalogChecksum.slice(0, 24)}.jsonl`),
      '--state-output', expect.stringContaining('-state.'),
      '--max-records', '20000', '--per-locality', '500'
    ]));
    expect(calls[1].args).not.toContain('--daily-geocode-limit');
    expect(requestedKeys).toEqual(['secret-a', 'secret-b']);
    expect(reports).toEqual([['geoapify-a', 'auth'], ['geoapify-b', 'success']]);
  });

  it('publishes a partial K-apt snapshot while retaining its checkpoint', async () => {
    const cacheDir = resolve('.data-cache', `kapt-resume-${process.pid}-${Date.now()}`);
    directories.push(cacheDir);
    const catalogData = `${JSON.stringify({
      source_record_id: 'kapt-fixture', admin1: '서울특별시', locality: '종로구', district: '내수동',
      address_levels: ['서울특별시', '종로구', '내수동'], latitude: 37.574, longitude: 126.977,
      source_rank: 'fixture'
    })}\n`;
    const catalogChecksum = createHash('sha256').update(catalogData).digest('hex');
    let materializations = 0;
    const execute = async ({ args }) => {
      if (args.includes('--catalog-output')) {
        await writeFile(args[args.indexOf('--catalog-output') + 1], catalogData, 'utf8');
        return;
      }
      materializations += 1;
      await writeFile(args[args.indexOf('--output') + 1], `${JSON.stringify({
        id: 'kapt-fixture', country: 'KR', postcode: '03000', street: '종로', number: '1',
        property_type: 'apartment', residential_building_id: 'A1'
      })}\n`, 'utf8');
      await writeFile(args[args.indexOf('--state-output') + 1], JSON.stringify({
        version: 2, source_complete: materializations > 1,
        checkpoint_token: materializations > 1 ? null : 'checkpoint-1',
        catalog_fingerprint: catalogChecksum, candidate_count: 2,
        resolved_count: materializations > 1 ? 2 : 1, publishable_count: 1, selected_count: 1
      }), 'utf8');
    };
    const catalog = await loadSourceCatalog();
    const shard = catalog.shards.find((entry) => entry.id === 'korea-kapt-residential');
    const adapters = createSourceAdapters({
      fetchImpl: async () => new Response('<title>K-apt</title>', { status: 200 }),
      execute,
      pythonBin: 'python-fixture',
      credentialPool: { acquire: async () => null, report: async () => {} }
    });
    const discovery = await adapters.discover(shard, { cacheDir });
    const options = { cacheDir, maxRecords: 60000, perLocality: 500, maxBytes: 1024, retainRaw: false };
    const partial = await adapters.materialize(shard, discovery, options);
    expect(partial).toMatchObject({
      file: expect.stringContaining('-partial-'), format: 'overture-jsonl', sourceComplete: false,
      checkpointToken: 'checkpoint-1', checkpointStage: 'materialize', cacheHit: false,
      metrics: { candidateCount: 2, resolvedCount: 1, publishableCount: 1, selectedCount: 1 }
    });
    const otherPolicy = await adapters.materialize(shard, discovery, { ...options, perLocality: 100 });
    expect(otherPolicy).toMatchObject({ sourceComplete: true, checkpointToken: null, cacheHit: false });
    const complete = await adapters.materialize(shard, discovery, options);
    expect(complete).toMatchObject({ sourceComplete: true, checkpointToken: null, cacheHit: false });
    await writeFile(complete.file, 'corrupt', 'utf8');
    const repaired = await adapters.materialize(shard, discovery, options);
    expect(repaired).toMatchObject({ sourceComplete: true, checkpointToken: null, cacheHit: false });
    const cached = await adapters.materialize(shard, discovery, options);
    expect(cached).toMatchObject({ sourceComplete: true, checkpointToken: null, cacheHit: true });
    expect(materializations).toBe(4);
  });

  it('discovers and materializes the official eThekwini residential source', async () => {
    const cacheDir = resolve('.data-cache', `ethekwini-${process.pid}-${Date.now()}`);
    directories.push(cacheDir);
    const catalog = await loadSourceCatalog();
    const shard = catalog.shards.find((entry) => entry.id === 'ethekwini-za-residential');
    const calls = [];
    const fetchImpl = async (input, init = {}) => {
      const url = String(input);
      if (url === `${shard.source.addressUrl}?f=json`) return Response.json({ editingInfo: { lastEditDate: 1784806455000 } });
      if (url === `${shard.source.zoningUrl}?f=json`) return Response.json({ editingInfo: { lastEditDate: 1782986069000 } });
      if (url === shard.source.postalDataUrl && init.method === 'HEAD') return new Response(null, {
        status: 200, headers: { 'content-length': '6', 'last-modified': 'Fri, 31 Jul 2026 00:00:00 GMT' }
      });
      if (url === shard.source.postalDataUrl) return new Response('postal');
      throw new Error(`Unexpected request: ${url}`);
    };
    const execute = async ({ file, args, phase }) => {
      calls.push({ file, args, phase });
      await writeFile(args[args.indexOf('--output') + 1], `${JSON.stringify({ id: 'fixture-za' })}\n`, 'utf8');
    };
    const adapters = createSourceAdapters({ fetchImpl, execute, pythonBin: 'python-fixture' });
    const discovery = await adapters.discover(shard);
    expect(discovery).toMatchObject({
      adapter: 'ethekwini-residential',
      version: '2026-07-23-2026-07-31-official-address-zoning-postcode-v1',
      postalBytes: 6,
      residentialBuildingAvailable: true
    });
    const materialized = await adapters.materialize(shard, discovery, {
      cacheDir, maxRecords: 8000, perLocality: 1500, maxBytes: 1024, retainRaw: false
    });
    expect(materialized).toMatchObject({ format: 'overture-jsonl', cacheHit: false });
    expect(materialized.file).toContain('-m8000-p1500.jsonl');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ file: 'python-fixture', phase: 'materialize:ethekwini-za-residential' });
    expect(calls[0].args).toEqual(expect.arrayContaining([
      expect.stringContaining('south-africa-ethekwini-export.py'), '--postal-file',
      expect.stringContaining('ethekwini-za-residential-postalcodes.txt'),
      '--max-records', '8000', '--per-locality', '1500', '--concurrency', '16'
    ]));
  });

  it('discovers and materializes the official Cape Town residential source', async () => {
    const cacheDir = resolve('.data-cache', `cape-town-${process.pid}-${Date.now()}`);
    directories.push(cacheDir);
    const catalog = await loadSourceCatalog();
    const shard = catalog.shards.find((entry) => entry.id === 'cape-town-za-residential');
    const calls = [];
    const fetchImpl = async (input, init = {}) => {
      const url = String(input);
      if (url === `${shard.source.parcelUrl}?f=json`) return Response.json({ editingInfo: { lastEditDate: 1785138876806 } });
      if (url === shard.source.postalDataUrl && init.method === 'HEAD') return new Response(null, {
        status: 200, headers: { 'content-length': '6', 'last-modified': 'Fri, 31 Jul 2026 00:00:00 GMT' }
      });
      if (url === shard.source.postalDataUrl) return new Response('postal');
      throw new Error(`Unexpected request: ${url}`);
    };
    const execute = async ({ file, args, phase }) => {
      calls.push({ file, args, phase });
      await writeFile(args[args.indexOf('--output') + 1], `${JSON.stringify({ id: 'fixture-cape-town' })}\n`, 'utf8');
    };
    const adapters = createSourceAdapters({ fetchImpl, execute, pythonBin: 'python-fixture' });
    const discovery = await adapters.discover(shard);
    expect(discovery).toMatchObject({
      adapter: 'cape-town-residential',
      version: '2026-07-27-2026-07-31-official-parcel-zoning-postcode-v2',
      postalBytes: 6,
      residentialBuildingAvailable: true
    });
    const materialized = await adapters.materialize(shard, discovery, {
      cacheDir, maxRecords: 8000, perLocality: 1500, maxBytes: 1024, retainRaw: false
    });
    expect(materialized).toMatchObject({ format: 'overture-jsonl', cacheHit: false });
    expect(materialized.file).toContain('-m8000-p1500.jsonl');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ file: 'python-fixture', phase: 'materialize:cape-town-za-residential' });
    expect(calls[0].args).toEqual(expect.arrayContaining([
      expect.stringContaining('south-africa-cape-town-export.py'), '--parcel-url',
      expect.stringContaining('Property/FeatureServer/0'), '--postal-file',
      expect.stringContaining('cape-town-za-residential-postalcodes.txt'),
      '--max-records', '8000', '--per-locality', '1500'
    ]));
  });

  it('discovers and materializes the official Thailand DPT residential source with a durable checkpoint', async () => {
    const cacheDir = resolve('.data-cache', `thailand-dpt-${process.pid}-${Date.now()}`);
    directories.push(cacheDir);
    const catalog = await loadSourceCatalog();
    const catalogShard = catalog.shards.find((entry) => entry.id === 'thailand-dpt-residential');
    const shard = { ...catalogShard, qualityGate: { ...catalogShard.qualityGate, minimumRecords: 1 } };
    const calls = [];
    const fetchImpl = async (input) => {
      const url = new URL(String(input));
      if (`${url.origin}${url.pathname}` === shard.source.dataUrl) {
        return Response.json({ editingInfo: { lastEditDate: Date.parse('2026-08-01T00:00:00Z') } });
      }
      expect(`${url.origin}${url.pathname}`).toBe(`${shard.source.dataUrl}/query`);
      expect(url.searchParams.get('returnIdsOnly')).toBe('true');
      expect(url.searchParams.get('where')).toContain('BL_CLASS17 = 1');
      expect(url.searchParams.get('where')).toContain('BL_CLASS54 = 1');
      return Response.json({ objectIdFieldName: 'OBJECTID', objectIds: [45, 3, 102] });
    };
    const execute = async ({ file, args, phase }) => {
      calls.push({ file, args, phase });
      await writeFile(args[args.indexOf('--output') + 1], `${JSON.stringify({ id: 'dpt-building:fixture' })}\n`, 'utf8');
    };
    const adapters = createSourceAdapters({ fetchImpl, execute, pythonBin: 'python-fixture' });
    const discovery = await adapters.discover(shard);
    expect(discovery).toMatchObject({
      adapter: 'thailand-dpt-residential',
      version: expect.stringMatching(/^2026-08-01-oid-102-count-3-[a-f0-9]{16}-official-building-residential-v3$/u),
      publishedAt: '2026-08-01T00:00:00.000Z',
      residentialCount: 3,
      maximumObjectId: 102,
      objectIdDigest: expect.stringMatching(/^[a-f0-9]{16}$/u),
      residentialBuildingAvailable: true
    });
    const options = { cacheDir, maxRecords: 8000, perLocality: 700, maxBytes: 1024, retainRaw: false };
    const materialized = await adapters.materialize(shard, discovery, options);
    expect(materialized).toMatchObject({ format: 'overture-jsonl', cacheHit: false });
    expect(materialized.file).toContain('-m8000-p700.jsonl');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ file: 'python-fixture', phase: 'materialize:thailand-dpt-residential' });
    expect(calls[0].args).toEqual(expect.arrayContaining([
      expect.stringContaining('thailand-dpt-export.py'), '--layer-url', shard.source.dataUrl,
      '--max-records', '8000', '--per-locality', '700', '--batch-size', '500',
      '--checkpoint', expect.stringMatching(/thailand-dpt-residential-state-[a-f0-9]{20}[\\/]checkpoint\.json$/u)
    ]));
    await expect(adapters.materialize(shard, discovery, options)).resolves.toMatchObject({ cacheHit: true });
    expect(calls).toHaveLength(1);
  });

  it('turns interrupted Thailand DPT progress into a resumable source checkpoint', async () => {
    const cacheDir = resolve('.data-cache', `thailand-dpt-resume-${process.pid}-${Date.now()}`);
    directories.push(cacheDir);
    const catalog = await loadSourceCatalog();
    const catalogShard = catalog.shards.find((entry) => entry.id === 'thailand-dpt-residential');
    const shard = { ...catalogShard, qualityGate: { ...catalogShard.qualityGate, minimumRecords: 1 } };
    const fetchImpl = async (input) => {
      const url = new URL(String(input));
      if (`${url.origin}${url.pathname}` === shard.source.dataUrl) {
        return Response.json({ editingInfo: { lastEditDate: Date.parse('2026-08-01T00:00:00Z') } });
      }
      if (url.searchParams.get('returnIdsOnly') === 'true') return Response.json({ objectIds: [1, 2, 3] });
      return Response.json({ features: [] });
    };
    let attempts = 0;
    const execute = async ({ args }) => {
      attempts += 1;
      const checkpoint = args[args.indexOf('--checkpoint') + 1];
      await writeFile(checkpoint, JSON.stringify({ fingerprint: 'fixture', next_offset: attempts }));
      await writeFile(`${checkpoint}.candidates.jsonl`, `${JSON.stringify({ id: `fixture-${attempts}` })}\n`);
      if (attempts === 1) throw Object.assign(new Error('fixture timeout'), { code: 'SYNC_PROCESS_TIMEOUT' });
      await writeFile(args[args.indexOf('--output') + 1], `${JSON.stringify({ id: 'fixture-th' })}\n`);
    };
    const adapters = createSourceAdapters({ fetchImpl, execute, pythonBin: 'python-fixture' });
    const discovery = await adapters.discover(shard);
    const options = { cacheDir, maxRecords: 100, perLocality: 10, maxBytes: 1024, retainRaw: false };

    await expect(adapters.materialize(shard, discovery, options)).rejects.toMatchObject({
      code: 'SOURCE_PARTIAL', sourceComplete: false, checkpointToken: expect.any(String)
    });
    await expect(adapters.materialize(shard, discovery, options)).resolves.toMatchObject({ cacheHit: false });
    expect(attempts).toBe(2);
  });

  it('discovers and materializes Statistics Canada NAR as an independent resumable source', async () => {
    const cacheDir = resolve('.data-cache', `canada-nar-${process.pid}-${Date.now()}`);
    directories.push(cacheDir);
    const catalog = await loadSourceCatalog();
    const shard = { ...catalog.shards.find((entry) => entry.id === 'canada-statcan-nar-residential'),
      qualityGate: { minimumRecords: 1 } };
    const calls = [];
    const fetchImpl = async (_input, init = {}) => {
      expect(init.method).toBe('HEAD');
      return new Response(null, { status: 200, headers: {
        'content-length': '1665944959', 'last-modified': 'Fri, 26 Jun 2026 12:30:56 GMT',
        etag: '"634c4d7f-6552747bf9b7a"'
      } });
    };
    const execute = async ({ args, phase }) => {
      calls.push({ args, phase });
      const checkpoint = args[args.indexOf('--checkpoint') + 1];
      await mkdir(resolve(checkpoint, '..'), { recursive: true });
      await writeFile(args[args.indexOf('--output') + 1], `${JSON.stringify({ id: 'fixture-ca' })}\n`);
    };
    const adapters = createSourceAdapters({ fetchImpl, execute, pythonBin: 'python-fixture' });
    const discovery = await adapters.discover(shard);
    expect(discovery).toMatchObject({
      adapter: 'canada-nar-residential', sourceBytes: 1665944959,
      publishedAt: '2026-06-26T12:30:56.000Z', residentialBuildingAvailable: true
    });
    const materialized = await adapters.materialize(shard, discovery, {
      cacheDir, maxRecords: 15000, perLocality: 350, maxBytes: 2 * 1024 ** 3, retainRaw: false
    });
    expect(materialized).toMatchObject({ format: 'overture-jsonl', cacheHit: false, sourceComplete: true });
    expect(calls[0]).toMatchObject({ phase: 'materialize:canada-statcan-nar-residential' });
    expect(calls[0].args).toEqual(expect.arrayContaining([
      expect.stringContaining('canada-nar-export.py'), '--archive-url', shard.source.dataUrl,
      '--expected-size', '1665944959', '--max-records', '15000', '--per-locality', '350'
    ]));
  });

  it('discovers and materializes the verified Taiwan residential source', async () => {
    const cacheDir = resolve('.data-cache', `taiwan-residential-${process.pid}-${Date.now()}`);
    directories.push(cacheDir);
    const catalog = await loadSourceCatalog();
    const shard = catalog.shards.find((entry) => entry.id === 'taiwan-official-residential');
    const calls = [];
    const molitUrls = new Set(shard.source.archives.map(({ dataUrl }) => dataUrl));
    const fetchImpl = async (input, init = {}) => {
      const url = String(input);
      if (init.method === 'HEAD' && molitUrls.has(url)) return new Response(null, {
        status: 200, headers: { 'content-length': '5', 'last-modified': 'Fri, 31 Jul 2026 00:00:00 GMT' }
      });
      if (init.method === 'HEAD' && url === shard.source.openAddressesDataUrl) return new Response(null, {
        status: 200, headers: { 'content-length': '7', 'last-modified': 'Thu, 30 Jul 2026 00:00:00 GMT' }
      });
      if (molitUrls.has(url)) return new Response('molit');
      if (url === shard.source.openAddressesDataUrl) return new Response('oa-data');
      throw new Error(`Unexpected request: ${url}`);
    };
    const execute = async ({ file, args, phase }) => {
      calls.push({ file, args, phase });
      await writeFile(args[args.indexOf('--output') + 1], `${JSON.stringify({ id: 'fixture-tw' })}\n`, 'utf8');
    };
    const adapters = createSourceAdapters({ fetchImpl, execute, pythonBin: 'python-fixture' });
    const discovery = await adapters.discover(shard);
    expect(discovery).toMatchObject({
      adapter: 'taiwan-residential', version: '115S2+115S1-molit-lvr-oa-post-v2',
      molitBytes: 10, openAddressesBytes: 7, residentialBuildingAvailable: true,
      molitArchives: [
        { sourceVersion: '115S2', bytes: 5 },
        { sourceVersion: '115S1', bytes: 5 }
      ]
    });
    const checksumShard = {
      ...shard,
      source: { ...shard.source, archives: shard.source.archives.map((archive) => ({ ...archive, sha256: null })) }
    };
    const checksumDiscovery = {
      ...discovery,
      molitArchives: discovery.molitArchives.map((archive) => ({ ...archive, sha256: null }))
    };
    const materialized = await adapters.materialize(checksumShard, checksumDiscovery, {
      cacheDir, maxRecords: 30000, perLocality: 1000, maxBytes: 1024, retainRaw: false
    });
    expect(materialized).toMatchObject({ format: 'overture-jsonl', cacheHit: false });
    expect(materialized.file).toContain('-m30000-p1000.jsonl');
    const retried = await adapters.materialize(checksumShard, checksumDiscovery, {
      cacheDir, maxRecords: 30000, perLocality: 1000, maxBytes: 1024, retainRaw: false
    });
    expect(retried).toMatchObject({ format: 'overture-jsonl', cacheHit: false });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ file: 'python-fixture', phase: 'materialize:taiwan-official-residential' });
    expect(calls[0].args).toEqual(expect.arrayContaining([
      expect.stringContaining('taiwan-residential-export.py'), '--molit-archive', '--openaddresses-archive',
      '--postcode-cache', expect.stringContaining('taiwan-postcode-cache.jsonl'),
      '--max-records', '30000', '--per-locality', '1000', '--request-interval', '0.2',
      '--postcode-concurrency', '6'
    ]));
    expect(calls[0].args.filter((value) => value === '--molit-archive')).toHaveLength(2);
  });

  it('discovers and materializes the official Hong Kong residential source', async () => {
    const cacheDir = resolve('.data-cache', `hong-kong-residential-${process.pid}-${Date.now()}`);
    directories.push(cacheDir);
    const catalog = await loadSourceCatalog();
    const shard = catalog.shards.find((entry) => entry.id === 'hong-kong-official-residential');
    expect(shard.source.metadataUrl).toBe('https://data.gov.hk/en-data/api/3/action/package_show?id=hk-bd-opendata-building-information');
    const dataUrl = 'https://static.csdi.gov.hk/csdi-webpage/download/0123456789abcdef/csv';
    const calls = [];
    const fetchImpl = async (input, init = {}) => {
      const url = String(input);
      if (url === shard.source.metadataUrl) return Response.json({ success: true, result: { resources: [
        { state: 'deleted', url: 'https://static.csdi.gov.hk/csdi-webpage/download/ffffffffffffffff/csv', metadata_modified: '2026-08-01T00:00:00' },
        { state: 'active', format: 'CSV', url: dataUrl, metadata_modified: '2026-07-14T16:30:38.156769' }
      ] } });
      if (init.method === 'HEAD' && url === dataUrl) {
        return new Response(null, { status: 200, headers: { 'content-length': '9' } });
      }
      if (url === dataUrl) return new Response('hk-source');
      throw new Error(`Unexpected request: ${url}`);
    };
    const execute = async ({ file, args, phase }) => {
      calls.push({ file, args, phase });
      await writeFile(args[args.indexOf('--output') + 1], `${JSON.stringify({ id: 'fixture-hk' })}\n`, 'utf8');
    };
    const adapters = createSourceAdapters({ fetchImpl, execute, pythonBin: 'python-fixture' });
    const discovery = await adapters.discover(shard);
    expect(discovery).toMatchObject({
      adapter: 'hong-kong-residential', version: '2026-07-14-bd-building-information-v1',
      publishedAt: '2026-07-14T00:00:00.000Z', dataUrl, sourceBytes: 9,
      residentialBuildingAvailable: true
    });
    const materialized = await adapters.materialize(shard, discovery, {
      cacheDir, maxRecords: 60000, perLocality: 10000, maxBytes: 1024, retainRaw: false
    });
    expect(materialized).toMatchObject({ format: 'overture-jsonl', cacheHit: false });
    expect(materialized.file).toContain('-m60000-p10000.jsonl');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ file: 'python-fixture', phase: 'materialize:hong-kong-official-residential' });
    expect(calls[0].args).toEqual(expect.arrayContaining([
      expect.stringContaining('hong-kong-residential-export.py'), '--building-information', '--offline',
      '--max-records', '60000', '--per-district', '10000'
    ]));
  });

  it('reloads the Geofabrik index after a failed request', async () => {
    let indexRequests = 0;
    const fetchImpl = async (input, init = {}) => {
      const url = String(input);
      if (url.endsWith('index-v1-nogeom.json')) {
        indexRequests += 1;
        if (indexRequests === 1) return new Response('missing', { status: 404 });
        return Response.json({ features: [{
          properties: { id: 'china', urls: { pbf: 'https://download.geofabrik.de/asia/china-latest.osm.pbf' } }
        }] });
      }
      if (init.method === 'HEAD') {
        return new Response(null, { status: 200, headers: {
          'last-modified': 'Mon, 27 Jul 2026 00:00:00 GMT', etag: 'fixture', 'content-length': '100'
        } });
      }
      throw new Error(`Unexpected request: ${url}`);
    };
    const adapters = createSourceAdapters({ fetchImpl });
    const shard = {
      id: 'geofabrik-osm-cn', countryCode: 'CN', extractId: 'china',
      source: { adapter: 'geofabrik' }
    };
    await expect(adapters.discover(shard)).rejects.toMatchObject({ code: 'SOURCE_METADATA_HTTP', status: 404 });
    await expect(adapters.discover(shard)).resolves.toMatchObject({ version: '2026-07-27-fixture' });
    expect(indexRequests).toBe(2);
  });

  it('retries transient Geofabrik metadata failures', async () => {
    let headRequests = 0;
    const fetchImpl = async (input, init = {}) => {
      const url = String(input);
      if (url.endsWith('index-v1-nogeom.json')) {
        return Response.json({ features: [{
          properties: { id: 'bremen', urls: { pbf: 'https://download.geofabrik.de/europe/germany/bremen-latest.osm.pbf' } }
        }] });
      }
      if (init.method === 'HEAD') {
        headRequests += 1;
        if (headRequests === 1) throw new Error('transient timeout');
        return new Response(null, { status: 200, headers: {
          'last-modified': 'Mon, 27 Jul 2026 00:00:00 GMT', etag: 'fixture', 'content-length': '100'
        } });
      }
      throw new Error(`Unexpected request: ${url}`);
    };
    const adapters = createSourceAdapters({ fetchImpl });
    await expect(adapters.discover({
      id: 'geofabrik-osm-de-hb', countryCode: 'DE', extractId: 'bremen', source: { adapter: 'geofabrik' }
    })).resolves.toMatchObject({ version: '2026-07-27-fixture', sourceBytes: 100 });
    expect(headRequests).toBe(2);
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

describe('Google residential source adapter', () => {
  it('persists multiple roads per response and deduplicates them across request-budget resumes', async () => {
    const cacheDir = resolve('.data-cache', `google-street-resume-${process.pid}-${Date.now()}`);
    directories.push(cacheDir);
    const shard = { id: 'google-street-ng', countryCode: 'NG', maxRecords: 3,
      source: { adapter: 'google-residential-enrichment', maxRequestsPerRun: 2, pilotRequests: 2, minimumPilotAccepted: 1 } };
    const discovery = { adapter: 'google-residential-enrichment', version: sourceAdapterRevisions['google-residential-enrichment'],
      dataUrl: 'https://download.geofabrik.de/africa/nigeria-latest.osm.pbf', sourceBytes: 3, excludeBoundaryUrls: [] };
    const requested = [];
    const adapters = createSourceAdapters({ fetchImpl: async () => new Response('pbf'), pythonBin: 'python-fixture',
      execute: async ({ args }) => {
        expect(args).toContain('--include-streets');
        await writeFile(args[args.indexOf('--output') + 1], [1, 2].map((id) => JSON.stringify({
          id: `way/${id}`, match_level: 'street', latitude: 6.5 + id / 1000, longitude: 3.4
        })).join('\n') + '\n');
      },
      credentialBrokerClient: { request: async (_operation, parameters, options) => {
        requested.push(parameters.latitude);
        expect(options.maxDispatches).toBe(2);
        options.onDispatch(2);
        return { results: [1, requested.length === 1 ? 2 : 3].map((id) => ({
          placeId: `road-${requested.length}-${id}`, types: ['route'], granularity: 'GEOMETRIC_CENTER',
          location: parameters,
          addressComponents: [
            { longText: `Test Road ${id}`, types: ['route'] }, { longText: 'Lagos', types: ['locality'] },
            { longText: 'Lagos State', types: ['administrative_area_level_1'] },
            { longText: 'Ikeja', types: ['sublocality_level_1'] }, { shortText: 'NG', types: ['country'] }
          ]
        })) };
      } }
    });
    const options = { cacheDir, maxRecords: 3, perLocality: 3, maxBytes: 1024, retainRaw: false };
    const first = await adapters.materialize(shard, discovery, options);
    expect(first).toMatchObject({ sourceComplete: false, metrics: { processedCount: 1, acceptedCount: 2, requestCount: 2 } });
    const final = await adapters.materialize(shard, discovery, options);
    expect(final).toMatchObject({ sourceComplete: true, metrics: { processedCount: 2, acceptedCount: 3,
      requestCount: 4, runRequestCount: 2, duplicateCount: 1 } });
    expect(new Set(requested).size).toBe(2);
    expect((await readFile(final.file, 'utf8')).trim().split('\n')).toHaveLength(3);
  });

  it('separates the upstream raw version from the adapter output version', async () => {
    const adapters = createSourceAdapters({
      fetchImpl: async (input, init = {}) => {
        const url = String(input);
        if (url.endsWith('index-v1-nogeom.json')) {
          return Response.json({ features: [{
            properties: {
              id: 'nigeria',
              urls: { pbf: 'https://download.geofabrik.de/africa/nigeria-latest.osm.pbf' }
            }
          }] });
        }
        if (init.method === 'HEAD') {
          return new Response(null, { status: 200, headers: {
            'last-modified': 'Wed, 19 Aug 2026 00:00:00 GMT',
            etag: 'upstream-etag',
            'content-length': '710198957'
          } });
        }
        throw new Error(`Unexpected request: ${url}`);
      }
    });
    await expect(adapters.discover({
      id: 'google-residential-enrichment-ng', countryCode: 'NG', extractId: 'nigeria',
      source: { id: 'google-residential-enrichment', adapter: 'google-residential-enrichment' }
    }, {})).resolves.toMatchObject({
      version: sourceAdapterRevisions['google-residential-enrichment'],
      rawVersion: '2026-08-19-upstream-etag',
      sourceBytes: 710198957
    });
  });

  it('resumes a valid local checkpoint without probing unavailable PBF metadata', async () => {
    const cacheDir = resolve('.data-cache', `google-residential-discovery-resume-${process.pid}-${Date.now()}`);
    directories.push(cacheDir);
    const shard = {
      id: 'google-residential-enrichment-th', countryCode: 'TH', extractId: 'thailand',
      source: { id: 'google-residential-enrichment', adapter: 'google-residential-enrichment' }
    };
    const dataUrl = 'https://download.geofabrik.de/asia/thailand-latest.osm.pbf';
    const rawVersion = '2026-08-31-upstream-etag';
    const rawContent = Buffer.from('pbf');
    const sourceChecksum = createHash('sha256').update(rawContent).digest('hex');
    const rawIdentity = createHash('sha256').update(`${dataUrl}\u001f${rawVersion}`).digest('hex').slice(0, 16);
    const rawRoot = resolve(cacheDir, 'raw');
    const stateDirectory = resolve(rawRoot, `${shard.id}-state-fixture`);
    await mkdir(stateDirectory, { recursive: true });
    await writeFile(resolve(rawRoot, `${rawIdentity}-thailand-latest.osm.pbf`), rawContent);
    await writeFile(resolve(stateDirectory, 'progress.json'), `${JSON.stringify({
      schemaVersion: 2,
      version: sourceAdapterRevisions['google-residential-enrichment'],
      rawVersion,
      sourceChecksum,
      nextIndex: 1,
      accepted: 1
    })}\n`, 'utf8');

    const requests = [];
    const adapters = createSourceAdapters({
      fetchImpl: async (input, init = {}) => {
        const url = String(input);
        requests.push({ url, method: init.method || 'GET' });
        if (url.endsWith('index-v1-nogeom.json')) {
          return Response.json({ features: [{
            properties: { id: 'thailand', urls: { pbf: dataUrl } }
          }] });
        }
        if (url === dataUrl && init.method === 'HEAD') return new Response(null, { status: 503 });
        throw new Error(`Unexpected request: ${url}`);
      }
    });

    await expect(adapters.discover(shard, { cacheDir })).resolves.toMatchObject({
      adapter: 'google-residential-enrichment',
      version: sourceAdapterRevisions['google-residential-enrichment'],
      rawVersion,
      dataUrl,
      sourceBytes: rawContent.byteLength,
      estimateMethod: 'resumable-checkpoint'
    });
    expect(requests.filter((request) => request.url === dataUrl)).toHaveLength(0);
  });

  it('resumes a checkpoint keyed by the -latest URL after dated extract resolution', async () => {
    const cacheDir = resolve('.data-cache', `google-residential-legacy-resume-${process.pid}-${Date.now()}`);
    directories.push(cacheDir);
    const shard = {
      id: 'google-residential-enrichment-vn', countryCode: 'VN', extractId: 'vietnam',
      source: { id: 'google-residential-enrichment', adapter: 'google-residential-enrichment' }
    };
    const latestUrl = 'https://download.geofabrik.de/asia/vietnam-latest.osm.pbf';
    const rawVersion = '2026-09-28-upstream-etag';
    const rawContent = Buffer.from('pbf');
    const rawIdentity = createHash('sha256').update(`${latestUrl}${rawVersion}`).digest('hex').slice(0, 16);
    const rawRoot = resolve(cacheDir, 'raw');
    const stateDirectory = resolve(rawRoot, `${shard.id}-state-fixture`);
    await mkdir(stateDirectory, { recursive: true });
    await writeFile(resolve(rawRoot, `${rawIdentity}-vietnam-latest.osm.pbf`), rawContent);
    await writeFile(resolve(stateDirectory, 'progress.json'), `${JSON.stringify({
      schemaVersion: 2, version: sourceAdapterRevisions['google-residential-enrichment'], rawVersion,
      sourceChecksum: createHash('sha256').update(rawContent).digest('hex'), nextIndex: 1, accepted: 1
    })}
`, 'utf8');
    const adapters = createSourceAdapters({
      resolveGeofabrikUrl: async () => 'https://download.geofabrik.de/asia/vietnam-260929.osm.pbf',
      fetchImpl: async (input) => String(input).endsWith('index-v1-nogeom.json')
        ? Response.json({ features: [{ properties: { id: 'vietnam', urls: { pbf: latestUrl } } }] })
        : new Response('unexpected', { status: 500 })
    });
    await expect(adapters.discover(shard, { cacheDir })).resolves.toMatchObject({
      dataUrl: latestUrl, rawVersion, sourceBytes: rawContent.byteLength, estimateMethod: 'resumable-checkpoint'
    });
  });

  it('fails closed when a valid Google checkpoint has lost its raw source file', async () => {
    const cacheDir = resolve('.data-cache', `google-residential-missing-raw-${process.pid}-${Date.now()}`);
    directories.push(cacheDir);
    const shard = {
      id: 'google-residential-enrichment-th', countryCode: 'TH', extractId: 'thailand',
      source: { id: 'google-residential-enrichment', adapter: 'google-residential-enrichment' }
    };
    const dataUrl = 'https://download.geofabrik.de/asia/thailand-latest.osm.pbf';
    const rawVersion = '2026-08-31-upstream-etag';
    const stateDirectory = resolve(cacheDir, 'raw', `${shard.id}-state-fixture`);
    await mkdir(stateDirectory, { recursive: true });
    await writeFile(resolve(stateDirectory, 'progress.json'), `${JSON.stringify({
      schemaVersion: 2, version: sourceAdapterRevisions['google-residential-enrichment'], rawVersion,
      sourceChecksum: 'a'.repeat(64), nextIndex: 1, accepted: 1
    })}\n`, 'utf8');
    const adapters = createSourceAdapters({
      fetchImpl: async (input) => String(input).endsWith('index-v1-nogeom.json')
        ? Response.json({ features: [{ properties: { id: 'thailand', urls: { pbf: dataUrl } } }] })
        : new Response('unexpected', { status: 500 })
    });
    await expect(adapters.discover(shard, { cacheDir })).rejects.toMatchObject({ code: 'SOURCE_STATE_INVALID' });
  });

  it('stops a low-yield country after the bounded pilot', async () => {
    const cacheDir = resolve('.data-cache', `google-residential-pilot-${process.pid}-${Date.now()}`);
    directories.push(cacheDir);
    const shard = {
      id: 'google-residential-enrichment-ng', countryCode: 'NG', maxRecords: 4,
      source: {
        adapter: 'google-residential-enrichment', maxRequestsPerRun: 4,
        pilotRequests: 3, minimumPilotAccepted: 1
      },
      qualityGate: { minimumRecords: 1 }
    };
    const discovery = {
      adapter: 'google-residential-enrichment',
      version: sourceAdapterRevisions['google-residential-enrichment'],
      dataUrl: 'https://download.geofabrik.de/africa/nigeria-latest.osm.pbf',
      sourceBytes: 3,
      excludeBoundaryUrls: []
    };
    const seeds = [1, 2, 3, 4].map((number) => ({
      id: `way/${number}`, building_id: `way/${number}`, building_class: 'house',
      latitude: 6.5 + number / 10_000, longitude: 3.3 + number / 10_000,
      ring: [[3.2, 6.4], [3.4, 6.4], [3.4, 6.6], [3.2, 6.6], [3.2, 6.4]]
    }));
    const execute = async ({ args }) => {
      await writeFile(args[args.indexOf('--output') + 1], `${seeds.map(JSON.stringify).join('\n')}\n`, 'utf8');
    };
    let requests = 0;
    const adapters = createSourceAdapters({
      fetchImpl: async () => new Response('pbf'), execute, pythonBin: 'python-fixture',
      credentialBrokerClient: { request: async () => { requests += 1; return {}; } }
    });
    await expect(adapters.materialize(shard, discovery, {
      cacheDir, maxRecords: 4, perLocality: 4, maxBytes: 1024, retainRaw: false
    })).rejects.toMatchObject({
      code: 'SOURCE_QUALITY_FAILED',
      metrics: {
        pilotRequests: 3, minimumPilotAccepted: 1, pilotFailed: true,
        geocodeRejectionReasons: { invalid_response: 3 }
      }
    });
    expect(requests).toBe(3);
  });

  it('continues after one strictly valid pilot result instead of discarding a low-yield country', async () => {
    const cacheDir = resolve('.data-cache', `google-residential-low-yield-${process.pid}-${Date.now()}`);
    directories.push(cacheDir);
    const shard = {
      id: 'google-residential-enrichment-ng', countryCode: 'NG', maxRecords: 4,
      source: {
        adapter: 'google-residential-enrichment', maxRequestsPerRun: 4,
        pilotRequests: 3, minimumPilotAccepted: 1
      },
      qualityGate: { minimumRecords: 1 }
    };
    const discovery = {
      adapter: 'google-residential-enrichment',
      version: sourceAdapterRevisions['google-residential-enrichment'],
      dataUrl: 'https://download.geofabrik.de/africa/nigeria-latest.osm.pbf',
      sourceBytes: 3, excludeBoundaryUrls: []
    };
    const seeds = [1, 2, 3, 4].map((number) => ({
      id: `way/${number}`, building_id: `way/${number}`, building_class: 'house',
      latitude: 6.5 + number / 10_000, longitude: 3.3 + number / 10_000,
      ring: [[3.2, 6.4], [3.4, 6.4], [3.4, 6.6], [3.2, 6.6], [3.2, 6.4]]
    }));
    const execute = async ({ args }) => {
      await writeFile(args[args.indexOf('--output') + 1], `${seeds.map(JSON.stringify).join('\n')}\n`, 'utf8');
    };
    let requests = 0;
    const adapters = createSourceAdapters({
      fetchImpl: async () => new Response('pbf'), execute, pythonBin: 'python-fixture',
      credentialBrokerClient: { request: async (_operation, parameters) => {
        requests += 1;
        if (requests !== 1) return {};
        return { results: [{
          placeId: 'google-ng-1', types: ['street_address'], granularity: 'ROOFTOP',
          location: { latitude: parameters.latitude, longitude: parameters.longitude },
          postalAddress: { regionCode: 'NG', postalCode: '100001' },
          addressComponents: [
            { longText: '12', types: ['street_number'] },
            { longText: 'Example Street', types: ['route'] },
            { longText: 'Example District', types: ['sublocality_level_1'] },
            { longText: 'Lagos', types: ['locality'] },
            { longText: 'Lagos', types: ['administrative_area_level_1'] },
            { longText: '100001', types: ['postal_code'] },
            { longText: 'Nigeria', shortText: 'NG', types: ['country'] }
          ]
        }] };
      } }
    });
    const materialized = await adapters.materialize(shard, discovery, {
      cacheDir, maxRecords: 4, perLocality: 4, maxBytes: 1024, retainRaw: false
    });
    expect(materialized).toMatchObject({
      sourceComplete: true,
      metrics: { acceptedCount: 1, rejectedCount: 3, geocodeRejectionReasons: { invalid_response: 3 } }
    });
    expect(requests).toBe(4);
    expect((await readFile(materialized.file, 'utf8')).trim().split('\n')).toHaveLength(1);
  });

  it('finishes when the seed count exactly matches the per-run request budget', async () => {
    const cacheDir = resolve('.data-cache', `google-residential-${process.pid}-${Date.now()}`);
    directories.push(cacheDir);
    const shard = {
      id: 'google-residential-enrichment-th',
      countryCode: 'TH',
      maxRecords: 2,
      source: { adapter: 'google-residential-enrichment', maxRequestsPerRun: 2 },
      qualityGate: { minimumRecords: 1 }
    };
    const discovery = {
      adapter: 'google-residential-enrichment',
      version: sourceAdapterRevisions['google-residential-enrichment'],
      dataUrl: 'https://download.geofabrik.de/asia/thailand-latest.osm.pbf',
      sourceBytes: 3,
      excludeBoundaryUrls: []
    };
    const seeds = [1, 2].map((number) => ({
      id: `way/${number}`,
      building_id: `way/${number}`,
      building_class: 'house',
      latitude: 13.75 + number / 10_000,
      longitude: 100.50 + number / 10_000,
      ring: [
        [100.49, 13.74], [100.52, 13.74], [100.52, 13.77],
        [100.49, 13.77], [100.49, 13.74]
      ]
    }));
    let seedArguments;
    const execute = async ({ args }) => {
      seedArguments = args;
      await writeFile(args[args.indexOf('--output') + 1], `${seeds.map(JSON.stringify).join('\n')}\n`, 'utf8');
    };
    let requests = 0;
    const adapters = createSourceAdapters({
      fetchImpl: async () => new Response('pbf'),
      execute,
      pythonBin: 'python-fixture',
      loadGoogleCoverageTargets: async () => [{
        id: 'city:1', kind: 'city', priority: 0, deficit: 5,
        latitude: 13.75, longitude: 100.5, regionId: 1, cityId: 1
      }],
      credentialBrokerClient: {
        request: async (_operation, parameters) => {
          requests += 1;
          return {
            status: 'OK',
            results: [{
              place_id: `place-${requests}`,
              types: ['street_address'],
              address_components: [
                { long_name: String(90 + requests), types: ['street_number'] },
                { long_name: 'ถนนพระรามที่ 1', types: ['route'] },
                { long_name: 'ปทุมวัน', types: ['sublocality_level_1'] },
                { long_name: 'กรุงเทพมหานคร', types: ['locality'] },
                { long_name: 'กรุงเทพมหานคร', types: ['administrative_area_level_1'] },
                { long_name: '10330', types: ['postal_code'] },
                { long_name: 'ประเทศไทย', short_name: 'TH', types: ['country'] }
              ],
              geometry: {
                location_type: 'ROOFTOP',
                location: { lat: parameters.latitude, lng: parameters.longitude }
              }
            }]
          };
        }
      }
    });
    const result = await adapters.materialize(shard, discovery, {
      cacheDir, maxRecords: 2, perLocality: 2, maxBytes: 1024, retainRaw: false
    });
    expect(result).toMatchObject({ sourceComplete: true, format: 'overture-jsonl' });
    expect(requests).toBe(2);
    expect(seedArguments).toContain('--coverage-targets');
    expect((await readFile(result.file, 'utf8')).trim().split('\n')).toHaveLength(2);
  });

  it('keeps quota checkpoints through cleanup and resumes without repeating Google requests', async () => {
    const cacheDir = resolve('.data-cache', `google-residential-resume-${process.pid}-${Date.now()}`);
    directories.push(cacheDir);
    const shard = {
      id: 'google-residential-enrichment-th', countryCode: 'TH', maxRecords: 3,
      source: { adapter: 'google-residential-enrichment', maxRequestsPerRun: 10 },
      qualityGate: { minimumRecords: 1 }
    };
    const discovery = {
      adapter: 'google-residential-enrichment',
      version: sourceAdapterRevisions['google-residential-enrichment'], rawVersion: '2026-08-19-fixture',
      dataUrl: 'https://download.geofabrik.de/asia/thailand-latest.osm.pbf',
      sourceBytes: 3, excludeBoundaryUrls: []
    };
    const seeds = [1, 2, 3].map((number) => ({
      id: `way/${number}`, building_id: `way/${number}`, building_class: 'house',
      latitude: 13.75 + number / 10_000, longitude: 100.50 + number / 10_000,
      ring: [[100.49, 13.74], [100.52, 13.74], [100.52, 13.77], [100.49, 13.77], [100.49, 13.74]]
    }));
    const execute = async ({ args }) => {
      await writeFile(args[args.indexOf('--output') + 1], `${seeds.map(JSON.stringify).join('\n')}\n`, 'utf8');
    };
    let firstRun = true;
    let runRequests = 0;
    const requestedCoordinates = [];
    const adapters = createSourceAdapters({
      fetchImpl: async () => new Response('pbf'), execute, pythonBin: 'python-fixture',
      credentialBrokerClient: {
        request: async (_operation, parameters) => {
          runRequests += 1;
          if (firstRun && runRequests === 2) throw Object.assign(new Error('quota wait'), {
            code: 'SOURCE_QUOTA_UNAVAILABLE', retryAt: '2026-08-20T00:00:00.000Z'
          });
          requestedCoordinates.push(`${parameters.latitude},${parameters.longitude}`);
          return {
            status: 'OK', results: [{
              place_id: `place-${parameters.latitude}`, types: ['street_address'],
              address_components: [
                { long_name: String(90 + requestedCoordinates.length), types: ['street_number'] },
                { long_name: 'ถนนพระรามที่ 1', types: ['route'] },
                { long_name: 'ปทุมวัน', types: ['sublocality_level_1'] },
                { long_name: 'กรุงเทพมหานคร', types: ['locality'] },
                { long_name: 'กรุงเทพมหานคร', types: ['administrative_area_level_1'] },
                { long_name: '10330', types: ['postal_code'] },
                { long_name: 'ประเทศไทย', short_name: 'TH', types: ['country'] }
              ],
              geometry: { location_type: 'ROOFTOP', location: {
                lat: parameters.latitude, lng: parameters.longitude
              } }
            }]
          };
        }
      }
    });
    const options = { cacheDir, maxRecords: 3, perLocality: 3, maxBytes: 1024, retainRaw: false };
    const obsoleteState = resolve(cacheDir, 'raw', `${shard.id}-state-obsolete-version`);
    await mkdir(obsoleteState, { recursive: true });
    await writeFile(resolve(obsoleteState, 'progress.json'), '{}\n', 'utf8');
    const partial = await adapters.materialize(shard, discovery, options);
    expect(partial).toMatchObject({ sourceComplete: false, metrics: {
      processedCount: 1, acceptedCount: 1, rejectedCount: 0, requestCount: 1, runRequestCount: 1
    } });

    const old = new Date('2026-08-19T00:00:00.000Z');
    const current = new Date('2026-08-19T08:00:00.000Z');
    const { readdir, stat, utimes } = await import('node:fs/promises');
    await expect(stat(obsoleteState)).rejects.toMatchObject({ code: 'ENOENT' });
    const stateRoot = resolve(cacheDir, 'raw');
    const stateName = (await readdir(stateRoot)).find((name) => name.includes('-state-'));
    const stateDirectory = resolve(stateRoot, stateName);
    for (const name of await readdir(stateDirectory)) await utimes(resolve(stateDirectory, name), old, old);
    await utimes(stateDirectory, old, old);
    await createSyncArtifactCleanup({
      cacheDir, now: () => current.getTime(), staleMs: 6 * 60 * 60_000,
      log: { log: () => {}, error: () => {} }
    }).runOnce();
    await expect(stat(stateDirectory)).resolves.toBeTruthy();

    firstRun = false;
    runRequests = 0;
    const completed = await adapters.materialize(shard, discovery, options);
    expect(completed).toMatchObject({ sourceComplete: true, metrics: {
      processedCount: 3, acceptedCount: 3, rejectedCount: 0, requestCount: 3, runRequestCount: 2
    } });
    expect(requestedCoordinates).toHaveLength(3);
    expect(new Set(requestedCoordinates).size).toBe(3);
    await expect(stat(stateDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readFile(completed.file, 'utf8')).trim().split('\n')).toHaveLength(3);
  });
});

describe('source record normalization', () => {
  it('keeps source unit semantics separate from building names', () => {
    const overture = normalizeSourceRecord({
      id: 'unit-3', admin1: 'California', locality: 'Berkeley', postal_city: 'Berkeley', postcode: '94704',
      street: 'College Avenue', number: '2704', unit: '3', longitude: -122.25, latitude: 37.86
    }, { id: 'fixture-us', countryCode: 'US', source }, 'overture-jsonl');
    const osm = normalizeSourceRecord({
      id: 'node/3', geometry: { type: 'Point', coordinates: [-0.12, 51.5] }, properties: {
        '@id': 'node/3', 'addr:housenumber': '21', 'addr:street': 'Baker Street', 'addr:city': 'London',
        'addr:postcode': 'NW1 6XE', 'addr:unit': '3', name: 'Baker House'
      }
    }, { id: 'fixture-gb', countryCode: 'GB', source: { ...source, adapter: 'geofabrik' } }, 'geofabrik-geojsonseq');
    expect(overture.components).toMatchObject({ unit: '3', buildingName: '' });
    expect(osm.components).toMatchObject({ unit: '3', buildingName: 'Baker House' });
  });

  it('does not treat OSM addr:place as a postal locality', () => {
    const record = normalizeSourceRecord({
      id: 'way/4', geometry: { type: 'Point', coordinates: [9.4, 42.3] }, properties: {
        '@type': 'way', '@id': 'way/4', 'addr:housenumber': '27', 'addr:street': 'Ortia',
        'addr:place': 'Poggiale', 'addr:city': 'Tarrano', 'addr:postcode': '20234', building: 'house'
      }
    }, { id: 'fixture-fr', countryCode: 'FR', source: { ...source, adapter: 'geofabrik' } }, 'geofabrik-geojsonseq');
    expect(record.components).toMatchObject({ locality: 'Tarrano', postalLocality: 'Tarrano', street: 'Ortia' });
  });

  it.each([
    ['TH', {
      'addr:province': 'กรุงเทพมหานคร', 'addr:district': 'เขตวัฒนา', 'addr:subdistrict': 'แขวงคลองตันเหนือ',
      'addr:postcode': '10110'
    }, { admin1: 'กรุงเทพมหานคร', locality: 'เขตวัฒนา', district: 'แขวงคลองตันเหนือ' }],
    ['PH', {
      'addr:province': 'Metro Manila', 'addr:city': 'Quezon City', 'addr:barangay': 'Bagumbayan',
      'addr:postcode': '1110'
    }, { admin1: 'Metro Manila', locality: 'Quezon City', district: 'Bagumbayan' }],
    ['VN', {
      'addr:province': 'Thành phố Hồ Chí Minh', 'addr:city': 'Thành phố Hồ Chí Minh', 'addr:ward': 'Phường Bến Thành',
      'addr:postcode': '70000'
    }, { admin1: 'Thành phố Hồ Chí Minh', locality: 'Phường Bến Thành', district: '' }]
  ])('maps current %s OSM administrative address tags', (countryCode, addressTags, expected) => {
    const record = normalizeSourceRecord({
      id: `way/${countryCode}`, geometry: { type: 'Point', coordinates: [100.5, 13.7] },
      properties: {
        '@type': 'way', '@id': `way/${countryCode}`, 'addr:housenumber': '10',
        'addr:street': 'Source Street', building: 'house', ...addressTags
      }
    }, { id: `fixture-${countryCode}`, countryCode, source: { ...source, adapter: 'geofabrik' } }, 'geofabrik-geojsonseq');
    expect(record.components).toMatchObject(expected);
  });

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

  it('normalizes an official Singapore HDB building with complete postal evidence', () => {
    const record = normalizeSourceRecord({
      id: 'hdb-building:8003:948044', source_record_id: 'hdb-building:8003:948044',
      source_dataset: 'HDB Property Information + HDB Existing Building',
      country: 'SG', admin1: 'Singapore', locality: 'Jurong West', postal_city: 'Singapore',
      address_levels: ['Singapore', 'Jurong West'], postcode: '600277', street: 'TOH GUAN RD', number: '277',
      longitude: 103.7466, latitude: 1.3413, property_type: 'apartment',
      residential_building_id: 'hdb-property:277:TOG', residential_building_class: 'apartments'
    }, {
      id: 'singapore-hdb-residential', countryCode: 'SG',
      source: { ...source, adapter: 'singapore-hdb' }
    }, 'overture-jsonl');
    expect(record).toMatchObject({
      countryCode: 'SG', admin1: 'Singapore', locality: 'Jurong West', postalLocality: 'Singapore',
      postcode: '600277', street: 'TOH GUAN RD', houseNumber: '277', propertyType: 'apartment',
      residentialSourceRecordId: 'hdb-property:277:TOG', residentialSourceClass: 'apartments',
      evidenceClass: 'official-address-point'
    });
  });

  it.each([
    ['JP', ['東京都', '杉並区', '永福'], '東京都', '杉並区', '永福'],
    ['MX', ['México', 'Texcoco', 'San Mateo'], 'México', 'Texcoco', 'San Mateo'],
    ['TW', ['臺北市', '中正區', '幸福里'], '臺北市', '中正區', '幸福里'],
    ['TW', ['台東縣', '台東市', '中正里'], '臺東縣', '臺東市', '中正里']
  ])('maps Overture address levels into complete %s administration', (countryCode, addressLevels, admin1, locality, district) => {
    const record = normalizeSourceRecord({
      id: `overture-${countryCode}`, country: countryCode, address_levels: addressLevels,
      postcode: countryCode === 'JP' ? '1680064' : countryCode === 'MX' ? '56233' : '100',
      street: 'Source Street', number: '10', longitude: 121.5, latitude: 25
    }, { id: `fixture-${countryCode}`, countryCode, source }, 'overture-jsonl');
    expect(record.components).toMatchObject({ admin1, locality, district });
  });

  it('maps Taiwan county and district below an English source region', () => {
    const record = normalizeSourceRecord({
      id: 'overture-tw-hierarchy', country: 'TW', address_levels: ['Taipei', '臺北市', '中正區'],
      postal_city: '臺北市', postcode: '100', street: '忠孝東路', number: '10', longitude: 121.52, latitude: 25.04
    }, { id: 'fixture-tw', countryCode: 'TW', source }, 'overture-jsonl');
    expect(record.components).toMatchObject({
      admin1: '臺北市', locality: '中正區', postalLocality: '中正區', district: ''
    });
  });

  it('exports the NL single address level as both admin1 and locality for import-time re-anchoring', () => {
    // Overture NL (BAG) address_levels carry only the city; the exporter therefore
    // emits the city name into admin1. The catalog anchoring step inside
    // PostgresAddressImporter is responsible for replacing it with the province.
    const record = normalizeSourceRecord({
      id: 'overture-nl', country: 'NL', admin1: 'Domburg', locality: 'Domburg',
      postal_city: 'Domburg', address_levels: ['Domburg'], postcode: '4357 HC',
      street: 'Ooststraat', number: '11', longitude: 3.4939, latitude: 51.5564
    }, { id: 'fixture-nl', countryCode: 'NL', source }, 'overture-jsonl');
    expect(record.components).toMatchObject({ admin1: 'Domburg', locality: 'Domburg', district: '' });
  });

  it.each(['JP', 'MX', 'TW'])('does not duplicate a two-level %s hierarchy into district', (countryCode) => {
    const record = normalizeSourceRecord({
      id: `overture-two-level-${countryCode}`, country: countryCode, address_levels: ['Region', 'Municipality'],
      postcode: '12345', street: 'Source Street', number: '10', longitude: 1, latitude: 1
    }, { id: `fixture-${countryCode}`, countryCode, source }, 'overture-jsonl');
    expect(record.components).toMatchObject({ admin1: 'Region', locality: 'Municipality', district: '' });
  });

  it('keeps the verified Japanese OSM residential building name for blacklist screening', () => {
    const record = normalizeSourceRecord({
      id: 'abr-jp', source_record_id: 'abr-jp', source_dataset: 'Digital Agency Address Base Registry via Geolonia',
      address_levels: ['東京都', '新宿区', '新宿'], postal_city: '新宿区', postcode: '1600022',
      street: '新宿六丁目', number: '10番11号', building_name: '新宿レジデンス',
      longitude: 139.707, latitude: 35.694, property_type: 'apartment',
      residential_building_id: 'way/10', residential_building_class: 'apartments'
    }, { id: 'fixture-jp', countryCode: 'JP', source }, 'overture-jsonl');
    expect(record).toMatchObject({ buildingName: '新宿レジデンス', propertyType: 'apartment' });
    expect(normalizeSourceRecord({
      id: 'abr-jp-public', address_levels: ['兵庫県', '神戸市', '有馬町'], postal_city: '神戸市',
      postcode: '6511401', street: '有馬町一丁目', number: '1番1号', building_name: '市立有馬地域福祉センター',
      longitude: 135.25, latitude: 34.8, property_type: 'residential',
      residential_building_id: 'way/11', residential_building_class: 'residential'
    }, { id: 'fixture-jp', countryCode: 'JP', source }, 'overture-jsonl')).toMatchObject({
      propertyType: 'unknown', residentialSourceRecordId: '', residentialSourceClass: ''
    });
  });

  it('maps the most detailed Italian address level to locality', () => {
    const record = normalizeSourceRecord({
      id: 'overture-it', country: 'IT', address_levels: ['Sardegna', 'Sud Sardegna', 'Teulada'],
      street: 'Via Sulcis', number: '95', longitude: 8.77, latitude: 38.97
    }, { id: 'fixture-it', countryCode: 'IT', source }, 'overture-jsonl');
    expect(record.components).toMatchObject({ admin1: 'Sardegna', locality: 'Teulada', district: 'Sud Sardegna' });
  });

  it('keeps premise identity stable when source coordinates drift slightly', () => {
    const sourceRecord = {
      id: 'address-1', admin1: 'Pennsylvania', locality: 'Philadelphia', postal_city: 'Philadelphia',
      postcode: '19103', street: 'Market Street', number: '1700', longitude: -75.169, latitude: 39.953
    };
    const first = normalizeSourceRecord(sourceRecord, { id: 'fixture-us', countryCode: 'US', source }, 'overture-jsonl');
    const second = normalizeSourceRecord({ ...sourceRecord, id: 'address-2', longitude: -75.169004, latitude: 39.953004 },
      { id: 'fixture-us', countryCode: 'US', source }, 'overture-jsonl');
    expect(second?.canonicalKey).toBe(first?.canonicalKey);
  });

  it('uses the containing OSM building as independent residential evidence', () => {
    const record = normalizeSourceRecord({
      id: 'node/9', geometry: { type: 'Point', coordinates: [-75.16, 39.95] },
      properties: {
        '@type': 'node', '@id': 'node/9', 'addr:housenumber': '12', 'addr:street': 'Bank Street',
        'addr:city': 'Philadelphia', name: 'Ground-floor tenant',
        residential_building_id: 'way/88', residential_building_class: 'apartments'
      }
    }, { id: 'fixture-us', countryCode: 'US', source: { ...source, adapter: 'geofabrik' } }, 'geofabrik-geojsonseq');
    expect(record).toMatchObject({
      sourceRecordId: 'node/9', propertyType: 'apartment',
      residentialSourceRecordId: 'way/88', residentialSourceClass: 'building=apartments', buildingName: ''
    });
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
    expect(localized.localizations.native.components).toMatchObject({ admin1: '九龍', street: '正德街', unit: '龍安樓' });
    expect(localized.localizations.en.components).toMatchObject({ admin1: 'Kowloon', street: 'Ching Tak Street', unit: 'Lung On House' });
    expect(localized.localizations.en.components.unit).not.toMatch(/[\p{Script=Han}]/u);
  });

  it('removes bilingual separators from Hong Kong native administrative fields', async () => {
    const record = normalizeSourceRecord({
      id: 'hk-bilingual-separator', admin1: '香港島 & Hong Kong Island',
      locality: '中西區 & Central and Western District', postal_city: '中西區 & Central and Western District',
      street: '皇后大道中 Queensway', number: '8', longitude: 114.16, latitude: 22.28
    }, { id: 'fixture-hk', countryCode: 'HK', source }, 'overture-jsonl');
    expect(record).toMatchObject({ admin1: '香港島', locality: '中西區', postalLocality: '中西區' });
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
    expect(localized[0].localizations['zh-CN'].formattedAddress).toBe('美国宾夕法尼亚州费城市场街1700 19103');
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
    expect(localizedHongKong.localizations.en.components).toMatchObject({ admin1: 'Kowloon', street: 'Ching Tak Street', unit: 'Lung On House' });
    expect(localizedHongKong.localizations['zh-CN'].components).toMatchObject({ admin1: '九龙', street: '正德街', unit: '龙安楼' });
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
  it('retries a deterministic quality failure only after the source capability changes', async () => {
    const cacheDir = resolve('.data-cache', 'sync-etl-tests', randomUUID());
    directories.push(cacheDir);
    let materializations = 0;
    const run = (capability) => runAddressEtl({
      cacheDir,
      catalog: { schemaVersion: 1, shards: [{
        id: 'fixture-us', countryCode: 'US', intervalDays: 30, maxRecords: 10,
        source: { ...source, capabilityInputs: { extractor: capability } }
      }] },
      requestedShards: ['fixture-us'],
      force: true,
      syncMode: 'manual',
      maxRecords: 10,
      perLocality: 2,
      importer: { importShard: vi.fn() },
      adapters: {
        discover: async () => ({
          adapter: 'overture', version: 'fixed-source-version', dataUrl: source.dataUrl,
          sourceBytes: 0, estimateMethod: 'fixture'
        }),
        materialize: async () => {
          materializations += 1;
          throw Object.assign(new Error('fixture snapshot rejected'), { code: 'SNAPSHOT_QUALITY_FAILED' });
        }
      }
    });

    await expect(run('v1')).rejects.toThrow('Address sync failed for 1 country shard');
    await expect(run('v1')).resolves.toMatchObject({
      reports: [expect.objectContaining({ status: 'source-quality-failed', skipped: true })]
    });
    expect(materializations).toBe(1);

    await expect(run('v2')).rejects.toThrow('Address sync failed for 1 country shard');
    expect(materializations).toBe(2);
  });

  it('uses bounded multi-asset Overture sampling and addressed OSM ways', async () => {
    const overture = (await readFile('server/sync/overture-export.py', 'utf8')).replace(/\r\n/g, '\n');
    const geofabrik = (await readFile('server/sync/geofabrik-export.py', 'utf8')).replace(/\r\n/g, '\n');
    const japanAbr = (await readFile('server/sync/japan-abr-export.py', 'utf8')).replace(/\r\n/g, '\n');
    const openAddresses = (await readFile('server/sync/openaddresses-export.py', 'utf8')).replace(/\r\n/g, '\n');
    const inegiResidential = (await readFile('server/sync/inegi-residential-export.py', 'utf8')).replace(/\r\n/g, '\n');
    const adapterSource = (await readFile('server/sync/source-adapters.mjs', 'utf8')).replace(/\r\n/g, '\n');
    expect(geofabrik).not.toContain('--communities-file');
    expect(overture).toContain('candidate_limit');
    expect(overture).toContain('candidate_multiplier = 12 if args.candidate_jsonl else 4');
    expect(overture).toContain('per_asset_limit = max(1, math.ceil(candidate_limit / len(assets)))');
    expect(overture).toContain('candidate_sources = "\\nUNION ALL\\n".join(asset_queries)');
    expect(overture).toContain('--bounds-extra');
    expect(overture).toContain("def box_predicate(longitude_column, latitude_column, boxes):");
    expect(overture).toContain('box_predicate(\'longitude\', \'latitude\', box_areas)');
    expect(overture).toContain("bbox_predicate('bbox.xmin', 'bbox.xmax', 'bbox.ymin', 'bbox.ymax', box_areas)");
    expect(overture).toContain('--building-assets-file');
    expect(overture).toContain('--candidate-jsonl');
    expect(overture).toContain("FROM read_json_auto({sql_string(str(candidate_file))}");
    expect(overture).toContain('ST_Intersects(address_candidates.geometry, residential_buildings.geometry)');
    expect(overture).not.toContain('residential_probe_limit');
    expect(overture).not.toContain('residential_grid_limit');
    expect(overture).toContain('residential_grid_scale = 4');
    expect(overture).toContain('count(*) AS address_count');
    expect(overture).toContain('ORDER BY address_count DESC, grid_latitude, grid_longitude');
    expect(overture).toContain('JOIN residential_grids ON');
    expect(overture).toContain("list_transform(address_levels");
    expect(overture).toContain("coalesce(address_levels[-1].value, '') AS district");
    expect(overture).toContain('FROM address_candidates\n    LEFT JOIN classified');
    expect(overture.indexOf('JOIN classified ON classified.address_id')).toBeLessThan(
      overture.indexOf('residential_locality_rank <= {rank_limit}')
    );
    expect(overture).toContain('LIMIT {args.max_records}');
    expect(overture).toContain('Residential building classification failed; exporting address-only fallback');
    expect(overture).not.toContain('USING SAMPLE system(25 PERCENT)');
    expect(overture).toContain('PARTITION BY coalesce(nullif(trim(address_candidates.admin1)');
    expect(overture).toContain('residential_locality_rank');
    expect(overture).toContain('SET http_keep_alive=true');
    expect(overture).toContain('SET http_retries=10');
    expect(openAddresses).toContain('required_mapping = {"id", "number", "street", "district", "locality", "admin1", "postcode", "longitude", "latitude"}');
    expect(openAddresses).toContain('while len(selected) < candidate_limit:');
    expect(inegiResidential).toContain('normalized(row.get("TIPODOM")) != "VIVIENDA"');
    expect(inegiResidential).toContain('POSTCODE_PATTERN.fullmatch(postcode)');
    expect(inegiResidential).toContain('inverse_inegi_lambert(*point)');
    expect(inegiResidential).toContain('"residential_building_class": "dwelling_house"');
    expect(adapterSource).toContain('return distance(left) - distance(right)');
    expect(adapterSource).toContain("['-4', '-sSLI', '--connect-timeout', '15', '--max-time', '60', url]");
    expect(adapterSource).toContain("expectedBytes: discovery.postcodeDataFormat === 'pdf' ? null : discovery.postcodeBytes");
    expect(geofabrik).toContain('def way(self, way, tags=None)');
    expect(geofabrik).not.toContain('def area(self, area)');
    expect(geofabrik).toContain('osmium.FileProcessor(args.input).with_locations(location_storage).with_filter(KeyFilter(');
    expect(geofabrik).toContain('sparse_file_array,{location_index}');
    expect(geofabrik).toContain('prepare(self.geometry)');
    expect(geofabrik).toContain('contains_xy(self.geometry, longitude, latitude)');
    expect(geofabrik).toContain('intersects_xy(self.hole_boundaries, longitude, latitude)');
    expect(geofabrik).toContain('self.capture(');
    expect(geofabrik).toContain('self.residential_limit = max_records');
    expect(geofabrik).toContain('self.points_by_tile = {}');
    expect(geofabrik).not.toContain('sqlite3');
    expect(geofabrik).toContain('if not point_in_ring(longitude, latitude, ring):');
    expect(geofabrik).toContain('properties["residential_building_id"] = residential_building[0]');
    expect(geofabrik).toContain('non_residential = has_non_residential_poi(tags)');
    expect(geofabrik).toContain('properties.pop("name", None)');
    expect(geofabrik).toContain('selected_matches = matcher.selected_matches(args.max_records)');
    expect(geofabrik).toContain('max_records / 10');
    expect(geofabrik).toContain('self.group_limit = max(1, min(per_locality, max_records))');
    expect(geofabrik).toContain('"addr:subdistrict", "addr:barangay", "addr:ward", "addr:commune"');
    expect(geofabrik).toContain('VietnamPostcodes(args.postcode_pdf)');
    expect(geofabrik).toContain('is_residential = not street_level and not non_residential');
    expect(geofabrik).toContain('class PhilippinePostcodes');
    expect(geofabrik).toContain('if len(entries) < 900:');
    expect(geofabrik).toContain('if args.postcode_html and args.country != "PH"');
    expect(geofabrik).toContain('residential_selected = sorted(');
    expect(geofabrik).toContain('residential_selected + selected');
    expect(japanAbr).toContain('def match_plateau_buildings(connection, parquet_path, start_offset=0, progress=None):');
    expect(japanAbr).toContain('max(city_limit, 2_000)');
    expect(japanAbr).toContain('heapq.heapreplace(candidates, item)');
    expect(japanAbr).toContain("WHERE usage='residential'");
    expect(japanAbr).toContain('self.tree.query(geometries, predicate="contains")');
    expect(japanAbr).toContain('match_residential_buildings(');
    expect(japanAbr).toContain('POSTAL_RANGE_PATTERN');
    expect(japanAbr).toContain('street = clean(lines[0])');
    expect(japanAbr).toContain('if not district or district == street or not postcode:');
    expect(japanAbr).toContain('building_class not in RESIDENTIAL_BUILDINGS');
    expect(japanAbr).toContain('any(clean(tags.get(key)) not in {"", "no", "none"}');
    expect(japanAbr).toContain('checkpoint["osm_scanned_ways"] = scanned_ways');
    expect(japanAbr).toContain('FROM candidates WHERE building_id IS NOT NULL');
    expect(japanAbr).toContain('"residential_building_id": building_id');
    expect(japanAbr).toContain('def match_city_lots(connection, lots, buildings, claimed_buildings, progress=None):');
    expect(japanAbr).toContain('def insert_land_lot_candidates(connection, candidates, batch_size=LAND_LOT_INSERT_BATCH, progress=None):');
    expect(japanAbr).toContain('connection.executemany');
    expect(japanAbr).toContain('INSERT INTO candidates');
    expect(japanAbr).not.toContain('source_id TEXT UNIQUE');
    expect(japanAbr).toContain('checkpoint["plateau_building_completed"]');
    expect(japanAbr).toContain('checkpoint["land_lot_candidate_count"]');
    expect(japanAbr).toContain('SET memory_limit=?');
    expect(japanAbr).toContain('SET temp_directory=?');
    expect(japanAbr).toContain('residential_matches[lot_id] == 1 and blocked_matches[lot_id] == 0');
    expect(japanAbr).toContain('if building_lot_counts.get(building_uid) != 1:');
    expect(japanAbr).toContain('if building_id in claimed_buildings:');
  });

  it('corrects a conflicting region from its polygon and rejects points outside the country', async () => {
    const directory = resolve('.data-cache', 'sync-etl-tests', randomUUID());
    directories.push(directory);
    await mkdir(directory, { recursive: true });
    const file = resolve(directory, 'regions.jsonl');
    const base = { locality: 'Philadelphia', postal_city: 'Philadelphia', postcode: '19103', street: 'Market Street', longitude: -75.169, latitude: 39.953 };
    await writeFile(file, `${[
      { ...base, id: 'wrong-state', admin1: 'New Jersey', number: '1700', admin_region: { region: { name: 'Pennsylvania', nameEn: 'Pennsylvania', code: 'US-PA' } } },
      { ...base, id: 'abroad', admin1: 'Pennsylvania', number: '1701', admin_region: { outside: true } }
    ].map(JSON.stringify).join('\n')}\n`, 'utf8');
    const database = openTestDatabase(':memory:');
    const importer = new PostgresAddressImporter({
      database, normalizeRecord: normalizeSourceRecord, hash: (value) => createHash('sha256').update(value).digest('hex'),
      localizeRecords: async (records) => records.map((record) => ({
        ...record,
        localizations: Object.fromEntries(['native', 'en', 'zh-CN'].map((language) => [language, {
          components: record.components, formattedAddress: record.formattedAddress, source: 'source'
        }]))
      }))
    });
    const result = await importer.importShard({
      shard: { id: 'fixture-us', countryCode: 'US', source },
      discovery: { version: '2026-10-11.0', publishedAt: '2026-10-11T00:00:00Z', dataUrl: source.dataUrl, sourceBytes: 1 },
      materialized: { file, format: 'overture-jsonl', checksum: 'c'.repeat(64), cacheBytes: 1 },
      maxRecords: 10, perLocality: 2
    });
    expect(result).toMatchObject({ acceptedCount: 1, rejectionReasons: { invalid_administrative_hierarchy: 1 } });
    expect(await database.prepare('SELECT admin1,admin1_code FROM address_pool').first()).toEqual({ admin1: 'Pennsylvania', admin1_code: 'PA' });
  });

  it('atomically imports localized records, evidence and coverage into PostgreSQL', async () => {
    const directory = resolve('.data-cache', 'sync-etl-tests', randomUUID());
    directories.push(directory);
    await mkdir(directory, { recursive: true });
    const file = resolve(directory, 'fixture.jsonl');
    await writeFile(file, `${[{
      id: 'overture-1', admin1: 'Pennsylvania', locality: 'Philadelphia', postal_city: 'Philadelphia',
      postcode: '19103', street: 'Market\u2028Street', number: '1700', longitude: -75.169, latitude: 39.953,
      property_type: 'residential', residential_building_id: 'building-1', residential_building_class: 'house'
    }, {
      id: 'overture-address-only', admin1: 'Pennsylvania', locality: 'Philadelphia', postal_city: 'Philadelphia',
      postcode: '19103', street: 'Market Street', number: '1701', longitude: -75.168, latitude: 39.953
    }].map(JSON.stringify).join('\n')}\n`, 'utf8');
    const database = openTestDatabase(':memory:');
    const importer = new PostgresAddressImporter({
      database,
      normalizeRecord: normalizeSourceRecord,
      hash: (value) => createHash('sha256').update(value).digest('hex'),
      localizeRecords: async (records) => records.map((record) => ({
        ...record,
        localizations: Object.fromEntries(['native', 'en', 'zh-CN'].map((language) => [language, {
          components: language === 'zh-CN' ? {
            ...record.components, street: '市场街', locality: '费城', postalLocality: '费城', admin1: '宾夕法尼亚州'
          } : record.components,
          formattedAddress: language === 'zh-CN' ? `美国宾夕法尼亚州费城市场街${record.components.houseNumber}号` : record.formattedAddress,
          source: language === 'native' ? 'source' : 'fixture-translator'
        }]))
      }))
    });
    const result = await importer.importShard({
      shard: { id: 'fixture-us', countryCode: 'US', source },
      discovery: { version: '2026-06-17.0', publishedAt: '2026-06-17T00:00:00Z', dataUrl: source.dataUrl, sourceBytes: 1234 },
      materialized: { file, format: 'overture-jsonl', checksum: 'b'.repeat(64), cacheBytes: 321, snapshotMode: 'authoritative' },
      maxRecords: 10,
      perLocality: 2
    });
    expect(result).toMatchObject({
      acceptedCount: 2, rejectedCount: 0, localityCount: 1, skipped: false,
      rejectionReasons: {},
      metrics: expect.objectContaining({ importRevision: 'strict-residential-v22' })
    });
    expect(await database.prepare('SELECT status,active_count FROM address_datasets WHERE id=?').bind(result.datasetId).first())
      .toMatchObject({ status: 'active', active_count: 2 });
    expect(await database.prepare('SELECT COUNT(*) AS count FROM address_pool_runtime').first('count')).toBe(2);
    expect(await database.prepare('SELECT COUNT(*) AS count FROM address_pool_evidence WHERE is_current=1').first('count')).toBe(3);
    expect(await database.prepare("SELECT source_record_id FROM address_pool_evidence WHERE evidence_type='residential_use'").first('source_record_id'))
      .toBe('building-1');
    expect(await database.prepare('SELECT COUNT(*) AS count FROM pool_coverage').first('count')).toBe(2);
    expect(await database.prepare('SELECT SUM(residential_count) AS count FROM pool_coverage').first('count')).toBe(1);
    const importerSource = await readFile('server/sync/postgres-address-importer.mjs', 'utf8');
    expect(importerSource).toContain('FROM address_pool address JOIN address_generation_index indexed');
    expect(importerSource).toContain('JOIN address_generation_index indexed');
    expect(importerSource).toContain('sum(indexed.residential_ready)');
    const aliasRetry = await importer.importShard({
      shard: { id: 'legacy-fixture-us', countryCode: 'US', source },
      discovery: { version: '2026-06-17.0', publishedAt: '2026-06-17T00:00:00Z', dataUrl: source.dataUrl, sourceBytes: 1234 },
      materialized: { file, format: 'overture-jsonl', checksum: 'b'.repeat(64), cacheBytes: 321, snapshotMode: 'authoritative' },
      maxRecords: 10,
      perLocality: 2
    });
    expect(aliasRetry).toMatchObject({ acceptedCount: 2, skipped: false });
    expect(await database.prepare('SELECT COUNT(*) AS count FROM address_datasets').first('count')).toBe(1);
    await writeFile(file, `${[{
      id: 'replacement-overlap', admin1: 'Pennsylvania', locality: 'Philadelphia', postal_city: 'Philadelphia',
      postcode: '19103', street: 'Market Street', number: '1700', longitude: -75.169, latitude: 39.953,
      property_type: 'residential', residential_building_id: 'replacement-building-1', residential_building_class: 'house'
    }, {
      id: 'overture-2', admin1: 'Pennsylvania', locality: 'Philadelphia', postal_city: 'Philadelphia',
      postcode: '19103', street: 'Market Street', number: '1800', longitude: -75.17, latitude: 39.954,
      property_type: 'residential', residential_building_id: 'building-2', residential_building_class: 'house'
    }].map(JSON.stringify).join('\n')}\n`, 'utf8');
    const replacementSource = { ...source, id: 'replacement-source', name: 'Replacement source' };
    const replacement = await importer.importShard({
      shard: { id: 'replacement-us', countryCode: 'US', source: replacementSource },
      discovery: { version: '2026-07-17.0', publishedAt: '2026-07-17T00:00:00Z', dataUrl: replacementSource.dataUrl, sourceBytes: 1234 },
      materialized: { file, format: 'overture-jsonl', checksum: 'd'.repeat(64), cacheBytes: 321 },
      maxRecords: 10,
      perLocality: 2
    });
    expect(replacement).toMatchObject({ acceptedCount: 2, skipped: false });
    expect(await database.prepare("SELECT COUNT(*) AS count FROM address_datasets WHERE status='active'").first('count')).toBe(2);
    expect(await database.prepare("SELECT COUNT(*) AS count FROM address_datasets WHERE status='retired'").first('count')).toBe(0);
    expect((await database.prepare("SELECT source_id FROM address_datasets WHERE status='active' ORDER BY source_id").all()).results
      .map(({ source_id }) => source_id)).toEqual(['fixture', 'replacement-source']);
    expect(await database.prepare('SELECT COUNT(*) AS count FROM address_pool_runtime').first('count')).toBe(3);
    expect(await database.prepare('SELECT SUM(active_count) AS count FROM pool_coverage').first('count')).toBe(3);

    await writeFile(file, `${[{
      id: 'overture-3', admin1: 'Pennsylvania', locality: 'Philadelphia', postal_city: 'Philadelphia',
      postcode: '19103', street: 'Market Street', number: '1900', longitude: -75.171, latitude: 39.955,
      property_type: 'residential', residential_building_id: 'building-3', residential_building_class: 'house'
    }, {
      id: 'overture-4', admin1: 'Pennsylvania', locality: 'Philadelphia', postal_city: 'Philadelphia',
      postcode: '19103', street: 'Market Street', number: '1901', longitude: -75.171, latitude: 39.955
    }].map(JSON.stringify).join('\n')}\n`, 'utf8');
    await importer.importShard({
      shard: { id: 'fixture-us', countryCode: 'US', source },
      discovery: { version: '2026-08-17.0', dataUrl: source.dataUrl },
      materialized: { file, format: 'overture-jsonl', checksum: 'e'.repeat(64), snapshotMode: 'authoritative' },
      maxRecords: 10,
      perLocality: 2
    });
    expect(await database.prepare("SELECT COUNT(*) AS count FROM address_datasets WHERE status='active'").first('count')).toBe(2);
    expect(await database.prepare("SELECT active_count FROM address_datasets WHERE source_id='replacement-source'").first('active_count')).toBe(2);
    expect(await database.prepare('SELECT COUNT(*) AS count FROM address_pool_runtime').first('count')).toBe(4);
    expect(await database.prepare('SELECT SUM(active_count) AS count FROM pool_coverage').first('count')).toBe(4);
    database.close();
  });

  it('rolls back the publication when the generation index refresh fails', async () => {
    const directory = resolve('.data-cache', 'sync-etl-tests', randomUUID());
    directories.push(directory);
    await mkdir(directory, { recursive: true });
    const file = resolve(directory, 'index-failure.jsonl');
    await writeFile(file, `${JSON.stringify({
      id: 'index-failure-1', admin1: 'Pennsylvania', locality: 'Philadelphia', postal_city: 'Philadelphia',
      postcode: '19103', street: 'Market Street', number: '1700', longitude: -75.169, latitude: 39.953,
      property_type: 'residential', residential_building_id: 'index-failure-building', residential_building_class: 'house'
    })}\n`, 'utf8');
    const database = openTestDatabase(':memory:');
    const transactionCommands = [];
    const originalTransaction = database.transaction.bind(database);
    database.transaction = async (work) => {
      transactionCommands.push('BEGIN');
      try { return await originalTransaction(work); }
      catch (error) { transactionCommands.push('ROLLBACK'); throw error; }
    };
    const originalBatch = database.batch.bind(database);
    database.batch = vi.fn(async (statements) => {
      if (statements.some((statement) => String(statement.query).includes('INSERT INTO address_generation_index'))) {
        throw Object.assign(new Error('generation index unavailable'), { code: 'INDEX_REFRESH_FAILED' });
      }
      return originalBatch(statements);
    });
    const importer = new PostgresAddressImporter({
      database,
      normalizeRecord: normalizeSourceRecord,
      hash: (value) => createHash('sha256').update(value).digest('hex'),
      localizeRecords: async (records) => records.map((record) => ({
        ...record,
        localizations: {
          native: { components: record.components, formattedAddress: record.formattedAddress, source: 'fixture' },
          en: { components: record.components, formattedAddress: record.formattedAddress, source: 'fixture' },
          'zh-CN': {
            components: {
              ...record.components, street: '市场街', locality: '费城', postalLocality: '费城', admin1: '宾夕法尼亚州'
            },
            formattedAddress: `宾夕法尼亚州费城市场街${record.components.houseNumber}号`, source: 'fixture'
          }
        }
      }))
    });
    await expect(importer.importShard({
      shard: { id: 'index-failure-us', countryCode: 'US', source },
      discovery: { version: 'v1', dataUrl: source.dataUrl },
      materialized: { file, format: 'overture-jsonl', checksum: 'i'.repeat(64) },
      maxRecords: 10, perLocality: 2
    })).rejects.toMatchObject({ code: 'INDEX_REFRESH_FAILED' });
    expect(transactionCommands).toEqual(['BEGIN', 'ROLLBACK']);
    expect(database.batch).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ query: expect.stringContaining('INSERT INTO address_generation_index') })
    ]));
    database.close();
  });

  it('rolls back an address publication when cancellation arrives during its transaction', async () => {
    const directory = resolve('.data-cache', 'sync-etl-tests', randomUUID());
    directories.push(directory);
    await mkdir(directory, { recursive: true });
    const file = resolve(directory, 'cancelled-publication.jsonl');
    await writeFile(file, `${JSON.stringify({
      id: 'cancelled-1', admin1: 'Pennsylvania', locality: 'Philadelphia', postal_city: 'Philadelphia',
      postcode: '19103', street: 'Market Street', number: '1700', longitude: -75.169, latitude: 39.953,
      property_type: 'residential', residential_building_id: 'cancelled-building-1', residential_building_class: 'house'
    })}\n`, 'utf8');
    const database = openTestDatabase(':memory:');
    const controller = new AbortController();
    const originalBatch = database.batch.bind(database);
    const transactionCommands = [];
    let transactionStarted = false;
    const originalTransaction = database.transaction.bind(database);
    database.transaction = async (work) => {
      transactionCommands.push('BEGIN'); transactionStarted = true;
      try { return await originalTransaction(work); }
      catch (error) { transactionCommands.push('ROLLBACK'); throw error; }
    };
    database.batch = async (statements) => {
      const result = await originalBatch(statements);
      if (transactionStarted && !controller.signal.aborted) {
        controller.abort(Object.assign(new Error('fixture cancellation'), { code: 'SYNC_JOB_TIMEOUT' }));
      }
      return result;
    };
    const importer = new PostgresAddressImporter({
      database,
      normalizeRecord: normalizeSourceRecord,
      hash: (value) => createHash('sha256').update(value).digest('hex'),
      localizeRecords: async (records) => records.map((record) => ({
        ...record,
        localizations: {
          native: { components: record.components, formattedAddress: record.formattedAddress, source: 'fixture' },
          en: { components: record.components, formattedAddress: record.formattedAddress, source: 'fixture' },
          'zh-CN': {
            components: {
              ...record.components,
              street: '市场街',
              locality: '费城',
              postalLocality: '费城',
              admin1: '宾夕法尼亚州'
            },
            formattedAddress: `宾夕法尼亚州费城市场街${record.components.houseNumber}号`,
            source: 'fixture'
          }
        }
      }))
    });
    await expect(importer.importShard({
      shard: { id: 'cancelled-us', countryCode: 'US', source },
      discovery: { version: 'v1', dataUrl: source.dataUrl },
      materialized: { file, format: 'overture-jsonl', checksum: 'f'.repeat(64) },
      maxRecords: 10,
      perLocality: 2,
      signal: controller.signal
    })).rejects.toMatchObject({ code: 'SYNC_JOB_TIMEOUT' });
    expect(transactionCommands).toEqual(['BEGIN', 'ROLLBACK']);
    database.close();
  });

  it('treats the country target as a completion minimum instead of a publication cap', async () => {
    const directory = resolve('.data-cache', 'sync-etl-tests', randomUUID());
    directories.push(directory);
    await mkdir(directory, { recursive: true });
    const file = resolve(directory, 'country-quota.jsonl');
    const database = openTestDatabase(':memory:');
    const importer = new PostgresAddressImporter({
      database,
      normalizeRecord: normalizeSourceRecord,
      hash: (value) => createHash('sha256').update(value).digest('hex'),
      localizeRecords: async (records) => records.map((record) => ({
        ...record,
        localizations: Object.fromEntries(['native', 'en', 'zh-CN'].map((language) => [language, {
          components: record.components,
          formattedAddress: record.formattedAddress,
          source: 'fixture'
        }]))
      }))
    });
    const makeRows = (prefix, start) => Array.from({ length: 2 }, (_, index) => ({
      id: `${prefix}-${index}`, admin1: 'Pennsylvania', locality: index ? 'Pittsburgh' : 'Philadelphia',
      postal_city: index ? 'Pittsburgh' : 'Philadelphia', postcode: `1910${(start + index) % 10}`,
      street: 'Market Street', number: String(start + index), longitude: -75.2 + index / 100,
      latitude: 40 + index / 100, property_type: 'residential',
      residential_building_id: `${prefix}-building-${index}`, residential_building_class: 'house'
    }));
    const policy = { targetCount: 2, levelLimits: [10, 10, 10, 0], overrides: new Map() };
    for (const [index, sourceId] of ['source-a', 'source-b'].entries()) {
      await writeFile(file, `${makeRows(sourceId, 100 + index * 10).map(JSON.stringify).join('\n')}\n`, 'utf8');
      await importer.importShard({
        shard: { id: `${sourceId}-us`, countryCode: 'US', source: { ...source, id: sourceId } },
        discovery: { version: `v${index + 1}`, dataUrl: source.dataUrl },
        materialized: { file, format: 'overture-jsonl', checksum: String(index + 1).repeat(64) },
        maxRecords: 2,
        perLocality: 2,
        policy
      });
    }
    expect(await database.prepare('SELECT COUNT(*) AS count FROM address_pool_runtime').first('count')).toBe(4);
    expect(await database.prepare('SELECT COUNT(*) AS count FROM address_pool WHERE active=0 AND retired_at IS NOT NULL').first('count')).toBe(0);
    expect(await database.prepare("SELECT COUNT(*) AS count FROM address_datasets WHERE status='active'").first('count')).toBe(2);
    expect(await database.prepare('SELECT COUNT(*) AS count FROM address_pool_evidence WHERE is_current=1').first('count')).toBe(8);
    database.close();
  });

  it('automatically republishes strict current evidence left inactive by legacy country caps', async () => {
    const directory = resolve('.data-cache', 'sync-etl-tests', randomUUID());
    directories.push(directory);
    await mkdir(directory, { recursive: true });
    const file = resolve(directory, 'legacy-inactive.jsonl');
    const database = openTestDatabase(':memory:');
    const importer = new PostgresAddressImporter({
      database,
      normalizeRecord: normalizeSourceRecord,
      hash: (value) => createHash('sha256').update(value).digest('hex'),
      localizeRecords: async (records) => records.map((record) => ({
        ...record,
        localizations: {
          native: { components: record.components, formattedAddress: record.formattedAddress, source: 'fixture' },
          en: { components: record.components, formattedAddress: record.formattedAddress, source: 'fixture' },
          'zh-CN': {
            components: {
              ...record.components,
              street: '市场街',
              locality: '费城',
              postalLocality: '费城',
              admin1: '宾夕法尼亚州'
            },
            formattedAddress: `宾夕法尼亚州费城市场街${record.components.houseNumber}号`,
            source: 'fixture'
          }
        }
      }))
    });
    const rows = Array.from({ length: 3 }, (_, index) => ({
      id: `us-${index}`, admin1: 'Pennsylvania', locality: 'Philadelphia', postal_city: 'Philadelphia', postcode: '19103',
      street: 'Market Street', number: String(index + 1), longitude: -75.17 + index / 1000,
      latitude: 39.95 + index / 1000, property_type: 'residential',
      residential_building_id: `us-building-${index}`, residential_building_class: 'house'
    }));
    await writeFile(file, `${rows.map(JSON.stringify).join('\n')}\n`, 'utf8');
    await importer.importShard({
      shard: { id: 'fixture-us', countryCode: 'US', source },
      discovery: { version: 'v1', dataUrl: source.dataUrl },
      materialized: { file, format: 'overture-jsonl', checksum: '9'.repeat(64) },
      maxRecords: 3, sourceMaxRecords: 3, perLocality: 10,
      policy: { targetCount: 1, levelLimits: [10, 10, 10, 0], overrides: new Map() }
    });
    const ids = (await database.prepare('SELECT id FROM address_pool ORDER BY id').all()).results.map((row) => row.id);
    await database.prepare("UPDATE address_pool SET active=0,retired_at='legacy' WHERE id IN (?,?)").bind(ids[0], ids[1]).run();
    expect(await database.prepare('SELECT COUNT(*) count FROM address_pool_runtime').first('count')).toBe(1);
    await expect(reconcilePublishedPool(database, ['US'], '2026-08-16T00:00:00.000Z'))
      .resolves.toEqual([{ countryCode: 'US', before: 1, after: 3, activated: 2, retired: 0 }]);
    expect(await database.prepare('SELECT COUNT(*) count FROM address_pool_runtime').first('count')).toBe(3);
    expect(await database.prepare("SELECT active_count FROM address_datasets WHERE status='active'").first('active_count')).toBe(3);
    const invalidVariants = JSON.stringify(Object.fromEntries(['native', 'en', 'zh-CN'].map((language) => [language, {
      houseNumber: '1', street: language === 'zh-CN' ? '市场街' : 'Market Street',
      admin1: language === 'zh-CN' ? '宾夕法尼亚州' : 'Pennsylvania', postcode: '19103'
    }])));
    await database.prepare(`UPDATE address_pool SET locality='',postal_locality='',component_variants_json=?
      WHERE id=?`).bind(invalidVariants, ids[0]).run();
    await expect(reconcilePublishedPool(database, ['US'], '2026-08-16T00:01:00.000Z'))
      .resolves.toEqual([{ countryCode: 'US', before: 3, after: 2, activated: 0, retired: 1 }]);
    expect(await database.prepare('SELECT COUNT(*) AS total FROM address_generation_index WHERE active=1').first('total')).toBe(2);
    expect(await database.prepare("SELECT active_count FROM address_datasets WHERE status='active'").first('active_count')).toBe(2);
    await writeFile(file, `${JSON.stringify({
      ...rows[2], id: 'us-new-source', number: '99',
      residential_building_id: 'us-new-source-building'
    })}\n`, 'utf8');
    await importer.importShard({
      shard: { id: 'fixture-us-second', countryCode: 'US', source: { ...source, id: 'fixture-second' } },
      discovery: { version: 'v2', dataUrl: source.dataUrl },
      materialized: { file, format: 'overture-jsonl', checksum: '7'.repeat(64) },
      maxRecords: 1, sourceMaxRecords: 1, perLocality: 10,
      policy: { targetCount: 1, levelLimits: [10, 10, 10, 0], overrides: new Map() }
    });
    expect(await database.prepare('SELECT active FROM address_pool WHERE id=?').bind(ids[0]).first('active')).toBe(0);
    expect(await database.prepare('SELECT COUNT(*) count FROM address_pool_runtime').first('count')).toBe(3);
    database.close();
  });

  it('reports only the pool rows its own import added', async () => {
    const directory = resolve('.data-cache', 'sync-etl-tests', randomUUID());
    directories.push(directory);
    await mkdir(directory, { recursive: true });
    const file = resolve(directory, 'own-growth.jsonl');
    const database = openTestDatabase(':memory:');
    const importer = new PostgresAddressImporter({
      database,
      normalizeRecord: normalizeSourceRecord,
      hash: (value) => createHash('sha256').update(value).digest('hex'),
      localizeRecords: async (records) => records.map((record) => ({
        ...record,
        localizations: Object.fromEntries(['native', 'en', 'zh-CN'].map((language) => [language, {
          components: record.components, formattedAddress: record.formattedAddress, source: 'fixture'
        }]))
      }))
    });
    await writeFile(file, ['1', '2'].map((number) => JSON.stringify({
      id: `us-own-${number}`, admin1: 'Pennsylvania', locality: 'Philadelphia', postal_city: 'Philadelphia',
      postcode: '19103', street: 'Market Street', number, longitude: -75.17, latitude: 39.95
    })).map((line) => `${line}\n`).join(''), 'utf8');
    const run = (version, checksum) => importer.importShard({
      shard: { id: 'fixture-us', countryCode: 'US', source },
      discovery: { version, dataUrl: source.dataUrl },
      materialized: { file, format: 'overture-jsonl', checksum },
      maxRecords: 10, sourceMaxRecords: 10, perLocality: 10,
      policy: { targetCount: 10, levelLimits: [10, 10, 10, 0], overrides: new Map() }
    });
    expect(await run('v1', '1'.repeat(64))).toMatchObject({ netGrowth: 2, changedCount: 2 });
    expect(await run('v2', '2'.repeat(64))).toMatchObject({ netGrowth: 0, changedCount: 0 });
    database.close();
  });

  it('automatically retires legacy rows that fail the current publication contract', async () => {
    const directory = resolve('.data-cache', 'sync-etl-tests', randomUUID());
    directories.push(directory);
    await mkdir(directory, { recursive: true });
    const file = resolve(directory, 'legacy-invalid.jsonl');
    const database = openTestDatabase(':memory:');
    const importer = new PostgresAddressImporter({
      database,
      normalizeRecord: normalizeSourceRecord,
      hash: (value) => createHash('sha256').update(value).digest('hex'),
      localizeRecords: async (records) => records.map((record) => ({
        ...record,
        localizations: Object.fromEntries(['native', 'en', 'zh-CN'].map((language) => [language, {
          components: record.components, formattedAddress: record.formattedAddress, source: 'fixture'
        }]))
      }))
    });
    await writeFile(file, `${JSON.stringify({
      id: 'us-valid', admin1: 'Pennsylvania', locality: 'Philadelphia', postal_city: 'Philadelphia',
      postcode: '19103', street: 'Market Street', number: '1', longitude: -75.17, latitude: 39.95,
      property_type: 'residential', residential_building_id: 'us-building', residential_building_class: 'house'
    })}\n`, 'utf8');
    await importer.importShard({
      shard: { id: 'fixture-us', countryCode: 'US', source },
      discovery: { version: 'v1', dataUrl: source.dataUrl },
      materialized: { file, format: 'overture-jsonl', checksum: '8'.repeat(64) },
      maxRecords: 1, sourceMaxRecords: 1, perLocality: 10,
      policy: { targetCount: 1, levelLimits: [10, 10, 10, 0], overrides: new Map() }
    });
    const invalidVariants = JSON.stringify(Object.fromEntries(['native', 'en', 'zh-CN'].map((language) => [language, {
      houseNumber: '1', street: language === 'zh-CN' ? '市场街' : 'Market Street',
      admin1: language === 'zh-CN' ? '宾夕法尼亚州' : 'Pennsylvania', postcode: '19103'
    }])));
    // English-first publication indexes the English-language row at import, before any Chinese translation.
    expect(await database.prepare(`SELECT COUNT(*) count FROM address_generation_index
      WHERE country_code='US' AND active=1`).first('count')).toBe(1);
    await database.prepare(`UPDATE address_pool SET locality='',postal_locality='',component_variants_json=?,expires_at=NULL
      WHERE country_code='US'`).bind(invalidVariants).run();
    await expect(validatePublishedPoolBatch(database, {
      checkedAt: '2026-08-17T00:00:00.000Z', limit: 100
    })).resolves.toMatchObject({ countryCode: 'US', scanned: 1, retired: 1, completed: false });
    expect(await database.prepare('SELECT COUNT(*) count FROM address_pool_runtime').first('count')).toBe(0);
    expect(await database.prepare(`SELECT COUNT(*) count FROM address_generation_index
      WHERE country_code='US' AND active=1`).first('count')).toBe(0);
    await expect(validatePublishedPoolBatch(database, {
      checkedAt: '2026-08-17T00:01:00.000Z', limit: 100
    })).resolves.toMatchObject({ countryCode: 'US', countryCompleted: true, scanned: 0 });
    await expect(validatePublishedPoolBatch(database, {
      checkedAt: '2026-08-17T00:02:00.000Z', limit: 100
    })).resolves.toEqual({ completed: true, scanned: 0, retired: 0 });
    await expect(validatePublishedPoolBatch(database, {
      checkedAt: '2026-08-18T00:00:00.000Z', limit: 100
    })).resolves.toEqual({ completed: true, scanned: 0, retired: 0 });
    expect(await database.prepare('SELECT COUNT(*) count FROM address_pool WHERE active=1').first('count')).toBe(0);
    database.close();
  });

  it('publishes strict partial datasets without retiring the last complete snapshot', async () => {
    const directory = resolve('.data-cache', 'sync-etl-tests', randomUUID());
    directories.push(directory);
    await mkdir(directory, { recursive: true });
    const file = resolve(directory, 'partial-publication.jsonl');
    const database = openTestDatabase(':memory:');
    const importer = new PostgresAddressImporter({
      database,
      normalizeRecord: normalizeSourceRecord,
      hash: (value) => createHash('sha256').update(value).digest('hex'),
      localizeRecords: async (records) => records.map((record) => ({
        ...record,
        localizations: Object.fromEntries(['native', 'en', 'zh-CN'].map((language) => [language, {
          components: record.components, formattedAddress: record.formattedAddress, source: 'fixture'
        }]))
      }))
    });
    const row = (id, number) => ({
      id, admin1: 'Pennsylvania', locality: 'Philadelphia', postal_city: 'Philadelphia', postcode: '19103',
      street: 'Market Street', number: String(number), longitude: -75.17 + number / 10000,
      latitude: 39.95 + number / 10000, property_type: 'residential',
      residential_building_id: `building-${id}`, residential_building_class: 'house'
    });
    const publish = async (version, checksum, rows, sourceComplete) => {
      await writeFile(file, `${rows.map(JSON.stringify).join('\n')}\n`, 'utf8');
      return importer.importShard({
        shard: { id: 'fixture-us', countryCode: 'US', source },
        discovery: { version, dataUrl: source.dataUrl },
        materialized: { file, format: 'overture-jsonl', checksum, sourceComplete, snapshotMode: sourceComplete ? 'authoritative' : 'merge' },
        maxRecords: 10, sourceMaxRecords: 10, perLocality: 10,
        policy: { targetCount: 1, levelLimits: [10, 10, 10, 0], overrides: new Map() }
      });
    };

    await publish('v1', '1'.repeat(64), [row('complete-1', 1), row('complete-2', 2)], true);
    await publish('v2', '2'.repeat(64), Array.from({ length: 8 }, (_, index) => row(`partial-${index + 1}`, index + 3)), false);
    expect(await database.prepare("SELECT COUNT(*) count FROM address_datasets WHERE status='active' AND source_complete=1").first('count')).toBe(1);
    expect(await database.prepare("SELECT COUNT(*) count FROM address_datasets WHERE status='active' AND source_complete=0").first('count')).toBe(1);
    expect(await database.prepare('SELECT COUNT(*) count FROM address_pool_runtime').first('count')).toBe(10);

    await expect(publish('v2', '9'.repeat(64), [row('partial-degraded', 20)], false))
      .rejects.toThrow(/capped previous floor/);
    expect(await database.prepare("SELECT COUNT(*) count FROM address_datasets WHERE status='active' AND source_complete=0").first('count')).toBe(1);
    expect(await database.prepare('SELECT COUNT(*) count FROM address_pool_runtime').first('count')).toBe(10);

    await publish('v3', '3'.repeat(64), [row('partial-next-version', 21)], false);
    expect(await database.prepare("SELECT COUNT(*) count FROM address_datasets WHERE status='active' AND source_complete=1").first('count')).toBe(1);
    expect(await database.prepare("SELECT COUNT(*) count FROM address_datasets WHERE status='active' AND source_complete=0").first('count')).toBe(2);
    expect(await database.prepare('SELECT COUNT(*) count FROM address_pool_runtime').first('count')).toBe(11);

    await publish('v2', '4'.repeat(64), [row('final-1', 5), row('final-2', 6)], true);
    expect(await database.prepare("SELECT COUNT(*) count FROM address_datasets WHERE status='active' AND source_complete=1").first('count')).toBe(1);
    expect(await database.prepare("SELECT COUNT(*) count FROM address_datasets WHERE status='active' AND source_complete=0").first('count')).toBe(0);
    expect(await database.prepare('SELECT COUNT(*) count FROM address_pool_runtime').first('count')).toBe(2);
    database.close();
  });

  it('rejects a sharply degraded candidate snapshot and preserves the active pool', async () => {
    const directory = resolve('.data-cache', 'sync-etl-tests', randomUUID());
    directories.push(directory);
    await mkdir(directory, { recursive: true });
    const file = resolve(directory, 'quality.jsonl');
    const database = openTestDatabase(':memory:');
    const importer = new PostgresAddressImporter({
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
      id, admin1, locality, postal_city: locality, postcode: `1000${id}`, street: 'Main Street', number: id,
      longitude: -75 + Number(id) / 100, latitude: 40 + Number(id) / 100,
      property_type: 'residential', residential_building_id: `building-${id}`, residential_building_class: 'house'
    }));
    await writeFile(file, `${rows.map(JSON.stringify).join('\n')}\n`, 'utf8');
    const shard = { id: 'quality-us', countryCode: 'US', source, qualityGate: {
      minimumRecords: 1, minimumAdmin1: 1, minimumCountRatio: 0.75, minimumAdmin1Ratio: 0.75
    } };
    const first = await importer.importShard({
      shard, discovery: { version: 'v1', dataUrl: source.dataUrl },
      materialized: { file, format: 'overture-jsonl', checksum: '1'.repeat(64), snapshotMode: 'authoritative' }, maxRecords: 10, perLocality: 10
    });
    await writeFile(file, `${JSON.stringify(rows[0])}\n`, 'utf8');
    await expect(importer.importShard({
      shard, discovery: { version: 'v2', dataUrl: source.dataUrl },
      materialized: { file, format: 'overture-jsonl', checksum: '2'.repeat(64) }, maxRecords: 10, perLocality: 10
    })).rejects.toMatchObject({
      code: 'SNAPSHOT_QUALITY_FAILED',
      rejectionReasons: {},
      metrics: expect.objectContaining({ candidateCount: 1, rejectionReasons: {} })
    });
    expect(await database.prepare("SELECT id FROM address_datasets WHERE status='active'").first('id')).toBe(first.datasetId);
    expect(await database.prepare('SELECT COUNT(*) count FROM address_pool_runtime').first('count')).toBe(4);

    await database.prepare("UPDATE address_datasets SET version='v1-legacy-import-revision' WHERE id=?").bind(first.datasetId).run();
    const revised = await importer.importShard({
      shard, discovery: { version: 'v3', dataUrl: source.dataUrl },
      materialized: { file, format: 'overture-jsonl', checksum: '3'.repeat(64), snapshotMode: 'authoritative' }, maxRecords: 10, perLocality: 10
    });
    expect(revised).toMatchObject({ acceptedCount: 1, skipped: false });
    expect(await database.prepare("SELECT id FROM address_datasets WHERE status='active'").first('id')).toBe(revised.datasetId);
    database.close();
  });

  it('publishes a small first strict snapshot and permits a later strict increase', async () => {
    const directory = resolve('.data-cache', 'sync-etl-tests', randomUUID());
    directories.push(directory);
    await mkdir(directory, { recursive: true });
    const file = resolve(directory, 'small-strict.jsonl');
    const database = openTestDatabase(':memory:');
    const importer = new PostgresAddressImporter({
      database, normalizeRecord: normalizeSourceRecord,
      hash: (value) => createHash('sha256').update(value).digest('hex'),
      localizeRecords: async (records) => records.map((record) => ({
        ...record,
        localizations: Object.fromEntries(['native', 'en', 'zh-CN'].map((language) => [language, {
          components: record.components, formattedAddress: record.formattedAddress, source: 'fixture'
        }]))
      }))
    });
    const makeRows = (count) => Array.from({ length: count }, (_, index) => ({
      id: `jp-${index}`, address_levels: ['東京都', '杉並区', '永福'], postcode: '1680064',
      street: '永福一丁目', number: String(index + 1), longitude: 139.64 + index / 10000,
      latitude: 35.67 + index / 10000, property_type: 'residential',
      residential_building_id: `building-${index}`, residential_building_class: 'house'
    }));
    const shard = { id: 'small-jp', countryCode: 'JP', source };
    const policy = { targetCount: 40_000, levelLimits: [1_500, 200, 50, 0], overrides: new Map() };
    await writeFile(file, `${makeRows(2).map(JSON.stringify).join('\n')}\n`, 'utf8');
    await expect(importer.importShard({
      shard, discovery: { version: 'v1', dataUrl: source.dataUrl },
      materialized: { file, format: 'overture-jsonl', checksum: '4'.repeat(64) },
      maxRecords: 40_000, perLocality: 64, policy
    })).resolves.toMatchObject({ acceptedCount: 2 });
    await writeFile(file, `${makeRows(3).map(JSON.stringify).join('\n')}\n`, 'utf8');
    await expect(importer.importShard({
      shard, discovery: { version: 'v2', dataUrl: source.dataUrl },
      materialized: { file, format: 'overture-jsonl', checksum: '5'.repeat(64) },
      maxRecords: 40_000, perLocality: 64, policy
    })).resolves.toMatchObject({ acceptedCount: 3 });
    const revisedPolicy = { ...policy, targetCount: 30_000 };
    await expect(importer.importShard({
      shard, discovery: { version: 'v2', dataUrl: source.dataUrl },
      materialized: { file, format: 'overture-jsonl', checksum: '5'.repeat(64) },
      maxRecords: 30_000, perLocality: 64, policy: revisedPolicy
    })).resolves.toMatchObject({ acceptedCount: 3, skipped: false });
    expect(await database.prepare("SELECT COUNT(*) count FROM address_datasets WHERE status='active'").first('count')).toBe(1);
    database.close();
  });

  it('publishes all strict records across active datasets beyond the completion target', async () => {
    const directory = resolve('.data-cache', 'sync-etl-tests', randomUUID());
    directories.push(directory);
    await mkdir(directory, { recursive: true });
    const file = resolve(directory, 'multi-source.jsonl');
    const database = openTestDatabase(':memory:');
    const importer = new PostgresAddressImporter({
      database,
      normalizeRecord: normalizeSourceRecord,
      hash: (value) => createHash('sha256').update(value).digest('hex'),
      localizeRecords: async (records) => records.map((value) => ({
        ...value,
        localizations: Object.fromEntries(['native', 'en', 'zh-CN'].map((language) => [language, {
          components: value.components, formattedAddress: value.formattedAddress, source: 'fixture'
        }]))
      }))
    });
    const policy = { targetCount: 12, levelLimits: [100, 100, 100, 0], overrides: new Map() };
    const rows = (prefix, district, longitude, sharedBuilding = false) => Array.from({ length: 8 }, (_, index) => ({
      id: `${prefix}-${index}`, admin1: 'Pennsylvania', locality: 'Philadelphia', district,
      postal_city: 'Philadelphia', postcode: `191${String(index).padStart(2, '0')}`,
      street: `${district} Street`, number: String(100 + index), longitude: longitude + index / 10000,
      latitude: 39.95 + index / 10000, property_type: 'residential',
      residential_building_id: `${prefix}-building-${sharedBuilding ? 'shared' : index}`, residential_building_class: 'house'
    }));
    const importRows = async (sourceId, district, checksum, longitude, sourceMaxRecords = 12, sharedBuilding = false) => {
      await writeFile(file, `${rows(sourceId, district, longitude, sharedBuilding).map(JSON.stringify).join('\n')}\n`, 'utf8');
      return importer.importShard({
        shard: { id: `${sourceId}-us`, countryCode: 'US', source: { ...source, id: sourceId, name: sourceId } },
        discovery: { version: 'v1', dataUrl: source.dataUrl },
        materialized: { file, format: 'overture-jsonl', checksum: checksum.repeat(64) },
        maxRecords: 12, sourceMaxRecords, perLocality: 100, policy
      });
    };
    expect(await importRows('source-a', 'Alpha', 'a', -75.17)).toMatchObject({ acceptedCount: 8 });
    expect(await importRows('source-b', 'Beta', 'b', -75.27)).toMatchObject({ acceptedCount: 8 });
    expect(await database.prepare("SELECT COUNT(*) AS count FROM address_pool WHERE active=1 AND country_code='US'").first('count')).toBe(16);
    expect(await database.prepare("SELECT SUM(active_count) AS count FROM address_datasets WHERE status='active'").first('count')).toBe(16);
    const districts = (await database.prepare(`SELECT district,COUNT(*) AS count FROM address_pool
      WHERE country_code='US' AND active=1 GROUP BY district ORDER BY district`).all()).results;
    expect(districts).toEqual([{ district: 'Alpha', count: 8 }, { district: 'Beta', count: 8 }]);
    expect(await importRows('source-c', 'Gamma', 'c', -75.37, 3, true)).toMatchObject({ acceptedCount: 3 });
    expect(await database.prepare("SELECT COUNT(*) AS count FROM address_pool WHERE active=1 AND country_code='US'").first('count')).toBe(19);
    expect(await database.prepare(`SELECT COUNT(*) AS count FROM address_pool_evidence evidence
      JOIN address_datasets dataset ON dataset.id=evidence.dataset_id
      WHERE dataset.source_id='source-c' AND evidence.evidence_type='residential_use' AND evidence.is_current=1`).first('count')).toBe(3);
    database.close();
  });

  it('uses the provided PostgreSQL database by default', async () => {
    const directory = resolve('.data-cache', 'sync-etl-tests', randomUUID());
    directories.push(directory);
    await mkdir(directory, { recursive: true });
    const file = resolve(directory, 'fixture.jsonl');
    const database = openTestDatabase();
    await writeFile(file, `${JSON.stringify({
      id: 'overture-default', admin1: 'Pennsylvania', locality: 'Philadelphia', postal_city: 'Philadelphia',
      postcode: '19103', street: 'Market Street', number: '1700', longitude: -75.169, latitude: 39.953,
      property_type: 'residential', residential_building_id: 'building-default', residential_building_class: 'house'
    })}\n`, 'utf8');
    const localizeRecords = async (records) => records.map((record) => ({
      ...record,
      localizations: Object.fromEntries(['native', 'en', 'zh-CN'].map((language) => [language, {
        components: record.components,
        formattedAddress: record.formattedAddress,
        source: language === 'native' ? 'source' : 'fixture-translator'
      }]))
    }));
    let materializeOptions;
    const result = await runAddressEtl({
      database,
      cacheDir: resolve(directory, 'cache'),
      dataRoot: directory,
      catalog: { schemaVersion: 1, shards: [{
        id: 'fixture-us', countryCode: 'US', intervalDays: 30, source,
        qualityGate: { minimumRecords: 1, minimumAdmin1: 1, minimumCountRatio: 0, minimumAdmin1Ratio: 0 }
      }] },
      syncMode: 'manual',
      maxRecords: 10,
      perLocality: 2,
      localizeRecords,
      adapters: {
        discover: async () => ({ adapter: 'overture', version: 'fixture', dataUrl: source.dataUrl, sourceBytes: 0 }),
        materialize: async (_shard, _discovery, options) => {
          materializeOptions = options;
          return { file, format: 'overture-jsonl', checksum: 'c'.repeat(64), cacheBytes: 1 };
        }
      }
    });
    expect(result).toMatchObject({ changed: true, selectedShards: ['fixture-us'] });
    expect(materializeOptions).toMatchObject({ maxRecords: 1_010, perLocality: 2_000 });
    expect(await database.prepare('SELECT COUNT(*) AS count FROM address_pool_runtime').first('count')).toBe(1);
    expect(await database.prepare('SELECT status FROM sync_country_state WHERE country_code=?').bind('US').first('status')).toBe('ready');
    database.close();
  });

  it('keeps a shard completion marker when pruning older normalized cache files', async () => {
    const directory = resolve('.data-cache', 'sync-etl-tests', randomUUID());
    directories.push(directory);
    const cacheDir = resolve(directory, 'cache');
    const normalized = resolve(cacheDir, 'normalized');
    const output = resolve(normalized, 'fixture-us-v1.jsonl');
    const marker = `${output}.complete`;
    const obsolete = resolve(normalized, 'fixture-us-obsolete.jsonl');
    await mkdir(normalized, { recursive: true });
    await writeFile(output, '{"id":"current"}\n', 'utf8');
    await writeFile(marker, '{"version":"fixture"}\n', 'utf8');
    await writeFile(obsolete, '{"id":"old"}\n', 'utf8');
    const result = await runAddressEtl({
      cacheDir,
      dataRoot: directory,
      catalog: { schemaVersion: 1, shards: [{ id: 'fixture-us', countryCode: 'US', intervalDays: 30, source }] },
      syncMode: 'manual',
      importer: { importShard: async () => ({ datasetId: 'fixture-dataset', acceptedCount: 1, rejectedCount: 0, localityCount: 1 }) },
      adapters: {
        discover: async () => ({ adapter: 'overture', version: 'fixture', dataUrl: source.dataUrl, sourceBytes: 0 }),
        materialize: async () => ({ file: output, format: 'overture-jsonl', checksum: 'a'.repeat(64), cacheBytes: 1 })
      }
    });
    expect(result.changed).toBe(true);
    await expect(readFile(marker, 'utf8')).resolves.toContain('fixture');
    await expect(readFile(obsolete, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('supports a single-shard dry run without opening PostgreSQL or changing cache state', async () => {
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

  it('records a normal staged checkpoint as a successful partial result without importing', async () => {
    const cacheDir = resolve('.data-cache', 'sync-etl-tests', randomUUID());
    directories.push(cacheDir);
    const importer = { importShard: vi.fn() };
    const result = await runAddressEtl({
      cacheDir,
      catalog: { schemaVersion: 1, shards: [{ id: 'fixture-jp', countryCode: 'JP', intervalDays: 30, source }] },
      syncMode: 'manual', importer,
      adapters: {
        discover: async () => ({
          adapter: 'japan-abr', version: 'fixture-v1', dataUrl: source.dataUrl,
          sourceBytes: 0, estimateMethod: 'fixture'
        }),
        materialize: async () => ({
          file: null, format: 'checkpoint', cacheBytes: 0, checksum: null,
          sourceComplete: false, checkpointToken: 'jp-checkpoint-1', checkpointStage: 'plateau',
          metrics: { candidateCount: 10, resolvedCount: 4, publishableCount: 0, selectedCount: 0 }
        })
      }
    });

    expect(importer.importShard).not.toHaveBeenCalled();
    expect(result.reports[0]).toMatchObject({
      status: 'partial', sourceComplete: false,
      checkpointToken: 'jp-checkpoint-1', checkpointStage: 'plateau', acceptedCount: 0,
      metrics: { candidateCount: 10, resolvedCount: 4, publishableCount: 0, selectedCount: 0 }
    });
  });

  it('fails closed when the local ETL manifest is corrupt', async () => {
    const cacheDir = resolve('.data-cache', 'sync-etl-tests', randomUUID());
    directories.push(cacheDir);
    await mkdir(cacheDir, { recursive: true });
    const manifest = resolve(cacheDir, 'manifest.json');
    await writeFile(manifest, '{"schemaVersion":1,', 'utf8');
    await expect(runAddressEtl({
      cacheDir,
      catalog: { schemaVersion: 1, shards: [] },
      dryRun: true,
      syncMode: 'manual',
      now: () => new Date('2026-07-16T00:00:00.000Z')
    })).rejects.toMatchObject({ code: 'SYNC_STATE_INVALID' });
    expect(await readFile(manifest, 'utf8')).toBe('{"schemaVersion":1,');
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
    const importer = { importShard: async () => ({
      datasetId: 'fixture-dataset', acceptedCount: 10, rejectedCount: 1, localityCount: 2,
      rejectionReasons: { duplicate: 1 }, metrics: { candidateCount: 10, rejectedCount: 1 }, skipped: false
    }) };
    const first = await runAddressEtl({ cacheDir, catalog, adapters, importer, now: () => new Date('2026-07-16T00:00:00Z') });
    const second = await runAddressEtl({ cacheDir, catalog, adapters, importer, now: () => new Date('2026-07-17T00:00:00Z') });
    const manifest = JSON.parse(await readFile(resolve(cacheDir, 'manifest.json'), 'utf8'));
    expect(discoveries).toBe(1);
    expect(first.reports[0]).toMatchObject({
      rejectionReasons: { duplicate: 1 }, metrics: { candidateCount: 10, rejectedCount: 1 }
    });
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

  it('publishes through the PostgreSQL ETL transaction without an external release phase', async () => {
    const result = await runAddressSync({
      releaseId: 'release-built-in',
      environment: {},
      runEtl: async () => ({ changed: true, dryRun: false, requiredCountries: ['US'] })
    });
    expect(result).toMatchObject({ releaseId: 'release-built-in', changed: true });
  });

  it('returns independently imported country targets from the PostgreSQL ETL result', async () => {
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
