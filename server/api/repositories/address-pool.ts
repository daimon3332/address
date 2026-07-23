import { hashSeed } from '../../../src/domain/generator';
import type { SqliteDatabase } from '../../database/sqlite.mjs';
import {
  normalizeAddressComponents,
  validateAdministrativeHierarchy
} from '../../../src/domain/administrative-integrity.mjs';
import { findNonResidentialMatch } from '../../../src/domain/non-residential.mjs';
import type { AddressComponents, AddressEvidence, CountryCode, PropertyType, VerifiedAddress } from '../../../src/domain/types';
import type { AddressFilters, CatalogTarget } from './address-repository';

interface AddressPoolRow {
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
  property_type: string;
  source_id: string;
  source_name: string;
  source_url: string;
  source_record_id: string;
  source_updated_at: string | null;
  imported_at: string;
}

const propertyTypes = new Set<PropertyType>(['residential', 'apartment', 'commercial', 'mixed', 'unknown']);
const normalizedAliases = (values: Array<string | undefined>): string[] => [...new Set(values
  .map((value) => value?.normalize('NFKC').trim().toLocaleLowerCase())
  .filter((value): value is string => Boolean(value)))];

const aliasClause = (columns: string[], values: string[], bindings: unknown[]): string | undefined => {
  if (!values.length) return undefined;
  const placeholders = values.map(() => '?').join(',');
  return `(${columns.map((column) => {
    bindings.push(...values);
    return `LOWER(${column}) IN (${placeholders})`;
  }).join(' OR ')})`;
};

const rowToAddress = (row: AddressPoolRow, now: Date): VerifiedAddress | undefined => {
  if (!validateAdministrativeHierarchy({
    countryCode: row.country_code, admin1: row.admin1, admin1Code: row.admin1_code
  }).valid) return undefined;
  const components: AddressComponents = normalizeAddressComponents(row.country_code, {
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
  const sourceUpdatedAt = row.source_updated_at || row.imported_at;
  const formatted = [row.house_number, row.street, components.postalLocality || components.locality, row.admin1_code || row.admin1, row.postcode]
    .filter(Boolean).join(', ');
  const expiresAt = new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000).toISOString();
  const propertyType = propertyTypes.has(row.property_type as PropertyType)
    ? row.property_type as PropertyType
    : 'unknown';
  if (findNonResidentialMatch({
    countryCode: row.country_code,
    buildingName: row.building_name,
    formattedAddress: formatted,
    street: row.street,
    propertyType
  }).excluded) return undefined;
  const evidence: AddressEvidence[] = [
    {
      sourceId: row.source_id,
      sourceName: row.source_name,
      sourceUrl: row.source_url,
      sourceFamily: row.source_id,
      type: 'address_existence',
      value: formatted,
      observedAt: sourceUpdatedAt
    },
    {
      sourceId: row.source_id,
      sourceName: row.source_name,
      sourceUrl: row.source_url,
      sourceFamily: row.source_id,
      type: 'coordinate',
      value: `${row.latitude},${row.longitude}`,
      observedAt: sourceUpdatedAt
    }
  ];
  if (propertyType === 'residential' || propertyType === 'apartment') {
    evidence.push({
      sourceId: row.source_id,
      sourceName: row.source_name,
      sourceUrl: row.source_url,
      sourceFamily: row.source_id,
      type: 'residential_use',
      value: `property_type=${propertyType}`,
      observedAt: sourceUpdatedAt
    });
  }
  return {
    id: `pool-${row.id}`,
    countryCode: row.country_code,
    nativeAddress: formatted,
    formattedAddress: formatted,
    nativeLanguage: '',
    addressVariants: { native: formatted, en: formatted, 'zh-CN': formatted },
    components,
    componentVariants: { native: components, en: components, 'zh-CN': components },
    coordinates: { latitude: row.latitude, longitude: row.longitude },
    addressStatus: 'verified',
    propertyType,
    unitStatus: 'building_only',
    unitProvenance: 'none',
    matchLevel: 'premise',
    verificationLevel: 'L2',
    sourceVersion: `pool-${sourceUpdatedAt}`,
    sourceUpdatedAt,
    verifiedAt: now.toISOString(),
    expiresAt,
    evidence,
    exclusionFlags: []
  };
};

export const pickAddressPoolAddress = async (
  db: SqliteDatabase | undefined,
  country: CountryCode,
  residential: boolean,
  filters: AddressFilters,
  target: CatalogTarget | undefined,
  seed: string,
  now = new Date()
): Promise<VerifiedAddress | undefined> => {
  if (!db) return undefined;
  const clauses = ['country_code = ?'];
  const bindings: unknown[] = [country];
  if (residential) clauses.push(`property_type IN ('residential','apartment')`);

  const regionClause = aliasClause(
    ['admin1', 'admin1_code'],
    normalizedAliases([filters.region, target?.region, ...target?.regionAliases || []]),
    bindings
  );
  if ((filters.region || target?.region) && regionClause) clauses.push(regionClause);
  const cityClause = aliasClause(
    ['locality', 'postal_locality', 'district'],
    normalizedAliases([filters.city, target?.city, ...target?.cityAliases || []]),
    bindings
  );
  if ((filters.city || target?.city) && cityClause) clauses.push(cityClause);
  const selectedPostcode = filters.postcode || target?.postcode;
  if (selectedPostcode) {
    clauses.push(`LOWER(REPLACE(postcode, ' ', '')) = ?`);
    bindings.push(selectedPostcode.replace(/\s/g, '').toLocaleLowerCase());
  }
  if (filters.q?.trim()) {
    const pattern = `%${filters.q.trim().toLocaleLowerCase().replace(/[\\%_]/g, '\\$&')}%`;
    clauses.push(`LOWER(house_number || ' ' || street || ' ' || locality || ' ' || postal_locality || ' ' || admin1 || ' ' || postcode) LIKE ? ESCAPE '\\'`);
    bindings.push(pattern);
  }

  const where = clauses.join(' AND ');
  const pivot = hashSeed(`${country}:${seed}:address-pool`) & 0x7fffffff;
  const select = `SELECT * FROM address_pool WHERE ${where}`;
  try {
    const pickEligible = async (sql: string, values: unknown[]): Promise<VerifiedAddress | undefined> => {
      const result = await db.prepare(sql).bind(...values).all<AddressPoolRow>();
      return (result.results || []).map((row) => rowToAddress(row, now)).find(Boolean);
    };
    return await pickEligible(`${select} AND random_key >= ? ORDER BY random_key, id LIMIT 16`, [...bindings, pivot])
      || await pickEligible(`${select} ORDER BY random_key, id LIMIT 16`, bindings);
  } catch {
    return undefined;
  }
};
