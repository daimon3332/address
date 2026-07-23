import { acceptGoogleGeocode, type GoogleGeocodeResponse, type GoogleResolution } from '../../../src/domain/google-geocoder';
import { DomainError } from '../../../src/domain/generator';
import type { VerifiedAddress } from '../../../src/domain/types';

export const resolveGoogleAddress = async (
  address: VerifiedAddress,
  apiKey: string | undefined,
  mockResponse: string | undefined,
  fetcher: typeof fetch = fetch
): Promise<GoogleResolution | undefined> => {
  if (address.addressStatus === 'synthetic') return undefined;
  let payload: GoogleGeocodeResponse;

  if (mockResponse) {
    payload = JSON.parse(mockResponse) as GoogleGeocodeResponse;
  } else {
    if (!apiKey) {
      throw new DomainError(
        'GOOGLE_GEOCODING_NOT_CONFIGURED',
        'Google Geocoding API is not configured.',
        503
      );
    }
    const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
    url.searchParams.set('address', address.formattedAddress);
    url.searchParams.set('components', `country:${address.countryCode}`);
    url.searchParams.set('key', apiKey);
    const response = await fetcher(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) {
      throw new DomainError('GOOGLE_GEOCODING_UPSTREAM_ERROR', 'Google Geocoding request failed.', 502);
    }
    payload = await response.json() as GoogleGeocodeResponse;
  }

  return acceptGoogleGeocode(payload, address);
};
