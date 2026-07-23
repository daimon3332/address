import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runProcess } from './process.mjs';

const syncRoot = resolve(fileURLToPath(new URL('.', import.meta.url)));
const catalogFile = resolve(syncRoot, 'source-shards.json');
const overtureExporter = resolve(syncRoot, 'overture-export.py');
const geofabrikExporter = resolve(syncRoot, 'geofabrik-export.py');
const overtureResidentialRevision = 'residential-buildings-v3';
const geofabrikExportRevision = 'g65';
// geoBoundaries gbOpen has no entries for these territories; use the exact OSM admin relations instead.
const osmBoundaryRelations = { HKG: 913110, MAC: 1867188 };

export const countryBounds = {
  US: [-180, 18, -66, 72], CA: [-141, 41, -52, 84], MX: [-119, 14, -86, 33],
  GB: [-9, 49, 2, 61], DE: [5, 47, 16, 56], FR: [-6, 41, 10, 52], IT: [6, 35, 19, 48],
  ES: [-19, 27, 5, 44], NL: [3, 50, 8, 54], JP: [122, 20, 154, 46],
  HK: [113, 22, 115, 23], SG: [103, 1, 105, 2], TW: [119, 21, 123, 26],
  RU: [19, 41, 180, 82], CN: [73, 18, 135, 54], KR: [124, 33, 132, 39],
  MY: [99, 0, 120, 8], TH: [97, 5, 106, 21], PH: [116, 4, 127, 22],
  VN: [102, 8, 110, 24], TR: [25, 35, 45, 43], SA: [34, 16, 56, 33],
  IN: [68, 6, 98, 36], AU: [112, -44, 154, -10], BR: [-74, -34, -34, 6],
  NG: [2, 4, 15, 14], ZA: [16, -35, 33, -22]
};

export class SourceMetadataError extends Error {
  constructor(message, { url, status = null, code = 'SOURCE_METADATA_ERROR', cause } = {}) {
    super(`${message}: ${url}`, { cause });
    this.name = 'SourceMetadataError';
    this.code = code;
    this.url = url;
    this.status = status;
  }
}

const retryableStatus = (status) => status === 408 || status === 429 || status >= 500;
const wait = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
const execFileAsync = promisify(execFile);

const curlMetadataFetch = async (input, init = {}) => {
  const url = String(input);
  if ((init.method || 'GET') === 'HEAD') {
    const { stdout } = await execFileAsync('curl', ['-4', '-fsSLI', '--connect-timeout', '15', '--max-time', '60', url], {
      encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true
    });
    const blocks = stdout.split(/\r?\n\r?\n/u).map((value) => value.trim()).filter((value) => /^HTTP\//u.test(value));
    const lines = (blocks.at(-1) || '').split(/\r?\n/u);
    const status = Number(lines.shift()?.match(/^HTTP\/\S+\s+(\d+)/u)?.[1] || 200);
    const headers = new Headers();
    for (const line of lines) {
      const separator = line.indexOf(':');
      if (separator > 0) headers.append(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
    }
    return new Response(null, { status, headers });
  }
  const { stdout } = await execFileAsync('curl', ['-4', '-fsSL', '--connect-timeout', '15', '--max-time', '60', url], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true
  });
  return new Response(stdout, { status: 200, headers: { 'Content-Type': 'application/json' } });
};

const jsonRequest = async (url, fetchImpl, { attempts = 3 } = {}) => {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(30_000)
      });
      if (!response.ok) {
        throw new SourceMetadataError(`Source metadata request returned HTTP ${response.status}`, {
          url, status: response.status, code: 'SOURCE_METADATA_HTTP'
        });
      }
      const contentType = response.headers.get('content-type') || '';
      if (!/\b(application\/([^;]+\+)?json|application\/geo\+json)\b/iu.test(contentType)) {
        throw new SourceMetadataError(`Source metadata returned unexpected Content-Type ${contentType || '(missing)'}`, {
          url, status: response.status, code: 'SOURCE_METADATA_CONTENT_TYPE'
        });
      }
      try {
        return await response.json();
      } catch (error) {
        throw new SourceMetadataError('Source metadata returned invalid JSON', {
          url, status: response.status, code: 'SOURCE_METADATA_JSON', cause: error
        });
      }
    } catch (error) {
      lastError = error instanceof SourceMetadataError ? error : new SourceMetadataError('Source metadata request failed', {
        url, code: error?.name === 'TimeoutError' ? 'SOURCE_METADATA_TIMEOUT' : 'SOURCE_METADATA_NETWORK', cause: error
      });
      const retryable = !(lastError instanceof SourceMetadataError) || lastError.status === null || retryableStatus(lastError.status)
        || lastError.code === 'SOURCE_METADATA_CONTENT_TYPE' || lastError.code === 'SOURCE_METADATA_JSON';
      if (!retryable || attempt === attempts) throw lastError;
      await wait(250 * 2 ** (attempt - 1));
    }
  }
  throw lastError;
};

const safeVersion = (value) => String(value).replace(/[^a-zA-Z0-9._-]/gu, '_').slice(0, 96);
const intersects = (left, right) => left[0] <= right[2] && left[2] >= right[0] && left[1] <= right[3] && left[3] >= right[1];
const headerNumber = (headers, name) => {
  const value = Number(headers.get(name));
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
};

const recentBootstrapRaw = async ({ cacheDir, shard, dataUrl, currentDate, currentBytes }) => {
  if (!cacheDir || !/^\d{4}-\d{2}-\d{2}$/u.test(currentDate)) return null;
  const directory = resolve(cacheDir, 'raw');
  let names;
  try { names = await readdir(directory); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const prefix = `${shard.id}-`;
  const suffix = `-${basename(new URL(dataUrl).pathname)}`;
  const currentTime = new Date(`${currentDate}T00:00:00.000Z`).getTime();
  const candidates = [];
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(suffix)) continue;
    const version = name.slice(prefix.length, -suffix.length);
    const match = version.match(/^(\d{4}-\d{2}-\d{2})-([a-zA-Z0-9._-]+)$/u);
    if (!match) continue;
    const publishedTime = new Date(`${match[1]}T00:00:00.000Z`).getTime();
    const age = currentTime - publishedTime;
    if (!Number.isFinite(publishedTime) || age < 0 || age > 24 * 60 * 60 * 1000) continue;
    const file = resolve(directory, name);
    const size = (await stat(file)).size;
    if (size < 1) continue;
    if (currentBytes !== null && (size < currentBytes * 0.75 || size > currentBytes * 1.25)) continue;
    candidates.push({ version, publishedAt: `${match[1]}T00:00:00.000Z`, etag: match[2], file, size, publishedTime });
  }
  return candidates.sort((left, right) => right.publishedTime - left.publishedTime || right.version.localeCompare(left.version))[0] || null;
};

export const sha256File = async (file) => {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
};

export const loadSourceCatalog = async (file = catalogFile) => {
  const catalog = JSON.parse(await readFile(file, 'utf8'));
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.sources)) throw new Error('Unsupported source shard catalog');
  const shards = [];
  for (const source of catalog.sources) {
    const intervalDays = source.intervalDays || catalog.defaultIntervalDays;
    if (source.adapter === 'overture') {
      for (const countryCode of source.countries || []) shards.push({
        id: `${source.id}-${countryCode.toLowerCase()}`, countryCode, intervalDays, source
      });
    } else if (source.adapter === 'geofabrik') {
      for (const extract of source.extracts || []) shards.push({
        id: `${source.id}-${extract.countryCode.toLowerCase()}`,
        countryCode: extract.countryCode,
        extractId: extract.extractId,
        boundaryIso3: extract.boundaryIso3,
        excludeBoundaryIso3: extract.excludeBoundaryIso3,
        intervalDays,
        source
      });
    } else {
      throw new Error(`Unsupported source adapter: ${source.adapter}`);
    }
  }
  const duplicate = shards.find((shard, index) => shards.findIndex((entry) => entry.id === shard.id) !== index);
  if (duplicate) throw new Error(`Duplicate source shard: ${duplicate.id}`);
  return { ...catalog, shards };
};

export const createSourceAdapters = ({
  fetchImpl = fetch,
  execute = runProcess,
  pythonBin = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3'),
  enableOvertureResidential = process.env.ADDRESS_SYNC_OVERTURE_BUILDINGS === 'true'
} = {}) => {
  const useCurlTransport = fetchImpl === fetch;
  if (useCurlTransport) fetchImpl = curlMetadataFetch;
  let overtureCatalogPromise;
  let overtureBuildingCatalogPromise;
  let geofabrikIndexPromise;

  const loadStacItems = async (collectionUrl, collection) => {
    const links = collection.links.filter((link) => link.rel === 'item');
    const items = [];
    for (let offset = 0; offset < links.length; offset += 32) {
      items.push(...await Promise.all(links.slice(offset, offset + 32).map((link) =>
        jsonRequest(new URL(link.href, collectionUrl).href, fetchImpl))));
    }
    return items;
  };

  const overtureCatalog = async () => {
    if (!overtureCatalogPromise) overtureCatalogPromise = (async () => {
      const rootUrl = 'https://stac.overturemaps.org/catalog.json';
      const root = await jsonRequest(rootUrl, fetchImpl);
      if (!/^20\d{2}-\d{2}-\d{2}\.\d+$/u.test(root.latest || '')) throw new Error('Overture STAC did not return a valid latest release');
      const collectionUrl = `https://stac.overturemaps.org/${root.latest}/addresses/address/collection.json`;
      const collection = await jsonRequest(collectionUrl, fetchImpl);
      const items = await loadStacItems(collectionUrl, collection);
      return { version: root.latest, collectionUrl, items };
    })();
    return overtureCatalogPromise;
  };

  const overtureBuildingCatalog = async () => {
    if (!overtureBuildingCatalogPromise) overtureBuildingCatalogPromise = (async () => {
      const addressCatalog = await overtureCatalog();
      const collectionUrl = `https://stac.overturemaps.org/${addressCatalog.version}/buildings/building/collection.json`;
      const collection = await jsonRequest(collectionUrl, fetchImpl);
      return { collectionUrl, items: await loadStacItems(collectionUrl, collection) };
    })();
    return overtureBuildingCatalogPromise;
  };

  const geofabrikIndex = async () => {
    if (!geofabrikIndexPromise) geofabrikIndexPromise = jsonRequest('https://download.geofabrik.de/index-v1-nogeom.json', fetchImpl);
    return geofabrikIndexPromise;
  };

  const discoverOverture = async (shard, { includeAssetSizes = false } = {}) => {
    const catalog = await overtureCatalog();
    const bounds = shard.bounds || countryBounds[shard.countryCode];
    if (!bounds) throw new Error(`Missing Overture bounds for ${shard.countryCode}`);
    const assets = catalog.items
      .filter((item) => Array.isArray(item.bbox) && intersects(bounds, item.bbox))
      .map((item) => item.assets?.aws?.href)
      .filter((url) => typeof url === 'string' && url.startsWith('https://'));
    if (!assets.length) throw new Error(`Overture STAC has no intersecting address assets for ${shard.countryCode}`);
    let buildingAssets = [];
    let buildingAssetEntries = [];
    if (enableOvertureResidential) {
      try {
        const buildingCatalog = await overtureBuildingCatalog();
        buildingAssetEntries = buildingCatalog.items
          .filter((item) => Array.isArray(item.bbox) && intersects(bounds, item.bbox))
          .map((item) => ({ url: item.assets?.aws?.href, bbox: item.bbox }))
          .filter((entry) => typeof entry.url === 'string' && entry.url.startsWith('https://'));
        buildingAssets = buildingAssetEntries.map(({ url }) => url);
      } catch (error) {
        console.warn(`Overture Buildings discovery failed for ${shard.countryCode}: ${error.message}`);
      }
    }
    let sourceBytes = null;
    if (includeAssetSizes) {
      const sizes = await Promise.all(assets.map(async (url) => {
        const response = await fetchImpl(url, { method: 'HEAD' });
        return response.ok ? headerNumber(response.headers, 'content-length') : null;
      }));
      sourceBytes = sizes.every(Number.isSafeInteger) ? sizes.reduce((sum, value) => sum + value, 0) : null;
    }
    return {
      adapter: 'overture',
      version: catalog.version,
      publishedAt: `${catalog.version.slice(0, 10)}T00:00:00.000Z`,
      dataUrl: catalog.collectionUrl,
      assets,
      buildingAssets,
      buildingAssetEntries,
      sourceBytes,
      estimateMethod: sourceBytes === null ? 'record-limit' : 'intersecting-assets-upper-bound'
    };
  };

  const discoverGeofabrik = async (shard, { syncMode, cacheDir } = {}) => {
    const index = await geofabrikIndex();
    const feature = index.features?.find((entry) => entry.properties?.id === shard.extractId);
    const dataUrl = feature?.properties?.urls?.pbf;
    if (!dataUrl) throw new Error(`Geofabrik extract is missing: ${shard.extractId}`);
    const response = await fetchImpl(dataUrl, { method: 'HEAD' });
    if (!response.ok) throw new Error(`Geofabrik metadata request failed (${response.status}): ${dataUrl}`);
    const modified = response.headers.get('last-modified');
    const etag = response.headers.get('etag')?.replaceAll('"', '') || '';
    const dateVersion = modified ? new Date(modified).toISOString().slice(0, 10) : 'latest';
    let version = etag ? `${dateVersion}-${safeVersion(etag).slice(0, 24)}` : dateVersion;
    let publishedAt = modified ? new Date(modified).toISOString() : null;
    let sourceBytes = headerNumber(response.headers, 'content-length');
    let discoveryEtag = etag;
    let estimateMethod = 'http-content-length';
    let bootstrapRawFile = null;
    if (syncMode === 'initial') {
      const recent = await recentBootstrapRaw({ cacheDir, shard, dataUrl, currentDate: dateVersion, currentBytes: sourceBytes });
      if (recent) {
        version = recent.version;
        publishedAt = recent.publishedAt;
        sourceBytes = recent.size;
        discoveryEtag = recent.etag;
        estimateMethod = 'recent-bootstrap-raw';
        bootstrapRawFile = recent.file;
      }
    }
    let boundaryUrl = null;
    const boundaryDownloadUrl = async (iso3) => {
      const relation = osmBoundaryRelations[iso3];
      if (relation) return `https://polygons.openstreetmap.fr/get_geojson.py?id=${relation}&params=0`;
      const boundary = await jsonRequest(`https://www.geoboundaries.org/api/current/gbOpen/${iso3}/ADM0/`, fetchImpl);
      if (!String(boundary.gjDownloadURL || '').startsWith('https://')) throw new Error(`Country boundary is missing: ${iso3}`);
      return boundary.gjDownloadURL;
    };
    if (shard.boundaryIso3) boundaryUrl = await boundaryDownloadUrl(shard.boundaryIso3);
    const excludeBoundaryUrls = [];
    for (const iso3 of shard.excludeBoundaryIso3 || []) {
      excludeBoundaryUrls.push(await boundaryDownloadUrl(iso3));
    }
    return {
      adapter: 'geofabrik', version, publishedAt,
      dataUrl, sourceBytes, etag: discoveryEtag,
      lastModified: modified, boundaryUrl, excludeBoundaryUrls, estimateMethod, bootstrapRawFile
    };
  };

  const discover = (shard, options) => shard.source.adapter === 'overture'
    ? discoverOverture(shard, options)
    : discoverGeofabrik(shard, options);

  const download = async (url, destination, { expectedBytes, maxBytes }) => {
    await mkdir(resolve(destination, '..'), { recursive: true });
    try {
      const existing = (await stat(destination)).size;
      if (existing > 0 && (expectedBytes === null || existing === expectedBytes)) return existing;
    } catch {}
    const partial = `${destination}.part`;
    if (useCurlTransport) {
      try {
        await runProcess({
          file: 'curl',
          args: ['-4', '-fL', '--retry', '3', '--retry-all-errors', '--connect-timeout', '15', '-C', '-', '-o', partial, url]
        });
      } catch {
        await rm(partial, { force: true });
        await runProcess({
          file: 'curl',
          args: ['-4', '-fL', '--retry', '3', '--retry-all-errors', '--connect-timeout', '15', '-o', partial, url]
        });
      }
      const downloaded = (await stat(partial)).size;
      if (downloaded > maxBytes || (expectedBytes !== null && downloaded !== expectedBytes)) {
        throw new Error(`Source download size mismatch: ${downloaded} (expected ${expectedBytes ?? 'unknown'})`);
      }
      await rename(partial, destination);
      return downloaded;
    }
    let offset = 0;
    try { offset = (await stat(partial)).size; } catch {}
    if (expectedBytes !== null && expectedBytes > maxBytes) throw new Error(`Source file exceeds cache budget: ${expectedBytes} > ${maxBytes}`);
    const response = await fetchImpl(url, { headers: offset ? { Range: `bytes=${offset}-` } : {} });
    if (!response.ok) throw new Error(`Source download failed (${response.status}): ${url}`);
    const append = offset > 0 && response.status === 206;
    if (!append) offset = 0;
    const remaining = headerNumber(response.headers, 'content-length');
    if (remaining !== null && offset + remaining > maxBytes) throw new Error(`Source file exceeds cache budget: ${offset + remaining} > ${maxBytes}`);
    if (!response.body) throw new Error(`Source download returned an empty body: ${url}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partial, { flags: append ? 'a' : 'w' }));
    await rename(partial, destination);
    return (await stat(destination)).size;
  };

  const materializeOverture = async (shard, discovery, options) => {
    const residentialRevision = discovery.buildingAssets?.length ? `-${overtureResidentialRevision}` : '';
    const baseOutput = resolve(options.cacheDir, 'normalized', `${shard.id}-${safeVersion(discovery.version)}.jsonl`);
    const output = resolve(options.cacheDir, 'normalized',
      `${shard.id}-${safeVersion(discovery.version)}${residentialRevision}.jsonl`);
    try {
      const size = (await stat(output)).size;
      return { file: output, format: 'overture-jsonl', cacheBytes: size, checksum: await sha256File(output), cacheHit: true };
    } catch {}
    await mkdir(resolve(options.cacheDir, 'normalized'), { recursive: true });
    const temporary = `${output}.${process.pid}.tmp`;
    const assetsFile = `${temporary}.assets.json`;
    const buildingAssetsFile = `${temporary}.building-assets.json`;
    let candidateJsonl;
    if (discovery.buildingAssets?.length) {
      try {
        if ((await stat(baseOutput)).size > 0) candidateJsonl = baseOutput;
      } catch {}
    }
    await writeFile(assetsFile, JSON.stringify(discovery.assets), 'utf8');
    await writeFile(buildingAssetsFile, JSON.stringify(discovery.buildingAssetEntries || discovery.buildingAssets || []), 'utf8');
    try {
      await execute({
        file: pythonBin,
        args: [overtureExporter, '--country', shard.countryCode, '--release', discovery.version,
          '--output', temporary, '--max-records', String(options.maxRecords),
          '--per-locality', String(options.perLocality), '--assets-file', assetsFile,
          '--building-assets-file', buildingAssetsFile,
          '--bounds', ...((shard.bounds || countryBounds[shard.countryCode]).map(String)),
          ...(candidateJsonl ? ['--candidate-jsonl', candidateJsonl] : [])],
        phase: `materialize:${shard.id}`
      });
      await rename(temporary, output);
    } finally {
      await rm(assetsFile, { force: true });
      await rm(buildingAssetsFile, { force: true });
      await rm(temporary, { force: true });
    }
    const size = (await stat(output)).size;
    return { file: output, format: 'overture-jsonl', cacheBytes: size, checksum: await sha256File(output), cacheHit: false };
  };

  const materializeGeofabrik = async (shard, discovery, options) => {
    const version = safeVersion(discovery.version);
    const boundarySignature = [
      geofabrikExportRevision,
      shard.boundaryIso3 ? `b${shard.boundaryIso3}` : '',
      (shard.excludeBoundaryIso3 || []).length ? `x${shard.excludeBoundaryIso3.join('-')}` : ''
    ].filter(Boolean).join('-');
    const outputVersion = `${version}-${boundarySignature}`;
    const output = resolve(options.cacheDir, 'normalized', `${shard.id}-${outputVersion}.geojsonseq`);
    try {
      const size = (await stat(output)).size;
      return { file: output, format: 'geofabrik-geojsonseq', cacheBytes: size, checksum: await sha256File(output), cacheHit: true };
    } catch {}
    const raw = resolve(options.cacheDir, 'raw', `${shard.id}-${version}-${basename(new URL(discovery.dataUrl).pathname)}`);
    const boundary = `${raw}.boundary.geojson`;
    const excludeBoundaries = (discovery.excludeBoundaryUrls || []).map((_, index) => `${raw}.exclude-${index}.geojson`);
    const temporary = `${output}.${process.pid}.tmp`;
    await mkdir(resolve(options.cacheDir, 'normalized'), { recursive: true });
    await download(discovery.dataUrl, raw, { expectedBytes: discovery.sourceBytes, maxBytes: options.maxBytes });
    const sourceChecksum = await sha256File(raw);
    let completed = false;
    try {
      if (discovery.boundaryUrl) {
        await download(discovery.boundaryUrl, boundary, { expectedBytes: null, maxBytes: Math.min(options.maxBytes, 100 * 1024 * 1024) });
      }
      for (let index = 0; index < (discovery.excludeBoundaryUrls || []).length; index += 1) {
        await download(discovery.excludeBoundaryUrls[index], excludeBoundaries[index], { expectedBytes: null, maxBytes: Math.min(options.maxBytes, 100 * 1024 * 1024) });
      }
      const boundaryBytes = (discovery.boundaryUrl ? (await stat(boundary)).size : 0)
        + (await Promise.all(excludeBoundaries.map(async (file) => (await stat(file)).size))).reduce((sum, size) => sum + size, 0);
      const stagingBytes = (await stat(raw)).size + boundaryBytes;
      if (stagingBytes > options.maxBytes) throw new Error(`Geofabrik staging files exceed cache budget: ${stagingBytes} > ${options.maxBytes}`);
      await execute({
        file: pythonBin,
        args: [geofabrikExporter, '--input', raw, '--output', temporary,
          '--max-records', String(options.maxRecords), '--per-locality', String(options.perLocality),
          ...(shard.countryCode === 'CN' ? ['--communities-file', `${temporary}.communities.jsonl`] : []),
          ...(discovery.boundaryUrl ? ['--boundary', boundary] : []),
          ...excludeBoundaries.flatMap((file) => ['--exclude-boundary', file])],
        phase: `materialize:${shard.id}`
      });
      await rename(temporary, output);
      if (shard.countryCode === 'CN') {
        await rename(`${temporary}.communities.jsonl`, `${output}.communities.jsonl`).catch(() => {});
      }
      completed = true;
    } finally {
      await rm(boundary, { force: true });
      await Promise.all(excludeBoundaries.map((file) => rm(file, { force: true })));
      await rm(temporary, { force: true });
      if (!options.retainRaw && completed) await rm(raw, { force: true });
    }
    const size = (await stat(output)).size;
    return { file: output, format: 'geofabrik-geojsonseq', cacheBytes: size, checksum: await sha256File(output), sourceChecksum, cacheHit: false };
  };

  const materialize = (shard, discovery, options) => discovery.adapter === 'overture'
    ? materializeOverture(shard, discovery, options)
    : materializeGeofabrik(shard, discovery, options);

  return { discover, materialize };
};
