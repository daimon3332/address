import { Converter as createSimplifier } from 'opencc-js/t2cn';
import { Converter as createTraditionalizer } from 'opencc-js/cn2t';
import type { AddressComponents, AddressEvidence, CountryConfig, VerifiedAddress } from '../../../src/domain/types';
import { findNonResidentialMatch } from '../../../src/domain/non-residential.mjs';
import type { AddressFilters, CatalogTarget } from '../repositories/address-repository';
import { fetchWithTimeout } from './fetch-timeout';

const ALS_ENDPOINT = 'https://www.als.gov.hk/lookup';
const DAY = 24 * 60 * 60 * 1000;
const toSimplified = createSimplifier({ from: 'hk', to: 'cn' });
const toTraditional = createTraditionalizer({ from: 'cn', to: 'hk' });

interface AlsStreet {
  LocationName?: string;
  StreetName?: string;
  BuildingNoFrom?: string;
  BuildingNoTo?: string;
}

interface AlsVillage extends AlsStreet {
  VillageName?: string;
}

interface AlsBlock {
  BlockDescriptor?: string;
  BlockNo?: string;
  BlockDescriptorPrecedenceIndicator?: string;
}

interface AlsEnglishAddress {
  BuildingName?: string;
  EngBlock?: AlsBlock;
  EngEstate?: { EstateName?: string };
  EngPhase?: { PhaseName?: string; PhaseNo?: string };
  EngVillage?: AlsVillage;
  EngStreet?: AlsStreet;
  EngDistrict?: { DcDistrict?: string };
  Region?: string;
}

interface AlsChineseAddress {
  BuildingName?: string;
  ChiBlock?: AlsBlock;
  ChiEstate?: { EstateName?: string };
  ChiPhase?: { PhaseName?: string; PhaseNo?: string };
  ChiVillage?: AlsVillage;
  ChiStreet?: AlsStreet;
  ChiDistrict?: { DcDistrict?: string };
  Region?: string;
}

interface AlsGeospatialInformation {
  Latitude?: string | number;
  Longitude?: string | number;
}

interface AlsPremisesAddress {
  EngPremisesAddress?: AlsEnglishAddress;
  ChiPremisesAddress?: AlsChineseAddress;
  GeoAddress?: string;
  GeospatialInformation?: AlsGeospatialInformation | AlsGeospatialInformation[];
}

interface AlsSuggestedAddress {
  Address?: { PremisesAddress?: AlsPremisesAddress };
  ValidationInformation?: { Score?: number };
}

interface AlsResponse {
  SuggestedAddress?: AlsSuggestedAddress[];
}

const text = (...parts: Array<string | undefined>): string => parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
const range = (from?: string, to?: string): string => from ? to && to !== from ? `${from}-${to}` : from : '';

const blockName = (block?: AlsBlock): string => {
  if (!block?.BlockNo) return '';
  if (!block.BlockDescriptor) return block.BlockNo;
  return block.BlockDescriptorPrecedenceIndicator === 'N'
    ? text(block.BlockNo, block.BlockDescriptor)
    : text(block.BlockDescriptor, block.BlockNo);
};

const englishRegion = (value = ''): string => ({ HK: 'HONG KONG', KLN: 'KOWLOON', NT: 'NEW TERRITORIES' })[value.toUpperCase()] || value;
const chineseNumber = (value: string): string => value && !/[號号]$/u.test(value) ? `${value}號` : value;

const normalized = (value = ''): string => toSimplified(value)
  .normalize('NFKC')
  .toLocaleLowerCase('en')
  .replace(/\b(?:district|region)\b/gu, '')
  .replace(/[區区]/gu, '')
  .replace(/[^\p{L}\p{N}]/gu, '');

const matches = (values: Array<string | undefined>, expected: string[]): boolean => values
  .some((value) => expected.some((item) => normalized(value) === normalized(item)));

const containsQuery = (variants: AddressComponents[], query: string | undefined): boolean => {
  if (!query) return true;
  const needle = normalized(query);
  if (!needle) return true;
  const fields = variants.flatMap((item) => [
    item.buildingName, item.street, item.houseNumber, item.locality,
    item.dependentLocality, item.district, item.admin1
  ]);
  if (fields.some((value) => normalized(value) === needle)) return true;
  if (variants.some((item) => [
    `${item.houseNumber}${item.street}`,
    `${item.street}${item.houseNumber}`
  ].some((value) => normalized(value) === needle))) return true;
  const haystack = normalized(fields.filter(Boolean).join(' '));
  return haystack.includes(needle);
};

const formatEnglish = (components: AddressComponents): string => [
  components.buildingName,
  components.dependentLocality,
  text(components.houseNumber, components.street),
  components.locality,
  components.admin1,
  'HONG KONG'
].filter((value, index, values) => value && values.findIndex((item) => normalized(item) === normalized(value)) === index).join(', ');

const formatChinese = (components: AddressComponents): string => [
  components.admin1,
  components.locality,
  components.dependentLocality,
  `${components.street}${components.houseNumber}`,
  components.buildingName,
  '香港'
].filter((value, index, values) => value && values.findIndex((item) => normalized(item) === normalized(value)) === index).join('');

const residentialPremises = (english: AlsEnglishAddress, chinese: AlsChineseAddress): boolean => Boolean(
  english.EngEstate?.EstateName
  || chinese.ChiEstate?.EstateName
  || /(?:HOUSE|COURT|MANSION|RESIDENCE|TOWER|BUILDING)$/iu.test(english.BuildingName || '')
  || /(?:樓|大廈|苑|閣|邨|臺|台)$/u.test(chinese.BuildingName || '')
);

const selectedGeospatial = (value: AlsPremisesAddress['GeospatialInformation']): AlsGeospatialInformation | undefined =>
  Array.isArray(value) ? value[0] : value;

const targetQuery = (filters: AddressFilters, target?: CatalogTarget): string => {
  if (filters.q) return filters.q;
  const value = filters.city || target?.city || target?.cityNative || filters.region || target?.region || target?.regionNative;
  return value || '香港';
};

const toCandidate = (
  country: CountryConfig,
  suggested: AlsSuggestedAddress,
  residentialOnly: boolean,
  filters: AddressFilters,
  target: CatalogTarget | undefined,
  sourceUrl: string,
  now: Date
): VerifiedAddress | undefined => {
  const premises = suggested.Address?.PremisesAddress;
  const english = premises?.EngPremisesAddress;
  const chinese = premises?.ChiPremisesAddress;
  const geospatial = premises && selectedGeospatial(premises.GeospatialInformation);
  const latitude = Number(geospatial?.Latitude);
  const longitude = Number(geospatial?.Longitude);
  if (!premises || !english || !chinese || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return undefined;

  const engStreet = english.EngStreet || english.EngVillage;
  const chiStreet = chinese.ChiStreet || chinese.ChiVillage;
  const engStreetName = engStreet?.StreetName || (engStreet as AlsVillage | undefined)?.VillageName || '';
  const chiStreetName = chiStreet?.StreetName || (chiStreet as AlsVillage | undefined)?.VillageName || '';
  if (!engStreetName || !chiStreetName) return undefined;

  const score = Number(suggested.ValidationInformation?.Score || 0);
  if (score <= 0) return undefined;
  const isResidential = residentialPremises(english, chinese);
  if (residentialOnly && !isResidential) return undefined;

  const useTarget = !filters.q;
  const engDistrict = english.EngDistrict?.DcDistrict || '';
  const chiDistrict = chinese.ChiDistrict?.DcDistrict || '';
  const nativeLocality = chiStreet?.LocationName || (chiStreet as AlsVillage | undefined)?.LocationName
    || (useTarget ? target?.cityNative && toTraditional(target.cityNative) : undefined) || chiDistrict;
  const englishLocality = engStreet?.LocationName || (engStreet as AlsVillage | undefined)?.LocationName
    || (useTarget ? target?.city : undefined) || engDistrict;
  const englishHouseNumber = range(engStreet?.BuildingNoFrom, engStreet?.BuildingNoTo);
  const chineseHouseNumber = chineseNumber(range(chiStreet?.BuildingNoFrom, chiStreet?.BuildingNoTo));
  const englishBuilding = text(blockName(english.EngBlock), english.BuildingName);
  const chineseBuilding = text(blockName(chinese.ChiBlock), chinese.BuildingName);

  const en: AddressComponents = {
    houseNumber: englishHouseNumber,
    street: engStreetName,
    buildingName: englishBuilding || undefined,
    locality: englishLocality,
    postalLocality: englishLocality,
    dependentLocality: english.EngEstate?.EstateName,
    district: engDistrict,
    admin1: englishRegion(english.Region),
    admin1Code: english.Region,
    postcode: ''
  };
  const native: AddressComponents = {
    houseNumber: chineseHouseNumber,
    street: chiStreetName,
    buildingName: chineseBuilding || undefined,
    locality: nativeLocality,
    postalLocality: nativeLocality,
    dependentLocality: chinese.ChiEstate?.EstateName,
    district: chiDistrict,
    admin1: chinese.Region || '',
    admin1Code: english.Region,
    postcode: ''
  };
  const zhCN: AddressComponents = Object.fromEntries(Object.entries(native).map(([key, value]) => [
    key,
    typeof value === 'string' ? toSimplified(value) : value
  ])) as unknown as AddressComponents;
  const variants = [native, en, zhCN];

  const regionExpected = filters.region ? [...(target?.regionAliases || []), filters.region] : [];
  if (regionExpected.length && !matches(variants.flatMap((item) => [item.district, item.admin1, item.admin1Code]), regionExpected)) return undefined;
  const cityExpected = filters.city ? [...(target?.cityAliases || []), filters.city] : [];
  if (cityExpected.length && !matches(variants.flatMap((item) => [item.locality, item.postalLocality, item.district]), cityExpected)) return undefined;
  if (!containsQuery(variants, filters.q)) return undefined;

  const nativeAddress = formatChinese(native);
  const englishAddress = formatEnglish(en);
  const simplifiedAddress = formatChinese(zhCN);
  if (findNonResidentialMatch({
    countryCode: country.code,
    buildingNames: variants.map((item) => item.buildingName).filter((value): value is string => Boolean(value)),
    formattedAddresses: [nativeAddress, englishAddress, simplifiedAddress],
    streets: variants.map((item) => item.street).filter(Boolean)
  }).excluded) return undefined;
  const observedAt = now.toISOString();
  const sourceId = 'hk-als';
  const evidence: AddressEvidence[] = [
    {
      sourceId, sourceName: 'Hong Kong Address Lookup Service', sourceUrl,
      sourceFamily: 'hksar-address-lookup-service', type: 'address_existence',
      value: `${englishAddress} (score ${score})`, observedAt
    },
    {
      sourceId, sourceName: 'Hong Kong Address Lookup Service', sourceUrl,
      sourceFamily: 'hksar-address-lookup-service', type: 'coordinate',
      value: `${latitude},${longitude}`, observedAt
    }
  ];
  if (isResidential) evidence.push({
    sourceId, sourceName: 'Hong Kong Address Lookup Service', sourceUrl,
    sourceFamily: 'hksar-address-lookup-service', type: 'residential_use',
    value: english.EngEstate?.EstateName ? 'official estate component' : 'residential building name', observedAt
  });

  return {
    id: `hk-als-${premises.GeoAddress || `${latitude}-${longitude}`}`,
    countryCode: country.code,
    nativeAddress,
    formattedAddress: englishAddress,
    nativeLanguage: country.nativeLanguage,
    addressVariants: { native: nativeAddress, en: englishAddress, 'zh-CN': simplifiedAddress },
    components: native,
    componentVariants: { native, en, 'zh-CN': zhCN },
    coordinates: { latitude, longitude },
    addressStatus: 'verified',
    propertyType: isResidential ? 'residential' : 'unknown',
    unitStatus: 'building_only',
    matchLevel: 'premise',
    verificationLevel: 'L2',
    sourceVersion: 'HK-ALS-3.2',
    sourceUpdatedAt: observedAt,
    verifiedAt: observedAt,
    expiresAt: new Date(now.getTime() + 7 * DAY).toISOString(),
    evidence,
    exclusionFlags: []
  };
};

export const fetchHongKongAlsCandidates = async (
  country: CountryConfig,
  residentialOnly: boolean,
  filters: AddressFilters,
  fetcher: typeof fetch = fetch,
  now = new Date(),
  target?: CatalogTarget,
  endpoint = ALS_ENDPOINT
): Promise<VerifiedAddress[]> => {
  if (country.code !== 'HK') return [];
  const url = new URL(endpoint);
  url.searchParams.set('q', targetQuery(filters, target));
  url.searchParams.set('n', '20');
  url.searchParams.set('t', '10');
  url.searchParams.set('b', '1');
  const response = await fetchWithTimeout(fetcher, url, {
    headers: { Accept: 'application/json', 'Accept-Language': 'en,zh-Hant' }
  });
  if (!response.ok) return [];
  const payload = await response.json() as AlsResponse;
  return (payload.SuggestedAddress || [])
    .map((item) => toCandidate(country, item, residentialOnly, filters, target, url.toString(), now))
    .filter((item): item is VerifiedAddress => Boolean(item));
};
