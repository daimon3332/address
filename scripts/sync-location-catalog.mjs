import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { strFromU8, unzipSync } from 'fflate';

const countryCodes = new Set([
  'US', 'CA', 'MX', 'GB', 'DE', 'FR', 'IT', 'ES', 'NL', 'RU', 'JP', 'HK', 'SG', 'TW', 'KR', 'MY',
  'CN', 'TH', 'PH', 'VN', 'TR', 'SA', 'IN', 'AU', 'BR', 'NG', 'ZA'
]);
const usStateCodes = new Set('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC'.split(' '));
const cacheDir = new URL('../.data-cache/', import.meta.url);
const outputUrl = new URL('../.data-cache/catalog-seed.sql', import.meta.url);
const manifestUrl = new URL('../src/domain/location-catalog.meta.json', import.meta.url);
const residentialCoverageUrl = new URL('../src/domain/residential-coverage.json', import.meta.url);
const refresh = process.argv.includes('--refresh');

const sources = {
  states: 'https://raw.githubusercontent.com/dr5hn/countries-states-cities-database/master/json/states.json',
  cities: 'https://github.com/dr5hn/countries-states-cities-database/releases/latest/download/json-cities.json.gz',
  postcodes: 'https://github.com/dr5hn/countries-states-cities-database/releases/latest/download/json-postcodes.json.gz'
};

await mkdir(cacheDir, { recursive: true });

const download = async (name, url) => {
  const target = new URL(name, cacheDir);
  if (!refresh) {
    try {
      if ((await stat(target)).size > 0) return target;
    } catch {}
  }
  const response = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'address-catalog-sync' } });
  if (!response.ok) throw new Error(`${name} returned HTTP ${response.status}`);
  await writeFile(target, new Uint8Array(await response.arrayBuffer()));
  return target;
};

const downloadOptional = async (name, url) => {
  try { return await download(name, url); } catch (error) {
    if (String(error).includes('HTTP 404')) return undefined;
    throw error;
  }
};

const [statesFile, citiesFile, postcodesFile] = await Promise.all([
  download('states.json', sources.states),
  download('json-cities.json.gz', sources.cities),
  download('json-postcodes.json.gz', sources.postcodes)
]);

const states = JSON.parse(await readFile(statesFile, 'utf8'));
const cities = JSON.parse(gunzipSync(await readFile(citiesFile)).toString('utf8'));
const postcodes = JSON.parse(gunzipSync(await readFile(postcodesFile)).toString('utf8'));
const residentialCoverage = JSON.parse(await readFile(residentialCoverageUrl, 'utf8'));
const includedState = (state) => countryCodes.has(state.country_code) && (state.country_code !== 'US' || usStateCodes.has(state.iso2));
const selectedStates = states.filter(includedState);
const stateIds = new Set(selectedStates.map((state) => state.id));
const selectedCities = cities.filter((city) => countryCodes.has(city.country_code) && (!city.state_id || stateIds.has(city.state_id)));
const cityIds = new Set(selectedCities.map((city) => city.id));
let selectedPostcodes = postcodes.filter((postcode) => countryCodes.has(postcode.country_code)
  && (!postcode.state_id || stateIds.has(postcode.state_id))
  && (!postcode.city_id || cityIds.has(postcode.city_id)));
const dr5hnPostcodeCount = selectedPostcodes.length;

const statesById = new Map(selectedStates.map((state) => [state.id, state]));
const normalize = (value = '') => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const stateLookup = new Map();
for (const state of selectedStates) {
  for (const value of [state.iso2, state.fips_code, state.name, state.native, state.translations?.['zh-CN']]) {
    if (value) stateLookup.set(`${state.country_code}:${normalize(value)}`, state.id);
  }
}
const cityLookup = new Map();
for (const city of selectedCities) {
  for (const value of [city.name, city.native, city.translations?.['zh-CN']]) {
    if (value) cityLookup.set(`${city.country_code}:${city.state_id || ''}:${normalize(value)}`, city.id);
  }
}
const existingPostcodes = new Set(selectedPostcodes.map((postcode) => `${postcode.country_code}:${postcode.code}:${normalize(postcode.locality_name || '')}`));
const geoNamesTargets = [...countryCodes].filter((country) => country !== 'HK');
let geoNamesId = 1_000_000_000;
const geoNamesChecksums = {};
let geoNamesAdded = 0;
for (const country of geoNamesTargets) {
  const file = await downloadOptional(`geonames-${country}.zip`, `https://download.geonames.org/export/zip/${country}.zip`);
  if (!file) continue;
  const bytes = new Uint8Array(await readFile(file));
  geoNamesChecksums[country] = createHash('sha256').update(bytes).digest('hex');
  const archive = unzipSync(bytes);
  const entryName = Object.keys(archive).find((name) => name.toUpperCase() === `${country}.TXT`) || Object.keys(archive).find((name) => name.toLowerCase().endsWith('.txt') && !name.toLowerCase().includes('readme'));
  if (!entryName) continue;
  for (const line of strFromU8(archive[entryName]).split(/\r?\n/)) {
    if (!line) continue;
    const [countryCode, code, localityName, adminName1, adminCode1, , , , , latitude, longitude] = line.split('\t');
    if (!countryCodes.has(countryCode) || !code) continue;
    const dedupe = `${countryCode}:${code}:${normalize(localityName)}`;
    if (existingPostcodes.has(dedupe)) continue;
    const regionId = stateLookup.get(`${countryCode}:${normalize(adminCode1)}`) || stateLookup.get(`${countryCode}:${normalize(adminName1)}`) || null;
    const cityId = cityLookup.get(`${countryCode}:${regionId || ''}:${normalize(localityName)}`) || null;
    selectedPostcodes.push({
      id: geoNamesId++, code, country_code: countryCode, state_id: regionId, city_id: cityId,
      locality_name: localityName || '', latitude: latitude || null, longitude: longitude || null
    });
    existingPostcodes.add(dedupe);
    geoNamesAdded += 1;
  }
}
const pathFor = (state) => {
  const path = [];
  const seen = new Set();
  let current = state;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.unshift(current.id);
    current = current.parent_id ? statesById.get(Number(current.parent_id)) : undefined;
  }
  return `/${path.join('/')}/`;
};
const sql = (value) => value == null ? 'NULL' : typeof value === 'number' ? String(value) : `'${String(value).replaceAll("'", "''")}'`;
const number = (value) => value == null || value === '' || Number.isNaN(Number(value)) ? null : Number(value);
const tuples = (records, values) => records.map((record) => `(${values(record).map(sql).join(',')})`).join(',\n');
const writeBatch = (stream, table, columns, records, values) => {
  const batchSize = 250;
  for (let index = 0; index < records.length; index += batchSize) {
    const batch = records.slice(index, index + batchSize);
    stream.write(`INSERT INTO ${table}(${columns.join(',')}) VALUES\n${tuples(batch, values)};\n`);
  }
};

const stream = createWriteStream(outputUrl, { encoding: 'utf8' });
stream.write(`PRAGMA foreign_keys = OFF;
BEGIN TRANSACTION;
DROP TABLE IF EXISTS catalog_regions_staging;
DROP TABLE IF EXISTS catalog_cities_staging;
DROP TABLE IF EXISTS catalog_postcodes_staging;
CREATE TABLE catalog_regions_staging AS SELECT * FROM catalog_regions WHERE 0;
CREATE TABLE catalog_cities_staging AS SELECT * FROM catalog_cities WHERE 0;
CREATE TABLE catalog_postcodes_staging AS SELECT * FROM catalog_postcodes WHERE 0;
`);
writeBatch(stream, 'catalog_regions_staging', ['id', 'country_code', 'code', 'name', 'native_name', 'zh_name', 'type', 'parent_id', 'path', 'latitude', 'longitude'], selectedStates, (state) => [
  state.id, state.country_code, state.iso2 || '', state.name, state.native || state.name,
  state.translations?.['zh-CN'] || state.native || state.name, state.type || '', state.parent_id ? Number(state.parent_id) : null,
  pathFor(state), number(state.latitude), number(state.longitude)
]);
writeBatch(stream, 'catalog_cities_staging', ['id', 'country_code', 'region_id', 'name', 'native_name', 'zh_name', 'type', 'population', 'latitude', 'longitude'], selectedCities, (city) => [
  city.id, city.country_code, city.state_id || null, city.name, city.native || city.name,
  city.translations?.['zh-CN'] || city.native || city.name, city.type || 'city', number(city.population), number(city.latitude), number(city.longitude)
]);
writeBatch(stream, 'catalog_postcodes_staging', ['id', 'country_code', 'region_id', 'city_id', 'code', 'locality_name', 'latitude', 'longitude'], selectedPostcodes, (postcode) => [
  postcode.id, postcode.country_code, postcode.state_id || null, postcode.city_id || null, postcode.code,
  postcode.locality_name || '', number(postcode.latitude), number(postcode.longitude)
]);
stream.write(`INSERT INTO catalog_regions(id,country_code,code,name,native_name,zh_name,type,parent_id,path,latitude,longitude)
SELECT id,country_code,code,name,native_name,zh_name,type,parent_id,path,latitude,longitude FROM catalog_regions_staging WHERE 1
ON CONFLICT(id) DO UPDATE SET country_code=excluded.country_code,code=excluded.code,name=excluded.name,native_name=excluded.native_name,zh_name=excluded.zh_name,type=excluded.type,parent_id=excluded.parent_id,path=excluded.path,latitude=excluded.latitude,longitude=excluded.longitude;
INSERT INTO catalog_cities(id,country_code,region_id,name,native_name,zh_name,type,population,latitude,longitude)
SELECT id,country_code,region_id,name,native_name,zh_name,type,population,latitude,longitude FROM catalog_cities_staging WHERE 1
ON CONFLICT(id) DO UPDATE SET country_code=excluded.country_code,region_id=excluded.region_id,name=excluded.name,native_name=excluded.native_name,zh_name=excluded.zh_name,type=excluded.type,population=excluded.population,latitude=excluded.latitude,longitude=excluded.longitude;
INSERT INTO catalog_postcodes(id,country_code,region_id,city_id,code,locality_name,latitude,longitude)
SELECT id,country_code,region_id,city_id,code,locality_name,latitude,longitude FROM catalog_postcodes_staging WHERE 1
ON CONFLICT(id) DO UPDATE SET country_code=excluded.country_code,region_id=excluded.region_id,city_id=excluded.city_id,code=excluded.code,locality_name=excluded.locality_name,latitude=excluded.latitude,longitude=excluded.longitude;
DELETE FROM catalog_postcodes WHERE id NOT IN (SELECT id FROM catalog_postcodes_staging);
DELETE FROM catalog_cities WHERE id NOT IN (SELECT id FROM catalog_cities_staging);
DELETE FROM catalog_regions WHERE id NOT IN (SELECT id FROM catalog_regions_staging);
DROP TABLE catalog_postcodes_staging;
DROP TABLE catalog_cities_staging;
DROP TABLE catalog_regions_staging;
`);

const checksums = {};
for (const [name, file] of Object.entries({ states: statesFile, cities: citiesFile, postcodes: postcodesFile })) {
  checksums[name] = createHash('sha256').update(await readFile(file)).digest('hex');
}
const now = new Date().toISOString();
stream.write(`DELETE FROM catalog_metadata WHERE source = 'countries-states-cities-database';\n`);
stream.write(`INSERT INTO catalog_metadata(source, source_version, source_url, source_checksum, synced_at, region_count, city_count, postcode_count) VALUES (${sql('countries-states-cities-database')}, ${sql(now.slice(0, 10))}, ${sql('https://github.com/dr5hn/countries-states-cities-database')}, ${sql(checksums.cities)}, ${sql(now)}, ${selectedStates.length}, ${selectedCities.length}, ${dr5hnPostcodeCount});\n`);
stream.write(`DELETE FROM catalog_metadata WHERE source = 'geonames-postal-codes';\n`);
stream.write(`INSERT INTO catalog_metadata(source, source_version, source_url, source_checksum, synced_at, region_count, city_count, postcode_count) VALUES (${sql('geonames-postal-codes')}, ${sql(now.slice(0, 10))}, ${sql('https://download.geonames.org/export/zip/')}, ${sql(createHash('sha256').update(JSON.stringify(geoNamesChecksums)).digest('hex'))}, ${sql(now)}, 0, 0, ${geoNamesAdded});\n`);
for (let index = 0; index < residentialCoverage.length; index += 250) {
  const batch = residentialCoverage.slice(index, index + 250);
  stream.write(`INSERT INTO residential_coverage(country_code,region_name,city_name,address_count,last_verified_at,region_id,city_id) VALUES\n${tuples(batch, (record) => [
    record.countryCode, record.region || '', record.city || '', record.addressCount || 1, record.verifiedAt || now, record.regionId || null, record.cityId || null
  ])}\nON CONFLICT(country_code,region_name,city_name) DO UPDATE SET address_count = MAX(address_count, excluded.address_count), last_verified_at = MAX(last_verified_at, excluded.last_verified_at), region_id = COALESCE(excluded.region_id, residential_coverage.region_id), city_id = COALESCE(excluded.city_id, residential_coverage.city_id);\n`);
}
stream.write('COMMIT;\nPRAGMA foreign_keys = ON;\n');
await new Promise((resolve, reject) => { stream.end(resolve); stream.on('error', reject); });

const countByCountry = (records) => Object.fromEntries([...countryCodes].map((country) => [country, records.filter((record) => record.country_code === country).length]));
const manifest = {
  sources: [
    { name: 'Countries States Cities Database', url: 'https://github.com/dr5hn/countries-states-cities-database', license: 'ODbL-1.0' },
    { name: 'GeoNames Postal Codes', url: 'https://download.geonames.org/export/zip/', license: 'CC-BY-4.0', added: geoNamesAdded }
  ],
  syncedAt: now,
  checksums,
  totals: { regions: selectedStates.length, cities: selectedCities.length, postcodes: selectedPostcodes.length },
  countries: Object.fromEntries([...countryCodes].map((country) => [country, {
    regions: countByCountry(selectedStates)[country],
    cities: countByCountry(selectedCities)[country],
    postcodes: countByCountry(selectedPostcodes)[country]
  }]))
};
await writeFile(manifestUrl, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(manifest.totals));
console.log(outputUrl.pathname);
