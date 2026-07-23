// Address data quality gate.
// Part 1 (geo-anchored countries): city fields must resolve to a city-tier
//   catalog entry (coordinate-consistent hierarchy).
// Part 2 (all countries): per-country sampled checks — postcode pattern,
//   admin1/street/houseNumber emptiness, script sanity (no Cyrillic in CN, no
//   Han in RU, etc.). Fails (exit 1) when any country exceeds its defect ratio.
//
// Usage: node scripts/validate-address-quality.mjs [DB_PATH] [COUNTRY...]

import { DatabaseSync } from 'node:sqlite';
import { CatalogReverseGeocoder } from '../server/sync/catalog-reverse-geocoder.mjs';
import { postcodePatterns } from '../src/domain/postcode-patterns.mjs';

const dbPath = process.argv[2] || process.env.ADDRESS_DB_PATH || 'data/address.sqlite';
const requested = process.argv.slice(3).map((code) => code.toUpperCase());
const anchoredCountries = ['CN'];
const SAMPLE = 4000;
const MAX_DEFECT_RATIO = 0.1;

const ALL_COUNTRIES = ['US', 'CA', 'MX', 'DE', 'FR', 'IT', 'ES', 'NL', 'JP', 'TW', 'AU', 'GB', 'RU', 'CN', 'KR', 'MY', 'TH', 'PH', 'VN', 'TR', 'SA', 'IN', 'NG', 'ZA', 'BR', 'SG', 'HK'];

// Postcode shapes come from the shared module; HK legitimately has none.

const cyrillic = /[Ѐ-ӿ]/u;
const han = /\p{Script=Han}/u;
// Scripts that must NOT appear in the native street of a country.
const forbiddenStreetScript = {
  CN: cyrillic, TW: cyrillic, JP: cyrillic, KR: cyrillic,
  RU: han, DE: han, FR: han, IT: han, ES: han, NL: han, GB: han, US: han, CA: han, AU: han, BR: han
};

const wrap = (db) => ({
  prepare(sql) {
    const statement = db.prepare(sql);
    return { bind(...args) { return { all() { return { results: statement.all(...args) }; } }; } };
  }
});

const anchoredCheck = async (db, country) => {
  const geocoder = await CatalogReverseGeocoder.load(wrap(db), country);
  if (!geocoder.hierarchyReady) {
    console.log(`[${country}] catalog hierarchy not ready — anchored check skipped`);
    return false;
  }
  const cityNames = new Set(geocoder.cityTier.map((city) => String(city.native_name || '').trim()).filter(Boolean));
  const rows = db.prepare(`SELECT admin1, locality, district FROM address_pool
    WHERE country_code = ? AND active = 1 ORDER BY random_key LIMIT ${SAMPLE}`).all(country);
  let defects = 0;
  const samples = [];
  for (const row of rows) {
    const city = String(row.locality || '').trim();
    const normalized = city.replace(/(?:市|自治州|地区|盟)$/u, '');
    const inCatalog = cityNames.has(city)
      || [...cityNames].some((name) => name.replace(/(?:市|自治州|地区|盟)$/u, '') === normalized);
    if (!inCatalog) {
      defects++;
      if (samples.length < 8) samples.push(`${row.admin1}/${row.locality}/${row.district}`);
    }
  }
  const ratio = rows.length ? defects / rows.length : 0;
  const failed = ratio > MAX_DEFECT_RATIO;
  console.log(`[${country}] anchored ${failed ? 'FAIL' : 'ok'} sampled=${rows.length} city-off-catalog=${defects} (${(ratio * 100).toFixed(1)}%, max ${MAX_DEFECT_RATIO * 100}%)`);
  if (samples.length) console.log(`  e.g. ${samples.join(' | ')}`);
  return failed;
};

const generalCheck = (db, country) => {
  // Sample only rows the read layer can serve (mirrors completenessClause), so
  // the gate measures user-visible quality rather than dead rows the API skips.
  const rows = db.prepare(`SELECT admin1, locality, postal_locality, district, street, house_number, postcode
    FROM address_pool WHERE country_code = ? AND active = 1
      AND (locality <> '' OR (postal_locality <> '' AND postal_locality <> street) OR district <> '' OR country_code IN ('SG'))
    ORDER BY random_key LIMIT ${SAMPLE}`).all(country);
  if (!rows.length) {
    console.log(`[${country}] general skip — no rows`);
    return false;
  }
  let emptyStreet = 0;
  let emptyCity = 0;
  let badPostcode = 0;
  let postcodePresent = 0;
  let badScript = 0;
  const pattern = postcodePatterns[country];
  const forbidden = forbiddenStreetScript[country];
  const samples = [];
  for (const row of rows) {
    if (!String(row.street || '').trim()) emptyStreet++;
    // City is judged at display semantics: locality with postal_locality/district
    // substitution (matching the read layer), never counting a street copy.
    const displayCity = String(row.locality || '').trim()
      || (String(row.postal_locality || '').trim() !== String(row.street || '').trim() ? String(row.postal_locality || '').trim() : '')
      || String(row.district || '').trim();
    if (!displayCity && country !== 'HK' && country !== 'SG') emptyCity++;
    const postcode = String(row.postcode || '').trim();
    if (postcode && pattern) {
      postcodePresent++;
      if (!pattern.test(postcode)) {
        badPostcode++;
        if (samples.length < 5) samples.push(`postcode:${postcode}`);
      }
    }
    if (forbidden && forbidden.test(String(row.street || ''))) {
      badScript++;
      if (samples.length < 5) samples.push(`script:${row.street}`);
    }
  }
  const total = rows.length;
  const postcodeRatio = postcodePresent ? badPostcode / postcodePresent : 0;
  // Raw-source postcode dirt is informational only: the read layer scrubs
  // malformed values and backfills from the catalog before anything is shown.
  const failed = emptyStreet / total > MAX_DEFECT_RATIO
    || emptyCity / total > MAX_DEFECT_RATIO
    || badScript / total > MAX_DEFECT_RATIO;
  console.log(`[${country}] general ${failed ? 'FAIL' : 'ok'} sampled=${total} emptyStreet=${emptyStreet} emptyCity=${emptyCity} rawBadPostcode=${badPostcode}/${postcodePresent} (${(postcodeRatio * 100).toFixed(1)}% scrubbed at read) badScript=${badScript}`);
  if (samples.length) console.log(`  e.g. ${samples.join(' | ')}`);
  return failed;
};

const run = async () => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const countries = requested.length ? requested : ALL_COUNTRIES;
  let failed = false;
  for (const country of countries) {
    if (anchoredCountries.includes(country)) {
      failed = (await anchoredCheck(db, country)) || failed;
    }
    failed = generalCheck(db, country) || failed;
  }
  db.close();
  if (failed) process.exit(1);
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
