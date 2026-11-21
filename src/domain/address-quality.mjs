import { isValidPostcode } from './postcode-patterns.mjs';
import { countryBoundAreas } from './country-bounds.mjs';
import countryNames from './country-names.json' with { type: 'json' };

// A published address carries a postcode everywhere postcodes exist (2026-10-26); Hong Kong has none and China
// keeps its district-level rule.
const policies = {
  US: { admin1: true, locality: true, postcode: true },
  CA: { admin1: true, locality: true, postcode: true },
  MX: { admin1: true, locality: true, district: true, postcode: true },
  GB: { locality: true, postcode: true },
  DE: { locality: true, postcode: true },
  FR: { locality: true, postcode: true },
  IT: { admin1: true, locality: true, postcode: true },
  ES: { admin1: true, locality: true, postcode: true },
  NL: { locality: true, postcode: true },
  JP: { admin1: true, locality: true, district: true, postcode: true },
  CN: { admin1: true, locality: true, district: true, postcode: false },
  HK: { locality: true, postcode: false },
  TW: { admin1: true, locality: true, postcode: true },
  KR: { admin1: true, locality: true, postcode: true },
  SG: { postcode: true },
  MY: { admin1: true, locality: true, postcode: true },
  TH: { admin1: true, locality: true, postcode: true },
  PH: { admin1: true, locality: true, postcode: true },
  VN: { admin1: true, locality: true, postcode: true },
  TR: { admin1: true, locality: true, postcode: true },
  SA: { locality: true, postcode: true },
  IN: { admin1: true, locality: true, postcode: true },
  AU: { admin1: true, locality: true, postcode: true },
  BR: { admin1: true, locality: true, postcode: true },
  NG: { admin1: true, locality: true, postcode: true },
  ZA: { admin1: true, locality: true, postcode: true },
  RU: { admin1: true, locality: true, postcode: true }
};

// Geocoders return these labels for roads without an official name; they are not real street names.
const placeholderStreetSource = '^(?:(?:unnamed|unknown|no +name)(?: +(?:road|rd|street|st|lane|way))?|(?:đường +)?(?:không +tên|chưa +đặt +tên)|(?:ถนน)?ไม่มีชื่อ|(?:(?:calle|camino|avenida) +)?sin +nombre|(?:(?:rua|travessa|estrada|avenida) +)?sem +(?:nome|denominação)|[iİ]simsiz(?: +(?:sokak|cadde|sokağı|caddesi))?|(?:(?:طريق|شارع) +)?بدون +اسم)$';
const placeholderStreetPattern = new RegExp(placeholderStreetSource, 'iu');
const placeholderStreetNames = [
  'unnamed', 'unnamed road', 'unnamed street', 'unknown', 'unknown road', 'unknown street', 'no name', 'no name road',
  'no name street', 'không tên', 'đường không tên', 'chưa đặt tên', 'đường chưa đặt tên', 'ไม่มีชื่อ', 'ถนนไม่มีชื่อ', 'sin nombre', 'calle sin nombre',
  'camino sin nombre', 'sem nome', 'rua sem nome', 'sem denominação', 'rua sem denominação', 'isimsiz', 'isimsiz sokak',
  'isimsiz cadde', 'i̇simsiz', 'i̇simsiz sokak', 'i̇simsiz cadde', 'بدون اسم', 'طريق بدون اسم', 'شارع بدون اسم'
];
export const isPlaceholderStreet = (value) => placeholderStreetPattern.test(String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim());

const clean = (value) => String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim();
const compact = (value) => clean(value).replace(/\s+/gu, '').toUpperCase();
const letters = /\p{L}/u;
const han = /\p{Script=Han}/u;
const japanese = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

const same = (left, right) => Boolean(clean(left)) && compact(left) === compact(right);
// AreaCity/StatsGov 2025.251231.260403: mainland direct-admin placeholder levels.
const chinaDirectLocalities = {
  '河南省': ['济源市'],
  '湖北省': ['仙桃市', '潜江市', '天门市', '神农架林区'],
  '广东省': ['东莞市', '中山市'],
  '海南省': ['儋州市', '五指山市', '琼海市', '文昌市', '万宁市', '东方市', '定安县', '屯昌县',
    '澄迈县', '临高县', '白沙黎族自治县', '昌江黎族自治县', '乐东黎族自治县', '陵水黎族自治县',
    '保亭黎族苗族自治县', '琼中黎族苗族自治县'],
  '甘肃省': ['嘉峪关市'],
  '新疆维吾尔自治区': ['石河子市', '阿拉尔市', '图木舒克市', '五家渠市', '北屯市', '铁门关市',
    '双河市', '可克达拉市', '昆玉市', '胡杨河市', '新星市', '白杨市']
};
const addDuplicateReasons = (country, components, reasons) => {
  const locality = localityValue(components);
  const district = districtValue(components);
  const koreanLandLot = country === 'KR' && same(components.street, district)
    && /(?:동|읍|면|리|\d가)$/u.test(clean(components.street));
  if (['JP', 'TW'].includes(country) && same(components.admin1, locality)) {
    reasons.push('duplicate_admin1_locality');
  }
  const directChinaLocality = country === 'CN' && chinaDirectLocalities[clean(components.admin1)]?.includes(locality);
  if (district && same(locality, district) && !directChinaLocality) reasons.push('duplicate_locality_district');
  if (same(components.street, locality) || (!koreanLandLot && same(components.street, district))
    || same(components.street, components.admin1)) {
    reasons.push('street_matches_administration');
  }
};

const addCountryReasons = (country, components, reasons) => {
  const admin1 = clean(components.admin1);
  const locality = localityValue(components);
  const district = districtValue(components);
  const street = clean(components.street);
  if (country === 'US' && !/^(?:[A-Z]{2}|[\p{L} .'-]+)$/u.test(clean(components.admin1Code || admin1))) {
    reasons.push('invalid_us_admin1');
  }
  if (country === 'JP') {
    if (!japanese.test(`${admin1}${locality}${district}${street}`)) reasons.push('invalid_japanese_script');
    if (admin1 && (!/[都道府県]$/u.test(admin1) || admin1 === '京都')) reasons.push('invalid_japanese_prefecture');
    if (locality && !/[市区町村郡]$/u.test(locality)) reasons.push('invalid_japanese_locality');
  }
  if (country === 'TW') {
    if (!han.test(`${admin1}${locality}${street}`)) reasons.push('invalid_taiwan_script');
    if (admin1 && !/[縣市]$/u.test(admin1)) reasons.push('invalid_taiwan_admin1');
    if (locality && !/[區鄉鎮市]$/u.test(locality)) reasons.push('invalid_taiwan_locality');
  }
  if (['DE', 'FR'].includes(country) && (!letters.test(street) || /^\d+$/u.test(street))) {
    reasons.push('invalid_street_name');
  }
  if (country === 'IN' && latinOnlyFields.some((field) => hasNonLatinText(components[field]))) reasons.push('non_latin_text');
};

// India is published in English only; Devanagari, Tamil and other local-script text is not part of its contract.
const nonLatinCharacter = /(?![\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}])[\p{L}\p{M}\p{N}]/u;
const nonLatinRun = /(?:(?![\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}])[\p{L}\p{M}\p{N}]|[।॥])+/gu;
const latinOnlyFields = ['admin1', 'locality', 'postalLocality', 'district', 'street', 'buildingName', 'unit', 'houseNumber'];
export const englishOnlyCoreFields = ['street', 'locality', 'admin1'];
export const hasNonLatinText = (value) => nonLatinCharacter.test(String(value ?? ''));
const decimalDigits = (value) => String(value ?? '').replace(/\p{Nd}/gu, (digit) => {
  let start = digit.codePointAt(0);
  while (/\p{Nd}/u.test(String.fromCodePoint(start - 1))) start--;
  return String((digit.codePointAt(0) - start) % 10);
});
export const stripNonLatinText = (value) => clean(decimalDigits(value).replace(nonLatinRun, ' '))
  .replace(/[(\[{]\s*[)\]}]/gu, ' ').replace(/\s+([,;:])/gu, '$1').replace(/([,;:/|-])(?:\s*[,;:/|-])+/gu, '$1')
  .replace(/\s+/gu, ' ').replace(/^[\s,;:/|&–—-]+|[\s,;:/|&–—-]+$/gu, '');
// Returns the components without local-script text and the fields that held nothing else. A preferred value
// (an earlier English translation of the same field) replaces local-script text when it is Latin-only.
export const englishOnlyComponents = (components = {}, preferred = {}) => {
  const output = { ...components };
  const emptied = [];
  for (const field of latinOnlyFields) {
    const value = clean(output[field]);
    if (!value || !hasNonLatinText(value)) continue;
    const translated = clean(preferred[field]);
    const stripped = translated && !hasNonLatinText(translated) && letters.test(translated) ? translated : stripNonLatinText(value);
    if (stripped && (field === 'houseNumber' ? /[\p{L}\p{N}]/u : letters).test(stripped)) output[field] = stripped;
    else {
      delete output[field];
      emptied.push(field);
    }
  }
  return { components: output, emptied };
};

const addCoordinateReasons = (country, latitude, longitude, reasons) => {
  if (latitude === undefined && longitude === undefined) return;
  const lat = Number(latitude);
  const lon = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    reasons.push('invalid_coordinates');
    return;
  }
  const bounds = countryBoundAreas[country];
  if (bounds && !bounds.some(([minimumLongitude, minimumLatitude, maximumLongitude, maximumLatitude]) =>
    lon >= minimumLongitude && lat >= minimumLatitude && lon <= maximumLongitude && lat <= maximumLatitude)) {
    reasons.push('coordinates_outside_country');
  }
};

const localDigits = /[٠-٩۰-۹๐-๙]/gu;
const asciiDigit = (digit) => String(digit.codePointAt(0) - (digit >= '๐' ? 0x0E50 : digit >= '۰' ? 0x06F0 : 0x0660));

export const normalizePostcode = (countryCode, value) => {
  const country = clean(countryCode).toUpperCase();
  const source = clean(value).replace(localDigits, asciiDigit).toUpperCase();
  if (!source) return '';
  const packed = compact(source);
  if (country === 'CA' && /^[A-Z]\d[A-Z]\d[A-Z]\d$/u.test(packed)) return `${packed.slice(0, 3)} ${packed.slice(3)}`;
  if (country === 'GB' && /^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/u.test(packed)) return `${packed.slice(0, -3)} ${packed.slice(-3)}`;
  if (country === 'NL' && /^\d{4}[A-Z]{2}$/u.test(packed)) return `${packed.slice(0, 4)} ${packed.slice(4)}`;
  if (country === 'JP' && /^\d{7}$/u.test(packed)) return `${packed.slice(0, 3)}-${packed.slice(3)}`;
  if (country === 'BR' && /^\d{8}$/u.test(packed)) return `${packed.slice(0, 5)}-${packed.slice(5)}`;
  if (country === 'IN' && /^\d{6}$/u.test(packed)) return packed;
  return source;
};

const localityValue = (components) => clean(components.locality || components.postalLocality);
const districtValue = (components) => clean(components.district || components.dependentLocality);

export const normalizeAddressFacts = (countryCode, input = {}) => {
  const components = Object.fromEntries(Object.entries(input).map(([key, value]) => [key, typeof value === 'string' ? clean(value) : value]));
  components.postcode = normalizePostcode(countryCode, components.postcode);
  // Outside China a postcode that cannot be validated is left empty instead of rejecting a real address.
  if (components.postcode && clean(countryCode).toUpperCase() !== 'CN' && !isValidPostcode(clean(countryCode).toUpperCase(), components.postcode)) {
    components.postcode = '';
  }
  const buildingName = clean(components.buildingName);
  const unit = clean(components.unit);
  if (/^\d+[\p{L}\p{N}./-]*$/u.test(buildingName)) {
    delete components.buildingName;
  } else if (/^(?:apt|apartment|unit|ste|suite|fl|floor|bldg|building|#|no\.?)$/iu.test(buildingName)) {
    delete components.buildingName;
  }
  if (/^(?:apt|apartment|unit|ste|suite|fl|floor|#|no\.?)$/iu.test(unit)) delete components.unit;
  return components;
};

export const streetAddressKey = (countryCode, components = {}) => [
  'street', countryCode, components.admin1Code || components.admin1,
  components.locality || components.postalLocality, components.district || components.dependentLocality,
  components.street
].map((value) => clean(value).toLocaleLowerCase('und')).join('\u001f');

export const addressCanonicalKey = (countryCode, components = {}, matchLevel = 'premise') => {
  if (matchLevel === 'street') return streetAddressKey(countryCode, components);
  return ['premise', countryCode, components.admin1Code || components.admin1,
    components.locality || components.postalLocality, components.district || components.dependentLocality,
    components.postcode, components.street, components.houseNumber, components.unit
  ].map((value) => clean(value).toLocaleLowerCase('und')).join('\u001f');
};

// A premise needs a real house number. Local "no number" markers (S/N, snc, sin valor), values without any digit and
// whole address strings stored as the number only prove the street. British house names are a valid premise.
const noNumberMarker = /^(?:s\s*[-/.]?\s*n[º°o.]?|s\.?\s*n\.?\s*c\.?|sin\s+n[uú]mero|sem\s+n[uú]mero|sin\s+valor|n\s*\/\s*a|c\s*\/\s*o|-+)$/iu;
const houseNameCountries = new Set(['GB']);
const numerals = /[\p{N}〇一二三四五六七八九十百千]/u;
export const houseNumberIssue = (countryCode, houseNumber) => {
  const value = clean(houseNumber);
  if (!value || clean(countryCode).toUpperCase() === 'CN') return null;
  if (noNumberMarker.test(clean(value.replace(/\([^)]*\)/gu, ' ')))) return 'no_number_marker';
  if (value.length > 30) return 'overlong_house_number';
  if (!numerals.test(value) && !houseNameCountries.has(clean(countryCode).toUpperCase())) return 'house_number_without_digits';
  return null;
};

const fold = (value) => clean(value).normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('und').replace(/[^\p{L}\p{N}]+/gu, '');
const countryNameKeys = (countryCode) => new Set(Object.values(countryNames).map((names) => fold(names?.[countryCode])).filter(Boolean));
// German and Italian official names append the municipality type after a comma (Polle, Flecken).
const municipalityType = /^(?:stadt|flecken|gemeinde|markt|kirchspiel|hansestadt|amt|samtgemeinde)$/iu;
const segments = (value) => clean(value).split(/[,，;]/u).map((part) => clean(part.replace(/\([^)]*\)/gu, ' '))).filter(Boolean);
const administrativeKeys = (countryCode, components, exclude) => new Set([
  ...countryNameKeys(countryCode),
  ...['admin1', 'admin1Code', 'locality', 'postalLocality', 'district', 'postcode']
    .filter((field) => field !== exclude).map((field) => fold(components[field]))
].filter(Boolean));

// Splits "suburb, city" style values. The city is the part the catalog knows; without one a single remaining part is
// kept and anything else is cleared so the caller fills the city from coordinates.
export const splitConcatenatedLocality = (countryCode, components, isKnownCity = () => false) => {
  const output = { ...components };
  for (const field of ['locality', 'postalLocality']) {
    if (!/[,，;]/u.test(clean(output[field]))) continue;
    const dropped = administrativeKeys(countryCode, output, field);
    const parts = segments(output[field]).filter((part) => !dropped.has(fold(part)) && !municipalityType.test(part));
    const city = [...parts].reverse().find((part) => isKnownCity(part));
    output[field] = city || (parts.length === 1 ? parts[0] : '');
    if (field === 'locality' && city && parts[0] !== city && !clean(output.district)) output.district = parts[0];
  }
  return output;
};

// Trailing segments that repeat the city, region, postcode or country are dropped from the street.
export const trimStreetAdministration = (countryCode, components) => {
  const street = clean(components.street);
  if (!/[,，;]/u.test(street)) return components;
  const dropped = administrativeKeys(countryCode, components, 'street');
  const parts = segments(street);
  while (parts.length > 1 && dropped.has(fold(parts.at(-1)))) parts.pop();
  return { ...components, street: parts.join(', ') };
};
// Brazilian addresses legitimately name the block and lot (Quadra 47, Lote 17) after the street.
const brazilianLot = /^(?:quadra|qd\.?|lote|lt\.?|bloco|conjunto|casa)(?!\p{L})/iu;
const concatenatedStreet = (countryCode, street) => {
  const parts = segments(street);
  if (parts.length < 3) return false;
  return !(countryCode === 'BR' && parts.slice(1).every((part) => brazilianLot.test(part)));
};

const corruptedText = /�|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}][?？]|[?？][\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
// Object-replacement marks and emoji are rendering debris or decoration, never part of an address name.
export const junkCharacters = /[\uFFFC\p{Extended_Pictographic}]/u;
// A city field that holds a region code, a bare number, a postcode or a chained Thai subdistrict/district/province
// names no city.
// One district label (อำเภอ X) names a city; two labels or a trailing Bangkok segment chain several levels.
const thaiAdministrativeLabel = /ตำบล|ตําบล|อำเภอ|อําเภอ|จังหวัด|แขวง|เขต/gu;
const thaiAdministrativeChain = (value) => (value.match(thaiAdministrativeLabel) || []).length > 1
  || /\S\s+\S+\s(?:กรุงเทพฯ|กรุงเทพมหานคร)$/u.test(value);
export const localityIssue = (countryCode, components = {}) => {
  const regionCodes = [components.admin1, components.admin1Code].map((value) => clean(value).toUpperCase()).filter(Boolean);
  for (const field of ['locality', 'postalLocality']) {
    const value = clean(components[field]);
    if (!value) continue;
    if (/^\p{N}+$/u.test(value)) return 'locality_number';
    if (/\p{N}{4,}/u.test(value)) return 'locality_postcode';
    // A place name with a number glued on (Entrevennes0, Burgos11, ALAMILL0) is a source typo, not a locality.
    if (/\p{L}{3}\p{N}+$/u.test(value)) return 'locality_trailing_number';
    if (/^[A-Z]{1,3}$/u.test(value) && regionCodes.includes(value)) return 'locality_region_code';
    if (clean(countryCode).toUpperCase() === 'TH' && thaiAdministrativeChain(value)) return 'locality_concatenated';
  }
  return '';
};

// `requirePostcode: false` lets an import write a row whose postcode the post-import inference may still fill; rows it
// cannot fill are retired before publication.
export const validateAddressQuality = ({ countryCode, components, latitude, longitude, matchLevel = 'premise', requirePostcode = true } = {}) => {
  const country = clean(countryCode).toUpperCase();
  const policy = policies[country];
  const normalizedComponents = normalizeAddressFacts(country, components);
  const reasons = [];
  if (!policy) reasons.push('unsupported_country');
  const streetLevel = matchLevel === 'street' && country !== 'CN';
  if (!['street', 'premise', 'subpremise'].includes(matchLevel)
    || (matchLevel === 'street' && !streetLevel)) reasons.push('invalid_match_level');
  if (streetLevel && ['houseNumber', 'buildingName', 'unit'].some((field) => clean(normalizedComponents[field]))) {
    reasons.push('street_has_premise_fields');
  }
  // A Chinese residential address is identified by its community name; road and house number are optional there.
  const chinaCommunity = country === 'CN' && clean(normalizedComponents.buildingName);
  if (!streetLevel && !clean(normalizedComponents.houseNumber) && !chinaCommunity) reasons.push('missing_house_number');
  else if (!streetLevel && houseNumberIssue(country, normalizedComponents.houseNumber)) reasons.push('invalid_house_number');
  if (concatenatedStreet(country, normalizedComponents.street)) reasons.push('concatenated_street');
  if (['locality', 'postalLocality'].some((field) => segments(normalizedComponents[field]).length > 1)) reasons.push('concatenated_locality');
  if (country !== 'CN' && localityIssue(country, normalizedComponents)) reasons.push('invalid_locality');
  if (!clean(normalizedComponents.street)) {
    if (!chinaCommunity) reasons.push('missing_street');
  }
  else if (isPlaceholderStreet(normalizedComponents.street)) reasons.push('placeholder_street');
  if (policy?.admin1 && !clean(normalizedComponents.admin1 || normalizedComponents.admin1Code)) reasons.push('missing_admin1');
  if (policy?.locality && !localityValue(normalizedComponents)) reasons.push('missing_locality');
  if (policy?.district && !districtValue(normalizedComponents)) reasons.push('missing_district');
  const postcode = clean(normalizedComponents.postcode);
  if (policy?.postcode && requirePostcode && !postcode) reasons.push('missing_postcode');
  if (postcode && !isValidPostcode(country, postcode)) reasons.push('invalid_postcode');
  if (clean(normalizedComponents.buildingName) && /^\d+[\p{L}\p{N}./-]*$/u.test(clean(normalizedComponents.buildingName))) {
    reasons.push('numeric_building_name');
  }
  // A "?" or U+FFFD next to CJK text is a character the source lost in an encoding step (e.g. ?榔路 for 檳榔路).
  if (['admin1', 'locality', 'postalLocality', 'district', 'street', 'buildingName', 'unit']
    .some((field) => corruptedText.test(String(normalizedComponents[field] ?? '')))) reasons.push('corrupted_text');
  if (['admin1', 'locality', 'postalLocality', 'district', 'dependentLocality', 'street', 'buildingName', 'unit', 'houseNumber']
    .some((field) => junkCharacters.test(String(normalizedComponents[field] ?? '')))) reasons.push('junk_characters');
  addDuplicateReasons(country, normalizedComponents, reasons);
  addCountryReasons(country, normalizedComponents, reasons);
  addCoordinateReasons(country, latitude, longitude, reasons);
  return { valid: reasons.length === 0, reasons, components: normalizedComponents };
};

export const addressQualitySqlClause = (prefix = '') => {
  const value = (field) => `trim(${prefix}${field}) <> ''`;
  const fresh = `(${prefix}expires_at IS NULL OR CASE WHEN ${prefix}expires_at ~
    '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}'
    THEN ${prefix}expires_at::timestamptz > CURRENT_TIMESTAMP
    WHEN ${prefix}expires_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    THEN ${prefix}expires_at::date >= CURRENT_DATE
    ELSE FALSE END)`;
  const city = `(${value('locality')} OR (${value('postal_locality')} AND ${prefix}postal_locality <> ${prefix}street))`;
  const district = `(${value('district')})`;
  const region = `(${value('admin1')} OR ${value('admin1_code')})`;
  const streetLevel = `(${prefix}country_code <> 'CN' AND ${prefix}match_level = 'street'
    AND trim(${prefix}house_number) = '' AND trim(${prefix}building_name) = '' AND ${prefix}property_type = 'unknown')`;
  const groups = new Map();
  for (const [country, policy] of Object.entries(policies)) {
    const checks = country === 'CN'
      ? [`(${prefix}match_level IN ('premise','subpremise') AND (${value('house_number')} OR ${value('building_name')}))`]
      : [`((${prefix}match_level IN ('premise','subpremise') AND ${value('house_number')}) OR ${streetLevel})`, value('street')];
    checks.push(`lower(trim(${prefix}street)) NOT IN (${placeholderStreetNames.map((name) => `'${name}'`).join(',')})`);
    if (policy.admin1) checks.push(region);
    if (policy.locality) checks.push(city);
    if (policy.district) checks.push(district);
    if (country === 'CN') checks.push(value('postcode'));
    if (country === 'SG') checks.push(`${prefix}postcode ~ '^[0-9]{6}$'`);
    else if (policy.postcode) checks.push(value('postcode'));
    const expression = [fresh, ...checks].join(' AND ');
    const countries = groups.get(expression) || [];
    countries.push(country);
    groups.set(expression, countries);
  }
  const coordinateClause = Object.entries(countryBoundAreas).map(([country, bounds]) =>
    `(${prefix}country_code='${country}' AND (${bounds.map(([minimumLongitude, minimumLatitude, maximumLongitude, maximumLatitude]) =>
      `(${prefix}longitude BETWEEN ${minimumLongitude} AND ${maximumLongitude} AND ${prefix}latitude BETWEEN ${minimumLatitude} AND ${maximumLatitude})`
    ).join(' OR ')}))`
  ).join(' OR ');
  const policyClause = [...groups]
    .map(([expression, countries]) => `(${prefix}country_code IN (${countries.map((country) => `'${country}'`).join(',')}) AND ${expression})`)
    .join(' OR ');
  return `(${coordinateClause}) AND (${policyClause})`;
};

export const countryAddressPolicies = policies;
