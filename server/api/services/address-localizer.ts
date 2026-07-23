import { Converter as createSimplifier } from 'opencc-js/t2cn';
import type { SqliteDatabase } from '../../database/sqlite.mjs';
import { pinyin } from 'pinyin-pro';
import { formatAddressPresentation } from '../../../src/domain/address-format.ts';
import {
  europeAmericasLocalizationPolicyFor,
  fieldsRequiringLocalization
} from '../../../src/domain/europe-americas-localization-policy.ts';
import type { AddressComponents, AddressLanguage, CountryConfig, VerifiedAddress } from '../../../src/domain/types.ts';
import { fetchWithTimeout } from './fetch-timeout.ts';
import { translateGoogleBatch } from './google-translator.ts';
import { translateYoudaoBatch } from './youdao-translator.ts';

export interface LocalizationBindings {
  LOCATION_DB?: SqliteDatabase;
  GEOAPIFY_API_KEY?: string;
  GOOGLE_TRANSLATION_ENABLED?: boolean | string;
  YOUDAO_APP_KEY?: string;
  YOUDAO_APP_SECRET?: string;
}

interface GeoapifyResult {
  place_id?: string;
  housenumber?: string;
  street?: string;
  name?: string;
  city?: string;
  town?: string;
  village?: string;
  suburb?: string;
  district?: string;
  county?: string;
  state?: string;
  state_code?: string;
  postcode?: string;
  country_code?: string;
}

const languageForGeoapify = (language: string): string => language.split('-')[0].toLowerCase();
const googleTranslationEnabled = (bindings: LocalizationBindings): boolean =>
  bindings.GOOGLE_TRANSLATION_ENABLED !== false && bindings.GOOGLE_TRANSLATION_ENABLED !== 'false';
const normalized = (value = ''): string => value.normalize('NFKD').toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const toSimplified = createSimplifier({ from: 'hk', to: 'cn' });
const semanticFields = [
  'buildingName', 'street', 'locality', 'postalLocality', 'dependentLocality', 'district', 'admin1'
] as const satisfies ReadonlyArray<keyof AddressComponents>;
const placeFields = [
  'locality', 'postalLocality', 'dependentLocality', 'district', 'admin1'
] as const satisfies ReadonlyArray<keyof AddressComponents>;
const nonLatinNative = new Set<CountryConfig['code']>(['RU', 'JP', 'HK', 'TW', 'KR', 'CN', 'TH', 'SA']);
const latinLetter = /\p{Script=Latin}/u;
const hanLetter = /\p{Script=Han}/u;
const letter = /\p{Letter}/u;
const incompatibleChineseLetter = /[\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;

type SemanticField = typeof semanticFields[number];

const chinaEnglishAliases: Partial<Record<SemanticField, Readonly<Record<string, string>>>> = {
  admin1: {
    '北京市': 'Beijing',
    '上海市': 'Shanghai',
    '天津市': 'Tianjin',
    '重庆市': 'Chongqing',
    '广西壮族自治区': 'Guangxi Zhuang Autonomous Region',
    '内蒙古自治区': 'Inner Mongolia Autonomous Region',
    '西藏自治区': 'Tibet Autonomous Region',
    '宁夏回族自治区': 'Ningxia Hui Autonomous Region',
    '新疆维吾尔自治区': 'Xinjiang Uyghur Autonomous Region',
    '香港特别行政区': 'Hong Kong Special Administrative Region',
    '澳门特别行政区': 'Macao Special Administrative Region'
  }
};

const chinaEnglishSuffixes: Partial<Record<SemanticField, ReadonlyArray<readonly [string, string]>>> = {
  admin1: [
    ['特别行政区', 'Special Administrative Region'],
    ['自治区', 'Autonomous Region'],
    ['省', 'Province'],
    ['市', 'City']
  ],
  locality: [
    ['自治州', 'Autonomous Prefecture'],
    ['地区', 'Prefecture'],
    ['市', 'City'],
    ['县', 'County']
  ],
  postalLocality: [
    ['自治州', 'Autonomous Prefecture'],
    ['地区', 'Prefecture'],
    ['市', 'City'],
    ['县', 'County']
  ],
  district: [
    ['自治县', 'Autonomous County'],
    ['自治旗', 'Autonomous Banner'],
    ['市', 'City'],
    ['区', 'District'],
    ['县', 'County'],
    ['旗', 'Banner']
  ],
  dependentLocality: [
    ['民族乡', 'Ethnic Township'],
    ['街道', 'Subdistrict'],
    ['苏木', 'Sum'],
    ['镇', 'Town'],
    ['乡', 'Township']
  ],
  street: [
    ['高速公路', 'Expressway'],
    ['国道', 'National Highway'],
    ['省道', 'Provincial Highway'],
    ['县道', 'County Road'],
    ['公路', 'Highway'],
    ['大道', 'Avenue'],
    ['大街', 'Avenue'],
    ['路', 'Road'],
    ['街', 'Street'],
    ['巷', 'Lane'],
    ['弄', 'Lane']
  ],
  buildingName: [
    ['住宅小区', 'Residential Community'],
    ['小区', 'Residential Community'],
    ['花园', 'Garden'],
    ['豪庭', 'Residence'],
    ['春城', 'Chuncheng'],
    ['家园', 'Residence'],
    ['公寓', 'Apartments'],
    ['大厦', 'Building'],
    ['广场', 'Plaza'],
    ['新村', 'Residential Community'],
    ['苑', 'Residence']
  ]
};

const romanizeChineseName = (value: string): string => pinyin(toSimplified(value), {
  toneType: 'none',
  type: 'array',
  nonZh: 'consecutive'
})
  .map((part) => part.trim())
  .filter(Boolean)
  .join('')
  .replace(/^\p{Ll}/u, (initial) => initial.toLocaleUpperCase('en'));

const romanizeChinaField = (field: SemanticField, value: string): string => {
  const simplified = toSimplified(value).trim();
  const alias = chinaEnglishAliases[field]?.[simplified];
  if (alias) return alias;
  const suffix = chinaEnglishSuffixes[field]?.find(([candidate]) => simplified.endsWith(candidate));
  if (!suffix) return romanizeChineseName(simplified);
  const stem = simplified.slice(0, -suffix[0].length).trim();
  return [romanizeChineseName(stem), suffix[1]].filter(Boolean).join(' ');
};

const needsChinaEnglishFallback = (
  canonical: AddressComponents,
  localized: AddressComponents
): boolean => semanticFields.some((field) => {
  const source = canonical[field];
  if (typeof source !== 'string' || !source.trim()) return false;
  const value = localized[field];
  return typeof value !== 'string' || !value.trim() || hanLetter.test(value);
});

const fallbackChinaEnglishComponents = (
  canonical: AddressComponents,
  localized: AddressComponents
): AddressComponents => {
  const result = { ...localized };
  for (const field of semanticFields) {
    const current = result[field];
    const canonicalValue = canonical[field];
    if (typeof current === 'string' && current.trim() && !hanLetter.test(current)) {
      const simplified = typeof canonicalValue === 'string' ? toSimplified(canonicalValue).trim() : '';
      const alias = chinaEnglishAliases[field]?.[simplified];
      const suffix = chinaEnglishSuffixes[field]?.find(([candidate]) => simplified.endsWith(candidate));
      if (alias) (result as Record<string, unknown>)[field] = alias;
      else if (suffix && !current.trim().toLocaleLowerCase('en').endsWith(suffix[1].toLocaleLowerCase('en'))) {
        (result as Record<string, unknown>)[field] = `${current.trim()} ${suffix[1]}`;
      }
      continue;
    }
    const source = typeof canonicalValue === 'string' && canonicalValue.trim() ? canonicalValue : current;
    if (typeof source !== 'string' || !source.trim()) continue;
    (result as Record<string, unknown>)[field] = hanLetter.test(source)
      ? romanizeChinaField(field, source)
      : source.trim();
  }
  const canonicalAdmin1 = toSimplified(canonical.admin1 || '').trim();
  if (canonical.locality && canonical.locality === canonical.admin1 && chinaEnglishAliases.admin1?.[canonicalAdmin1]) {
    result.locality = chinaEnglishAliases.admin1[canonicalAdmin1];
  }
  return result;
};

const usesOnlyTargetScript = (value: string, language: 'en' | 'zh-CN'): boolean => {
  const letters = Array.from(value).filter((character) => letter.test(character));
  if (!letters.length) return true;
  if (language === 'en') return letters.every((character) => latinLetter.test(character));
  return letters.some((character) => hanLetter.test(character))
    && letters.every((character) => hanLetter.test(character) || latinLetter.test(character));
};

const needsTargetLocalization = (
  components: AddressComponents,
  fields: ReadonlyArray<keyof AddressComponents>,
  language: 'en' | 'zh-CN'
): boolean => fields.some((field) => {
  const value = components[field];
  return typeof value === 'string' && Boolean(value.trim()) && !usesOnlyTargetScript(value, language);
});

const preservesNumbers = (source: string, translated: string): boolean => {
  const tokens = (value: string): string[] => value.match(/\p{Decimal_Number}+/gu) || [];
  return JSON.stringify(tokens(source)) === JSON.stringify(tokens(translated));
};

const simplifyComponents = (source: AddressComponents): AddressComponents => Object.fromEntries(
  Object.entries(source).map(([key, value]) => [key, typeof value === 'string' ? toSimplified(value) : value])
) as unknown as AddressComponents;

const youdaoLanguage = (language: string): string => ({
  'zh-cn': 'zh-CHS', 'zh-hk': 'zh-CHT', 'zh-tw': 'zh-CHT', 'pt-br': 'pt', fil: 'tl'
})[language.toLocaleLowerCase()] || language.split('-')[0].toLocaleLowerCase();

const mergeFields = (
  source: AddressComponents,
  localized: AddressComponents | undefined,
  fields: ReadonlyArray<keyof AddressComponents>
): AddressComponents => {
  if (!localized) return source;
  const result = { ...source };
  for (const field of fields) {
    const value = localized[field];
    if (value !== undefined && value !== '') (result as Record<string, unknown>)[field] = value;
  }
  return result;
};

const russianTransliteration: Record<string, string> = {
  А: 'A', Б: 'B', В: 'V', Г: 'G', Д: 'D', Е: 'E', Ё: 'Yo', Ж: 'Zh', З: 'Z', И: 'I', Й: 'Y',
  К: 'K', Л: 'L', М: 'M', Н: 'N', О: 'O', П: 'P', Р: 'R', С: 'S', Т: 'T', У: 'U', Ф: 'F',
  Х: 'Kh', Ц: 'Ts', Ч: 'Ch', Ш: 'Sh', Щ: 'Shch', Ъ: '', Ы: 'Y', Ь: '', Э: 'E', Ю: 'Yu', Я: 'Ya'
};

const transliterateRussian = (value: string): string => Array.from(value).map((character) => {
  const upper = character.toLocaleUpperCase('ru');
  const replacement = russianTransliteration[upper];
  if (replacement === undefined) return character;
  return character === upper ? replacement : replacement.charAt(0).toLocaleLowerCase('en') + replacement.slice(1);
}).join('');

const transliterateRussianComponents = (
  source: AddressComponents,
  fields: ReadonlyArray<keyof AddressComponents>
): AddressComponents => {
  const result = { ...source };
  for (const field of fields) {
    const value = result[field];
    if (typeof value === 'string' && /\p{Script=Cyrillic}/u.test(value)) {
      (result as Record<string, unknown>)[field] = transliterateRussian(value);
    }
  }
  return result;
};

const harmonizeEquivalentPlaces = (
  reference: AddressComponents,
  localized: AddressComponents
): AddressComponents => {
  const fields = ['locality', 'postalLocality'] as const;
  const result = { ...localized };
  const groups = new Map<string, typeof fields[number][]>();
  for (const field of fields) {
    const value = reference[field];
    if (!value) continue;
    const key = normalized(value);
    groups.set(key, [...(groups.get(key) || []), field]);
  }
  for (const equivalentFields of groups.values()) {
    if (equivalentFields.length < 2) continue;
    const value = equivalentFields
      .map((field) => result[field])
      .filter((item): item is string => Boolean(item))
      .sort((left, right) => Array.from(right).length - Array.from(left).length)[0];
    if (!value) continue;
    for (const field of equivalentFields) result[field] = value;
  }
  return result;
};

const translateComponentFields = async (
  source: AddressComponents,
  fields: ReadonlyArray<keyof AddressComponents>,
  from: string,
  to: 'en' | 'zh-CN',
  bindings: LocalizationBindings,
  fetcher: typeof fetch
): Promise<AddressComponents> => {
  const selected = fields
    .map((field) => ({ field, value: source[field] }))
    .filter((item): item is { field: keyof AddressComponents; value: string } =>
      typeof item.value === 'string' && Boolean(item.value.trim()) && !usesOnlyTargetScript(item.value, to)
    );
  if (!selected.length) return source;
  const values = [...new Set(selected.map(({ value }) => value))];
  let translations: string[] | undefined;
  try {
    if (googleTranslationEnabled(bindings)) translations = await translateGoogleBatch(values, from, to, fetcher);
    if (!translations && bindings.YOUDAO_APP_KEY && bindings.YOUDAO_APP_SECRET) {
      translations = await translateYoudaoBatch(
        values,
        from,
        to === 'en' ? 'en' : 'zh-CHS',
        { appKey: bindings.YOUDAO_APP_KEY, appSecret: bindings.YOUDAO_APP_SECRET },
        fetcher
      );
    }
  } catch {
    return source;
  }
  if (!translations) return source;
  const translated = new Map(values.map((value, index) => [value, translations[index]]));
  const result = { ...source };
  for (const { field, value } of selected) {
    const candidate = translated.get(value);
    if (candidate && usesOnlyTargetScript(candidate, to) && preservesNumbers(value, candidate)) {
      (result as Record<string, unknown>)[field] = candidate;
    }
  }
  return result;
};

const translateNativeComponentFields = async (
  source: AddressComponents,
  country: CountryConfig,
  bindings: LocalizationBindings,
  fetcher: typeof fetch
): Promise<AddressComponents> => {
  const expected = nativeScript[country.code];
  if (!expected) return source;
  const selected = semanticFields
    .map((field) => ({ field, value: source[field] }))
    .filter((item): item is { field: typeof semanticFields[number]; value: string } =>
      typeof item.value === 'string' && Boolean(item.value.trim()) && letter.test(item.value) && !expected.test(item.value)
    );
  if (!selected.length) return source;
  const values = [...new Set(selected.map(({ value }) => value))];
  let translations: string[] | undefined;
  try {
    if (googleTranslationEnabled(bindings)) {
      translations = await translateGoogleBatch(values, 'auto', country.nativeLanguage, fetcher);
    }
    if (!translations && bindings.YOUDAO_APP_KEY && bindings.YOUDAO_APP_SECRET) {
      translations = await translateYoudaoBatch(
        values,
        'auto',
        youdaoLanguage(country.nativeLanguage),
        { appKey: bindings.YOUDAO_APP_KEY, appSecret: bindings.YOUDAO_APP_SECRET },
        fetcher
      );
    }
  } catch {
    return source;
  }
  if (!translations) return source;
  const translated = new Map(values.map((value, index) => [value, translations[index]]));
  const result = { ...source };
  for (const { field, value } of selected) {
    const candidate = translated.get(value);
    if (candidate && expected.test(candidate) && preservesNumbers(value, candidate)) {
      (result as Record<string, unknown>)[field] = candidate;
    }
  }
  return result;
};

const samePremise = (
  address: VerifiedAddress,
  source: AddressComponents,
  result: GeoapifyResult,
  country: CountryConfig
): boolean => {
  const resultCountry = result.country_code?.toUpperCase();
  if (resultCountry && resultCountry !== country.code && !(country.code === 'HK' && resultCountry === 'CN')) return false;
  const idPrefix = `geoapify-${country.code.toLowerCase()}-`;
  if (result.place_id && address.id.startsWith(idPrefix)) {
    const sourcePlaceId = decodeURIComponent(address.id.slice(idPrefix.length));
    if (sourcePlaceId === result.place_id) return true;
  }
  const resultStreet = result.street || (source.street === source.buildingName ? result.name : undefined);
  if (!resultStreet) return false;
  const streetMatches = normalized(source.street) === normalized(resultStreet);
  const sourcePlaces = [source.locality, source.postalLocality, source.dependentLocality].filter(Boolean).map(normalized);
  const resultPlaces = [result.city, result.town, result.village, result.suburb].filter(Boolean).map((value) => normalized(value));
  const placeMatches = sourcePlaces.some((value) => resultPlaces.includes(value));
  const postcodeMatches = Boolean(source.postcode && result.postcode && normalized(source.postcode) === normalized(result.postcode));
  if (!source.houseNumber) return streetMatches && (placeMatches || postcodeMatches);
  const houseMatches = Boolean(result.housenumber && normalized(source.houseNumber) === normalized(result.housenumber));
  return houseMatches && (streetMatches || placeMatches);
};

const componentsFromGeoapify = (
  source: AddressComponents,
  result: GeoapifyResult,
  country: CountryConfig,
  language: string
): AddressComponents => {
  let locality = result.city || result.town || result.village || result.suburb || source.locality;
  let admin1 = result.state || source.admin1;
  let dependentLocality = result.suburb || result.district || source.dependentLocality;
  let district = result.county || result.district || source.district;
  if (country.code === 'JP' && languageForGeoapify(language) === 'ja') {
    if (/[\u3040-\u30ff\u3400-\u9fff]/u.test(source.locality) && !/[\u3040-\u30ff\u3400-\u9fff]/u.test(locality)) locality = source.locality;
    if (source.admin1 && /[\u3400-\u9fff]/u.test(source.admin1) && (!admin1 || !/[\u3400-\u9fff]/u.test(admin1))) admin1 = source.admin1;
    if (admin1 && /[\u3400-\u9fff]/u.test(admin1) && !/[都道府県]$/u.test(admin1)) {
      admin1 = ['北海道', '東京都', '大阪府', '京都府'].includes(admin1) ? admin1 : `${admin1}県`;
    }
    if (dependentLocality && !/[\u3040-\u30ff\u3400-\u9fff]/u.test(dependentLocality)) dependentLocality = undefined;
    if (district && (!/[\u3040-\u30ff\u3400-\u9fff]/u.test(district) || normalized(district) === normalized(locality))) district = undefined;
  }
  return {
    ...source,
    houseNumber: source.houseNumber || result.housenumber || '',
    buildingName: result.name || source.buildingName,
    street: result.street || (source.street === source.buildingName ? result.name : undefined) || source.street,
    locality,
    postalLocality: source.postalLocality || result.city || result.town || result.village,
    dependentLocality,
    district,
    admin1,
    admin1Code: source.admin1Code || result.state_code,
    postcode: source.postcode || result.postcode || ''
  };
};

const reverseGeoapify = async (
  address: VerifiedAddress,
  source: AddressComponents,
  country: CountryConfig,
  language: string,
  apiKey: string,
  fetcher: typeof fetch
): Promise<AddressComponents | undefined> => {
  const url = new URL('https://api.geoapify.com/v1/geocode/reverse');
  url.searchParams.set('lat', String(address.coordinates.latitude));
  url.searchParams.set('lon', String(address.coordinates.longitude));
  url.searchParams.set('format', 'json');
  url.searchParams.set('lang', languageForGeoapify(language));
  url.searchParams.set('limit', '1');
  url.searchParams.set('apiKey', apiKey);
  const response = await fetchWithTimeout(fetcher, url, { headers: { Accept: 'application/json' } });
  if (!response.ok) return undefined;
  const body = await response.json() as { results?: GeoapifyResult[] };
  const result = body.results?.[0];
  return result && samePremise(address, source, result, country)
    ? componentsFromGeoapify(source, result, country, language)
    : undefined;
};

const houseNumberFor = (value: string, language: AddressLanguage): string => language === 'en'
  ? value.replace(/(?:号|號|番地|번지)$/u, '').trim()
  : value;

const cacheKey = (address: VerifiedAddress): string => [
  'v18', address.id, address.coordinates.latitude.toFixed(6), address.coordinates.longitude.toFixed(6),
  address.sourceVersion, address.sourceUpdatedAt
].join(':');

const readCached = async (
  db: SqliteDatabase | undefined,
  address: VerifiedAddress,
  language: AddressLanguage
): Promise<AddressComponents | undefined> => {
  if (!db) return undefined;
  const row = await db.prepare('SELECT value FROM translation_cache WHERE cache_key = ? AND target_language = ?')
    .bind(cacheKey(address), language).first<{ value: string }>();
  if (!row?.value) return undefined;
  try { return JSON.parse(row.value) as AddressComponents; } catch { return undefined; }
};

const writeCached = async (
  db: SqliteDatabase | undefined,
  address: VerifiedAddress,
  language: AddressLanguage,
  value: AddressComponents
): Promise<void> => {
  if (!db) return;
  await db.prepare(`INSERT INTO translation_cache(cache_key, target_language, value, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(cache_key, target_language) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .bind(cacheKey(address), language, JSON.stringify(value), new Date().toISOString()).run();
};

const sourceFor = (address: VerifiedAddress, language: AddressLanguage): AddressComponents => {
  const variant = address.componentVariants[language];
  const source = variant?.street ? variant : address.componentVariants.native?.street ? address.componentVariants.native : address.components;
  return { ...source, houseNumber: houseNumberFor(source.houseNumber, language) };
};

const nativeScript: Partial<Record<CountryConfig['code'], RegExp>> = {
  JP: /[\u3040-\u30ff\u3400-\u9fff]/u,
  HK: /[\u3400-\u9fff]/u,
  TW: /[\u3400-\u9fff]/u,
  KR: /[\uac00-\ud7af]/u,
  RU: /[\u0400-\u04ff]/u,
  TH: /[\u0e00-\u0e7f]/u,
  SA: /[\u0600-\u06ff]/u
};

const needsNativeReverse = (country: CountryConfig, source: AddressComponents): boolean => {
  const expected = nativeScript[country.code];
  if (!expected) return false;
  return semanticFields.some((field) => {
    const value = source[field];
    return typeof value === 'string' && letter.test(value) && !expected.test(value);
  });
};

const preserveIdentifiers = (
  canonical: AddressComponents,
  localized: AddressComponents,
  language: AddressLanguage
): AddressComponents => ({
  ...localized,
  houseNumber: houseNumberFor(canonical.houseNumber, language),
  unit: canonical.unit,
  postcode: canonical.postcode,
  admin1Code: canonical.admin1Code
});

const sanitizeJapaneseChinese = (
  native: AddressComponents,
  localized: AddressComponents
): AddressComponents => {
  const result = { ...localized };
  for (const field of semanticFields) {
    const value = result[field];
    if (typeof value !== 'string' || !incompatibleChineseLetter.test(value)) continue;
    const nativeValue = native[field];
    if (typeof nativeValue === 'string' && hanLetter.test(nativeValue)) {
      (result as Record<string, unknown>)[field] = toSimplified(nativeValue);
    } else if (field === 'dependentLocality' || field === 'district' || field === 'buildingName') {
      delete (result as Record<string, unknown>)[field];
    }
  }
  return result;
};

const sanitizeNative = (country: CountryConfig, source: AddressComponents): AddressComponents => {
  if (country.code !== 'JP') return source;
  const value = { ...source };
  if (value.admin1 && /[\u3400-\u9fff]/u.test(value.admin1) && !/[都道府県]$/u.test(value.admin1)) {
    value.admin1 = ['北海道', '東京都', '大阪府', '京都府'].includes(value.admin1) ? value.admin1 : `${value.admin1}県`;
  }
  if (value.postalLocality && !/[\u3040-\u30ff\u3400-\u9fff]/u.test(value.postalLocality)) value.postalLocality = value.locality;
  if (value.dependentLocality && (
    !/[\u3040-\u30ff\u3400-\u9fff]/u.test(value.dependentLocality)
    || normalized(value.dependentLocality) === normalized(value.street)
  )) value.dependentLocality = undefined;
  if (value.district && (
    !/[\u3040-\u30ff\u3400-\u9fff]/u.test(value.district)
    || normalized(value.district) === normalized(value.locality)
    || normalized(value.district) === normalized(value.street)
  )) value.district = undefined;
  return value;
};

export const localizeAddress = async (
  address: VerifiedAddress,
  country: CountryConfig,
  bindings: LocalizationBindings,
  fetcher: typeof fetch = fetch
): Promise<VerifiedAddress> => {
  const [cachedNative, cachedEn, cachedZh] = await Promise.all([
    readCached(bindings.LOCATION_DB, address, 'native'),
    readCached(bindings.LOCATION_DB, address, 'en'),
    readCached(bindings.LOCATION_DB, address, 'zh-CN')
  ]);
  const sourceId = address.evidence.find((item) => item.type === 'address_existence')?.sourceId;
  const regionalPolicy = europeAmericasLocalizationPolicyFor(country.code);
  const englishFields = regionalPolicy ? fieldsRequiringLocalization(regionalPolicy, 'en') : semanticFields;
  const chineseFields = regionalPolicy
    ? fieldsRequiringLocalization(regionalPolicy, 'zh-CN')
    : nonLatinNative.has(country.code) ? semanticFields : placeFields;
  const mayReverse = Boolean(bindings.GEOAPIFY_API_KEY && (sourceId === 'geoapify' || sourceId === 'osm-overpass'));
  const nativeSource = sanitizeNative(country, sourceFor(address, 'native'));
  const validCachedNative = cachedNative && !needsNativeReverse(country, cachedNative) ? cachedNative : undefined;
  const validCachedEn = cachedEn
    && !needsTargetLocalization(cachedEn, englishFields, 'en')
    && !(country.code === 'CN' && needsChinaEnglishFallback(nativeSource, cachedEn))
    ? cachedEn
    : undefined;
  const validCachedZh = cachedZh && !needsTargetLocalization(cachedZh, chineseFields, 'zh-CN') ? cachedZh : undefined;
  const providerNative = validCachedNative || (mayReverse && needsNativeReverse(country, nativeSource)
    ? await reverseGeoapify(
      address, nativeSource, country, country.nativeLanguage, bindings.GEOAPIFY_API_KEY!, fetcher
    ) || nativeSource
    : nativeSource);
  const native = (validCachedNative || sourceId === 'hk-als')
    ? providerNative
    : preserveIdentifiers(
      nativeSource,
      await translateNativeComponentFields(providerNative, country, bindings, fetcher),
      'native'
    );
  const englishSource = preserveIdentifiers(native, sourceFor(address, 'en'), 'en');
  const chineseSource = ['CN', 'HK', 'TW'].includes(country.code)
    ? simplifyComponents(native)
    : preserveIdentifiers(native, sourceFor(address, 'zh-CN'), 'zh-CN');
  const [reversedEn, reversedZh] = await Promise.all([
    !validCachedEn && mayReverse && englishFields.length && needsTargetLocalization(englishSource, englishFields, 'en')
      ? reverseGeoapify(address, englishSource, country, 'en', bindings.GEOAPIFY_API_KEY!, fetcher)
      : undefined,
    !validCachedZh && mayReverse && chineseFields.length && !['CN', 'HK'].includes(country.code)
      && needsTargetLocalization(chineseSource, chineseFields, 'zh-CN')
      ? reverseGeoapify(address, chineseSource, country, 'zh-CN', bindings.GEOAPIFY_API_KEY!, fetcher)
      : undefined
  ]);
  const mergedEnglish = mergeFields(englishSource, reversedEn, englishFields);
  const englishBase = country.code === 'RU'
    ? transliterateRussianComponents(mergedEnglish, englishFields)
    : mergedEnglish;
  const chineseBase = mergeFields(chineseSource, reversedZh, chineseFields);
  const [translatedEn, translatedZh] = await Promise.all([
    validCachedEn || (sourceId === 'hk-als'
      ? englishSource
      : translateComponentFields(
        englishBase,
        englishFields,
        'auto',
        'en',
        bindings,
        fetcher
      )),
    validCachedZh || (sourceId === 'hk-als' || ['CN', 'HK'].includes(country.code)
      ? chineseSource
      : translateComponentFields(
        chineseBase,
        chineseFields,
        'auto',
        'zh-CN',
        bindings,
        fetcher
      ))
  ]);
  const identifiedEn = preserveIdentifiers(native, translatedEn, 'en');
  const en = country.code === 'CN' ? fallbackChinaEnglishComponents(native, identifiedEn) : identifiedEn;
  const localizedZh = sourceId === 'hk-als' || ['CN', 'HK', 'TW'].includes(country.code)
    ? translatedZh
    : harmonizeEquivalentPlaces(englishBase, translatedZh);
  const sanitizedZh = country.code === 'JP' ? sanitizeJapaneseChinese(native, localizedZh) : localizedZh;
  const zhCN = preserveIdentifiers(native, simplifyComponents(sanitizedZh), 'zh-CN');

  await Promise.all([
    validCachedNative ? undefined : writeCached(bindings.LOCATION_DB, address, 'native', native),
    validCachedEn ? undefined : writeCached(bindings.LOCATION_DB, address, 'en', en),
    validCachedZh ? undefined : writeCached(bindings.LOCATION_DB, address, 'zh-CN', zhCN)
  ]);

  const componentVariants = { native, en, 'zh-CN': zhCN };
  const draft = { ...address, components: native, componentVariants };
  const addressVariants = {
    native: formatAddressPresentation(draft, 'native', '').singleLine,
    en: formatAddressPresentation(draft, 'en', '').singleLine,
    'zh-CN': formatAddressPresentation(draft, 'zh-CN', '').singleLine
  };
  return {
    ...draft,
    nativeAddress: addressVariants.native,
    formattedAddress: addressVariants.en,
    addressVariants
  };
};
