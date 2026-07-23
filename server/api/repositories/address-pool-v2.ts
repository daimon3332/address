import { hashSeed } from '../../../src/domain/generator';
import { Converter as createSimplifier } from 'opencc-js/t2cn';
import { Converter as createTraditionalizer } from 'opencc-js/cn2t';
import type { SqliteDatabase } from '../../database/sqlite.mjs';
import { matchesCustomBlacklist } from '../../lib/custom-blacklist.mjs';
import { isValidPostcode } from '../../../src/domain/postcode-patterns.mjs';
import {
  normalizeAddressComponents,
  validateAdministrativeHierarchy
} from '../../../src/domain/administrative-integrity.mjs';
import { findNonResidentialMatch } from '../../../src/domain/non-residential.mjs';
import type { AddressComponents, AddressEvidence, CountryCode, PropertyType, VerifiedAddress } from '../../../src/domain/types';
import type { AddressFilters, CatalogTarget } from './address-repository';

interface AddressPoolV2Row {
  id: string;
  country_code: CountryCode;
  admin1: string;
  admin1_code: string;
  locality: string;
  postal_locality: string;
  district: string;
  postcode: string;
  street: string;
  house_number: string;
  building_name: string;
  latitude: number;
  longitude: number;
  native_language: string;
  component_variants_json: string;
  address_variants_json: string;
  property_type: string;
  generation: string;
  quality_score: number;
  first_seen_at: string;
  expires_at: string | null;
  source_id: string | null;
  source_name: string | null;
  source_url: string | null;
  source_license: string | null;
  license_url: string | null;
  attribution_text: string | null;
  attribution_url: string | null;
  source_record_id: string | null;
  record_url: string | null;
  observed_at: string | null;
  evidence_type: string | null;
  residential_evidence: number;
  dataset_id: string | null;
  dataset_version: string | null;
  source_updated_at: string | null;
  imported_at: string | null;
}

const propertyTypes = new Set<PropertyType>(['residential', 'apartment', 'commercial', 'mixed', 'unknown']);
const evidenceTypes = new Set<AddressEvidence['type']>(['address_existence', 'residential_use', 'coordinate', 'building_status']);

const normalize = (value: string | undefined): string => (value || '')
  .normalize('NFKC')
  .toLocaleLowerCase()
  .replace(/\s+/gu, ' ')
  .trim();

const toSimplifiedHan = createSimplifier({ from: 'hk', to: 'cn' });
const toTraditionalHan = createTraditionalizer({ from: 'cn', to: 'tw' });
const hanScript = /\p{Script=Han}/u;

const adminSuffixes = ['市', '縣', '县', '区', '區', '省', '自治区', '自治區', '特别行政区', '特別行政區'];
const adminSuffixPattern = /(?:自治区|自治區|特别行政区|特別行政區|省|市|縣|县|区|區)$/u;

const aliases = (values: Array<string | undefined>): string[] => [...new Set(values.flatMap((value) => {
  const normalized = normalize(value);
  if (!normalized) return [];
  if (!hanScript.test(normalized)) {
    return [normalized, normalized.replace(adminSuffixPattern, '')].filter(Boolean);
  }
  // Han values match across scripts (simplified 台中 <-> traditional 臺中) and
  // across admin-suffix presence (pool stores 臺中市, catalog stores 台中).
  const scriptVariants = [...new Set([normalized, toSimplifiedHan(normalized), toTraditionalHan(normalized)])];
  return scriptVariants.flatMap((variant) => {
    const stem = variant.replace(adminSuffixPattern, '');
    if (!stem) return [variant];
    return [variant, stem, ...adminSuffixes.map((suffix) => `${stem}${suffix}`)];
  }).filter(Boolean);
}))];

// Read-layer completeness gate, mirroring the importer's per-country standard
// format requirements (docs/address-formats.md). A record missing a field its
// country's standard mandates is skipped so it never reaches the UI. Postcode is
// backfilled at read time and therefore never gates here.
const cityOnlyCountries = ['DE', 'FR', 'IT', 'ES', 'NL', 'GB', 'SA', 'ZA'];
const noGateCountries = ['SG'];
export const completenessClause = (prefix = ''): string => {
  const region = `${prefix}admin1 <> ''`;
  // postal_locality counts as city evidence only when it is a real place name,
  // not a copy of the street (rural OSM records duplicate the village into both).
  const city = `(${prefix}locality <> ''
    OR (${prefix}postal_locality <> '' AND ${prefix}postal_locality <> ${prefix}street)
    OR ${prefix}district <> '')`;
  const district = `${prefix}district <> ''`;
  const inList = (codes: string[]): string => codes.map((code) => `'${code}'`).join(',');
  return `(
    CASE
      WHEN ${prefix}country_code = 'CN' THEN (${region} AND ${city} AND ${district})
      WHEN ${prefix}country_code = 'HK' THEN ${city}
      WHEN ${prefix}country_code IN (${inList(noGateCountries)}) THEN 1
      WHEN ${prefix}country_code IN (${inList(cityOnlyCountries)}) THEN ${city}
      ELSE (${region} AND ${city})
    END
  )`;
};

const residentialEvidenceClause = `EXISTS (
  SELECT 1 FROM address_pool_evidence residential_evidence
  JOIN address_datasets residential_dataset ON residential_dataset.id = residential_evidence.dataset_id
    AND residential_dataset.status = 'active' AND residential_dataset.redistribution_allowed = 1
  JOIN address_sources residential_source ON residential_source.id = residential_dataset.source_id
    AND residential_source.redistribution_allowed = 1
  WHERE residential_evidence.address_id = address_pool.id
    AND residential_evidence.evidence_type = 'residential_use'
    AND residential_evidence.is_current = 1
)`;

const aliasClause = (columns: string[], values: string[], bindings: unknown[]): string | undefined => {
  if (!values.length) return undefined;
  const placeholders = values.map(() => '?').join(',');
  return `(${columns.map((column) => {
    bindings.push(...values);
    return `${column} IN (${placeholders})`;
  }).join(' OR ')})`;
};

const fallbackComponents = (row: AddressPoolV2Row): AddressComponents => normalizeAddressComponents(row.country_code, {
  houseNumber: row.house_number,
  street: row.street,
  ...(row.building_name ? { buildingName: row.building_name } : {}),
  locality: row.locality || row.postal_locality,
  ...(row.postal_locality ? { postalLocality: row.postal_locality } : {}),
  ...(row.district ? { district: row.district, dependentLocality: row.district } : {}),
  ...(row.admin1 ? { admin1: row.admin1 } : {}),
  ...(row.admin1_code ? { admin1Code: row.admin1_code } : {}),
  postcode: row.postcode
});

const parseVariants = <T>(value: string, fallback: T): Record<'native' | 'en' | 'zh-CN', T> => {
  try {
    const parsed = JSON.parse(value) as Partial<Record<'native' | 'en' | 'zh-CN', T>>;
    return {
      native: parsed.native || fallback,
      en: parsed.en || parsed.native || fallback,
      'zh-CN': parsed['zh-CN'] || parsed.native || fallback
    };
  } catch {
    return { native: fallback, en: fallback, 'zh-CN': fallback };
  }
};

const rowToAddress = (row: AddressPoolV2Row, now: Date): VerifiedAddress | undefined => {
  if (!row.source_id || !row.source_name || !row.source_url) return undefined;
  if (!validateAdministrativeHierarchy({
    countryCode: row.country_code, admin1: row.admin1, admin1Code: row.admin1_code
  }).valid) return undefined;
  const fallback = fallbackComponents(row);
  const fallbackAddress = [row.house_number, row.street, row.postal_locality || row.locality, row.admin1_code || row.admin1, row.postcode]
    .filter(Boolean).join(', ');
  const parsedComponents = parseVariants(row.component_variants_json, fallback);
  for (const language of ['native', 'en', 'zh-CN'] as const) {
    const components = parsedComponents[language];
    if (components !== fallback && !(components.admin1 || '').trim() && row.admin1) {
      components.admin1 = row.admin1;
      if (!(components.admin1Code || '').trim() && row.admin1_code) components.admin1Code = row.admin1_code;
    }
  }
  const componentVariants = {
    native: normalizeAddressComponents(row.country_code, parsedComponents.native),
    en: normalizeAddressComponents(row.country_code, parsedComponents.en),
    'zh-CN': normalizeAddressComponents(row.country_code, parsedComponents['zh-CN'])
  };
  const addressVariants = parseVariants(row.address_variants_json, fallbackAddress);
  const propertyType = propertyTypes.has(row.property_type as PropertyType)
    ? row.property_type as PropertyType
    : 'unknown';
  const variants = Object.values(componentVariants);
  if (findNonResidentialMatch({
    countryCode: row.country_code,
    buildingNames: variants.map((item) => item.buildingName).filter((value): value is string => Boolean(value)),
    formattedAddresses: Object.values(addressVariants),
    streets: variants.map((item) => item.street).filter(Boolean),
    propertyType
  }).excluded) return undefined;
  if (matchesCustomBlacklist([
    ...variants.map((item) => item.buildingName),
    ...Object.values(addressVariants),
    ...variants.map((item) => item.street)
  ])) return undefined;
  const sourceUpdatedAt = row.observed_at || row.source_updated_at || row.imported_at || row.first_seen_at;
  const type = evidenceTypes.has(row.evidence_type as AddressEvidence['type'])
    ? row.evidence_type as AddressEvidence['type']
    : 'address_existence';
  const evidence: AddressEvidence[] = [{
    sourceId: row.source_id,
    sourceName: row.source_name,
    sourceUrl: row.record_url || row.source_url,
    sourceFamily: row.source_id,
    ...(row.source_license ? { sourceLicense: row.source_license } : {}),
    ...(row.license_url ? { sourceLicenseUrl: row.license_url } : {}),
    ...(row.attribution_text ? { attribution: row.attribution_text } : {}),
    ...(row.attribution_url ? { attributionUrl: row.attribution_url } : {}),
    ...(row.dataset_id ? { datasetId: row.dataset_id } : {}),
    type,
    value: addressVariants.native,
    observedAt: sourceUpdatedAt
  }];
  if (type !== 'coordinate') {
    evidence.push({
      sourceId: row.source_id,
      sourceName: row.source_name,
      sourceUrl: row.record_url || row.source_url,
      sourceFamily: row.source_id,
      type: 'coordinate',
      value: `${row.latitude},${row.longitude}`,
      observedAt: sourceUpdatedAt
    });
  }
  if (row.residential_evidence && !evidence.some(({ type: evidenceType }) => evidenceType === 'residential_use')) {
    evidence.push({
      sourceId: row.source_id,
      sourceName: row.source_name,
      sourceUrl: row.record_url || row.source_url,
      sourceFamily: row.source_id,
      type: 'residential_use',
      value: propertyType,
      observedAt: sourceUpdatedAt
    });
  }
  return {
    id: `pool-v2-${row.id}`,
    countryCode: row.country_code,
    nativeAddress: addressVariants.native,
    formattedAddress: addressVariants.en,
    nativeLanguage: row.native_language,
    addressVariants,
    components: componentVariants.native,
    componentVariants,
    coordinates: { latitude: row.latitude, longitude: row.longitude },
    addressStatus: 'verified',
    propertyType,
    unitStatus: 'building_only',
    unitProvenance: 'none',
    matchLevel: 'premise',
    verificationLevel: 'L2',
    sourceVersion: `${row.dataset_id || row.source_id}:${row.dataset_version || row.generation}`,
    sourceUpdatedAt,
    verifiedAt: now.toISOString(),
    expiresAt: row.expires_at || new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000).toISOString(),
    evidence,
    exclusionFlags: row.quality_score < 0.7 ? ['low_quality_score'] : []
  };
};

const missingSchema = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return /no such (?:table|view).*address_pool_runtime|does not exist.*address_pool_runtime/i.test(message);
};

interface RegionNameRow { code: string; name: string; native_name: string; zh_name: string }

const regionNameCaches = new WeakMap<object, Map<string, RegionNameRow | null>>();
const cityZhCaches = new WeakMap<object, Map<string, string | null>>();
const regionPresenceCaches = new WeakMap<object, Map<string, boolean>>();
const postcodeCaches = new WeakMap<object, Map<string, string | null>>();
const communityCaches = new WeakMap<object, Map<string, Array<{ zh: string; en: string }> | null>>();
const cacheFor = <T,>(store: WeakMap<object, Map<string, T>>, db: SqliteDatabase): Map<string, T> => {
  let cache = store.get(db as object);
  if (!cache) {
    cache = new Map();
    store.set(db as object, cache);
  }
  if (cache.size > 2000) cache.clear();
  return cache;
};
const han = /[\p{Script=Han}]/u;
const placeholderUnit = /^(?:apt|apartment|unit|ste|suite|fl|floor|bldg|building|#|no\.?)$/iu;
const samePlaceKey = (value: string | undefined): string => (value || '')
  .normalize('NFKC').toLocaleLowerCase('und').replace(/[^\p{L}\p{N}]+/gu, '');

const lookupRegionNames = async (
  db: SqliteDatabase,
  country: CountryCode,
  admin1: string,
  admin1Code: string
): Promise<RegionNameRow | null> => {
  const cache = cacheFor(regionNameCaches, db);
  const key = `${country}:${samePlaceKey(admin1Code || admin1)}`;
  if (cache.has(key)) return cache.get(key) || null;
  let row: RegionNameRow | null = null;
  try {
    const value = admin1Code || admin1;
    const raw = await db.prepare(`SELECT code, name, native_name, zh_name FROM catalog_regions
      WHERE country_code = ? AND (LOWER(code) = LOWER(?) OR LOWER(name) = LOWER(?) OR LOWER(native_name) = LOWER(?))
      ORDER BY CASE WHEN parent_id IS NULL THEN 0 ELSE 1 END, id LIMIT 1`)
      .bind(country, value, value, value).first<RegionNameRow>();
    row = raw && (typeof raw.name === 'string' && raw.name.trim() !== ''
      || typeof raw.native_name === 'string' && raw.native_name.trim() !== '')
      ? raw
      : null;
  } catch {
    row = null;
  }
  cache.set(key, row);
  return row;
};

const hasCatalogRegions = async (db: SqliteDatabase, country: CountryCode): Promise<boolean> => {
  const cache = cacheFor(regionPresenceCaches, db);
  if (cache.has(country)) return Boolean(cache.get(country));
  let present = false;
  try {
    present = Boolean(await db.prepare('SELECT 1 AS present FROM catalog_regions WHERE country_code = ? LIMIT 1')
      .bind(country).first<{ present: number }>());
  } catch {
    present = false;
  }
  cache.set(country, present);
  return present;
};

const lookupCityZhName = async (db: SqliteDatabase, country: CountryCode, locality: string): Promise<string | null> => {
  const cache = cacheFor(cityZhCaches, db);
  const key = `${country}:${samePlaceKey(locality)}`;
  if (cache.has(key)) return cache.get(key) || null;
  let zhName: string | null = null;
  try {
    const row = await db.prepare(`SELECT zh_name FROM catalog_cities
      WHERE country_code = ? AND (LOWER(name) = LOWER(?) OR LOWER(native_name) = LOWER(?)) AND zh_name <> ''
      ORDER BY COALESCE(population, 0) DESC, id LIMIT 1`)
      .bind(country, locality, locality).first<{ zh_name: string }>();
    zhName = typeof row?.zh_name === 'string' && han.test(row.zh_name) ? row.zh_name : null;
  } catch {
    zhName = null;
  }
  cache.set(key, zhName);
  return zhName;
};

const lookupNearestPostcode = async (
  db: SqliteDatabase,
  country: CountryCode,
  coordinates: { latitude: number; longitude: number },
  cityNames: string[] = [],
  regionNames: string[] = []
): Promise<string | null> => {
  const cache = cacheFor(postcodeCaches, db);
  const key = `${country}:${Math.round(coordinates.latitude * 20)}:${Math.round(coordinates.longitude * 20)}`;
  if (cache.has(key)) return cache.get(key) || null;
  let code: string | null = null;
  try {
    const longitudeScale = Math.max(0.1, Math.cos(coordinates.latitude * Math.PI / 180));
    const row = await db.prepare(`SELECT code, latitude, longitude FROM catalog_postcodes
      WHERE country_code = ? AND latitude IS NOT NULL AND longitude IS NOT NULL AND code <> ''
        AND latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ?
      ORDER BY ((latitude - ?) * (latitude - ?)) + ((longitude - ?) * (longitude - ?) * ? * ?), code
      LIMIT 1`)
      .bind(
        country,
        coordinates.latitude - 0.5, coordinates.latitude + 0.5,
        coordinates.longitude - 0.5 / longitudeScale, coordinates.longitude + 0.5 / longitudeScale,
        coordinates.latitude, coordinates.latitude,
        coordinates.longitude, coordinates.longitude,
        longitudeScale, longitudeScale
      ).first<{ code: string; latitude: number; longitude: number }>();
    code = typeof row?.code === 'string' && row.code.trim() !== ''
      && geographicDistanceKm(coordinates, { latitude: row.latitude, longitude: row.longitude }) <= 50
      ? row.code.trim()
      : null;
    if (!code) {
      for (const city of cityNames) {
        const needle = (city || '').trim();
        if (!needle) continue;
        const named = await db.prepare(`SELECT code FROM catalog_postcodes
          WHERE country_code = ? AND code <> ''
            AND (LOWER(locality_name) = LOWER(?) OR LOWER(locality_name) LIKE LOWER(?))
          ORDER BY CASE WHEN LOWER(locality_name) = LOWER(?) THEN 0 ELSE 1 END,
            CASE WHEN city_id IS NULL THEN 1 ELSE 0 END, code LIMIT 1`)
          .bind(country, needle, `%${needle}%`, needle).first<{ code: string }>();
        if (typeof named?.code === 'string' && named.code.trim() !== '') {
          code = named.code.trim();
          break;
        }
      }
    }
    if (!code) {
      for (const name of regionNames) {
        const needle = (name || '').trim();
        if (!needle) continue;
        const bridged = await db.prepare(`SELECT postcode.code AS code FROM catalog_regions region
          JOIN catalog_postcodes postcode ON postcode.country_code = region.country_code
            AND postcode.region_id = region.id AND postcode.code <> ''
          WHERE region.country_code = ?
            AND (LOWER(region.name) = LOWER(?) OR LOWER(region.native_name) = LOWER(?) OR LOWER(region.code) = LOWER(?)
              OR LOWER(?) LIKE '%' || LOWER(region.name) || '%' OR LOWER(?) LIKE '%' || LOWER(region.native_name) || '%')
          ORDER BY CASE WHEN LOWER(region.name) = LOWER(?) THEN 0 ELSE 1 END,
            CASE WHEN postcode.city_id IS NULL THEN 1 ELSE 0 END, postcode.code LIMIT 1`)
          .bind(country, needle, needle, needle, needle, needle, needle).first<{ code: string }>();
        if (typeof bridged?.code === 'string' && bridged.code.trim() !== '') {
          code = bridged.code.trim();
          break;
        }
      }
    }
  } catch {
    code = null;
  }
  cache.set(key, code);
  return code;
};

// Nearest real residential communities (CN). ~3km box, five candidates so the
// seeded generator pick still varies. Missing table (pre-v13 data) returns null.
const lookupNearbyCommunities = async (
  db: SqliteDatabase,
  coordinates: { latitude: number; longitude: number }
): Promise<Array<{ zh: string; en: string }> | null> => {
  const cache = cacheFor(communityCaches, db);
  const key = `${Math.round(coordinates.latitude * 50)}:${Math.round(coordinates.longitude * 50)}`;
  if (cache.has(key)) return cache.get(key) || null;
  let result: Array<{ zh: string; en: string }> | null = null;
  try {
    const longitudeScale = Math.max(0.1, Math.cos(coordinates.latitude * Math.PI / 180));
    const rows = (await db.prepare(`SELECT name, name_en FROM cn_communities
      WHERE latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ?
      ORDER BY ((latitude - ?) * (latitude - ?)) + ((longitude - ?) * (longitude - ?) * ? * ?)
      LIMIT 5`)
      .bind(
        coordinates.latitude - 0.03, coordinates.latitude + 0.03,
        coordinates.longitude - 0.03 / longitudeScale, coordinates.longitude + 0.03 / longitudeScale,
        coordinates.latitude, coordinates.latitude,
        coordinates.longitude, coordinates.longitude,
        longitudeScale, longitudeScale
      ).all<{ name: string; name_en: string }>()).results || [];
    const communities = rows
      .map((row) => ({ zh: String(row.name || '').trim(), en: String(row.name_en || '').trim() }))
      .filter((entry) => entry.zh);
    result = communities.length ? communities : null;
  } catch {
    result = null;
  }
  cache.set(key, result);
  return result;
};

export const enrichPickedAddress = async (db: SqliteDatabase, address: VerifiedAddress): Promise<VerifiedAddress> => {
  const variants = address.componentVariants;
  const updated: Record<'native' | 'en' | 'zh-CN', AddressComponents> = {
    native: { ...variants.native },
    en: { ...variants.en },
    'zh-CN': { ...variants['zh-CN'] }
  };
  const languages = ['native', 'en', 'zh-CN'] as const;
  let changed = false;

  for (const language of languages) {
    const components = updated[language];
    const houseNumber = components.houseNumber?.normalize('NFKC');
    if (houseNumber && houseNumber !== components.houseNumber) {
      components.houseNumber = houseNumber;
      changed = true;
    }
    const building = (components.buildingName || '').trim();
    if (building && placeholderUnit.test(building)) {
      delete components.buildingName;
      changed = true;
    }
  }

  const native = updated.native;
  if (native.admin1 || native.admin1Code) {
    const names = await lookupRegionNames(db, address.countryCode, native.admin1 || '', native.admin1Code || '');
    if (names) {
      const assign = (language: typeof languages[number], name: string | undefined) => {
        const value = String(name ?? '').trim();
        if (!value) return;
        if (updated[language].admin1 !== value) {
          updated[language].admin1 = value;
          changed = true;
        }
        if (names.code && updated[language].admin1Code !== names.code) {
          updated[language].admin1Code = names.code;
          changed = true;
        }
      };
      assign('native', names.native_name || names.name);
      assign('en', names.name);
      assign('zh-CN', names.zh_name || names.native_name || names.name);
    } else if ((samePlaceKey(native.admin1) === samePlaceKey(native.locality)
      || samePlaceKey(native.admin1) === samePlaceKey(native.postalLocality))
      && await hasCatalogRegions(db, address.countryCode)) {
      for (const language of languages) {
        delete updated[language].admin1;
        delete updated[language].admin1Code;
      }
      changed = true;
    }
  }

  const zhLocality = updated['zh-CN'].locality;
  if (zhLocality && !han.test(zhLocality)) {
    const zhName = await lookupCityZhName(db, address.countryCode, zhLocality);
    if (zhName) {
      updated['zh-CN'].locality = zhName;
      if (updated['zh-CN'].postalLocality && samePlaceKey(updated['zh-CN'].postalLocality) === samePlaceKey(zhLocality)) {
        updated['zh-CN'].postalLocality = zhName;
      }
      changed = true;
    }
  }

  // A source postcode that does not match the country's format (phone numbers,
  // city names, partial digits from OSM) is scrubbed so the catalog backfill
  // below replaces it with a plausible one.
  if (address.countryCode !== 'HK') {
    const sourcePostcode = (native.postcode || '').trim();
    if (sourcePostcode && !isValidPostcode(address.countryCode, sourcePostcode)) {
      for (const language of languages) updated[language].postcode = '';
      changed = true;
    }
  }

  if (address.countryCode !== 'HK' && !(updated.native.postcode || '').trim()) {
    const postcode = await lookupNearestPostcode(db, address.countryCode, address.coordinates, [
      native.locality || '', updated.en.locality || '', native.postalLocality || '',
      native.district || '', native.admin1 || '', updated.en.admin1 || ''
    ], [native.admin1 || '', updated.en.admin1 || '', native.admin1Code || '']);
    if (postcode) {
      for (const language of languages) updated[language].postcode = postcode;
      changed = true;
    }
  }

  if (address.countryCode === 'HK' && !(native.locality || '').trim()) {
    const hongKong = { native: '香港', en: 'Hong Kong', 'zh-CN': '香港' } as const;
    for (const language of languages) {
      if (!(updated[language].locality || '').trim()) {
        updated[language].locality = hongKong[language];
        changed = true;
      }
    }
  }

  // A record may carry its city only in postalLocality (or district); surface it in
  // the locality field so the city row is never blank. A postalLocality equal to
  // the street is a rural OSM duplicate, not a city.
  for (const language of languages) {
    const components = updated[language];
    if ((components.locality || '').trim()) continue;
    const postal = (components.postalLocality || '').trim();
    const substitute = postal && samePlaceKey(postal) !== samePlaceKey(components.street)
      ? postal
      : (components.district || '').trim();
    if (substitute) {
      components.locality = substitute;
      changed = true;
    }
  }

  const nearbyCommunities = address.countryCode === 'CN'
    ? await lookupNearbyCommunities(db, address.coordinates)
    : null;

  if (!changed && !nearbyCommunities) return address;
  return {
    ...address,
    components: updated.native,
    componentVariants: updated,
    ...(nearbyCommunities ? { nearbyCommunities } : {})
  };
};

const geographicDistanceKm = (
  left: { latitude: number; longitude: number },
  right: { latitude: number; longitude: number }
): number => {
  const radians = Math.PI / 180;
  const latitudeDelta = (right.latitude - left.latitude) * radians;
  const longitudeDelta = (right.longitude - left.longitude) * radians;
  const value = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(left.latitude * radians) * Math.cos(right.latitude * radians) * Math.sin(longitudeDelta / 2) ** 2;
  const bounded = Math.min(1, Math.max(0, value));
  return 6371 * 2 * Math.atan2(Math.sqrt(bounded), Math.sqrt(1 - bounded));
};

export interface NearestAddressPoolV2Result {
  address: VerifiedAddress;
  distanceKm: number;
}

export const pickNearestAddressPoolV2Address = async (
  db: SqliteDatabase | undefined,
  country: CountryCode,
  residential: boolean,
  coordinates: { latitude: number; longitude: number },
  seed: string,
  maximumDistanceKm = 100,
  now = new Date()
): Promise<NearestAddressPoolV2Result | undefined> => {
  if (!db) return undefined;
  const clauses = [
    'country_code = ?',
    'active = 1',
    'quality_score >= 0.7',
    completenessClause(),
    '(expires_at IS NULL OR (datetime(expires_at) IS NOT NULL AND datetime(expires_at) > datetime(?)))'
  ];
  const baseBindings: unknown[] = [country, now.toISOString()];
  if (residential) clauses.push(`property_type IN ('residential','apartment')`, 'residential_evidence = 1');
  const longitudeScale = Math.max(0.1, Math.cos(coordinates.latitude * Math.PI / 180));
  const radii = [...new Set([Math.min(25, maximumDistanceKm), maximumDistanceKm])].filter((radius) => radius > 0);

  try {
    for (const radiusKm of radii) {
      const latitudeRadius = radiusKm / 111.32;
      const longitudeRadius = Math.min(180, latitudeRadius / longitudeScale);
      const result = await db.prepare(`SELECT *,
        ((latitude - ?) * (latitude - ?)) +
        ((longitude - ?) * (longitude - ?) * ? * ?) AS distance_score
        FROM address_pool_runtime
        WHERE ${clauses.join(' AND ')}
          AND id IN (
            SELECT address.id FROM address_coordinate_index coordinate
            JOIN address_pool address ON address.rowid = coordinate.address_rowid
            WHERE coordinate.min_latitude >= ? AND coordinate.max_latitude <= ?
              AND coordinate.min_longitude >= ? AND coordinate.max_longitude <= ?
          )
        ORDER BY distance_score, random_key, id LIMIT 16`).bind(
        coordinates.latitude,
        coordinates.latitude,
        coordinates.longitude,
        coordinates.longitude,
        longitudeScale,
        longitudeScale,
        ...baseBindings,
        Math.max(-90, coordinates.latitude - latitudeRadius),
        Math.min(90, coordinates.latitude + latitudeRadius),
        Math.max(-180, coordinates.longitude - longitudeRadius),
        Math.min(180, coordinates.longitude + longitudeRadius)
      ).all<AddressPoolV2Row>();
      const rows = result.results || [];
      const candidates = rows.flatMap((row) => {
        const address = rowToAddress(row, now);
        return address ? [{ address, distanceKm: geographicDistanceKm(coordinates, address.coordinates) }] : [];
      }).filter((candidate) => candidate.distanceKm <= radiusKm);
      if (candidates.length) {
        const picked = candidates[hashSeed(`${country}:${seed}:ip-nearest`) % Math.min(8, candidates.length)];
        return { ...picked, address: await enrichPickedAddress(db, picked.address) };
      }
    }
    return undefined;
  } catch (error) {
    if (missingSchema(error)) return undefined;
    throw error;
  }
};

export const pickAddressPoolV2Address = async (
  db: SqliteDatabase | undefined,
  country: CountryCode,
  residential: boolean,
  filters: AddressFilters,
  target: CatalogTarget | undefined,
  seed: string,
  now = new Date()
): Promise<VerifiedAddress | undefined> => {
  if (!db) return undefined;
  const clauses = ['country_code = ?', 'active = 1', 'quality_score >= 0.7', completenessClause(), '(expires_at IS NULL OR (datetime(expires_at) IS NOT NULL AND datetime(expires_at) > datetime(?)))'];
  const bindings: unknown[] = [country, now.toISOString()];
  if (residential) clauses.push(`property_type IN ('residential','apartment')`);

  const regionClause = aliasClause(
    ['admin1_key', 'admin1_code_key'],
    aliases([filters.region, target?.region, target?.regionNative, target?.regionCode, ...target?.regionAliases || []]),
    bindings
  );
  if ((filters.region || target?.region) && regionClause) clauses.push(regionClause);
  const cityClause = aliasClause(
    ['locality_key', 'postal_locality_key'],
    aliases([filters.city, target?.city, target?.cityNative, ...target?.cityAliases || []]),
    bindings
  );
  if ((filters.city || target?.city) && cityClause) clauses.push(cityClause);
  const selectedPostcode = filters.postcode || target?.postcode;
  if (selectedPostcode) {
    clauses.push('postcode_key = ?');
    bindings.push(normalize(selectedPostcode).replace(/\s/gu, ''));
  }
  if (filters.q?.trim()) {
    clauses.push(`LOWER(house_number || ' ' || street || ' ' || locality || ' ' || postal_locality || ' ' || admin1 || ' ' || postcode) LIKE ? ESCAPE '\\'`);
    bindings.push(`%${normalize(filters.q).replace(/[\\%_]/g, '\\$&')}%`);
  }

  const pivot = hashSeed(`${country}:${seed}:address-pool-v2`) & 0x7fffffff;
  const candidateLimit = residential ? 16 : 64;
  try {
    const select = `SELECT id FROM address_pool WHERE ${clauses.join(' AND ')}${residential ? ` AND ${residentialEvidenceClause}` : ''}`;
    const pickEligible = async (sql: string, values: unknown[]): Promise<VerifiedAddress | undefined> => {
      const identifiers = (await db.prepare(sql).bind(...values).all<{ id: string }>()).results || [];
      if (!identifiers.length) return undefined;
      const ids = identifiers.map(({ id }) => id);
      const placeholders = ids.map(() => '?').join(',');
      const rows = (await db.prepare(`SELECT * FROM address_pool_runtime WHERE id IN (${placeholders})`)
        .bind(...ids).all<AddressPoolV2Row>()).results || [];
      const byId = new Map(rows.map((row) => [row.id, row]));
      for (const { id } of identifiers) {
        const row = byId.get(id);
        const address = row ? rowToAddress(row, now) : undefined;
        if (address) return enrichPickedAddress(db, address);
      }
      return undefined;
    };
    return await pickEligible(`${select} AND random_key >= ? ORDER BY random_key, id LIMIT ${candidateLimit}`, [...bindings, pivot])
      || await pickEligible(`${select} ORDER BY random_key, id LIMIT ${candidateLimit}`, bindings);
  } catch (error) {
    if (missingSchema(error)) return undefined;
    throw error;
  }
};
