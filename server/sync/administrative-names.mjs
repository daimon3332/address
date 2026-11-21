import { requiresAdminCode } from '../../src/domain/address-contracts.mjs';
import { englishNativeCountries } from '../database/catalog-native-names.mjs';
import { nameVariants, variantRegionIndex } from '../../src/domain/region-names.mjs';

export const ADMINISTRATIVE_NAMES_REVISION = 'administrative-names-v19';
// A country whose published rows need another pass without rescanning every country takes its own revision.
// v20: IT rescans rows imported while a region-polygon assignment failed (a Gressoney address left in Biella); FR takes
// catalog Chinese city names the street-type check had refused (Vivier au Court). IT v21 moves 2026-10-25 imports of
// Trentino addresses left in Veneto or Bolzano provinces (Ala recorded as Vicenza) to the province their polygon names.
// v23 (2026-11-21) judges rows imported since the last pass, which only a postcode fill used to send here (a Port au
// Port address off the Canadian coastline, overseas French departments without a region), and rejects localities with
// a number glued on.
const countryRevisions = { IT: 'administrative-names-v21',
  ...Object.fromEntries(['CA', 'DE', 'ES', 'FR', 'IN', 'MY', 'NG', 'TH', 'US'].map((country) => [country, 'administrative-names-v23'])) };
// Rows the structure and administrative-names repairs retired by region polygons the publication check cannot see; only
// these repairs' own next revision may restore them.
export const repairRetirement = /^publication-validation:(?:address-structure|administrative-names)-/u;
export const administrativeNamesRevision = (countryCode) => countryRevisions[countryCode] || ADMINISTRATIVE_NAMES_REVISION;
// USPS, Canada Post, Australia Post and Correios write first-level regions as codes, so the native and English
// address keep the code; the Chinese address always names the region.
export const postalRegionCodeCountries = new Set(['US', 'CA', 'AU', 'BR']);
// Italian addresses carry the province sigla as admin1Code while admin1 names the region.
const lowerLevelCodeCountries = new Set(['IT']);
// Chinese-script and city-state countries derive their variants from the native text and their own catalogs.
export const administrativeNameCountries = (countryCode) => !['CN', 'HK', 'TW', 'SG'].includes(countryCode);
// Countries whose admin1 names a province or department below the first-level region the polygons identify.
export const mixedLevelCountries = new Set(['ES', 'FR', 'IT', 'PH', 'GB']);
// Nearest catalog city considered when choosing the province of a point, in degrees.
const NEAREST_CITY_DEGREES = 0.25;
// Official postcode prefixes: Spanish postcodes start with the INE province number, French ones with the department
// (Corsica 200-201 is 2A, 202-206 is 2B; Paris is the collectivity 75C). Codes are the catalog's ISO 3166-2 province
// and department codes.
const spanishProvinces = ['VI', 'AB', 'A', 'AL', 'AV', 'BA', 'PM', 'B', 'BU', 'CC', 'CA', 'CS', 'CR', 'CO', 'C', 'CU', 'GI', 'GR', 'GU',
  'SS', 'H', 'HU', 'J', 'LE', 'L', 'LO', 'LU', 'M', 'MA', 'MU', 'NA', 'OR', 'O', 'P', 'GC', 'PO', 'SA', 'TF', 'S', 'SG', 'SE', 'SO', 'T',
  'TE', 'TO', 'V', 'VA', 'BI', 'ZA', 'Z'];
const prefixProvince = {
  ES: (postcode) => /^\d{5}$/u.test(postcode) ? spanishProvinces[Number(postcode.slice(0, 2)) - 1] || null : null,
  FR: (postcode) => !/^\d{5}$/u.test(postcode) || /^(?:69|97|98)/u.test(postcode) ? null
    : postcode.startsWith('20') ? (Number(postcode.slice(2, 3)) <= 1 ? '2A' : '2B')
    : postcode.startsWith('75') ? '75C' : postcode.slice(0, 2)
};
// Italian CAP prefixes that belong to a single province (shared ones such as 20 Milano/Monza are left out); used only
// when the catalog postcode table has no province.
const italianProvinces = Object.fromEntries(Object.entries({
  '00': 'RM', '01': 'VT', '02': 'RI', '03': 'FR', '04': 'LT', '05': 'TR', '06': 'PG', 10: 'TO', 11: 'AO', 12: 'CN', 14: 'AT',
  15: 'AL', 16: 'GE', 17: 'SV', 18: 'IM', 19: 'SP', 21: 'VA', 24: 'BG', 25: 'BS', 27: 'PV', 29: 'PC', 30: 'VE', 31: 'TV',
  32: 'BL', 35: 'PD', 36: 'VI', 37: 'VR', 38: 'TN', 39: 'BZ', 40: 'BO', 41: 'MO', 42: 'RE', 43: 'PR', 44: 'FE', 45: 'RO',
  46: 'MN', 48: 'RA', 50: 'FI', 51: 'PT', 52: 'AR', 53: 'SI', 54: 'MS', 55: 'LU', 56: 'PI', 57: 'LI', 58: 'GR', 59: 'PO',
  60: 'AN', 61: 'PU', 62: 'MC', 64: 'TE', 65: 'PE', 66: 'CH', 67: 'AQ', 70: 'BA', 71: 'FG', 72: 'BR', 73: 'LE', 74: 'TA',
  75: 'MT', 80: 'NA', 81: 'CE', 82: 'BN', 83: 'AV', 84: 'SA', 85: 'PZ', 87: 'CS', 90: 'PA', 91: 'TP', 92: 'AG', 93: 'CL',
  94: 'EN', 95: 'CT', 96: 'SR', 97: 'RG', 98: 'ME'
}).map(([prefix, code]) => [String(prefix).padStart(2, '0'), code]));
const fallbackProvince = { IT: (postcode) => /^\d{5}$/u.test(postcode) ? italianProvinces[postcode.slice(0, 2)] || null : null };
export const usTerritories = Object.freeze({
  PR: { name: 'Puerto Rico', zh: '波多黎各' }, VI: { name: 'U.S. Virgin Islands', zh: '美属维尔京群岛' },
  GU: { name: 'Guam', zh: '关岛' }, AS: { name: 'American Samoa', zh: '美属萨摩亚' }, MP: { name: 'Northern Mariana Islands', zh: '北马里亚纳群岛' }
});

// Provinces merged into another by Vietnam's Resolution 202/2025/QH15 (in force 1 July 2025), by the province that now
// holds them; the catalog lists the 34 current provinces.
const vietnamMergedProvinces = {
  'Tuyên Quang': ['Hà Giang'], 'Lào Cai': ['Yên Bái'], 'Thái Nguyên': ['Bắc Kạn'], 'Phú Thọ': ['Vĩnh Phúc', 'Hòa Bình'],
  'Bắc Ninh': ['Bắc Giang'], 'Hưng Yên': ['Thái Bình'], 'Hải Phòng': ['Hải Dương'], 'Ninh Bình': ['Hà Nam', 'Nam Định'],
  'Quảng Trị': ['Quảng Bình'], 'Đà Nẵng': ['Quảng Nam'], 'Quảng Ngãi': ['Kon Tum'], 'Gia Lai': ['Bình Định'],
  'Khánh Hòa': ['Ninh Thuận'], 'Lâm Đồng': ['Đắk Nông', 'Bình Thuận'], 'Đắk Lắk': ['Phú Yên'],
  'Hồ Chí Minh': ['Bà Rịa - Vũng Tàu', 'Bà Rịa Vũng Tàu', 'Vũng Tàu - Bà Rịa', 'Bình Dương'], 'Đồng Nai': ['Bình Phước'],
  'Tây Ninh': ['Long An'], 'Cần Thơ': ['Sóc Trăng', 'Hậu Giang'], 'Vĩnh Long': ['Bến Tre', 'Trà Vinh'], 'Đồng Tháp': ['Tiền Giang'],
  'Cà Mau': ['Bạc Liêu'], 'An Giang': ['Kiên Giang'], 'Thừa Thiên-Huế': ['Huế', 'Thành phố Huế']
};
const regionSuccessors = { VN: Object.entries(vietnamMergedProvinces).flatMap(([current, merged]) => merged.map((name) => [name, current])) };
// Current first-level units the catalog does not list yet keep their names: the Jeonnam-Gwangju Unified Special City
// replaced Gwangju and South Jeolla on 1 July 2026.
const regionsMissingFromCatalog = {
  KR: { 전남광주통합특별시: { en: 'Jeonnam Gwangju Unified Special City', zh: '全罗南道光州统一特别市' } }
};

const clean = (value) => String(value ?? '').trim();
const fold = (value) => clean(value).normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('und').replace(/[^\p{L}\p{N}]+/gu, '');
const han = /\p{Script=Han}/u;
// Region codes compare without punctuation, so "B.C." and "A:K" find BC and AK.
const codeKey = (value) => clean(value).toUpperCase().replace(/[^\p{L}\p{N}]+/gu, '');
const postcodeKey = (value) => clean(value).toUpperCase().replace(/[\s-]+/gu, '');
const unique = (set) => set?.size === 1 ? [...set][0] : null;
const add = (map, key, value) => {
  if (!key) return;
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(value);
};

// Resolves first-level regions and their cities from the catalog. The admin1 text decides the region; the code is
// trusted only when there is no usable text and the city agrees, because earlier imports filled codes from the
// nearest region centroid.
export const createAdministrativeNames = (countryCode, regions = [], cities = [], postcodes = []) => {
  const byId = new Map(regions.map((region) => [region.id, region]));
  const rootOf = (region) => {
    let current = region;
    for (let depth = 0; current?.parent_id != null && byId.has(current.parent_id) && depth < 8; depth += 1) current = byId.get(current.parent_id);
    return current;
  };
  const roots = regions.filter((region) => region.parent_id == null || !byId.has(region.parent_id));
  const byText = new Map();
  const byCode = new Map();
  const lowerByText = new Map();
  const lowerByCode = new Map();
  for (const region of roots) {
    for (const name of new Set([region.name, region.native_name, region.zh_name].map(fold))) add(byText, name, region);
    add(byCode, codeKey(region.code), region);
  }
  // Mixed-level countries (Italian provinces, Spanish provinces) may name a lower catalog level in admin1.
  for (const region of regions.filter((entry) => !roots.includes(entry))) {
    for (const name of new Set([region.name, region.native_name, region.zh_name].map(fold))) add(lowerByText, name, region);
    add(lowerByCode, codeKey(region.code), region);
  }
  const citiesByRoot = new Map();
  for (const city of cities) {
    const root = rootOf(byId.get(city.region_id));
    if (!citiesByRoot.has(root?.id ?? null)) citiesByRoot.set(root?.id ?? null, new Map());
    for (const name of new Set([city.name, city.native_name, city.zh_name].map(fold))) add(citiesByRoot.get(root?.id ?? null), name, city);
  }
  const cityRoots = new Map();
  for (const city of cities) {
    const root = rootOf(byId.get(city.region_id));
    if (root) for (const name of new Set([city.name, city.native_name].map(fold))) add(cityRoots, name, root);
  }
  const successors = new Map((regionSuccessors[countryCode] || []).flatMap(([name, current]) =>
    [...nameVariants(name)].map((variant) => [variant, current])));
  const missingNames = new Map(Object.entries(regionsMissingFromCatalog[countryCode] || {}).map(([name, names]) => [fold(name), { name, ...names }]));
  const missing = new Set(missingNames.keys());
  const byVariant = variantRegionIndex(roots, (region) => region);
  const regionFor = ({ admin1, admin1Code, locality, postalLocality }) => {
    const text = clean(admin1);
    const named = unique(byText.get(fold(text)));
    if (named) return { region: named, byCode: false };
    // A merged region's former name takes the name of the region that holds it now.
    const successor = text && [...nameVariants(text)].map((variant) => successors.get(variant)).find(Boolean);
    const current = successor && unique(byText.get(fold(successor)));
    if (current) return { region: current, byCode: false, renamed: true };
    const coded = unique(byCode.get(codeKey(text)));
    if (coded) return { region: coded, byCode: true };
    const lower = !byText.has(fold(text)) && unique(lowerByText.get(fold(text)));
    if (lower) return { region: lower, byCode: false, root: rootOf(lower) };
    const lowerCode = !byCode.has(codeKey(text)) && unique(lowerByCode.get(codeKey(text)));
    if (lowerCode) return { region: lowerCode, byCode: true, root: rootOf(lowerCode) };
    // Bilingual labels such as "New Brunswick / Nouveau-Brunswick" name one region in either part.
    const parts = text.includes('/') ? new Set(text.split('/').map((part) => unique(byText.get(fold(part)))).filter(Boolean)) : new Set();
    if (parts.size === 1) return { region: [...parts][0], byCode: false, renamed: true };
    if (lowerLevelCodeCountries.has(countryCode)) return null;
    // Where the post writes regions as codes, text that names no region (e.g. "Brasil") defers to the code when the
    // city lies in that region. Elsewhere unmatched text is often a fuller official name ("Белгородская область").
    const fromField = unique(byCode.get(codeKey(admin1Code)));
    // A shortened name ("Алтай" for Республика Алтай and Алтайский край) is settled by the code it names part of.
    const shortened = fold(text).length >= 4 && [fromField?.native_name, fromField?.name].some((name) => fold(name).includes(fold(text)));
    if (fromField && shortened) return { region: fromField, byCode: false, renamed: true };
    const inRegion = (value) => clean(value) && cityFor(fromField, value);
    if (fromField && (!text || postalRegionCodeCountries.has(countryCode) && (inRegion(locality) || inRegion(postalLocality)))) {
      return { region: fromField, byCode: true };
    }
    // Official and colloquial spellings (서울특별시, منطقة الرياض, Белгородская область) name the region and keep their text.
    const spelled = text && byVariant(text);
    if (spelled) return { region: spelled, byCode: false, spelled: true };
    return null;
  };
  // Text naming no region in any spelling (typos, a city, a phone number) takes the first-level region of the polygon
  // containing the point. US territories and current units missing from the catalog keep their names.
  const regionRecognized = (components) => Boolean(regionFor(components) || missing.has(fold(components.admin1))
    || countryCode === 'US' && usTerritories[clean(components.admin1Code || components.admin1).toUpperCase()]);
  const unrecognizedRegion = (components, boundary, { latitude, longitude } = {}) => {
    if (regionRecognized(components)) return null;
    const code = clean(boundary?.code).toUpperCase();
    // Without an admin1 and a coded polygon (overseas territories), a city the whole catalog places in one region names
    // it, or else the one region every catalog city near the point belongs to.
    const empty = !clean(components.admin1);
    const named = empty && [components.locality, components.postalLocality]
      .map((value) => clean(value) && unique(cityRoots.get(fold(value)))).find(Boolean);
    const nearby = empty && !named && Number.isFinite(Number(latitude)) && Number.isFinite(Number(longitude))
      ? unique(new Set(located.filter((city) => (Number(city.latitude) - Number(latitude)) ** 2 + (Number(city.longitude) - Number(longitude)) ** 2
        < NEAREST_CITY_DEGREES ** 2).map((city) => rootOf(byId.get(city.region_id))))) : null;
    const root = code.startsWith(`${countryCode}-`) ? rootsByCode.get(codeKey(code.slice(3))) : named || nearby || null;
    // A polygon naming a current unit the catalog does not list yet gives that unit.
    const current = !root && missingNames.get(fold(boundary?.name));
    if (current) return { admin1: current.name, admin1Code: '', admin1En: current.en, admin1Zh: current.zh };
    if (!root) return null;
    const admin1 = postalRegionCodeCountries.has(countryCode) ? clean(root.code) : clean(root.native_name) || clean(root.name);
    return admin1 ? { admin1, admin1Code: lowerLevelCodeCountries.has(countryCode) ? '' : clean(root.code),
      admin1En: clean(root.name) || admin1, admin1Zh: han.test(clean(root.zh_name)) ? clean(root.zh_name) : '' } : null;
  };
  const cityFor = (region, value) => unique(citiesByRoot.get(region?.id ?? null)?.get(fold(value)));
  const postcodeRoots = new Map();
  const postcodeRegions = new Map();
  for (const postcode of postcodes) {
    add(postcodeRoots, postcodeKey(postcode.code), rootOf(byId.get(postcode.region_id)));
    add(postcodeRegions, postcodeKey(postcode.code), byId.get(postcode.region_id));
  }
  // The region a catalog postcode belongs to: the full code, its outward part, or its first five or three characters.
  const postcodeLookup = (map) => (postcode) => {
    const value = clean(postcode).toUpperCase();
    for (const candidate of new Set([value, value.split(/\s/u)[0], value.slice(0, 5), value.slice(0, 3)].map(postcodeKey))) {
      const found = map.get(candidate);
      if (found) return found.has(undefined) ? null : unique(found);
    }
    return null;
  };
  const postcodeRegionFor = postcodeLookup(postcodeRoots);
  // The Métropole de Lyon shares the 69 prefix with the Rhône department, so 69 is left to the catalog.
  const catalogProvinceFor = postcodeLookup(postcodeRegions);
  const provinceByCode = (code) => code ? unique(lowerByCode.get(codeKey(code))) : null;
  const postcodeProvinceFor = (postcode) => provinceByCode(prefixProvince[countryCode]?.(clean(postcode)))
    || catalogProvinceFor(postcode) || provinceByCode(fallbackProvince[countryCode]?.(clean(postcode)));
  // Regions no catalog city belongs to group several provinces (the Collectivité européenne d'Alsace); a postcode
  // inside one of them does not contradict it.
  const regionsWithCities = new Set(cities.map((city) => city.region_id));
  const located = cities.filter((city) => Number.isFinite(Number(city.latitude)) && Number.isFinite(Number(city.longitude))
    && byId.has(city.region_id));
  const nearestRegionIn = (root, latitude, longitude) => {
    let best = null;
    let distance = NEAREST_CITY_DEGREES ** 2;
    for (const city of located) {
      const next = (Number(city.latitude) - latitude) ** 2 + (Number(city.longitude) - longitude) ** 2;
      if (next < distance && rootOf(byId.get(city.region_id))?.id === root.id) [best, distance] = [byId.get(city.region_id), next];
    }
    return best;
  };
  const rootsByCode = new Map(roots.map((region) => [codeKey(region.code), region]));
  const englishNative = englishNativeCountries.has(countryCode);
  // A catalog English or Chinese name shared by two regions (e.g. Moscow city and oblast) cannot identify either.
  const shared = (field) => {
    const counts = new Map();
    for (const region of regions) if (clean(region[field])) counts.set(fold(region[field]), (counts.get(fold(region[field])) || 0) + 1);
    return (value) => (counts.get(fold(value)) || 0) > 1;
  };
  const sharedEnglish = shared('name');
  const sharedChinese = shared('zh_name');
  // Japanese place names are already Chinese characters; the catalog only fills a Chinese name that has none.
  const chineseFill = countryCode === 'JP';
  return {
    regionFor,
    regionRecognized,
    unrecognizedRegion,
    postcodeRegionFor,
    // Mixed-level countries: the first-level polygon containing the point overrules an admin1 from another region,
    // which is replaced by the province of its postcode inside the polygon region, or by the region itself. Inside the
    // right region a province changes only when the postcode and the nearest catalog city agree on another one. Text
    // that names no catalog region is left as it is.
    regionInBoundary(components, boundary, { postcode, latitude, longitude } = {}) {
      const code = clean(boundary?.code).toUpperCase();
      if (!mixedLevelCountries.has(countryCode) || !code.startsWith(`${countryCode}-`)) return null;
      const root = rootsByCode.get(codeKey(code.slice(3)));
      const match = root && regionFor(components);
      if (!match) return null;
      const current = rootOf(match.region);
      const lowerLevel = match.region.id !== current.id;
      const inRoot = (region) => region && region.id !== root.id && rootOf(region)?.id === root.id ? region : null;
      const posted = inRoot(postcodeProvinceFor(postcode));
      const nearby = () => Number.isFinite(Number(latitude)) && Number.isFinite(Number(longitude))
        ? inRoot(nearestRegionIn(root, Number(latitude), Number(longitude))) : null;
      let target = null;
      if (current.id !== root.id) target = lowerLevel && posted || root;
      else if (lowerLevel && regionsWithCities.has(match.region.id) && posted && posted.id !== match.region.id
        && nearby()?.id === posted.id) target = posted;
      if (!target) return null;
      // Italian admin1Code is the province sigla; a region alone leaves it empty rather than wrong.
      const sigla = lowerLevelCodeCountries.has(countryCode) && target.id === root.id;
      const admin1 = clean(target.native_name) || clean(target.name);
      return { admin1, admin1Code: sigla ? '' : clean(target.code), admin1En: clean(target.name) || admin1,
        admin1Zh: han.test(clean(target.zh_name)) ? clean(target.zh_name) : '' };
    },
    // The catalog's corrections to a native address and its English and Chinese variants. With the stored variants,
    // English city names are only filled where none is in Latin script.
    names(components = {}, current) {
      const keepChinese = (field) => chineseFill && current && han.test(clean(current['zh-CN']?.[field]));
      const result = { native: {}, en: {}, 'zh-CN': {} };
      const match = regionFor(components);
      const code = clean(components.admin1Code || components.admin1).toUpperCase();
      const territory = countryCode === 'US' && !match ? usTerritories[code] : null;
      if (match) {
        const { region } = match;
        if (!match.root && requiresAdminCode(countryCode) && !lowerLevelCodeCountries.has(countryCode) && clean(region.code)
          && clean(components.admin1Code).toUpperCase() !== clean(region.code).toUpperCase()) result.native.admin1Code = clean(region.code);
        const text = clean(components.admin1);
        const keepsCode = match.byCode && postalRegionCodeCountries.has(countryCode);
        const nativeName = keepsCode ? text && clean(region.code) || text : clean(region.native_name) || clean(region.name);
        // Japanese addresses name the prefecture in full (大阪府, not 大阪).
        const shortPrefecture = countryCode === 'JP' && /[都道府県]$/u.test(nativeName) && text !== nativeName && nativeName.startsWith(text);
        // English-language addresses write the catalog's casing (kerala, TAMIL NADU → Kerala, Tamil Nadu).
        const recased = englishNative && countryCode !== 'MY' && !keepsCode && text.toLocaleLowerCase() === nativeName.toLocaleLowerCase();
        if ((match.byCode || match.renamed || shortPrefecture || recased) && nativeName && nativeName !== text) result.native.admin1 = nativeName;
        // English-language countries write the same region in both variants; Malaysia keeps Malay state names natively.
        // A region recognized by another spelling keeps it, so English-language countries write that spelling twice.
        const english = keepsCode || englishNative && countryCode !== 'MY' ? (match.spelled ? text : nativeName)
          : !sharedEnglish(region.name) && clean(region.name) || '';
        if (english) result.en.admin1 = english;
        if (han.test(clean(region.zh_name)) && !sharedChinese(region.zh_name) && !keepChinese('admin1')) result['zh-CN'].admin1 = clean(region.zh_name);
      } else if (territory) {
        result['zh-CN'].admin1 = territory.zh;
      } else if (missingNames.has(fold(components.admin1))) {
        const current = missingNames.get(fold(components.admin1));
        if (!englishNative) result.en.admin1 = current.en;
        result['zh-CN'].admin1 = current.zh;
      }
      for (const field of ['locality', 'postalLocality']) {
        // English-language countries write the same city in both variants; accented local spellings (Montréal) stay.
        if (englishNative && countryCode !== 'MY' && clean(components[field]) && clean(current?.en?.[field])
          && fold(current.en[field]) !== fold(components[field])) result.en[field] = clean(components[field]);
        const city = clean(components[field]) && cityFor(match?.root || match?.region, components[field]);
        if (!city) continue;
        if (!englishNative && /\p{Script=Latin}/u.test(clean(city.name)) && !/\p{Script=Latin}/u.test(clean(current?.en?.[field]))) {
          result.en[field] = clean(city.name);
        }
        if (han.test(clean(city.zh_name)) && !keepChinese(field)) result['zh-CN'][field] = clean(city.zh_name);
      }
      return result;
    }
  };
};

// Singapore is one city: an admin1 naming neither it nor a catalog district (an OSM 東京都) becomes Singapore.
export const singaporeRegion = (regions = []) => {
  const known = new Set(['singapore', '新加坡', ...regions.flatMap((region) => [region.name, region.native_name, region.zh_name])].map(fold).filter(Boolean));
  return (components) => clean(components.admin1) && !known.has(fold(components.admin1))
    ? { admin1: 'Singapore', admin1Code: '', admin1En: 'Singapore', admin1Zh: '新加坡' } : null;
};

export const loadAdministrativeNames = async (database, countryCode, { withPostcodes = false } = {}) => {
  const regions = (await database.prepare(`SELECT id,parent_id,code,name,native_name,zh_name FROM catalog_regions WHERE country_code=?`)
    .bind(countryCode).all()).results || [];
  const cities = (await database.prepare(`SELECT region_id,name,native_name,zh_name,latitude,longitude FROM catalog_cities WHERE country_code=?`)
    .bind(countryCode).all()).results || [];
  const postcodes = withPostcodes ? (await database.prepare('SELECT region_id,code FROM catalog_postcodes WHERE country_code=? AND region_id IS NOT NULL')
    .bind(countryCode).all()).results || [] : [];
  return createAdministrativeNames(countryCode, regions, cities, postcodes);
};
