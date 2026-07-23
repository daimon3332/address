import type { CountryCode, VerifiedAddress } from './types';

export interface GoogleGeocodeComponent {
  long_name: string;
  short_name: string;
  types: string[];
}

export interface GoogleGeocodeResult {
  place_id?: string;
  partial_match?: boolean;
  types?: string[];
  address_components?: GoogleGeocodeComponent[];
  geometry?: {
    location_type?: string;
  };
}

export interface GoogleGeocodeResponse {
  status?: string;
  results?: GoogleGeocodeResult[];
}

export interface GoogleResolution {
  status: 'resolved';
  placeId: string;
  resultType: 'street_address' | 'premise' | 'subpremise';
  locationType: 'ROOFTOP' | 'GEOMETRIC_CENTER';
}

const allowedResultTypes = new Set(['street_address', 'premise', 'subpremise']);

const normalizePart = (value: string): string => value
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]/g, '');

const component = (result: GoogleGeocodeResult, type: string): GoogleGeocodeComponent | undefined =>
  result.address_components?.find((item) => item.types.includes(type));

const selectedType = (result: GoogleGeocodeResult): GoogleResolution['resultType'] | undefined =>
  result.types?.find((type) => allowedResultTypes.has(type)) as GoogleResolution['resultType'] | undefined;

const countryMatches = (result: GoogleGeocodeResult, countryCode: CountryCode): boolean =>
  component(result, 'country')?.short_name.toUpperCase() === countryCode;

const houseNumberMatches = (result: GoogleGeocodeResult, address: VerifiedAddress): boolean => {
  const googleHouseNumber = component(result, 'street_number')?.long_name;
  if (!googleHouseNumber) return false;
  return normalizePart(googleHouseNumber) === normalizePart(address.components.houseNumber);
};

export const acceptGoogleGeocode = (
  response: GoogleGeocodeResponse,
  address: VerifiedAddress
): GoogleResolution | undefined => {
  if (response.status !== 'OK') return undefined;

  for (const result of response.results || []) {
    if (!result.place_id || result.partial_match) continue;
    const resultType = selectedType(result);
    if (!resultType) continue;
    if (!countryMatches(result, address.countryCode)) continue;
    if (!houseNumberMatches(result, address)) continue;

    const rawLocationType = result.geometry?.location_type;
    const locationType = rawLocationType === 'ROOFTOP'
      ? 'ROOFTOP'
      : rawLocationType === 'GEOMETRIC_CENTER' && resultType === 'premise'
        ? 'GEOMETRIC_CENTER'
        : undefined;
    if (!locationType) continue;

    return { status: 'resolved', placeId: result.place_id, resultType, locationType };
  }

  return undefined;
};
