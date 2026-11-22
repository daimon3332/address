import { formatAllAddressPresentations } from './address-format';
import {
  ar, base, de, en, en_AU, en_CA, en_GB, en_HK, en_IN, en_NG, en_US, en_ZA, es,
  es_MX, Faker, fr, it, ja, ko, nl, pt_BR, ru, th, tr, vi, zh_CN, zh_TW,
  type LocaleDefinition
} from '@faker-js/faker';
import { parsePhoneNumberFromString } from 'libphonenumber-js/core';
import mobileMetadata from 'libphonenumber-js/mobile/metadata';
import { countryByCode } from './countries';
import type { GoogleResolution } from './google-geocoder';
import { latinPersonName } from './latin-name';
import { googleMapsLinksFromCoordinates } from './maps';
import { generateBirthDate, generateExtensions } from './profile-model';
import { generateProfilePresentations } from './profile-presentations';
import { generateSandboxCard } from './sandbox-card';
import type {
  AddressComponents, CountryCode, GeneratedBundle, GeneratedUnit, VerifiedAddress
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

const phonePrefixes: Partial<Record<CountryCode, readonly string[]>> = {
  MX: ['33', '55', '56', '81'], GB: ['71', '72', '73', '74', '75', '77', '78', '79'],
  DE: ['151', '152', '155', '157', '160', '162', '163', '170', '171', '172', '173', '174', '175', '176', '177', '178', '179'],
  FR: ['6', '7'], IT: ['320', '327', '328', '329', '330', '331', '333', '334', '335', '336', '337', '338', '339', '340', '347', '348', '349', '350', '351', '360', '366', '368', '370', '371', '377', '380', '388', '389'],
  ES: ['6', '7'], NL: ['6'], RU: ['9'], JP: ['70', '80', '90'], HK: ['5', '6', '9'], SG: ['8', '9'],
  TW: ['9'], KR: ['10'], MY: ['10', '11', '12', '13', '14', '16', '17', '18', '19'],
  CN: ['13', '14', '15', '16', '17', '18', '19'], TH: ['6', '8', '9'], PH: ['905', '906', '915', '916', '917', '918', '919', '920', '921', '922', '923', '925', '926', '927', '928', '929', '930', '935', '936', '937', '938', '939', '940', '941', '942', '943', '945', '946', '947', '948', '949', '950', '951', '952', '953', '954', '955', '956', '957', '958', '959', '960', '961', '963', '965', '966', '967', '968', '969', '970', '975', '976', '977', '978', '979', '980', '981', '982', '983', '984', '985', '986', '987', '988', '989', '990', '991', '992', '993', '994', '995', '996', '997', '998', '999'],
  VN: ['3', '5', '7', '8', '9'], TR: ['50', '51', '53', '54', '55', '56', '57', '58', '59'], SA: ['5'], IN: ['6', '7', '8', '9'], AU: ['4'],
  BR: ['119', '219', '319', '419', '519', '619', '719', '819', '919'], NG: ['70', '80', '81', '90', '91'], ZA: ['6', '7', '8']
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
): { fullName: string; latinName: string } => {
  const firstName = faker.person.firstName(gender);
  const lastName = faker.person.lastName(gender);
  const fullName = ['CN', 'TW', 'KR'].includes(countryCode) ? `${lastName}${firstName}`
    : ['JP', 'VN'].includes(countryCode) ? `${lastName} ${firstName}` : `${firstName} ${lastName}`;
  return { fullName, latinName: latinPersonName(countryCode, fullName, lastName, firstName) ?? fullName };
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
  for (let attempt = 0; attempt < 128; attempt += 1) {
    const prefixes = phonePrefixes[countryCode] || [];
    const prefix = countryCode === 'US' || countryCode === 'CA'
      ? nanpPrefix(countryCode, components, random)
      : prefixes[Math.floor(random() * prefixes.length)];
    const length = countryCode === 'DE' && prefix.startsWith('15') ? 11
      : countryCode === 'MY' && prefix === '11' ? 10 : nationalNumberLength[countryCode];
    const national = `${prefix}${digits(random, length - prefix.length)}`;
    const phone = parsePhoneNumberFromString(`${callingCode}${national}`, mobileMetadata);
    if (!phone?.isValid() || phone.country !== countryCode
      || (countryCode === 'GB' && /^7700900\d{3}$/u.test(national))) continue;
    const groups = phoneGroups[countryCode];
    let offset = 0;
    const formatted = groups.map((size, index) => {
      const part = national.slice(offset, index === groups.length - 1 ? undefined : offset + size);
      offset += size;
      return part;
    }).filter(Boolean).join(' ');
    return `${callingCode} ${formatted}`;
  }
  throw new DomainError('PHONE_GENERATION_FAILED', `No valid mobile number generated for ${countryCode}`, 500);
};

const emailFor = (name: string, countryCode: CountryCode, suffix: string): string => {
  const local = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return `${local || countryCode.toLowerCase()}${suffix}@outlook.com`;
};

const chinaGeneratedUnit = (seed: number): GeneratedUnit => {
  const random = randomFromSeed(seed);
  const building = String(1 + Math.floor(random() * 3));
  const unit = String(1 + Math.floor(random() * 3));
  const floor = 2 + Math.floor(random() * 5);
  const roomOnFloor = String(1 + Math.floor(random() * 4)).padStart(2, '0');
  const room = `${floor}${roomOnFloor}`;
  return {
    components: { building, unit, room },
    variants: {
      native: `${building}栋${unit}单元${room}室`,
      en: `Building ${building}, Unit ${unit}, Room ${room}`,
      'zh-CN': `${building}栋${unit}单元${room}室`
    },
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
  const presentedAddress = address;
  const random = randomFromSeed(requestSeed);
  const faker = new Faker({ locale: [fakerLocaleByCountry[address.countryCode], en, base] });
  faker.seed(requestSeed);
  const gender = random() < 0.5 ? 'female' as const : 'male' as const;
  const { fullName, latinName } = fullNameFor(address.countryCode, gender, faker);
  const birthDate = generateBirthDate(random, now);
  const suffix = String(hashSeed(normalizedSeed) % 10000).padStart(4, '0');
  const generatedUnit = residential && address.countryCode === 'CN' && !address.components.unit
    ? chinaGeneratedUnit(hashSeed(`${requestSeed}:china-unit`))
    : undefined;
  const extensions = generateExtensions(
    address.countryCode, gender, fullName, birthDate, suffix, faker, random, now
  );
  const profilePresentations = generateProfilePresentations(requestSeed, gender, extensions);
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
    profilePresentations,
    extensions,
    address: presentedAddress,
    addressFormats: formatAllAddressPresentations(presentedAddress, fullName, generatedUnit, latinName),
    ...(generatedUnit ? { generatedUnit } : {}),
    googleMaps: {
      ...(googleMaps || { status: 'map_query' as const }),
      ...mapLinks
    },
    card: generateSandboxCard(random, now)
  };
};
