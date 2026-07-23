import type {
  AddressComponents,
  AddressEvidence,
  CountryConfig,
  PropertyType,
  VerifiedAddress
} from '../../../src/domain/types';
import { findNonResidentialMatch } from '../../../src/domain/non-residential.mjs';
import { filterCandidates, type AddressFilters, type CatalogTarget } from '../repositories/address-repository';
import { fetchWithTimeout } from './fetch-timeout';

interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat?: number; lon?: number };
  tags?: Record<string, string>;
}

interface OverpassResponse {
  elements?: OverpassElement[];
}

interface PhotonResponse {
  features?: Array<{
    geometry?: { coordinates?: [number, number] };
    properties?: { countrycode?: string };
  }>;
}

const residentialBuildings = new Set([
  'apartments', 'house', 'residential', 'detached', 'semidetached_house', 'terrace', 'bungalow'
]);

const propertyType = (value: string, residentialCapability: boolean): PropertyType => {
  if (!residentialCapability || !residentialBuildings.has(value)) return 'unknown';
  return value === 'apartments' ? 'apartment' : 'residential';
};

const toAddress = (
  country: CountryConfig,
  element: OverpassElement,
  now: Date,
  target?: CatalogTarget
): VerifiedAddress | undefined => {
  const tags = element.tags || {};
  const houseNumber = tags['addr:housenumber'];
  const street = tags['addr:street'];
  const latitude = element.lat ?? element.center?.lat;
  const longitude = element.lon ?? element.center?.lon;
  if (!houseNumber || !street || latitude === undefined || longitude === undefined) return undefined;

  const components: AddressComponents = {
    houseNumber,
    street,
    buildingName: tags.name || tags['name:en'],
    locality: tags['addr:city'] || tags['addr:town'] || tags['addr:municipality'] || target?.city || '',
    postalLocality: tags['addr:place'] || tags['addr:city'] || tags['addr:town'],
    dependentLocality: tags['addr:suburb'] || tags['addr:hamlet'],
    district: tags['addr:district'] || tags['addr:county'],
    admin1: tags['addr:state'] || tags['addr:province'] || target?.region,
    admin1Code: tags['addr:state_code'] || target?.regionCode,
    postcode: tags['addr:postcode'] || ''
  };

  const sourceRecord = `${element.type}/${element.id}`;
  const sourceUrl = `https://www.openstreetmap.org/${sourceRecord}`;
  const building = tags.building || 'unknown';
  const observedAt = now.toISOString().slice(0, 10);
  const evidence: AddressEvidence[] = [
    {
      sourceId: 'osm-overpass', sourceName: 'OpenStreetMap / Overpass', sourceUrl,
      sourceFamily: 'openstreetmap', type: 'address_existence',
      value: `${sourceRecord}: addr:housenumber + addr:street`, observedAt
    },
    {
      sourceId: 'osm-overpass', sourceName: 'OpenStreetMap / Overpass', sourceUrl,
      sourceFamily: 'openstreetmap', type: 'coordinate', value: `${latitude},${longitude}`, observedAt
    }
  ];
  if (country.residentialCapability && residentialBuildings.has(building)) {
    evidence.push({
      sourceId: 'osm-overpass', sourceName: 'OpenStreetMap / Overpass', sourceUrl,
      sourceFamily: 'openstreetmap', type: 'residential_use', value: `building=${building}`, observedAt
    });
  }

  const line = `${houseNumber} ${street}, ${components.locality}${components.admin1 ? `, ${components.admin1}` : ''}${components.postcode ? ` ${components.postcode}` : ''}, ${country.name.en}`;
  if (findNonResidentialMatch({
    countryCode: country.code,
    buildingNames: [tags.name, tags['name:en']].filter((value): value is string => Boolean(value)),
    formattedAddress: line,
    street,
    propertyType: building,
    classifications: [
      building,
      tags.amenity,
      ...(tags.office ? ['office', tags.office] : []),
      ...(tags.shop ? ['retail', tags.shop] : []),
      tags.tourism,
      tags.healthcare,
      tags.public_transport,
      tags.railway,
      tags.landuse,
      tags.military
    ].filter((value): value is string => Boolean(value))
  }).excluded) return undefined;
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
  return {
    id: `osm-live-${country.code.toLowerCase()}-${element.type}-${element.id}`,
    countryCode: country.code,
    nativeAddress: line,
    formattedAddress: line,
    nativeLanguage: country.nativeLanguage,
    addressVariants: { native: line, en: line, 'zh-CN': line },
    components,
    componentVariants: { native: components, en: components, 'zh-CN': components },
    coordinates: { latitude, longitude },
    addressStatus: 'verified',
    propertyType: propertyType(building, country.residentialCapability),
    unitStatus: 'building_only',
    matchLevel: 'premise',
    verificationLevel: 'L2',
    sourceVersion: `OSM-LIVE-${observedAt}`,
    sourceUpdatedAt: observedAt,
    verifiedAt: now.toISOString(),
    expiresAt,
    evidence,
    exclusionFlags: []
  };
};

export const fetchOverpassCandidates = async (
  country: CountryConfig,
  residentialOnly: boolean,
  filters: AddressFilters,
  endpoint: string | undefined,
  photonEndpoint: string | undefined,
  mockResponse: string | undefined,
  fetcher: typeof fetch = fetch,
  now = new Date(),
  target?: CatalogTarget,
  timeoutMs = 15000
): Promise<VerifiedAddress[]> => {
  let payload: OverpassResponse;
  if (mockResponse) {
    payload = JSON.parse(mockResponse) as OverpassResponse;
  } else {
    let center = target?.coordinates || country.fallbackCenter;
    const regionLabel = country.adminShortcuts.find((item) => item.value === filters.region)?.label.en;
    const locationQuery = filters.city || regionLabel || filters.region || filters.q;
    if (locationQuery && !target) {
      try {
        const photonUrl = new URL(photonEndpoint || 'https://photon.komoot.io/api/');
        photonUrl.searchParams.set('q', `${locationQuery}, ${country.name.en}`);
        photonUrl.searchParams.set('limit', '5');
        photonUrl.searchParams.set('lang', 'en');
        const photonResponse = await fetchWithTimeout(fetcher, photonUrl, { headers: { Accept: 'application/json' } }, timeoutMs);
        if (photonResponse.ok) {
          const photon = await photonResponse.json() as PhotonResponse;
          const feature = photon.features?.find((item) =>
            item.properties?.countrycode?.toUpperCase() === country.code
            && item.geometry?.coordinates?.length === 2
          );
          const coordinates = feature?.geometry?.coordinates;
          if (coordinates) center = { latitude: coordinates[1], longitude: coordinates[0] };
        }
      } catch {
        center = country.fallbackCenter;
      }
    }
    const buildingFilter = residentialOnly && country.residentialCapability
      ? '["building"~"^(apartments|house|residential|detached|semidetached_house|terrace|bungalow)$"]'
      : '["building"]';
    const query = `[out:json][timeout:20];nwr(around:6000,${center.latitude},${center.longitude})["addr:housenumber"]["addr:street"]${buildingFilter};out tags center 30;`;
    const response = await fetchWithTimeout(fetcher, endpoint || 'https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'User-Agent': 'AddressProof/0.1'
      },
      body: new URLSearchParams({ data: query })
    }, timeoutMs);
    if (!response.ok) return [];
    payload = await response.json() as OverpassResponse;
  }

  const candidates = (payload.elements || [])
    .map((element) => toAddress(country, element, now, target))
    .filter((address): address is VerifiedAddress => Boolean(address))
    .filter((address) => !residentialOnly || !country.residentialCapability || address.evidence.some((item) => item.type === 'residential_use'));
  return filterCandidates(candidates, filters, target);
};
