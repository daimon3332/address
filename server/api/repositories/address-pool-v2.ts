import { createHash } from 'node:crypto';
import { hashSeed } from '../../../src/domain/generator';
import { Converter as createSimplifier } from 'opencc-js/t2cn';
import { Converter as createTraditionalizer } from 'opencc-js/cn2t';
import type { Database } from '../../database/database.mjs';
import { addressLocalizationSqlClause } from '../../database/generation-index.mjs';
import { projectAdministrativeRow } from '../../database/administrative-assignments.mjs';
import { matchesCustomBlacklist } from '../../lib/custom-blacklist.mjs';
import {
  addressQualitySqlClause,
  normalizeAddressFacts,
  validateAddressQuality
} from '../../../src/domain/address-quality.mjs';
import {
  normalizeAddressComponents,
  validateAdministrativeHierarchy
} from '../../../src/domain/administrative-integrity.mjs';
import { findNonResidentialMatch } from '../../../src/domain/non-residential.mjs';
import { taiwanEnglishPremise } from '../../../src/domain/address-format';
import { addressContracts, requiresAdminCode, validateAddressContract } from '../../../src/domain/address-contracts.mjs';
import { componentLooksLocalized, implausibleChineseTranslation, implausibleEnglishTranslation, preservesAddressIdentifiers, preservesAddressNumbers, semanticAddressFields } from '../../../src/domain/address-localization.mjs';
import type { AddressComponents, AddressEvidence, CountryCode, PropertyType, VerifiedAddress } from '../../../src/domain/types';
import type { AddressFilters, CatalogTarget, LocationScopeClause } from './address-repository';

interface AddressPoolV2Row {
  id: string;
  country_code: CountryCode;
  admin1: string;
  admin1_code: string;
  locality: string;
  postal_locality: string;
  admin1_key?: string;
  admin1_code_key?: string;
  locality_key?: string;
  postal_locality_key?: string;
  district: string;
  postcode: string;
  street: string;
  house_number: string;
  match_level?: VerifiedAddress['matchLevel'];
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
  administrative_patch_json?: string | null;
}

const propertyTypes = new Set<PropertyType>(['residential', 'apartment', 'commercial', 'mixed', 'unknown']);
const evidenceTypes = new Set<AddressEvidence['type']>(['address_existence', 'residential_use', 'coordinate', 'building_status']);
const residentialEvidenceSource = (row: AddressPoolV2Row): Pick<AddressEvidence, 'sourceId' | 'sourceName' | 'sourceUrl' | 'sourceFamily'> => {
  const source = row.source_id || '';
  const reference = source === 'overture-addresses'
    ? ['overture-buildings', 'Overture Maps buildings', 'https://docs.overturemaps.org/guides/buildings']
    : source.startsWith('google-residential-enrichment') || source.startsWith('mappls-in-residential')
      ? ['openstreetmap', 'OpenStreetMap residential buildings', 'https://www.openstreetmap.org/']
      : source === 'singapore-hdb-residential'
        ? ['hdb-property', 'HDB Property Information', 'https://data.gov.sg/collections/189/view']
        : source === 'korea-kapt-residential'
          ? ['korea-kapt', 'K-apt official apartment complexes', 'https://www.k-apt.go.kr/']
          : [source, row.source_name || '', row.record_url || row.source_url || ''];
  return { sourceId: reference[0], sourceName: reference[1], sourceUrl: reference[2], sourceFamily: reference[0] };
};

const normalize = (value: string | undefined): string => (value || '')
  .normalize('NFKC')
  .toLocaleLowerCase()
  .replace(/\s+/gu, ' ')
  .trim();

const candidateOffset = (seed: string, length: number): number => length <= 1 ? 0
  : Number(createHash('sha256').update(seed).digest().readBigUInt64BE(0) % BigInt(length));

const rankSeed = (seed: string): string => (createHash('sha256').update(seed).digest().readBigUInt64BE(0)
  & 0x7fffffffffffffffn).toString();

const rotateCandidates = <T>(values: T[], seed: string): T[] => {
  const offset = candidateOffset(seed, values.length);
  return offset ? [...values.slice(offset), ...values.slice(0, offset)] : values;
};

const toSimplifiedHan = createSimplifier({ from: 'hk', to: 'cn' });
const toTraditionalHongKong = createTraditionalizer({ from: 'cn', to: 'hk' });
const toTraditionalTaiwan = createTraditionalizer({ from: 'cn', to: 'tw' });
const hanScript = /\p{Script=Han}/u;
const nativeSemanticFields = new Set(['street', 'locality', 'postalLocality', 'district', 'dependentLocality', 'admin1', 'buildingName']);
const translatedSemanticFields = (country: CountryCode) => semanticAddressFields
  .filter((field) => field === 'street' || addressContracts[country]?.required.includes(field));
const unchangedIdentifier = /^[A-Z]{1,6}[-./ ]?\d+(?:[-./ ]?[A-Z\d]+)*$/u;
const hasHanSemanticContent = (components: AddressComponents): boolean => [...nativeSemanticFields]
  .some((field) => hanScript.test(String(components[field as keyof AddressComponents] || '')));
const adminSuffixes = ['市', '縣', '县', '区', '區', '省', '自治区', '自治區', '特别行政区', '特別行政區', '都', '道', '府', '県'];
const adminSuffixPattern = /(?:自治区|自治區|特别行政区|特別行政區|省|市|縣|县|区|區|都|道|府|県)$/u;

const valueAliases = (value: string | undefined): string[] => {
  const normalized = normalize(value);
  if (!normalized) return [];
  if (!hanScript.test(normalized)) {
    return [normalized, normalized.replace(adminSuffixPattern, '')].filter(Boolean);
  }
  // Han values match across scripts (simplified 台中 <-> traditional 臺中) and
  // across admin-suffix presence (pool stores 臺中市, catalog stores 台中).
  const scriptVariants = [...new Set([
    normalized,
    toSimplifiedHan(normalized),
    toTraditionalHongKong(normalized),
    toTraditionalTaiwan(normalized)
  ])];
  return scriptVariants.flatMap((variant) => {
    const stem = variant.replace(adminSuffixPattern, '');
    if (!stem) return [variant];
    return [variant, stem, ...adminSuffixes.map((suffix) => `${stem}${suffix}`)];
  }).filter(Boolean);
};
// Script conversion dominates snapshot builds (every catalog city carries a Han name), so aliases are memoized.
const aliasCache = new Map<string, string[]>();
const cachedAliases = (value: string | undefined): string[] => {
  const key = value ?? '';
  let cached = aliasCache.get(key);
  if (!cached) {
    if (aliasCache.size >= 200_000) aliasCache.clear();
    cached = valueAliases(key);
    aliasCache.set(key, cached);
  }
  return cached;
};
const aliases = (values: Array<string | undefined>): string[] => [...new Set(values.flatMap(cachedAliases))];

export const poolLocationAliases = aliases;
export const completenessClause = (prefix = ''): string => addressQualitySqlClause(prefix);

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

export const aliasClauseValues = (columns: string[], values: string[]): { sql: string; values: string[] } | undefined => {
  if (!values.length) return undefined;
  const placeholders = values.map(() => '?').join(',');
  return {
    sql: `(${columns.map((column) => `${column} IN (${placeholders})`).join(' OR ')})`,
    values: columns.flatMap(() => values)
  };
};

interface ScopeKeys { admin1_key?: string; admin1_code_key?: string; locality_key?: string; postal_locality_key?: string }
// A location scope matches an address's admin1 key pair and, for a city, its city key: the locality, or the postal
// locality where the address has no locality.
export const scopeGroupMatches = (keys: ScopeKeys, scope: LocationScopeClause[]): boolean => scope.some((clause) =>
  clause.pairs.some(([admin1, code]) => admin1 === (keys.admin1_key || '') && code === (keys.admin1_code_key || ''))
  && (!clause.cities?.length || clause.cities.includes(keys.locality_key || keys.postal_locality_key || '')));
// admin1_key IN (...) lets the planner read the admin1 random-key index in order; the exact key pairs are then a filter
// on the joined pair, which no index matches.
const PAIR_SEPARATOR = '';
export const scopeClauseValues = (scope: LocationScopeClause[]): { sql: string; values: string[] } => {
  const values: string[] = [];
  const list = (items: string[]) => { values.push(...items); return items.map(() => '?').join(','); };
  const parts = scope.filter((clause) => clause.pairs.length).map((clause) => {
    const admin1 = list([...new Set(clause.pairs.map(([key]) => key))]);
    values.push(PAIR_SEPARATOR);
    const pairs = list(clause.pairs.map(([key, code]) => `${key}${PAIR_SEPARATOR}${code}`));
    const region = `admin1_key IN (${admin1}) AND (admin1_key || ? || admin1_code_key) IN (${pairs})`;
    if (!clause.cities?.length) return `(${region})`;
    const cities = list(clause.cities);
    const postal = list(clause.cities);
    return `(${region} AND (locality_key IN (${cities}) OR (locality_key='' AND postal_locality_key IN (${postal}))))`;
  });
  return { sql: parts.length ? `(${parts.join(' OR ')})` : '(1=0)', values };
};

const fallbackComponents = (row: AddressPoolV2Row): AddressComponents => normalizeAddressComponents(row.country_code, normalizeAddressFacts(row.country_code, {
  houseNumber: row.house_number,
  street: row.street,
  ...(row.building_name ? { buildingName: row.building_name } : {}),
  locality: row.locality || row.postal_locality,
  ...(row.postal_locality ? { postalLocality: row.postal_locality } : {}),
  ...(row.district ? { district: row.district, dependentLocality: row.district } : {}),
  ...(row.admin1 ? { admin1: row.admin1 } : {}),
  ...(row.admin1_code ? { admin1Code: row.admin1_code } : {}),
  postcode: row.postcode
}));

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

export const repairHongKongNativeVariants = (
  country: CountryCode,
  variants: Record<'native' | 'en' | 'zh-CN', AddressComponents>
): Record<'native' | 'en' | 'zh-CN', AddressComponents> => {
  if (country !== 'HK' && country !== 'TW') return variants;
  const traditionalize = country === 'HK' ? toTraditionalHongKong : toTraditionalTaiwan;
  const native = Object.fromEntries(Object.entries(variants.native).map(([field, original]) => {
    if (typeof original !== 'string' || !nativeSemanticFields.has(field)) return [field, original];
    const counterpart = variants['zh-CN'][field as keyof AddressComponents];
    const value = !hanScript.test(original) && typeof counterpart === 'string' && hanScript.test(counterpart)
      && preservesAddressNumbers(original, counterpart) ? counterpart : original;
    if (!hanScript.test(value)) return [field, original];
    return [field, traditionalize(value).replace(/[\p{Script=Latin}][\p{Script=Latin}\p{N}' .&/-]*/gu, ' ')
      .replace(/\s+/gu, ' ').trim() || original];
  })) as unknown as AddressComponents;
  return { ...variants, native };
};

const storedAddress = (components: AddressComponents, country: CountryCode): string => [
  [components.houseNumber, components.street].filter(Boolean).join(' '),
  components.buildingName,
  components.unit,
  components.district || components.dependentLocality,
  components.postalLocality || components.locality,
  components.admin1Code || components.admin1,
  country === 'CN' || country === 'HK' ? '' : components.postcode
].filter(Boolean).join(', ');

const taiwanEnglishAddress = (components: AddressComponents): string => [
  components.unit,
  components.houseNumber,
  components.street,
  components.buildingName,
  components.district || components.dependentLocality,
  components.postalLocality || components.locality,
  components.admin1,
  components.postcode,
  'Taiwan'
].filter(Boolean).join(', ');

const nativeStoredAddress = (components: AddressComponents, country: CountryCode): string => {
  if (country === 'HK' || country === 'TW') return [
    components.postcode,
    components.admin1,
    components.postalLocality || components.locality,
    components.district || components.dependentLocality,
    [components.houseNumber, components.street].filter(Boolean).join(' '),
    components.buildingName,
    components.unit
  ].filter(Boolean).join(', ');
  return storedAddress(components, country);
};

export interface AddressPublicationIssue {
  stage: 'source' | 'translation' | 'publication';
  code: string;
  field?: string;
  language?: string;
  category?: string;
}

// Ordinary addresses may publish before the Chinese street name is translated (it stays in Latin script);
// residential addresses and the recovery scan still require the full Chinese variant.

const rowToAddress = (row: AddressPoolV2Row, now: Date, requireTranslations = true,
  issues?: AddressPublicationIssue[], requireChineseStreet = false): VerifiedAddress | undefined => {
  row = projectAdministrativeRow(row);
  const reject = (stage: AddressPublicationIssue['stage'], code: string, details = {}): undefined => {
    issues?.push({ stage, code, ...details });
    return undefined;
  };
  if (!(row.quality_score >= 0.7)) return reject('source', 'low_quality_score');
  if (row.expires_at) {
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/u.test(row.expires_at);
    const fresh = dateOnly
      ? row.expires_at >= now.toISOString().slice(0, 10)
      : Number.isFinite(Date.parse(row.expires_at)) && Date.parse(row.expires_at) > now.getTime();
    if (!fresh) return reject('source', 'expired');
  }
  const matchLevel = row.match_level || 'premise';
  if (matchLevel === 'street' && (row.property_type !== 'unknown' || row.residential_evidence)) return reject('source', 'invalid_street_evidence');
  if (!row.source_id || !row.source_name || !row.source_url) return reject('source', 'source_metadata_missing');
  const hierarchy = validateAdministrativeHierarchy({
    countryCode: row.country_code, admin1: row.admin1, admin1Code: row.admin1_code, locality: row.locality
  });
  if (!hierarchy.valid) return reject('source', hierarchy.reason || 'invalid_administrative_hierarchy');
  const fallback = fallbackComponents(row);
  const fallbackAddress = [row.house_number, row.street, row.postal_locality || row.locality, row.admin1_code || row.admin1, row.postcode]
    .filter(Boolean).join(', ');
  const parsedComponents = parseVariants(row.component_variants_json, fallback);
  for (const language of ['native', 'en', 'zh-CN'] as const) {
    const stored = parsedComponents[language];
    parsedComponents[language] = { ...fallback, ...stored };
    if (!Object.hasOwn(stored, 'postalLocality') && stored.locality
      && normalize(row.postal_locality) === normalize(row.locality)) parsedComponents[language].postalLocality = stored.locality;
    if (!Object.hasOwn(stored, 'dependentLocality')) {
      if (stored.district) parsedComponents[language].dependentLocality = stored.district;
      else delete parsedComponents[language].dependentLocality;
    }
  }
  const componentVariants = repairHongKongNativeVariants(row.country_code, {
    native: normalizeAddressComponents(row.country_code, normalizeAddressFacts(row.country_code, parsedComponents.native)),
    en: normalizeAddressComponents(row.country_code, normalizeAddressFacts(row.country_code, parsedComponents.en)),
    'zh-CN': normalizeAddressComponents(row.country_code, normalizeAddressFacts(row.country_code, parsedComponents['zh-CN']))
  });
  const contract = validateAddressContract(row.country_code, componentVariants.native, { strict: true, requireAdminCode: false, matchLevel });
  if (!contract.valid) {
    for (const code of contract.reasons) reject('source', code);
    return undefined;
  }
  const quality = validateAddressQuality({
    countryCode: row.country_code, components: componentVariants.native,
    latitude: row.latitude, longitude: row.longitude, matchLevel
  });
  if (!quality.valid) {
    for (const code of quality.reasons) reject('source', code);
    return undefined;
  }
  // English-first publication: a Chinese field still untranslated or unusable shows its English form (or the source
  // value) until translation recovery replaces it. `requireChineseStreet` asks for the complete Chinese variant instead,
  // which decides whether a published row still needs translation.
  let chineseFallback = false;
  if (requireTranslations) {
    for (const language of ['en', 'zh-CN'] as const) {
      if (language === 'zh-CN' && !requireChineseStreet) {
        const chinese = { ...componentVariants['zh-CN'] };
        for (const field of [...semanticAddressFields, 'houseNumber', 'unit', 'postcode', 'admin1Code'] as Array<keyof AddressComponents>) {
          const original = String(componentVariants.native[field] || '');
          const value = String(chinese[field] || '');
          const semantic = (semanticAddressFields as readonly string[]).includes(field);
          if ((!original || value) && preservesAddressNumbers(original, value) && preservesAddressIdentifiers(original, value)
            && (!['postcode', 'admin1Code'].includes(field) || original === value)
            && (!semantic || componentLooksLocalized(value, language) && !(hanScript.test(value) && implausibleChineseTranslation(original, value, field)))) continue;
          const fallback = String(componentVariants.en[field] || original);
          if (fallback && componentLooksLocalized(fallback, language)) chinese[field] = fallback; else delete chinese[field];
          chineseFallback = true;
        }
        componentVariants['zh-CN'] = chinese;
        continue;
      }
      const translated = componentVariants[language];
      for (const field of [...semanticAddressFields, 'houseNumber', 'unit', 'postcode', 'admin1Code'] as Array<keyof AddressComponents>) {
        const original = String(componentVariants.native[field] || '');
        const value = String(translated[field] || '');
        if (!preservesAddressNumbers(original, value) || !preservesAddressIdentifiers(original, value)
          || ['postcode', 'admin1Code'].includes(field) && original !== value) {
          return reject('translation', 'changed_source_identifier', { language, field });
        }
      }
      for (const field of semanticAddressFields as Array<keyof AddressComponents>) {
        const value = String(translated[field] || '');
        if (!componentLooksLocalized(value, language)) return reject('translation', 'invalid_target_script', { language, field });
        if (language === 'en' && implausibleEnglishTranslation(componentVariants.native[field], value, field)) {
          return reject('translation', 'implausible_target_translation', { language, field });
        }
      }
      if (language === 'zh-CN') {
        for (const field of translatedSemanticFields(row.country_code) as Array<keyof AddressComponents>) {
          const original = String(componentVariants.native[field] || '');
          const value = String(translated[field] || '');
          if (original && /\p{L}/u.test(original) && !hanScript.test(value) && !unchangedIdentifier.test(original)) {
            return reject('translation', 'incomplete_target_translation', { language, field });
          }
        }
        for (const field of semanticAddressFields as Array<keyof AddressComponents>) {
          const value = String(translated[field] || '');
          if (implausibleChineseTranslation(componentVariants.native[field], value, field)) {
            return reject('translation', 'implausible_target_translation', { language, field });
          }
        }
      }
      if (language === 'zh-CN' && !hasHanSemanticContent(translated)) return reject('translation', 'missing_target_script', { language });
    }
  }
  const parsedAddresses = parseVariants(row.address_variants_json, fallbackAddress);
  // Taiwanese English addresses carry the house number and floor in Chunghwa Post style instead of romanized 號/之/樓.
  const taiwanPremise = row.country_code === 'TW'
    ? taiwanEnglishPremise(componentVariants.native.houseNumber || '', componentVariants.native.unit || '') : undefined;
  if (row.country_code === 'TW' && !taiwanPremise && hanScript.test(`${componentVariants.en.houseNumber}${componentVariants.en.unit}`)) {
    return reject('translation', 'invalid_target_script', { language: 'en', field: 'houseNumber' });
  }
  if (taiwanPremise) componentVariants.en = { ...componentVariants.en, ...taiwanPremise };
  const addressVariants = ['HK', 'TW'].includes(row.country_code) && hanScript.test(Object.values(componentVariants.native).join(' '))
    ? {
        ...parsedAddresses,
        native: nativeStoredAddress(componentVariants.native, row.country_code),
        ...(taiwanPremise ? { en: taiwanEnglishAddress(componentVariants.en) } : {})
      }
    : /^\d+[\p{L}\p{N}./-]*$/u.test(row.building_name.trim())
    ? {
        native: storedAddress(componentVariants.native, row.country_code),
        en: storedAddress(componentVariants.en, row.country_code),
        'zh-CN': storedAddress(componentVariants['zh-CN'], row.country_code)
      }
    : parsedAddresses;
  if (chineseFallback) addressVariants['zh-CN'] = storedAddress(componentVariants['zh-CN'], row.country_code);
  const propertyType = propertyTypes.has(row.property_type as PropertyType)
    ? row.property_type as PropertyType
    : 'unknown';
  const variants = requireTranslations ? Object.values(componentVariants) : [componentVariants.native];
  const formattedAddresses = requireTranslations ? Object.values(addressVariants) : [addressVariants.native];
  const useMatch = (row.country_code === 'CN' || row.residential_evidence
    || ['residential', 'apartment'].includes(propertyType)) ? findNonResidentialMatch({
    countryCode: row.country_code,
    buildingNames: variants.map((item) => item.buildingName).filter((value): value is string => Boolean(value)),
    formattedAddresses,
    streets: variants.map((item) => item.street).filter(Boolean),
    propertyType
  }) : { excluded: false as const };
  if (useMatch.excluded) return reject(requireTranslations ? 'publication' : 'source', 'use_evidence_conflict', {
    field: useMatch.field, category: useMatch.category
  });
  if (matchesCustomBlacklist([
    ...variants.map((item) => item.buildingName),
    ...formattedAddresses,
    ...variants.map((item) => item.street)
  ])) return reject(requireTranslations ? 'publication' : 'source', 'custom_blacklist');
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
    const residentialSource = residentialEvidenceSource(row);
    evidence.push({
      ...residentialSource,
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
    nativeLanguage: row.country_code === 'HK' ? 'zh-HK' : row.native_language,
    addressVariants,
    components: componentVariants.native,
    componentVariants,
    coordinates: { latitude: row.latitude, longitude: row.longitude },
    addressStatus: 'verified',
    propertyType,
    unitStatus: componentVariants.native.unit ? 'verified' : componentVariants.native.buildingName ? 'building_only' : 'not_present',
    unitProvenance: componentVariants.native.unit ? 'source_tagged' : 'none',
    matchLevel: matchLevel === 'street' ? 'street' : componentVariants.native.unit ? 'subpremise' : 'premise',
    verificationLevel: 'L2',
    sourceVersion: `${row.dataset_id || row.source_id}:${row.dataset_version || row.generation}`,
    sourceUpdatedAt,
    verifiedAt: now.toISOString(),
    expiresAt: row.expires_at
      ? /^\d{4}-\d{2}-\d{2}$/u.test(row.expires_at) ? `${row.expires_at}T23:59:59.999Z` : new Date(row.expires_at).toISOString()
      : '9999-12-31T23:59:59.999Z',
    evidence,
    exclusionFlags: row.quality_score < 0.7 ? ['low_quality_score'] : []
  };
};

export const storedAddressPoolV2RowIsPublishable = (
  row: AddressPoolV2Row,
  now = new Date()
): boolean => Boolean(rowToAddress(row, now));

export const storedAddressPoolV2RowIsFullyTranslated = (row: AddressPoolV2Row, now = new Date()): boolean =>
  Boolean(rowToAddress(row, now, true, undefined, true));

export const storedAddressPoolV2RowCanRecoverTranslations = (row: AddressPoolV2Row, now = new Date()): boolean =>
  row.country_code !== 'CN' && row.quality_score >= 0.7 && Boolean(rowToAddress(row, now, false));

export const diagnoseStoredAddressPoolV2Row = (row: AddressPoolV2Row,
  { recovery = false, now = new Date() } = {}): { valid: boolean; issues: AddressPublicationIssue[] } => {
  const issues: AddressPublicationIssue[] = [];
  if (recovery && row.country_code === 'CN') issues.push({ stage: 'source', code: 'unsupported_recovery' });
  if (recovery && row.quality_score < 0.7) issues.push({ stage: 'source', code: 'low_quality_score' });
  const address = rowToAddress(row, now, !recovery, issues);
  return { valid: Boolean(address) && !issues.length, issues };
};

const missingSchema = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return /no such (?:table|view).*(?:address_pool_runtime|address_generation_index)|(?:does not exist.*(?:address_pool_runtime|address_generation_index)|(?:address_pool_runtime|address_generation_index).*does not exist)/i.test(message);
};

interface RegionNameRow { id: number; code: string; name: string; native_name: string; zh_name: string }

const regionNameCaches = new WeakMap<object, Map<string, RegionNameRow | null>>();
const cityZhCaches = new WeakMap<object, Map<string, string | null>>();
const regionPresenceCaches = new WeakMap<object, Map<string, boolean>>();
const cacheFor = <T,>(store: WeakMap<object, Map<string, T>>, db: Database): Map<string, T> => {
  let cache = store.get(db as object);
  if (!cache) {
    cache = new Map();
    store.set(db as object, cache);
  }
  if (cache.size > 2000) cache.clear();
  return cache;
};
const han = /[\p{Script=Han}]/u;
const samePlaceKey = (value: string | undefined): string => (value || '')
  .normalize('NFKC').toLocaleLowerCase('und').replace(/[^\p{L}\p{N}]+/gu, '');

const lookupRegionNames = async (
  db: Database,
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
    const matches = (await db.prepare(`SELECT id, code, name, native_name, zh_name FROM catalog_regions
      WHERE country_code = ? AND (LOWER(code) = LOWER(?) OR LOWER(name) = LOWER(?) OR LOWER(native_name) = LOWER(?))
      ORDER BY id LIMIT 2`).bind(country, value, value, value).all<RegionNameRow>()).results;
    const raw = matches.length === 1 ? matches[0] : null;
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

const hasCatalogRegions = async (db: Database, country: CountryCode): Promise<boolean> => {
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

const lookupCityZhName = async (db: Database, country: CountryCode, locality: string, regionId?: number): Promise<string | null> => {
  const cache = cacheFor(cityZhCaches, db);
  const key = `${country}:${regionId || ''}:${samePlaceKey(locality)}`;
  if (cache.has(key)) return cache.get(key) || null;
  let zhName: string | null = null;
  try {
    const matches = (await db.prepare(`SELECT zh_name FROM catalog_cities
      WHERE country_code = ? AND (LOWER(name) = LOWER(?) OR LOWER(native_name) = LOWER(?)) AND zh_name <> ''
        ${regionId ? 'AND region_id=?' : ''} ORDER BY id LIMIT 2`)
      .bind(country, locality, locality, ...(regionId ? [regionId] : [])).all<{ zh_name: string }>()).results;
    const row = matches.length === 1 ? matches[0] : null;
    zhName = typeof row?.zh_name === 'string' && han.test(row.zh_name) && !implausibleChineseTranslation(locality, row.zh_name)
      ? row.zh_name : null;
  } catch {
    zhName = null;
  }
  cache.set(key, zhName);
  return zhName;
};

export const enrichPickedAddress = async (db: Database, address: VerifiedAddress): Promise<VerifiedAddress> => {
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
    const normalized = normalizeAddressFacts(address.countryCode, components) as AddressComponents;
    if (JSON.stringify(normalized) !== JSON.stringify(components)) {
      updated[language] = normalized;
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
      // Only a Chinese catalog name replaces the stored translation; a missing or literal one (Bursa → 囊) keeps it.
      if (han.test(names.zh_name || '') && !implausibleChineseTranslation(names.native_name || names.name, names.zh_name)) {
        assign('zh-CN', names.zh_name);
      }
    } else if (!addressContracts[address.countryCode]?.required.includes('admin1')
      && (samePlaceKey(native.admin1) === samePlaceKey(native.locality)
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
    const region = await lookupRegionNames(db, address.countryCode, native.admin1 || '', native.admin1Code || '');
    const zhName = await lookupCityZhName(db, address.countryCode, zhLocality, region?.id);
    if (zhName) {
      updated['zh-CN'].locality = zhName;
      if (updated['zh-CN'].postalLocality && samePlaceKey(updated['zh-CN'].postalLocality) === samePlaceKey(zhLocality)) {
        updated['zh-CN'].postalLocality = zhName;
      }
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

  if (!changed) return address;
  const baseVariants = address.addressVariants || { native: '', en: '', 'zh-CN': '' };
  const addressVariants = {
    native: ['HK', 'TW'].includes(address.countryCode) && hanScript.test(Object.values(updated.native).join(' '))
      ? nativeStoredAddress(updated.native, address.countryCode) : storedAddress(updated.native, address.countryCode),
    en: storedAddress(updated.en, address.countryCode),
    'zh-CN': storedAddress(updated['zh-CN'], address.countryCode)
  };
  return {
    ...address,
    nativeAddress: addressVariants.native || baseVariants.native,
    formattedAddress: addressVariants.en || baseVariants.en,
    addressVariants,
    components: updated.native,
    componentVariants: updated
  };
};

const enrichPublishableAddress = async (db: Database, address: VerifiedAddress): Promise<VerifiedAddress | undefined> => {
  const enriched = await enrichPickedAddress(db, address);
  return requiresAdminCode(enriched.countryCode) && !enriched.components.admin1Code ? undefined : enriched;
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
  db: Database | undefined,
  country: CountryCode,
  residential: boolean,
  coordinates: { latitude: number; longitude: number },
  seed: string,
  maximumDistanceKm = 100,
  now = new Date()
): Promise<NearestAddressPoolV2Result | undefined> => {
  if (!db) return undefined;
  const readiness = residential ? ' AND generation.residential_ready=1' : '';
  const longitudeScale = Math.max(0.1, Math.cos(coordinates.latitude * Math.PI / 180));
  // Every row inside the box is read and sorted, so the search widens step by step and stops at the first radius with
  // candidates; a 2 km box in a dense city holds thousands of rows. The box is read from the covering coordinate index
  // alone, and only its nearest rows are checked against the generation index (which holds exactly the publishable
  // rows) and read through the runtime view: one random read per box row took seconds on a cold cache.
  const radii = [...new Set([0.5, 2, 8, 25, maximumDistanceKm].map((radius) => Math.min(radius, maximumDistanceKm)))].filter((radius) => radius > 0);
  const boxLimit = 64;
  // Repeated picks for one IP draw at random from the nearest publishable rows, so the box widens until it holds enough
  // of them for variety; a pick among the eight nearest returned the same few addresses over and over.
  const varietyTarget = 32;
  const residentialTypes = residential ? ` AND pool.property_type IN ('residential','apartment')` : '';
  const distance = `((pool.latitude - ?) * (pool.latitude - ?)) + ((pool.longitude - ?) * (pool.longitude - ?) * ? * ?)`;

  try {
    let best: { ids: string[]; radiusKm: number } | undefined;
    for (const radiusKm of radii) {
      const latitudeRadius = radiusKm / 111.32;
      const longitudeRadius = Math.min(180, latitudeRadius / longitudeScale);
      const box = [
        coordinates.latitude, coordinates.latitude, coordinates.longitude, coordinates.longitude, longitudeScale, longitudeScale,
        country,
        Math.max(-90, coordinates.latitude - latitudeRadius),
        Math.min(90, coordinates.latitude + latitudeRadius),
        Math.max(-180, coordinates.longitude - longitudeRadius),
        Math.min(180, coordinates.longitude + longitudeRadius)
      ];
      const boxWhere = `pool.country_code = ? AND pool.active = 1
          AND pool.latitude >= ? AND pool.latitude <= ? AND pool.longitude >= ? AND pool.longitude <= ?${residentialTypes}`;
      type BoxRow = { id: string; latitude: number; longitude: number };
      const closest = (await db.prepare(`SELECT pool.id, pool.latitude, pool.longitude, ${distance} AS distance_score
        FROM address_pool pool WHERE ${boxWhere}
        ORDER BY distance_score, pool.random_key, pool.id LIMIT ${boxLimit}`).bind(...box).all<BoxRow>()).results || [];
      if (!closest.length) continue;
      const ready = new Set(((await db.prepare(`SELECT generation.address_id AS id FROM address_generation_index generation
        WHERE generation.active=1${readiness} AND generation.address_id IN (${closest.map(() => '?').join(',')})`)
        .bind(...closest.map(({ id }) => id)).all<{ id: string }>()).results || []).map(({ id }) => id));
      let nearest = closest.filter(({ id }) => ready.has(id));
      // The nearest box rows are all unpublishable only rarely; the whole box then decides, as before.
      if (!nearest.length && closest.length === boxLimit) {
        nearest = (await db.prepare(`SELECT pool.id, pool.latitude, pool.longitude, ${distance} AS distance_score
          FROM address_pool pool
          JOIN address_generation_index generation ON generation.address_id=pool.id AND generation.active=1${readiness}
          WHERE ${boxWhere}
          ORDER BY distance_score, pool.random_key, pool.id LIMIT ${boxLimit}`).bind(...box).all<BoxRow>()).results || [];
      }
      // The box corners lie beyond the radius.
      nearest = nearest.filter((row) => geographicDistanceKm(coordinates, { latitude: Number(row.latitude), longitude: Number(row.longitude) }) <= radiusKm);
      if (!nearest.length) continue;
      best = { ids: nearest.map(({ id }) => id), radiusKm };
      if (nearest.length >= varietyTarget) break;
    }
    if (!best) return undefined;
    // A seeded order over the candidates; rows are read in small batches until one passes, usually the first.
    const order = [...best.ids].sort((left, right) => hashSeed(`${seed}:ip-nearest:${left}`) - hashSeed(`${seed}:ip-nearest:${right}`)
      || left.localeCompare(right));
    for (let offset = 0; offset < order.length; offset += 8) {
      const batch = order.slice(offset, offset + 8);
      const stored = new Map(((await db.prepare(`SELECT * FROM address_pool_runtime WHERE active = 1 AND id IN (${batch.map(() => '?').join(',')})`)
        .bind(...batch).all<AddressPoolV2Row>()).results || []).map((row) => [row.id, row]));
      for (const id of batch) {
        const row = stored.get(id);
        if (!row || row.country_code !== country
          || residential && (Number(row.residential_evidence) !== 1 || !['residential', 'apartment'].includes(row.property_type))) continue;
        const candidate = rowToAddress(row, now);
        if (!candidate) continue;
        const distanceKm = geographicDistanceKm(coordinates, candidate.coordinates);
        if (distanceKm > best.radiusKm) continue;
        const address = await enrichPublishableAddress(db, candidate);
        if (address) return { address, distanceKm };
      }
    }
    return undefined;
  } catch (error) {
    if (missingSchema(error)) return undefined;
    throw error;
  }
};

export const loadAddressPoolV2AddressById = async (
  db: Database | undefined,
  addressId: string,
  now = new Date()
): Promise<VerifiedAddress | undefined> => {
  if (!db || !addressId.startsWith('pool-v2-')) return undefined;
  try {
    const row = await db.prepare('SELECT * FROM address_pool_runtime WHERE id = ? AND active = 1 LIMIT 1')
      .bind(addressId.slice('pool-v2-'.length).split(':')[0]).first<AddressPoolV2Row>();
    if (!row) return undefined;
    const address = storedAddressPoolV2RowIsPublishable(row, now) ? rowToAddress(row, now) : undefined;
    return address ? enrichPublishableAddress(db, address) : undefined;
  } catch (error) {
    if (missingSchema(error)) return undefined;
    throw error;
  }
};

export const pickAddressPoolV2Address = async (
  db: Database | undefined,
  country: CountryCode,
  residential: boolean,
  filters: AddressFilters,
  target: CatalogTarget | undefined,
  seed: string,
  now = new Date()
): Promise<VerifiedAddress | undefined> => {
  if (!db) return undefined;
  if (filters.districtId && !filters.district) return undefined;
  const clauses = ['country_code = ?', 'active = 1', 'quality_score >= 0.7', completenessClause(), addressLocalizationSqlClause()];
  const bindings: unknown[] = [country];
  if (residential) clauses.push(`property_type IN ('residential','apartment')`);
  const regionNames = aliases([filters.region, target?.region, target?.regionNative, target?.regionCode, ...target?.regionAliases || []]);
  const cityNames = aliases([filters.city, target?.city, target?.cityNative, ...target?.cityAliases || []]);
  const districtNames = aliases([filters.district]);
  const currentValueMatches = (values: Array<string | undefined>, expected: string[]): boolean =>
    !expected.length || aliases(values).some((value) => expected.includes(value));

  const scope = target?.scope;
  const scopeClause = scope ? scopeClauseValues(scope) : undefined;
  if (scopeClause) {
    clauses.push(scopeClause.sql);
    bindings.push(...scopeClause.values);
  }
  const regionClause = aliasClauseValues(['admin1_key', 'admin1_code_key'], regionNames);
  if (!scope && (filters.region || target?.region) && regionClause) {
    clauses.push(regionClause.sql);
    bindings.push(...regionClause.values);
  }
  const cityClause = aliasClauseValues(['locality_key', 'postal_locality_key'], cityNames);
  if (!scope && (filters.city || target?.city) && cityClause) {
    clauses.push(cityClause.sql);
    bindings.push(...cityClause.values);
  }
  const districtClause = aliasClauseValues(['district_key'], districtNames);
  if (filters.district && districtClause) {
    clauses.push(districtClause.sql);
    bindings.push(...districtClause.values);
  }
  const selectedPostcode = filters.postcode || target?.postcode;
  if (selectedPostcode) {
    clauses.push('postcode_key = ?');
    bindings.push(normalize(selectedPostcode).replace(/\s/gu, ''));
  }
  if (filters.q?.trim()) {
    clauses.push(`LOWER(house_number || ' ' || street || ' ' || locality || ' ' || postal_locality || ' ' || admin1 || ' ' || postcode) LIKE ? ESCAPE '\\'`);
    bindings.push(`%${normalize(filters.q).replace(/[\\%_]/g, '\\$&')}%`);
  }

  const generationClauses = ['country_code = ?', 'active = 1'];
  const generationBindings: unknown[] = [country];
  if (residential) generationClauses.push('residential_ready = 1');
  if (scopeClause) {
    generationClauses.push(scopeClause.sql);
    generationBindings.push(...scopeClause.values);
  }
  const generationRegionClause = aliasClauseValues(['admin1_key', 'admin1_code_key'], regionNames);
  if (!scope && (filters.region || target?.region) && generationRegionClause) {
    generationClauses.push(generationRegionClause.sql);
    generationBindings.push(...generationRegionClause.values);
  }
  const generationCityClause = aliasClauseValues(['locality_key', 'postal_locality_key'], cityNames);
  if (!scope && (filters.city || target?.city) && generationCityClause) {
    generationClauses.push(generationCityClause.sql);
    generationBindings.push(...generationCityClause.values);
  }
  const generationDistrictClause = aliasClauseValues(['district_key'], districtNames);
  if (filters.district && generationDistrictClause) {
    generationClauses.push(generationDistrictClause.sql);
    generationBindings.push(...generationDistrictClause.values);
  }
  const generationPostcode = filters.postcode || target?.postcode;
  if (generationPostcode) {
    generationClauses.push('postcode_key = ?');
    generationBindings.push(normalize(generationPostcode).replace(/\s/gu, ''));
  }
  if (filters.q?.trim()) {
    generationClauses.push(`search_text LIKE ? ESCAPE '\\'`);
    generationBindings.push(`%${normalize(filters.q).replace(/[\\%_]/g, '\\$&')}%`);
  }

  const pivot = hashSeed(`${country}:${seed}:address-pool-v2`) & 0x7fffffff;
  const candidateLimit = residential ? 16 : 64;
  const nationwide = !target && !filters.region && !filters.regionId && !filters.city && !filters.cityId
    && !filters.district && !filters.districtId && !filters.postcode && !filters.postcodeId && !filters.q?.trim();
  try {
    const select = `SELECT id FROM address_pool WHERE ${clauses.join(' AND ')}${residential ? ` AND ${residentialEvidenceClause}` : ''}`;
    const generationSelect = `SELECT address_id AS id FROM address_generation_index WHERE ${generationClauses.join(' AND ')}`;
    const loadIdentifiers = async (sql: string, values: unknown[]): Promise<Array<{ id: string }>> =>
      (await db.prepare(sql).bind(...values).all<{ id: string }>()).results || [];
    // random_key is uniform over 31 bits, so a scope of known size reads a slice expected to hold four times the
    // candidates instead of every key after the pivot; a slice that falls short reads on as before.
    const slice = target?.scopeCount ? Math.ceil(2 ** 31 * candidateLimit * 4 / target.scopeCount) : 0;
    const loadWindow = async (select: string, values: unknown[], idColumn: string): Promise<Array<{ id: string }>> => {
      if (slice && slice < 2 ** 31 && pivot + slice < 2 ** 31) {
        const sliced = await loadIdentifiers(
          `${select} AND random_key >= ? AND random_key < ? ORDER BY random_key, ${idColumn} LIMIT ${candidateLimit}`,
          [...values, pivot, pivot + slice]
        );
        if (sliced.length >= candidateLimit) return sliced;
      }
      const forward = await loadIdentifiers(
        `${select} AND random_key >= ? ORDER BY random_key, ${idColumn} LIMIT ${candidateLimit}`,
        [...values, pivot]
      );
      if (forward.length >= candidateLimit || typeof (db as { exec?: unknown }).exec !== 'function') return forward;
      const seen = new Set(forward.map(({ id }) => id));
      const wrapped = await loadIdentifiers(
        `${select} AND random_key < ? ORDER BY random_key, ${idColumn} LIMIT ${candidateLimit}`,
        [...values, pivot]
      );
      return [...forward, ...wrapped.filter(({ id }) => !seen.has(id))].slice(0, candidateLimit);
    };
    const pickEligible = async (identifiers: Array<{ id: string }>): Promise<VerifiedAddress | undefined> => {
      if (!identifiers.length) return undefined;
      const ids = identifiers.map(({ id }) => id);
      const placeholders = ids.map(() => '?').join(',');
      const rows = (await db.prepare(`SELECT * FROM address_pool_runtime WHERE id IN (${placeholders})`)
        .bind(...ids).all<AddressPoolV2Row>()).results || [];
      const byId = new Map(rows.map((row) => [row.id, row]));
      for (const { id } of rotateCandidates(identifiers, `${country}:${seed}:address-pool-v2:candidate`)) {
        const stored = byId.get(id);
        if (!stored) continue;
        const row = projectAdministrativeRow(stored);
        if (row.country_code !== country
          || residential && (Number(row.residential_evidence) !== 1
            || !['residential', 'apartment'].includes(row.property_type))
          || scope && !scopeGroupMatches(row, scope)
          || !scope && (filters.region || target?.region) && !currentValueMatches([row.admin1, row.admin1_code], regionNames)
          || !scope && (filters.city || target?.city) && !currentValueMatches([row.locality, row.postal_locality], cityNames)
          || filters.district && !currentValueMatches([row.district], districtNames)
          || selectedPostcode && normalize(row.postcode).replace(/\s/gu, '') !== normalize(selectedPostcode).replace(/\s/gu, '')
          || filters.q?.trim() && !normalize([row.house_number, row.street, row.building_name, row.district,
            row.locality, row.postal_locality, row.admin1, row.admin1_code, row.postcode].filter(Boolean).join(' '))
            .includes(normalize(filters.q))) continue;
        const address = rowToAddress(row, now);
        if (address) {
          const enriched = await enrichPublishableAddress(db, address);
          if (enriched) return enriched;
        }
      }
      return undefined;
    };
    // Test doubles and older database adapters may not expose exec(); in that
    // case use the original indexed address_pool query directly.
    if (typeof (db as { exec?: unknown }).exec === 'function') {
      if (nationwide) {
        const rank = residential ? 'residential_rank' : 'country_rank';
        const readiness = residential ? ' AND residential_ready=1' : '';
        // Ranks keep gaps where rows were retired, so several seeded ranks are probed in one indexed read and the
        // first one that exists wins; the pick stays uniform over active rows.
        const probes = Array.from({ length: 16 }, (_, index) => rankSeed(`${country}:${seed}:address-pool-v2:rank${index ? `:${index}` : ''}`));
        const hits = (await db.prepare(`WITH selected AS (
            SELECT MAX(${rank}) AS maximum
            FROM address_generation_index
            WHERE country_code=? AND active=1${readiness}
          )
          SELECT address_id AS id,${rank} AS rank,selected.maximum AS maximum FROM address_generation_index,selected
          WHERE country_code=? AND active=1${readiness}
            AND ${rank} IN (${probes.map(() => '(CAST(? AS bigint) % selected.maximum)+1').join(',')})`)
          .bind(country, country, ...probes).all<{ id: string; rank: number | string; maximum: number | string }>()).results || [];
        const byRank = new Map(hits.map((hit) => [String(hit.rank), hit.id]));
        const maximum = hits.length ? BigInt(hits[0]!.maximum) : 0n;
        const first = maximum ? probes.map((probe) => byRank.get(String(BigInt(probe) % maximum + 1n))).find(Boolean) : undefined;
        const ranked = first ? [{ id: first }] : [];
        const exact = await pickEligible(ranked);
        if (exact) return exact;
      }
      const indexed = await pickEligible(await loadWindow(generationSelect, generationBindings, 'address_id'));
      if (indexed) return indexed;
      // A built index lists every publishable address of its country, so a miss there is final; the pool itself is
      // read only until the country's first index build.
      if (await db.prepare('SELECT 1 AS built FROM address_generation_index WHERE country_code=? AND active=1 LIMIT 1')
        .bind(country).first()) return undefined;
    }
    return await pickEligible(await loadWindow(select, bindings, 'id'));
  } catch (error) {
    if (missingSchema(error)) return undefined;
    throw error;
  }
};
