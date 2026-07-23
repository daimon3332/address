import { isCountryCode } from './countries';
import type { CountryCode } from './types';

export type GenerationMode = 'address' | 'residential';
export type IpLocationPrecision = 'coordinates' | 'postal' | 'city' | 'region' | 'country' | 'none';
export type IpLocationSource = 'request-socket' | 'trusted-proxy' | 'manual-database';

export interface ClientContext {
  country?: CountryCode;
  region?: string;
  regionCode?: string;
  city?: string;
  postalCode?: string;
  latitude?: number;
  longitude?: number;
  timezone?: string;
  colo?: string;
  accuracyRadiusKm?: number;
  matchLevel: 'city' | 'region' | 'country' | 'none';
  precisionLevel: IpLocationPrecision;
  source?: IpLocationSource;
  supported: boolean;
  publicIp?: string;
  localDevelopment: boolean;
}

export interface InitialSelection {
  country: CountryCode;
  mode: GenerationMode;
  source: 'url' | 'session' | 'ip' | 'default';
}

export const countryCodeFrom = (value: string | null | undefined): CountryCode | undefined => {
  const normalized = value?.trim().toUpperCase();
  return normalized && isCountryCode(normalized) ? normalized : undefined;
};

const ipv4Octets = (value: string): number[] | undefined => {
  const octets = value.split('.');
  if (octets.length !== 4 || octets.some((octet) => !/^\d{1,3}$/.test(octet))) return undefined;
  const parsed = octets.map(Number);
  return parsed.every((octet) => octet <= 255) ? parsed : undefined;
};

const ipv6Bytes = (value: string): number[] | undefined => {
  if (!value.includes(':') || /[%/\s[\]]/.test(value) || value.split('::').length > 2) return undefined;
  let normalized = value.toLowerCase();
  const ipv4 = normalized.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/)?.[1];
  if (ipv4) {
    const octets = ipv4Octets(ipv4);
    if (!octets) return undefined;
    normalized = `${normalized.slice(0, -ipv4.length)}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const [leftText, rightText] = normalized.split('::');
  const parseSide = (side: string): number[] | undefined => {
    if (!side) return [];
    const groups = side.split(':');
    if (groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return undefined;
    return groups.map((group) => Number.parseInt(group, 16));
  };
  const left = parseSide(leftText);
  const right = parseSide(rightText || '');
  if (!left || !right) return undefined;
  const missing = 8 - left.length - right.length;
  if ((normalized.includes('::') && missing < 1) || (!normalized.includes('::') && missing !== 0)) return undefined;
  const groups = [...left, ...Array.from({ length: missing }, () => 0), ...right];
  return groups.flatMap((group) => [group >> 8, group & 0xff]);
};

export const normalizeIpAddress = (value: string | null | undefined): string | undefined => {
  const normalized = value?.trim();
  if (!normalized || normalized.length > 45) return undefined;
  return ipv4Octets(normalized) || ipv6Bytes(normalized) ? normalized : undefined;
};

export const isPublicIpAddress = (value: string | null | undefined): boolean => {
  const normalized = normalizeIpAddress(value);
  if (!normalized) return false;
  const ipv4 = ipv4Octets(normalized);
  if (ipv4) {
    const [a, b, c] = ipv4;
    return !(
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  const bytes = ipv6Bytes(normalized);
  if (!bytes) return false;
  const allZero = bytes.every((byte) => byte === 0);
  const loopback = bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1;
  const ipv4Mapped = bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  if (ipv4Mapped) return isPublicIpAddress(bytes.slice(12).join('.'));
  return !(
    allZero || loopback ||
    (bytes[0] & 0xfe) === 0xfc ||
    (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) ||
    bytes[0] === 0xff ||
    (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8)
  );
};

export const resolveInitialSelection = ({
  urlCountry,
  sessionCountry,
  ipCountry,
  mode = 'address'
}: {
  urlCountry?: string | null;
  sessionCountry?: string | null;
  ipCountry?: string | null;
  mode?: GenerationMode;
}): InitialSelection => {
  const choices = [
    ['url', countryCodeFrom(urlCountry)],
    ['ip', countryCodeFrom(ipCountry)],
    ['session', countryCodeFrom(sessionCountry)]
  ] as const;
  const selected = choices.find(([, country]) => country);
  return {
    country: selected?.[1] || 'US',
    mode,
    source: selected?.[0] || 'default'
  };
};
