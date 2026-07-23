import type { CountryCode, LocationOption } from '../../../src/domain/types';
import type { SqliteDatabase } from '../../database/sqlite.mjs';

export type CatalogField = 'region' | 'city' | 'postcode';

export interface CatalogQuery {
  country: CountryCode;
  field: CatalogField;
  query?: string;
  regionId?: string;
  cityId?: string;
  residential?: boolean;
  cursor?: string;
  limit?: number;
}

export interface CatalogPage {
  options: LocationOption[];
  total: number;
  nextCursor?: string;
  source: 'sqlite';
}

interface RegionRow {
  id: number;
  parent_id: number | null;
  code: string;
  name: string;
  native_name: string;
  zh_name: string;
}

interface CityRow {
  id: number;
  region_id: number | null;
  name: string;
  native_name: string;
  zh_name: string;
  region_name: string | null;
  region_native_name: string | null;
  region_zh_name: string | null;
  region_code: string | null;
}

interface PostcodeRow {
  id: number;
  city_id: number | null;
  code: string;
  locality_name: string;
  city_name: string | null;
  city_native_name: string | null;
  city_zh_name: string | null;
  region_id: number | null;
  region_name: string | null;
  region_native_name: string | null;
  region_zh_name: string | null;
  region_code: string | null;
}

const PAGE_SIZE = 100;
const normalizeLimit = (value = PAGE_SIZE, maximum = 200): number => {
  const parsed = Number.isFinite(value) ? Math.trunc(value) : PAGE_SIZE;
  return Math.max(20, Math.min(maximum, parsed));
};
const normalizeOffset = (cursor?: string): number => Math.max(0, Number.parseInt(cursor || '0', 10) || 0);
const searchPattern = (query?: string): string => `%${(query || '').trim().toLocaleLowerCase().replace(/[\\%_]/g, '\\$&')}%`;

const page = <T,>(rows: T[], total: number, offset: number): { rows: T[]; nextCursor?: string } => ({
  rows,
  nextCursor: offset + rows.length < total ? String(offset + rows.length) : undefined
});

const regionLabel = (row: RegionRow, country: CountryCode): string => {
  if (country === 'CN') return row.zh_name;
  const abbreviation = row.code && ['US', 'CA', 'AU', 'BR', 'IN', 'MX', 'NG'].includes(country) ? `（${row.code}）` : '';
  const translated = row.zh_name && row.zh_name !== row.name ? row.zh_name : '';
  return `${row.name}${abbreviation}${translated ? ` ${translated}` : ''}`;
};

const cityLabel = (row: CityRow, country: CountryCode): string => {
  if (['CN', 'HK', 'TW'].includes(country)) return row.native_name || row.zh_name || row.name;
  const seen = new Set<string>();
  return [row.native_name, row.name, row.zh_name].filter((value) => {
    const key = value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase().trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).join(' · ');
};

const queryRegions = async (db: SqliteDatabase, input: CatalogQuery, limit: number, offset: number): Promise<CatalogPage> => {
  const pattern = searchPattern(input.query);
  const residentialJoin = input.residential
    ? `AND EXISTS (SELECT 1 FROM residential_coverage rc WHERE rc.country_code = r.country_code AND (rc.region_id = r.id OR rc.region_name = r.name OR rc.region_name = r.native_name))`
    : '';
  const where = `r.country_code = ? AND (LOWER(r.name) LIKE ? ESCAPE '\\' OR LOWER(r.native_name) LIKE ? ESCAPE '\\' OR LOWER(r.zh_name) LIKE ? ESCAPE '\\' OR LOWER(r.code) LIKE ? ESCAPE '\\') ${residentialJoin}`;
  const bindings = [input.country, pattern, pattern, pattern, pattern];
  const count = await db.prepare(`SELECT COUNT(*) AS total FROM catalog_regions r WHERE ${where}`).bind(...bindings).first<{ total: number }>();
  const result = await db.prepare(`SELECT r.id, r.parent_id, r.code, r.name, r.native_name, r.zh_name FROM catalog_regions r WHERE ${where} ORDER BY CASE WHEN r.parent_id IS NULL THEN 0 ELSE 1 END, r.name LIMIT ? OFFSET ?`)
    .bind(...bindings, limit, offset).all<RegionRow>();
  const total = Number(count?.total || 0);
  const current = page(result.results || [], total, offset);
  return {
    options: current.rows.map((row) => ({ value: row.name, label: regionLabel(row, input.country), id: String(row.id), parentId: row.parent_id == null ? undefined : String(row.parent_id), native: row.native_name, en: row.name, zhCN: row.zh_name })),
    total,
    nextCursor: current.nextCursor,
    source: 'sqlite'
  };
};

const regionScope = (regionId?: string): { sql: string; bindings: number[] } => {
  const id = Number.parseInt(regionId || '', 10);
  if (!Number.isFinite(id)) return { sql: '', bindings: [] };
  return {
    sql: `AND c.region_id IN (SELECT child.id FROM catalog_regions selected JOIN catalog_regions child ON child.path LIKE selected.path || '%' WHERE selected.id = ?)`,
    bindings: [id]
  };
};

const queryCities = async (db: SqliteDatabase, input: CatalogQuery, limit: number, offset: number): Promise<CatalogPage> => {
  const pattern = searchPattern(input.query);
  const scope = regionScope(input.regionId);
  const residentialJoin = input.residential
    ? `AND EXISTS (
        SELECT 1 FROM residential_coverage rc LEFT JOIN catalog_regions rr ON rr.id = c.region_id
        WHERE rc.country_code = c.country_code
          AND (rc.city_id = c.id OR (rc.city_id IS NULL AND (
            LOWER(rc.city_name) IN (LOWER(c.name), LOWER(c.native_name))
            OR LOWER(REPLACE(c.name, ' City', '')) = LOWER(REPLACE(rc.city_name, ' City', ''))
            OR LOWER(REPLACE(c.native_name, ' City', '')) = LOWER(REPLACE(rc.city_name, ' City', ''))
            OR LOWER(REPLACE(c.name, 'City of ', '')) = LOWER(REPLACE(rc.city_name, 'City of ', ''))
          )))
          AND (rc.city_id = c.id OR rc.region_name = '' OR rc.region_id = c.region_id OR rc.region_name IN (rr.name, rr.native_name))
      )`
    : '';
  const where = `c.country_code = ? ${scope.sql} AND (LOWER(c.name) LIKE ? ESCAPE '\\' OR LOWER(c.native_name) LIKE ? ESCAPE '\\' OR LOWER(c.zh_name) LIKE ? ESCAPE '\\') ${residentialJoin}`;
  const bindings = [input.country, ...scope.bindings, pattern, pattern, pattern];
  const count = await db.prepare(`SELECT COUNT(*) AS total FROM catalog_cities c WHERE ${where}`).bind(...bindings).first<{ total: number }>();
  const result = await db.prepare(`SELECT c.id, c.region_id, c.name, c.native_name, c.zh_name,
    r.name AS region_name, r.native_name AS region_native_name, r.zh_name AS region_zh_name, r.code AS region_code
    FROM catalog_cities c LEFT JOIN catalog_regions r ON r.id = c.region_id
    WHERE ${where} ORDER BY COALESCE(c.population, 0) DESC, c.name LIMIT ? OFFSET ?`)
    .bind(...bindings, limit, offset).all<CityRow>();
  const total = Number(count?.total || 0);
  const current = page(result.results || [], total, offset);
  return {
    options: current.rows.map((row) => ({
      value: row.name,
      label: cityLabel(row, input.country),
      id: String(row.id),
      parentId: row.region_id == null ? undefined : String(row.region_id),
      parentValue: row.region_name || undefined,
      parentLabel: row.region_name ? regionLabel({
        id: row.region_id || 0,
        parent_id: null,
        code: row.region_code || '',
        name: row.region_name,
        native_name: row.region_native_name || row.region_name,
        zh_name: row.region_zh_name || row.region_name
      }, input.country) : undefined,
      regionId: row.region_id == null ? undefined : String(row.region_id),
      regionValue: row.region_name || undefined,
      regionCode: row.region_code || undefined,
      native: row.native_name,
      en: row.name,
      zhCN: row.zh_name
    })),
    total,
    nextCursor: current.nextCursor,
    source: 'sqlite'
  };
};

const queryPostcodes = async (db: SqliteDatabase, input: CatalogQuery, limit: number, offset: number): Promise<CatalogPage> => {
  const pattern = searchPattern(input.query);
  const cityId = Number.parseInt(input.cityId || '', 10);
  const regionId = Number.parseInt(input.regionId || '', 10);
  const parentSql = Number.isFinite(cityId)
    ? `AND (p.city_id = ? OR LOWER(p.locality_name) IN (
        SELECT LOWER(name) FROM catalog_cities WHERE id = ?
        UNION SELECT LOWER(native_name) FROM catalog_cities WHERE id = ?
      ))`
    : Number.isFinite(regionId)
      ? `AND COALESCE(p.region_id, c.region_id) IN (SELECT child.id FROM catalog_regions selected JOIN catalog_regions child ON child.path LIKE selected.path || '%' WHERE selected.id = ?)`
      : '';
  const parentBindings = Number.isFinite(cityId) ? [cityId, cityId, cityId] : Number.isFinite(regionId) ? [regionId] : [];
  const where = `p.country_code = ? ${parentSql} AND (LOWER(p.code) LIKE ? ESCAPE '\\' OR LOWER(p.locality_name) LIKE ? ESCAPE '\\')`;
  const bindings = [input.country, ...parentBindings, pattern, pattern];
  const count = await db.prepare(`SELECT COUNT(DISTINCT p.code) AS total FROM catalog_postcodes p LEFT JOIN catalog_cities c ON c.id = p.city_id WHERE ${where}`).bind(...bindings).first<{ total: number }>();
  const result = await db.prepare(`SELECT MIN(p.id) AS id, MAX(p.city_id) AS city_id, p.code,
    MAX(p.locality_name) AS locality_name, MAX(c.name) AS city_name, MAX(c.native_name) AS city_native_name,
    MAX(c.zh_name) AS city_zh_name, MAX(COALESCE(p.region_id, c.region_id)) AS region_id,
    MAX(r.name) AS region_name, MAX(r.native_name) AS region_native_name, MAX(r.zh_name) AS region_zh_name,
    MAX(r.code) AS region_code
    FROM catalog_postcodes p
    LEFT JOIN catalog_cities c ON c.id = p.city_id
    LEFT JOIN catalog_regions r ON r.id = COALESCE(p.region_id, c.region_id)
    WHERE ${where} GROUP BY p.code ORDER BY p.code LIMIT ? OFFSET ?`)
    .bind(...bindings, limit, offset).all<PostcodeRow>();
  const total = Number(count?.total || 0);
  const current = page(result.results || [], total, offset);
  return {
    options: current.rows.map((row) => ({
      value: row.code,
      label: [row.code, row.locality_name, row.region_name].filter(Boolean).join(' · '),
      id: String(row.id),
      parentId: row.city_id == null ? undefined : String(row.city_id),
      parentValue: row.city_name || row.locality_name || undefined,
      parentLabel: row.city_name || row.locality_name || undefined,
      regionId: row.region_id == null ? undefined : String(row.region_id),
      regionValue: row.region_name || undefined,
      regionLabel: row.region_name ? regionLabel({
        id: row.region_id || 0,
        parent_id: null,
        code: row.region_code || '',
        name: row.region_name,
        native_name: row.region_native_name || row.region_name,
        zh_name: row.region_zh_name || row.region_name
      }, input.country) : undefined,
      regionCode: row.region_code || undefined
    })),
    total,
    nextCursor: current.nextCursor,
    source: 'sqlite'
  };
};

export const queryLocationCatalog = async (db: SqliteDatabase, input: CatalogQuery): Promise<CatalogPage> => {
  const limit = normalizeLimit(input.limit, input.field === 'city' ? 20_000 : 200);
  const offset = normalizeOffset(input.cursor);
  if (input.field === 'region') return queryRegions(db, input, limit, offset);
  if (input.field === 'city') return queryCities(db, input, limit, offset);
  return queryPostcodes(db, input, limit, offset);
};

export const recordResidentialCoverage = async (
  db: SqliteDatabase | undefined,
  country: CountryCode,
  region: string | undefined,
  city: string | undefined,
  coordinates?: { latitude: number; longitude: number }
): Promise<void> => {
  if (!db) return;
  const now = new Date().toISOString();
  const cityName = city || '';
  let catalogLocation = await db.prepare(`SELECT c.id AS city_id, c.region_id
    FROM catalog_cities c LEFT JOIN catalog_regions r ON r.id = c.region_id
    WHERE c.country_code = ? AND (
      LOWER(c.name) = LOWER(?) OR LOWER(c.native_name) = LOWER(?) OR LOWER(c.zh_name) = LOWER(?)
      OR LOWER(REPLACE(c.name, ' City', '')) = LOWER(REPLACE(?, ' City', ''))
      OR LOWER(REPLACE(c.name, 'City of ', '')) = LOWER(REPLACE(?, 'City of ', ''))
    )
    ORDER BY CASE WHEN ? IN (r.name, r.native_name, r.zh_name) THEN 0 ELSE 1 END, COALESCE(c.population, 0) DESC LIMIT 1`)
    .bind(country, cityName, cityName, cityName, cityName, cityName, region || '').first<{ city_id: number; region_id: number | null }>();
  if (!catalogLocation && coordinates) {
    catalogLocation = await db.prepare(`SELECT id AS city_id, region_id FROM catalog_cities
      WHERE country_code = ? AND latitude IS NOT NULL AND longitude IS NOT NULL
      ORDER BY ((latitude - ?) * (latitude - ?)) + ((longitude - ?) * (longitude - ?)) LIMIT 1`)
      .bind(country, coordinates.latitude, coordinates.latitude, coordinates.longitude, coordinates.longitude)
      .first<{ city_id: number; region_id: number | null }>();
  }
  await db.prepare(`INSERT INTO residential_coverage(country_code, region_name, city_name, address_count, last_verified_at, region_id, city_id)
    VALUES (?, ?, ?, 1, ?, ?, ?)
    ON CONFLICT(country_code, region_name, city_name) DO UPDATE SET
      address_count = address_count + 1,
      last_verified_at = excluded.last_verified_at,
      region_id = COALESCE(excluded.region_id, residential_coverage.region_id),
      city_id = COALESCE(excluded.city_id, residential_coverage.city_id)`)
    .bind(country, region || '', cityName, now, catalogLocation?.region_id || null, catalogLocation?.city_id || null).run();
};
