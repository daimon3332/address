import { applyHierarchicalQuota } from './address-policy.mjs';
import { addressCanonicalKey, localityIssue, splitConcatenatedLocality, validateAddressQuality, streetAddressKey } from '../../src/domain/address-quality.mjs';
import { canonicalUsSubdivisionCode, validateAdministrativeHierarchy } from '../../src/domain/administrative-integrity.mjs';
import { requiresAdminCode, validateAddressContract } from '../../src/domain/address-contracts.mjs';
import { ranksNeedRenumbering, refreshAddressGenerationIndex } from '../database/generation-index.mjs';
import { POSTCODE_REQUIRED_REVISION, postcodeRequired } from './postcode-requirement.mjs';
import { correctedRegion, regionCorrectionCountries } from './region-boundaries.mjs';
import { administrativeNameCountries, createAdministrativeNames, mixedLevelCountries, singaporeRegion } from './administrative-names.mjs';
import { semanticAddressFields, usableAddressTranslation } from '../../src/domain/address-localization.mjs';

const cleanKey = (value) => String(value || '').normalize('NFKC').trim().toLocaleLowerCase('und');
const postcodeKey = (value) => cleanKey(value).replace(/\s/gu, '');
const randomKey = (hash) => Number.parseInt(hash.slice(0, 8), 16) & 0x7fffffff;
const DEFAULT_MINIMUM_RATIO = 0.7;
const GENERATION_REFRESH_BATCH = 5_000;
const placeholders = (values) => values.map(() => '?').join(',');

// Minimum administrative completeness per country. A record must carry at least
// one region-level field and (where listed) a city-level field, else it is dropped.
const requiredAdminFields = {
  CN: { region: true, city: true, district: true }, IN: { region: true, city: true }, VN: { region: true, city: true },
  TH: { region: true, city: true }, US: { region: true, city: true }, CA: { region: true, city: true },
  JP: { region: true, city: true }, MX: { region: true, city: true }, BR: { region: true, city: true },
  AU: { region: true, city: true }, KR: { region: true, city: true }, MY: { region: true, city: true },
  PH: { region: true, city: true }, TR: { region: true, city: true }, RU: { region: true, city: true },
  DE: { region: false, city: true }, FR: { region: false, city: true }, IT: { region: false, city: true },
  ES: { region: false, city: true }, NL: { region: false, city: true }, GB: { region: false, city: true },
  SA: { region: false, city: true }, NG: { region: true, city: true }, ZA: { region: false, city: true },
  TW: { region: true, city: true }, HK: { region: false, city: true }, SG: { region: false, city: false }
};

const hasRegion = (components) => Boolean((components.admin1 || '').trim() || (components.admin1Code || '').trim());
const hasCity = (components) => Boolean(
  (components.locality || '').trim() || (components.postalLocality || '').trim() || (components.district || '').trim()
);

// Countries whose admin hierarchy is rebuilt from coordinates, overriding
// untrustworthy source text (OSM stores district names in the city field, mixes
// scripts, etc.). Only CN has both severe misplacement and a dense enough catalog.
const geoAnchorCountries = new Set(['CN']);

// Countries whose source admin1 must resolve to a catalog_regions entry. A
// non-matching value (e.g. NL Overture address_levels carrying the city name)
// is re-derived from coordinates; a record that cannot be anchored to any
// region is dropped — no invented admin. US is excluded because
// administrative-integrity.mjs already validates against the full official
// subdivision list (incl. territories such as PR that the catalog omits).
// TW/HK are excluded because their catalog region names are Latin-script while
// source admin1 is Han, so name validation cannot apply there.
const catalogAnchoredAdmin1Countries = new Set(['NL', 'CA', 'DE', 'FR', 'IT', 'ES', 'AU', 'JP', 'MX']);
const foldAdmin1 = (value) => String(value || '').normalize('NFKD').replace(/[̀-ͯ]/gu, '')
  .toLocaleLowerCase('und').replace(/[^\p{L}\p{N}]+/gu, '');
// The catalog stores some JP prefectures with the 都/道/府/県 suffix and some
// without; compare both spellings on both sides.
const admin1Variants = (value) => {
  const folded = foldAdmin1(value);
  if (!folded) return [];
  const stripped = folded.replace(/[都道府県]$/u, '');
  return stripped && stripped !== folded ? [folded, stripped] : [folded];
};
const matchesCatalogRegion = (geocoder, value) => {
  const needles = admin1Variants(value);
  if (!needles.length) return false;
  for (const region of geocoder.regionsById.values()) {
    for (const candidate of [region.code, region.name, region.native_name, region.zh_name]) {
      if (admin1Variants(candidate).some((key) => needles.includes(key))) return true;
    }
  }
  return false;
};

// Rule-based soft fixes for countries with locality-level misplacement but a
// catalog too sparse (TW) or a defect rate too low (RU) for full re-anchoring.
// `demote` matches a locality that is NOT a city; `replaceWith: 'admin1'` uses the
// admin1 name as the city (TW 縣市), `'anchor'` uses the coordinate-nearest
// catalog city (RU район records).
const softLocalityFixes = {
  TW: { demote: /[里村]$/u, replaceWith: 'admin1' },
  RU: { demote: /район|поселение|сельсовет|городской округ/iu, replaceWith: 'anchor' }
};

// A city field holding a region code, a number or a postcode is cleared so the catalog or boundary fill can name the city.
const clearInvalidLocality = (record, countryCode) => {
  const { components } = record;
  for (const field of ['locality', 'postalLocality']) {
    if (!localityIssue(countryCode, { admin1: components.admin1, admin1Code: components.admin1Code, locality: components[field] })) continue;
    components[field] = '';
    record[field] = '';
  }
};
// Catalog names replace machine translations of regions and cities, and the admin1 text corrects its code.
const administrativeNamesOf = (geocoder, countryCode) => geocoder.administrativeNames ||= createAdministrativeNames(countryCode,
  [...geocoder.regionsById.values()], geocoder.cities || [], geocoder.postcodes || []);
const applyAdministrativeNames = (record, geocoder, countryCode) => {
  if (!administrativeNameCountries(countryCode) || !geocoder?.regionsById?.size) return false;
  const { native, en, 'zh-CN': zh } = administrativeNamesOf(geocoder, countryCode)
    .names(record.components, { en: {}, 'zh-CN': countryCode === 'JP' ? record.components : {} });
  Object.assign(record.components, native);
  if (native.admin1 !== undefined) record.admin1 = native.admin1;
  if (native.admin1Code !== undefined) record.admin1Code = native.admin1Code;
  record.englishComponentHints = { ...(record.englishComponentHints || {}), ...en };
  record.chineseComponentHints = { ...(record.chineseComponentHints || {}), ...zh };
  return Object.keys(native).length > 0;
};

// The pool audit's polygon rule, applied once every correction has run: a snapshot whose regions were assigned by
// polygon must carry this record's polygon, and a mixed-level country's region must agree with it.
const polygonRegionIssue = (record, shard, materialized, geocoder) => {
  const countryCode = shard.countryCode;
  if (!materialized.regionsAssigned) return '';
  if (!record.administrativeRegion) return 'region_unverified';
  if (!mixedLevelCountries.has(countryCode) || !geocoder?.regionsById?.size) return '';
  return administrativeNamesOf(geocoder, countryCode).regionInBoundary(record.components, record.administrativeRegion,
    { postcode: record.components.postcode, latitude: record.latitude, longitude: record.longitude }) ? 'region_boundary' : '';
};

// Fills empty admin fields via catalog reverse-geocoding, then enforces the
// country's minimum administrative completeness. Returns false to drop the record.
const enrichAndValidate = (record, geocoder, countryCode, rebuildFormattedAddress) => {
  const components = record.components;
  const streetLevel = record.matchLevel === 'street';
  if (countryCode !== 'CN') clearInvalidLocality(record, countryCode);
  if (countryCode !== 'CN' && ['locality', 'postalLocality'].some((field) => /[,，;]/u.test(String(components[field] || '')))) {
    Object.assign(components, splitConcatenatedLocality(countryCode, components, (value) => Boolean(geocoder?.isKnownCity?.(value))));
    record.locality = components.locality || '';
    record.postalLocality = components.postalLocality || '';
    record.district = components.district || record.district || '';
  }
  if (geoAnchorCountries.has(countryCode) && geocoder?.hierarchyReady) {
    // Cross-border source label guard: china.pbf carries Taiwan/HK/Macau points.
    const sourceRegion = `${components.admin1 || ''} ${record.admin1 || ''}`;
    if (countryCode === 'CN') {
      if (/香港|澳門|澳门|台湾|臺灣|hong\s?kong|macau|macao|taiwan/iu.test(sourceRegion)) return false;
      // Russian/Mongolian border streets leak Cyrillic; a CN street is never Cyrillic.
      if (/[Ѐ-ӿ]/u.test(`${components.street || ''} ${components.buildingName || ''}`)) return false;
    }
    const anchored = geocoder.resolveHierarchy(Number(record.latitude), Number(record.longitude), {
      sourceAdmin1: components.admin1 || record.admin1 || ''
    });
    // No city-tier anchor within range => point is off-grid or cross-border; drop.
    if (!anchored) return false;
    components.admin1 = anchored.admin1;
    components.admin1Code = anchored.admin1Code || components.admin1Code || '';
    components.locality = anchored.city;
    components.postalLocality = anchored.city;
    if (anchored.district) {
      components.district = anchored.district;
      components.dependentLocality = anchored.district;
      record.district = anchored.district;
    } else {
      components.district = '';
      components.dependentLocality = '';
      record.district = '';
    }
    record.englishComponentHints = {
      ...(record.englishComponentHints || {}),
      admin1: anchored.admin1En, locality: anchored.cityEn,
      ...(anchored.districtEn ? { district: anchored.districtEn } : {})
    };
    record.chineseComponentHints = {
      ...(record.chineseComponentHints || {}),
      admin1: anchored.admin1Zh || anchored.admin1, locality: anchored.cityZh || anchored.city,
      ...(anchored.districtZh || anchored.district ? { district: anchored.districtZh || anchored.district } : {})
    };
    record.admin1 = components.admin1;
    record.admin1Code = components.admin1Code;
    record.locality = components.locality;
    record.postalLocality = components.postalLocality;
    // OSM name tags sometimes hold "中文 English" in one value; keep the Han part
    // as native and route the Latin part to the English hint (Han-script countries only).
    if (countryCode === 'CN' || countryCode === 'TW') {
      for (const field of ['street', 'buildingName']) {
        const value = String(components[field] || '').trim();
        const mixed = value.match(/^([^A-Za-z]*\p{Script=Han}[^A-Za-z]*)\s+([A-Za-z][A-Za-z' .’-]+)$/u);
        if (mixed) {
          components[field] = mixed[1].trim();
          record.englishComponentHints[field] = record.englishComponentHints[field] || mixed[2].trim();
          if (field === 'street') record.street = components.street;
          if (field === 'buildingName') record.buildingName = components.buildingName;
        }
      }
    }
    if (rebuildFormattedAddress) record.formattedAddress = rebuildFormattedAddress(components, countryCode);
    const policy = requiredAdminFields[countryCode] || { region: false, city: false };
    if (policy.region && !hasRegion(components)) return false;
    if (policy.city && !hasCity(components)) return false;
    if (policy.district && !(components.district || '').trim()) return false;
    return true;
  }
  // Region polygons: a point outside every first-level region is not in the country; a conflicting or unknown source
  // region is replaced by the region that contains the point.
  if (record.administrativeRegion?.outside) return false;
  const region = correctedRegion(countryCode, components, record.administrativeRegion, [...(geocoder?.regionsById?.values() || [])])
    || (mixedLevelCountries.has(countryCode) && geocoder?.regionsById?.size ? administrativeNamesOf(geocoder, countryCode)
      .regionInBoundary(components, record.administrativeRegion, { postcode: components.postcode, latitude: record.latitude, longitude: record.longitude })
      : null)
    || (administrativeNameCountries(countryCode) && geocoder?.regionsById?.size
      ? administrativeNamesOf(geocoder, countryCode).unrecognizedRegion(components, record.administrativeRegion, record) : null)
    || (countryCode === 'SG' ? singaporeRegion([...(geocoder?.regionsById?.values() || [])])(components) : null);
  if (region) {
    components.admin1 = region.admin1;
    components.admin1Code = region.admin1Code;
    record.admin1 = region.admin1;
    record.admin1Code = region.admin1Code;
    record.englishComponentHints = { ...(record.englishComponentHints || {}), admin1: region.admin1En };
    if (region.admin1Zh) record.chineseComponentHints = { ...(record.chineseComponentHints || {}), admin1: region.admin1Zh };
    if (rebuildFormattedAddress) record.formattedAddress = rebuildFormattedAddress(components, countryCode);
  }
  const regionFromBoundary = Boolean(record.administrativeRegion?.code) && regionCorrectionCountries.has(countryCode);
  const softFix = softLocalityFixes[countryCode];
  if (softFix) {
    const locality = String(components.locality || '').trim();
    if (locality && softFix.demote.test(locality)) {
      if (streetLevel) return false;
      // Preserve the fine-grained name for sampling-bucket diversity before replacing.
      record.samplingLocality = locality;
      let replacement = '';
      if (softFix.replaceWith === 'admin1') {
        replacement = String(components.admin1 || record.admin1 || '').trim();
      } else if (softFix.replaceWith === 'anchor' && geocoder?.hierarchyReady) {
        const anchored = geocoder.resolveHierarchy(Number(record.latitude), Number(record.longitude), {
          sourceAdmin1: components.admin1 || record.admin1 || ''
        });
        const city = String(anchored?.city || '').trim();
        replacement = city && !softFix.demote.test(city) ? city : '';
      }
      if (!replacement) return false;
      components.locality = replacement;
      if (components.postalLocality && softFix.demote.test(components.postalLocality)) {
        components.postalLocality = replacement;
      }
      record.locality = replacement;
      if (record.postalLocality && softFix.demote.test(record.postalLocality)) record.postalLocality = replacement;
      if (rebuildFormattedAddress) record.formattedAddress = rebuildFormattedAddress(components, countryCode);
    }
  }
  if (catalogAnchoredAdmin1Countries.has(countryCode) && geocoder?.regions?.length && !regionFromBoundary) {
    const sourceAdmin1 = String(components.admin1 || '').trim();
    if (sourceAdmin1 && !matchesCatalogRegion(geocoder, sourceAdmin1)) {
      if (streetLevel) return false;
      const region = geocoder.nearestRegion(Number(record.latitude), Number(record.longitude), 10);
      if (!region) return false;
      components.admin1 = region.native_name || region.name || '';
      components.admin1Code = region.code || '';
      record.admin1 = components.admin1;
      record.admin1Code = components.admin1Code;
      record.englishComponentHints = { ...(record.englishComponentHints || {}), admin1: region.name || components.admin1 };
      if (region.zh_name) {
        record.chineseComponentHints = { ...(record.chineseComponentHints || {}), admin1: region.zh_name };
      }
      if (rebuildFormattedAddress) record.formattedAddress = rebuildFormattedAddress(components, countryCode);
    }
  }
  if (geocoder?.available && !streetLevel) {
    const filled = geocoder.lookup(record);
    let enriched = false;
    if (filled.admin1 && (!components.admin1 || filled.replaceRegion)) {
      components.admin1 = filled.admin1;
      if (filled.admin1Code) components.admin1Code = filled.admin1Code;
      record.englishComponentHints = record.englishComponentHints || {};
      if (filled.admin1En) record.englishComponentHints.admin1 = filled.admin1En;
      if (filled.admin1Zh) record.chineseComponentHints = { ...(record.chineseComponentHints || {}), admin1: filled.admin1Zh };
      enriched = true;
    }
    if (filled.locality && (!components.locality || filled.replaceCity)) {
      components.locality = filled.locality;
      if (filled.replaceCity && components.postalLocality) components.postalLocality = filled.locality;
      record.englishComponentHints = record.englishComponentHints || {};
      if (filled.localityEn) record.englishComponentHints.locality = filled.localityEn;
      if (filled.localityZh) record.chineseComponentHints = { ...(record.chineseComponentHints || {}), locality: filled.localityZh };
      enriched = true;
    }
    if (enriched) {
      record.admin1 = components.admin1 || '';
      record.admin1Code = components.admin1Code || record.admin1Code || '';
      record.locality = components.locality || '';
      if (rebuildFormattedAddress) record.formattedAddress = rebuildFormattedAddress(components, countryCode);
    }
  }
  if (requiresAdminCode(countryCode) && !String(components.admin1Code || '').trim()) {
    if (countryCode === 'US') components.admin1Code = canonicalUsSubdivisionCode(components.admin1 || '');
    // Italian codes are province siglas below the named region, so only a street-level region name is matched there.
    const provinceCode = countryCode === 'IT';
    if (!components.admin1Code && components.admin1 && (!provinceCode || streetLevel) && geocoder?.regionsById) {
      const names = admin1Variants(components.admin1);
      const regions = [...geocoder.regionsById.values()].filter((region) =>
        [region.code, region.name, region.native_name].some((value) =>
          admin1Variants(value).some((key) => names.includes(key))));
      if (regions.length === 1) components.admin1Code = regions[0].code || '';
    }
    // Coordinates decide the code only when the source names no region.
    if (!components.admin1Code && (!components.admin1 || provinceCode) && !streetLevel && geocoder?.nearestRegion) {
      const region = geocoder.nearestRegion(Number(record.latitude), Number(record.longitude), 10);
      if (region?.code) components.admin1Code = region.code;
    }
    record.admin1Code = components.admin1Code || '';
  }
  if (applyAdministrativeBoundary(record) && rebuildFormattedAddress) {
    record.formattedAddress = rebuildFormattedAddress(components, countryCode);
  }
  if (applyAdministrativeNames(record, geocoder, countryCode) && rebuildFormattedAddress) {
    record.formattedAddress = rebuildFormattedAddress(components, countryCode);
  }
  const policy = requiredAdminFields[countryCode] || { region: false, city: false };
  // A region no catalog spelling, polygon or territory names is not published: its text is wrong (전남특별자치도).
  if (administrativeNameCountries(countryCode) && geocoder?.regionsById?.size && String(components.admin1 || '').trim()
    && !administrativeNamesOf(geocoder, countryCode).regionRecognized(components)) return false;
  if (policy.region && !hasRegion(components)) return false;
  if (policy.city && !hasCity(components)) return false;
  if (policy.district && !(components.district || '').trim()) return false;
  // Cross-border leakage guard: a mainland-China record must never carry an HK/Macau region.
  if (countryCode === 'CN') {
    const region = `${components.admin1 || ''} ${record.admin1 || ''}`;
    if (/香港|澳門|澳门|hong\s?kong|macau|macao/iu.test(region)) return false;
  }
  return true;
};
const boundaryNameKey = (value) => String(value || '').normalize('NFKC').toLocaleLowerCase('und').replace(/[\s\p{P}]/gu, '');
// Official/open boundary polygons only fill administrative fields the source left empty
// (or a district that merely repeats the city); source values are never overwritten.
export const applyAdministrativeBoundary = (record) => {
  const boundary = record.administrativeBoundary;
  if (!boundary || typeof boundary !== 'object') return false;
  const components = record.components;
  const hints = { ...(record.englishComponentHints || {}) };
  let changed = false;
  const city = boundary.locality;
  if (city?.name && !String(components.locality || '').trim() && !String(components.postalLocality || '').trim()) {
    components.locality = city.name;
    components.postalLocality = city.name;
    record.locality = city.name;
    record.postalLocality = city.name;
    if (city.nameEn && city.nameEn !== city.name) hints.locality = city.nameEn;
    changed = true;
  }
  const district = String(components.district || '').trim();
  const locality = String(components.locality || components.postalLocality || '').trim();
  const found = boundary.district;
  const repeatsCity = district && locality && boundaryNameKey(district) === boundaryNameKey(locality);
  if (found?.name && (!district || repeatsCity) && boundaryNameKey(found.name) !== boundaryNameKey(locality)) {
    components.district = found.name;
    record.district = found.name;
    if (found.nameEn && found.nameEn !== found.name) hints.district = found.nameEn;
    else delete hints.district;
    changed = true;
  }
  if (changed) record.englishComponentHints = hints;
  return changed;
};
const applyQualityGate = (record, countryCode, rebuildFormattedAddress) => {
  const hierarchy = validateAdministrativeHierarchy({
    countryCode, admin1: record.components.admin1, admin1Code: record.components.admin1Code,
    locality: record.components.locality
  });
  if (!hierarchy.valid) return { valid: false, reasons: [hierarchy.reason], components: record.components };
  // A missing postcode is filled by the post-import inference or the row is retired before it is published.
  const quality = validateAddressQuality({
    countryCode, components: record.components, latitude: record.latitude, longitude: record.longitude,
    matchLevel: record.matchLevel, requirePostcode: false
  });
  if (!quality.valid) return quality;
  const contract = validateAddressContract(countryCode, record.components, {
    strict: true, matchLevel: record.matchLevel, requirePostcode: false
  });
  if (!contract.valid) return { valid: false, reasons: contract.reasons, components: record.components };
  record.components = quality.components;
  for (const field of ['admin1', 'admin1Code', 'locality', 'postalLocality', 'district', 'postcode', 'street', 'houseNumber', 'buildingName', 'unit']) {
    record[field] = quality.components[field] || '';
  }
  if (rebuildFormattedAddress) record.formattedAddress = rebuildFormattedAddress(record.components, countryCode);
  return quality;
};
export const ADDRESS_IMPORT_REVISION = 'strict-residential-v22';

export class SourceQualityError extends Error {
  constructor(shardId, retrySignature, rejectionReasons, metrics = {}) {
    super(`Shard ${shardId} produced no valid addresses`);
    this.name = 'SourceQualityError';
    this.code = 'SOURCE_QUALITY_FAILED';
    this.failureSignature = retrySignature;
    this.rejectionReasons = rejectionReasons;
    this.metrics = { ...metrics, rejectionReasons };
  }
}

export class SnapshotQualityError extends Error {
  constructor(shardId, failures, metrics, failureSignature = '') {
    super(`Shard ${shardId} failed snapshot quality gates: ${failures.join('; ')}`);
    this.name = 'SnapshotQualityError';
    this.code = 'SNAPSHOT_QUALITY_FAILED';
    this.failureSignature = failureSignature;
    this.rejectionReasons = metrics.rejectionReasons || {};
    this.metrics = metrics;
  }
}

const coverageKey = (record) => [
  'sync', record.countryCode, cleanKey(record.admin1Code || record.admin1) || '*',
  cleanKey(record.postalLocality || record.locality) || '*', record.propertyType
].join(':');

const variants = (record) => ({
  components: Object.fromEntries(['native', 'en', 'zh-CN'].map((language) => [language, record.localizations[language].components])),
  addresses: Object.fromEntries(['native', 'en', 'zh-CN'].map((language) => [language, record.localizations[language].formattedAddress]))
});

// Returns the ids among the records that were already in the published pool before this import.
const preserveLocalizations = async (database, records) => {
  const rows = (await database.prepare(`SELECT id,active,native_language,component_variants_json,address_variants_json
    FROM address_pool WHERE id IN (${records.map(() => '?').join(',')}) FOR UPDATE`)
    .bind(...records.map((record) => record.id)).all()).results;
  const previous = new Map(rows.map((row) => [row.id, row]));
  const active = new Set(rows.filter((row) => Number(row.active) === 1).map((row) => row.id));
  for (const record of records) {
    const row = previous.get(record.id);
    if (!row || row.native_language !== record.nativeLanguage) continue;
    const stored = JSON.parse(row.component_variants_json);
    const native = record.localizations.native.components;
    if (!stored.native || [...new Set([...Object.keys(native), ...Object.keys(stored.native)])]
      .some((field) => String(native[field] ?? '') !== String(stored.native[field] ?? ''))) continue;
    const addresses = JSON.parse(row.address_variants_json);
    for (const language of ['en', 'zh-CN']) {
      const components = stored[language];
      if (!components || !addresses[language] || !semanticAddressFields.every((field) => !native[field]
        || usableAddressTranslation(components[field], language, native[field], field))) continue;
      record.localizations[language] = { components, formattedAddress: addresses[language], source: 'validated-previous-source' };
    }
  }
  return active;
};

const sourceStatement = (database, shard, observedAt) => database.prepare(`
  INSERT INTO address_sources(
    id,name,homepage_url,data_url,license_code,license_name,license_url,attribution_text,
    attribution_url,terms_url,share_alike,notice_required,redistribution_allowed,metadata_json,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(id) DO UPDATE SET
    name=excluded.name,data_url=excluded.data_url,license_code=excluded.license_code,
    license_name=excluded.license_name,license_url=excluded.license_url,
    attribution_text=excluded.attribution_text,attribution_url=excluded.attribution_url,
    terms_url=excluded.terms_url,share_alike=excluded.share_alike,
    notice_required=excluded.notice_required,redistribution_allowed=excluded.redistribution_allowed,
    metadata_json=excluded.metadata_json,updated_at=excluded.updated_at
`).bind(
  shard.source.id, shard.source.name, shard.source.homepageUrl, shard.source.dataUrl,
  shard.source.licenseCode, shard.source.licenseName, shard.source.licenseUrl,
  shard.source.attributionText, shard.source.attributionUrl, shard.source.termsUrl,
  Number(Boolean(shard.source.shareAlike)), Number(Boolean(shard.source.noticeRequired)),
  Number(shard.source.redistributionAllowed !== false), JSON.stringify({
    adapter: shard.source.adapter, recordSources: shard.source.recordSources || {}
  }),
  observedAt, observedAt
);

const datasetStatement = (database, { datasetId, datasetVersion, shard, discovery, materialized, observedAt }) => database.prepare(`
  INSERT INTO address_datasets(
    id,source_id,country_code,version,published_at,retrieved_at,imported_at,input_checksum,format,
    license_code,license_name,license_url,attribution_text,attribution_url,terms_url,
    share_alike,notice_required,redistribution_allowed,accepted_count,rejected_count,active_count,source_complete,status
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending')
  ON CONFLICT(id) DO UPDATE SET version=excluded.version,published_at=excluded.published_at,
    retrieved_at=excluded.retrieved_at,imported_at=excluded.imported_at,input_checksum=excluded.input_checksum,
    format=excluded.format,source_complete=excluded.source_complete,status='pending'
`).bind(
  datasetId, shard.source.id, shard.countryCode, datasetVersion, discovery.publishedAt || null,
  observedAt, observedAt, materialized.checksum, materialized.format,
  shard.source.licenseCode, shard.source.licenseName, shard.source.licenseUrl,
  shard.source.attributionText, shard.source.attributionUrl, shard.source.termsUrl,
  Number(Boolean(shard.source.shareAlike)), Number(Boolean(shard.source.noticeRequired)),
  Number(shard.source.redistributionAllowed !== false), 0, 0, 0,
  Number(materialized.sourceComplete !== false)
);

const addressStatements = (database, records, context) => {
  const addressBindings = [];
  const addressRows = records.map((record) => {
    const localized = variants(record);
    const coverage = coverageKey(record);
    // A row still missing a required postcode is stored unpublished; the post-import inference publishes it once filled.
    const pending = postcodeRequired(record.countryCode) && !String(record.postcode || '').trim();
    addressBindings.push(
      record.id, record.canonicalKey, record.countryCode, record.admin1, record.admin1Code, record.locality, record.postalLocality,
      record.district, record.postcode, record.street, record.houseNumber, record.buildingName,
      record.latitude, record.longitude, record.nativeLanguage, JSON.stringify(localized.components),
      JSON.stringify(localized.addresses), cleanKey(record.admin1), cleanKey(record.admin1Code),
      cleanKey(record.locality), cleanKey(record.postalLocality), cleanKey(record.district), postcodeKey(record.postcode),
      record.propertyType, record.qualityScore, context.datasetId, coverage, randomKey(record.canonicalHash), pending ? 0 : 1,
      context.observedAt, context.observedAt, context.expiresAt,
      pending ? `publication-validation:${POSTCODE_REQUIRED_REVISION}:${context.observedAt}` : null,
      record.matchLevel || (record.unit ? 'subpremise' : 'premise')
    );
    return '(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)';
  });
  // Rows retired by publication validation return only through translation recovery after revalidation, except rows
  // retired for a missing postcode, which follow the postcode of the new import.
  const address = database.prepare(`
    INSERT INTO address_pool(
      id,canonical_key,country_code,admin1,admin1_code,locality,postal_locality,district,postcode,street,house_number,
      building_name,latitude,longitude,native_language,component_variants_json,address_variants_json,
      admin1_key,admin1_code_key,locality_key,postal_locality_key,district_key,postcode_key,property_type,
      quality_score,generation,coverage,random_key,active,first_seen_at,last_seen_at,expires_at,retired_at,match_level
    ) VALUES ${addressRows.join(',')}
    ON CONFLICT(id) DO UPDATE SET
      canonical_key=excluded.canonical_key,
      admin1=excluded.admin1,admin1_code=excluded.admin1_code,locality=excluded.locality,
      postal_locality=excluded.postal_locality,district=excluded.district,postcode=excluded.postcode,
      street=excluded.street,house_number=excluded.house_number,building_name=excluded.building_name,
      latitude=excluded.latitude,longitude=excluded.longitude,native_language=excluded.native_language,
      component_variants_json=excluded.component_variants_json,address_variants_json=excluded.address_variants_json,
      admin1_key=excluded.admin1_key,admin1_code_key=excluded.admin1_code_key,
      locality_key=excluded.locality_key,postal_locality_key=excluded.postal_locality_key,
      district_key=excluded.district_key,postcode_key=excluded.postcode_key,
      property_type=excluded.property_type,quality_score=GREATEST(address_pool.quality_score,excluded.quality_score),
      generation=excluded.generation,coverage=excluded.coverage,last_seen_at=excluded.last_seen_at,
      expires_at=excluded.expires_at,match_level=excluded.match_level,
      active=CASE WHEN address_pool.retired_at LIKE 'publication-validation:%'
        AND address_pool.retired_at NOT LIKE 'publication-validation:postcode-required-%' THEN 0 ELSE excluded.active END,
      retired_at=CASE WHEN address_pool.retired_at LIKE 'publication-validation:%'
        AND address_pool.retired_at NOT LIKE 'publication-validation:postcode-required-%' THEN address_pool.retired_at ELSE excluded.retired_at END
  `).bind(...addressBindings);
  const evidenceBindings = [];
  const evidenceRows = records.flatMap((record) => {
    const evidence = [{ type: 'address_existence', sourceRecordId: record.sourceRecordId, recordUrl: record.sourceRecordUrl }];
    if ((record.propertyType === 'residential' || record.propertyType === 'apartment') && record.residentialSourceRecordId) {
      evidence.push({ type: 'residential_use', sourceRecordId: record.residentialSourceRecordId,
        recordUrl: record.residentialSourceRecordUrl || record.sourceRecordUrl });
    }
    return evidence.map(({ type, sourceRecordId, recordUrl }) => {
        evidenceBindings.push(
          context.hash(`${context.datasetId}\u001f${record.id}\u001f${sourceRecordId}\u001f${type}`),
          record.id, context.datasetId, sourceRecordId, recordUrl || context.discovery.dataUrl || '', context.observedAt,
          type, context.observedAt
        );
        return '(?,?,?,?,?,?,?,0,1,?)';
      });
  });
  const evidence = database.prepare(`
      INSERT INTO address_pool_evidence(
        id,address_id,dataset_id,source_record_id,record_url,observed_at,evidence_type,is_primary,is_current,created_at
      ) VALUES ${evidenceRows.join(',')}
      ON CONFLICT(id) DO UPDATE SET observed_at=excluded.observed_at,is_current=1
    `).bind(...evidenceBindings);
  return [address, evidence];
};

export class PostgresAddressImporter {
  constructor({ database, normalizeRecord, localizeRecords, hash, reverseGeocoder, rebuildFormattedAddress }) {
    this.database = database;
    this.normalizeRecord = normalizeRecord;
    this.localizeRecords = localizeRecords;
    this.hash = hash;
    this.reverseGeocoder = reverseGeocoder;
    this.rebuildFormattedAddress = rebuildFormattedAddress;
  }

  async importShard({ shard, discovery, materialized, maxRecords, sourceMaxRecords = maxRecords, perLocality, policy, batchSize = 800, signal }) {
    const checkpoint = () => signal?.throwIfAborted();
    checkpoint();
    const activePolicy = policy || {
      targetCount: maxRecords,
      levelLimits: [maxRecords, perLocality, perLocality, perLocality],
      overrides: new Map()
    };
    const policyHash = this.hash(JSON.stringify({
      levelLimits: activePolicy.levelLimits,
      sourceMaxRecords,
      overrides: [...activePolicy.overrides].sort(([left], [right]) => left.localeCompare(right)),
      floors: {
        level1Min: Number(activePolicy.level1Min) || 0,
        level2Min: Number(activePolicy.level2Min) || 0,
        minPerNode: Number(activePolicy.minPerNode) || 0,
        nodes: [...(activePolicy.nodeFloors || new Map())].sort(([left], [right]) => left.localeCompare(right))
      }
    })).slice(0, 8);
    const sourceComplete = materialized.sourceComplete !== false;
    const snapshotMode = materialized.snapshotMode
      || (materialized.authoritativeSnapshot === true ? 'authoritative' : 'merge');
    const generatedDatasetId = `${shard.id}-${String(discovery.version).replace(/[^a-zA-Z0-9._-]/gu, '_')}-${materialized.checksum.slice(0, 12)}-${ADDRESS_IMPORT_REVISION}-${policyHash}`;
    const datasetVersion = `${String(discovery.version)}-${ADDRESS_IMPORT_REVISION}-${policyHash}`;
    const existingIdentity = await this.database.prepare(`SELECT id,status,active_count,rejected_count,source_complete
      FROM address_datasets WHERE source_id=? AND country_code=? AND version LIKE ? AND input_checksum=?
      ORDER BY imported_at DESC LIMIT 1`).bind(
      shard.source.id, shard.countryCode, `${String(discovery.version)}-%`, materialized.checksum
    ).first();
    checkpoint();
    const datasetId = existingIdentity?.id ? String(existingIdentity.id) : generatedDatasetId;
    const existing = await this.database.prepare("SELECT status,active_count,rejected_count,source_complete FROM address_datasets WHERE id=?").bind(datasetId).first();
    if (existing?.status === 'active' && datasetId === generatedDatasetId
      && Number(existing.source_complete) === Number(sourceComplete)) {
      return {
        datasetId,
        acceptedCount: Number(existing.active_count),
        rejectedCount: Number(existing.rejected_count),
        rejectionReasons: {},
        metrics: null,
        skipped: true
      };
    }

    const seen = new Set();
    const candidates = [];
    let rejectedCount = 0;
    const rejectionReasons = new Map();
    const reject = (reasons) => {
      rejectedCount += 1;
      for (const reason of reasons) rejectionReasons.set(reason, (rejectionReasons.get(reason) || 0) + 1);
    };
    const geocoder = this.reverseGeocoder ? await this.reverseGeocoder(shard.countryCode) : null;
    checkpoint();
    for await (const value of readJsonLines(materialized.file, signal)) {
      checkpoint();
      const record = this.normalizeRecord(value, shard, materialized.format);
      if (!record) {
        reject(['invalid_source_record']);
        continue;
      }
      if (!enrichAndValidate(record, geocoder, shard.countryCode, this.rebuildFormattedAddress)) {
        reject(['invalid_administrative_hierarchy']);
        continue;
      }
      const quality = applyQualityGate(record, shard.countryCode, this.rebuildFormattedAddress);
      if (!quality.valid) {
        reject(quality.reasons);
        continue;
      }
      const polygonIssue = polygonRegionIssue(record, shard, materialized, geocoder);
      if (polygonIssue) {
        reject([polygonIssue]);
        continue;
      }
      if (shard.countryCode === 'CN'
        && (!['residential', 'apartment'].includes(record.propertyType) || !record.residentialSourceRecordId)) {
        reject(['missing_residential_evidence']);
        continue;
      }
      if (record.matchLevel === 'street') {
        record.canonicalHash = this.hash(streetAddressKey(shard.countryCode, record.components));
        record.id = `addr-${record.canonicalHash.slice(0, 40)}`;
      }
      record.canonicalKey = addressCanonicalKey(shard.countryCode, record.components, record.matchLevel);
      if (seen.has(record.canonicalKey)) { reject(['duplicate']); continue; }
      if (!record.residentialSourceRecordId && ['residential', 'apartment'].includes(record.propertyType)) {
        record.propertyType = 'unknown';
      }
      seen.add(record.canonicalKey);
      candidates.push(record);
    }
    candidates.sort((left, right) =>
      Number(Boolean(right.residentialSourceRecordId)) - Number(Boolean(left.residentialSourceRecordId))
      || Number(right.qualityScore || 0) - Number(left.qualityScore || 0)
      || left.canonicalHash.localeCompare(right.canonicalHash));
    // Popular-city exports fill each popular metro area's share first, in the exporter's rank order; the remaining
    // budget keeps the balanced node policy (baselines, region minimums, round-robin).
    const popular = candidates.filter((record) => record.samplingTier === 1)
      .sort((left, right) => left.samplingRank - right.samplingRank).slice(0, sourceMaxRecords);
    const popularIds = new Set(popular.map((record) => record.canonicalKey));
    let records = [...popular, ...applyHierarchicalQuota(candidates.filter((record) => !popularIds.has(record.canonicalKey)), {
      ...activePolicy,
      targetCount: Math.max(0, sourceMaxRecords - popular.length),
      maxRecords: Math.max(0, sourceMaxRecords - popular.length)
    })];
    const canonicalKeys = [...new Set(records.map((record) => record.canonicalKey).filter(Boolean))];
    const existingByKey = new Map();
    const ambiguousKeys = new Set();
    for (let offset = 0; offset < canonicalKeys.length; offset += 500) {
      const keys = canonicalKeys.slice(offset, offset + 500);
      const rows = (await this.database.prepare(`SELECT id,canonical_key FROM address_pool
        WHERE country_code=? AND canonical_key IN (${keys.map(() => '?').join(',')})`)
        .bind(shard.countryCode, ...keys).all()).results;
      for (const row of rows) {
        if (existingByKey.has(row.canonical_key)) ambiguousKeys.add(row.canonical_key);
        else existingByKey.set(row.canonical_key, row.id);
      }
    }
    for (const record of records) {
      if (!ambiguousKeys.has(record.canonicalKey) && existingByKey.has(record.canonicalKey)) {
        record.id = existingByKey.get(record.canonicalKey);
      }
    }
    // One address row carries one primary evidence per dataset; later records resolving to the same row are duplicates.
    const assignedIds = new Set();
    records = records.filter((record) => {
      if (assignedIds.has(record.id)) { reject(['duplicate']); return false; }
      assignedIds.add(record.id);
      return true;
    });
    // A postcode derived earlier (boundary, catalog or neighbours) stays when the source still has none.
    const missingPostcode = records.filter((record) => !record.postcode);
    for (let offset = 0; offset < missingPostcode.length; offset += 500) {
      const batch = missingPostcode.slice(offset, offset + 500);
      const inferred = new Map((await this.database.prepare(`SELECT address_id,postcode FROM address_postcode_inference
        WHERE postcode<>'' AND address_id IN (${batch.map(() => '?').join(',')})`).bind(...batch.map((record) => record.id)).all()
        .catch(() => ({ results: [] }))).results.map((row) => [row.address_id, row.postcode]));
      for (const record of batch) {
        const postcode = inferred.get(record.id);
        if (!postcode) continue;
        record.postcode = postcode;
        record.components = { ...record.components, postcode };
        if (this.rebuildFormattedAddress) record.formattedAddress = this.rebuildFormattedAddress(record.components, shard.countryCode);
      }
    }
    if (!records.length) {
      throw new SourceQualityError(
        shard.id,
        discovery.failureSignature || '',
        Object.fromEntries(rejectionReasons),
        { candidateCount: 0, rejectedCount }
      );
    }

    const localityCounts = new Map();
    for (const record of records) {
      const locality = cleanKey(record.samplingLocality || record.components.locality
        || record.components.postalLocality || record.postcode || '*');
      localityCounts.set(locality, (localityCounts.get(locality) || 0) + 1);
    }

    const localized = [];
    for (let offset = 0; offset < records.length; offset += batchSize) {
      checkpoint();
      localized.push(...await this.localizeRecords(records.slice(offset, offset + batchSize), { signal }));
      checkpoint();
    }
    const authoritativeReplacement = sourceComplete && snapshotMode === 'authoritative'
      && materialized.capped !== true && materialized.sampled !== true && materialized.truncated !== true
      && !rejectedCount && records.length === candidates.length && localized.length === records.length;
    const candidateAdmin1Count = new Set(localized
      .map((record) => cleanKey(record.admin1Code || record.admin1 || record.district))
      .filter(Boolean)).size;
    const previous = await this.database.prepare(`SELECT dataset.id,dataset.version,dataset.active_count,
      COUNT(DISTINCT coalesce(nullif(trim(pool.admin1_key),''),nullif(trim(pool.district_key),''))) AS admin1_count
      FROM address_datasets dataset
      LEFT JOIN address_pool_evidence evidence ON evidence.dataset_id=dataset.id
        AND evidence.evidence_type='address_existence' AND evidence.is_current=1
      LEFT JOIN address_pool pool ON pool.id=evidence.address_id AND pool.active=1
      WHERE dataset.source_id=? AND dataset.country_code=? AND dataset.status='active'
        AND dataset.source_complete=?
        AND (?=1 OR dataset.version=?)
      GROUP BY dataset.id,dataset.version,dataset.active_count,dataset.imported_at
      ORDER BY dataset.imported_at DESC LIMIT 1`
    ).bind(shard.source.id, shard.countryCode, Number(sourceComplete), Number(sourceComplete), datasetVersion).first();
    const configuredGate = shard.qualityGate || {};
    const effectiveMaxRecords = sourceMaxRecords;
    const compactMinimum = shard.countryCode === 'SG' ? 50 : shard.countryCode === 'HK' ? 500 : 1_000;
    const defaultMinimumRecords = effectiveMaxRecords >= 1_000
      ? Math.max(10, Math.min(compactMinimum, Math.ceil(effectiveMaxRecords * 0.01))) : 1;
    const defaultMinimumAdmin1 = shard.countryCode === 'SG'
      ? 0 : effectiveMaxRecords >= 1_000 && shard.countryCode !== 'HK' ? 2 : 1;
    const minimumRecords = !sourceComplete ? 1 : configuredGate.minimumRecords
      ?? (previous ? Math.min(defaultMinimumRecords, Number(previous.active_count || 0) || 1) : 1);
    const minimumAdmin1 = !sourceComplete ? 0 : configuredGate.minimumAdmin1
      ?? (previous ? Math.min(defaultMinimumAdmin1, Number(previous.admin1_count || 0)) : Math.min(defaultMinimumAdmin1, 1));
    const minimumCountRatio = configuredGate.minimumCountRatio ?? DEFAULT_MINIMUM_RATIO;
    const minimumAdmin1Ratio = configuredGate.minimumAdmin1Ratio ?? DEFAULT_MINIMUM_RATIO;
    const metrics = {
      candidateCount: localized.length,
      candidateAdmin1Count,
      previousCount: Number(previous?.active_count || 0),
      previousAdmin1Count: Number(previous?.admin1_count || 0),
      minimumRecords,
      minimumAdmin1,
      minimumCountRatio,
      minimumAdmin1Ratio,
      importRevision: ADDRESS_IMPORT_REVISION,
      policyHash,
      replacementMode: authoritativeReplacement ? 'authoritative' : snapshotMode,
      rejectionReasons: Object.fromEntries([...rejectionReasons].sort(([left], [right]) => left.localeCompare(right)))
    };
    const failures = [];
    if (metrics.candidateCount < minimumRecords) failures.push(`count ${metrics.candidateCount} < ${minimumRecords}`);
    if (metrics.candidateAdmin1Count < minimumAdmin1) failures.push(`admin1 coverage ${metrics.candidateAdmin1Count} < ${minimumAdmin1}`);
    // Ratio gates only compare snapshots produced by the same import methodology; a revision
    // change intentionally replaces the sampling/enrichment rules, so the old counts are not a baseline.
    const sameRevision = Boolean(
      previous?.id
      && (sourceComplete
        ? String(previous.version || '').includes(`-${ADDRESS_IMPORT_REVISION}-`)
        : String(previous.version || '') === datasetVersion)
      && String(previous.id).endsWith(`-${ADDRESS_IMPORT_REVISION}-${policyHash}`)
    );
    if (sameRevision) {
      const previousCountFloor = Math.ceil(Math.min(
        metrics.previousCount * minimumCountRatio,
        effectiveMaxRecords * minimumCountRatio
      ));
      if (metrics.previousCount && metrics.candidateCount < previousCountFloor) {
        failures.push(`count ${metrics.candidateCount} < capped previous floor ${previousCountFloor}`);
      }
      if (metrics.previousAdmin1Count && metrics.candidateAdmin1Count < Math.ceil(metrics.previousAdmin1Count * minimumAdmin1Ratio)) {
        failures.push(`admin1 ratio ${(metrics.candidateAdmin1Count / metrics.previousAdmin1Count).toFixed(3)} < ${minimumAdmin1Ratio}`);
      }
    }
    if (failures.length) throw new SnapshotQualityError(shard.id, failures, metrics, discovery.failureSignature || '');
    checkpoint();
    const observedAt = new Date().toISOString();
    const context = { datasetId, discovery, observedAt, expiresAt: null, hash: this.hash };
    // This import's own effect on the pool: rows it adds or reactivates minus rows it retires. Totals measured around
    // the run would also count addresses that translation publishing added meanwhile.
    const previouslyActive = new Set();
    let addedCount = 0;
    let reactivatedCount = 0;
    let retiredCount = 0;
    await this.database.transaction(async () => {
      checkpoint();
      await this.database.batch([
        sourceStatement(this.database, shard, observedAt),
        datasetStatement(this.database, { datasetId, datasetVersion, shard, discovery, materialized, observedAt })
      ]);
      checkpoint();
      for (let offset = 0; offset < localized.length; offset += batchSize) {
        checkpoint();
        const batch = localized.slice(offset, offset + batchSize);
        for (const id of await preserveLocalizations(this.database, batch)) previouslyActive.add(id);
        await this.database.batch(addressStatements(this.database, batch, context));
        checkpoint();
        await new Promise((resolve) => setImmediate(resolve));
      }
      checkpoint();
      const supersededDatasets = (await this.database.prepare(`SELECT id FROM address_datasets
        WHERE source_id=? AND country_code=? AND id<>? AND status IN ('pending','active')`)
        .bind(shard.source.id, shard.countryCode, datasetId).all()).results.map((row) => String(row.id));
      // Only addresses this import wrote or whose evidence it supersedes can change state; the rest of the country is left
      // alone, so a small shard no longer rewrites a whole large country inside one long transaction.
      const touched = new Set(localized.map((record) => record.id));
      if (authoritativeReplacement && supersededDatasets.length) {
        for (const row of (await this.database.prepare(`SELECT DISTINCT address_id FROM address_pool_evidence
          WHERE is_current=1 AND dataset_id IN (${placeholders(supersededDatasets)})`).bind(...supersededDatasets).all()).results) {
          touched.add(String(row.address_id));
        }
      }
      const touchedIds = [...touched].sort();
      const eachBatch = async (ids, work) => {
        for (let offset = 0; offset < ids.length; offset += batchSize) {
          checkpoint();
          await work(ids.slice(offset, offset + batchSize));
        }
      };
      await this.database.batch([
        this.database.prepare(`UPDATE address_pool_evidence SET is_primary=0
          WHERE is_primary=1 AND address_id IN (
            SELECT address_id FROM address_pool_evidence WHERE dataset_id=? AND evidence_type='address_existence'
          )`).bind(datasetId),
        // Primary flags are chosen per address below; one address can carry several source records in a dataset,
        // and flagging them all broke the one-primary-per-address index.
        this.database.prepare("UPDATE address_pool_evidence SET is_current=1 WHERE dataset_id=? AND evidence_type='address_existence'").bind(datasetId),
        this.database.prepare(`UPDATE address_pool_evidence SET is_primary=0,is_current=0
          WHERE dataset_id IN (
            SELECT id FROM address_datasets WHERE source_id=? AND country_code=? AND id<>? AND status IN ('pending','active')
          ) AND (?=1 OR address_id IN (
            SELECT refreshed.address_id FROM address_pool_evidence refreshed WHERE refreshed.dataset_id=?
          ))`).bind(shard.source.id, shard.countryCode, datasetId, Number(authoritativeReplacement), datasetId),
        this.database.prepare(`UPDATE address_datasets SET status='retired',active_count=0
          WHERE source_id=? AND country_code=? AND id<>? AND status IN ('pending','active')
            AND id NOT IN (SELECT DISTINCT evidence.dataset_id FROM address_pool_evidence evidence
              JOIN address_datasets current ON current.id=evidence.dataset_id
              WHERE evidence.is_current=1 AND current.source_id=? AND current.country_code=?)`)
          .bind(shard.source.id, shard.countryCode, datasetId, shard.source.id, shard.countryCode),
        this.database.prepare("UPDATE address_datasets SET status='active',accepted_count=?,rejected_count=?,source_complete=? WHERE id=?")
          .bind(localized.length, rejectedCount, Number(sourceComplete), datasetId)
      ]);
      const evidenceFor = (ids, statuses) => this.database.prepare(`SELECT candidate.id,candidate.address_id
        FROM address_pool_evidence candidate
        JOIN address_datasets dataset ON dataset.id=candidate.dataset_id
        JOIN address_sources source ON source.id=dataset.source_id
        WHERE candidate.address_id IN (${placeholders(ids)}) AND candidate.is_current=1
          AND candidate.evidence_type='address_existence' AND dataset.status IN (${placeholders(statuses)})
          AND dataset.redistribution_allowed=1 AND source.redistribution_allowed=1
        ORDER BY candidate.address_id,dataset.imported_at DESC,candidate.id`).bind(...ids, ...statuses).all();
      const statusChanged = [];
      await eachBatch(touchedIds, async (ids) => {
        const retained = new Set((await evidenceFor(ids, ['pending', 'active'])).results.map((row) => row.address_id));
        const unretained = ids.filter((id) => !retained.has(id));
        if (unretained.length) {
          const retired = await this.database.prepare(`UPDATE address_pool SET active=0,retired_at=?
            WHERE active=1 AND id IN (${placeholders(unretained)}) RETURNING id`).bind(observedAt, ...unretained).all();
          retiredCount += retired.results.length;
          statusChanged.push(...retired.results.map((row) => row.id));
        }
        // Rows retired by publication validation stay out of the pool even while their evidence is current.
        const invalid = await this.database.prepare(`UPDATE address_pool SET active=0,retired_at=?
          WHERE active=1 AND retired_at LIKE 'publication-validation:%' AND id IN (${placeholders(ids)}) RETURNING id`)
          .bind(observedAt, ...ids).all();
        retiredCount += invalid.results.length;
        statusChanged.push(...invalid.results.map((row) => row.id));
        const primaryEvidenceIds = new Set();
        const listed = new Set();
        for (const row of (await evidenceFor(ids, ['active'])).results) {
          if (listed.has(row.address_id)) continue;
          listed.add(row.address_id);
          primaryEvidenceIds.add(row.id);
        }
        // Only flags that change are written; rewriting every evidence row made large imports time out.
        const currentPrimaryIds = new Set((await this.database.prepare(`SELECT id FROM address_pool_evidence
          WHERE evidence_type='address_existence' AND is_primary=1 AND address_id IN (${placeholders(ids)})`)
          .bind(...ids).all()).results.map((row) => row.id));
        for (const [flag, changed] of [
          [0, [...currentPrimaryIds].filter((id) => !primaryEvidenceIds.has(id))],
          [1, [...primaryEvidenceIds].filter((id) => !currentPrimaryIds.has(id))]
        ]) {
          if (changed.length) await this.database.prepare(`UPDATE address_pool_evidence SET is_primary=?
            WHERE id IN (${placeholders(changed)})`).bind(flag, ...changed).run();
        }
        const listedIds = [...listed];
        if (!listedIds.length) return;
        const reactivated = await this.database.prepare(`UPDATE address_pool SET active=1,retired_at=NULL
          WHERE (retired_at IS NULL OR retired_at NOT LIKE 'publication-validation:%') AND active=0
            AND id IN (${placeholders(listedIds)}) RETURNING id`).bind(...listedIds).all();
        reactivatedCount += reactivated.results.length;
        statusChanged.push(...reactivated.results.map((row) => row.id));
        await this.database.prepare(`UPDATE address_pool SET retired_at=NULL
          WHERE active=1 AND retired_at IS NOT NULL AND retired_at NOT LIKE 'publication-validation:%'
            AND id IN (${placeholders(listedIds)})`).bind(...listedIds).run();
      });
      const countedDatasets = new Set([datasetId, ...supersededDatasets]);
      await eachBatch(statusChanged, async (ids) => {
        for (const row of (await this.database.prepare(`SELECT DISTINCT dataset_id FROM address_pool_evidence
          WHERE is_current=1 AND address_id IN (${placeholders(ids)})`).bind(...ids).all()).results) countedDatasets.add(String(row.dataset_id));
      });
      for (const id of countedDatasets) {
        checkpoint();
        const activeCount = await this.database.prepare(`SELECT COUNT(DISTINCT evidence.address_id) AS total
          FROM address_pool_evidence evidence JOIN address_pool address ON address.id=evidence.address_id
          JOIN address_datasets dataset ON dataset.id=evidence.dataset_id
          JOIN address_sources source ON source.id=dataset.source_id
          WHERE evidence.dataset_id=? AND evidence.is_current=1 AND address.active=1
            AND dataset.redistribution_allowed=1 AND source.redistribution_allowed=1`).bind(id).first('total');
        await this.database.prepare("UPDATE address_datasets SET active_count=? WHERE id=? AND status='active'")
          .bind(Number(activeCount || 0), id).run();
      }
      for (let offset = 0; offset < touchedIds.length; offset += GENERATION_REFRESH_BATCH) {
        checkpoint();
        await refreshAddressGenerationIndex(this.database, shard.countryCode,
          { addressIds: touchedIds.slice(offset, offset + GENERATION_REFRESH_BATCH) });
      }
      checkpoint();
      await this.database.batch([
        this.database.prepare(`DELETE FROM address_pool_evidence WHERE dataset_id IN (
          SELECT id FROM address_datasets WHERE source_id=? AND country_code=? AND status='retired'
        )`).bind(shard.source.id, shard.countryCode),
        this.database.prepare("DELETE FROM address_datasets WHERE source_id=? AND country_code=? AND status='retired'")
          .bind(shard.source.id, shard.countryCode)
      ]);
      await eachBatch(touchedIds, async (ids) => {
        await this.database.prepare(`DELETE FROM address_pool WHERE id IN (
          SELECT target.id FROM address_pool target
          LEFT JOIN address_pool_evidence evidence ON evidence.address_id=target.id
          WHERE target.id IN (${placeholders(ids)}) AND target.active=0 AND evidence.address_id IS NULL
        )`).bind(...ids).run();
      });
      checkpoint();
      const newlyListed = localized.map((record) => record.id).filter((id) => !previouslyActive.has(id));
      for (let offset = 0; offset < newlyListed.length; offset += batchSize) {
        const ids = newlyListed.slice(offset, offset + batchSize);
        addedCount += Number(await this.database.prepare(`SELECT COUNT(*) AS total FROM address_pool
          WHERE active=1 AND id IN (${ids.map(() => '?').join(',')})`).bind(...ids).first('total') || 0);
      }
    }, { signal });
    await this.refreshDerivedCountryState(shard.countryCode, activePolicy.levelLimits[1] || perLocality, datasetId, observedAt)
      .catch((error) => { if (signal?.aborted) throw error; console.error(`[address-sync] ${shard.countryCode} pool coverage deferred`, error?.code || error?.message || error); });
    const residentialCount = localized.filter((record) => record.propertyType === 'residential' || record.propertyType === 'apartment').length;
    return {
      datasetId, acceptedCount: localized.length, rejectedCount, localityCount: localityCounts.size,
      addressIds: localized.map((record) => record.id),
      netGrowth: addedCount + reactivatedCount - retiredCount, changedCount: addedCount + reactivatedCount + retiredCount,
      admin1Count: candidateAdmin1Count, residentialCount,
      metrics,
      rejectionReasons: Object.fromEntries([...rejectionReasons].sort(([left], [right]) => left.localeCompare(right))),
      skipped: false
    };
  }

  // Derived per-country state is rebuilt after the import commits so it never holds the import transaction open.
  // Coverage keys come from the current administrative columns, which repairs may have changed since import.
  async refreshDerivedCountryState(countryCode, coverageTarget, datasetId, observedAt) {
    const ranks = await this.database.prepare(`SELECT COUNT(*) AS total,MAX(country_rank) AS maximum
      FROM address_generation_index WHERE country_code=? AND active=1`).bind(countryCode).first();
    if (ranksNeedRenumbering(ranks?.maximum, ranks?.total)) {
      await refreshAddressGenerationIndex(this.database, countryCode);
    }
    await this.database.batch([
      this.database.prepare('DELETE FROM pool_coverage WHERE country_code=?').bind(countryCode),
      this.database.prepare(`INSERT INTO pool_coverage(
          coverage_key,country_code,admin1_key,locality_key,postcode_key,property_type,target_count,
          active_count,shadow_count,residential_count,refresh_status,generation,last_refreshed_at,expires_at
        ) SELECT 'sync:' || address.country_code || ':' || coalesce(nullif(coalesce(nullif(address.admin1_code_key,''),address.admin1_key),''),'*')
            || ':' || coalesce(nullif(coalesce(nullif(address.postal_locality_key,''),address.locality_key),''),'*') || ':' || address.property_type,
          address.country_code,
          coalesce(nullif(address.admin1_code_key,''),address.admin1_key),
          coalesce(nullif(address.postal_locality_key,''),address.locality_key),min(address.postcode_key),address.property_type,CAST(? AS INTEGER),
          count(*),0,sum(indexed.residential_ready),
          CASE WHEN count(*)>=CAST(? AS INTEGER) THEN 'ready' ELSE 'low' END,?,?,NULL
        FROM address_pool address JOIN address_generation_index indexed
          ON indexed.address_id=address.id AND indexed.country_code=address.country_code AND indexed.active=1
        WHERE address.country_code=? AND address.active=1
        GROUP BY address.country_code,coalesce(nullif(address.admin1_code_key,''),address.admin1_key),
          coalesce(nullif(address.postal_locality_key,''),address.locality_key),address.property_type`)
        .bind(coverageTarget, coverageTarget, datasetId, observedAt, countryCode)
    ]);
  }

  async close() {}
}

async function* readJsonLines(file, signal) {
  const { createReadStream } = await import('node:fs');
  let pending = '';
  for await (const chunk of createReadStream(file, { encoding: 'utf8', signal })) {
    signal?.throwIfAborted();
    pending += chunk;
    let newline;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      const text = line.replace(/^\u001e/u, '').trim();
      if (text) yield JSON.parse(text);
    }
  }
  if (pending) {
    const line = pending;
    const text = line.replace(/^\u001e/u, '').trim();
    if (text) yield JSON.parse(text);
  }
}
