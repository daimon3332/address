import { normalizeIpAddress, type ClientContext } from '../../../src/domain/client-context';
import { clientContextFromLocation, type ClientLocationInput } from './client-context';
import { fetchWithTimeout } from './fetch-timeout';

const DEFAULT_IP_GEOLOCATION_API_URL = 'https://ipwho.is/{ip}';
const DEFAULT_IP_GEOLOCATION_FALLBACK_API_URL = 'https://ipapi.co/{ip}/json/';

export class ManualIpLookupError extends Error {
  constructor(
    readonly code: 'INVALID_IP' | 'IP_DATABASE_UNAVAILABLE' | 'IP_LOOKUP_FAILED',
    message: string,
    readonly status: 400 | 502 | 503
  ) {
    super(message);
  }
}

const firstString = (...values: unknown[]): string | undefined =>
  values.find((value): value is string => typeof value === 'string');

const firstNumberLike = (...values: unknown[]): string | number | undefined =>
  values.find((value): value is string | number => typeof value === 'string' || typeof value === 'number');

export const lookupManualIpContext = async (
  input: string,
  apiUrl = DEFAULT_IP_GEOLOCATION_API_URL,
  fetcher: typeof fetch = fetch,
  fallbackApiUrl = DEFAULT_IP_GEOLOCATION_FALLBACK_API_URL
): Promise<ClientContext> => {
  const ip = normalizeIpAddress(input);
  if (!ip) throw new ManualIpLookupError('INVALID_IP', 'The manual IP must be a valid IPv4 or IPv6 address.', 400);
  if (!apiUrl) {
    throw new ManualIpLookupError(
      'IP_DATABASE_UNAVAILABLE',
      'The IP geolocation database is not configured.',
      503
    );
  }

  const endpoints = [...new Set([apiUrl, fallbackApiUrl].filter(Boolean))];
  for (const endpoint of endpoints) {
    try {
      const response = await fetchWithTimeout(fetcher, endpoint.replace('{ip}', encodeURIComponent(ip)), {
        headers: { Accept: 'application/json' }
      });
      if (!response.ok) continue;
      const payload = await response.json() as unknown;
      const value = payload && typeof payload === 'object' && 'data' in payload
        ? (payload as { data?: unknown }).data
        : payload;
      if (!value || typeof value !== 'object') continue;
      if ('success' in value && (value as { success?: unknown }).success === false) continue;
      if ('error' in value && (value as { error?: unknown }).error === true) continue;
      const location = value as ClientLocationInput & Record<string, unknown>;
      const result = clientContextFromLocation({
        country: firstString(location.countryCode, location.country_code, location.country),
        region: firstString(location.region, location.stateProv, location.state_prov),
        regionCode: firstString(location.regionCode, location.region_code, location.stateCode, location.state_code),
        city: location.city,
        postalCode: firstString(location.postalCode, location.zipCode, location.postal_code, location.postal),
        latitude: location.latitude,
        longitude: location.longitude,
        timezone: firstString(location.timezone, location.timeZone, location.time_zone),
        colo: location.colo,
        accuracyRadiusKm: firstNumberLike(location.accuracyRadiusKm, location.accuracy_radius)
      }, 'manual-database');
      if (result.country) return result;
    } catch {}
  }
  throw new ManualIpLookupError('IP_LOOKUP_FAILED', 'The manual IP database lookup failed.', 502);
};
