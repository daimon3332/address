import snapshots from './address-snapshots.json';
import { countryByCode, countryCodes } from '../../src/domain/countries';
import type {
  AddressComponents,
  AddressEvidence,
  AddressLanguage,
  CountryCode,
  PropertyType,
  VerifiedAddress
} from '../../src/domain/types';

interface AddressSnapshot {
  sourceId: string;
  houseNumber: string;
  street: string;
  locality: string;
  admin1: string;
  postcode: string;
  latitude: number;
  longitude: number;
  building: string;
  name: string;
}

const snapshotData = snapshots as Record<CountryCode, AddressSnapshot[]>;

const englishOverrides: Record<string, Partial<AddressComponents>> = {
  'way/23371929': { street: 'Simonovsky Val Street', locality: 'Moscow', admin1: 'Moscow' },
  'way/23371943': { street: 'Simonovsky Val Street', locality: 'Moscow', admin1: 'Moscow' },
  'way/23372067': { street: 'Krutitskaya Embankment', locality: 'Moscow', admin1: 'Moscow' },
  'node/3009244313': { street: 'Tama Ward 3313', locality: 'Kawasaki', admin1: 'Kanagawa' },
  'node/4895483923': { street: 'Sakurajosui 4-chome', locality: 'Setagaya', admin1: 'Tokyo' },
  'way/89183377': { street: 'Sotokanda 4-chome 9', locality: 'Chiyoda', admin1: 'Tokyo' },
  'way/25608721': { street: 'Austin Road West', locality: 'Hong Kong', admin1: 'Kowloon' },
  'way/30810938': { street: 'Wharf Road', locality: 'Hong Kong', admin1: 'Hong Kong Island' },
  'way/30810939': { street: 'Wharf Road', locality: 'Hong Kong', admin1: 'Hong Kong Island' },
  'way/138259004': { street: 'Xinyi Road Section 5', locality: 'Taipei', admin1: 'Taipei City' },
  'way/206067851': { street: 'Xinyi Road Section 3', locality: 'Taipei', admin1: 'Taipei City' },
  'way/232093689': { street: 'Lane 6, Zhuangjing Road', locality: 'Taipei', admin1: 'Taipei City' },
  'node/5837982603': { street: 'Sajik-ro 8-gil', locality: 'Seoul', admin1: 'Seoul' },
  'way/196070400': { street: 'Sajik-ro 8-gil', locality: 'Seoul', admin1: 'Seoul' },
  'way/196070401': { street: 'Saemunan-ro 3-gil', locality: 'Seoul', admin1: 'Seoul' },
  'node/5625691122': { street: 'Yongxing Road', locality: "Jing'an", admin1: 'Shanghai' },
  'way/285358193': { street: 'Xiaomuqiao Road', locality: 'Shanghai', admin1: 'Shanghai' },
  'way/298734773': { street: 'Xiaomuqiao Road', locality: 'Shanghai', admin1: 'Shanghai' },
  'way/39878518': { street: 'Soi Sathon 11', locality: 'Bangkok', admin1: 'Bangkok' },
  'way/39878525': { street: 'Sathon 11', locality: 'Bangkok', admin1: 'Bangkok' },
  'way/1304457951': { street: 'Wadi Al Thumamah', locality: 'Riyadh', admin1: 'Riyadh Province' },
  'way/846678553': { street: 'Uqbah ibn Amir', locality: 'Riyadh', admin1: 'Riyadh Province' }
};

const zhPlaceNames: Record<string, string> = {
  Brooklyn: '布鲁克林', 'New York': '纽约', NY: '纽约州', Toronto: '多伦多', ON: '安大略省',
  'Ciudad de México': '墨西哥城', London: '伦敦', England: '英格兰', Berlin: '柏林', Paris: '巴黎',
  'Île-de-France': '法兰西岛大区', Roma: '罗马', Lazio: '拉齐奥大区', Madrid: '马德里',
  'Comunidad de Madrid': '马德里自治区', Amsterdam: '阿姆斯特丹', 'Noord-Holland': '北荷兰省',
  Москва: '莫斯科', 川崎市: '川崎市', 神奈川県: '神奈川县', 世田谷区: '世田谷区', 東京都: '东京都',
  千代田区: '千代田区', 香港: '香港', 九龍: '九龙', 香港島: '香港岛', Singapore: '新加坡',
  台北市: '台北市', 臺北市: '台北市', 서울특별시: '首尔特别市', 'Kuala Lumpur': '吉隆坡',
  静安区: '静安区', 上海市: '上海市', กรุงเทพมหานคร: '曼谷', Manila: '马尼拉', Caloocan: '卡洛奥坎',
  'Metro Manila': '马尼拉大都会', 'Quận Gò Vấp': '旧邑郡', 'TP. Hồ Chí Minh': '胡志明市',
  'Phường 4': '第四坊', 'Hồ Chí Minh': '胡志明市', 'Thành phố Hồ Chí Minh': '胡志明市',
  İstanbul: '伊斯坦布尔', Riyadh: '利雅得', الرياض: '利雅得', 'Riyadh Province': '利雅得省',
  'منطقة الرياض': '利雅得省', Bengaluru: '班加罗尔', Karnataka: '卡纳塔克邦', Sydney: '悉尼',
  NSW: '新南威尔士州', 'São Paulo': '圣保罗', Lagos: '拉各斯', 'Cape Town': '开普敦',
  'Western Cape': '西开普省'
};

const countryName = (countryCode: CountryCode, language: AddressLanguage): string => {
  const country = countryByCode.get(countryCode);
  if (!country) return countryCode;
  if (language === 'native') return country.nativeName;
  return language === 'en' ? country.name.en : country.name['zh-CN'];
};

const componentsFor = (
  snapshot: AddressSnapshot,
  language: AddressLanguage
): AddressComponents => {
  const base: AddressComponents = {
    houseNumber: snapshot.houseNumber,
    buildingName: snapshot.name || undefined,
    street: snapshot.street,
    locality: snapshot.locality,
    admin1: snapshot.admin1 || undefined,
    postcode: snapshot.postcode
  };
  if (language === 'native') return base;
  const english = { ...base, ...(englishOverrides[snapshot.sourceId] || {}) };
  if (language === 'en') return english;
  return {
    ...english,
    locality: zhPlaceNames[snapshot.locality] || zhPlaceNames[english.locality] || english.locality,
    admin1: zhPlaceNames[snapshot.admin1] || zhPlaceNames[english.admin1 || ''] || english.admin1
  };
};

const eastAsian = new Set<CountryCode>(['JP', 'HK', 'TW', 'KR', 'CN']);
const houseFirst = new Set<CountryCode>(['US', 'CA', 'GB', 'SG', 'MY', 'PH', 'IN', 'AU', 'NG', 'ZA']);

const streetLine = (countryCode: CountryCode, components: AddressComponents): string => {
  const building = components.buildingName ? ` ${components.buildingName}` : '';
  if (eastAsian.has(countryCode)) return `${components.street}${components.houseNumber}${building}`;
  if (houseFirst.has(countryCode)) return `${components.houseNumber} ${components.street}`;
  return `${components.street} ${components.houseNumber}`;
};

const oneLine = (
  countryCode: CountryCode,
  components: AddressComponents,
  language: AddressLanguage
): string => {
  const parts = [streetLine(countryCode, components), components.locality, components.admin1, components.postcode, countryName(countryCode, language)].filter(Boolean) as string[];
  return parts.filter((part, index) => !parts.slice(0, index).some((previous) => previous.localeCompare(part, undefined, { sensitivity: 'accent' }) === 0)).join(', ');
};

const propertyType = (building: string, residentialCapability: boolean): PropertyType => {
  if (!residentialCapability) return 'unknown';
  return ['apartments', 'dormitory'].includes(building) ? 'apartment' : 'residential';
};

const evidenceFor = (
  snapshot: AddressSnapshot,
  residentialCapability: boolean
): AddressEvidence[] => {
  const sourceUrl = `https://www.openstreetmap.org/${snapshot.sourceId}`;
  const evidence: AddressEvidence[] = [
    {
      sourceId: 'osm-overpass', sourceName: 'OpenStreetMap / Overpass', sourceUrl,
      sourceFamily: 'openstreetmap', type: 'address_existence',
      value: `${snapshot.sourceId}: addr:housenumber + addr:street`, observedAt: '2026-07-15'
    },
    {
      sourceId: 'osm-overpass', sourceName: 'OpenStreetMap / Overpass', sourceUrl,
      sourceFamily: 'openstreetmap', type: 'coordinate',
      value: `${snapshot.latitude},${snapshot.longitude}`, observedAt: '2026-07-15'
    }
  ];
  if (residentialCapability) {
    evidence.push({
      sourceId: 'osm-overpass', sourceName: 'OpenStreetMap / Overpass', sourceUrl,
      sourceFamily: 'openstreetmap', type: 'residential_use',
      value: `building=${snapshot.building}`, observedAt: '2026-07-15'
    });
  }
  return evidence;
};

const createAddress = (countryCode: CountryCode, snapshot: AddressSnapshot): VerifiedAddress => {
  const country = countryByCode.get(countryCode);
  if (!country) throw new Error(`Missing country configuration: ${countryCode}`);
  const componentVariants = {
    native: componentsFor(snapshot, 'native'),
    en: componentsFor(snapshot, 'en'),
    'zh-CN': componentsFor(snapshot, 'zh-CN')
  };
  const addressVariants = {
    native: oneLine(countryCode, componentVariants.native, 'native'),
    en: oneLine(countryCode, componentVariants.en, 'en'),
    'zh-CN': oneLine(countryCode, componentVariants['zh-CN'], 'zh-CN')
  };

  return {
    id: `osm-${countryCode.toLowerCase()}-${snapshot.sourceId.replace('/', '-')}`,
    countryCode,
    nativeAddress: addressVariants.native,
    formattedAddress: addressVariants.en,
    nativeLanguage: country.nativeLanguage,
    addressVariants,
    components: componentVariants.native,
    componentVariants,
    coordinates: { latitude: snapshot.latitude, longitude: snapshot.longitude },
    addressStatus: 'verified',
    propertyType: propertyType(snapshot.building, country.residentialCapability),
    unitStatus: 'building_only',
    unitProvenance: 'none',
    matchLevel: 'premise',
    verificationLevel: 'L2',
    sourceVersion: 'OSM-SNAPSHOT-2026-07-15',
    sourceUpdatedAt: '2026-07-15',
    verifiedAt: '2026-07-15T00:00:00Z',
    expiresAt: '2026-07-22T23:59:59Z',
    evidence: evidenceFor(snapshot, country.residentialCapability),
    exclusionFlags: []
  };
};

export const addressCatalog: VerifiedAddress[] = countryCodes.flatMap((countryCode) =>
  snapshotData[countryCode].map((snapshot) => createAddress(countryCode, snapshot))
);

export const isFresh = (address: VerifiedAddress, now = new Date()): boolean => Date.parse(address.expiresAt) >= now.getTime();

export const isAddressEligible = (address: VerifiedAddress, residentialOnly = false, now = new Date()): boolean => {
  const common = address.addressStatus === 'verified'
    && ['premise', 'subpremise'].includes(address.matchLevel)
    && address.exclusionFlags.length === 0
    && Boolean(address.components.houseNumber)
    && Boolean(address.components.street)
    && Number.isFinite(address.coordinates.latitude)
    && Number.isFinite(address.coordinates.longitude)
    && isFresh(address, now);
  if (!common || !residentialOnly) return common;
  return ['residential', 'apartment'].includes(address.propertyType)
    && address.evidence.some((item) => item.type === 'residential_use');
};

export const eligibleAddresses = (countryCode?: CountryCode, residentialOnly = false, now = new Date()): VerifiedAddress[] =>
  addressCatalog.filter((address) => (!countryCode || address.countryCode === countryCode) && isAddressEligible(address, residentialOnly, now));

export const selectCandidate = (countryCode: CountryCode, residentialOnly: boolean, seed: string, attempt: number, now = new Date()): VerifiedAddress => {
  const pool = eligibleAddresses(countryCode, residentialOnly, now);
  if (!pool.length) throw new Error(`No current fixture address for ${countryCode}.`);
  let hash = 2166136261;
  for (const character of `${countryCode}:${residentialOnly}:${seed}`) { hash ^= character.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  return pool[((hash >>> 0) + attempt) % pool.length];
};
