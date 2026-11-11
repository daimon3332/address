import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync, readFileSync } from 'node:fs';
import { appendFile, copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createGeoapifyCredentialBridge } from './geoapify-credential-bridge.mjs';
import { createOneMapCredentialBridge } from './onemap-credential-bridge.mjs';
import {
  evaluateGoogleAddressResults, googleResidentialLanguages, reconcileGoogleProgressOutput, requestGoogleReverse
} from './google-residential-enrichment.mjs';
import { evaluateMapplsAddressResults, requestMapplsReverse } from './mappls-residential-enrichment.mjs';
import { streetAddressKey } from '../../src/domain/address-quality.mjs';
import { countryBoundAreas } from '../../src/domain/country-bounds.mjs';
import { runProcess } from './process.mjs';
import { assignRegionsToFile, regionBoundaryCountries } from './region-boundaries.mjs';

const syncRoot = resolve(fileURLToPath(new URL('.', import.meta.url)));
const catalogFile = resolve(syncRoot, 'source-shards.json');
const adminBoundaryBuilder = resolve(syncRoot, 'admin-boundary-build.py');
const adminBoundaryAssigner = resolve(syncRoot, 'admin-boundary-assign.py');
const adminBoundaryCatalog = JSON.parse(readFileSync(resolve(syncRoot, 'admin-boundaries.json'), 'utf8'));
const adminBoundaryAdapters = new Set(['geofabrik', 'overture', 'openaddresses-archive']);
const adminBoundaryFormats = new Set(['overture-jsonl', 'geofabrik-geojsonseq']);
const overtureExporter = resolve(syncRoot, 'overture-export.py');
const geofabrikExporter = resolve(syncRoot, 'geofabrik-export.py');
const googleResidentialSeedExporter = resolve(syncRoot, 'google-residential-seeds.py');
const singaporeHdbExporter = resolve(syncRoot, 'singapore-hdb-export.py');
const koreaKaptExporter = resolve(syncRoot, 'korea-kapt-export.py');
const openAddressesExporter = resolve(syncRoot, 'openaddresses-export.py');
const inegiResidentialExporter = resolve(syncRoot, 'inegi-residential-export.py');
const ethekwiniResidentialExporter = resolve(syncRoot, 'south-africa-ethekwini-export.py');
const capeTownResidentialExporter = resolve(syncRoot, 'south-africa-cape-town-export.py');
const thailandDptResidentialExporter = resolve(syncRoot, 'thailand-dpt-export.py');
const canadaNarExporter = resolve(syncRoot, 'canada-nar-export.py');
const franceBdnbExporter = resolve(syncRoot, 'france-bdnb-export.py');
const spainCatastroExporter = resolve(syncRoot, 'spain-catastro-export.py');
const taiwanResidentialExporter = resolve(syncRoot, 'taiwan-residential-export.py');
const hongKongResidentialExporter = resolve(syncRoot, 'hong-kong-residential-export.py');
// v8 writes each row's popular-city tier and rank; the importer fills popular metro areas first.
const overtureResidentialRevision = 'addresses-streets-residential-subset-v8-popular-ranks';
const geofabrikExportRevision = 'g70-streets';
const googleResidentialRevision = 'osm-address-street-google-geocoding-v10-city-level';
const singaporeHdbExportRevision = 'hdb-property-address-onemap-streets-v6';
const koreaKaptExportRevision = 'kapt-official-addresses-geoapify-streets-v7';
const openAddressesExportRevision = 'archive-address-streets-v3';
const inegiResidentialExportRevision = 'official-dwelling-v1';
const ethekwiniResidentialExportRevision = 'official-address-zoning-postcode-v1';
const capeTownResidentialExportRevision = 'official-parcel-zoning-postcode-v2';
const thailandDptResidentialExportRevision = 'official-building-residential-v3';
const canadaNarExportRevision = 'statcan-nar-pumf-v1';
const franceBdnbExportRevision = 'bdnb-ban-fiabilite17-v3';
const spainCatastroExportRevision = 'inspire-residential-join-v2';
const taiwanResidentialExportRevision = 'molit-lvr-oa-post-v2';
const hongKongResidentialExportRevision = 'bd-building-information-v1';
const mapplsResidentialRevision = 'osm-source-address-street-mappls-reverse-v5-city-level';
const pdokBagRevision = 'strict-active-residential-coverage-round-robin-v2';
// Raised per-run record caps change what file-based sources can extract.
const capacityRevision = 'capacity-20261003';
export const sourceAdapterRevisions = Object.freeze({
  overture: `${overtureResidentialRevision}+${capacityRevision}`,
  geofabrik: `${geofabrikExportRevision}+${capacityRevision}`,
  'google-residential-enrichment': googleResidentialRevision,
  'singapore-hdb': singaporeHdbExportRevision,
  'korea-kapt': koreaKaptExportRevision,
  'openaddresses-archive': `${openAddressesExportRevision}+${capacityRevision}`,
  'inegi-residential': `${inegiResidentialExportRevision}+${capacityRevision}`,
  'ethekwini-residential': `${ethekwiniResidentialExportRevision}+${capacityRevision}`,
  'cape-town-residential': `${capeTownResidentialExportRevision}+${capacityRevision}`,
  'thailand-dpt-residential': `${thailandDptResidentialExportRevision}+${capacityRevision}`,
  'canada-nar-residential': canadaNarExportRevision,
  'france-bdnb-residential': `${franceBdnbExportRevision}+${capacityRevision}`,
  'spain-catastro-residential': `${spainCatastroExportRevision}+${capacityRevision}`,
  'taiwan-residential': `${taiwanResidentialExportRevision}+${capacityRevision}`,
  // Discovery markers: the catalogue API (HK) and the top-level OGC `updated` field (NL) reach sources that earlier
  // discovery could not, so only these sources leave their latched failures.
  'hong-kong-residential': `${hongKongResidentialExportRevision}+${capacityRevision}+ckan-discovery`,
  'mappls-residential': mapplsResidentialRevision,
  'pdok-bag': `${pdokBagRevision}+${capacityRevision}+ogc-updated`
});

export const adminBoundaryRevision = (countryCode) => {
  const entry = adminBoundaryCatalog.countries[String(countryCode || '').toUpperCase()];
  return entry ? `adm${entry.revision}-${createHash('sha256').update(JSON.stringify(entry)).digest('hex').slice(0, 12)}` : '';
};

export const sourceCapabilityRevision = (shard) => {
  const adapter = String(shard?.source?.adapter || '');
  const boundary = adminBoundaryAdapters.has(adapter) ? adminBoundaryRevision(shard?.countryCode) : '';
  const base = `${sourceAdapterRevisions[adapter] || ''}${boundary ? `:${boundary}` : ''}${shard?.priority
    // A popular region's raised cap is new extractable capacity for that shard alone.
    ? `:popular-${createHash('sha256').update(JSON.stringify({ maxRecords: shard.maxRecords ?? null, priority: shard.priority }))
      .digest('hex').slice(0, 12)}` : ''}`;
  const inputs = shard?.source?.capabilityInputs;
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) return base;
  return `${base}:cap-${createHash('sha256').update(JSON.stringify({
    maxRecords: shard.maxRecords ?? null,
    inputs
  })).digest('hex').slice(0, 16)}`;
};
// geoBoundaries gbOpen has no entries for these territories; use the exact OSM admin relations instead.
const osmBoundaryRelations = { HKG: 913110, MAC: 1867188 };

export const countryBounds = Object.fromEntries(
  Object.entries(countryBoundAreas).map(([country, areas]) => [country, [
    Math.min(...areas.map((area) => area[0])),
    Math.min(...areas.map((area) => area[1])),
    Math.max(...areas.map((area) => area[2])),
    Math.max(...areas.map((area) => area[3]))
  ]])
);

export const countryBoundBoxes = (shard) => shard.bounds
  ? [shard.bounds]
  : (countryBoundAreas[shard.countryCode] || (countryBounds[shard.countryCode] ? [countryBounds[shard.countryCode]] : []));

export const overtureBoundsArgs = (boxes) => {
  if (!boxes.length) return [];
  return ['--bounds', ...boxes[0].map(String),
    ...boxes.slice(1).flatMap((box) => ['--bounds-extra', ...box.map(String)])];
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

const sourceStateError = (label, cause) => Object.assign(new Error(`${label} is invalid`, { cause }), { code: 'SOURCE_STATE_INVALID' });
const existingFileSize = async (file) => {
  try {
    const metadata = await stat(file);
    return metadata.isFile() ? metadata.size : null;
  }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw sourceStateError(`Source file ${file}`, error);
  }
};
const optionalStateText = async (file, label) => {
  try { return await readFile(file, 'utf8'); }
  catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw sourceStateError(label, error);
  }
};
const readPersistedJson = async (file, label) => {
  let value;
  try { value = await readFile(file, 'utf8'); }
  catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw sourceStateError(label, error);
  }
  try { return JSON.parse(value); }
  catch (error) { throw sourceStateError(label, error); }
};

const retryableStatus = (status) => status === 408 || status === 429 || status >= 500;
const wait = (milliseconds, signal) => {
  if (!signal) return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
  signal.throwIfAborted();
  return new Promise((resolveWait, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolveWait();
    }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
  });
};
const execFileAsync = promisify(execFile);

const curlMetadataFetch = async (input, init = {}) => {
  const url = String(input);
  const parseHeaders = (stdout) => {
    const blocks = stdout.split(/\r?\n\r?\n/u).map((value) => value.trim()).filter((value) => /^HTTP\//u.test(value));
    const lines = (blocks.at(-1) || '').split(/\r?\n/u);
    const status = Number(lines.shift()?.match(/^HTTP\/\S+\s+(\d+)/u)?.[1] || 200);
    const headers = new Headers();
    for (const line of lines) {
      const separator = line.indexOf(':');
      if (separator > 0) headers.append(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
    }
    return new Response(null, { status, headers });
  };
  if ((init.method || 'GET') === 'HEAD') {
    const { stdout } = await execFileAsync('curl', ['-4', '-sSLI', '--connect-timeout', '15', '--max-time', '60', url], {
      encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true, signal: init.signal
    });
    return parseHeaders(stdout);
  }
  if (new Headers(init.headers).has('range')) {
    const sink = process.platform === 'win32' ? 'NUL' : '/dev/null';
    const { stdout } = await execFileAsync('curl', ['-4', '-fsSL', '-r', '0-0', '-D', '-', '-o', sink,
      '--connect-timeout', '15', '--max-time', '60', url], {
      encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true, signal: init.signal
    });
    return parseHeaders(stdout);
  }
  const { stdout } = await execFileAsync('curl', ['-4', '-fsSL', '--connect-timeout', '15', '--max-time', '60', url], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true, signal: init.signal
  });
  return new Response(stdout, { status: 200, headers: { 'Content-Type': 'application/json' } });
};

// Geofabrik redirects `*-latest.osm.pbf` to a dated file, but stale edge caches can answer with
// self-redirect loops. Follow hops manually; when that fails, derive the dated name from the
// extract's replication state timestamp and confirm it exists. URLs end without a slash so
// `.md5` siblings resolve.
const curlText = (args, signal) => execFileAsync('curl', ['-4', ...args, '--connect-timeout', '15', '--max-time', '60'],
  { encoding: 'utf8', maxBuffer: 1024 * 1024, windowsHide: true, signal }).then(({ stdout }) => stdout);
const lastHeaderBlock = (text) => String(text).split(/\r?\n\r?\n/u).map((value) => value.trim())
  .filter((value) => /^HTTP\//u.test(value)).at(-1) || '';
const headerStatus = (block) => Number(block.match(/^HTTP\/\S+\s+(\d+)/u)?.[1] || 0);
export const resolveGeofabrikPbfUrl = async (url, {
  signal,
  head = (target) => curlText(['-sSI', target], signal),
  get = (target) => curlText(['-fsSL', target], signal),
  now = () => new Date()
} = {}) => {
  const visited = new Set();
  let current = url;
  let failure;
  for (let hop = 0; hop < 10 && !failure; hop += 1) {
    visited.add(current);
    const block = lastHeaderBlock(await head(current));
    const status = headerStatus(block);
    if (status >= 200 && status < 300) return current.replace(/\/+$/u, '');
    const location = block.match(/^location:\s*(\S+)/imu)?.[1];
    if (status < 300 || status >= 400 || !location) { failure = new Error(`Geofabrik URL did not resolve (${status}): ${url}`); break; }
    let next = new URL(location, current).href;
    if (visited.has(next)) next = next.endsWith('/') ? next.replace(/\/+$/u, '') : `${next}/`;
    if (visited.has(next)) failure = new Error(`Geofabrik redirect loop: ${url}`);
    else current = next;
  }
  failure ||= new Error(`Geofabrik redirect chain too long: ${url}`);
  const base = url.match(/^(.*)-latest\.osm\.pbf$/u)?.[1];
  if (!base) throw failure;
  // Newest first: the replication state date (when reachable), then the last week of daily extracts.
  const timestamp = (await get(`${base}-updates/state.txt`).catch(() => ''))
    .match(/^timestamp=(\d{4})-(\d{2})-(\d{2})T/mu);
  const stateDay = timestamp ? Date.UTC(Number(timestamp[1]), Number(timestamp[2]) - 1, Number(timestamp[3])) : null;
  const today = Date.UTC(now().getUTCFullYear(), now().getUTCMonth(), now().getUTCDate());
  const days = [...new Set([
    ...(stateDay === null ? [] : [stateDay, stateDay + 86_400_000, stateDay - 86_400_000]),
    ...Array.from({ length: 8 }, (_, index) => today - index * 86_400_000)
  ])];
  for (const day of days) {
    const date = new Date(day).toISOString();
    const candidate = `${base}-${date.slice(2, 4)}${date.slice(5, 7)}${date.slice(8, 10)}.osm.pbf`;
    if (headerStatus(lastHeaderBlock(await head(candidate).catch(() => ''))) === 200) return candidate;
  }
  throw failure;
};

const jsonRequest = async (url, fetchImpl, { attempts = 3, signal } = {}) => {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    signal?.throwIfAborted();
    try {
      const response = await fetchImpl(url, {
        headers: { Accept: 'application/json' },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000)
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
      await wait(250 * 2 ** (attempt - 1), signal);
    }
  }
  throw lastError;
};

const headRequest = async (url, fetchImpl, { attempts = 3, signal } = {}) => {
  let lastError;
  let lastResponse;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    signal?.throwIfAborted();
    try {
      const response = await fetchImpl(url, { method: 'HEAD', signal });
      if (response.ok || !retryableStatus(response.status)) return response;
      lastResponse = response;
    } catch (error) {
      if (signal?.aborted) signal.throwIfAborted();
      lastError = error;
    }
    if (attempt < attempts) await wait(250 * 2 ** (attempt - 1), signal);
  }
  if (lastResponse) return lastResponse;
  throw lastError;
};

const safeVersion = (value) => String(value).replace(/[^a-zA-Z0-9._-]/gu, '_').slice(0, 96);
export const normalizedCachePolicyIdentity = (maxRecords, perLocality) =>
  `m${Number(maxRecords)}-p${Number(perLocality)}`;
const intersects = (left, right) => left[0] <= right[2] && left[2] >= right[0] && left[1] <= right[3] && left[3] >= right[1];
const headerNumber = (headers, name) => {
  const value = Number(headers.get(name));
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
};

export const sourceSizeMatches = (actual, expected) => expected === null
  || (actual >= Math.floor(expected * 0.75) && actual <= Math.ceil(expected * 1.25));

const pdokText = (value) => String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim();

export const normalizePdokBagFeature = (feature, sourceName = 'Kadaster BAG') => {
  const properties = feature?.properties;
  const coordinates = feature?.geometry?.type === 'Point' ? feature.geometry.coordinates : null;
  if (!properties || !Array.isArray(coordinates) || properties.gebruiksdoel !== 'woonfunctie'
    || properties.status !== 'Verblijfsobject in gebruik' || properties.geconstateerd !== 'N'
    || properties.hoofdadres_status !== 'Naamgeving uitgegeven'
    || properties.openbare_ruimte_status !== 'Naamgeving uitgegeven'
    || properties.woonplaats_status !== 'Woonplaats aangewezen') return null;
  const sourceRecordId = pdokText(properties.identificatie);
  const houseNumber = Number(properties.huisnummer);
  const houseLetter = pdokText(properties.huisletter);
  const addition = pdokText(properties.toevoeging);
  const street = pdokText(properties.openbare_ruimte_naam);
  const locality = pdokText(properties.woonplaats_naam);
  const admin1 = pdokText(properties.provincie_naam);
  const postcode = pdokText(properties.postcode).toUpperCase().replace(/\s+/gu, '');
  const longitude = Number(coordinates[0]);
  const latitude = Number(coordinates[1]);
  const safeSuffix = (value) => !value || /^[\p{L}\p{N} .'/+-]{1,16}$/u.test(value);
  if (!/^\d{16}$/u.test(sourceRecordId) || !Number.isSafeInteger(houseNumber) || houseNumber < 1
    || !safeSuffix(houseLetter) || !safeSuffix(addition) || !street || !locality || !admin1
    || !/^\d{4}[A-Z]{2}$/u.test(postcode) || !Number.isFinite(longitude) || !Number.isFinite(latitude)
    || longitude < 3 || longitude > 8 || latitude < 50 || latitude > 54) return null;
  const number = `${houseNumber}${houseLetter}${addition ? `-${addition}` : ''}`;
  return {
    id: sourceRecordId,
    source_record_id: sourceRecordId,
    source_dataset: sourceName,
    number,
    street,
    locality,
    postal_city: locality,
    admin1,
    postcode,
    longitude,
    latitude,
    property_type: 'residential',
    residential_building_id: sourceRecordId,
    residential_building_class: 'bag:woonfunctie'
  };
};

export const selectDispersedSeeds = (values, maximum = 400) => {
  const cells = new Map();
  for (const value of values || []) {
    const latitude = Number(value.latitude);
    const longitude = Number(value.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)
      || longitude < 3 || longitude > 8 || latitude < 50 || latitude > 54) continue;
    const key = `${Math.round(latitude / 0.08)}:${Math.round(longitude / 0.12)}`;
    if (!cells.has(key)) cells.set(key, { latitude, longitude });
  }
  const candidates = [...cells.values()];
  if (candidates.length <= maximum) return candidates;
  const selected = [candidates.splice(Math.floor(candidates.length / 2), 1)[0]];
  const minimumDistances = candidates.map((candidate) =>
    (candidate.latitude - selected[0].latitude) ** 2 + (candidate.longitude - selected[0].longitude) ** 2);
  while (selected.length < maximum && candidates.length) {
    let bestIndex = 0;
    for (let index = 1; index < candidates.length; index += 1) {
      if (minimumDistances[index] > minimumDistances[bestIndex]) bestIndex = index;
    }
    const [latest] = candidates.splice(bestIndex, 1);
    minimumDistances.splice(bestIndex, 1);
    selected.push(latest);
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      const distance = (candidate.latitude - latest.latitude) ** 2 + (candidate.longitude - latest.longitude) ** 2;
      minimumDistances[index] = Math.min(minimumDistances[index], distance);
    }
  }
  return selected;
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

const digestFile = async (file, algorithm) => {
  const hash = createHash(algorithm);
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
};

export const sha256File = (file) => digestFile(file, 'sha256');

const publishContentAddressed = async (temporary, destination, checksum) => {
  try {
    await rename(temporary, destination);
  } catch (error) {
    if (!['EEXIST', 'EPERM'].includes(error?.code)) throw error;
    const existingChecksum = await sha256File(destination).catch(() => null);
    if (existingChecksum !== checksum) throw error;
    await rm(temporary, { force: true });
  }
};

// Postcode locator pages often contain a changing nonce, timestamp, or
// analytics markup even when the actual postal rows are unchanged. Hash only
// visible semantic text so a dynamic wrapper cannot create a new source
// version on every queue pass.
export const canonicalizeHtmlText = (html) => {
  let value = String(html || '').replace(/<!--[\s\S]*?-->/gu, ' ');
  value = value.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/giu, ' ');
  value = value.replace(/<[^>]+>/gu, ' ')
    .replace(/&nbsp;|&#160;/giu, ' ')
    .replace(/&amp;/giu, '&')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLocaleLowerCase('und');
  return value;
};

export const stableHtmlFingerprint = async (file) => {
  const hash = createHash('sha256');
  let buffered = '';
  let skippedTag = null;
  const canonicalLine = (line) => {
    let value = line;
    while (value) {
      if (skippedTag) {
        const closing = value.search(new RegExp(`</${skippedTag}\\s*>`, 'iu'));
        if (closing < 0) return '';
        value = value.slice(closing).replace(new RegExp(`^</${skippedTag}\\s*>`, 'iu'), ' ');
        skippedTag = null;
      }
      const opening = value.match(/<(script|style|noscript)\b[^>]*>/iu);
      if (!opening) break;
      const before = value.slice(0, opening.index);
      const closing = value.slice((opening.index || 0) + opening[0].length)
        .search(new RegExp(`</${opening[1]}\\s*>`, 'iu'));
      if (closing < 0) {
        skippedTag = opening[1];
        value = before;
        break;
      }
      value = `${before} ${value.slice((opening.index || 0) + opening[0].length + closing)}`
        .replace(new RegExp(`^\\s*</${opening[1]}\\s*>`, 'iu'), ' ');
    }
    return canonicalizeHtmlText(value);
  };
  for await (const chunk of createReadStream(file)) {
    buffered += chunk.toString('utf8');
    const parts = buffered.split(/\r?\n/u);
    buffered = parts.pop() || '';
    for (const part of parts) {
      const canonical = canonicalLine(part);
      if (canonical) hash.update(canonical).update('\n');
    }
  }
  const canonical = canonicalLine(buffered);
  if (canonical) hash.update(canonical).update('\n');
  return hash.digest('hex').slice(0, 16);
};
const hasMinimumLines = async (file, minimum) => {
  if (minimum <= 1) return (await stat(file)).size > 0;
  let lines = 0;
  for await (const chunk of createReadStream(file, { encoding: 'utf8' })) {
    for (const character of chunk) {
      if (character === '\n' && ++lines >= minimum) return true;
    }
  }
  return false;
};
export const parseGeofabrikMd5 = (value) => String(value || '').match(/\b[a-f\d]{32}\b/iu)?.[0].toLowerCase() || null;

const environmentEnabled = (value) => /^(1|true|yes)$/iu.test(String(value || ''));

export const loadSourceCatalog = async (file = catalogFile, environment = process.env) => {
  const catalog = JSON.parse(await readFile(file, 'utf8'));
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.sources)) throw new Error('Unsupported source shard catalog');
  const shards = [];
  for (const configuredSource of catalog.sources) {
    if (configuredSource.enabledEnvironment && !environmentEnabled(environment[configuredSource.enabledEnvironment])) continue;
    const source = { ...configuredSource };
    if (source.licenseConfirmationEnvironment
      && !environmentEnabled(environment[source.licenseConfirmationEnvironment])) {
      source.configurationError = `missing_source_configuration:${source.licenseConfirmationEnvironment}`;
    }
    if (source.redistributionConfirmationEnvironment) {
      source.redistributionAllowed = environmentEnabled(environment[source.redistributionConfirmationEnvironment]);
      if (!source.redistributionAllowed) {
        source.configurationError ||= `missing_source_configuration:${source.redistributionConfirmationEnvironment}`;
      }
    }
    if (source.dataUrlEnvironment) {
      const configuredUrl = String(environment[source.dataUrlEnvironment] || '').trim();
      if (configuredUrl) source.dataUrl = configuredUrl;
      else source.configurationError = `missing_source_configuration:${source.dataUrlEnvironment}`;
    }
    const intervalDays = source.intervalDays || catalog.defaultIntervalDays;
    if (source.adapter === 'overture' && source.partitions) {
      for (const partition of source.partitions) shards.push({
        id: `${source.id}-${partition.shardId}`,
        countryCode: partition.countryCode,
        admin1: partition.admin1,
        partitionName: partition.name,
        bounds: partition.bounds,
        priority: partition.priority,
        maxRecords: partition.maxRecords ?? source.partitionDefaults?.maxRecords,
        qualityGate: partition.qualityGate ?? source.partitionDefaults?.qualityGate,
        intervalDays,
        source: { ...source, id: `${source.id}-${partition.shardId}`, name: `${source.name} (${partition.name})` }
      });
    } else if (source.adapter === 'overture') {
      // A countrywide Overture export samples the popular cities first, so it runs before the popular-region shards.
      for (const countryCode of source.countries || []) shards.push({
        id: `${source.id}-${countryCode.toLowerCase()}`, countryCode, intervalDays, popularCities: true, source
      });
    } else if (source.adapter === 'geofabrik') {
      for (const extract of source.extracts || []) shards.push({
        id: `${source.id}-${extract.shardId || extract.countryCode.toLowerCase()}`,
        countryCode: extract.countryCode,
        extractId: extract.extractId,
        boundaryIso3: extract.boundaryIso3,
        excludeBoundaryIso3: extract.excludeBoundaryIso3,
        postcodeDataUrl: extract.postcodeDataUrl,
        postcodeMetadataUrl: extract.postcodeMetadataUrl,
        postcodeMetadataFormat: extract.postcodeMetadataFormat,
        postcodeMetadataMatchUrl: extract.postcodeMetadataMatchUrl,
        postcodeDataFormat: extract.postcodeDataFormat,
        priority: extract.priority,
        maxRecords: extract.maxRecords ?? source.extractDefaults?.maxRecords,
        qualityGate: extract.qualityGate ?? source.extractDefaults?.qualityGate,
        intervalDays,
        source: extract.shardId || extract.capabilityInputs ? {
          ...source,
          ...(extract.shardId ? { id: `${source.id}-${extract.shardId}`, name: `${source.name} (${extract.name || extract.extractId})` } : {}),
          ...(extract.capabilityInputs ? { capabilityInputs: { ...(source.capabilityInputs || {}), ...extract.capabilityInputs } } : {})
        } : source
      });
    } else if (source.adapter === 'singapore-hdb') {
      shards.push({
        id: source.id,
        countryCode: 'SG',
        maxRecords: source.maxRecords,
        qualityGate: source.qualityGate,
        quotaProvider: source.quotaProvider,
        intervalDays,
        source
      });
    } else if (source.adapter === 'korea-kapt') {
      shards.push({
        id: source.id,
        countryCode: 'KR',
        extractId: source.extractId || 'korea',
        maxRecords: source.maxRecords,
        qualityGate: source.qualityGate,
        quotaProvider: source.quotaProvider,
        intervalDays,
        source
      });
    } else if (source.adapter === 'openaddresses-archive') {
      shards.push({
        id: source.id,
        countryCode: source.countryCode,
        maxRecords: source.maxRecords,
        qualityGate: source.qualityGate,
        intervalDays,
        source
      });
    } else if (source.adapter === 'inegi-residential') {
      shards.push({
        id: source.id,
        countryCode: 'MX',
        maxRecords: source.maxRecords,
        qualityGate: source.qualityGate,
        intervalDays,
        source
      });
    } else if (source.adapter === 'ethekwini-residential') {
      shards.push({
        id: source.id,
        countryCode: 'ZA',
        maxRecords: source.maxRecords,
        qualityGate: source.qualityGate,
        intervalDays,
        source
      });
    } else if (source.adapter === 'cape-town-residential') {
      shards.push({
        id: source.id,
        countryCode: 'ZA',
        maxRecords: source.maxRecords,
        qualityGate: source.qualityGate,
        intervalDays,
        source
      });
    } else if (source.adapter === 'thailand-dpt-residential') {
      shards.push({
        id: source.id,
        countryCode: 'TH',
        maxRecords: source.maxRecords,
        qualityGate: source.qualityGate,
        intervalDays,
        source
      });
    } else if (source.adapter === 'canada-nar-residential') {
      shards.push({
        id: source.id,
        countryCode: 'CA',
        maxRecords: source.maxRecords,
        qualityGate: source.qualityGate,
        intervalDays,
        source
      });
    } else if (source.adapter === 'france-bdnb-residential') {
      shards.push({
        id: source.id,
        countryCode: 'FR',
        maxRecords: source.maxRecords,
        qualityGate: source.qualityGate,
        intervalDays,
        source
      });
    } else if (source.adapter === 'spain-catastro-residential') {
      for (const municipality of source.municipalities || []) shards.push({
        id: `${source.id}-${municipality.code}`,
        countryCode: 'ES',
        maxRecords: municipality.maxRecords,
        qualityGate: municipality.qualityGate,
        intervalDays,
        source: {
          ...source,
          ...municipality,
          id: `${source.id}-${municipality.code}`,
          dataUrl: municipality.addressesUrl,
          municipalityName: municipality.name,
          name: `${source.name} (${municipality.name})`
        }
      });
    } else if (source.adapter === 'taiwan-residential') {
      shards.push({
        id: source.id,
        countryCode: 'TW',
        maxRecords: source.maxRecords,
        qualityGate: source.qualityGate,
        intervalDays,
        source
      });
    } else if (source.adapter === 'hong-kong-residential') {
      shards.push({
        id: source.id,
        countryCode: 'HK',
        maxRecords: source.maxRecords,
        qualityGate: source.qualityGate,
        intervalDays,
        source
      });
    } else if (source.adapter === 'mappls-residential') {
      shards.push({
        id: source.id,
        countryCode: source.countryCode,
        extractId: source.extractId,
        boundaryIso3: source.boundaryIso3,
        excludeBoundaryIso3: source.excludeBoundaryIso3,
        maxRecords: source.maxRecords,
        qualityGate: source.qualityGate,
        quotaProvider: source.quotaProvider,
        intervalDays,
        source
      });
    } else if (source.adapter === 'pdok-bag') {
      shards.push({
        id: source.id,
        countryCode: source.countryCode,
        maxRecords: source.maxRecords,
        qualityGate: source.qualityGate,
        quotaProvider: source.quotaProvider,
        intervalDays,
        source
      });
    } else if (source.adapter === 'google-residential-enrichment') {
      for (const extract of source.extracts || []) shards.push({
        id: `${source.id}-${extract.countryCode.toLowerCase()}`,
        countryCode: extract.countryCode,
        extractId: extract.extractId,
        boundaryIso3: extract.boundaryIso3,
        excludeBoundaryIso3: extract.excludeBoundaryIso3,
        maxRecords: extract.maxRecords ?? source.maxRecords,
        qualityGate: extract.qualityGate ?? source.qualityGate,
        quotaProvider: source.quotaProvider,
        intervalDays,
        source: extract.capabilityInputs ? {
          ...source,
          capabilityInputs: { ...(source.capabilityInputs || {}), ...extract.capabilityInputs }
        } : source
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
  environment = process.env,
  execute = runProcess,
  processConcurrency = 3,
  processTimeoutMs = Number(environment.ADDRESS_SYNC_PROCESS_TIMEOUT_MS || 75 * 60_000),
  signal,
  pythonBin = environment.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3'),
  enableOvertureResidential = environment.ADDRESS_SYNC_OVERTURE_BUILDINGS !== 'false',
  credentialPool = null,
  credentialBrokerClient = null,
  loadSeedLocations = async () => [],
  loadGoogleCoverageTargets = async () => [],
  resolveGeofabrikUrl = null
} = {}) => {
  const apiFetchImpl = fetchImpl;
  const useCurlTransport = fetchImpl === fetch;
  if (useCurlTransport) fetchImpl = curlMetadataFetch;
  const fetchJson = (url, options = {}) => jsonRequest(url, fetchImpl, {
    ...options,
    signal: options.signal || signal
  });
  const fetchHead = (url, options = {}) => headRequest(url, fetchImpl, {
    ...options,
    signal: options.signal || signal
  });
  let overtureCatalogPromise;
  let overtureBuildingCatalogPromise;
  let geofabrikIndexPromise;
  const processWaiters = [];
  let activeProcesses = 0;
  const processLimit = Number.isSafeInteger(processConcurrency) ? Math.max(1, processConcurrency) : 3;
  const acquireProcessSlot = (runSignal) => {
    runSignal?.throwIfAborted();
    if (activeProcesses < processLimit) {
      activeProcesses += 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal: runSignal, onAbort: undefined };
      const onAbort = () => {
        const index = processWaiters.indexOf(waiter);
        if (index >= 0) processWaiters.splice(index, 1);
        runSignal?.removeEventListener('abort', onAbort);
        reject(runSignal.reason);
      };
      waiter.onAbort = onAbort;
      runSignal?.addEventListener('abort', onAbort, { once: true });
      processWaiters.push(waiter);
    });
  };
  const releaseProcessSlot = () => {
    activeProcesses -= 1;
    while (processWaiters.length) {
      const waiter = processWaiters.shift();
      waiter.signal?.removeEventListener('abort', waiter.onAbort);
      if (waiter.signal?.aborted) {
        waiter.reject(waiter.signal.reason);
        continue;
      }
      activeProcesses += 1;
      waiter.resolve();
      return;
    }
  };
  const runExecute = async (options) => {
    const runSignal = options.signal || signal;
    await acquireProcessSlot(runSignal);
    try {
      return await execute({
        ...options,
        signal: runSignal,
        timeoutMs: options.timeoutMs || processTimeoutMs
      });
    }
    finally {
      releaseProcessSlot();
    }
  };
  const downloads = new Map();
  const verifiedDownloads = new Map();
  const sharedRawFiles = new Set();

  const environmentKeys = (baseName) => [baseName, ...Object.keys(environment)
    .filter((name) => name.startsWith(`${baseName}_`) && /^\d+$/u.test(name.slice(baseName.length + 1)))
    .sort((left, right) => Number(left.slice(baseName.length + 1)) - Number(right.slice(baseName.length + 1)))]
    .map((name) => String(environment[name] || '').trim())
    .filter(Boolean)
    .map((secret, index) => ({ id: `environment-${index}`, secret, disabled: false, cooldownUntil: 0 }));
  const mapplsEnvironmentCredentials = environmentKeys('MAPPLS_API_KEY');
  let mapplsEnvironmentCursor = 0;
  const mapplsCredentialPool = credentialPool || {
    acquire: async () => {
      const now = Date.now();
      for (let offset = 0; offset < mapplsEnvironmentCredentials.length; offset += 1) {
        const index = (mapplsEnvironmentCursor + offset) % mapplsEnvironmentCredentials.length;
        const credential = mapplsEnvironmentCredentials[index];
        if (!credential.disabled && credential.cooldownUntil <= now) {
          mapplsEnvironmentCursor = (index + 1) % mapplsEnvironmentCredentials.length;
          return credential;
        }
      }
      return null;
    },
    report: async (id, outcome, observation = {}) => {
      const credential = mapplsEnvironmentCredentials.find((entry) => entry.id === id);
      if (!credential || outcome === 'success') return;
      if (outcome === 'auth' || outcome === 'invalid') credential.disabled = true;
      else credential.cooldownUntil = Number.isFinite(Date.parse(observation.retryAt))
        ? Date.parse(observation.retryAt) : Date.now() + (outcome === 'quota' ? 60_000 : 5_000);
    }
  };

  const geoapifyEnvironmentCredentials = environmentKeys('GEOAPIFY_API_KEY')
    .map((credential) => ({ ...credential, used: 0, usageDate: '', lastUsedAt: 0 }));
  const geoapifyEnvironmentPool = {
    acquire: async (_provider, { excludeIds = [] } = {}) => {
      const excluded = new Set(excludeIds);
      const now = Date.now();
      const usageDate = new Date(now).toISOString().slice(0, 10);
      for (const credential of geoapifyEnvironmentCredentials) {
        if (credential.usageDate !== usageDate) {
          credential.usageDate = usageDate;
          credential.used = 0;
        }
        if (!excluded.has(credential.id) && !credential.disabled && credential.cooldownUntil <= now
            && credential.used < 3000 && credential.lastUsedAt + 200 <= now) {
          credential.lastUsedAt = now;
          return credential;
        }
      }
      return null;
    },
    report: async (id, outcome, observation = {}) => {
      const credential = geoapifyEnvironmentCredentials.find((entry) => entry.id === id);
      if (!credential) return;
      credential.used += 1;
      if (outcome === 'auth' || outcome === 'invalid') credential.disabled = true;
      else if (outcome !== 'success') credential.cooldownUntil = Number.isFinite(Date.parse(observation.retryAt))
        ? Date.parse(observation.retryAt) : Date.now() + (outcome === 'quota' ? 24 * 60 * 60_000 : 5_000);
    }
  };
  const geoapifyCredentialPool = credentialPool || geoapifyEnvironmentPool;

  const loadStacItems = async (collectionUrl, collection) => {
    const links = collection.links.filter((link) => link.rel === 'item');
    const items = [];
    for (let offset = 0; offset < links.length; offset += 32) {
      items.push(...await Promise.all(links.slice(offset, offset + 32).map((link) =>
        fetchJson(new URL(link.href, collectionUrl).href))));
    }
    return items;
  };

  const overtureCatalog = async () => {
    if (!overtureCatalogPromise) overtureCatalogPromise = (async () => {
      const rootUrl = 'https://stac.overturemaps.org/catalog.json';
      const root = await fetchJson(rootUrl);
      if (!/^20\d{2}-\d{2}-\d{2}\.\d+$/u.test(root.latest || '')) throw new Error('Overture STAC did not return a valid latest release');
      const collectionUrl = `https://stac.overturemaps.org/${root.latest}/addresses/address/collection.json`;
      const collection = await fetchJson(collectionUrl);
      const items = await loadStacItems(collectionUrl, collection);
      return { version: root.latest, collectionUrl, items };
    })();
    return overtureCatalogPromise;
  };

  const overtureBuildingCatalog = async () => {
    if (!overtureBuildingCatalogPromise) overtureBuildingCatalogPromise = (async () => {
      const addressCatalog = await overtureCatalog();
      const collectionUrl = `https://stac.overturemaps.org/${addressCatalog.version}/buildings/building/collection.json`;
      const collection = await fetchJson(collectionUrl);
      return { collectionUrl, items: await loadStacItems(collectionUrl, collection) };
    })();
    return overtureBuildingCatalogPromise;
  };

  const geofabrikIndex = async () => {
    if (!geofabrikIndexPromise) {
      geofabrikIndexPromise = fetchJson('https://download.geofabrik.de/index-v1-nogeom.json')
        .catch((error) => {
          geofabrikIndexPromise = undefined;
          throw error;
        });
    }
    return geofabrikIndexPromise;
  };
  const resolvedGeofabrikUrls = new Map();
  const geofabrikPbfUrl = (url) => {
    const resolver = resolveGeofabrikUrl || (useCurlTransport ? (target) => resolveGeofabrikPbfUrl(target, { signal }) : null);
    if (!url || !resolver) return Promise.resolve(url);
    if (!resolvedGeofabrikUrls.has(url)) {
      resolvedGeofabrikUrls.set(url, Promise.resolve(resolver(url))
        .catch((error) => { resolvedGeofabrikUrls.delete(url); throw error; }));
    }
    return resolvedGeofabrikUrls.get(url);
  };

  let usaStructuresIndexPromise;
  // FEMA/ORNL USA Structures publishes per-state FileGDB archives in a public S3 bucket; the newest dated archive wins.
  const usaStructuresArchive = async (shard) => {
    const { bucketUrl, prefix } = shard.source.residentialStructures;
    if (!usaStructuresIndexPromise) usaStructuresIndexPromise = (async () => {
      const archives = new Map();
      let token = '';
      do {
        const url = new URL(bucketUrl);
        url.searchParams.set('list-type', '2');
        url.searchParams.set('prefix', prefix);
        if (token) url.searchParams.set('continuation-token', token);
        const response = await fetchImpl(url, { signal });
        if (!response.ok) throw new SourceMetadataError('USA Structures listing unavailable', { url: url.href, status: response.status });
        const body = await response.text();
        for (const [, key] of body.matchAll(/<Key>([^<]+)<\/Key>/gu)) {
          const match = key.slice(prefix.length).match(/^([^/]+)\/(?:Deliverable(\d{8})[A-Z]{2}|[A-Z]{2}_Structures_(\d{8}))\.zip$/u);
          const version = match?.[2] || match?.[3];
          if (!version || !/^20\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])$/u.test(version)) continue;
          const folder = match[1].replace(/&amp;/gu, '&');
          if ((archives.get(folder)?.version || '') >= version) continue;
          archives.set(folder, { url: new URL(key.split('/').map(encodeURIComponent).join('/'), bucketUrl).href, version });
        }
        token = body.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/u)?.[1] || '';
      } while (token);
      return archives;
    })().catch((error) => { usaStructuresIndexPromise = null; throw error; });
    const archive = (await usaStructuresIndexPromise).get(shard.partitionName);
    // One state without an archive keeps its Overture addresses; residential evidence then comes from Overture
    // Buildings instead of failing the whole country run.
    if (!archive) console.warn(`USA Structures has no archive for ${shard.admin1}`);
    return archive || null;
  };

  const discoverOverture = async (shard, { includeAssetSizes = false } = {}) => {
    const catalog = await overtureCatalog();
    const bounds = shard.bounds || countryBounds[shard.countryCode];
    if (!bounds) throw new Error(`Missing Overture bounds for ${shard.countryCode}`);
    const center = [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2];
    const assets = catalog.items
      .filter((item) => Array.isArray(item.bbox) && intersects(bounds, item.bbox))
      .sort((left, right) => {
        const distance = (item) => Math.abs((item.bbox[0] + item.bbox[2]) / 2 - center[0])
          + Math.abs((item.bbox[1] + item.bbox[3]) / 2 - center[1]);
        return distance(left) - distance(right);
      })
      .map((item) => item.assets?.aws?.href)
      .filter((url) => typeof url === 'string' && url.startsWith('https://'));
    if (!assets.length) throw new Error(`Overture STAC has no intersecting address assets for ${shard.countryCode}`);
    let buildingAssets = [];
    let buildingAssetEntries = [];
    const structures = shard.source.residentialStructures ? await usaStructuresArchive(shard) : null;
    if (enableOvertureResidential && !structures) {
      try {
        const buildingCatalog = await overtureBuildingCatalog();
        buildingAssetEntries = buildingCatalog.items
          .filter((item) => Array.isArray(item.bbox) && intersects(bounds, item.bbox))
          .map((item) => ({ url: item.assets?.aws?.href, bbox: item.bbox }))
          .filter((entry) => typeof entry.url === 'string' && entry.url.startsWith('https://'));
        buildingAssets = buildingAssetEntries.map(({ url }) => url);
      } catch (error) {
        if (signal?.aborted) signal.throwIfAborted();
        console.warn(`Overture Buildings discovery failed for ${shard.countryCode}: ${error.message}`);
      }
    }
    let sourceBytes = null;
    if (includeAssetSizes) {
      const sizes = await Promise.all(assets.map(async (url) => {
        const response = await fetchHead(url);
        return response.ok ? headerNumber(response.headers, 'content-length') : null;
      }));
      sourceBytes = sizes.every(Number.isSafeInteger) ? sizes.reduce((sum, value) => sum + value, 0) : null;
    }
    return {
      adapter: 'overture',
      version: structures ? `${catalog.version}+usa-structures-${structures.version}` : catalog.version,
      structuresUrl: structures?.url || null,
      residentialBuildingAvailable: structures ? true : undefined,
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
    if (!feature?.properties?.urls?.pbf) throw new Error(`Geofabrik extract is missing: ${shard.extractId}`);
    const dataUrl = await geofabrikPbfUrl(feature.properties.urls.pbf);
    const response = await fetchHead(dataUrl);
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
    let postcodeMetadataVersion = null;
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
    if (shard.postcodeDataUrl) {
      let metadataIdentity;
      if (shard.postcodeMetadataUrl) {
        const postcodeMetadata = await fetchImpl(shard.postcodeMetadataUrl, {
          headers: { Accept: shard.postcodeMetadataFormat === 'sitemap' ? 'application/xml' : 'application/json' }, signal
        });
        if (!postcodeMetadata.ok) {
          throw new Error(`Official postcode metadata request failed (${postcodeMetadata.status}): ${shard.postcodeMetadataUrl}`);
        }
        const metadataText = await postcodeMetadata.text();
        if (shard.postcodeMetadataFormat === 'sitemap') {
          const entries = [...metadataText.matchAll(/<url>([\s\S]*?)<\/url>/giu)].map((match) => match[1]);
          const selected = entries.find((entry) => entry.includes(`<loc>${shard.postcodeMetadataMatchUrl}</loc>`));
          const modified = selected?.match(/<lastmod>([^<]+)<\/lastmod>/iu)?.[1];
          if (!modified) throw new Error(`Official postcode sitemap entry is missing: ${shard.postcodeMetadataMatchUrl}`);
          metadataIdentity = `${shard.postcodeMetadataMatchUrl}\u001f${modified}`;
        } else metadataIdentity = `${shard.postcodeMetadataUrl}\u001f${metadataText}`;
      } else {
        const postcodeMetadata = await fetchHead(shard.postcodeDataUrl, {
          headers: { Accept: shard.postcodeDataFormat === 'pdf' ? 'application/pdf' : 'text/html' }
        });
        if (!postcodeMetadata.ok) {
          throw new Error(`Official postcode metadata request failed (${postcodeMetadata.status}): ${shard.postcodeDataUrl}`);
        }
        const contentLength = postcodeMetadata.headers.get('content-length');
        metadataIdentity = [
          shard.postcodeDataUrl,
          postcodeMetadata.headers.get('etag')?.replaceAll('"', '') || '',
          postcodeMetadata.headers.get('last-modified') || '',
          Number(contentLength) > 0 ? contentLength : ''
        ].join('\u001f');
      }
      if (metadataIdentity.replaceAll('\u001f', '')) {
        postcodeMetadataVersion = createHash('sha256').update(metadataIdentity).digest('hex').slice(0, 16);
        version = `${version}-p${postcodeMetadataVersion}`;
      }
    }
    if (syncMode === 'probe') {
      return {
        adapter: 'geofabrik', version, publishedAt, dataUrl, sourceBytes,
        etag: discoveryEtag, lastModified: modified, estimateMethod: 'metadata-probe'
      };
    }
    let boundaryUrl = null;
    const boundaryDownloadUrl = async (iso3) => {
      const relation = osmBoundaryRelations[iso3];
      if (relation) return `https://polygons.openstreetmap.fr/get_geojson.py?id=${relation}&params=0`;
      const boundary = await fetchJson(`https://www.geoboundaries.org/api/current/gbOpen/${iso3}/ADM0/`);
      if (!String(boundary.gjDownloadURL || '').startsWith('https://')) throw new Error(`Country boundary is missing: ${iso3}`);
      return boundary.gjDownloadURL;
    };
    if (shard.boundaryIso3) boundaryUrl = await boundaryDownloadUrl(shard.boundaryIso3);
    const excludeBoundaryUrls = [];
    for (const iso3 of shard.excludeBoundaryIso3 || []) {
      excludeBoundaryUrls.push(await boundaryDownloadUrl(iso3));
    }
    let postcodeDataUrl = null;
    let postcodeDataFormat = null;
    let postcodeVersion = null;
    let postcodeBytes = null;
    let postcodeFile = null;
    if (shard.postcodeDataUrl) {
      postcodeDataFormat = shard.postcodeDataFormat || 'html';
      if (!['html', 'pdf'].includes(postcodeDataFormat)) {
        throw new Error(`Unsupported postcode data format: ${postcodeDataFormat}`);
      }
      postcodeDataUrl = shard.postcodeDataUrl;
      if (cacheDir) {
        const rawDir = resolve(cacheDir, 'raw');
        await mkdir(rawDir, { recursive: true });
        const identity = createHash('sha256').update(`${postcodeDataUrl}\u001f${postcodeDataFormat}`).digest('hex').slice(0, 16);
        postcodeFile = resolve(rawDir, `${shard.id}-postcodes-${identity}.${postcodeDataFormat}`);
        postcodeBytes = await download(postcodeDataUrl, postcodeFile, {
          expectedBytes: null,
          maxBytes: Math.max(10 * 1024 * 1024, Number(shard.source?.postcodeMaxBytes || 512 * 1024 * 1024)),
          forceRefresh: postcodeDataFormat === 'html'
        });
        if (postcodeBytes < 100_000) throw new Error(`Official postcode source is unexpectedly small: ${postcodeBytes}`);
        postcodeVersion = postcodeMetadataVersion || (postcodeDataFormat === 'html'
          ? await stableHtmlFingerprint(postcodeFile)
          : await sha256File(postcodeFile).then((value) => value.slice(0, 16)));
      } else {
        const postcodeResponse = await fetchImpl(shard.postcodeDataUrl, {
          headers: { Accept: postcodeDataFormat === 'pdf' ? 'application/pdf' : 'text/html' },
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000)
        });
        if (!postcodeResponse.ok) {
          throw new Error(`Official postcode source request failed (${postcodeResponse.status}): ${shard.postcodeDataUrl}`);
        }
        const postcodeContent = Buffer.from(await postcodeResponse.arrayBuffer());
        postcodeBytes = postcodeContent.byteLength;
        if (postcodeBytes < 100_000) throw new Error(`Official postcode source is unexpectedly small: ${postcodeBytes}`);
        postcodeVersion = postcodeMetadataVersion || (postcodeDataFormat === 'html'
          ? createHash('sha256').update(canonicalizeHtmlText(postcodeContent.toString('utf8'))).digest('hex').slice(0, 16)
          : createHash('sha256').update(postcodeContent).digest('hex').slice(0, 16));
      }
      if (!postcodeMetadataVersion) version = `${version}-p${postcodeVersion}`;
    }
    return {
      adapter: 'geofabrik', version, publishedAt,
      dataUrl, sourceBytes, etag: discoveryEtag,
      lastModified: modified, boundaryUrl, excludeBoundaryUrls, estimateMethod, bootstrapRawFile,
      postcodeDataUrl, postcodeDataFormat, postcodeVersion, postcodeBytes, postcodeFile
    };
  };

  const discoverGoogleResidential = async (shard, options) => {
    requireLicensedSource(shard.source);
    const index = await geofabrikIndex();
    const feature = index.features?.find((entry) => entry.properties?.id === shard.extractId);
    if (!feature?.properties?.urls?.pbf) throw new Error(`Geofabrik extract is missing: ${shard.extractId}`);
    const dataUrl = await geofabrikPbfUrl(feature.properties.urls.pbf);
    const rawRoot = options?.cacheDir ? resolve(options.cacheDir, 'raw') : null;
    if (rawRoot) {
      const prefix = `${shard.id}-state-`;
      let entries = [];
      try { entries = await readdir(rawRoot, { withFileTypes: true }); } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
        try {
          const progress = await readPersistedJson(resolve(rawRoot, entry.name, 'progress.json'), 'Google residential checkpoint');
          if (progress === undefined) continue;
          if (!progress || typeof progress !== 'object' || Array.isArray(progress)) {
            throw sourceStateError('Google residential checkpoint');
          }
          if (progress.schemaVersion !== 2 || progress.version !== googleResidentialRevision
            || !String(progress.rawVersion || '') || !/^[a-f\d]{64}$/u.test(String(progress.sourceChecksum || ''))) continue;
          // Checkpoints created before dated-extract resolution keyed their raw file by the `-latest` URL.
          let resumed = null;
          for (const candidateUrl of [...new Set([dataUrl, feature.properties.urls.pbf])]) {
            const rawIdentity = createHash('sha256')
              .update(`${candidateUrl}\u001f${progress.rawVersion}`).digest('hex').slice(0, 16);
            const sourceBytes = await existingFileSize(resolve(rawRoot, `${rawIdentity}-${basename(new URL(candidateUrl).pathname)}`));
            if (sourceBytes > 0) { resumed = { dataUrl: candidateUrl, sourceBytes }; break; }
          }
          if (!resumed) throw sourceStateError('Google residential raw source', new Error('Raw source is missing or empty'));
          return {
            adapter: 'google-residential-enrichment', version: googleResidentialRevision,
            rawVersion: progress.rawVersion, publishedAt: null, ...resumed,
            estimateMethod: 'resumable-checkpoint'
          };
        } catch (error) {
          if (error?.code === 'SOURCE_STATE_INVALID') throw error;
          if (error?.code !== 'ENOENT') throw error;
        }
      }
    }
    const source = await discoverGeofabrik(shard, options);
    return {
      ...source,
      adapter: 'google-residential-enrichment',
      version: googleResidentialRevision,
      rawVersion: source.version,
      publishedAt: null,
      estimateMethod: 'fixed-residential-seed-cap'
    };
  };

  const dataGovDownload = async (datasetId) => {
    const baseUrl = `https://api-open.data.gov.sg/v1/public/api/datasets/${datasetId}`;
    let payload = await fetchJson(`${baseUrl}/initiate-download`);
    let dataUrl = payload.data?.url;
    for (let attempt = 0; !dataUrl && attempt < 10; attempt += 1) {
      await wait(1_000, signal);
      payload = await fetchJson(`${baseUrl}/poll-download`);
      dataUrl = payload.data?.url;
    }
    if (!String(dataUrl || '').startsWith('https://')) throw new Error(`data.gov.sg download is unavailable: ${datasetId}`);
    let sourceBytes = null;
    let lastModified = null;
    try {
      const response = await fetchHead(dataUrl);
      if (response.ok) {
        sourceBytes = headerNumber(response.headers, 'content-length');
        lastModified = response.headers.get('last-modified');
      }
    } catch {
      if (signal?.aborted) signal.throwIfAborted();
    }
    return { dataUrl, sourceBytes, lastModified };
  };

  const discoverSingaporeHdb = async (shard) => {
    const [property, building] = await Promise.all([
      dataGovDownload(shard.source.propertyDatasetId),
      dataGovDownload(shard.source.buildingDatasetId)
    ]);
    const publishedAt = [property.lastModified, building.lastModified]
      .filter(Boolean).map((value) => new Date(value)).sort((left, right) => right - left)[0];
    const dateVersion = publishedAt && Number.isFinite(publishedAt.getTime())
      ? publishedAt.toISOString().slice(0, 10)
      : new Date().toISOString().slice(0, 10);
    return {
      adapter: 'singapore-hdb',
      version: `${dateVersion}-${singaporeHdbExportRevision}`,
      publishedAt: publishedAt?.toISOString() || null,
      dataUrl: shard.source.dataUrl,
      propertyUrl: property.dataUrl,
      buildingUrl: building.dataUrl,
      propertyBytes: property.sourceBytes,
      buildingBytes: building.sourceBytes,
      sourceBytes: property.sourceBytes !== null && building.sourceBytes !== null
        ? property.sourceBytes + building.sourceBytes : null,
      residentialBuildingAvailable: true,
      estimateMethod: 'official-dataset-download'
    };
  };

  const discoverKoreaKapt = async (shard, options = {}) => {
    const response = await fetchImpl(shard.source.dataUrl, { headers: { Accept: 'text/html' }, signal });
    if (!response.ok) throw new Error(`K-apt metadata request failed (${response.status}): ${shard.source.dataUrl}`);
    const page = await response.text();
    if (!page.includes('K-apt')) throw new Error('K-apt metadata page is invalid');
    const modified = response.headers.get('last-modified');
    const rawRoot = resolve(options.cacheDir || environment.ADDRESS_SYNC_CACHE_DIR || '.data-cache', 'raw');
    const temporary = resolve(rawRoot, `${shard.id}-catalog.${process.pid}.tmp`);
    await mkdir(rawRoot, { recursive: true });
    let catalogFile;
    let sourceChecksum;
    let sourceBytes;
    try {
      await runExecute({
        file: pythonBin,
        args: [koreaKaptExporter, '--catalog-output', temporary],
        phase: `discover:${shard.id}`
      });
      const metadata = await stat(temporary);
      if (!metadata.size) throw Object.assign(new Error('K-apt catalog has no qualifying residential records'), {
        code: 'SOURCE_QUALITY_FAILED'
      });
      sourceBytes = metadata.size;
      sourceChecksum = await sha256File(temporary);
      catalogFile = resolve(rawRoot, `${shard.id}-catalog-${sourceChecksum.slice(0, 24)}.jsonl`);
      await publishContentAddressed(temporary, catalogFile, sourceChecksum);
    } finally {
      await rm(temporary, { force: true });
    }
    return {
      adapter: 'korea-kapt',
      version: `${sourceChecksum.slice(0, 24)}-${koreaKaptExportRevision}`,
      publishedAt: modified ? new Date(modified).toISOString() : null,
      dataUrl: shard.source.dataUrl,
      sourceBytes,
      sourceChecksum,
      catalogFile,
      estimateMethod: 'official-k-apt-dynamic-catalog'
    };
  };

  const discoverOpenAddresses = async (shard) => {
    let response = await fetchHead(shard.source.dataUrl);
    if ([403, 405].includes(response.status)) {
      response = await fetchImpl(shard.source.dataUrl, { headers: { Range: 'bytes=0-0' }, signal });
    }
    if (!response.ok) throw new Error(`OpenAddresses metadata request failed (${response.status}): ${shard.source.dataUrl}`);
    const modified = response.headers.get('last-modified');
    const etag = response.headers.get('etag')?.replaceAll('"', '') || '';
    const version = safeVersion([modified ? new Date(modified).toISOString().slice(0, 10) : 'latest', etag].filter(Boolean).join('-'));
    const bounds = shard.bounds || countryBounds[shard.countryCode];
    const buildingCatalog = await overtureBuildingCatalog();
    const buildingAssetEntries = buildingCatalog.items
      .filter((item) => Array.isArray(item.bbox) && intersects(bounds, item.bbox))
      .map((item) => ({ url: item.assets?.aws?.href, bbox: item.bbox }))
      .filter((entry) => typeof entry.url === 'string' && entry.url.startsWith('https://'));
    if (!buildingAssetEntries.length) throw new Error(`Overture STAC has no residential building assets for ${shard.countryCode}`);
    return {
      adapter: 'openaddresses-archive',
      version,
      publishedAt: modified ? new Date(modified).toISOString() : null,
      dataUrl: shard.source.dataUrl,
      sourceBytes: Number(response.headers.get('content-range')?.match(/\/(\d+)$/u)?.[1])
        || headerNumber(response.headers, 'content-length'),
      buildingAssets: buildingAssetEntries.map(({ url }) => url),
      buildingAssetEntries,
      estimateMethod: 'http-content-length'
    };
  };

  const discoverInegiResidential = async (shard) => {
    const inspect = async (url) => {
      let response = await fetchHead(url);
      if ([403, 405].includes(response.status)) {
        response = await fetchImpl(url, { headers: { Range: 'bytes=0-0' }, signal });
      }
      if (!response.ok) throw new Error(`INEGI source metadata request failed (${response.status}): ${url}`);
      return {
        bytes: Number(response.headers.get('content-range')?.match(/\/(\d+)$/u)?.[1])
          || headerNumber(response.headers, 'content-length'),
        modified: response.headers.get('last-modified')
      };
    };
    const [source, normalized] = await Promise.all([
      inspect(shard.source.dataUrl), inspect(shard.source.normalizedDataUrl)
    ]);
    const publishedAt = [source.modified, normalized.modified]
      .filter(Boolean).map((value) => new Date(value)).sort((left, right) => right - left)[0];
    return {
      adapter: 'inegi-residential',
      version: `${shard.source.sourceVersion}-${inegiResidentialExportRevision}`,
      publishedAt: publishedAt && Number.isFinite(publishedAt.getTime()) ? publishedAt.toISOString() : null,
      dataUrl: shard.source.dataUrl,
      normalizedDataUrl: shard.source.normalizedDataUrl,
      sourceBytes: source.bytes,
      normalizedSourceBytes: normalized.bytes,
      estimateMethod: 'http-content-length'
    };
  };

  const discoverEthekwiniResidential = async (shard) => {
    const [address, zoning, postalResponse] = await Promise.all([
      fetchJson(`${shard.source.addressUrl}?f=json`),
      fetchJson(`${shard.source.zoningUrl}?f=json`),
      fetchHead(shard.source.postalDataUrl)
    ]);
    if (!postalResponse.ok) {
      throw new Error(`South African Post Office metadata request failed (${postalResponse.status})`);
    }
    const modifiedValues = [
      Number(address.editingInfo?.lastEditDate),
      Number(zoning.editingInfo?.lastEditDate)
    ].filter((value) => Number.isFinite(value) && value > 0);
    const publishedAt = modifiedValues.length ? new Date(Math.max(...modifiedValues)).toISOString() : null;
    const postalModified = postalResponse.headers.get('last-modified');
    const postalVersion = postalModified ? new Date(postalModified).toISOString().slice(0, 10) : 'latest';
    return {
      adapter: 'ethekwini-residential',
      version: `${publishedAt?.slice(0, 10) || 'latest'}-${postalVersion}-${ethekwiniResidentialExportRevision}`,
      publishedAt,
      dataUrl: shard.source.addressUrl,
      addressUrl: shard.source.addressUrl,
      zoningUrl: shard.source.zoningUrl,
      postalUrl: shard.source.postalDataUrl,
      postalBytes: headerNumber(postalResponse.headers, 'content-length'),
      sourceBytes: headerNumber(postalResponse.headers, 'content-length'),
      residentialBuildingAvailable: true,
      estimateMethod: 'arcgis-feature-count-and-postal-content-length'
    };
  };

  const discoverCapeTownResidential = async (shard) => {
    const [parcel, postalResponse] = await Promise.all([
      fetchJson(`${shard.source.parcelUrl}?f=json`),
      fetchHead(shard.source.postalDataUrl)
    ]);
    if (!postalResponse.ok) {
      throw new Error(`South African Post Office metadata request failed (${postalResponse.status})`);
    }
    const modified = Number(parcel.editingInfo?.lastEditDate);
    const publishedAt = Number.isFinite(modified) && modified > 0 ? new Date(modified).toISOString() : null;
    const postalModified = postalResponse.headers.get('last-modified');
    const postalVersion = postalModified ? new Date(postalModified).toISOString().slice(0, 10) : 'latest';
    return {
      adapter: 'cape-town-residential',
      version: `${publishedAt?.slice(0, 10) || 'latest'}-${postalVersion}-${capeTownResidentialExportRevision}`,
      publishedAt,
      dataUrl: shard.source.parcelUrl,
      parcelUrl: shard.source.parcelUrl,
      postalUrl: shard.source.postalDataUrl,
      postalBytes: headerNumber(postalResponse.headers, 'content-length'),
      sourceBytes: headerNumber(postalResponse.headers, 'content-length'),
      residentialBuildingAvailable: true,
      estimateMethod: 'arcgis-feature-count-and-postal-content-length'
    };
  };

  const discoverThailandDptResidential = async (shard) => {
    const residentialWhere = `(${['BL_CLASS17 = 1', 'BL_CLASS18 = 1', 'BL_CLASS20 = 1', 'BL_CLASS22 = 1', 'BL_CLASS54 = 1']
      .join(' OR ')}) AND ${['BL_ID', 'BL_HOUSENUM', 'BL_ROAD', 'BL_TAMBOL', 'BL_AMPHOE', 'BL_CHANGWAT', 'BL_POSTCODE']
      .map((field) => `${field} IS NOT NULL AND ${field} <> ''`).join(' AND ')}`;
    const idQuery = new URLSearchParams({ where: residentialWhere, returnIdsOnly: 'true', f: 'json' });
    const updateQuery = new URLSearchParams({
      where: residentialWhere,
      outStatistics: JSON.stringify([{
        statisticType: 'max', onStatisticField: 'BL_UPDATED_DATE', outStatisticFieldName: 'latest_update'
      }]),
      returnGeometry: 'false', f: 'json'
    });
    const [layer, result, updateResult] = await Promise.all([
      fetchJson(`${shard.source.dataUrl}?f=json`),
      fetchJson(`${shard.source.dataUrl}/query?${idQuery}`),
      fetchJson(`${shard.source.dataUrl}/query?${updateQuery}`).catch(() => {
        if (signal?.aborted) signal.throwIfAborted();
        return null;
      })
    ]);
    if (result.error) {
      throw new Error(`Thailand DPT object ID query failed (${result.error.code || 'unknown'}): ${result.error.message || 'unknown error'}`);
    }
    const objectIds = Array.isArray(result.objectIds)
      ? result.objectIds.map(Number).filter((value) => Number.isSafeInteger(value) && value >= 0)
      : [];
    if (!objectIds.length) throw new Error('Thailand DPT residential query returned no object IDs');
    const maximumObjectId = Math.max(...objectIds);
    const objectIdDigest = createHash('sha256').update(objectIds.sort((left, right) => left - right).join(','))
      .digest('hex').slice(0, 16);
    const lastEditDate = Number(layer.editingInfo?.lastEditDate);
    const latestFeatureUpdate = Number(updateResult?.features?.[0]?.attributes?.latest_update);
    const revisionTime = [lastEditDate, latestFeatureUpdate]
      .filter((value) => Number.isFinite(value) && value > 0).sort((left, right) => right - left)[0];
    const publishedAt = revisionTime ? new Date(revisionTime).toISOString() : null;
    return {
      adapter: 'thailand-dpt-residential',
      version: `${publishedAt?.slice(0, 10) || 'undated'}-oid-${maximumObjectId}-count-${objectIds.length}-${objectIdDigest}-${thailandDptResidentialExportRevision}`,
      publishedAt,
      dataUrl: shard.source.dataUrl,
      residentialCount: objectIds.length,
      maximumObjectId,
      objectIdDigest,
      residentialBuildingAvailable: true,
      estimateMethod: 'arcgis-strict-address-object-ids-and-latest-update'
    };
  };

  const discoverCanadaNarResidential = async (shard) => {
    const response = await fetchHead(shard.source.dataUrl);
    if (!response.ok) throw new Error(`Statistics Canada NAR metadata request failed (${response.status})`);
    const bytes = headerNumber(response.headers, 'content-length');
    const modified = response.headers.get('last-modified');
    const etag = response.headers.get('etag') || '';
    const publishedAt = modified ? new Date(modified) : null;
    const release = shard.source.release || '202606';
    const version = `${release}-${bytes || 'unknown'}-${etag.replace(/[^a-zA-Z0-9-]/gu, '')}-${canadaNarExportRevision}`;
    return {
      adapter: 'canada-nar-residential', version,
      publishedAt: publishedAt && Number.isFinite(publishedAt.getTime()) ? publishedAt.toISOString() : null,
      dataUrl: shard.source.dataUrl, sourceBytes: bytes,
      residentialBuildingAvailable: true, estimateMethod: 'official-release-http-metadata'
    };
  };

  const discoverFranceBdnbResidential = async (shard) => {
    const response = await fetchHead(shard.source.dataUrl);
    if (!response.ok) throw new Error(`CSTB BDNB metadata request failed (${response.status})`);
    const bytes = headerNumber(response.headers, 'content-length');
    const modified = response.headers.get('last-modified');
    const publishedAt = modified ? new Date(modified) : null;
    const etag = (response.headers.get('etag') || '').replace(/[^a-zA-Z0-9-]/gu, '');
    const advertisedChecksum = response.headers.get('x-amz-meta-sha256') || '';
    const metadataIdentity = createHash('sha256').update(`${bytes}\u001f${etag}\u001f${advertisedChecksum}`)
      .digest('hex').slice(0, 16);
    return {
      adapter: 'france-bdnb-residential',
      version: `${shard.source.sourceVersion || 'undated'}-${metadataIdentity}-${franceBdnbExportRevision}`,
      publishedAt: publishedAt && Number.isFinite(publishedAt.getTime()) ? publishedAt.toISOString() : null,
      dataUrl: shard.source.dataUrl,
      sourceBytes: bytes,
      advertisedChecksum,
      residentialBuildingAvailable: true,
      estimateMethod: 'official-department-archive-http-metadata'
    };
  };

  const discoverSpainCatastroResidential = async (shard) => {
    const inspect = async (url) => {
      const response = await fetchHead(url);
      if (!response.ok) throw new Error(`Spanish Catastro metadata request failed (${response.status}): ${url}`);
      return {
        bytes: headerNumber(response.headers, 'content-length'),
        modified: response.headers.get('last-modified'),
        etag: response.headers.get('etag') || ''
      };
    };
    const [addresses, buildings] = await Promise.all([
      inspect(shard.source.addressesUrl), inspect(shard.source.buildingsUrl)
    ]);
    const dates = [addresses.modified, buildings.modified]
      .map((value) => value ? new Date(value) : null)
      .filter((value) => value && Number.isFinite(value.getTime()))
      .sort((left, right) => right.getTime() - left.getTime());
    const metadataIdentity = createHash('sha256').update([
      addresses.bytes, addresses.etag, buildings.bytes, buildings.etag
    ].join('\u001f')).digest('hex').slice(0, 16);
    return {
      adapter: 'spain-catastro-residential',
      version: `${shard.source.sourceVersion || 'undated'}-${metadataIdentity}-${spainCatastroExportRevision}`,
      publishedAt: dates[0]?.toISOString() || null,
      dataUrl: shard.source.addressesUrl,
      addressesUrl: shard.source.addressesUrl,
      buildingsUrl: shard.source.buildingsUrl,
      addressBytes: addresses.bytes,
      buildingBytes: buildings.bytes,
      residentialBuildingAvailable: true,
      estimateMethod: 'official-municipality-atom-archive-metadata'
    };
  };

  const discoverTaiwanResidential = async (shard) => {
    const inspect = async (url) => {
      let response = await fetchHead(url);
      if ([403, 405].includes(response.status)) {
        response = await fetchImpl(url, { headers: { Range: 'bytes=0-0' }, signal });
      }
      if (!response.ok) throw new Error(`Taiwan source metadata request failed (${response.status}): ${url}`);
      return {
        bytes: Number(response.headers.get('content-range')?.match(/\/(\d+)$/u)?.[1])
          || headerNumber(response.headers, 'content-length'),
        modified: response.headers.get('last-modified')
      };
    };
    const archiveSources = shard.source.archives?.length ? shard.source.archives : [{
      sourceVersion: shard.source.sourceVersion,
      dataUrl: shard.source.dataUrl,
      archiveCacheName: shard.source.archiveCacheName,
      sha256: shard.source.sha256
    }];
    const [molitArchives, openAddresses] = await Promise.all([
      Promise.all(archiveSources.map(async (archive) => ({ ...archive, ...await inspect(archive.dataUrl) }))),
      inspect(shard.source.openAddressesDataUrl)
    ]);
    const publishedAt = [...molitArchives.map(({ modified }) => modified), openAddresses.modified]
      .filter(Boolean).map((value) => new Date(value)).sort((left, right) => right - left)[0];
    const molitBytes = molitArchives.every(({ bytes }) => bytes !== null)
      ? molitArchives.reduce((total, { bytes }) => total + bytes, 0)
      : null;
    const sourceVersion = molitArchives.map(({ sourceVersion }) => sourceVersion).filter(Boolean).join('+');
    return {
      adapter: 'taiwan-residential',
      version: `${sourceVersion}-${taiwanResidentialExportRevision}`,
      publishedAt: publishedAt && Number.isFinite(publishedAt.getTime()) ? publishedAt.toISOString() : null,
      dataUrl: molitArchives[0].dataUrl,
      molitArchives,
      openAddressesDataUrl: shard.source.openAddressesDataUrl,
      sourceBytes: molitBytes !== null && openAddresses.bytes !== null ? molitBytes + openAddresses.bytes : null,
      molitBytes,
      openAddressesBytes: openAddresses.bytes,
      residentialBuildingAvailable: true,
      estimateMethod: 'official-archives-content-length'
    };
  };

  const discoverHongKongResidential = async (shard) => {
    const metadataResponse = await fetchImpl(shard.source.metadataUrl, { signal });
    if (!metadataResponse.ok) {
      throw new Error(`Hong Kong source metadata request failed (${metadataResponse.status})`);
    }
    const metadata = await metadataResponse.text();
    const downloadPattern = /^https:\/\/static\.csdi\.gov\.hk\/csdi-webpage\/download\/[a-f\d]+\/csv$/iu;
    let dataUrl;
    let publishedAt;
    // The DATA.GOV.HK catalogue API keeps a stable dataset id while resources are replaced; resource pages are not.
    if (shard.source.metadataUrl.includes('/api/3/action/package_show')) {
      const resource = JSON.parse(metadata)?.result?.resources
        ?.find((entry) => entry.state === 'active' && downloadPattern.test(String(entry.url || '')));
      const updated = Date.parse(resource?.metadata_modified || resource?.created || '');
      dataUrl = resource?.url;
      publishedAt = Number.isFinite(updated) ? `${new Date(updated).toISOString().slice(0, 10)}T00:00:00.000Z` : undefined;
    } else {
      const date = metadata.match(/Last updated on[\s\S]{0,500}?(\d{2})\/(\d{2})\/(\d{4})/iu);
      dataUrl = metadata.match(/https:\/\/static\.csdi\.gov\.hk\/csdi-webpage\/download\/[a-f\d]+\/csv/iu)?.[0];
      publishedAt = date ? `${date[3]}-${date[2]}-${date[1]}T00:00:00.000Z` : undefined;
    }
    if (!dataUrl || !publishedAt) throw new Error('Hong Kong source metadata is missing the download URL or update date');
    const response = await fetchHead(dataUrl);
    if (!response.ok) throw new Error(`Hong Kong source request failed (${response.status})`);
    return {
      adapter: 'hong-kong-residential',
      version: `${publishedAt.slice(0, 10)}-${hongKongResidentialExportRevision}`,
      publishedAt,
      dataUrl,
      sourceBytes: headerNumber(response.headers, 'content-length'),
      residentialBuildingAvailable: true,
      estimateMethod: 'official-archive-content-length'
    };
  };

  const requireLicensedSource = (source) => {
    for (const name of [source.licenseConfirmationEnvironment, source.redistributionConfirmationEnvironment].filter(Boolean)) {
      if (!environmentEnabled(environment[name])) {
        throw Object.assign(new Error(`${name} must be true before ${source.id} can run`), {
          code: 'SOURCE_LICENSE_NOT_CONFIRMED'
        });
      }
    }
  };

  const discoverMapplsResidential = async (shard, options) => {
    requireLicensedSource(shard.source);
    const source = await discoverGeofabrik(shard, options);
    return {
      ...source,
      adapter: 'mappls-residential',
      version: mapplsResidentialRevision,
      rawVersion: source.version,
      publishedAt: null,
      residentialBuildingAvailable: true,
      estimateMethod: 'fixed-osm-source-address-seed-cap'
    };
  };

  const discoverPdokBag = async (shard) => {
    const metadata = await fetchJson(shard.source.dataUrl);
    const itemLink = metadata?.links?.find((link) => link.rel === 'items'
      && /(?:application\/geo\+json|application\/json)/iu.test(String(link.type || '')));
    // OGC API collections carry `updated` at the top level; older PDOK responses put it on the self link.
    const updated = metadata?.updated || metadata?.links?.find((link) => link.rel === 'self')?.updated;
    if (!itemLink?.href || !updated || !Number.isFinite(Date.parse(updated))) {
      throw new SourceMetadataError('PDOK BAG collection metadata is incomplete', {
        url: shard.source.dataUrl, code: 'SOURCE_METADATA_INVALID'
      });
    }
    return {
      adapter: 'pdok-bag',
      version: `${new Date(updated).toISOString().slice(0, 10)}-${pdokBagRevision}`,
      publishedAt: new Date(updated).toISOString(),
      dataUrl: itemLink.href,
      sourceBytes: null,
      estimateMethod: 'pdok-bag-ogc-features'
    };
  };

  const discover = (shard, options) => {
    if (shard.source.configurationError) {
      throw Object.assign(new Error(shard.source.configurationError), { code: 'SOURCE_CONFIGURATION_INVALID' });
    }
    if (shard.source.adapter === 'overture') return discoverOverture(shard, options);
    if (shard.source.adapter === 'geofabrik') return discoverGeofabrik(shard, options);
    if (shard.source.adapter === 'google-residential-enrichment') return discoverGoogleResidential(shard, options);
    if (shard.source.adapter === 'singapore-hdb') return discoverSingaporeHdb(shard, options);
    if (shard.source.adapter === 'korea-kapt') return discoverKoreaKapt(shard, options);
    if (shard.source.adapter === 'openaddresses-archive') return discoverOpenAddresses(shard, options);
    if (shard.source.adapter === 'inegi-residential') return discoverInegiResidential(shard, options);
    if (shard.source.adapter === 'ethekwini-residential') return discoverEthekwiniResidential(shard, options);
    if (shard.source.adapter === 'cape-town-residential') return discoverCapeTownResidential(shard, options);
    if (shard.source.adapter === 'thailand-dpt-residential') return discoverThailandDptResidential(shard, options);
    if (shard.source.adapter === 'canada-nar-residential') return discoverCanadaNarResidential(shard, options);
    if (shard.source.adapter === 'france-bdnb-residential') return discoverFranceBdnbResidential(shard, options);
    if (shard.source.adapter === 'spain-catastro-residential') return discoverSpainCatastroResidential(shard, options);
    if (shard.source.adapter === 'taiwan-residential') return discoverTaiwanResidential(shard, options);
    if (shard.source.adapter === 'hong-kong-residential') return discoverHongKongResidential(shard, options);
    if (shard.source.adapter === 'mappls-residential') return discoverMapplsResidential(shard, options);
    if (shard.source.adapter === 'pdok-bag') return discoverPdokBag(shard, options);
    throw new Error(`Unsupported source adapter: ${shard.source.adapter}`);
  };

  const download = async (url, destination, {
    expectedBytes, maxBytes, forceRefresh = false, retainPartial = false, signal: runSignal = signal
  }) => {
    runSignal?.throwIfAborted();
    await mkdir(resolve(destination, '..'), { recursive: true });
    if (!forceRefresh) {
      const existing = await existingFileSize(destination);
      if (existing > 0 && sourceSizeMatches(existing, expectedBytes)) return existing;
    } else {
      await rm(destination, { force: true });
      await rm(`${destination}.part`, { force: true });
    }
    const partial = `${destination}.part`;
    let completed = false;
    try {
      if (useCurlTransport) {
        try {
          await runProcess({
            file: 'curl',
            args: ['-4', '-fL', '--retry', '3', '--retry-all-errors', '--connect-timeout', '15', '-C', '-', '-o', partial, url],
            signal: runSignal
          });
        } catch (error) {
          if (retainPartial && !String(error?.message || '').includes('code 33')) throw error;
          await rm(partial, { force: true });
          await runProcess({
            file: 'curl',
            args: ['-4', '-fL', '--retry', '3', '--retry-all-errors', '--connect-timeout', '15', '-o', partial, url],
            signal: runSignal
          });
        }
        const downloaded = (await stat(partial)).size;
        if (downloaded > maxBytes || !sourceSizeMatches(downloaded, expectedBytes)) {
          throw new Error(`Source download size mismatch: ${downloaded} (expected ${expectedBytes ?? 'unknown'})`);
        }
        await rename(partial, destination);
        completed = true;
        return downloaded;
      }
      const partialSize = await existingFileSize(partial);
      let offset = partialSize || 0;
      if (expectedBytes !== null && expectedBytes > maxBytes) throw new Error(`Source file exceeds cache budget: ${expectedBytes} > ${maxBytes}`);
      const response = await fetchImpl(url, {
        headers: offset ? { Range: `bytes=${offset}-` } : {},
        signal: runSignal
      });
      if (!response.ok) throw new Error(`Source download failed (${response.status}): ${url}`);
      const append = offset > 0 && response.status === 206;
      if (!append) offset = 0;
      const remaining = headerNumber(response.headers, 'content-length');
      if (remaining !== null && offset + remaining > maxBytes) throw new Error(`Source file exceeds cache budget: ${offset + remaining} > ${maxBytes}`);
      if (!response.body) throw new Error(`Source download returned an empty body: ${url}`);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(partial, { flags: append ? 'a' : 'w' }));
      const downloaded = (await stat(partial)).size;
      if (downloaded > maxBytes || !sourceSizeMatches(downloaded, expectedBytes)) {
        throw new Error(`Source download size mismatch: ${downloaded} (expected ${expectedBytes ?? 'unknown'})`);
      }
      await rename(partial, destination);
      completed = true;
      return downloaded;
    } finally {
      if (!completed && !retainPartial) await rm(partial, { force: true });
    }
  };

  const sharedDownload = (url, destination, options) => {
    if (!downloads.has(destination)) {
      downloads.set(destination, download(url, destination, options).finally(() => downloads.delete(destination)));
    }
    return downloads.get(destination);
  };

  const verifiedGeofabrikDownload = (url, destination, options) => {
    if (!verifiedDownloads.has(destination)) {
      verifiedDownloads.set(destination, (async () => {
        const expectedMd5 = useCurlTransport
          ? await execFileAsync('curl', ['-4', '-fsSL', '--connect-timeout', '15', '--max-time', '60', `${url}.md5`], {
            encoding: 'utf8', maxBuffer: 1024 * 1024, windowsHide: true, signal: options.signal || signal
          }).then(({ stdout }) => parseGeofabrikMd5(stdout)).catch(() => {
            if ((options.signal || signal)?.aborted) (options.signal || signal).throwIfAborted();
            return null;
          })
          : null;
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          await sharedDownload(url, destination, options);
          if (!expectedMd5 || await digestFile(destination, 'md5') === expectedMd5) return;
          await rm(destination, { force: true });
          await rm(`${destination}.part`, { force: true });
        }
        throw new Error(`Geofabrik checksum mismatch after full retry: ${url}`);
      })().finally(() => verifiedDownloads.delete(destination)));
    }
    return verifiedDownloads.get(destination);
  };

  // Remote GeoParquet reads run at ~13 MB/s per stream; parallel whole-file downloads reach several times that, so a
  // release's address files are mirrored once and every country reads them locally. Two releases are kept.
  const overtureMirrorConcurrency = Math.max(1, Number.parseInt(environment.ADDRESS_SYNC_OVERTURE_MIRROR_CONCURRENCY || '8', 10) || 8);
  const mirrorOvertureAssets = async (assets, release, cacheDir, maxBytes) => {
    if (environment.ADDRESS_SYNC_OVERTURE_MIRROR === 'false' || !assets.length) return assets;
    const root = resolve(cacheDir, 'overture-mirror');
    const directory = resolve(root, safeVersion(release));
    await mkdir(directory, { recursive: true });
    const releases = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    for (const stale of releases.filter((name) => name !== safeVersion(release)).slice(0, -1)) {
      await rm(resolve(root, stale), { recursive: true, force: true });
    }
    const local = new Array(assets.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(overtureMirrorConcurrency, assets.length) }, async () => {
      while (next < assets.length) {
        const index = next++;
        const url = assets[index];
        const head = await fetchHead(url);
        const expectedBytes = head.ok ? headerNumber(head.headers, 'content-length') : null;
        const destination = resolve(directory, basename(new URL(url).pathname));
        await download(url, destination, { expectedBytes, maxBytes });
        local[index] = destination;
      }
    }));
    return local;
  };

  const materializeOverture = async (shard, discovery, options) => {
    const residentialRevision = `-${overtureResidentialRevision}`;
    const weightsJson = options.localityWeights ? JSON.stringify(options.localityWeights) : '';
    const weightsIdentity = weightsJson ? `-w${createHash('sha256').update(weightsJson).digest('hex').slice(0, 12)}` : '';
    const policyIdentity = normalizedCachePolicyIdentity(options.maxRecords, options.perLocality);
    const output = resolve(options.cacheDir, 'normalized',
      `${shard.id}-${safeVersion(discovery.version)}${residentialRevision}-${policyIdentity}${weightsIdentity}.jsonl`);
    const cachedSize = await existingFileSize(output);
    if (cachedSize > 0) return { file: output, format: 'overture-jsonl', cacheBytes: cachedSize, checksum: await sha256File(output), cacheHit: true };
    await mkdir(resolve(options.cacheDir, 'normalized'), { recursive: true });
    const temporary = `${output}.${process.pid}.tmp`;
    const assetsFile = `${temporary}.assets.json`;
    const buildingAssetsFile = `${temporary}.building-assets.json`;
    const weightsFile = weightsJson ? `${temporary}.locality-weights.json` : null;
    if (weightsFile) await writeFile(weightsFile, weightsJson, 'utf8');
    const structuresZip = discovery.structuresUrl
      ? resolve(options.cacheDir, 'raw', `usa-structures-${shard.admin1}-${safeVersion(discovery.version)}.zip`) : null;
    try {
      if (structuresZip) await download(discovery.structuresUrl, structuresZip, { expectedBytes: null, maxBytes: options.maxBytes });
      const assets = await mirrorOvertureAssets(discovery.assets || [], String(discovery.version).split('+')[0], options.cacheDir, options.maxBytes);
      await writeFile(assetsFile, JSON.stringify(assets), 'utf8');
      await writeFile(buildingAssetsFile, JSON.stringify(discovery.buildingAssetEntries || discovery.buildingAssets || []), 'utf8');
      await runExecute({
        file: pythonBin,
        args: [overtureExporter, '--country', shard.countryCode, '--release', discovery.version,
          '--output', temporary, '--max-records', String(options.maxRecords),
          '--per-locality', String(options.perLocality), '--assets-file', assetsFile,
          '--building-assets-file', buildingAssetsFile,
          ...(shard.admin1 ? ['--admin1', shard.admin1] : []),
          ...(structuresZip ? ['--structures-zip', structuresZip] : []),
          ...(weightsFile ? ['--locality-weights', weightsFile] : []),
          ...overtureBoundsArgs(countryBoundBoxes(shard))],
        phase: `materialize:${shard.id}`
      });
      await rename(temporary, output);
    } finally {
      await rm(assetsFile, { force: true });
      await rm(buildingAssetsFile, { force: true });
      if (weightsFile) await rm(weightsFile, { force: true });
      await rm(temporary, { force: true });
      if (structuresZip && !options.retainRaw) await rm(structuresZip, { force: true });
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
    const outputVersion = `${version}-${boundarySignature}-${normalizedCachePolicyIdentity(options.maxRecords, options.perLocality)}`;
    const output = resolve(options.cacheDir, 'normalized', `${shard.id}-${outputVersion}.geojsonseq`);
    const cachedSize = await existingFileSize(output);
    if (cachedSize > 0) {
      if (discovery.postcodeFile && !options.retainRaw) await rm(discovery.postcodeFile, { force: true });
      return { file: output, format: 'geofabrik-geojsonseq', cacheBytes: cachedSize, checksum: await sha256File(output), cacheHit: true };
    }
    const rawIdentity = createHash('sha256').update(`${discovery.dataUrl}\u001f${version}`).digest('hex').slice(0, 16);
    const raw = resolve(options.cacheDir, 'raw', `${rawIdentity}-${basename(new URL(discovery.dataUrl).pathname)}`);
    const boundary = `${raw}.${shard.id}.boundary.geojson`;
    const excludeBoundaries = (discovery.excludeBoundaryUrls || []).map((_, index) => `${raw}.${shard.id}.exclude-${index}.geojson`);
    const postcodeFile = discovery.postcodeDataUrl
      ? (discovery.postcodeFile || `${raw}.${shard.id}.postcodes.${discovery.postcodeDataFormat || 'html'}`) : null;
    const temporary = `${output}.${process.pid}.tmp`;
    await mkdir(resolve(options.cacheDir, 'normalized'), { recursive: true });
    await verifiedGeofabrikDownload(discovery.dataUrl, raw, { expectedBytes: discovery.sourceBytes, maxBytes: options.maxBytes });
    if (options.sharedRaw && !options.retainRaw) sharedRawFiles.add(raw);
    const sourceChecksum = await sha256File(raw);
    let completed = false;
    try {
      if (discovery.boundaryUrl) {
        await download(discovery.boundaryUrl, boundary, { expectedBytes: null, maxBytes: Math.min(options.maxBytes, 100 * 1024 * 1024) });
      }
      for (let index = 0; index < (discovery.excludeBoundaryUrls || []).length; index += 1) {
        await download(discovery.excludeBoundaryUrls[index], excludeBoundaries[index], { expectedBytes: null, maxBytes: Math.min(options.maxBytes, 100 * 1024 * 1024) });
      }
      if (postcodeFile) {
        if (!(await existingFileSize(postcodeFile))) {
          await download(discovery.postcodeDataUrl, postcodeFile, {
            expectedBytes: discovery.postcodeDataFormat === 'pdf' ? null : discovery.postcodeBytes,
            maxBytes: Math.max(10 * 1024 * 1024, options.maxBytes)
          });
        }
      }
      const boundaryBytes = (discovery.boundaryUrl ? (await stat(boundary)).size : 0)
        + (await Promise.all(excludeBoundaries.map(async (file) => (await stat(file)).size))).reduce((sum, size) => sum + size, 0)
        + (postcodeFile ? (await stat(postcodeFile)).size : 0);
      const stagingBytes = (await stat(raw)).size + boundaryBytes;
      if (stagingBytes > options.maxBytes) throw new Error(`Geofabrik staging files exceed cache budget: ${stagingBytes} > ${options.maxBytes}`);
      await runExecute({
        file: pythonBin,
        args: [geofabrikExporter, '--input', raw, '--output', temporary,
          '--max-records', String(options.maxRecords), '--per-locality', String(options.perLocality),
          '--country', shard.countryCode,
          ...(postcodeFile && discovery.postcodeDataFormat === 'pdf' ? ['--postcode-pdf', postcodeFile] : []),
          ...(postcodeFile && discovery.postcodeDataFormat !== 'pdf' ? ['--postcode-html', postcodeFile] : []),
          ...(discovery.boundaryUrl ? ['--boundary', boundary] : []),
          ...excludeBoundaries.flatMap((file) => ['--exclude-boundary', file])],
        phase: `materialize:${shard.id}`
      });
      await rename(temporary, output);
      completed = true;
    } finally {
      await rm(boundary, { force: true });
      if (postcodeFile && !options.retainRaw) await rm(postcodeFile, { force: true });
      await Promise.all(excludeBoundaries.map((file) => rm(file, { force: true })));
      await rm(temporary, { force: true });
      if (!options.retainRaw && !options.sharedRaw && completed) await rm(raw, { force: true });
    }
    const size = (await stat(output)).size;
    return { file: output, format: 'geofabrik-geojsonseq', cacheBytes: size, checksum: await sha256File(output), sourceChecksum, cacheHit: false };
  };

  const materializeResidentialEnrichment = async (shard, discovery, options) => {
    const mappls = discovery.adapter === 'mappls-residential';
    const providerName = mappls ? 'Mappls' : 'Google';
    const version = safeVersion(discovery.version);
    const rawVersion = String(discovery.rawVersion || discovery.version);
    const policyIdentity = normalizedCachePolicyIdentity(options.maxRecords, options.perLocality);
    const normalizedRoot = resolve(options.cacheDir, 'normalized');
    const rawRoot = resolve(options.cacheDir, 'raw');
    const publishedOutput = resolve(normalizedRoot, `${shard.id}-${version}-${policyIdentity}.jsonl`);
    const completeMarker = `${publishedOutput}.complete`;
    const markerSize = await existingFileSize(completeMarker);
    const cachedSize = await existingFileSize(publishedOutput);
    if (markerSize > 0 && cachedSize > 0) return { file: publishedOutput, format: 'overture-jsonl', cacheBytes: cachedSize,
      checksum: await sha256File(publishedOutput), cacheHit: true };
    await Promise.all([mkdir(normalizedRoot, { recursive: true }), mkdir(rawRoot, { recursive: true })]);
    const rawIdentity = createHash('sha256')
      .update(`${discovery.dataUrl}\u001f${rawVersion}`).digest('hex').slice(0, 16);
    const stateIdentity = createHash('sha256')
      .update(`${version}\u001f${rawVersion}\u001f${policyIdentity}`).digest('hex').slice(0, 20);
    const statePrefix = `${shard.id}-state-`;
    const stateDirectory = resolve(rawRoot, `${statePrefix}${stateIdentity}`);
    const seeds = resolve(stateDirectory, 'seeds.jsonl');
    const coverageTargets = resolve(stateDirectory, 'coverage-targets.json');
    const progressFile = resolve(stateDirectory, 'progress.json');
    const output = resolve(stateDirectory, 'candidates.jsonl');
    const raw = resolve(rawRoot, `${rawIdentity}-${basename(new URL(discovery.dataUrl).pathname)}`);
    const boundary = `${raw}.${shard.id}.boundary.geojson`;
    const excludeBoundaries = (discovery.excludeBoundaryUrls || []).map((_, index) => `${raw}.${shard.id}.exclude-${index}.geojson`);
    for (const entry of await readdir(rawRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith(statePrefix) && entry.name !== basename(stateDirectory)) {
        await rm(resolve(rawRoot, entry.name), { recursive: true, force: true });
      }
    }
    await verifiedGeofabrikDownload(discovery.dataUrl, raw, {
      expectedBytes: discovery.sourceBytes, maxBytes: options.maxBytes
    });
    const sourceChecksum = await sha256File(raw);
    await mkdir(stateDirectory, { recursive: true });
    let progress = {
      schemaVersion: 2, version, rawVersion, sourceChecksum,
      nextIndex: 0, accepted: 0, requested: 0, rejected: 0, duplicates: 0, rejectionReasons: {}
    };
    const saved = await readPersistedJson(progressFile, 'Google residential progress');
    if (saved !== undefined) {
      if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw sourceStateError('Google residential progress');
      const compatible = saved.schemaVersion === 2 && saved.version === version
        && saved.rawVersion === rawVersion && saved.sourceChecksum === sourceChecksum
        && Number.isSafeInteger(saved.nextIndex) && saved.nextIndex >= 0
        && Number.isSafeInteger(saved.accepted) && saved.accepted >= 0
        && (saved.nextIndex > 0 || saved.accepted === 0)
        && ['requested', 'rejected', 'duplicates'].every((field) => saved[field] === undefined
          || Number.isSafeInteger(saved[field]) && saved[field] >= 0);
      if (compatible) progress = {
        ...progress,
        nextIndex: saved.nextIndex,
        accepted: saved.accepted,
        requested: Number.isSafeInteger(saved.requested) ? saved.requested : saved.nextIndex,
        rejected: Number.isSafeInteger(saved.rejected) ? saved.rejected : Math.max(0, saved.nextIndex - saved.accepted),
        duplicates: Number.isSafeInteger(saved.duplicates) ? saved.duplicates : 0,
        rejectionReasons: saved.rejectionReasons && typeof saved.rejectionReasons === 'object'
          ? saved.rejectionReasons : {}
      };
      else {
        throw sourceStateError('Google residential progress');
      }
    }
    if (discovery.boundaryUrl) {
      await download(discovery.boundaryUrl, boundary, {
        expectedBytes: null, maxBytes: Math.min(options.maxBytes, 100 * 1024 * 1024)
      });
    }
    for (let index = 0; index < (discovery.excludeBoundaryUrls || []).length; index += 1) {
      await download(discovery.excludeBoundaryUrls[index], excludeBoundaries[index], {
        expectedBytes: null, maxBytes: Math.min(options.maxBytes, 100 * 1024 * 1024)
      });
    }
    if (!(await existingFileSize(seeds))) {
      const temporarySeeds = `${seeds}.${process.pid}.tmp`;
      try {
        let targets = [];
        try {
          targets = await loadGoogleCoverageTargets(shard.countryCode);
        } catch (error) {
          if (signal?.aborted) signal.throwIfAborted();
          console.error(`[address-sync] ${shard.countryCode} ${providerName} coverage targets unavailable`, error);
        }
        if (targets.length) await writeFile(coverageTargets, `${JSON.stringify(targets)}\n`, 'utf8');
        await runExecute({
          file: pythonBin,
          args: [googleResidentialSeedExporter, '--input', raw, '--output', temporarySeeds,
            '--max-records', String(Math.min(Number(shard.maxRecords || options.maxRecords), options.maxRecords)),
            '--include-streets',
            ...(mappls ? ['--require-source-address'] : []),
            ...(targets.length ? ['--coverage-targets', coverageTargets] : []),
            ...(discovery.boundaryUrl ? ['--boundary', boundary] : []),
            ...excludeBoundaries.flatMap((file) => ['--exclude-boundary', file])],
          phase: `materialize:${shard.id}:seeds`
        });
        await rename(temporarySeeds, seeds);
      } finally {
        await rm(temporarySeeds, { force: true });
      }
    }
    if (!progress.nextIndex) {
      await writeFile(output, '', 'utf8');
      progress.accepted = 0;
      progress.requested = 0;
      progress.rejected = 0;
      progress.duplicates = 0;
      progress.rejectionReasons = {};
    } else await reconcileGoogleProgressOutput(output, progress);
    const saveProgress = async () => {
      const temporary = `${progressFile}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(progress)}\n`, 'utf8');
      await rename(temporary, progressFile);
    };
    const recordIdentity = (record) => record.match_level === 'street'
      ? streetAddressKey(shard.countryCode, record) : String(record.id || record.source_record_id);
    const seenRecords = new Set((await readFile(output, 'utf8')).split(/\r?\n/u).filter(Boolean)
      .map((line) => recordIdentity(JSON.parse(line))));
    const maximumRequests = Math.max(1, Number(shard.source.maxRequestsPerRun || 1_000));
    const pilotRequests = Math.min(maximumRequests, Math.max(1, Number(shard.source.pilotRequests || 50)));
    const minimumPilotAccepted = Math.min(pilotRequests,
      Math.max(1, Number(shard.source.minimumPilotAccepted || 5)));
    let requests = 0;
    const onDispatch = (count) => { requests += count; progress.requested += count; };
    let currentIndex = 0;
    let unavailable = null;
    let requestBudgetReached = false;
    let pilotFailed = false;
    const lines = createInterface({ input: createReadStream(seeds), crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        options.signal?.throwIfAborted();
        if (!line.trim()) continue;
        if (currentIndex < progress.nextIndex) {
          currentIndex += 1;
          continue;
        }
        if (requests >= maximumRequests) {
          requestBudgetReached = true;
          break;
        }
        currentIndex += 1;
        const seed = JSON.parse(line);
        let payload;
        try {
          payload = mappls ? await requestMapplsReverse({
            latitude: seed.latitude,
            longitude: seed.longitude,
            credentialPool: credentialPool || mapplsCredentialPool,
            brokerClient: credentialBrokerClient,
            fetchImpl: apiFetchImpl,
            signal: options.signal || signal, maxRequests: maximumRequests - requests, onDispatch
          }) : await requestGoogleReverse({
              latitude: seed.latitude,
              longitude: seed.longitude,
              language: googleResidentialLanguages[shard.countryCode] || 'en',
              regionCode: shard.countryCode,
              credentialPool,
              brokerClient: credentialBrokerClient,
              fetchImpl: apiFetchImpl,
              signal: options.signal || signal, maxRequests: maximumRequests - requests, onDispatch
            });
        } catch (error) {
          if (['SOURCE_CREDENTIAL_UNAVAILABLE', 'SOURCE_QUOTA_UNAVAILABLE', 'SOURCE_RATE_LIMITED',
            'SOURCE_REQUEST_BUDGET', 'BROKER_TEST_POLICY_BLOCKED', 'BROKER_UNAVAILABLE'].includes(error?.code)) {
            unavailable = error;
            break;
          }
          throw error;
        }
        const evaluation = mappls
          ? evaluateMapplsAddressResults(payload, seed)
          : evaluateGoogleAddressResults(payload, seed, shard.countryCode);
        for (const record of evaluation.records) {
          const identity = recordIdentity(record);
          if (seenRecords.has(identity)) { progress.duplicates += 1; continue; }
          await appendFile(output, `${JSON.stringify({ ...record,
            source_record_provider: mappls ? 'mappls' : 'google',
            ...(record.residential_building_id ? { residential_source_provider: 'osm' } : {})
          })}\n`, 'utf8');
          seenRecords.add(identity);
          progress.accepted += 1;
        }
        if (!evaluation.records.length) {
          progress.rejected += 1;
          const reason = evaluation.reason || 'unknown';
          progress.rejectionReasons[reason] = Number(progress.rejectionReasons[reason] || 0) + 1;
        }
        progress.nextIndex = currentIndex;
        await saveProgress();
        if (progress.nextIndex >= pilotRequests && progress.accepted < minimumPilotAccepted) {
          pilotFailed = true;
          break;
        }
      }
    } finally {
      lines.close();
      await saveProgress();
    }
    const totalSeeds = currentIndex;
    const sourceComplete = !unavailable && !requestBudgetReached;
    const size = (await stat(output)).size;
    const metrics = {
      processedCount: progress.nextIndex,
      acceptedCount: progress.accepted,
      rejectedCount: progress.rejected,
      duplicateCount: progress.duplicates,
      requestCount: progress.requested,
      runRequestCount: requests,
      geocodeRejectionReasons: progress.rejectionReasons,
      progressEvaluationReady: progress.requested >= pilotRequests,
      progressEvaluationMinimum: pilotRequests,
      seedCount: sourceComplete ? totalSeeds : null
    };
    if (pilotFailed) {
      await Promise.all([
        rm(stateDirectory, { recursive: true, force: true }), rm(publishedOutput, { force: true }),
        rm(completeMarker, { force: true }), rm(boundary, { force: true }),
        ...excludeBoundaries.map((file) => rm(file, { force: true })),
        ...(!options.retainRaw ? [rm(raw, { force: true })] : [])
      ]);
      throw Object.assign(new Error(
        `${providerName} residential pilot accepted ${progress.accepted}/${progress.nextIndex}; minimum ${minimumPilotAccepted}/${pilotRequests}`
      ), {
        code: 'SOURCE_QUALITY_FAILED',
        failureSignature: `${shard.id}:${version}:pilot:${pilotRequests}:${minimumPilotAccepted}`,
        metrics: { ...metrics, pilotRequests, minimumPilotAccepted, pilotFailed: true }
      });
    }
    if (!sourceComplete) {
      return {
        file: progress.accepted ? output : null,
        format: progress.accepted ? 'overture-jsonl' : 'checkpoint',
        cacheBytes: size,
        checksum: progress.accepted ? await sha256File(output) : null,
        sourceChecksum,
        cacheHit: false,
        sourceComplete: false,
        checkpointToken: `${version}:${stateIdentity}:${progress.nextIndex}`,
        checkpointStage: unavailable ? 'credential' : 'materialize',
        nextAttemptAt: unavailable?.retryAt || new Date(Date.now() + 60_000).toISOString(),
        metrics
      };
    }
    await rm(publishedOutput, { force: true });
    await rename(output, publishedOutput);
    await writeFile(completeMarker, `${JSON.stringify({ version, rawVersion, sourceChecksum,
      completedAt: new Date().toISOString(), ...metrics })}\n`, 'utf8');
    await rm(stateDirectory, { recursive: true, force: true });
    await Promise.all([rm(boundary, { force: true }), ...excludeBoundaries.map((file) => rm(file, { force: true }))]);
    if (!options.retainRaw) await rm(raw, { force: true });
    return {
      file: publishedOutput,
      format: 'overture-jsonl',
      cacheBytes: size,
      checksum: await sha256File(publishedOutput),
      sourceChecksum,
      cacheHit: false,
      sourceComplete: true,
      metrics
    };
  };

  const materializeSingaporeHdb = async (shard, discovery, options) => {
    const version = safeVersion(discovery.version);
    const output = resolve(options.cacheDir, 'normalized', `${shard.id}-${version}.jsonl`);
    const cachedSize = await existingFileSize(output);
    if (cachedSize > 0) return { file: output, format: 'overture-jsonl', cacheBytes: cachedSize, checksum: await sha256File(output), cacheHit: true };
    const rawRoot = resolve(options.cacheDir, 'raw');
    const propertyFile = resolve(rawRoot, `${shard.id}-${version}-property.csv`);
    const buildingFile = resolve(rawRoot, `${shard.id}-${version}-buildings.geojson`);
    const onemapCacheFile = resolve(rawRoot, `${shard.id}-onemap-cache.jsonl`);
    const stateFile = resolve(rawRoot, `${shard.id}-${version}-state.json`);
    const temporary = `${output}.${process.pid}.tmp`;
    await mkdir(resolve(options.cacheDir, 'normalized'), { recursive: true });
    await Promise.all([
      sharedDownload(discovery.propertyUrl, propertyFile, {
        expectedBytes: discovery.propertyBytes, maxBytes: Math.min(options.maxBytes, 100 * 1024 * 1024)
      }),
      sharedDownload(discovery.buildingUrl, buildingFile, {
        expectedBytes: discovery.buildingBytes, maxBytes: Math.min(options.maxBytes, 250 * 1024 * 1024)
      })
    ]);
    const [propertyChecksum, buildingChecksum] = await Promise.all([
      sha256File(propertyFile), sha256File(buildingFile)
    ]);
    let completed = false;
    let exporterMetrics = null;
    const maxRequests = Math.max(1, Math.floor(Number(shard.source.maxRequestsPerRun) || 500));
    const bridge = createOneMapCredentialBridge({ brokerClient: credentialBrokerClient, signal, maxRequests });
    try {
      const bridgeUrl = await bridge.start();
      const childEnvironment = { ...environment };
      for (const name of Object.keys(childEnvironment)) {
        if (/^ONEMAP_ACCESS_TOKEN(?:_\d+)?$/u.test(name) || /^CREDENTIAL_BROKER_/u.test(name)) {
          delete childEnvironment[name];
        }
      }
      await runExecute({
        file: pythonBin,
        args: [singaporeHdbExporter,
          '--property-csv', propertyFile,
          '--building-geojson', buildingFile,
          '--onemap-bridge-url', bridgeUrl,
          '--onemap-cache', onemapCacheFile,
          '--state-output', stateFile,
          '--output', temporary,
          '--max-records', String(options.maxRecords),
          '--per-locality', String(options.perLocality),
          '--max-onemap-requests', String(maxRequests)],
        env: childEnvironment,
        phase: `materialize:${shard.id}`
      });
      let state;
      try { state = JSON.parse(await readFile(stateFile, 'utf8')); }
      catch (cause) {
        throw Object.assign(new Error('Singapore HDB exporter did not write valid state', { cause }), {
          code: 'SOURCE_STATE_INVALID'
        });
      }
      if (state?.version !== 1 || typeof state.source_complete !== 'boolean') {
        throw Object.assign(new Error('Singapore HDB exporter state is invalid'), { code: 'SOURCE_STATE_INVALID' });
      }
      exporterMetrics = {
        candidateCount: Number(state.candidate_count || 0),
        resolvedCount: Number(state.resolved_count || 0),
        publishableCount: Number(state.publishable_count || 0),
        selectedCount: Number(state.selected_count || 0),
        onemapQueryCount: Number(state.onemap_query_count || 0),
        onemapRequestCount: bridge.requestCount()
      };
      if (!state.source_complete) {
        const size = (await stat(temporary)).size;
        const checksum = size > 0 ? await sha256File(temporary) : null;
        const partialOutput = checksum
          ? resolve(options.cacheDir, 'normalized', `${shard.id}-${version}-partial-${checksum.slice(0, 24)}.jsonl`)
          : null;
        if (partialOutput) await publishContentAddressed(temporary, partialOutput, checksum);
        return {
          file: partialOutput,
          format: partialOutput ? 'overture-jsonl' : 'checkpoint',
          cacheBytes: size,
          checksum,
          cacheHit: false,
          sourceComplete: false,
          checkpointToken: state.checkpoint_token || null,
          checkpointStage: state.temporary_failure || 'onemap',
          nextAttemptAt: state.next_available_at || null,
          metrics: exporterMetrics
        };
      }
      await rename(temporary, output);
      completed = true;
    } finally {
      await bridge.close();
      await rm(temporary, { force: true });
      if (!options.retainRaw && completed) {
        await Promise.all([rm(propertyFile, { force: true }), rm(buildingFile, { force: true })]);
      }
    }
    const size = (await stat(output)).size;
    const sourceChecksum = createHash('sha256')
      .update(`${propertyChecksum}\u001f${buildingChecksum}`).digest('hex');
    return {
      file: output,
      format: 'overture-jsonl',
      cacheBytes: size,
      checksum: await sha256File(output),
      sourceChecksum,
      cacheHit: false,
      sourceComplete: true,
      metrics: exporterMetrics
    };
  };

  const materializeKoreaKapt = async (shard, discovery, options) => {
    const version = safeVersion(discovery.version);
    const sourceMaximum = Math.min(options.maxRecords, Number(shard.maxRecords || options.maxRecords));
    const policyIdentity = normalizedCachePolicyIdentity(sourceMaximum, options.perLocality);
    const identity = `${shard.id}-${version}-${policyIdentity}`;
    const normalizedRoot = resolve(options.cacheDir, 'normalized');
    const rawRoot = resolve(options.cacheDir, 'raw');
    const validCounts = (state) => {
      const counts = ['candidate_count', 'resolved_count', 'publishable_count', 'selected_count']
        .map((name) => Number(state[name]));
      return counts.every((value) => Number.isSafeInteger(value) && value >= 0)
        && counts[3] <= counts[2] && counts[1] <= counts[0];
    };
    const validState = (state) => state?.version === 2
      && state.catalog_fingerprint === discovery.sourceChecksum
      && typeof state.source_complete === 'boolean'
      && validCounts(state)
      && (state.source_complete ? state.resolved_count === state.candidate_count
        : typeof state.checkpoint_token === 'string' && state.checkpoint_token.length > 0);
    const manifests = await readdir(rawRoot).catch((error) => {
      if (error?.code === 'ENOENT') return [];
      throw error;
    });
    for (const name of manifests.filter((entry) => entry.startsWith(`${identity}-manifest-`) && entry.endsWith('.json')).sort()) {
      let manifest;
      try {
        manifest = JSON.parse(await readFile(resolve(rawRoot, name), 'utf8'));
      } catch (error) {
        throw sourceStateError(`K-apt manifest ${name}`, error);
      }
      if (!validState(manifest) || manifest.source_complete !== true || manifest.policy_identity !== policyIdentity
          || typeof manifest.output_file !== 'string' || basename(manifest.output_file) !== manifest.output_file
          || !manifest.output_file.startsWith(`${identity}-output-`)
          || !/^[a-f\d]{64}$/u.test(String(manifest.output_checksum || ''))
          || !Number.isSafeInteger(manifest.output_bytes) || manifest.output_bytes <= 0) {
        throw sourceStateError(`K-apt manifest ${name}`);
      }
      const output = resolve(normalizedRoot, manifest.output_file);
      try {
        const size = (await stat(output)).size;
        if (size !== manifest.output_bytes || await sha256File(output) !== manifest.output_checksum) continue;
        return {
          file: output, format: 'overture-jsonl', cacheBytes: size, checksum: manifest.output_checksum,
          sourceChecksum: discovery.sourceChecksum, cacheHit: true, sourceComplete: true, checkpointToken: null,
          metrics: {
            candidateCount: Number(manifest.candidate_count || 0),
            resolvedCount: Number(manifest.resolved_count || 0),
            publishableCount: Number(manifest.publishable_count || 0),
            selectedCount: Number(manifest.selected_count || 0)
          }
        };
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    const cacheFile = resolve(rawRoot, `${shard.id}-postcode-cache.jsonl`);
    const temporary = resolve(normalizedRoot, `${identity}.${process.pid}.tmp`);
    const temporaryState = resolve(rawRoot, `${identity}-state.${process.pid}.tmp`);
    await Promise.all([
      mkdir(normalizedRoot, { recursive: true }),
      mkdir(rawRoot, { recursive: true })
    ]);
    const bridge = createGeoapifyCredentialBridge({
      credentialPool: geoapifyCredentialPool,
      brokerClient: credentialBrokerClient,
      fetchImpl: apiFetchImpl,
      signal
    });
    const bridgeUrl = await bridge.start();
    const childEnvironment = Object.fromEntries(Object.entries(environment).filter(([name]) =>
      name !== 'GEOAPIFY_API_KEY' && !/^GEOAPIFY_API_KEY_\d+$/u.test(name)));
    try {
      try {
        await runExecute({
          file: pythonBin,
          args: [koreaKaptExporter,
            '--output', temporary,
            '--catalog-input', discovery.catalogFile,
            '--state-output', temporaryState,
            '--max-records', String(sourceMaximum),
            '--per-locality', String(options.perLocality),
            '--postcode-cache', cacheFile,
            '--geocode-concurrency', String(shard.source.geocodeConcurrency || 3)],
          env: { ...childEnvironment, ADDRESS_SYNC_GEOAPIFY_BRIDGE_URL: bridgeUrl },
          phase: `materialize:${shard.id}`
        });
      } catch (error) {
        if (bridge.unavailable()) throw Object.assign(new Error('No Geoapify credential is currently available', { cause: error }), {
          code: 'SOURCE_CREDENTIAL_UNAVAILABLE'
        });
        throw error;
      }
      const state = JSON.parse(await readFile(temporaryState, 'utf8'));
      if (!validState(state)) {
        throw Object.assign(new Error('K-apt exporter returned invalid resume state'), {
          code: 'SOURCE_METADATA_INVALID'
        });
      }
      const outputBytes = (await stat(temporary)).size;
      const metrics = {
        candidateCount: Number(state.candidate_count),
        resolvedCount: Number(state.resolved_count),
        publishableCount: Number(state.publishable_count),
        selectedCount: Number(state.selected_count),
        geoapifyRequestCount: bridge.requestCount()
      };
      if (!state.source_complete) {
        const outputChecksum = outputBytes > 0 ? await sha256File(temporary) : null;
        const partialOutput = outputChecksum
          ? resolve(normalizedRoot, `${identity}-partial-${outputChecksum.slice(0, 24)}.jsonl`)
          : null;
        if (partialOutput) await publishContentAddressed(temporary, partialOutput, outputChecksum);
        return {
          file: partialOutput,
          format: partialOutput ? 'overture-jsonl' : 'checkpoint',
          cacheBytes: outputBytes,
          checksum: outputChecksum,
          sourceChecksum: discovery.sourceChecksum,
          cacheHit: false,
          sourceComplete: false,
          checkpointToken: state.checkpoint_token || null,
          checkpointStage: bridge.unavailable() ? 'credential' : 'materialize',
          nextAttemptAt: bridge.nextAvailableAt?.() || null,
          metrics
        };
      }
      const outputChecksum = await sha256File(temporary);
      const outputFile = `${identity}-output-${outputChecksum.slice(0, 24)}-${process.pid}-${Date.now()}.jsonl`;
      const output = resolve(normalizedRoot, outputFile);
      await publishContentAddressed(temporary, output, outputChecksum);
      const manifest = {
        ...state,
        policy_identity: policyIdentity,
        output_file: outputFile,
        output_checksum: outputChecksum,
        output_bytes: outputBytes
      };
      const manifestPayload = `${JSON.stringify(manifest)}\n`;
      const manifestChecksum = createHash('sha256').update(manifestPayload).digest('hex');
      const temporaryManifest = resolve(rawRoot, `${identity}-manifest.${process.pid}.tmp`);
      const manifestFile = resolve(rawRoot, `${identity}-manifest-${manifestChecksum.slice(0, 24)}.json`);
      try {
        await writeFile(temporaryManifest, manifestPayload, 'utf8');
        await publishContentAddressed(temporaryManifest, manifestFile, manifestChecksum);
      } finally {
        await rm(temporaryManifest, { force: true });
      }
      return {
        file: output,
        format: 'overture-jsonl',
        cacheBytes: outputBytes,
        checksum: outputChecksum,
        sourceChecksum: discovery.sourceChecksum,
        cacheHit: false,
        sourceComplete: true,
        checkpointToken: null,
        metrics
      };
    } finally {
      await bridge.close();
      await Promise.all([rm(temporary, { force: true }), rm(temporaryState, { force: true })]);
    }
  };

  const materializeOpenAddresses = async (shard, discovery, options) => {
    const version = safeVersion(discovery.version);
    const sourceMaximum = Math.min(options.maxRecords, Number(shard.maxRecords || options.maxRecords));
    const output = resolve(options.cacheDir, 'normalized',
      `${shard.id}-${version}-${openAddressesExportRevision}-${overtureResidentialRevision}-${normalizedCachePolicyIdentity(sourceMaximum, options.perLocality)}.jsonl`);
    const cachedSize = await existingFileSize(output);
    if (cachedSize > 0) return { file: output, format: 'overture-jsonl', cacheBytes: cachedSize, checksum: await sha256File(output), cacheHit: true };
    const rawIdentity = createHash('sha256').update(`${discovery.dataUrl}\u001f${version}`).digest('hex').slice(0, 16);
    const raw = resolve(options.cacheDir, 'raw', shard.source.archiveCacheName
      ? basename(shard.source.archiveCacheName)
      : `${rawIdentity}-${basename(new URL(discovery.dataUrl).pathname)}`);
    const temporary = `${output}.${process.pid}.tmp`;
    const candidateFile = `${temporary}.candidates.jsonl`;
    const mappingFile = `${temporary}.mapping.json`;
    const assetsFile = `${temporary}.assets.json`;
    const buildingAssetsFile = `${temporary}.building-assets.json`;
    await mkdir(resolve(options.cacheDir, 'normalized'), { recursive: true });
    await verifiedGeofabrikDownload(discovery.dataUrl, raw, { expectedBytes: discovery.sourceBytes, maxBytes: options.maxBytes });
    await writeFile(mappingFile, JSON.stringify(shard.source.mapping), 'utf8');
    await writeFile(assetsFile, '[]', 'utf8');
    await writeFile(buildingAssetsFile, JSON.stringify(discovery.buildingAssetEntries), 'utf8');
    let completed = false;
    const sourceChecksum = await sha256File(raw);
    const archiveMembers = Array.isArray(shard.source.archiveMembers)
      ? shard.source.archiveMembers
      : [shard.source.archiveMember];
    if (!archiveMembers.length || archiveMembers.some((member) => typeof member !== 'string' || !member)) {
      throw new Error(`OpenAddresses archive members are missing for ${shard.id}`);
    }
    try {
      await runExecute({
        file: pythonBin,
        args: [openAddressesExporter, '--input', raw,
          ...archiveMembers.flatMap((member) => ['--member', member]),
          '--mapping-file', mappingFile, '--country', shard.countryCode, '--output', candidateFile,
          '--max-records', String(sourceMaximum), '--per-locality', String(options.perLocality)],
        phase: `candidates:${shard.id}`
      });
      await runExecute({
        file: pythonBin,
        args: [overtureExporter, '--country', shard.countryCode, '--release', discovery.version,
          '--output', temporary, '--max-records', String(sourceMaximum),
          '--per-locality', String(options.perLocality), '--assets-file', assetsFile,
          '--building-assets-file', buildingAssetsFile, '--candidate-jsonl', candidateFile,
          ...overtureBoundsArgs(countryBoundBoxes(shard))],
        phase: `materialize:${shard.id}`
      });
      await rename(temporary, output);
      completed = true;
    } finally {
      await Promise.all([mappingFile, assetsFile, buildingAssetsFile, candidateFile, temporary]
        .map((file) => rm(file, { force: true })));
      if (!options.retainRaw && completed) await rm(raw, { force: true });
    }
    const size = (await stat(output)).size;
    return {
      file: output,
      format: 'overture-jsonl',
      cacheBytes: size,
      checksum: await sha256File(output),
      sourceChecksum,
      cacheHit: false
    };
  };

  const materializeInegiResidential = async (shard, discovery, options) => {
    const version = safeVersion(discovery.version);
    const output = resolve(options.cacheDir, 'normalized', `${shard.id}-${version}.jsonl`);
    const cachedSize = await existingFileSize(output);
    if (cachedSize > 0) return { file: output, format: 'overture-jsonl', cacheBytes: cachedSize, checksum: await sha256File(output), cacheHit: true };
    const rawRoot = resolve(options.cacheDir, 'raw');
    const sourceFile = resolve(rawRoot, basename(shard.source.archiveCacheName));
    const normalizedFile = resolve(rawRoot, basename(shard.source.normalizedArchiveCacheName));
    const temporary = `${output}.${process.pid}.tmp`;
    await mkdir(resolve(options.cacheDir, 'normalized'), { recursive: true });
    await Promise.all([
      sharedDownload(discovery.dataUrl, sourceFile, {
        expectedBytes: discovery.sourceBytes, maxBytes: options.maxBytes
      }),
      sharedDownload(discovery.normalizedDataUrl, normalizedFile, {
        expectedBytes: discovery.normalizedSourceBytes, maxBytes: options.maxBytes
      })
    ]);
    const [sourceChecksum, normalizedChecksum] = await Promise.all([
      sha256File(sourceFile), sha256File(normalizedFile)
    ]);
    if (sourceChecksum !== shard.source.sha256 || normalizedChecksum !== shard.source.normalizedSha256) {
      throw new Error('INEGI source checksum mismatch');
    }
    let completed = false;
    try {
      await runExecute({
        file: pythonBin,
        args: [inegiResidentialExporter,
          '--input', sourceFile,
          '--normalized-input', normalizedFile,
          '--normalized-member', shard.source.normalizedArchiveMember,
          '--output', temporary,
          '--max-records', String(options.maxRecords),
          '--per-locality', String(options.perLocality)],
        phase: `materialize:${shard.id}`
      });
      await rename(temporary, output);
      completed = true;
    } finally {
      await rm(temporary, { force: true });
      if (!options.retainRaw && completed) {
        await Promise.all([rm(sourceFile, { force: true }), rm(normalizedFile, { force: true })]);
      }
    }
    const size = (await stat(output)).size;
    return {
      file: output,
      format: 'overture-jsonl',
      cacheBytes: size,
      checksum: await sha256File(output),
      sourceChecksum: createHash('sha256').update(`${sourceChecksum}\u001f${normalizedChecksum}`).digest('hex'),
      cacheHit: false
    };
  };

  const materializeEthekwiniResidential = async (shard, discovery, options) => {
    const version = safeVersion(discovery.version);
    const sourceMaximum = Math.min(options.maxRecords, Number(shard.maxRecords || options.maxRecords));
    const output = resolve(options.cacheDir, 'normalized',
      `${shard.id}-${version}-${normalizedCachePolicyIdentity(sourceMaximum, options.perLocality)}.jsonl`);
    const cachedSize = await existingFileSize(output);
    if (cachedSize > 0) return { file: output, format: 'overture-jsonl', cacheBytes: cachedSize, checksum: await sha256File(output), cacheHit: true };
    const postalFile = resolve(options.cacheDir, 'raw', basename(
      shard.source.postalCacheName || `${shard.id}-${version}-postalcodes.txt`
    ));
    const temporary = `${output}.${process.pid}.tmp`;
    await mkdir(resolve(options.cacheDir, 'normalized'), { recursive: true });
    await sharedDownload(discovery.postalUrl, postalFile, {
      expectedBytes: discovery.postalBytes,
      maxBytes: Math.min(options.maxBytes, 10 * 1024 * 1024)
    });
    const postalChecksum = await sha256File(postalFile);
    let completed = false;
    try {
      await runExecute({
        file: pythonBin,
        args: [ethekwiniResidentialExporter,
          '--address-url', discovery.addressUrl,
          '--zoning-url', discovery.zoningUrl,
          '--postal-file', postalFile,
          '--output', temporary,
          '--max-records', String(sourceMaximum),
          '--per-locality', String(options.perLocality),
          '--concurrency', String(shard.source.queryConcurrency || 16)],
        phase: `materialize:${shard.id}`
      });
      await rename(temporary, output);
      completed = true;
    } finally {
      await rm(temporary, { force: true });
      if (!options.retainRaw && completed) await rm(postalFile, { force: true });
    }
    const size = (await stat(output)).size;
    return {
      file: output,
      format: 'overture-jsonl',
      cacheBytes: size,
      checksum: await sha256File(output),
      sourceChecksum: createHash('sha256').update(`${postalChecksum}\u001f${discovery.version}`).digest('hex'),
      cacheHit: false
    };
  };

  const materializeCapeTownResidential = async (shard, discovery, options) => {
    const version = safeVersion(discovery.version);
    const sourceMaximum = Math.min(options.maxRecords, Number(shard.maxRecords || options.maxRecords));
    const output = resolve(options.cacheDir, 'normalized',
      `${shard.id}-${version}-${normalizedCachePolicyIdentity(sourceMaximum, options.perLocality)}.jsonl`);
    const cachedSize = await existingFileSize(output);
    if (cachedSize > 0) return { file: output, format: 'overture-jsonl', cacheBytes: cachedSize, checksum: await sha256File(output), cacheHit: true };
    const postalFile = resolve(options.cacheDir, 'raw', basename(
      shard.source.postalCacheName || `${shard.id}-${version}-postalcodes.txt`
    ));
    const temporary = `${output}.${process.pid}.tmp`;
    await mkdir(resolve(options.cacheDir, 'normalized'), { recursive: true });
    await sharedDownload(discovery.postalUrl, postalFile, {
      expectedBytes: discovery.postalBytes,
      maxBytes: Math.min(options.maxBytes, 10 * 1024 * 1024)
    });
    const postalChecksum = await sha256File(postalFile);
    let completed = false;
    try {
      await runExecute({
        file: pythonBin,
        args: [capeTownResidentialExporter,
          '--parcel-url', discovery.parcelUrl,
          '--postal-file', postalFile,
          '--output', temporary,
          '--max-records', String(sourceMaximum),
          '--per-locality', String(options.perLocality)],
        phase: `materialize:${shard.id}`
      });
      await rename(temporary, output);
      completed = true;
    } finally {
      await rm(temporary, { force: true });
      if (!options.retainRaw && completed) await rm(postalFile, { force: true });
    }
    const size = (await stat(output)).size;
    return {
      file: output,
      format: 'overture-jsonl',
      cacheBytes: size,
      checksum: await sha256File(output),
      sourceChecksum: createHash('sha256').update(`${postalChecksum}\u001f${discovery.version}`).digest('hex'),
      cacheHit: false
    };
  };

  const materializeThailandDptResidential = async (shard, discovery, options) => {
    const version = safeVersion(discovery.version);
    const sourceMaximum = Math.min(options.maxRecords, Number(shard.maxRecords || options.maxRecords));
    const policyIdentity = normalizedCachePolicyIdentity(sourceMaximum, options.perLocality);
    const output = resolve(options.cacheDir, 'normalized', `${shard.id}-${version}-${policyIdentity}.jsonl`);
    const minimum = Number(shard.qualityGate?.minimumRecords || 1);
    try {
      const size = (await stat(output)).size;
      if (await hasMinimumLines(output, minimum)) {
        return { file: output, format: 'overture-jsonl', cacheBytes: size, checksum: await sha256File(output), cacheHit: true };
      }
      await rm(output, { force: true });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const rawRoot = resolve(options.cacheDir, 'raw');
    const statePrefix = `${shard.id}-state-`;
    const stateIdentity = createHash('sha256').update(`${version}\u001f${policyIdentity}`).digest('hex').slice(0, 20);
    const stateDirectory = resolve(rawRoot, `${statePrefix}${stateIdentity}`);
    const checkpoint = resolve(stateDirectory, 'checkpoint.json');
    const candidates = `${checkpoint}.candidates.jsonl`;
    const temporary = `${output}.${process.pid}.tmp`;
    await Promise.all([
      mkdir(resolve(options.cacheDir, 'normalized'), { recursive: true }),
      mkdir(stateDirectory, { recursive: true })
    ]);
    for (const entry of await readdir(rawRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith(statePrefix) && entry.name !== basename(stateDirectory)) {
        await rm(resolve(rawRoot, entry.name), { recursive: true, force: true });
      }
    }
    const progressToken = async () => {
      const [checkpointValue, candidateBytes] = await Promise.all([
        optionalStateText(checkpoint, 'Thailand DPT checkpoint'),
        existingFileSize(candidates).then((value) => value || 0)
      ]);
      if (!checkpointValue && !candidateBytes) return null;
      return createHash('sha256').update(`${checkpointValue}\u001f${candidateBytes}`).digest('hex');
    };
    const initialProgressToken = await progressToken();
    try {
      try {
        await runExecute({
          file: pythonBin,
          args: [thailandDptResidentialExporter,
            '--layer-url', discovery.dataUrl,
            '--output', temporary,
            '--max-records', String(sourceMaximum),
            '--per-locality', String(options.perLocality),
            '--batch-size', String(shard.source.batchSize || 500),
            '--checkpoint', checkpoint],
          phase: `materialize:${shard.id}`
        });
      } catch (error) {
        const token = await progressToken();
        if (token && token !== initialProgressToken) {
          throw Object.assign(new Error(`Thailand DPT checkpoint saved after ${error.message}`, { cause: error }), {
            code: 'SOURCE_PARTIAL', sourceComplete: false, checkpointToken: token,
            checkpointStage: 'materialize', failurePhase: `materialize:${shard.id}`, stderr: error.stderr || null
          });
        }
        throw error;
      }
      if (!await hasMinimumLines(temporary, minimum)) {
        throw Object.assign(new Error(`Thailand DPT source produced fewer than ${minimum} publishable records`), {
          code: 'SOURCE_QUALITY_FAILED'
        });
      }
      await rename(temporary, output);
      await rm(stateDirectory, { recursive: true, force: true });
    } finally {
      await rm(temporary, { force: true });
    }
    const size = (await stat(output)).size;
    return {
      file: output,
      format: 'overture-jsonl',
      cacheBytes: size,
      checksum: await sha256File(output),
      sourceChecksum: createHash('sha256').update(discovery.version).digest('hex'),
      cacheHit: false
    };
  };

  const materializeCanadaNarResidential = async (shard, discovery, options) => {
    const version = safeVersion(discovery.version);
    const sourceMaximum = Math.min(options.maxRecords, Number(shard.maxRecords || options.maxRecords));
    const policyIdentity = normalizedCachePolicyIdentity(sourceMaximum, options.perLocality);
    const output = resolve(options.cacheDir, 'normalized', `${shard.id}-${version}-${policyIdentity}.jsonl`);
    try {
      const size = (await stat(output)).size;
      const minimum = Number(shard.qualityGate?.minimumRecords || 1);
      if (await hasMinimumLines(output, minimum)) {
        return { file: output, format: 'overture-jsonl', cacheBytes: size, checksum: await sha256File(output), cacheHit: true };
      }
      await rm(output, { force: true });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const rawRoot = resolve(options.cacheDir, 'raw');
    const statePrefix = `${shard.id}-state-`;
    const stateDirectory = resolve(rawRoot, `${statePrefix}${createHash('sha256').update(`${version}\u001f${policyIdentity}`).digest('hex').slice(0, 20)}`);
    const checkpoint = resolve(stateDirectory, 'checkpoint.json');
    const temporary = `${output}.${process.pid}.tmp`;
    await mkdir(resolve(options.cacheDir, 'normalized'), { recursive: true });
    await mkdir(rawRoot, { recursive: true });
    for (const entry of await readdir(rawRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith(statePrefix) && entry.name !== basename(stateDirectory)) {
        await rm(resolve(rawRoot, entry.name), { recursive: true, force: true });
      }
    }
    try {
      await runExecute({
        file: pythonBin,
        args: [canadaNarExporter, '--archive-url', discovery.dataUrl,
          '--expected-size', String(discovery.sourceBytes || 0), '--output', temporary,
          '--checkpoint', checkpoint, '--max-records', String(sourceMaximum),
          '--per-locality', String(options.perLocality)],
        phase: `materialize:${shard.id}`
      });
      const minimum = Number(shard.qualityGate?.minimumRecords || 1);
      if (!await hasMinimumLines(temporary, minimum)) {
        throw Object.assign(new Error(`Statistics Canada NAR source produced fewer than ${minimum} publishable records`), {
          code: 'SOURCE_QUALITY_FAILED'
        });
      }
      await rename(temporary, output);
      await rm(stateDirectory, { recursive: true, force: true });
    } catch (error) {
      const checkpointValue = await optionalStateText(checkpoint, 'Statistics Canada NAR checkpoint');
      if (checkpointValue) {
        const token = createHash('sha256').update(checkpointValue).digest('hex');
        throw Object.assign(new Error(`Statistics Canada NAR checkpoint saved after ${error.message}`, { cause: error }), {
          code: 'SOURCE_PARTIAL', sourceComplete: false, checkpointToken: token,
          checkpointStage: 'province', failurePhase: `materialize:${shard.id}`, stderr: error.stderr || null
        });
      }
      throw error;
    } finally {
      await rm(temporary, { force: true });
    }
    const size = (await stat(output)).size;
    return { file: output, format: 'overture-jsonl', cacheBytes: size,
      checksum: await sha256File(output), sourceChecksum: createHash('sha256').update(discovery.version).digest('hex'),
      cacheHit: false, sourceComplete: true, checkpointToken: null };
  };

  const materializeFranceBdnbResidential = async (shard, discovery, options) => {
    const version = safeVersion(discovery.version);
    const sourceMaximum = Math.min(options.maxRecords, Number(shard.maxRecords || options.maxRecords));
    const output = resolve(options.cacheDir, 'normalized',
      `${shard.id}-${version}-${normalizedCachePolicyIdentity(sourceMaximum, options.perLocality)}.jsonl`);
    const minimum = Number(shard.qualityGate?.minimumRecords || 1);
    try {
      const size = (await stat(output)).size;
      if (await hasMinimumLines(output, minimum)) {
        return { file: output, format: 'overture-jsonl', cacheBytes: size, checksum: await sha256File(output), cacheHit: true };
      }
      await rm(output, { force: true });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const rawRoot = resolve(options.cacheDir, 'raw');
    const archiveFile = resolve(rawRoot, basename(shard.source.archiveCacheName));
    const temporary = `${output}.${process.pid}.tmp`;
    await Promise.all([
      mkdir(resolve(options.cacheDir, 'normalized'), { recursive: true }),
      mkdir(rawRoot, { recursive: true })
    ]);
    let completed = false;
    try {
      await sharedDownload(discovery.dataUrl, archiveFile, {
        expectedBytes: discovery.sourceBytes, maxBytes: options.maxBytes, retainPartial: true
      });
      const sourceChecksum = await sha256File(archiveFile);
      const configuredChecksum = String(shard.source.sha256 || '').toLowerCase();
      const advertisedChecksum = String(discovery.advertisedChecksum || '').toLowerCase();
      if (configuredChecksum && sourceChecksum !== configuredChecksum) {
        throw new Error('CSTB BDNB source checksum mismatch');
      }
      if (/^[a-f\d]{64}$/u.test(advertisedChecksum) && sourceChecksum !== advertisedChecksum) {
        throw new Error('CSTB BDNB advertised checksum mismatch');
      }
      await runExecute({
        file: pythonBin,
        args: [franceBdnbExporter,
          '--input', archiveFile,
          '--output', temporary,
          '--max-records', String(sourceMaximum),
          '--per-locality', String(options.perLocality),
          '--minimum-fiability', String(shard.source.minimumFiability || 17)],
        phase: `materialize:${shard.id}`
      });
      if (!await hasMinimumLines(temporary, minimum)) {
        throw Object.assign(new Error(`CSTB BDNB source produced fewer than ${minimum} publishable records`), {
          code: 'SOURCE_QUALITY_FAILED'
        });
      }
      await rename(temporary, output);
      completed = true;
      const size = (await stat(output)).size;
      return {
        file: output,
        format: 'overture-jsonl',
        cacheBytes: size,
        checksum: await sha256File(output),
        sourceChecksum,
        cacheHit: false
      };
    } finally {
      await rm(temporary, { force: true });
      if (!options.retainRaw && completed) await rm(archiveFile, { force: true });
    }
  };

  const materializeSpainCatastroResidential = async (shard, discovery, options) => {
    const version = safeVersion(discovery.version);
    const sourceMaximum = Math.min(options.maxRecords, Number(shard.maxRecords || options.maxRecords));
    const output = resolve(options.cacheDir, 'normalized',
      `${shard.id}-${version}-${normalizedCachePolicyIdentity(sourceMaximum, options.perLocality)}.jsonl`);
    const minimum = Number(shard.qualityGate?.minimumRecords || 1);
    try {
      const size = (await stat(output)).size;
      if (await hasMinimumLines(output, minimum)) {
        return { file: output, format: 'overture-jsonl', cacheBytes: size, checksum: await sha256File(output), cacheHit: true };
      }
      await rm(output, { force: true });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const rawRoot = resolve(options.cacheDir, 'raw');
    const addressFile = resolve(rawRoot, `${shard.id}-${version}-addresses.zip`);
    const buildingFile = resolve(rawRoot, `${shard.id}-${version}-buildings.zip`);
    const temporary = `${output}.${process.pid}.tmp`;
    await Promise.all([
      mkdir(resolve(options.cacheDir, 'normalized'), { recursive: true }),
      mkdir(rawRoot, { recursive: true })
    ]);
    let completed = false;
    try {
      const addressBytes = await sharedDownload(discovery.addressesUrl, addressFile, {
        expectedBytes: discovery.addressBytes, maxBytes: options.maxBytes, retainPartial: true
      });
      await sharedDownload(discovery.buildingsUrl, buildingFile, {
        expectedBytes: discovery.buildingBytes,
        maxBytes: Math.max(1, options.maxBytes - addressBytes),
        retainPartial: true
      });
      const [addressChecksum, buildingChecksum] = await Promise.all([
        sha256File(addressFile), sha256File(buildingFile)
      ]);
      await runExecute({
        file: pythonBin,
        args: [spainCatastroExporter,
          '--addresses-archive', addressFile,
          '--buildings-archive', buildingFile,
          '--output', temporary,
          '--max-records', String(sourceMaximum),
          '--province', shard.source.province,
          '--province-code', shard.source.provinceCode,
          '--municipality', shard.source.municipalityName,
          '--municipality-code', shard.source.code],
        phase: `materialize:${shard.id}`
      });
      if (!await hasMinimumLines(temporary, minimum)) {
        throw Object.assign(new Error(`Spanish Catastro source produced fewer than ${minimum} publishable records`), {
          code: 'SOURCE_QUALITY_FAILED'
        });
      }
      await rename(temporary, output);
      completed = true;
      const size = (await stat(output)).size;
      return {
        file: output,
        format: 'overture-jsonl',
        cacheBytes: size,
        checksum: await sha256File(output),
        sourceChecksum: createHash('sha256').update(`${addressChecksum}\u001f${buildingChecksum}`).digest('hex'),
        cacheHit: false
      };
    } finally {
      await rm(temporary, { force: true });
      if (!options.retainRaw && completed) {
        await Promise.all([rm(addressFile, { force: true }), rm(buildingFile, { force: true })]);
      }
    }
  };

  const materializeTaiwanResidential = async (shard, discovery, options) => {
    const version = safeVersion(discovery.version);
    const sourceMaximum = Math.min(options.maxRecords, Number(shard.maxRecords || options.maxRecords));
    const output = resolve(options.cacheDir, 'normalized',
      `${shard.id}-${version}-${normalizedCachePolicyIdentity(sourceMaximum, options.perLocality)}.jsonl`);
    try {
      const size = (await stat(output)).size;
      const minimum = Number(shard.qualityGate?.minimumRecords || 1);
      if (await hasMinimumLines(output, minimum)) {
        return { file: output, format: 'overture-jsonl', cacheBytes: size, checksum: await sha256File(output), cacheHit: true };
      }
      await rm(output, { force: true });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const rawRoot = resolve(options.cacheDir, 'raw');
    const archiveSources = discovery.molitArchives?.length ? discovery.molitArchives : [{
      dataUrl: discovery.dataUrl,
      archiveCacheName: shard.source.archiveCacheName,
      sha256: shard.source.sha256,
      bytes: discovery.molitBytes
    }];
    const molitFiles = archiveSources.map((archive) => resolve(rawRoot, basename(archive.archiveCacheName)));
    const openAddressesFile = resolve(rawRoot, basename(shard.source.openAddressesArchiveCacheName));
    const postcodeCache = resolve(rawRoot, basename(shard.source.postcodeCacheName));
    const temporary = `${output}.${process.pid}.tmp`;
    await mkdir(resolve(options.cacheDir, 'normalized'), { recursive: true });
    await mkdir(rawRoot, { recursive: true });
    await Promise.all([
      ...archiveSources.map((archive, index) => sharedDownload(archive.dataUrl, molitFiles[index], {
        expectedBytes: archive.bytes, maxBytes: options.maxBytes
      })),
      sharedDownload(discovery.openAddressesDataUrl, openAddressesFile, {
        expectedBytes: discovery.openAddressesBytes, maxBytes: options.maxBytes
      })
    ]);
    const [molitChecksums, openAddressesChecksum] = await Promise.all([
      Promise.all(molitFiles.map((file) => sha256File(file))), sha256File(openAddressesFile)
    ]);
    for (const [index, archive] of archiveSources.entries()) {
      if (archive.sha256 && molitChecksums[index] !== archive.sha256) {
        throw new Error(`Taiwan MOLIT source checksum mismatch: ${archive.sourceVersion || index + 1}`);
      }
    }
    let completed = false;
    try {
      await runExecute({
        file: pythonBin,
        args: [taiwanResidentialExporter,
          ...molitFiles.flatMap((file) => ['--molit-archive', file]),
          '--openaddresses-archive', openAddressesFile,
          '--postcode-cache', postcodeCache,
          '--output', temporary,
          '--max-records', String(sourceMaximum),
          '--per-locality', String(options.perLocality),
          '--request-interval', String(shard.source.postcodeRequestInterval ?? 0.2),
          '--postcode-concurrency', String(shard.source.postcodeConcurrency || 6)],
        phase: `materialize:${shard.id}`
      });
      await rename(temporary, output);
      completed = true;
    } finally {
      await rm(temporary, { force: true });
      if (!options.retainRaw && completed) {
        await Promise.all([...molitFiles, openAddressesFile].map((file) => rm(file, { force: true })));
      }
    }
    const size = (await stat(output)).size;
    return {
      file: output,
      format: 'overture-jsonl',
      cacheBytes: size,
      checksum: await sha256File(output),
      sourceChecksum: createHash('sha256')
        .update(`${molitChecksums.join('\u001f')}\u001f${openAddressesChecksum}\u001f${discovery.version}`).digest('hex'),
      cacheHit: false
    };
  };

  const materializeHongKongResidential = async (shard, discovery, options) => {
    const version = safeVersion(discovery.version);
    const sourceMaximum = Math.min(options.maxRecords, Number(shard.maxRecords || options.maxRecords));
    const output = resolve(options.cacheDir, 'normalized',
      `${shard.id}-${version}-${normalizedCachePolicyIdentity(sourceMaximum, options.perLocality)}.jsonl`);
    try {
      const size = (await stat(output)).size;
      const minimum = Number(shard.qualityGate?.minimumRecords || 1);
      if (await hasMinimumLines(output, minimum)) {
        return { file: output, format: 'overture-jsonl', cacheBytes: size, checksum: await sha256File(output), cacheHit: true };
      }
      await rm(output, { force: true });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const rawRoot = resolve(options.cacheDir, 'raw');
    const sourceFile = resolve(rawRoot, basename(shard.source.archiveCacheName));
    const temporary = `${output}.${process.pid}.tmp`;
    await mkdir(resolve(options.cacheDir, 'normalized'), { recursive: true });
    await mkdir(rawRoot, { recursive: true });
    await sharedDownload(discovery.dataUrl, sourceFile, {
      expectedBytes: discovery.sourceBytes, maxBytes: options.maxBytes
    });
    const sourceChecksum = await sha256File(sourceFile);
    let completed = false;
    try {
      await runExecute({
        file: pythonBin,
        args: [hongKongResidentialExporter,
          '--building-information', sourceFile,
          '--offline',
          '--output', temporary,
          '--max-records', String(sourceMaximum),
          '--per-district', String(options.perLocality)],
        phase: `materialize:${shard.id}`
      });
      await rename(temporary, output);
      completed = true;
    } finally {
      await rm(temporary, { force: true });
      if (!options.retainRaw && completed) await rm(sourceFile, { force: true });
    }
    const size = (await stat(output)).size;
    return {
      file: output,
      format: 'overture-jsonl',
      cacheBytes: size,
      checksum: await sha256File(output),
      sourceChecksum,
      cacheHit: false
    };
  };

  const replaceFile = async (temporary, destination) => {
    try {
      await rename(temporary, destination);
    } catch (error) {
      if (signal?.aborted) signal.throwIfAborted();
      if (!['EEXIST', 'EPERM'].includes(error?.code)) throw error;
      await rm(destination, { force: true });
      await rename(temporary, destination);
    }
  };

  const writeJsonAtomic = async (file, value) => {
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value)}\n`, 'utf8');
    await replaceFile(temporary, file);
  };

  const materializePdokBag = async (shard, discovery, options) => {
    const version = safeVersion(discovery.version);
    const sourceMaximum = options.maxRecords;
    const identity = normalizedCachePolicyIdentity(sourceMaximum, options.perLocality);
    const normalizedRoot = resolve(options.cacheDir, 'normalized');
    const rawRoot = resolve(options.cacheDir, 'raw');
    const output = resolve(normalizedRoot, `${shard.id}-${version}-${identity}.jsonl`);
    const candidates = resolve(rawRoot, `${shard.id}-${version}-${identity}-candidates.jsonl`);
    const checkpointFile = resolve(rawRoot, `${shard.id}-${version}-${identity}-checkpoint.json`);
    const minimumRecords = Number(shard.qualityGate?.minimumRecords || 1);
    await Promise.all([mkdir(normalizedRoot, { recursive: true }), mkdir(rawRoot, { recursive: true })]);
    try {
      const size = (await stat(output)).size;
      if (await hasMinimumLines(output, minimumRecords)) {
        return { file: output, format: 'overture-jsonl', cacheBytes: size, checksum: await sha256File(output), cacheHit: true };
      }
      await rm(output, { force: true });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }

    const seeds = selectDispersedSeeds(await loadSeedLocations(shard.countryCode), 400);
    if (!seeds.length) throw Object.assign(new Error('PDOK BAG discovery requires Netherlands postcode or city coordinates'), {
      code: 'SOURCE_CONFIGURATION_INVALID'
    });
    let checkpoint = { version, round: 0, seedIndex: 0, nextBySeed: {}, complete: false };
    const loaded = await readPersistedJson(checkpointFile, 'PDOK BAG checkpoint');
    if (loaded !== undefined) {
      if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded) || loaded.version !== version) {
        throw sourceStateError('PDOK BAG checkpoint');
      }
      if (loaded.version === version) {
        checkpoint = { ...checkpoint, ...loaded };
        if (!checkpoint.nextBySeed || typeof checkpoint.nextBySeed !== 'object') checkpoint.nextBySeed = {};
        if (loaded.nextUrl && !checkpoint.nextBySeed[String(loaded.seedIndex || 0)]) {
          checkpoint.nextBySeed[String(loaded.seedIndex || 0)] = loaded.nextUrl;
        }
        if (loaded.pageInSeed != null && loaded.round == null) checkpoint.round = Number(loaded.pageInSeed || 0);
      }
    }
    const processed = new Set();
    let acceptedCount = 0;
    try {
      const lines = createInterface({ input: createReadStream(candidates, { encoding: 'utf8' }), crlfDelay: Infinity });
      for await (const line of lines) {
        if (!line) continue;
        const record = JSON.parse(line);
        const id = String(record.source_record_id || record.id || '');
        if (id) processed.add(id);
        acceptedCount += 1;
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (!acceptedCount && Number(checkpoint.acceptedCount || 0) > 0) {
      throw sourceStateError('PDOK BAG candidates');
    }
    const persistCheckpoint = () => writeJsonAtomic(checkpointFile, {
      ...checkpoint, acceptedCount, updatedAt: new Date().toISOString()
    });
    const requestBudget = Math.max(1, Math.min(2_000,
      Number.parseInt(environment.PDOK_BAG_MAX_REQUESTS_PER_RUN || '1000', 10) || 1000));
    const maximumPages = Math.max(1, Math.min(10,
      Number.parseInt(environment.PDOK_BAG_MAX_PAGES_PER_SEED || '2', 10) || 2));
    const pageLimit = Math.max(1, Math.min(250,
      Math.ceil(sourceMaximum / Math.max(1, seeds.length * maximumPages)) || 1));
    const apiOrigin = new URL(discovery.dataUrl).origin;
    const apiPath = new URL(discovery.dataUrl).pathname;
    const checkedItemsUrl = (value) => {
      const url = new URL(value);
      if (url.origin !== apiOrigin || url.pathname !== apiPath) {
        throw Object.assign(new Error(`PDOK BAG returned an invalid pagination URL: ${url}`), {
          code: 'SOURCE_METADATA_INVALID'
        });
      }
      return url.toString();
    };
    let requests = 0;
    try {
      while (!checkpoint.complete && acceptedCount < sourceMaximum && requests < requestBudget) {
        signal?.throwIfAborted();
        if (checkpoint.seedIndex >= seeds.length) {
          checkpoint.complete = true;
          break;
        }
        const seedIndex = checkpoint.seedIndex;
        const seed = seeds[seedIndex];
        if (checkpoint.round > 0 && !checkpoint.nextBySeed[String(seedIndex)]) {
          checkpoint.seedIndex += 1;
          if (checkpoint.seedIndex >= seeds.length) {
            checkpoint.round += 1;
            checkpoint.seedIndex = 0;
            if (checkpoint.round >= maximumPages) checkpoint.complete = true;
          }
          await persistCheckpoint();
          continue;
        }
        const firstPage = new URL(discovery.dataUrl);
        firstPage.searchParams.set('f', 'json');
        firstPage.searchParams.set('limit', String(pageLimit));
        firstPage.searchParams.set('bbox', [
          seed.longitude - 0.06, seed.latitude - 0.04,
          seed.longitude + 0.06, seed.latitude + 0.04
        ].map((value) => value.toFixed(6)).join(','));
        const requestUrl = checkedItemsUrl(checkpoint.round > 0
          ? checkpoint.nextBySeed[String(seedIndex)] : firstPage);
        const payload = await fetchJson(requestUrl);
        requests += 1;
        if (payload?.type !== 'FeatureCollection' || !Array.isArray(payload.features)) {
          throw Object.assign(new Error('PDOK BAG returned an invalid FeatureCollection'), {
            code: 'SOURCE_METADATA_INVALID'
          });
        }
        const records = [];
        for (const feature of payload.features) {
          signal?.throwIfAborted();
          const record = normalizePdokBagFeature(feature, shard.source.name);
          if (!record || processed.has(record.source_record_id)) continue;
          processed.add(record.source_record_id);
          records.push(record);
          acceptedCount += 1;
          if (acceptedCount >= sourceMaximum) break;
        }
        if (records.length) await appendFile(candidates, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
        const next = payload.links?.find((link) => link.rel === 'next')?.href;
        if (checkpoint.round === 0 && next && acceptedCount < sourceMaximum) {
          checkpoint.nextBySeed[String(seedIndex)] = checkedItemsUrl(next);
        } else if (checkpoint.round > 0) {
          delete checkpoint.nextBySeed[String(seedIndex)];
        }
        checkpoint.seedIndex += 1;
        if (checkpoint.seedIndex >= seeds.length) {
          checkpoint.seedIndex = 0;
          checkpoint.round += 1;
          if (checkpoint.round >= maximumPages || !Object.keys(checkpoint.nextBySeed).length) checkpoint.complete = true;
        }
        if (acceptedCount >= sourceMaximum) checkpoint.complete = true;
        await persistCheckpoint();
      }
    } finally {
      await persistCheckpoint();
    }
    if (!checkpoint.complete) throw Object.assign(new Error('PDOK BAG initialization paused at its request budget'), {
      code: 'SOURCE_PARTIAL',
      sourceComplete: false,
      checkpointToken: createHash('sha256').update(JSON.stringify({
        seedIndex: checkpoint.seedIndex,
        round: checkpoint.round,
        nextBySeed: checkpoint.nextBySeed,
        processedCount: processed.size,
        acceptedCount
      })).digest('hex')
    });
    if (acceptedCount < minimumRecords) throw Object.assign(
      new Error(`PDOK BAG produced ${acceptedCount} qualifying records; ${minimumRecords} required`), {
        code: 'SOURCE_QUALITY_FAILED', metrics: { acceptedCount, minimumRecords }
      });
    const temporary = `${output}.${process.pid}.tmp`;
    let sourceChecksum;
    try {
      await copyFile(candidates, temporary);
      await replaceFile(temporary, output);
      sourceChecksum = await sha256File(candidates);
    } finally {
      await rm(temporary, { force: true });
    }
    await Promise.all([rm(candidates, { force: true }), rm(checkpointFile, { force: true })]);
    const size = (await stat(output)).size;
    return {
      file: output,
      format: 'overture-jsonl',
      cacheBytes: size,
      checksum: await sha256File(output),
      sourceChecksum,
      cacheHit: false
    };
  };

  const builtBoundaries = new Map();
  const ensureAdminBoundaries = (countryCode, cacheDir) => {
    const revision = adminBoundaryRevision(countryCode);
    const output = resolve(cacheDir, 'boundaries', countryCode, `${revision}.parquet`);
    if (existsSync(output)) return Promise.resolve(output);
    if (!builtBoundaries.has(output)) builtBoundaries.set(output, (async () => {
      const entry = adminBoundaryCatalog.countries[countryCode];
      const configFile = resolve(cacheDir, 'boundaries', countryCode, `${revision}.${process.pid}.tmp.json`);
      await mkdir(resolve(cacheDir, 'boundaries', countryCode), { recursive: true });
      await writeFile(configFile, JSON.stringify(entry));
      try {
        const overture = entry.datasets.some((dataset) => dataset.kind === 'overture-divisions');
        await runExecute({
          file: pythonBin,
          args: [adminBoundaryBuilder, '--country', countryCode, '--config-file', configFile,
            '--cache-dir', resolve(cacheDir, 'boundaries'), '--output', output,
            ...(overture ? ['--overture-release', (await overtureCatalog()).version] : [])],
          phase: `boundaries:${countryCode}`
        });
      } finally {
        await rm(configFile, { force: true });
      }
      return output;
    })().finally(() => builtBoundaries.delete(output)));
    return builtBoundaries.get(output);
  };
  const assignAdminBoundaries = async (shard, result, options) => {
    if (!result?.file || !adminBoundaryAdapters.has(shard.source?.adapter)
      || !adminBoundaryFormats.has(result.format) || !adminBoundaryRevision(shard.countryCode)) return result;
    const boundaries = await ensureAdminBoundaries(shard.countryCode, options.cacheDir);
    const output = resolve(options.cacheDir, 'boundaries', 'assigned', `${shard.id}.jsonl`);
    await mkdir(resolve(options.cacheDir, 'boundaries', 'assigned'), { recursive: true });
    await runExecute({
      file: pythonBin,
      args: [adminBoundaryAssigner, '--boundaries', boundaries, '--input', result.file,
        '--output', output, '--format', result.format],
      phase: `assign-boundaries:${shard.id}`
    });
    return { ...result, file: output, cacheFile: result.file };
  };

  // First-level region polygons correct conflicting regions and reject points outside the country.
  const assignRegionBoundaries = async (shard, result, options) => {
    if (!result?.file || !adminBoundaryAdapters.has(shard.source?.adapter) || !adminBoundaryFormats.has(result.format)
      || !regionBoundaryCountries.has(shard.countryCode)) return result;
    const output = resolve(options.cacheDir, 'boundaries', 'assigned', `${shard.id}.regions.jsonl`);
    await mkdir(resolve(options.cacheDir, 'boundaries', 'assigned'), { recursive: true });
    try {
      await assignRegionsToFile({ countryCode: shard.countryCode, input: result.file, output, format: result.format,
        cacheDir: options.cacheDir, pythonBin, execute: runExecute, signal });
    } catch (error) {
      // Rows imported without their polygon region keep a wrong source region nothing corrects later, so the shard
      // fails and is retried under the sync failure policy instead.
      if (!signal?.aborted) console.error(`[address-sync] ${shard.countryCode} region boundaries unavailable`, error?.code || error?.message || error);
      throw error;
    }
    if (result.cacheFile && result.file !== result.cacheFile) await rm(result.file, { force: true });
    return { ...result, file: output, cacheFile: result.cacheFile || result.file, regionsAssigned: true };
  };

  const materialize = async (shard, discovery, options) => {
    let result;
    if (discovery.adapter === 'overture') result = await materializeOverture(shard, discovery, options);
    else if (discovery.adapter === 'geofabrik') result = await materializeGeofabrik(shard, discovery, options);
    if (['google-residential-enrichment', 'mappls-residential'].includes(discovery.adapter)) {
      result = await materializeResidentialEnrichment(shard, discovery, options);
    }
    else if (discovery.adapter === 'singapore-hdb') result = await materializeSingaporeHdb(shard, discovery, options);
    else if (discovery.adapter === 'korea-kapt') result = await materializeKoreaKapt(shard, discovery, options);
    else if (discovery.adapter === 'openaddresses-archive') result = await materializeOpenAddresses(shard, discovery, options);
    else if (discovery.adapter === 'inegi-residential') result = await materializeInegiResidential(shard, discovery, options);
    else if (discovery.adapter === 'ethekwini-residential') result = await materializeEthekwiniResidential(shard, discovery, options);
    else if (discovery.adapter === 'cape-town-residential') result = await materializeCapeTownResidential(shard, discovery, options);
    else if (discovery.adapter === 'thailand-dpt-residential') result = await materializeThailandDptResidential(shard, discovery, options);
    else if (discovery.adapter === 'canada-nar-residential') result = await materializeCanadaNarResidential(shard, discovery, options);
    else if (discovery.adapter === 'france-bdnb-residential') result = await materializeFranceBdnbResidential(shard, discovery, options);
    else if (discovery.adapter === 'spain-catastro-residential') result = await materializeSpainCatastroResidential(shard, discovery, options);
    else if (discovery.adapter === 'taiwan-residential') result = await materializeTaiwanResidential(shard, discovery, options);
    else if (discovery.adapter === 'hong-kong-residential') result = await materializeHongKongResidential(shard, discovery, options);
    else if (discovery.adapter === 'pdok-bag') result = await materializePdokBag(shard, discovery, options);
    else if (!result) throw new Error(`Unsupported source adapter: ${discovery.adapter}`);
    result = await assignAdminBoundaries(shard, result, options);
    result = await assignRegionBoundaries(shard, result, options);
    return { ...result, snapshotMode: result.snapshotMode || shard.source?.snapshotMode || 'merge' };
  };

  const cleanupSharedRaw = async () => {
    await Promise.all([...sharedRawFiles].map((file) => rm(file, { force: true })));
    sharedRawFiles.clear();
  };

  return { discover, materialize, cleanupSharedRaw };
};
