import { formatAllAddressPresentations } from './address-format';
import {
  ar, base, de, en, en_AU, en_CA, en_GB, en_HK, en_IN, en_NG, en_US, en_ZA, es,
  es_MX, Faker, fr, it, ja, ko, nl, pt_BR, ru, th, tr, vi, zh_CN, zh_TW,
  type LocaleDefinition
} from '@faker-js/faker';
import { countryByCode } from './countries';
import type { GoogleResolution } from './google-geocoder';
import { googleMapsLinksFromCoordinates } from './maps';
import { generateBirthDate, generateExtensions } from './profile-model';
import { generateSandboxCard } from './sandbox-card';
import type {
  AddressComponents, CountryCode, GeneratedBundle, VerifiedAddress
} from './types';

export class DomainError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) {
    super(message);
  }
}

export const hashSeed = (value: string): number => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

const randomFromSeed = (seed: number): (() => number) => {
  let state = seed;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
};

const fakerLocaleByCountry: Record<CountryCode, LocaleDefinition> = {
  US: en_US, CA: en_CA, MX: es_MX, GB: en_GB, DE: de, FR: fr, IT: it, ES: es, NL: nl,
  RU: ru, JP: ja, HK: en_HK, SG: en, TW: zh_TW, KR: ko, MY: en, CN: zh_CN, TH: th,
  PH: en, VN: vi, TR: tr, SA: ar, IN: en_IN, AU: en_AU, BR: pt_BR, NG: en_NG, ZA: en_ZA
};

const nationalNumberLength: Record<CountryCode, number> = {
  US: 10, CA: 10, MX: 10, GB: 10, DE: 10, FR: 9, IT: 10, ES: 9, NL: 9, RU: 10,
  JP: 10, HK: 8, SG: 8, TW: 9, KR: 10, MY: 9, CN: 11, TH: 9, PH: 10, VN: 9,
  TR: 10, SA: 9, IN: 10, AU: 9, BR: 11, NG: 10, ZA: 9
};

const phonePrefixes: Partial<Record<CountryCode, string>> = {
  MX: '55', GB: '7700900', DE: '151', FR: '612', IT: '320', ES: '612', NL: '6', RU: '9',
  JP: '901', HK: '5', SG: '8', TW: '912', KR: '102', MY: '12', CN: '138',
  TH: '81', PH: '917', VN: '91', TR: '532', SA: '50', IN: '9876', AU: '412',
  BR: '119', NG: '803', ZA: '71'
};

type NanpCountry = 'US' | 'CA';

const regionalAreaCodes: Record<NanpCountry, ReadonlyArray<{
  places: readonly string[];
  codes: readonly string[];
}>> = {
  US: [
    { places: ['brooklyn'], codes: ['347', '718', '917', '929'] },
    { places: ['new york', 'new york city'], codes: ['212', '332', '646', '917'] },
    { places: ['philadelphia'], codes: ['215', '267', '445'] },
    { places: ['los angeles'], codes: ['213', '310', '323', '424'] },
    { places: ['ny', 'new york state'], codes: ['315', '516', '585', '607', '631', '716', '845', '914'] },
    { places: ['pa', 'pennsylvania'], codes: ['223', '272', '412', '484', '570', '610', '717', '724', '814'] },
    { places: ['ca', 'california'], codes: ['209', '279', '408', '415', '510', '530', '559', '619', '626', '650', '657', '661', '707', '714', '760', '805', '831', '858', '909', '916', '925', '949', '951'] }
  ],
  CA: [
    { places: ['toronto'], codes: ['416', '437', '647'] },
    { places: ['vancouver'], codes: ['236', '604', '672', '778'] },
    { places: ['montreal'], codes: ['438', '514'] },
    { places: ['calgary'], codes: ['403', '587', '825'] },
    { places: ['on', 'ontario'], codes: ['226', '249', '289', '343', '365', '519', '613', '705', '807', '905'] },
    { places: ['bc', 'british columbia'], codes: ['236', '250', '604', '672', '778'] },
    { places: ['qc', 'quebec'], codes: ['263', '354', '367', '418', '438', '450', '514', '579', '581', '819', '873'] },
    { places: ['ab', 'alberta'], codes: ['368', '403', '587', '780', '825'] }
  ]
};

const phoneGroups: Record<CountryCode, number[]> = {
  US: [3, 3, 4], CA: [3, 3, 4], MX: [2, 4, 4], GB: [4, 6], DE: [3, 3, 4], FR: [1, 2, 2, 2, 2],
  IT: [3, 3, 4], ES: [3, 3, 3], NL: [1, 4, 4], RU: [3, 3, 4], JP: [2, 4, 4], HK: [4, 4],
  SG: [4, 4], TW: [3, 3, 3], KR: [2, 4, 4], MY: [2, 3, 4], CN: [3, 4, 4], TH: [2, 3, 4],
  PH: [3, 3, 4], VN: [2, 3, 4], TR: [3, 3, 4], SA: [2, 3, 4], IN: [5, 5], AU: [3, 3, 3],
  BR: [2, 5, 4], NG: [3, 3, 4], ZA: [2, 3, 4]
};

const fullNameFor = (
  countryCode: CountryCode,
  gender: 'female' | 'male',
  faker: Faker
): string => {
  const firstName = faker.person.firstName(gender);
  const lastName = faker.person.lastName(gender);
  if (['CN', 'TW', 'KR'].includes(countryCode)) return `${lastName}${firstName}`;
  if (['JP', 'VN'].includes(countryCode)) return `${lastName} ${firstName}`;
  return `${firstName} ${lastName}`;
};

const digits = (random: () => number, length: number): string =>
  Array.from({ length }, () => Math.floor(random() * 10)).join('');

const normalizeLocation = (value: string | undefined): string => (value || '')
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

const nanpPrefix = (
  countryCode: NanpCountry,
  components: AddressComponents,
  random: () => number
): string => {
  const locations = [
    components.postalLocality, components.locality, components.admin1, components.admin1Code
  ].map(normalizeLocation).filter(Boolean);
  const plan = regionalAreaCodes[countryCode].find(({ places }) => places.some((place) =>
    locations.some((location) => location === place || (place.length > 3 && location.includes(place)))
  ));
  const areaCodes = plan?.codes || (countryCode === 'US' ? ['202'] : ['416']);
  const areaCode = areaCodes[Math.floor(random() * areaCodes.length)];
  let exchange = 200 + Math.floor(random() * 800);
  if (exchange === 555 || exchange % 100 === 11) exchange += 1;
  return `${areaCode}${exchange}`;
};

const phoneFor = (
  countryCode: CountryCode,
  callingCode: string,
  components: AddressComponents,
  random: () => number
): string => {
  const prefix = countryCode === 'US' || countryCode === 'CA'
    ? nanpPrefix(countryCode, components, random)
    : phonePrefixes[countryCode] || '7';
  const national = `${prefix}${digits(random, Math.max(0, nationalNumberLength[countryCode] - prefix.length))}`;
  let offset = 0;
  const formatted = phoneGroups[countryCode].map((size) => {
    const part = national.slice(offset, offset + size);
    offset += size;
    return part;
  }).filter(Boolean).join(' ');
  return `${callingCode} ${formatted}`;
};

const emailFor = (name: string, countryCode: CountryCode, suffix: string): string => {
  const local = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return `${local || countryCode.toLowerCase()}${suffix}@outlook.com`;
};

// Decision ②: only China gets a synthetic house number (1-2999) and a community
// name from the lexicon; the road, district, city, province and coordinates stay
// real. Drawn from a dedicated seeded stream so profile fields keep their values.
const chinaCommunityLexicon: Array<{ zh: string; en: string }> = [
  { zh: '世纪花园', en: 'Century Garden' },
  { zh: '幸福家园', en: 'Happiness Garden' },
  { zh: '阳光小区', en: 'Sunshine Community' },
  { zh: '翡翠湾', en: 'Emerald Bay' },
  { zh: '锦绣华庭', en: 'Splendid Court' },
  { zh: '龙湖天街', en: 'Longhu Paradise Walk' },
  { zh: '绿地公馆', en: 'Greenland Mansion' },
  { zh: '保利花园', en: 'Poly Garden' },
  { zh: '中海国际社区', en: 'Zhonghai International Community' },
  { zh: '招商雍景湾', en: 'Yongjing Bay' }
];

const withChinaSyntheticBase = (address: VerifiedAddress, seed: number): VerifiedAddress => {
  if (address.countryCode !== 'CN') return address;
  const random = randomFromSeed(hashSeed(`${seed}:cn-base`));
  const houseNumber = String(1 + Math.floor(random() * 2999));
  // Prefer a real community near the point (attached at read time from OSM
  // landuse=residential); the lexicon is only the no-coverage fallback.
  const real = address.nearbyCommunities?.length
    ? address.nearbyCommunities[Math.floor(random() * address.nearbyCommunities.length)]
    : undefined;
  const fallback = chinaCommunityLexicon[Math.floor(random() * chinaCommunityLexicon.length)];
  const community = real
    ? { zh: real.zh, en: real.en || real.zh }
    : fallback;
  const override = (components: AddressComponents, buildingName: string): AddressComponents => ({
    ...components, houseNumber, buildingName
  });
  const componentVariants = {
    native: override(address.componentVariants.native, community.zh),
    en: override(address.componentVariants.en, community.en),
    'zh-CN': override(address.componentVariants['zh-CN'], community.zh)
  };
  return { ...address, components: componentVariants.native, componentVariants };
};

const generatedUnitFor = (
  address: VerifiedAddress,
  random: () => number
): GeneratedBundle['generatedUnit'] => {
  if (address.components.unit || ['official', 'source_tagged'].includes(address.unitProvenance || '')) return undefined;
  const shouldGenerate = address.countryCode === 'CN' || address.propertyType === 'apartment';
  if (!shouldGenerate) return undefined;
  const building = 1 + Math.floor(random() * 35);
  const entrance = 1 + Math.floor(random() * 4);
  const floor = 2 + Math.floor(random() * 28);
  const room = 1 + Math.floor(random() * 8);
  const roomNumber = `${floor}${String(room).padStart(2, '0')}`;
  const nativeUnits: Partial<Record<CountryCode, string>> = {
    CN: `${building}栋${entrance}单元${roomNumber}室`,
    HK: `${floor}樓${String.fromCharCode(65 + room - 1)}室`,
    SG: `#${String(floor).padStart(2, '0')}-${String(room).padStart(2, '0')}`,
    JP: `${roomNumber}号室`,
    KR: `${building}동 ${roomNumber}호`,
    TW: `${floor}樓之${room}`,
    GB: `Flat ${room}`,
    US: `Apt ${roomNumber}`,
    CA: `Unit ${roomNumber}`
  };
  const englishUnits: Partial<Record<CountryCode, string>> = {
    HK: `Flat ${String.fromCharCode(65 + room - 1)}, ${floor}/F`,
    SG: `#${String(floor).padStart(2, '0')}-${String(room).padStart(2, '0')}`,
    JP: `Rm ${roomNumber}`,
    KR: `Bldg ${building}, Unit ${roomNumber}`,
    TW: `${floor}F.-${room}`,
    GB: `Flat ${room}`,
    US: `Apt ${roomNumber}`,
    CA: `Unit ${roomNumber}`
  };
  const variants = {
    native: nativeUnits[address.countryCode] || `Apt ${roomNumber}`,
    en: englishUnits[address.countryCode] || `Room ${roomNumber}, Unit ${entrance}, Building ${building}`,
    'zh-CN': `${building}栋${entrance}单元${roomNumber}室`
  };
  return {
    components: { building: String(building), unit: String(entrance), room: roomNumber },
    variants,
    provenance: 'synthetic',
    unitProvenance: 'synthetic'
  };
};

export const generateBundle = (
  address: VerifiedAddress,
  residential: boolean,
  seed: string,
  googleMaps: GoogleResolution | undefined,
  now = new Date()
): GeneratedBundle => {
  const country = countryByCode.get(address.countryCode);
  if (!country) throw new DomainError('INVALID_COUNTRY', `Unknown country code: ${address.countryCode}`);

  const normalizedSeed = seed.trim() || crypto.randomUUID();
  const requestSeed = hashSeed(`${address.id}:${address.countryCode}:${normalizedSeed}`);
  const presentedAddress = withChinaSyntheticBase(address, requestSeed);
  const random = randomFromSeed(requestSeed);
  const faker = new Faker({ locale: [fakerLocaleByCountry[address.countryCode], en, base] });
  faker.seed(requestSeed);
  const gender = random() < 0.5 ? 'female' as const : 'male' as const;
  const fullName = fullNameFor(address.countryCode, gender, faker);
  const birthDate = generateBirthDate(random, now);
  const suffix = String(hashSeed(normalizedSeed) % 10000).padStart(4, '0');
  const generatedUnit = generatedUnitFor(presentedAddress, random);
  const extensions = generateExtensions(
    address.countryCode, gender, fullName, birthDate, suffix, faker, random, now
  );
  const mapLinks = googleMapsLinksFromCoordinates(address.coordinates, googleMaps?.placeId, {
    countryCode: address.countryCode,
    components: address.countryCode === 'CN'
      ? presentedAddress.componentVariants.native
      : presentedAddress.componentVariants.en
  });

  return {
    id: `${address.id}:${hashSeed(normalizedSeed).toString(16)}`,
    seed: normalizedSeed,
    generatedAt: now.toISOString(),
    residential,
    profile: {
      fullName,
      gender,
      email: emailFor(fullName, address.countryCode, suffix),
      phone: phoneFor(address.countryCode, country.callingCode, address.components, random),
      dateOfBirth: birthDate.toISOString().slice(0, 10)
    },
    extensions,
    address: presentedAddress,
    addressFormats: formatAllAddressPresentations(presentedAddress, fullName, generatedUnit),
    ...(generatedUnit ? { generatedUnit } : {}),
    googleMaps: {
      ...(googleMaps || { status: 'map_query' as const }),
      ...mapLinks
    },
    card: generateSandboxCard(random, now)
  };
};
