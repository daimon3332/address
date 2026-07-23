import {
  countryCodeFrom,
  isPublicIpAddress,
  normalizeIpAddress,
  type ClientContext,
  type IpLocationSource
} from '../../../src/domain/client-context';

export interface ClientLocationInput {
  country?: string | null;
  region?: string | null;
  regionCode?: string | null;
  city?: string | null;
  postalCode?: string | null;
  latitude?: string | number | null;
  longitude?: string | number | null;
  timezone?: string | null;
  colo?: string | null;
  accuracyRadiusKm?: string | number | null;
}

const text = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return normalized ? normalized.slice(0, 128) : undefined;
};

const number = (value: unknown, minimum: number, maximum: number): number | undefined => {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value.trim());
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : undefined;
};

const precisionLevel = (location: ClientContext): ClientContext['precisionLevel'] => {
  if (location.latitude !== undefined && location.longitude !== undefined) return 'coordinates';
  if (location.postalCode) return 'postal';
  if (location.city) return 'city';
  if (location.region || location.regionCode) return 'region';
  return location.country ? 'country' : 'none';
};

export const clientContextFromLocation = (
  location: ClientLocationInput,
  source: IpLocationSource,
  localDevelopment = false
): ClientContext => {
  const country = countryCodeFrom(text(location.country));
  const region = text(location.region);
  const regionCode = text(location.regionCode)?.toUpperCase();
  const city = text(location.city);
  const postalCode = text(location.postalCode);
  const latitude = number(location.latitude, -90, 90);
  const longitude = number(location.longitude, -180, 180);
  const hasCoordinates = latitude !== undefined && longitude !== undefined;
  const context: ClientContext = {
    country,
    region,
    regionCode,
    city,
    postalCode,
    ...(hasCoordinates ? { latitude, longitude } : {}),
    timezone: text(location.timezone),
    colo: text(location.colo)?.toUpperCase(),
    accuracyRadiusKm: number(location.accuracyRadiusKm, 0, 10_000),
    supported: Boolean(country),
    matchLevel: country ? city ? 'city' : region || regionCode ? 'region' : 'country' : 'none',
    precisionLevel: 'none',
    source,
    localDevelopment
  };
  context.precisionLevel = precisionLevel(context);
  return context;
};

const isLocalHostname = (hostname: string): boolean => {
  const normalized = hostname.toLowerCase();
  return normalized === 'localhost' || normalized.endsWith('.localhost') ||
    normalized === '127.0.0.1' || normalized === '[::1]' || normalized === '::1';
};

const isLocalDevelopmentRequest = (request: Request): boolean => {
  let hostname = '';
  try {
    hostname = new URL(request.url).hostname;
  } catch {}
  return isLocalHostname(hostname);
};

export interface ClientRequestNetworkOptions {
  socketIp?: string | null;
  trustProxy?: boolean;
}

const normalizeNetworkIp = (input: string | null | undefined): string | undefined => {
  let value = input?.trim();
  if (!value || value.length > 128) return undefined;
  if (/^for=/i.test(value)) value = value.slice(4).trim();
  if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
  if (!value || value.toLowerCase() === 'unknown' || value.startsWith('_')) return undefined;
  const bracketed = value.match(/^\[([^\]]+)](?::\d{1,5})?$/);
  if (bracketed) value = bracketed[1];
  else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d{1,5}$/.test(value)) value = value.slice(0, value.lastIndexOf(':'));
  const zoneIndex = value.indexOf('%');
  if (zoneIndex >= 0) value = value.slice(0, zoneIndex);
  const mappedIpv4 = value.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i)?.[1];
  return normalizeIpAddress(mappedIpv4 || value);
};

const forwardedIp = (headers: Headers): string | undefined => {
  const forwarded = headers.get('forwarded');
  if (forwarded) {
    for (const parameter of forwarded.split(',')[0].split(';')) {
      if (/^\s*for=/i.test(parameter)) return normalizeNetworkIp(parameter.trim());
    }
  }
  const xForwardedFor = headers.get('x-forwarded-for')?.split(',')[0];
  return normalizeNetworkIp(xForwardedFor) || normalizeNetworkIp(headers.get('x-real-ip'));
};

export const clientContextFromRequest = (
  request: Request,
  { socketIp, trustProxy = false }: ClientRequestNetworkOptions = {}
): ClientContext => {
  const proxyIp = trustProxy ? forwardedIp(request.headers) : undefined;
  const requestIp = proxyIp || normalizeNetworkIp(socketIp);
  const source: IpLocationSource = proxyIp ? 'trusted-proxy' : 'request-socket';
  const context = clientContextFromLocation({}, source, isLocalDevelopmentRequest(request));
  if (requestIp && isPublicIpAddress(requestIp)) context.publicIp = requestIp;
  return context;
};
