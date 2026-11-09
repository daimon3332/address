import { execFile } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { createBrotliDecompress } from 'node:zlib';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { isValidPostcode } from '../../src/domain/postcode-patterns.mjs';
import { refreshAddressGenerationIndex } from '../database/generation-index.mjs';
import { formattedAddress, localizedFormattedAddress } from './address-etl.mjs';
import { staleCoverage } from './stale-coverage.mjs';

const execFileAsync = promisify(execFile);
const boundaryScript = fileURLToPath(new URL('./postcode-boundary.py', import.meta.url));
const registerScript = fileURLToPath(new URL('./postcode-registers.py', import.meta.url));
const taiwanTownships = JSON.parse(await readFile(new URL('../database/tw-township-postcodes.json', import.meta.url), 'utf8'));

export const POSTCODE_INFERENCE_REVISION = 'postcode-inference-v1';
// Postcodes finer than a neighbourhood (or absent) cannot be derived from areas or neighbours; Canada, Brazil and the
// Netherlands take them only from address registers matched house by house.
export const POSTCODE_INFERENCE_EXCLUDED = new Set(['CN', 'HK', 'GB', 'JP', 'SG']);
const REGISTER_ONLY_COUNTRIES = new Set(['CA', 'BR', 'NL']);
// v2 (2026-10-27) adds official sources and rescans the rows retired only for a missing postcode in these countries.
export const POSTCODE_RECOVERY_REVISION = 'postcode-inference-v2-official-sources';
export const POSTCODE_RECOVERY_COUNTRIES = new Set(['TW', 'DE', 'FR', 'CA', 'BR', 'NL']);
const RETIRED_FOR_POSTCODE = "publication-validation:postcode-required-%";
const brazilStates = { RO: '11', AC: '12', AM: '13', RR: '14', PA: '15', AP: '16', TO: '17', MA: '21', PI: '22', CE: '23', RN: '24',
  PB: '25', PE: '26', AL: '27', SE: '28', BA: '29', MG: '31', ES: '32', RJ: '33', SP: '35', PR: '41', SC: '42', RS: '43', MS: '50',
  MT: '51', GO: '52', DF: '53' };
const cnefeBase = 'https://ftp.ibge.gov.br/Cadastro_Nacional_de_Enderecos_para_Fins_Estatisticos/Censo_Demografico_2022/Arquivos_CNEFE/CSV/UF/';
export const postcodeRegisterSources = {
  CA: { id: 'statcan-nar-202606', format: 'nar', name: 'Statistics Canada National Address Register, June 2026',
    files: () => ['https://www150.statcan.gc.ca/n1/pub/46-26-0002/2022001/202606.zip'] },
  // Only the states the rows lie in are downloaded; one state archive is up to 1.1 GB.
  BR: { id: 'ibge-cnefe-2022', format: 'cnefe', name: 'IBGE Cadastro Nacional de Endereços para Fins Estatísticos 2022',
    files: (rows) => [...new Set(rows.map((row) => clean(row.admin1_code).toUpperCase()).filter((code) => brazilStates[code]))]
      .sort().map((code) => `${cnefeBase}${brazilStates[code]}_${code}.zip`) },
  // BANO (OpenStreetMap France, ODbL) carries La Poste postcodes per address; the official BAN download was unavailable
  // (HTTP 503) on 2026-10-27, and the ban format remains for it.
  FR: { id: 'bano-france-2026-10', format: 'bano', name: 'BANO, OpenStreetMap France (ODbL)',
    files: () => ['https://bano.openstreetmap.fr/data/full.csv.gz'] }
};
export const postcodeBoundarySources = {
  US: {
    id: 'census-zcta-2020', field: 'ZCTA5CE20', name: 'U.S. Census Bureau TIGER/Line 2020 ZCTA5',
    url: 'https://www2.census.gov/geo/tiger/TIGER2020/ZCTA520/tl_2020_us_zcta520.zip'
  },
  AU: {
    id: 'abs-poa-2021', field: 'POA_CODE21', name: 'ABS ASGS Edition 3 Postal Areas 2021',
    url: 'https://www.abs.gov.au/statistics/standards/australian-statistical-geography-standard-asgs/edition-3-july-2021-june-2026/access-and-downloads/digital-boundary-files/POA_2021_AUST_GDA2020_SHP.zip'
  },
  DE: {
    id: 'osm-postal-code-areas-de-2026-02', field: 'postcode', format: 'geojson-br',
    name: 'OpenStreetMap postal code boundaries (yetzt/postleitzahlen 2026.02, ODbL)',
    url: 'https://github.com/yetzt/postleitzahlen/releases/download/2026.02/postleitzahlen.geojson.br'
  }
};
// Taiwan's 3-digit postal zones are assigned per township (鄉鎮市區), so one township's source postcodes determine it.
const TOWNSHIP_POSTCODE_COUNTRIES = new Set(['TW']);
const inferenceRevision = (country) => `${POSTCODE_RECOVERY_COUNTRIES.has(country) ? POSTCODE_RECOVERY_REVISION : POSTCODE_INFERENCE_REVISION}${
  TOWNSHIP_POSTCODE_COUNTRIES.has(country) ? '+township' : ''}`;
const CATALOG_DISTANCE_DEGREES = 0.3;
const NEIGHBOR_LATITUDE = 0.01;
const NEIGHBOR_LONGITUDE = 0.012;
const MINIMUM_NEIGHBORS = 3;

const clean = (value) => String(value ?? '').trim();
const nameKey = (value) => clean(value).normalize('NFKC').toLocaleUpperCase('und').replace(/\s+/gu, ' ');
const postcodeKey = (value) => clean(value).normalize('NFKC').toLocaleLowerCase('und').replace(/\s/gu, '');
const localityOf = (row) => nameKey(row.postal_locality || row.locality);

const downloadOnce = async (url, file) => {
  if (await stat(file).then((info) => info.size > 0, () => false)) return file;
  await mkdir(resolve(file, '..'), { recursive: true });
  const partial = `${file}.part`;
  await execFileAsync('curl', ['-4', '-fsSL', '--retry', '5', '--retry-all-errors', '--connect-timeout', '20', '-C', '-', '-o', partial, url],
    { maxBuffer: 1024 * 1024, timeout: 3 * 60 * 60_000 });
  await rename(partial, file);
  return file;
};

const downloadBoundary = async (source, cacheDir) => {
  // Kept outside raw/ so stale-artifact cleanup does not force a re-download on every run.
  const directory = resolve(cacheDir, 'reference', 'postcode-boundaries');
  if (source.format !== 'geojson-br') return downloadOnce(source.url, resolve(directory, `${source.id}.zip`));
  const geojson = resolve(directory, `${source.id}.geojson`);
  if (await stat(geojson).then((info) => info.size > 0, () => false)) return geojson;
  const compressed = await downloadOnce(source.url, resolve(directory, `${source.id}.geojson.br`));
  await pipeline(createReadStream(compressed), createBrotliDecompress(), createWriteStream(`${geojson}.part`));
  await rename(`${geojson}.part`, geojson);
  await rm(compressed, { force: true });
  return geojson;
};

// Point-in-polygon lookup in DuckDB; returns address id -> postcode for points inside exactly one area.
export const boundaryPostcodes = async (source, points, { cacheDir, pythonBin = process.env.PYTHON_BIN || 'python3' }) => {
  if (!points.length) return new Map();
  const boundary = await downloadBoundary(source, cacheDir);
  const directory = resolve(cacheDir, 'postcode-inference');
  await mkdir(directory, { recursive: true });
  const stamp = `${source.id}-${process.pid}-${Date.now()}`;
  const input = resolve(directory, `${stamp}.csv`);
  const output = resolve(directory, `${stamp}.out.csv`);
  try {
    await writeFile(input, `id,longitude,latitude\n${points.map((point) => `${point.id},${point.longitude},${point.latitude}`).join('\n')}\n`);
    await execFileAsync(pythonBin, [boundaryScript, source.format === 'geojson-br' ? '--boundary-file' : '--boundary-zip', boundary,
      '--field', source.field, '--input', input, '--output', output],
      { maxBuffer: 16 * 1024 * 1024, timeout: 60 * 60_000 });
    const lines = (await readFile(output, 'utf8')).trim().split('\n').slice(1).filter(Boolean);
    return new Map(lines.map((line) => line.split(',')).map(([id, code]) => [id, clean(code)]));
  } finally {
    await rm(input, { force: true });
    await rm(output, { force: true });
  }
};

// Official address registers: a row takes the postcode of register addresses with its house number within 60 m.
export const registerPostcodes = async (source, rows, { cacheDir, pythonBin = process.env.PYTHON_BIN || 'python3' }) => {
  const points = rows.filter((row) => clean(row.house_number) && Number.isFinite(Number(row.latitude)) && Number.isFinite(Number(row.longitude)));
  if (!points.length) return new Map();
  const directory = resolve(cacheDir, 'reference', 'postcode-registers', source.id);
  const registers = [];
  for (const url of source.files(points)) registers.push(await downloadOnce(url, resolve(directory, new URL(url).pathname.split('/').pop())));
  if (!registers.length) return new Map();
  const work = resolve(cacheDir, 'postcode-inference');
  await mkdir(work, { recursive: true });
  const stamp = `${source.id}-${process.pid}-${Date.now()}`;
  const input = resolve(work, `${stamp}.csv`);
  const output = resolve(work, `${stamp}.out.csv`);
  try {
    await writeFile(input, `id,latitude,longitude,number\n${points.map((row) =>
      [row.id, row.latitude, row.longitude, clean(row.house_number).replace(/[",\n]/gu, ' ')].join(',')).join('\n')}\n`);
    await execFileAsync(pythonBin, [registerScript, '--format', source.format, ...registers.flatMap((file) => ['--register', file]),
      '--input', input, '--output', output], { maxBuffer: 16 * 1024 * 1024, timeout: 3 * 60 * 60_000 });
    const lines = (await readFile(output, 'utf8')).trim().split('\n').slice(1).filter(Boolean);
    return new Map(lines.map((line) => line.split(',')).map(([id, code]) => [id, clean(code)]));
  } finally {
    await rm(input, { force: true });
    await rm(output, { force: true });
  }
};

// The Dutch BAG through the PDOK locatieserver: the nearest addresses with the row's house number name its postcode.
const PDOK_REVERSE = 'https://api.pdok.nl/bzk/locatieserver/search/v3_1/reverse';
export const pdokPostcodes = async (rows, { fetchImpl = fetch, signal } = {}) => {
  const found = new Map();
  for (const row of rows) {
    signal?.throwIfAborted();
    const number = clean(row.house_number).toUpperCase().replace(/[^0-9A-Z]/gu, '');
    if (!number) continue;
    const url = new URL(PDOK_REVERSE);
    for (const [key, value] of Object.entries({ lat: row.latitude, lon: row.longitude, type: 'adres', rows: 20, distance: 60,
      fl: 'postcode,huisnummer,huisletter,huisnummertoevoeging,afstand' })) url.searchParams.set(key, String(value));
    const response = await fetchImpl(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)].filter(Boolean)) })
      .catch(() => null);
    if (!response?.ok) continue;
    const docs = (await response.json().catch(() => ({})))?.response?.docs || [];
    const codes = new Set(docs.filter((doc) => `${doc.huisnummer ?? ''}${doc.huisletter ?? ''}${doc.huisnummertoevoeging ?? ''}`
      .toUpperCase().replace(/[^0-9A-Z]/gu, '') === number && doc.postcode).map((doc) => clean(doc.postcode).toUpperCase()
      .replace(/^(\d{4})\s?([A-Z]{2})$/u, '$1 $2')));
    if (codes.size === 1) found.set(row.id, [...codes][0]);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  return found;
};

// Chunghwa Post assigns one 3-digit code per township; renamed townships (員林鎮 → 員林市) match on the name stem.
const taiwanCounty = (value) => clean(value).replaceAll('台', '臺');
const townshipStem = (value) => clean(value).replace(/[鄉鎮市區]$/u, '');
const officialTownships = new Map(taiwanTownships.rows.map(([county, township, code]) => [`${county}\u001f${township}`, code]));
const officialStems = taiwanTownships.rows.reduce((map, [county, township, code]) => {
  const key = `${county}\u001f${townshipStem(township)}`;
  map.set(key, map.has(key) && map.get(key) !== code ? '' : code);
  return map;
}, new Map());
export const officialTaiwanPostcode = (row) => {
  const county = taiwanCounty(row.admin1);
  for (const township of [row.locality, row.postal_locality, row.district].map((value) => taiwanCounty(value)).filter(Boolean)) {
    const code = officialTownships.get(`${county}\u001f${township}`) || officialStems.get(`${county}\u001f${townshipStem(township)}`);
    if (code) return code;
  }
  return '';
};

// GeoNames postal codes keyed by region and place name; a place with exactly one postcode determines it.
const loadCatalogPostcodes = async (database, countryCode) => {
  const rows = (await database.prepare(`SELECT postcode.code,postcode.locality_name,postcode.latitude,postcode.longitude,
      region.code AS region_code,region.name AS region_name,region.native_name AS region_native
    FROM catalog_postcodes postcode LEFT JOIN catalog_regions region ON region.id=postcode.region_id
    WHERE postcode.country_code=?`).bind(countryCode).all()).results;
  const places = new Map();
  for (const row of rows) {
    const code = clean(row.code);
    if (!code || !isValidPostcode(countryCode, code)) continue;
    for (const region of new Set([row.region_code, row.region_name, row.region_native].map(nameKey).filter(Boolean))) {
      const key = `${region}\u001f${nameKey(row.locality_name)}`;
      const place = places.get(key) || { codes: new Set(), points: [] };
      place.codes.add(code);
      if (Number.isFinite(Number(row.latitude)) && Number.isFinite(Number(row.longitude))) {
        place.points.push([Number(row.latitude), Number(row.longitude)]);
      }
      places.set(key, place);
    }
  }
  return places;
};

const catalogPostcode = (places, row) => {
  for (const region of [row.admin1_code, row.admin1].map(nameKey).filter(Boolean)) {
    for (const place of [row.district, row.postal_locality, row.locality].map(nameKey).filter(Boolean)) {
      const entry = places.get(`${region}\u001f${place}`);
      if (!entry) continue;
      if (entry.codes.size !== 1) return '';
      const near = !entry.points.length || entry.points.some(([latitude, longitude]) =>
        Math.abs(latitude - Number(row.latitude)) <= CATALOG_DISTANCE_DEGREES
        && Math.abs(longitude - Number(row.longitude)) <= CATALOG_DISTANCE_DEGREES);
      return near ? [...entry.codes][0] : '';
    }
  }
  return '';
};

// Source-provided postcodes of nearby addresses in the same place; derived postcodes never vote.
const neighborPostcodes = async (database, countryCode, rows) => {
  const found = new Map();
  for (const row of rows) {
    const latitude = Number(row.latitude);
    const longitude = Number(row.longitude);
    const votes = (await database.prepare(`SELECT pool.postcode,COUNT(*) AS total FROM address_pool pool
      LEFT JOIN address_postcode_inference inferred ON inferred.address_id=pool.id AND inferred.postcode<>''
      WHERE pool.country_code=? AND pool.active=1 AND pool.postcode<>'' AND inferred.address_id IS NULL
        AND pool.latitude BETWEEN ? AND ? AND pool.longitude BETWEEN ? AND ?
        AND upper(coalesce(nullif(pool.postal_locality,''),pool.locality))=?
      GROUP BY pool.postcode`).bind(countryCode, latitude - NEIGHBOR_LATITUDE, latitude + NEIGHBOR_LATITUDE,
      longitude - NEIGHBOR_LONGITUDE, longitude + NEIGHBOR_LONGITUDE, localityOf(row)).all()).results;
    if (votes.length === 1 && Number(votes[0].total) >= MINIMUM_NEIGHBORS) found.set(row.id, clean(votes[0].postcode));
  }
  return found;
};

const townshipKey = (row) => `${clean(row.admin1)}\u001f${clean(row.locality)}`.replaceAll('台', '臺');
const loadTownshipPostcodes = async (database, countryCode) => {
  const rows = (await database.prepare(`SELECT pool.admin1,pool.locality,pool.postcode,COUNT(*) AS total FROM address_pool pool
    LEFT JOIN address_postcode_inference inferred ON inferred.address_id=pool.id AND inferred.postcode<>''
    WHERE pool.country_code=? AND pool.active=1 AND pool.postcode<>'' AND pool.locality<>'' AND inferred.address_id IS NULL
    GROUP BY pool.admin1,pool.locality,pool.postcode`).bind(countryCode).all()).results;
  const townships = new Map();
  for (const row of rows) {
    const township = townships.get(townshipKey(row)) || { codes: new Set(), total: 0 };
    township.codes.add(clean(row.postcode).slice(0, 3));
    township.total += Number(row.total);
    townships.set(townshipKey(row), township);
  }
  return new Map([...townships].filter(([, township]) => township.codes.size === 1 && township.total >= MINIMUM_NEIGHBORS)
    .map(([key, township]) => [key, [...township.codes][0]]));
};

const withPostcode = (row, postcode, countryCode) => {
  const components = JSON.parse(row.component_variants_json || '{}');
  const addresses = JSON.parse(row.address_variants_json || '{}');
  const previousNative = formattedAddress(components.native || {}, countryCode);
  for (const language of Object.keys(components)) components[language] = { ...components[language], postcode };
  if (addresses.native === previousNative) addresses.native = formattedAddress(components.native, countryCode);
  if (components.en) addresses.en = localizedFormattedAddress(components.en, countryCode, 'en');
  if (components['zh-CN']) addresses['zh-CN'] = localizedFormattedAddress(components['zh-CN'], countryCode, 'zh-CN');
  return { components: JSON.stringify(components), addresses: JSON.stringify(addresses) };
};

// A recovery country's rows retired for a missing postcode may only be deleted once its official sources were applied.
export const postcodeRecoveryDone = async (database, countryCode) => {
  const country = String(countryCode || '').toUpperCase();
  if (!POSTCODE_RECOVERY_COUNTRIES.has(country)) return true;
  return await database.prepare('SELECT value_json FROM translation_backfill_progress WHERE key=?')
    .bind(`postcode-inference:${country}`).first('value_json') === JSON.stringify({ revision: inferenceRevision(country) });
};

// Without address ids the whole country is scanned once per inference revision; imports pass the rows they wrote.
export const runPostcodeInference = async ({
  database, countryCode, cacheDir, pythonBin, boundaryLookup = boundaryPostcodes, registerLookup = registerPostcodes,
  pdokLookup = pdokPostcodes, pageSize = 5_000, now = () => new Date(), signal, addressIds
}) => {
  const country = String(countryCode || '').toUpperCase();
  const summary = { countryCode: country, checked: 0, boundary: 0, catalog: 0, township: 0, neighbor: 0, official: 0, register: 0, restored: 0 };
  // Not logged: callers re-check the administrative names of the rows a filled postcode may contradict. Set before the
  // early returns, which skipped it and failed every Hong Kong import (#20).
  const filled = [];
  Object.defineProperty(summary, 'filledIds', { value: filled });
  const revision = inferenceRevision(country);
  if (POSTCODE_INFERENCE_EXCLUDED.has(country)) return summary;
  const markerKey = `postcode-inference:${country}`;
  const scoped = Array.isArray(addressIds);
  if (!scoped && await database.prepare('SELECT value_json FROM translation_backfill_progress WHERE key=?')
    .bind(markerKey).first('value_json') === JSON.stringify({ revision })) return summary;
  const ids = scoped ? [...new Set(addressIds.map(String))].sort() : [];
  const boundary = postcodeBoundarySources[country];
  const register = postcodeRegisterSources[country];
  const recovery = POSTCODE_RECOVERY_COUNTRIES.has(country);
  const registerOnly = REGISTER_ONLY_COUNTRIES.has(country);
  // Imports and recovery countries also read rows retired only for a missing postcode; a filled postcode publishes them.
  const eligible = recovery || scoped ? `(pool.active=1 OR pool.retired_at LIKE '${RETIRED_FOR_POSTCODE}')` : 'pool.active=1';
  let places;
  let townships;
  let cursor = '';
  // A recovery scan lists its candidates once: the retired rows it reads have no index to page through, and a register
  // lookup reads the indexes of the whole area its rows span, so all candidates are matched in one pass and the pages
  // below fetch rows by id and only apply the result.
  const candidates = recovery && !scoped ? (await database.prepare(`SELECT pool.id,pool.latitude,pool.longitude,pool.house_number,
      pool.admin1_code
    FROM address_pool pool LEFT JOIN address_postcode_inference inferred ON inferred.address_id=pool.id
    WHERE pool.country_code=? AND ${eligible} AND pool.postcode='' AND (inferred.address_id IS NULL OR inferred.checked_revision<>?)`)
    .bind(country, revision).all()).results : null;
  // Appended one by one: spreading a few hundred thousand ids into push() exceeds the call stack.
  if (candidates) {
    for (const row of candidates) ids.push(String(row.id));
    ids.sort();
  }
  const byIds = scoped || Boolean(candidates);
  const registerMatches = register && candidates ? await registerLookup(register, candidates, { cacheDir, pythonBin }) : null;
  for (let offset = 0; ; offset += pageSize) {
    signal?.throwIfAborted();
    const batch = ids.slice(offset, offset + pageSize);
    if (byIds && !batch.length) break;
    const rows = (await database.prepare(`SELECT pool.id,pool.active,pool.latitude,pool.longitude,pool.admin1,pool.admin1_code,pool.locality,
        pool.postal_locality,pool.district,pool.house_number,pool.component_variants_json,pool.address_variants_json
      FROM address_pool pool LEFT JOIN address_postcode_inference inferred ON inferred.address_id=pool.id
      WHERE pool.country_code=? AND ${eligible} AND pool.postcode=''
        AND ${byIds ? `pool.id IN (${batch.map(() => '?').join(',')})` : 'pool.id>?'}
        AND (inferred.address_id IS NULL OR inferred.checked_revision<>?)
      ORDER BY pool.id LIMIT ?`).bind(country, ...(byIds ? batch : [cursor]), revision, pageSize).all()).results;
    if (!rows.length) {
      if (byIds) continue;
      break;
    }
    cursor = rows.at(-1).id;
    const results = new Map();
    if (country === 'TW') {
      for (const row of rows) {
        const postcode = officialTaiwanPostcode(row);
        if (postcode) results.set(row.id, { postcode, method: 'official-township', source: 'chunghwa-post-3-digit' });
      }
    }
    if (register) {
      const matches = registerMatches || await registerLookup(register, rows.filter((row) => !results.has(row.id)), { cacheDir, pythonBin });
      for (const row of rows) {
        const postcode = !results.has(row.id) && matches.get(row.id);
        if (postcode) results.set(row.id, { postcode, method: 'address-register', source: register.id });
      }
    }
    if (country === 'NL') {
      for (const [id, postcode] of await pdokLookup(rows.filter((row) => !results.has(row.id)), { signal })) {
        results.set(id, { postcode, method: 'address-register', source: 'pdok-bag-locatieserver' });
      }
    }
    if (boundary && !registerOnly) {
      const found = await boundaryLookup(boundary, rows.map((row) => ({ id: row.id, latitude: row.latitude, longitude: row.longitude })),
        { cacheDir, pythonBin });
      for (const [id, postcode] of found) results.set(id, { postcode, method: 'boundary', source: boundary.id });
    }
    places ||= registerOnly ? new Map() : await loadCatalogPostcodes(database, country);
    for (const row of rows) {
      if (registerOnly || results.has(row.id)) continue;
      const postcode = catalogPostcode(places, row);
      if (postcode) results.set(row.id, { postcode, method: 'catalog-unique', source: 'geonames-postal-codes' });
    }
    if (TOWNSHIP_POSTCODE_COUNTRIES.has(country)) {
      townships ||= await loadTownshipPostcodes(database, country);
      for (const row of rows) {
        const postcode = !results.has(row.id) && townships.get(townshipKey(row));
        if (postcode) results.set(row.id, { postcode, method: 'township-consensus', source: 'address-pool' });
      }
    }
    const remaining = registerOnly ? [] : rows.filter((row) => !results.has(row.id));
    for (const [id, postcode] of await neighborPostcodes(database, country, remaining)) {
      results.set(id, { postcode, method: 'neighbor-consensus', source: 'address-pool' });
    }
    const updatedAt = now().toISOString();
    const updated = [];
    await database.transaction(async (transaction) => {
      for (const row of rows) {
        const result = results.get(row.id);
        const postcode = result && isValidPostcode(country, result.postcode) ? result.postcode : '';
        if (postcode) {
          const { components, addresses } = withPostcode(row, postcode, country);
          const changed = (await transaction.prepare(`UPDATE address_pool SET postcode=?,postcode_key=?,component_variants_json=?,address_variants_json=?,
              active=1,retired_at=NULL WHERE id=? AND postcode='' RETURNING id`).bind(postcode, postcodeKey(postcode), components, addresses, row.id).all()).results;
          if (!changed.length) continue;
          updated.push(row.id);
          if (Number(row.active) !== 1) summary.restored += 1;
          summary[{ boundary: 'boundary', 'catalog-unique': 'catalog', 'township-consensus': 'township', 'official-township': 'official',
            'address-register': 'register' }[result.method] || 'neighbor'] += 1;
        }
        // A row deleted since it was read (a duplicate merged by a concurrent repair) is skipped, not a failed page.
        await transaction.prepare(`INSERT INTO address_postcode_inference(address_id,postcode,method,source,checked_revision,updated_at)
          SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM address_pool WHERE id=?) ON CONFLICT(address_id) DO UPDATE SET postcode=excluded.postcode,method=excluded.method,
            source=excluded.source,checked_revision=excluded.checked_revision,updated_at=excluded.updated_at`)
          .bind(row.id, postcode, postcode ? result.method : '', postcode ? result.source : '', revision, updatedAt, row.id).run();
      }
    });
    if (updated.length) await refreshAddressGenerationIndex(database, country, { addressIds: updated });
    filled.push(...updated);
    summary.checked += rows.length;
  }
  if (summary.restored) {
    // Loaded on use: published-pool pulls in the TypeScript reader, which plain-Node audit scripts cannot load.
    const { refreshCountryCounts } = await import('../database/published-pool.mjs');
    await refreshCountryCounts(database, country, now().toISOString(), { useGenerationIndex: true });
    staleCoverage.add(country);
  }
  if (!scoped) {
    await database.prepare(`INSERT INTO translation_backfill_progress(key,value_json,updated_at) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`)
      .bind(markerKey, JSON.stringify({ revision }), now().toISOString()).run();
  }
  return summary;
};
