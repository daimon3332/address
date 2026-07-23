// Reverse-geocodes address points to catalog admin1/locality names when the
// source data omits addr:city / addr:state tags. Runs at import time so the
// stored pool always carries region and city fields.
//
// resolveHierarchy() additionally re-anchors a record's admin1/city/district to
// the authoritative catalog tiers by coordinate, overriding untrustworthy source
// text (e.g. OSM storing a district name in the city field). City tier and
// district tier are separated by catalog_cities.type so a district can never be
// mistaken for a city.

const RADIANS = Math.PI / 180;

import { pinyin } from 'pinyin-pro';

// GeoNames Chinese alternate names are machine-sourced and occasionally garbage
// (e.g. 痴汉 for Chikan 赤坎). A native_name is trusted only when its pinyin
// matches the English name; otherwise the entry keeps only its English name and
// Chinese output falls back to it.
const pinyinKey = (value) => {
  try {
    return pinyin(String(value || ''), { toneType: 'none', type: 'array' }).join('').toLowerCase().replace(/[^a-z]/g, '');
  } catch {
    return '';
  }
};
const englishKey = (value) => String(value || '').toLowerCase().replace(/\s*(district|county|city|town|township|new area|qu|shi|xian)\s*$/i, '').replace(/[^a-z]/g, '');
const hanPattern = /\p{Script=Han}/u;
// Known GeoNames homophone typos that pass the pinyin check (same pronunciation,
// wrong characters). Verified against official district names.
const chineseNameCorrections = new Map([
  ['拱术', '拱墅'], ['立夏', '历下'], ['胡里', '湖里'], ['安喜', '安溪'], ['张普', '漳浦']
]);
const chineseNameTrustworthy = (nativeName, englishName) => {
  const native = String(nativeName || '').trim();
  if (!native || !hanPattern.test(native)) return false;
  const target = englishKey(englishName);
  if (!target) return true;
  const candidate = pinyinKey(native.replace(/(?:区|县|市|镇|旗|乡|街道|新区)$/u, ''));
  if (!candidate) return false;
  return candidate === target || target.startsWith(candidate) || candidate.startsWith(target);
};

const distanceScore = (lat1, lon1, lat2, lon2) => {
  const dLat = lat1 - lat2;
  const dLon = (lon1 - lon2) * Math.cos(((lat1 + lat2) / 2) * RADIANS);
  return dLat * dLat + dLon * dLon;
};

// Region names that must never appear for a given country (cross-border catalog leakage).
const excludedRegionNames = {
  CN: [/香港/, /澳門/, /澳门/, /hong\s?kong/i, /macau/i, /macao/i, /台湾/, /臺灣/, /taiwan/i]
};

// catalog_cities.type values grouped into administrative tiers. The city tier is
// the "addressable city" level (地级市 for China); everything more granular
// (county-level cities, districts, towns, villages) is district tier so a small
// place can never be mistaken for the city. Per-country overrides below adjust
// this default where a catalog names its tiers differently.
const DEFAULT_CITY_TIER_TYPES = new Set([
  'prefecture', 'adm2', 'special municipality', 'capital'
]);
const DEFAULT_DISTRICT_TIER_TYPES = new Set([
  'city', 'cities', 'district', 'county', 'banner', 'adm3', 'adm4',
  'section', 'town', 'township', 'subdistrict', 'area', 'administrative zone'
]);

// Anchor policy per geo-anchored country. `cityTypes` overrides the city tier;
// `latinScript` skips the pinyin sanitizer (only meaningful for Han catalogs);
// `cityRadius`/`districtRadius` in degrees. Countries absent here are not anchored.
const ANCHOR_CONFIG = {
  CN: { cityTypes: ['prefecture', 'adm2', 'special municipality', 'capital'], sanitizePinyin: true, cityRadius: 1.6, districtRadius: 0.6 },
  RU: {
    cityTypes: ['city', 'adm2', 'capital'], sanitizePinyin: false, cityRadius: 1.2, districtRadius: 0.3,
    // Administrative districts (район etc.) are typed 'city' in the RU catalog;
    // they must never be offered as a settlement.
    excludeCityPattern: /район|поселение|сельсовет|городской округ/iu
  }
};

const finiteCoord = (entry) => Number.isFinite(entry.latitude) && Number.isFinite(entry.longitude);

export class CatalogReverseGeocoder {
  constructor(countryCode, regions, cities) {
    this.countryCode = countryCode;
    this.anchorConfig = ANCHOR_CONFIG[countryCode] || null;
    const cityTierTypes = this.anchorConfig?.cityTypes
      ? new Set(this.anchorConfig.cityTypes)
      : DEFAULT_CITY_TIER_TYPES;
    const districtTierTypes = new Set([...DEFAULT_DISTRICT_TIER_TYPES, ...DEFAULT_CITY_TIER_TYPES].filter((type) => !cityTierTypes.has(type)));
    const blocked = excludedRegionNames[countryCode] || [];
    const isBlocked = (value) => blocked.some((pattern) => pattern.test(String(value || '')));
    const keptRegions = regions.filter((region) =>
      !isBlocked(region.name) && !isBlocked(region.native_name) && !isBlocked(region.zh_name));
    const keptIds = new Set(keptRegions.map((region) => region.id));
    this.regionsById = new Map(keptRegions.map((region) => [region.id, region]));
    this.regions = keptRegions.filter(finiteCoord);
    const scopedCities = cities
      .filter((city) => city.region_id == null || keptIds.has(city.region_id))
      .filter(finiteCoord);
    // For Han-script catalogs, drop machine-garbled Chinese names (pinyin mismatch
    // with the English name) so they can never surface as a city/district.
    const sanitized = this.anchorConfig?.sanitizePinyin
      ? scopedCities.map((city) => {
        const corrected = chineseNameCorrections.get(String(city.native_name || '').trim());
        const entry = corrected ? { ...city, native_name: corrected, zh_name: corrected } : city;
        return chineseNameTrustworthy(entry.native_name, entry.name)
          ? entry
          : { ...entry, native_name: '', zh_name: '' };
      })
      : scopedCities;
    const excludePattern = this.anchorConfig?.excludeCityPattern;
    const settlementPool = excludePattern
      ? sanitized.filter((city) => !excludePattern.test(String(city.native_name || ''))
        && !excludePattern.test(String(city.name || '')))
      : sanitized;
    this.cities = settlementPool;
    this.cityTier = settlementPool.filter((city) => cityTierTypes.has(String(city.type || '').toLowerCase()));
    this.districtTier = settlementPool.filter((city) => districtTierTypes.has(String(city.type || '').toLowerCase()));
  }

  static async load(database, countryCode) {
    if (!database) return new CatalogReverseGeocoder(countryCode, [], []);
    try {
      const regions = (await database.prepare(`SELECT id, code, name, native_name, zh_name, type, latitude, longitude
        FROM catalog_regions WHERE country_code = ?`).bind(countryCode).all()).results || [];
      const cities = (await database.prepare(`SELECT name, native_name, zh_name, region_id, type, latitude, longitude
        FROM catalog_cities WHERE country_code = ? AND latitude IS NOT NULL AND longitude IS NOT NULL`)
        .bind(countryCode).all()).results || [];
      return new CatalogReverseGeocoder(countryCode, regions, cities);
    } catch {
      return new CatalogReverseGeocoder(countryCode, [], []);
    }
  }

  get available() {
    return this.cities.length > 0 || (this.regions?.length || 0) > 0;
  }

  get hierarchyReady() {
    return this.cityTier.length > 0 && this.regions.length > 0;
  }

  nearestFrom(pool, latitude, longitude, maxDegrees) {
    if (!pool?.length) return null;
    let best = null;
    let bestScore = Infinity;
    for (const entry of pool) {
      const score = distanceScore(latitude, longitude, entry.latitude, entry.longitude);
      if (score < bestScore) {
        bestScore = score;
        best = entry;
      }
    }
    return best && bestScore <= maxDegrees * maxDegrees ? best : null;
  }

  nearestCity(latitude, longitude, maxDegrees = 1.5) {
    return this.nearestFrom(this.cities, latitude, longitude, maxDegrees);
  }

  nearestRegion(latitude, longitude, maxDegrees = 4) {
    return this.nearestFrom(this.regions, latitude, longitude, maxDegrees);
  }

  // Coordinate-anchored authoritative hierarchy. Ignores source text entirely and
  // rebuilds {admin1, city, district} from the catalog tiers. Returns null when the
  // point cannot be anchored to a city tier within range (e.g. cross-border point),
  // signalling the caller to drop the record.
  regionByName(name) {
    const needle = String(name || '').trim().toLowerCase();
    if (!needle) return null;
    for (const region of this.regionsById.values()) {
      const names = [region.native_name, region.name, region.zh_name, region.code]
        .map((value) => String(value || '').trim().toLowerCase());
      if (names.includes(needle)) return region;
      // "重庆" matches "重庆市", "Fujian" matches "Fujian Province" etc.
      if (names.some((value) => value && (value.startsWith(needle) || needle.startsWith(value)) && Math.abs(value.length - needle.length) <= 2)) {
        return region;
      }
    }
    return null;
  }

  // Coordinate-anchored authoritative hierarchy. admin1 (province) is trusted from
  // sourceAdmin1 when it resolves to a catalog region — OSM rarely mislabels the
  // province, and a large municipality's centroid is unreliable. City and district
  // are always rebuilt from coordinates, constrained to the resolved region.
  resolveHierarchy(latitude, longitude, options = {}) {
    const cityRadius = options.cityRadius ?? this.anchorConfig?.cityRadius ?? 1.6;
    const districtRadius = options.districtRadius ?? this.anchorConfig?.districtRadius ?? 0.6;
    const sourceAdmin1 = options.sourceAdmin1;
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !this.hierarchyReady) return null;
    const anchorCity = this.nearestFrom(this.cityTier, latitude, longitude, cityRadius);
    const anchorRegion = (anchorCity?.region_id != null && this.regionsById.get(anchorCity.region_id))
      || this.nearestRegion(latitude, longitude);
    const trusted = this.regionByName(sourceAdmin1);
    const region = trusted || anchorRegion;
    if (!region) return null;
    const municipal = String(region.type || '').toLowerCase() === 'municipality';
    const inRegion = (entry) => entry.region_id == null || entry.region_id === region.id;
    const namedDistrict = (entry) => inRegion(entry) && String(entry.native_name || '').trim() !== '';
    const district = this.nearestFrom(this.districtTier.filter(namedDistrict), latitude, longitude, districtRadius);
    // Municipality: the region itself is the city. Otherwise use the nearest
    // prefecture city that belongs to the resolved region.
    const namedCity = (entry) => inRegion(entry) && String(entry.native_name || '').trim() !== '';
    const city = municipal
      ? null
      : (anchorCity && namedCity(anchorCity) ? anchorCity : this.nearestFrom(this.cityTier.filter(namedCity), latitude, longitude, cityRadius * 1.5));
    if (!municipal && !city) return null;
    return {
      admin1: region.native_name || region.name || '',
      admin1En: region.name || '',
      admin1Zh: region.zh_name || '',
      admin1Code: region.code || '',
      city: municipal ? (region.native_name || region.name || '') : (city.native_name || city.name || ''),
      cityEn: municipal ? (region.name || '') : (city.name || ''),
      cityZh: municipal ? (region.zh_name || '') : (city.zh_name || ''),
      district: district ? (district.native_name || district.name || '') : '',
      districtEn: district ? (district.name || '') : '',
      districtZh: district ? (district.zh_name || '') : ''
    };
  }

  // Returns { admin1, admin1En, admin1Zh, admin1Code, locality, localityEn, localityZh }
  // for whatever the record is missing; empty object when nothing can be filled.
  lookup(record) {
    const filled = {};
    if (!this.available) return filled;
    const latitude = Number(record.latitude);
    const longitude = Number(record.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return filled;

    const components = record.components || record;
    const chineseCountry = ['CN', 'HK', 'TW'].includes(this.countryCode);
    const latin = /^[\p{Script=Latin}\p{N}\p{P}\p{Z}]+$/u;
    const cityLatin = chineseCountry && (components.locality || components.postalLocality)
      && latin.test((components.locality || components.postalLocality).trim());
    const regionLatin = chineseCountry && components.admin1 && latin.test(components.admin1.trim());
    const missingCity = (!((components.locality || '').trim()) && !((components.postalLocality || '').trim())) || cityLatin;
    const missingRegion = !((components.admin1 || '').trim()) || regionLatin;

    if (missingCity) {
      const city = this.nearestCity(latitude, longitude);
      if (city) {
        filled.locality = city.native_name || city.name || '';
        filled.localityEn = city.name || '';
        filled.localityZh = city.zh_name || '';
        filled.replaceCity = cityLatin;
        if (missingRegion && city.region_id != null) {
          const region = this.regionsById.get(city.region_id);
          if (region) {
            this.fillRegion(filled, region);
            filled.replaceRegion = regionLatin;
          }
        }
      }
    }
    if (missingRegion && !filled.admin1) {
      const region = this.nearestRegion(latitude, longitude);
      if (region) {
        this.fillRegion(filled, region);
        filled.replaceRegion = regionLatin;
      }
    }
    return filled;
  }

  fillRegion(filled, region) {
    filled.admin1 = region.native_name || region.name || '';
    filled.admin1En = region.name || '';
    filled.admin1Zh = region.zh_name || '';
    filled.admin1Code = region.code || '';
  }
}
