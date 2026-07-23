import type { AddressComponents, GeneratedBundle, VerifiedAddress } from './types';

type Coordinates = VerifiedAddress['coordinates'];

const coordinateQuery = ({ latitude, longitude }: Coordinates): string => `${latitude},${longitude}`;

// WGS-84 -> GCJ-02 for AMap links. Standard obfuscation transform; error <1m.
const OUT_OF_CHINA = (latitude: number, longitude: number): boolean =>
  longitude < 72.004 || longitude > 137.8347 || latitude < 0.8293 || latitude > 55.8271;

const transformLatitude = (x: number, y: number): number => {
  let result = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  result += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
  result += (20 * Math.sin(y * Math.PI) + 40 * Math.sin(y / 3 * Math.PI)) * 2 / 3;
  result += (160 * Math.sin(y / 12 * Math.PI) + 320 * Math.sin(y * Math.PI / 30)) * 2 / 3;
  return result;
};

const transformLongitude = (x: number, y: number): number => {
  let result = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  result += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
  result += (20 * Math.sin(x * Math.PI) + 40 * Math.sin(x / 3 * Math.PI)) * 2 / 3;
  result += (150 * Math.sin(x / 12 * Math.PI) + 300 * Math.sin(x / 30 * Math.PI)) * 2 / 3;
  return result;
};

export const wgs84ToGcj02 = ({ latitude, longitude }: Coordinates): Coordinates => {
  if (OUT_OF_CHINA(latitude, longitude)) return { latitude, longitude };
  const radiusMajor = 6378245;
  const eccentricitySquared = 0.00669342162296594323;
  const dLat = transformLatitude(longitude - 105, latitude - 35);
  const dLng = transformLongitude(longitude - 105, latitude - 35);
  const radianLatitude = latitude / 180 * Math.PI;
  let magic = Math.sin(radianLatitude);
  magic = 1 - eccentricitySquared * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  return {
    latitude: latitude + (dLat * 180) / ((radiusMajor * (1 - eccentricitySquared)) / (magic * sqrtMagic) * Math.PI),
    longitude: longitude + (dLng * 180) / (radiusMajor / sqrtMagic * Math.cos(radianLatitude) * Math.PI)
  };
};

// Verifiable skeleton for text search: real components only — synthetic house
// numbers (CN), community names and indoor units never join the query.
export const mapSearchQuery = (countryCode: string, components: AddressComponents): string => {
  if (countryCode === 'CN') {
    return [components.street, components.district, components.locality, components.admin1]
      .map((value) => (value || '').trim()).filter(Boolean).join('');
  }
  return [
    [components.houseNumber, components.street].map((value) => (value || '').trim()).filter(Boolean).join(' '),
    components.locality,
    components.admin1,
    components.postcode
  ].map((value) => (value || '').trim()).filter(Boolean).join(', ');
};

export const googleMapsLinksFromCoordinates = (
  coordinates: Coordinates,
  placeId?: string,
  search?: { countryCode: string; components: AddressComponents }
): {
  embedUrl: string;
  openUrl: string;
  searchUrl?: string;
  amapUrl?: string;
} => {
  const query = coordinateQuery(coordinates);
  const openUrl = new URL('https://www.google.com/maps/search/');
  openUrl.searchParams.set('api', '1');
  openUrl.searchParams.set('query', query);
  if (placeId) openUrl.searchParams.set('query_place_id', placeId);
  const links: { embedUrl: string; openUrl: string; searchUrl?: string; amapUrl?: string } = {
    embedUrl: `https://www.google.com/maps?q=${query}&z=17&output=embed`,
    openUrl: openUrl.toString()
  };
  if (search) {
    const text = mapSearchQuery(search.countryCode, search.components);
    if (text) {
      const searchUrl = new URL('https://www.google.com/maps/search/');
      searchUrl.searchParams.set('api', '1');
      searchUrl.searchParams.set('query', text);
      links.searchUrl = searchUrl.toString();
    }
    if (search.countryCode === 'CN') {
      const gcj = wgs84ToGcj02(coordinates);
      const amapUrl = new URL('https://uri.amap.com/marker');
      amapUrl.searchParams.set('position', `${gcj.longitude.toFixed(6)},${gcj.latitude.toFixed(6)}`);
      if (text) amapUrl.searchParams.set('name', text);
      links.amapUrl = amapUrl.toString();
    }
  }
  return links;
};

export const googleMapsOpenUrl = (bundle: GeneratedBundle): string => bundle.googleMaps.openUrl;

export const googleMapsEmbedUrl = (bundle: GeneratedBundle): string => bundle.googleMaps.embedUrl;
