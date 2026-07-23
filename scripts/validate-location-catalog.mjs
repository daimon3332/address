import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const databasePath = resolve(process.env.ADDRESS_DATABASE_PATH || 'data/address.sqlite');
const db = new DatabaseSync(databasePath, { readOnly: true });
const manifest = JSON.parse(await readFile(new URL('../src/domain/location-catalog.meta.json', import.meta.url), 'utf8'));
const scalar = (sql, ...params) => Number(db.prepare(sql).get(...params)?.value || 0);
const assert = (condition, message) => { if (!condition) throw new Error(message); };

for (const [table, expected] of Object.entries({
  catalog_regions: manifest.totals.regions,
  catalog_cities: manifest.totals.cities,
  catalog_postcodes: manifest.totals.postcodes
})) {
  assert(scalar(`SELECT COUNT(*) AS value FROM ${table}`) === expected, `${table} count mismatch`);
}

assert(scalar(`SELECT COUNT(*) AS value FROM catalog_cities c LEFT JOIN catalog_regions r ON r.id = c.region_id WHERE c.region_id IS NOT NULL AND (r.id IS NULL OR r.country_code <> c.country_code)`) === 0, 'orphan or cross-country cities found');
assert(scalar(`SELECT COUNT(*) AS value FROM catalog_postcodes p LEFT JOIN catalog_regions r ON r.id = p.region_id WHERE p.region_id IS NOT NULL AND (r.id IS NULL OR r.country_code <> p.country_code)`) === 0, 'orphan or cross-country postcodes found');
assert(scalar(`SELECT COUNT(*) AS value FROM catalog_postcodes p LEFT JOIN catalog_cities c ON c.id = p.city_id WHERE p.city_id IS NOT NULL AND (c.id IS NULL OR c.country_code <> p.country_code)`) === 0, 'orphan or cross-country postcode cities found');

for (const [country, expected] of Object.entries(manifest.countries)) {
  const regions = scalar('SELECT COUNT(*) AS value FROM catalog_regions WHERE country_code = ?', country);
  const cities = scalar('SELECT COUNT(*) AS value FROM catalog_cities WHERE country_code = ?', country);
  const postcodes = scalar('SELECT COUNT(*) AS value FROM catalog_postcodes WHERE country_code = ?', country);
  assert(regions === expected.regions && cities === expected.cities && postcodes === expected.postcodes, `${country} manifest mismatch`);
  assert(regions > 0, `${country} has no regions`);
  assert(cities > 0, `${country} has no cities`);
}

const citiesWithin = (country, regionName) => db.prepare(`SELECT c.name FROM catalog_cities c JOIN catalog_regions selected ON selected.country_code = c.country_code AND selected.name = ? JOIN catalog_regions child ON child.id = c.region_id AND child.path LIKE selected.path || '%' WHERE c.country_code = ?`).all(regionName, country).map((row) => row.name);
const california = citiesWithin('US', 'California');
assert(california.includes('Los Angeles'), 'California is missing Los Angeles');
assert(!california.includes('Chicago'), 'California contains Chicago');
const guangdong = citiesWithin('CN', 'Guangdong');
assert(guangdong.some((name) => /Shenzhen/i.test(name)), 'Guangdong is missing Shenzhen');
assert(!guangdong.some((name) => /Beijing/i.test(name)), 'Guangdong contains Beijing');

const summary = Object.fromEntries(Object.keys(manifest.countries).map((country) => [country, {
  regions: scalar('SELECT COUNT(*) AS value FROM catalog_regions WHERE country_code = ?', country),
  cities: scalar('SELECT COUNT(*) AS value FROM catalog_cities WHERE country_code = ?', country),
  postcodes: scalar('SELECT COUNT(DISTINCT code) AS value FROM catalog_postcodes WHERE country_code = ?', country)
}]));
console.log(JSON.stringify({ totals: manifest.totals, countries: summary }, null, 2));
db.close();
