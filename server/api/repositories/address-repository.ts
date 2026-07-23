import { hashSeed } from '../../../src/domain/generator';
import { Converter as createSimplifier } from 'opencc-js/t2cn';
import { Converter as createTraditionalizer } from 'opencc-js/cn2t';
import type { SqliteDatabase } from '../../database/sqlite.mjs';
import type { VerifiedAddress } from '../../../src/domain/types';

const toSimplifiedHan = createSimplifier({ from: 'hk', to: 'cn' });
const toTraditionalHan = createTraditionalizer({ from: 'cn', to: 'tw' });
const hanScript = /\p{Script=Han}/u;
const adminSuffix = /(?:自治区|自治區|特别行政区|特別行政區|省|市|縣|县|区|區)$/u;
// Distinct Han script/suffix variants of a place name for cross-script catalog matching.
const hanVariants = (value: string | undefined): string[] => {
  const trimmed = String(value || '').trim();
  if (!trimmed || !hanScript.test(trimmed)) return trimmed ? [trimmed] : [];
  const base = [...new Set([trimmed, toSimplifiedHan(trimmed), toTraditionalHan(trimmed)])];
  return [...new Set(base.flatMap((variant) => {
    const stem = variant.replace(adminSuffix, '');
    return stem && stem !== variant ? [variant, stem] : [variant];
  }))];
};

export interface AddressFilters {
  q?: string;
  region?: string;
  regionId?: string;
  city?: string;
  cityId?: string;
  postcode?: string;
  postcodeId?: string;
}

export interface CatalogTarget {
  coordinates: { latitude: number; longitude: number };
  regionId?: number;
  region?: string;
  regionNative?: string;
  regionCode?: string;
  regionAliases: string[];
  cityId?: number;
  city?: string;
  cityNative?: string;
  cityAliases: string[];
  postcodeId?: number;
  postcode?: string;
  bucket: string;
}

export interface NearestCatalogTarget {
  target: CatalogTarget;
  distanceKm: number;
  matchLevel: 'city' | 'region';
}

interface TargetRow {
  id: number;
  region_id: number | null;
  city_id: number | null;
  postcode: string | null;
  city_name: string | null;
  city_native: string | null;
  city_zh: string | null;
  region_name: string | null;
  region_native: string | null;
  region_zh: string | null;
  region_code: string | null;
  latitude: number | null;
  longitude: number | null;
}

const normalize = (value: string | undefined): string => (value || '')
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLocaleLowerCase()
  .replace(/\s+/g, ' ')
  .trim();

const equal = (left: string | undefined, right: string | undefined): boolean =>
  !right || normalize(left) === normalize(right);

const matchesOne = (value: string | undefined, expected: string[]): boolean => {
  const normalized = normalize(value);
  return expected.some((item) => normalize(item) === normalized);
};

const matchesAny = (values: Array<string | undefined>, expected: string[]): boolean =>
  values.some((value) => matchesOne(value, expected));

const containsQuery = (address: VerifiedAddress, query: string | undefined): boolean => {
  if (!query) return true;
  const haystack = [
    address.components.street,
    address.components.locality,
    address.components.admin1,
    address.components.postcode,
    address.addressVariants.native,
    address.addressVariants.en,
    address.addressVariants['zh-CN']
  ].map(normalize).join(' ');
  return normalize(query).split(' ').every((term) => haystack.includes(term));
};

export const filterCandidates = (
  candidates: VerifiedAddress[],
  filters: AddressFilters,
  target?: CatalogTarget
): VerifiedAddress[] => candidates.filter((address) =>
  containsQuery(address, filters.q)
  && (filters.region && target
    ? matchesAny([address.components.admin1, address.components.admin1Code], [...target.regionAliases, filters.region])
    : !filters.region || matchesAny([address.components.admin1, address.components.admin1Code], [filters.region]))
  && (filters.city && target
    ? matchesAny([
        address.components.locality,
        address.components.postalLocality,
        address.components.dependentLocality,
        address.components.district
      ], [...target.cityAliases, filters.city])
    : !filters.city || matchesAny([
        address.components.locality,
        address.components.postalLocality,
        address.components.dependentLocality,
        address.components.district
      ], [filters.city]))
  && equal(address.components.postcode.replace(/\s/g, ''), filters.postcode?.replace(/\s/g, ''))
);

const aliases = (...values: Array<string | null | undefined>): string[] => [...new Set(values.filter((value): value is string => Boolean(value)))];
const cityAliases = (...values: Array<string | null | undefined>): string[] => {
  const result = aliases(...values);
  return aliases(...result, ...result.map((value) => value.replace(/\s+City$/i, '').replace(/^City of\s+/i, '')));
};

const toTarget = (row: TargetRow, kind: string): CatalogTarget | undefined => {
  if (row.latitude == null || row.longitude == null) return undefined;
  return {
    coordinates: { latitude: row.latitude, longitude: row.longitude },
    regionId: row.region_id || undefined,
    region: row.region_name || undefined,
    regionNative: row.region_native || undefined,
    regionCode: row.region_code || undefined,
    regionAliases: aliases(row.region_name, row.region_native, row.region_zh, row.region_code),
    cityId: row.city_id || undefined,
    city: row.city_name || undefined,
    cityNative: row.city_native || undefined,
    cityAliases: cityAliases(row.city_name, row.city_native, row.city_zh),
    postcodeId: kind === 'postcode' ? row.id : undefined,
    postcode: row.postcode || undefined,
    bucket: `${kind}-${row.id}`
  };
};

const catalogId = (value: string | undefined): number | undefined => {
  if (!value || !/^\d+$/u.test(value)) return undefined;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
};

const findRegion = async (
  db: SqliteDatabase,
  country: string,
  value: string | undefined,
  stableId: number | undefined
): Promise<number | undefined> => {
  if (stableId !== undefined) {
    const row = await db.prepare('SELECT r.id FROM catalog_regions r WHERE r.country_code = ? AND r.id = ? LIMIT 1')
      .bind(country, stableId).first<{ id: number }>();
    return row?.id;
  }
  if (!value) return undefined;
  const variants = hanVariants(value);
  const lowered = [...new Set([value, ...variants].map((entry) => entry.toLowerCase()))];
  const placeholders = lowered.map(() => '?').join(',');
  const row = await db.prepare(`SELECT r.id FROM catalog_regions r WHERE r.country_code = ?
    AND (LOWER(r.name) IN (${placeholders}) OR LOWER(r.native_name) IN (${placeholders})
      OR LOWER(r.zh_name) IN (${placeholders}) OR LOWER(r.code) IN (${placeholders}))
    ORDER BY CASE WHEN r.parent_id IS NULL THEN 0 ELSE 1 END, r.id LIMIT 1`)
    .bind(country, ...lowered, ...lowered, ...lowered, ...lowered).first<{ id: number }>();
  return row?.id;
};

interface CityIdentity { id: number; region_id: number | null }

const findCity = async (
  db: SqliteDatabase,
  country: string,
  value: string | undefined,
  regionId: number | undefined,
  stableId: number | undefined
): Promise<CityIdentity | undefined> => {
  const regionScope = regionId === undefined ? '' : `AND c.region_id IN (
    SELECT child.id FROM catalog_regions selected JOIN catalog_regions child ON child.path LIKE selected.path || '%' WHERE selected.id = ?
  )`;
  if (stableId !== undefined) {
    const bindings = regionId === undefined ? [country, stableId] : [country, stableId, regionId];
    return await db.prepare(`SELECT c.id, c.region_id FROM catalog_cities c
      WHERE c.country_code = ? AND c.id = ? ${regionScope} LIMIT 1`)
      .bind(...bindings).first<CityIdentity>() || undefined;
  }
  if (!value) return undefined;
  const variants = [...new Set([value, ...hanVariants(value)].map((entry) => entry.toLowerCase()))];
  const placeholders = variants.map(() => '?').join(',');
  const nameMatch = `(LOWER(c.name) IN (${placeholders}) OR LOWER(c.native_name) IN (${placeholders})
    OR LOWER(c.zh_name) IN (${placeholders})
    OR LOWER(REPLACE(c.name, ' City', '')) = LOWER(REPLACE(?, ' City', ''))
    OR LOWER(REPLACE(c.name, 'City of ', '')) = LOWER(REPLACE(?, 'City of ', '')))`;
  const bindings = regionId === undefined
    ? [country, ...variants, ...variants, ...variants, value, value]
    : [country, ...variants, ...variants, ...variants, value, value, regionId];
  return await db.prepare(`SELECT c.id, c.region_id FROM catalog_cities c WHERE c.country_code = ? AND ${nameMatch} ${regionScope}
    ORDER BY COALESCE(c.population, 0) DESC, c.id LIMIT 1`).bind(...bindings).first<CityIdentity>() || undefined;
};

const selectAtOffset = async (
  db: SqliteDatabase,
  countSql: string,
  selectSql: string,
  bindings: unknown[],
  seed: string
): Promise<TargetRow | undefined> => {
  const count = await db.prepare(countSql).bind(...bindings).first<{ total: number }>();
  const total = Number(count?.total || 0);
  if (!total) return undefined;
  const offset = hashSeed(seed) % total;
  return await db.prepare(`${selectSql} LIMIT 1 OFFSET ?`).bind(...bindings, offset).first<TargetRow>() || undefined;
};

const targetColumns = `c.id, c.region_id, c.id AS city_id, NULL AS postcode,
  c.name AS city_name, c.native_name AS city_native, c.zh_name AS city_zh,
  r.name AS region_name, r.native_name AS region_native, r.zh_name AS region_zh, r.code AS region_code,
  COALESCE(c.latitude, r.latitude) AS latitude, COALESCE(c.longitude, r.longitude) AS longitude`;

const distanceKm = (
  left: { latitude: number; longitude: number },
  right: { latitude: number; longitude: number }
): number => {
  const radians = Math.PI / 180;
  const latitudeDelta = (right.latitude - left.latitude) * radians;
  const longitudeDelta = (right.longitude - left.longitude) * radians;
  const a = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(left.latitude * radians) * Math.cos(right.latitude * radians) * Math.sin(longitudeDelta / 2) ** 2;
  const bounded = Math.min(1, Math.max(0, a));
  return 6371 * 2 * Math.atan2(Math.sqrt(bounded), Math.sqrt(1 - bounded));
};

export const resolveNearestCatalogTarget = async (
  db: SqliteDatabase,
  country: string,
  coordinates: { latitude: number; longitude: number }
): Promise<NearestCatalogTarget | undefined> => {
  const longitudeScale = Math.max(0.1, Math.cos(coordinates.latitude * Math.PI / 180));
  const citySql = `SELECT ${targetColumns},
    ((c.latitude - ?) * (c.latitude - ?)) +
    ((c.longitude - ?) * (c.longitude - ?) * ? * ?) AS distance_score
    FROM catalog_cities c LEFT JOIN catalog_regions r ON r.id = c.region_id
    WHERE c.country_code = ? AND c.latitude BETWEEN ? AND ? AND c.longitude BETWEEN ? AND ?
    ORDER BY distance_score, COALESCE(c.population, 0) DESC, c.id LIMIT 1`;
  for (const radius of [0.5, 2, 8, 180]) {
    const longitudeRadius = Math.min(180, radius / longitudeScale);
    const row = await db.prepare(citySql).bind(
      coordinates.latitude,
      coordinates.latitude,
      coordinates.longitude,
      coordinates.longitude,
      longitudeScale,
      longitudeScale,
      country,
      Math.max(-90, coordinates.latitude - radius),
      Math.min(90, coordinates.latitude + radius),
      Math.max(-180, coordinates.longitude - longitudeRadius),
      Math.min(180, coordinates.longitude + longitudeRadius)
    ).first<TargetRow>();
    const target = row ? toTarget(row, 'city') : undefined;
    if (target) return { target, distanceKm: distanceKm(coordinates, target.coordinates), matchLevel: 'city' };
  }

  const row = await db.prepare(`SELECT r.id, r.id AS region_id, NULL AS city_id, NULL AS postcode,
    NULL AS city_name, NULL AS city_native, NULL AS city_zh,
    r.name AS region_name, r.native_name AS region_native, r.zh_name AS region_zh, r.code AS region_code,
    r.latitude, r.longitude,
    ((r.latitude - ?) * (r.latitude - ?)) +
    ((r.longitude - ?) * (r.longitude - ?) * ? * ?) AS distance_score
    FROM catalog_regions r
    WHERE r.country_code = ? AND r.latitude IS NOT NULL AND r.longitude IS NOT NULL
    ORDER BY distance_score, r.id LIMIT 1`).bind(
    coordinates.latitude,
    coordinates.latitude,
    coordinates.longitude,
    coordinates.longitude,
    longitudeScale,
    longitudeScale,
    country
  ).first<TargetRow>();
  const target = row ? toTarget(row, 'region') : undefined;
  return target ? { target, distanceKm: distanceKm(coordinates, target.coordinates), matchLevel: 'region' } : undefined;
};

export const resolveCatalogTarget = async (
  db: SqliteDatabase,
  country: string,
  filters: AddressFilters,
  seed: string
): Promise<CatalogTarget | undefined> => {
  const requestedRegionId = catalogId(filters.regionId);
  const requestedCityId = catalogId(filters.cityId);
  const requestedPostcodeId = catalogId(filters.postcodeId);
  if ((filters.regionId && requestedRegionId === undefined)
    || (filters.cityId && requestedCityId === undefined)
    || (filters.postcodeId && requestedPostcodeId === undefined)) return undefined;

  let regionId = filters.region || requestedRegionId !== undefined
    ? await findRegion(db, country, filters.region, requestedRegionId)
    : undefined;
  if ((filters.region || requestedRegionId !== undefined) && regionId === undefined) return undefined;
  const cityIdentity = filters.city || requestedCityId !== undefined
    ? await findCity(db, country, filters.city, regionId, requestedCityId)
    : undefined;
  if ((filters.city || requestedCityId !== undefined) && !cityIdentity) return undefined;
  const cityId = cityIdentity?.id;
  regionId ??= cityIdentity?.region_id || undefined;

  if (filters.postcode || requestedPostcodeId !== undefined) {
    const scopes: string[] = ['p.country_code = ?'];
    const bindings: unknown[] = [country];
    if (requestedPostcodeId !== undefined) {
      scopes.push('p.id = ?');
      bindings.push(requestedPostcodeId);
    } else {
      scopes.push(`LOWER(REPLACE(p.code, ' ', '')) = LOWER(?)`);
      bindings.push(filters.postcode!.replace(/\s/g, ''));
    }
    if (cityId !== undefined) {
      scopes.push(`(p.city_id = ? OR LOWER(p.locality_name) IN (
        SELECT LOWER(name) FROM catalog_cities WHERE id = ?
        UNION SELECT LOWER(native_name) FROM catalog_cities WHERE id = ?
      ))`);
      bindings.push(cityId, cityId, cityId);
    }
    if (regionId !== undefined) {
      scopes.push(`p.region_id IN (SELECT child.id FROM catalog_regions selected JOIN catalog_regions child ON child.path LIKE selected.path || '%' WHERE selected.id = ?)`);
      bindings.push(regionId);
    }
    const where = scopes.join(' AND ');
    const columns = `p.id, COALESCE(p.region_id, c.region_id) AS region_id, p.city_id, p.code AS postcode,
      COALESCE(c.name, p.locality_name) AS city_name, c.native_name AS city_native, c.zh_name AS city_zh,
      r.name AS region_name, r.native_name AS region_native, r.zh_name AS region_zh, r.code AS region_code,
      COALESCE(p.latitude, c.latitude, r.latitude) AS latitude, COALESCE(p.longitude, c.longitude, r.longitude) AS longitude`;
    const from = `FROM catalog_postcodes p LEFT JOIN catalog_cities c ON c.id = p.city_id LEFT JOIN catalog_regions r ON r.id = COALESCE(p.region_id, c.region_id) WHERE ${where}`;
    const row = requestedPostcodeId !== undefined
      ? await db.prepare(`SELECT ${columns} ${from} LIMIT 1`).bind(...bindings).first<TargetRow>()
      : await selectAtOffset(
        db,
        `SELECT COUNT(*) AS total ${from}`,
        `SELECT ${columns} ${from} ORDER BY p.id`,
        bindings,
        `${country}:${seed}:postcode`
      );
    return row ? toTarget(row, 'postcode') : undefined;
  }

  if (cityId !== undefined) {
    const row = await db.prepare(`SELECT ${targetColumns} FROM catalog_cities c LEFT JOIN catalog_regions r ON r.id = c.region_id
      WHERE c.id = ? AND COALESCE(c.latitude, r.latitude) IS NOT NULL AND COALESCE(c.longitude, r.longitude) IS NOT NULL LIMIT 1`)
      .bind(cityId).first<TargetRow>();
    return row ? toTarget(row, 'city') : undefined;
  }

  if (regionId !== undefined) {
    const row = await db.prepare(`SELECT r.id, r.id AS region_id, NULL AS city_id, NULL AS postcode,
      NULL AS city_name, NULL AS city_native, NULL AS city_zh,
      r.name AS region_name, r.native_name AS region_native, r.zh_name AS region_zh, r.code AS region_code,
      r.latitude, r.longitude FROM catalog_regions r
      WHERE r.id = ? AND r.latitude IS NOT NULL AND r.longitude IS NOT NULL LIMIT 1`)
      .bind(regionId).first<TargetRow>();
    return row ? toTarget(row, 'region') : undefined;
  }

  const where = `c.country_code = ? AND COALESCE(c.population, 0) >= 5000 AND c.latitude IS NOT NULL AND c.longitude IS NOT NULL`;
  const row = await selectAtOffset(
    db,
    `SELECT COUNT(*) AS total FROM catalog_cities c WHERE ${where}`,
    `SELECT ${targetColumns} FROM catalog_cities c LEFT JOIN catalog_regions r ON r.id = c.region_id WHERE ${where} ORDER BY c.id`,
    [country],
    `${country}:${seed}:city`
  );
  if (!row) return undefined;
  return toTarget(row, 'city');
};

export const orderedCandidate = (
  candidates: VerifiedAddress[],
  seed: string,
  attempt: number
): VerifiedAddress => candidates[(hashSeed(seed) + attempt) % candidates.length];
