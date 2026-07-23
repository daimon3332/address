import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import {
  normalizeAddressComponents,
  validateAdministrativeHierarchy
} from '../../src/domain/administrative-integrity.mjs';
import { findNonResidentialMatch } from '../../src/domain/non-residential.mjs';

const aliases = {
  countryCode: ['country_code', 'country', 'iso_country_code'],
  admin1: ['admin1', 'region', 'state', 'province'],
  admin1Code: ['admin1_code', 'region_code', 'state_code', 'province_code'],
  locality: ['locality', 'city', 'municipality'],
  postalLocality: ['postal_locality', 'postal_city', 'post_town'],
  district: ['district', 'county', 'dependent_locality'],
  postcode: ['postcode', 'postal_code', 'zip', 'zip_code'],
  street: ['street', 'road', 'street_name'],
  houseNumber: ['house_number', 'number', 'street_number'],
  buildingName: ['building_name', 'building'],
  latitude: ['latitude', 'lat'],
  longitude: ['longitude', 'lon', 'lng'],
  propertyType: ['property_type'],
  residentialEvidence: ['residential_evidence'],
  sourceId: ['source_id'],
  sourceName: ['source_name'],
  sourceUrl: ['source_url'],
  sourceLicense: ['source_license', 'license'],
  sourceRecordId: ['source_record_id', 'record_id', 'id', 'hash'],
  sourceUpdatedAt: ['source_updated_at', 'updated_at']
};

const limits = {
  admin1: 160,
  admin1Code: 32,
  locality: 160,
  postalLocality: 160,
  district: 160,
  postcode: 32,
  street: 240,
  houseNumber: 64,
  buildingName: 240,
  propertyType: 64,
  sourceId: 120,
  sourceName: 200,
  sourceUrl: 1000,
  sourceLicense: 160,
  sourceRecordId: 300,
  sourceUpdatedAt: 64
};

export const parseArgs = (argv) => {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const [rawKey, inlineValue] = token.slice(2).split('=', 2);
    const key = rawKey.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (inlineValue !== undefined) result[key] = inlineValue;
    else if (argv[index + 1] && !argv[index + 1].startsWith('--')) result[key] = argv[++index];
    else result[key] = true;
  }
  return result;
};

export async function* csvRows(file) {
  const input = createReadStream(file, { encoding: 'utf8' });
  let row = [];
  let field = '';
  let inQuotes = false;
  let afterQuote = false;
  let skipLineFeed = false;
  let rowNumber = 1;

  const finishField = () => {
    row.push(field);
    field = '';
  };

  for await (const chunk of input) {
    for (const character of chunk) {
      if (skipLineFeed) {
        skipLineFeed = false;
        if (character === '\n') continue;
      }
      if (inQuotes) {
        if (afterQuote) {
          if (character === '"') {
            field += '"';
            afterQuote = false;
          } else if (character === ',') {
            finishField();
            inQuotes = false;
            afterQuote = false;
          } else if (character === '\n' || character === '\r') {
            finishField();
            yield { values: row, rowNumber };
            row = [];
            rowNumber += 1;
            inQuotes = false;
            afterQuote = false;
            skipLineFeed = character === '\r';
          } else if (!/\s/u.test(character)) {
            throw new Error(`Malformed CSV after closing quote near row ${rowNumber}`);
          }
        } else if (character === '"') afterQuote = true;
        else field += character;
        continue;
      }
      if (character === ',' ) finishField();
      else if (character === '\n' || character === '\r') {
        finishField();
        yield { values: row, rowNumber };
        row = [];
        rowNumber += 1;
        skipLineFeed = character === '\r';
      } else if (character === '"' && field === '') inQuotes = true;
      else field += character;
    }
  }
  if (inQuotes && !afterQuote) throw new Error(`Unclosed quoted field near row ${rowNumber}`);
  if (field !== '' || row.length > 0) {
    finishField();
    yield { values: row, rowNumber };
  }
}

export const headerMap = (values) => {
  const headers = values.map((value, index) => value.replace(/^\uFEFF/, '').trim().toLocaleLowerCase() || `__empty_${index}`);
  const duplicates = headers.filter((value, index) => !value.startsWith('__empty_') && headers.indexOf(value) !== index);
  if (duplicates.length) throw new Error(`Duplicate CSV headers: ${[...new Set(duplicates)].join(', ')}`);
  return headers;
};

export const objectFromRow = (headers, values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']));

const first = (row, names) => {
  for (const name of names) {
    if (row[name] !== undefined && String(row[name]).trim() !== '') return row[name];
  }
  return '';
};

const clean = (value) => String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim();
const identity = (value) => clean(value).toLocaleLowerCase();

const validUrl = (value) => {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};

const requireText = (value, name) => {
  const result = clean(value);
  if (!result) throw new Error(`${name} is required in the source manifest`);
  return result;
};

const requireUrl = (value, name) => {
  const result = requireText(value, name);
  if (!validUrl(result)) throw new Error(`${name} must be an HTTP(S) URL`);
  return result;
};

const optionalDate = (value, name) => {
  if (value === undefined || value === null || value === '') return null;
  const result = clean(value);
  if (Number.isNaN(Date.parse(result))) throw new Error(`${name} must be a valid date`);
  return result;
};

const requireBoolean = (value, name) => {
  if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean`);
  return value;
};

export const loadSourceManifest = async (file) => {
  let document;
  try {
    document = JSON.parse(await readFile(resolveManifestPath(file), 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read source manifest: ${error instanceof Error ? error.message : error}`);
  }
  if (document?.schemaVersion !== 2) throw new Error('source manifest schemaVersion must be 2');
  const source = document.source || {};
  const license = source.license || {};
  const dataset = document.dataset || {};
  const defaults = document.defaults || {};
  const redistributionAllowed = requireBoolean(license.redistributionAllowed, 'source.license.redistributionAllowed');
  if (!redistributionAllowed) throw new Error('source manifest must permit redistribution for persistent pool imports');
  const manifest = {
    source: {
      id: requireText(source.id, 'source.id'),
      name: requireText(source.name, 'source.name'),
      homepageUrl: requireUrl(source.homepageUrl, 'source.homepageUrl'),
      dataUrl: requireUrl(source.dataUrl, 'source.dataUrl'),
      licenseCode: requireText(license.code, 'source.license.code'),
      licenseName: requireText(license.name, 'source.license.name'),
      licenseUrl: requireUrl(license.url, 'source.license.url'),
      attributionText: requireText(license.attributionText, 'source.license.attributionText'),
      attributionUrl: requireUrl(license.attributionUrl, 'source.license.attributionUrl'),
      termsUrl: requireUrl(license.termsUrl, 'source.license.termsUrl'),
      shareAlike: requireBoolean(license.shareAlike, 'source.license.shareAlike'),
      noticeRequired: requireBoolean(license.noticeRequired, 'source.license.noticeRequired'),
      redistributionAllowed,
      metadataJson: JSON.stringify(source.metadata || {})
    },
    dataset: {
      id: requireText(dataset.id, 'dataset.id'),
      version: requireText(dataset.version, 'dataset.version'),
      publishedAt: optionalDate(dataset.publishedAt, 'dataset.publishedAt'),
      retrievedAt: requireText(optionalDate(dataset.retrievedAt, 'dataset.retrievedAt'), 'dataset.retrievedAt'),
      format: requireText(dataset.format, 'dataset.format'),
      status: clean(dataset.status || 'active')
    },
    defaults: {
      countryCode: clean(defaults.countryCode).toUpperCase() || undefined,
      nativeLanguage: requireText(defaults.nativeLanguage, 'defaults.nativeLanguage'),
      propertyType: clean(defaults.propertyType).toLocaleLowerCase() || undefined,
      generation: requireText(defaults.generation, 'defaults.generation'),
      coveragePrefix: clean(defaults.coveragePrefix || 'pool'),
      qualityScore: Number(defaults.qualityScore),
      targetCount: defaults.targetCount === undefined ? 64 : Number(defaults.targetCount),
      expiresAt: optionalDate(defaults.expiresAt, 'defaults.expiresAt')
    }
  };
  if (!['pending', 'active', 'retired', 'failed'].includes(manifest.dataset.status)) throw new Error('dataset.status is invalid');
  if (!Number.isFinite(manifest.defaults.qualityScore) || manifest.defaults.qualityScore < 0 || manifest.defaults.qualityScore > 1) {
    throw new Error('defaults.qualityScore must be between 0 and 1');
  }
  if (!Number.isInteger(manifest.defaults.targetCount) || manifest.defaults.targetCount < 0) {
    throw new Error('defaults.targetCount must be a non-negative integer');
  }
  return manifest;
};

const resolveManifestPath = (file) => {
  if (typeof file !== 'string' || !file.trim()) throw new Error('--source-manifest requires a file path');
  return file;
};

export const detectFormat = (headers) => {
  const set = new Set(headers);
  return ['lon', 'lat', 'number', 'street'].every((header) => set.has(header)) ? 'openaddresses' : 'normalized';
};

export const normalizeAddress = (row, defaults = {}) => {
  const value = (name, fallback = '') => clean(defaults[name] || first(row, aliases[name]) || fallback);
  const rowCountry = clean(first(row, aliases.countryCode)).toUpperCase();
  const defaultCountry = clean(defaults.countryCode).toUpperCase();
  const declaredPropertyType = clean(first(row, aliases.propertyType)).toLocaleLowerCase();
  const declaredResidentialEvidence = clean(first(row, aliases.residentialEvidence)).toLocaleLowerCase();
  const countryCode = defaultCountry || rowCountry;
  const locality = value('locality');
  const latitude = value('latitude');
  const longitude = value('longitude');
  const address = normalizeAddressComponents(countryCode, {
    countryCode,
    admin1: value('admin1'),
    admin1Code: value('admin1Code'),
    locality,
    postalLocality: value('postalLocality', defaults.postalLocalityFromLocality ? locality : ''),
    district: value('district'),
    postcode: value('postcode'),
    street: value('street'),
    houseNumber: value('houseNumber'),
    buildingName: value('buildingName'),
    latitude: latitude === '' ? Number.NaN : Number(latitude),
    longitude: longitude === '' ? Number.NaN : Number(longitude),
    propertyType: declaredPropertyType || clean(defaults.propertyType || 'unknown').toLocaleLowerCase(),
    residentialEvidence: ['true', '1', 'yes'].includes(declaredResidentialEvidence),
    sourceId: value('sourceId'),
    sourceName: value('sourceName'),
    sourceUrl: value('sourceUrl'),
    sourceLicense: value('sourceLicense'),
    sourceRecordId: value('sourceRecordId'),
    sourceUpdatedAt: value('sourceUpdatedAt') || null
  });
  const errors = [];
  const exclusion = findNonResidentialMatch({
    countryCode: address.countryCode,
    buildingName: address.buildingName,
    formattedAddresses: [row.address_native, row.address_en, row.address_zh_cn],
    street: address.street,
    propertyType: address.propertyType
  });
  if (exclusion.excluded) {
    errors.push(`non-residential:${exclusion.category}:${exclusion.field}:${exclusion.term}`);
  }
  const hierarchy = validateAdministrativeHierarchy(address);
  if (!hierarchy.valid) errors.push(`administrative-hierarchy:${hierarchy.reason}`);
  if (declaredResidentialEvidence && !['true', 'false', '1', '0', 'yes', 'no'].includes(declaredResidentialEvidence)) {
    errors.push('residential_evidence must be true or false');
  }
  if (defaultCountry && rowCountry && defaultCountry !== rowCountry) errors.push(`country ${rowCountry} conflicts with --country ${defaultCountry}`);
  if (!/^[A-Z]{2}$/.test(address.countryCode)) errors.push('country_code must be a two-letter uppercase ISO code');
  if (!Number.isFinite(address.latitude) || address.latitude < -90 || address.latitude > 90) errors.push('latitude is outside [-90, 90]');
  if (!Number.isFinite(address.longitude) || address.longitude < -180 || address.longitude > 180) errors.push('longitude is outside [-180, 180]');
  if (!address.street) errors.push('street is required');
  if (!address.houseNumber) errors.push('house_number is required');
  if (!address.sourceId) errors.push('source_id is required');
  if (!address.sourceName) errors.push('source_name is required');
  if (!address.sourceUrl || !validUrl(address.sourceUrl)) errors.push('source_url must be an HTTP(S) URL');
  if (!address.sourceLicense) errors.push('source_license is required');
  if (address.sourceUpdatedAt && Number.isNaN(Date.parse(address.sourceUpdatedAt))) errors.push('source_updated_at is not a valid date');
  for (const [name, maximum] of Object.entries(limits)) {
    if (address[name]?.length > maximum) errors.push(`${name} exceeds ${maximum} characters`);
    if (address[name] && /[\u0000-\u001F\u007F]/u.test(address[name])) errors.push(`${name} contains control characters`);
  }

  const canonical = [
    address.countryCode,
    identity(address.admin1Code || address.admin1),
    identity(address.locality),
    identity(address.postalLocality),
    identity(address.district),
    identity(address.postcode).replace(/\s/gu, ''),
    identity(address.street),
    identity(address.houseNumber),
    identity(address.buildingName),
    Number.isFinite(address.latitude) ? address.latitude.toFixed(7) : '',
    Number.isFinite(address.longitude) ? address.longitude.toFixed(7) : ''
  ].join('\u001F');
  const digest = createHash('sha256').update(canonical).digest('hex');
  return {
    address: { ...address, id: `addr_${digest.slice(0, 32)}`, randomKey: Number.parseInt(digest.slice(32, 40), 16) & 0x7fffffff },
    errors
  };
};

export const checksumFile = async (file) => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
};

export const normalizeAddressKey = (value) => identity(value);

export const postcodeKey = (value) => normalizeAddressKey(value).replace(/\s/gu, '');

export const addressComponents = (address) => ({
  houseNumber: address.houseNumber,
  street: address.street,
  ...(address.buildingName ? { buildingName: address.buildingName } : {}),
  locality: address.locality || address.postalLocality,
  ...(address.postalLocality ? { postalLocality: address.postalLocality } : {}),
  ...(address.district ? { district: address.district, dependentLocality: address.district } : {}),
  ...(address.admin1 ? { admin1: address.admin1 } : {}),
  ...(address.admin1Code ? { admin1Code: address.admin1Code } : {}),
  postcode: address.postcode
});

const localizedComponentColumns = [
  ['admin1', 'admin1'],
  ['locality', 'locality'],
  ['postalLocality', 'postal_locality'],
  ['district', 'district'],
  ['street', 'street'],
  ['buildingName', 'building_name']
];

const chinaPostcodePattern = /(?:邮(?:政)?编码|郵(?:政)?編碼|邮编|郵編|post(?:al)?\s*code|zip(?:\s*code)?)[^\p{L}\p{N}]*\d{6}|\b\d{6}\b/iu;
const addressLanguages = ['native', 'en', 'zh-CN'];
const requiredComponentFields = ['houseNumber', 'street', 'locality', 'postcode'];
const languageColumn = (language) => language === 'zh-CN' ? 'zh_cn' : language;
const localizedObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const comparableText = (value) => typeof value === 'string' ? value.normalize('NFKC') : '';

export const validateLocalizedAddressVariants = (countryCode, componentVariants, addressVariants) => {
  const errors = [];
  if (!localizedObject(componentVariants)) errors.push('componentVariants must be an object');
  else {
    for (const language of addressLanguages) {
      const components = componentVariants[language];
      if (!localizedObject(components) || !Object.keys(components).length) {
        errors.push(`componentVariants.${language} must be a non-empty object`);
      } else if (Object.values(components).some((value) => typeof value !== 'string')) {
        errors.push(`componentVariants.${language} values must be strings`);
      } else if (requiredComponentFields.some((field) => typeof components[field] !== 'string')) {
        errors.push(`componentVariants.${language} must include houseNumber, street, locality and postcode strings`);
      }
    }
  }
  if (!localizedObject(addressVariants)) errors.push('addressVariants must be an object');
  else {
    for (const language of addressLanguages) {
      if (typeof addressVariants[language] !== 'string' || !clean(addressVariants[language])) {
        errors.push(`addressVariants.${language} must be a non-empty string`);
      }
    }
  }
  if (countryCode !== 'CN') return errors;
  const englishAddress = typeof addressVariants?.en === 'string' ? addressVariants.en : '';
  const englishComponents = localizedObject(componentVariants?.en)
    ? componentVariants.en
    : {};
  if (/\p{Script=Han}/u.test(comparableText(englishAddress))) errors.push('address_en must not contain Han characters for CN');
  if (Object.values(englishComponents).some((value) => /\p{Script=Han}/u.test(comparableText(value)))) {
    errors.push('English components must not contain Han characters for CN');
  }
  for (const language of addressLanguages) {
    const address = addressVariants?.[language];
    if (chinaPostcodePattern.test(comparableText(address))) {
      errors.push(`address_${languageColumn(language)} must not contain a postcode for CN`);
    }
    const components = componentVariants?.[language];
    if (localizedObject(components) && Object.entries(components).some(([field, value]) => (
      field === 'postcode'
        ? clean(value) !== ''
        : chinaPostcodePattern.test(comparableText(value))
    ))) errors.push(`componentVariants.${language} must not contain a postcode for CN`);
  }
  return errors;
};

export const localizedAddressData = (row, address) => {
  const nativeComponents = addressComponents(address);
  const errors = [];
  const line = (column) => clean(row[column]);
  const addressVariants = {
    native: line('address_native'),
    en: line('address_en'),
    'zh-CN': line('address_zh_cn')
  };
  for (const [language, value] of Object.entries(addressVariants)) {
    if (!value) errors.push(`address_${language === 'zh-CN' ? 'zh_cn' : language} is required for v2 imports`);
  }

  const localizedComponents = (prefix) => {
    const result = { ...nativeComponents };
    for (const [field, column] of localizedComponentColumns) {
      if (!nativeComponents[field]) continue;
      const value = line(`${column}_${prefix}`);
      if (!value) errors.push(`${column}_${prefix} is required when ${column} is present`);
      else result[field] = value;
    }
    if (result.district) result.dependentLocality = result.district;
    return result;
  };

  const componentVariants = {
    native: { ...nativeComponents },
    en: localizedComponents('en'),
    'zh-CN': localizedComponents('zh_cn')
  };
  if (address.countryCode === 'CN') {
    for (const components of Object.values(componentVariants)) components.postcode = '';
    componentVariants.en.houseNumber = componentVariants.en.houseNumber.replace(/(?:号|號)$/u, '');
  }
  errors.push(...validateLocalizedAddressVariants(address.countryCode, componentVariants, addressVariants));

  return {
    localized: {
      componentVariants,
      addressVariants
    },
    errors
  };
};

export const formattedAddress = (address) => [
  address.houseNumber,
  address.street,
  address.postalLocality || address.locality,
  address.admin1Code || address.admin1,
  address.postcode
].filter(Boolean).join(', ');

export const coverageKey = (address, prefix = 'pool') => [
  prefix,
  address.countryCode,
  normalizeAddressKey(address.admin1Code || address.admin1) || '*',
  normalizeAddressKey(address.postalLocality || address.locality) || '*',
  address.propertyType
].join(':');

export const sqlValue = (value) => {
  if (value === null || value === undefined || value === '') return value === '' ? "''" : 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  return `'${String(value).replaceAll("'", "''")}'`;
};

export const addressSqlValues = (address, importedAt) => [
  address.id, address.countryCode, address.admin1, address.admin1Code, address.locality, address.postalLocality,
  address.district, address.postcode, address.street, address.houseNumber, address.buildingName, address.latitude,
  address.longitude, address.propertyType, address.sourceId, address.sourceName, address.sourceUrl, address.sourceLicense,
  address.sourceRecordId, address.sourceUpdatedAt, address.randomKey, importedAt
];

export const addressColumns = [
  'id', 'country_code', 'admin1', 'admin1_code', 'locality', 'postal_locality', 'district', 'postcode', 'street',
  'house_number', 'building_name', 'latitude', 'longitude', 'property_type', 'source_id', 'source_name', 'source_url',
  'source_license', 'source_record_id', 'source_updated_at', 'random_key', 'imported_at'
];

export const addressV2SqlValues = (address, manifest, importedAt) => {
  if (!address.localized) throw new Error(`v2 address ${address.id} is missing localized variants`);
  const { componentVariants, addressVariants } = address.localized;
  return [
    address.id, address.countryCode, address.admin1, address.admin1Code, address.locality, address.postalLocality,
    address.district, address.postcode, address.street, address.houseNumber, address.buildingName, address.latitude,
    address.longitude, manifest.defaults.nativeLanguage, JSON.stringify(componentVariants), JSON.stringify(addressVariants),
    normalizeAddressKey(address.admin1), normalizeAddressKey(address.admin1Code), normalizeAddressKey(address.locality),
    normalizeAddressKey(address.postalLocality), normalizeAddressKey(address.district), postcodeKey(address.postcode),
    address.propertyType, manifest.defaults.qualityScore, manifest.defaults.generation,
    coverageKey(address, manifest.defaults.coveragePrefix), address.randomKey, 1, importedAt, importedAt,
    manifest.defaults.expiresAt, null
  ];
};

export const addressV2Columns = [
  'id', 'country_code', 'admin1', 'admin1_code', 'locality', 'postal_locality', 'district', 'postcode', 'street',
  'house_number', 'building_name', 'latitude', 'longitude', 'native_language', 'component_variants_json',
  'address_variants_json', 'admin1_key', 'admin1_code_key', 'locality_key', 'postal_locality_key', 'district_key',
  'postcode_key', 'property_type', 'quality_score', 'generation', 'coverage', 'random_key', 'active', 'first_seen_at',
  'last_seen_at', 'expires_at', 'retired_at'
];
