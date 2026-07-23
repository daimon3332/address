import { Hono } from 'hono';
import type { SqliteDatabase } from '../database/sqlite.mjs';
import { countries, countryByCode, isCountryCode } from '../../src/domain/countries';
import type { ClientContext } from '../../src/domain/client-context';
import { DomainError, generateBundle } from '../../src/domain/generator';
import { locationOptions, regionsForCountry } from '../../src/domain/location-options';
import { isVerifiedAddressNonResidential } from '../../src/domain/non-residential.mjs';
import { matchesCustomBlacklist } from '../lib/custom-blacklist.mjs';
import type { GeneratedBundle } from '../../src/domain/types';
import type { VerifiedAddress } from '../../src/domain/types';
import {
  orderedCandidate,
  resolveCatalogTarget,
  resolveNearestCatalogTarget,
  type CatalogTarget,
  type AddressFilters
} from './repositories/address-repository';
import { pickAddressPoolAddress } from './repositories/address-pool';
import { completenessClause, pickAddressPoolV2Address, pickNearestAddressPoolV2Address } from './repositories/address-pool-v2';
import { queryLocationCatalog } from './repositories/location-catalog';
import { localizeAddress } from './services/address-localizer';
import { clientContextFromRequest } from './services/client-context';
import { lookupManualIpContext, ManualIpLookupError } from './services/ip-geolocation';
import { fetchOverpassCandidates } from './services/overpass-provider';
import { fetchExternalCandidates, type LocationField } from './services/external-providers';

interface Bindings {
  LOCATION_DB?: SqliteDatabase;
  ADDRESS_DB?: SqliteDatabase;
  IP_GEOLOCATION_API_URL?: string;
  IP_GEOLOCATION_FALLBACK_API_URL?: string;
  ALLOWED_ORIGIN?: string;
  HOT_POOL_COUNTRIES?: string;
  HOT_POOL_MIN_PER_SLOT?: string;
  LIVE_API_MODES?: string;
  GOOGLE_GEOCODING_API_KEY?: string;
  GOOGLE_GEOCODING_MOCK?: string;
  OVERPASS_API_URL?: string;
  PHOTON_API_URL?: string;
  OVERPASS_MOCK?: string;
  AMAP_API_KEY?: string;
  GEOAPIFY_API_KEY?: string;
  GOOGLE_TRANSLATION_ENABLED?: boolean | string;
  ONEMAP_ACCESS_TOKEN?: string;
  OS_DATA_HUB_API_KEY?: string;
  YOUDAO_APP_KEY?: string;
  YOUDAO_APP_SECRET?: string;
  TRUST_PROXY?: string;
  incoming?: { socket?: { remoteAddress?: string } };
}

const app = new Hono<{ Bindings: Bindings }>();

const requestContext = (request: Request, env: Bindings): ClientContext => clientContextFromRequest(request, {
  socketIp: env.incoming?.socket?.remoteAddress,
  trustProxy: env.TRUST_PROXY === 'true'
});

const locateRequestIp = async (request: Request, env: Bindings): Promise<ClientContext> => {
  const network = requestContext(request, env);
  if (!network.publicIp) return network;
  try {
    return withRequestNetworkContext(
      await lookupManualIpContext(network.publicIp, env.IP_GEOLOCATION_API_URL, fetch, env.IP_GEOLOCATION_FALLBACK_API_URL),
      network
    );
  } catch {
    return network;
  }
};

const withRequestNetworkContext = (location: ClientContext, requestContext: ClientContext): ClientContext => ({
  ...location,
  ...(requestContext.publicIp ? { publicIp: requestContext.publicIp } : {}),
  localDevelopment: requestContext.localDevelopment
});
const CACHE_SECONDS = 7 * 24 * 60 * 60;
const LOCATION_CACHE_SECONDS = 30 * 24 * 60 * 60;
const IP_LIVE_LOOKUP_TIMEOUT_MS = 20000;
// Residential mode stays hidden for a country until its evidence-backed pool clears this floor.
const RESIDENTIAL_MIN_POOL = 100;

interface CacheEntry<T> { data: T; expiresAt: number }

class MemoryCache {
  private readonly entries = new Map<string, CacheEntry<unknown>>();

  constructor(private readonly maximumEntries: number) {}

  get<T>(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.data as T;
  }

  set(key: string, data: unknown, seconds: number): void {
    this.entries.delete(key);
    this.entries.set(key, { data, expiresAt: Date.now() + seconds * 1000 });
    while (this.entries.size > this.maximumEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.entries.delete(oldest);
    }
  }
}

const providerCache = new MemoryCache(500);
const locationCache = new MemoryCache(2_000);
const poolMetadataCache = new WeakMap<object, {
  expiresAt: number;
  v1?: Map<string, number>;
  v2?: Map<string, AddressPoolV2Count>;
}>();

type GenerateTimingStage = 'pool' | 'provider' | 'localize';
type GenerateTimings = Record<GenerateTimingStage, number>;

const measureStage = async <T,>(timings: GenerateTimings, stage: GenerateTimingStage, task: () => Promise<T>): Promise<T> => {
  const startedAt = performance.now();
  try {
    return await task();
  } finally {
    timings[stage] += performance.now() - startedAt;
  }
};

const toleratePoolFailure = async <T,>(task: () => Promise<T>): Promise<T | undefined> => {
  try {
    return await task();
  } catch {
    return undefined;
  }
};

const serverTiming = (startedAt: number, timings: GenerateTimings): string => [
  ['total', performance.now() - startedAt],
  ['pool', timings.pool],
  ['provider', timings.provider],
  ['localize', timings.localize]
].map(([name, duration]) => `${name};dur=${Number(duration).toFixed(1)}`).join(', ');

const providerCacheKey = (country: string, residential: boolean, filters: AddressFilters, target?: CatalogTarget): string => {
  const url = new URL('https://address.internal/provider-candidates');
  url.searchParams.set('version', '8');
  url.searchParams.set('country', country);
  url.searchParams.set('residential', String(residential));
  if (filters.q) url.searchParams.set('q', filters.q);
  if (filters.region) url.searchParams.set('region', filters.region);
  if (filters.city) url.searchParams.set('city', filters.city);
  if (filters.postcode) url.searchParams.set('postcode', filters.postcode);
  if (target) url.searchParams.set('target', target.bucket);
  return url.href;
};

const readProviderCache = (key: string): VerifiedAddress[] | undefined => providerCache.get(key);

export const filterProviderCandidates = (candidates: VerifiedAddress[]): VerifiedAddress[] =>
  candidates.filter((candidate) => !isVerifiedAddressNonResidential(candidate)
    && !matchesCustomBlacklist([
      candidate.components.buildingName,
      candidate.formattedAddress,
      candidate.nativeAddress,
      candidate.components.street
    ]));

const writeProviderCache = (key: string, candidates: VerifiedAddress[]): void => {
  if (candidates.length) providerCache.set(key, candidates, CACHE_SECONDS);
};

const locationCacheKey = (country: string, field: string, residential: boolean, region: string | undefined, query: string): string => {
  const url = new URL('https://address.internal/location-options');
  url.searchParams.set('version', '2');
  url.searchParams.set('country', country);
  url.searchParams.set('field', field);
  url.searchParams.set('residential', String(residential));
  if (region) url.searchParams.set('region', region);
  if (query) url.searchParams.set('query', query);
  return url.href;
};

const readLocationCache = <T,>(key: string): T | undefined => locationCache.get(key);

const writeLocationCache = (key: string, data: unknown): void => locationCache.set(key, data, LOCATION_CACHE_SECONDS);

const addressPoolCounts = async (db: SqliteDatabase | undefined): Promise<Map<string, number>> => {
  const counts = new Map<string, number>();
  if (!db) return counts;
  const cached = poolMetadataCache.get(db as object);
  if (cached?.v1 && cached.expiresAt > Date.now()) return cached.v1;
  try {
    const rows = await db.prepare('SELECT country_code, COUNT(*) AS total FROM address_pool WHERE active = 1 GROUP BY country_code')
      .all<{ country_code: string; total: number }>();
    for (const row of rows.results || []) counts.set(row.country_code, Number(row.total || 0));
  } catch {}
  poolMetadataCache.set(db as object, { ...poolMetadataCache.get(db as object), expiresAt: Date.now() + 30_000, v1: counts });
  return counts;
};

interface AddressPoolV2Count { total: number; residential: number }

interface AddressPoolV2CountRow { country_code: string; total: number; residential: number }

interface HotPoolCountryRow {
  country_code: string;
  slot_count: number;
  ready_slot_count: number;
  active_count: number;
}

interface LowWaterSlotRow {
  coverage_key: string;
  country_code: string;
  admin1_key: string;
  locality_key: string;
  property_type: string;
  active_count: number;
  minimum_count: number;
  refresh_status: string;
  expires_at: string | null;
}

interface HotPoolCoverage {
  available: boolean;
  countries: HotPoolCountryRow[];
  lowWaterSlots: LowWaterSlotRow[];
}

const addressPoolV2Counts = async (db: SqliteDatabase | undefined): Promise<Map<string, AddressPoolV2Count>> => {
  const counts = new Map<string, AddressPoolV2Count>();
  if (!db) return counts;
  const cached = poolMetadataCache.get(db as object);
  if (cached?.v2 && cached.expiresAt > Date.now()) return cached.v2;
  try {
    const rows = await db.prepare(`SELECT address.country_code, COUNT(*) AS total,
      SUM(CASE WHEN address.property_type IN ('residential','apartment') AND EXISTS (
        SELECT 1 FROM address_pool_evidence residential
        JOIN address_datasets dataset ON dataset.id=residential.dataset_id
          AND dataset.status='active' AND dataset.redistribution_allowed=1
        JOIN address_sources source ON source.id=dataset.source_id AND source.redistribution_allowed=1
        WHERE residential.address_id=address.id AND residential.evidence_type='residential_use'
          AND residential.is_current=1
      ) THEN 1 ELSE 0 END) AS residential
      FROM address_pool address WHERE address.active=1 AND address.quality_score>=0.7
        AND ${completenessClause('address.')}
        AND (address.expires_at IS NULL OR address.expires_at>?)
      GROUP BY address.country_code`)
      .bind(new Date().toISOString()).all<AddressPoolV2CountRow>();
    for (const row of rows.results || []) {
      counts.set(row.country_code, { total: Number(row.total || 0), residential: Number(row.residential || 0) });
    }
  } catch {}
  poolMetadataCache.set(db as object, { ...poolMetadataCache.get(db as object), expiresAt: Date.now() + 30_000, v2: counts });
  return counts;
};

const hotPoolCoverage = async (
  db: SqliteDatabase | undefined,
  requiredCountries: string[],
  minimumPerSlot: number,
  checkedAt: string
): Promise<HotPoolCoverage> => {
  if (!db || !requiredCountries.length) return { available: false, countries: [], lowWaterSlots: [] };
  const placeholders = requiredCountries.map(() => '?').join(',');
  const evaluated = `WITH evaluated AS (
    SELECT coverage.coverage_key, coverage.country_code, coverage.admin1_key, coverage.locality_key,
      coverage.property_type,
      CASE WHEN coverage.property_type IN ('residential','apartment')
        THEN coverage.residential_count ELSE coverage.active_count END AS active_count,
      CASE WHEN target_count > ? THEN target_count ELSE ? END AS minimum_count,
      coverage.refresh_status, coverage.expires_at
    FROM pool_coverage coverage
    WHERE coverage.country_code IN (${placeholders})
  )`;
  try {
    const summary = await db.prepare(`${evaluated}
      SELECT country_code, COUNT(*) AS slot_count, SUM(active_count) AS active_count,
        SUM(CASE WHEN active_count >= minimum_count AND refresh_status = 'ready'
          AND (expires_at IS NULL OR (datetime(expires_at) IS NOT NULL AND datetime(expires_at) > datetime(?))) THEN 1 ELSE 0 END) AS ready_slot_count
      FROM evaluated GROUP BY country_code ORDER BY country_code`)
      .bind(minimumPerSlot, minimumPerSlot, ...requiredCountries, checkedAt).all<HotPoolCountryRow>();
    const lowWater = await db.prepare(`${evaluated}
      SELECT coverage_key, country_code, admin1_key, locality_key, property_type, active_count,
        minimum_count, refresh_status, expires_at
      FROM evaluated
      WHERE active_count < minimum_count OR refresh_status <> 'ready'
        OR (expires_at IS NOT NULL AND (datetime(expires_at) IS NULL OR datetime(expires_at) <= datetime(?)))
      ORDER BY (minimum_count - active_count) DESC, country_code, coverage_key LIMIT 100`)
      .bind(minimumPerSlot, minimumPerSlot, ...requiredCountries, checkedAt).all<LowWaterSlotRow>();
    return {
      available: true,
      countries: summary.results || [],
      lowWaterSlots: lowWater.results || []
    };
  } catch {
    return { available: false, countries: [], lowWaterSlots: [] };
  }
};

const loadDynamicCandidates = async (
  country: NonNullable<ReturnType<typeof countryByCode.get>>,
  residential: boolean,
  filters: AddressFilters,
  env: Bindings,
  target?: CatalogTarget,
  timeoutMs?: number,
  useCache = true
): Promise<{ candidates: VerifiedAddress[]; sources: string[] }> => {
  const cacheKey = providerCacheKey(country.code, residential, filters, target);
  if (useCache) {
    const cached = filterProviderCandidates(readProviderCache(cacheKey) || []);
    if (cached.length) return { candidates: cached, sources: ['edge-cache'] };
  }
  const external = await fetchExternalCandidates(country, residential, filters, {
    amap: env.AMAP_API_KEY,
    geoapify: env.GEOAPIFY_API_KEY,
    oneMap: env.ONEMAP_ACCESS_TOKEN,
    osDataHub: env.OS_DATA_HUB_API_KEY
  }, undefined, undefined, target, timeoutMs);
  const candidates = filterProviderCandidates(external.candidates);
  if (useCache) writeProviderCache(cacheKey, candidates);
  return { candidates, sources: external.sources };
};

app.use('*', async (context, next) => {
  if (context.req.method === 'OPTIONS') {
    return context.body(null, 204, {
      'Access-Control-Allow-Origin': context.env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'GET,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
  }
  await next();
  context.header('Access-Control-Allow-Origin', context.env.ALLOWED_ORIGIN || '*');
  context.header('X-Content-Type-Options', 'nosniff');
});

app.get('/', (context) => context.json({ service: 'Real Address Generator API', version: 'v1' }));
app.get('/api/v1/health', (context) => context.json({ status: 'ok' }));

app.get('/api/v1/countries', async (context) => {
  const coverage = new Map<string, number>();
  const [poolCounts, poolV2Counts] = await Promise.all([
    addressPoolCounts(context.env.LOCATION_DB),
    addressPoolV2Counts(context.env.ADDRESS_DB)
  ]);
  if (context.env.LOCATION_DB) {
    const rows = await context.env.LOCATION_DB.prepare('SELECT country_code, SUM(address_count) AS total FROM residential_coverage GROUP BY country_code')
      .all<{ country_code: string; total: number }>();
    for (const row of rows.results || []) coverage.set(row.country_code, Number(row.total || 0));
  }
  const hasPoolDatabase = Boolean(context.env.LOCATION_DB || context.env.ADDRESS_DB);
  const data = countries.map((country) => {
    const v2 = poolV2Counts.get(country.code);
    const addressCount = context.env.ADDRESS_DB ? v2?.total || 0 : poolCounts.get(country.code) || 0;
    const residentialCount = context.env.ADDRESS_DB ? v2?.residential || 0 : coverage.get(country.code) || 0;
    return {
      ...country,
      addressCount: hasPoolDatabase ? addressCount : null,
      residentialCount: hasPoolDatabase ? residentialCount : country.residentialCapability ? null : 0,
      residentialAvailable: hasPoolDatabase ? residentialCount >= RESIDENTIAL_MIN_POOL : country.residentialCapability,
      generationMode: addressCount > 0 ? 'synchronized-pool' : 'sync-required'
    };
  });
  context.header('Cache-Control', 'no-store');
  return context.json({ data });
});

app.get('/api/v1/client-context', async (context) => {
  const manualIp = context.req.query('ip');
  const network = requestContext(context.req.raw, context.env);
  const data = manualIp === undefined
    ? await locateRequestIp(context.req.raw, context.env)
    : withRequestNetworkContext(
      await lookupManualIpContext(manualIp, context.env.IP_GEOLOCATION_API_URL, fetch, context.env.IP_GEOLOCATION_FALLBACK_API_URL),
      network
    );
  context.header('Cache-Control', 'no-store');
  return context.json({ data });
});

app.get('/api/v1/locations/search', async (context) => {
  const country = context.req.query('country')?.toUpperCase() || 'US';
  if (!isCountryCode(country)) throw new DomainError('INVALID_COUNTRY', `Unknown country code: ${country}`);
  const config = countryByCode.get(country);
  if (!config) throw new DomainError('INVALID_COUNTRY', `Unknown country code: ${country}`);
  const fieldQuery = context.req.query('field') || 'city';
  if (!['region', 'city', 'postcode'].includes(fieldQuery)) throw new DomainError('INVALID_FIELD', 'Unknown location field.');
  const field = fieldQuery as LocationField;
  const query = context.req.query('q')?.trim() || '';
  const region = context.req.query('region') || undefined;
  const regionId = context.req.query('regionId') || undefined;
  const cityId = context.req.query('cityId') || undefined;
  const cursor = context.req.query('cursor') || undefined;
  const limit = Number.parseInt(context.req.query('limit') || '100', 10);
  const residential = context.req.query('residential') === 'true';
  if (context.env.LOCATION_DB) {
    const catalog = await queryLocationCatalog(context.env.LOCATION_DB, {
      country: config.code,
      field,
      query,
      regionId,
      cityId,
      residential,
      cursor,
      limit
    });
    const responseData = {
      regions: field === 'region' ? catalog.options : [],
      cities: field === 'city' ? catalog.options : [],
      postcodes: field === 'postcode' ? catalog.options : [],
      matches: catalog.options,
      total: catalog.total,
      nextCursor: catalog.nextCursor,
      source: catalog.source
    };
    context.header('Cache-Control', 'public, max-age=2592000, stale-while-revalidate=604800');
    return context.json({ data: responseData });
  }
  if (field === 'region') {
    const regions = regionsForCountry(config.code, query);
    context.header('Cache-Control', 'public, max-age=2592000, stale-while-revalidate=604800');
    return context.json({ data: { regions, cities: [], postcodes: [], matches: regions } });
  }
  const cacheKey = locationCacheKey(config.code, field, residential, region, query);
  const cached = readLocationCache<{ regions: ReturnType<typeof locationOptions>; cities: ReturnType<typeof locationOptions>; postcodes: ReturnType<typeof locationOptions>; matches: ReturnType<typeof locationOptions> }>(cacheKey);
  if (cached) {
    context.header('Cache-Control', 'public, max-age=2592000, stale-while-revalidate=604800');
    return context.json({ data: cached });
  }
  const normalizedQuery = query.normalize('NFKD').replace(/[\u0300-\u036f]/gu, '').toLocaleLowerCase();
  const cities = field === 'city' ? config.popularCities
    .filter((item) => !normalizedQuery || [item.value, item.label.en, item.label['zh-CN']].some((value) =>
      value.normalize('NFKD').replace(/[\u0300-\u036f]/gu, '').toLocaleLowerCase().includes(normalizedQuery)))
    .map((item) => item.value) : [];
  const data = { regions: [], cities, postcodes: [], matches: cities };
  context.header('Cache-Control', 'public, max-age=2592000, stale-while-revalidate=604800');
  const responseData = {
    regions: locationOptions(data.regions),
    cities: locationOptions(data.cities),
    postcodes: locationOptions(data.postcodes),
    matches: locationOptions(data.matches)
  };
  writeLocationCache(cacheKey, responseData);
  return context.json({ data: responseData });
});

app.get('/api/v1/generate', async (context) => {
  const startedAt = performance.now();
  const timings: GenerateTimings = { pool: 0, provider: 0, localize: 0 };
  const ipRegionMode = context.req.query('mode') === 'ip-region';
  const manualIp = context.req.query('ip');
  let ipContext: ClientContext | undefined;
  if (ipRegionMode) {
    if (manualIp !== undefined) {
      ipContext = await lookupManualIpContext(manualIp, context.env.IP_GEOLOCATION_API_URL, fetch, context.env.IP_GEOLOCATION_FALLBACK_API_URL);
    } else {
      ipContext = await locateRequestIp(context.req.raw, context.env);
    }
  }
  if (ipRegionMode && !ipContext?.country) {
    throw new DomainError('IP_LOCATION_UNAVAILABLE', 'No supported country was found for this IP location.', 400);
  }
  const countryCode = ipContext?.country || context.req.query('country')?.toUpperCase() || 'US';
  if (!isCountryCode(countryCode)) throw new DomainError('INVALID_COUNTRY', `Unknown country code: ${countryCode}`);
  const country = countryByCode.get(countryCode);
  if (!country) throw new DomainError('INVALID_COUNTRY', `Unknown country code: ${countryCode}`);

  const residentialQuery = context.req.query('residential');
  if (residentialQuery && !['true', 'false'].includes(residentialQuery)) {
    throw new DomainError('INVALID_RESIDENTIAL', 'Residential must be true or false.');
  }
  const residential = country.residentialCapability && residentialQuery !== 'false';
  const seed = context.req.query('seed') || crypto.randomUUID();
  const strategy = context.req.query('strategy') === 'instant' ? 'instant' : 'random';
  const requestId = context.req.query('requestId') || crypto.randomUUID();
  const mode = ipRegionMode ? 'ip-region' : residential ? 'residential' : 'address';
  const liveApiModes = new Set(String(context.env.LIVE_API_MODES ?? 'ip-region')
    .split(',').map((value) => value.trim().toLowerCase()).filter(Boolean));
  // Per-request opt-in via ?live=true always allows live lookup; otherwise the server-wide LIVE_API_MODES decides.
  const liveRequested = ['true', '1'].includes((context.req.query('live') || '').toLowerCase());
  const liveApiEnabled = liveRequested || liveApiModes.has(mode);
  const requestedFilters: AddressFilters = {
    q: context.req.query('q') || undefined,
    region: context.req.query('region') || undefined,
    regionId: context.req.query('regionId') || undefined,
    city: context.req.query('city') || undefined,
    cityId: context.req.query('cityId') || undefined,
    postcode: context.req.query('postcode') || undefined,
    postcodeId: context.req.query('postcodeId') || undefined
  };
  const filters: AddressFilters = ipRegionMode ? { q: requestedFilters.q } : requestedFilters;

  const hasLocationFilter = Boolean(
    filters.region || filters.regionId || filters.city || filters.cityId || filters.postcode || filters.postcodeId
  );
  const ipCoordinates = ipContext?.latitude !== undefined && ipContext.longitude !== undefined
    ? { latitude: ipContext.latitude, longitude: ipContext.longitude }
    : undefined;
  const ipLocationFilters: AddressFilters = {
    q: filters.q,
    region: ipContext?.regionCode || ipContext?.region,
    city: ipContext?.city,
    postcode: ipContext?.postalCode
  };
  let catalogLookupFailed = false;
  let target: CatalogTarget | undefined;
  try {
    const nearestCatalog = ipRegionMode && ipCoordinates && context.env.LOCATION_DB
      ? await resolveNearestCatalogTarget(context.env.LOCATION_DB, country.code, ipCoordinates)
      : undefined;
    target = ipRegionMode
      ? nearestCatalog?.target || (context.env.LOCATION_DB
        ? await resolveCatalogTarget(context.env.LOCATION_DB, country.code, ipLocationFilters, seed)
        : undefined)
      : context.env.LOCATION_DB && hasLocationFilter
        ? await resolveCatalogTarget(context.env.LOCATION_DB, country.code, filters, seed)
        : undefined;
  } catch {
    catalogLookupFailed = true;
  }
  if (context.env.LOCATION_DB && hasLocationFilter && !target && !catalogLookupFailed) {
    throw new DomainError('INVALID_LOCATION', 'The selected region, city, or postcode is not present in the location catalog.', 400);
  }

  let candidates: VerifiedAddress[] = [];
  const sourcesTried: string[] = [];
  let pooledSource = '';
  let ipMatchLevel: 'coordinate' | 'city' | 'region' | 'country' | undefined;
  let ipDistanceKm: number | undefined;
  let filterMatchLevel: 'exact' | 'nearby' | 'region' | 'country' | undefined;
  let resolvedFilters = filters;
  let resolvedTarget = target;
  if (ipRegionMode && ipCoordinates && liveApiEnabled) {
    resolvedFilters = target?.city ? {
      q: filters.q,
      region: target.region,
      city: target.city
    } : target?.region ? {
      q: filters.q,
      region: target.region
    } : ipLocationFilters;
    const liveTarget: CatalogTarget | undefined = ipCoordinates ? {
      ...(target || {
        region: ipContext?.region,
        regionCode: ipContext?.regionCode,
        regionAliases: [ipContext?.region, ipContext?.regionCode].filter((value): value is string => Boolean(value)),
        city: ipContext?.city,
        cityAliases: [ipContext?.city].filter((value): value is string => Boolean(value)),
        bucket: `ip-${country.code}`
      }),
      coordinates: ipCoordinates,
      bucket: `ip-${country.code}-${ipCoordinates.latitude.toFixed(3)}-${ipCoordinates.longitude.toFixed(3)}`
    } : target;
    try {
      const dynamic = await measureStage(timings, 'provider', () => loadDynamicCandidates(
        country,
        residential,
        resolvedFilters,
        context.env,
        liveTarget,
        IP_LIVE_LOOKUP_TIMEOUT_MS,
        false
      ));
      candidates = dynamic.candidates;
      sourcesTried.push(...dynamic.sources);
      if (!candidates.length && ipCoordinates) {
        sourcesTried.push('osm-overpass');
        candidates = await measureStage(timings, 'provider', () => fetchOverpassCandidates(
          country,
          residential,
          resolvedFilters,
          context.env.OVERPASS_API_URL,
          context.env.PHOTON_API_URL,
          context.env.OVERPASS_MOCK,
          undefined,
          undefined,
          liveTarget,
          IP_LIVE_LOOKUP_TIMEOUT_MS
        ));
      }
      if (candidates.length) {
        ipMatchLevel = 'coordinate';
        resolvedTarget = liveTarget;
      }
    } catch {
      candidates = [];
    }
  }

  if (!ipRegionMode && liveApiEnabled) {
    try {
      const dynamic = await measureStage(timings, 'provider', () => loadDynamicCandidates(
        country,
        residential,
        filters,
        context.env,
        target
      ));
      candidates = dynamic.candidates;
      sourcesTried.push(...dynamic.sources);
    } catch {
      candidates = [];
    }
  }

  let liveCandidatesLocalized = false;
  if (candidates.length) {
    const localized: VerifiedAddress[] = [];
    for (let attempt = 0; attempt < Math.min(12, candidates.length); attempt += 1) {
      try {
        localized.push(await measureStage(timings, 'localize', () =>
          localizeAddress(orderedCandidate(candidates, seed, attempt), country, context.env)
        ));
        break;
      } catch {
        // A synchronized pool remains available when live localization infrastructure is degraded.
      }
    }
    candidates = localized;
    liveCandidatesLocalized = localized.length > 0;
  }

  const pooled = candidates.length ? undefined : await measureStage(timings, 'pool', async () => {
    if (ipRegionMode) {
      if (ipCoordinates) {
        const nearest = await toleratePoolFailure(() => pickNearestAddressPoolV2Address(
          context.env.ADDRESS_DB,
          country.code,
          residential,
          ipCoordinates,
          seed
        ));
        if (nearest) {
          pooledSource = 'address-pool-v2';
          ipMatchLevel = 'coordinate';
          ipDistanceKm = nearest.distanceKm;
          return nearest.address;
        }
      }

      const cityFilters: AddressFilters = {
        q: filters.q,
        region: target?.region || ipContext?.regionCode || ipContext?.region,
        city: target?.city || ipContext?.city
      };
      if (cityFilters.city) {
        const cityAddress = await toleratePoolFailure(() => pickAddressPoolV2Address(
          context.env.ADDRESS_DB, country.code, residential, cityFilters, target, seed
        )) || await toleratePoolFailure(() => pickAddressPoolAddress(
          context.env.LOCATION_DB, country.code, residential, cityFilters, target, seed
        ));
        if (cityAddress) {
          pooledSource = cityAddress.id.startsWith('pool-v2-') ? 'address-pool-v2' : 'address-pool-v1';
          ipMatchLevel = 'city';
          resolvedFilters = cityFilters;
          return cityAddress;
        }
      }

      const regionTarget: CatalogTarget | undefined = target?.region ? {
        coordinates: target.coordinates,
        regionId: target.regionId,
        region: target.region,
        regionNative: target.regionNative,
        regionCode: target.regionCode,
        regionAliases: target.regionAliases,
        cityAliases: [],
        bucket: `ip-region-${target.regionId || target.regionCode || target.region}`
      } : undefined;
      const regionFilters: AddressFilters = {
        q: filters.q,
        region: regionTarget?.region || ipContext?.regionCode || ipContext?.region
      };
      if (regionFilters.region) {
        const regionAddress = await toleratePoolFailure(() => pickAddressPoolV2Address(
          context.env.ADDRESS_DB, country.code, residential, regionFilters, regionTarget, seed
        )) || await toleratePoolFailure(() => pickAddressPoolAddress(
          context.env.LOCATION_DB, country.code, residential, regionFilters, regionTarget, seed
        ));
        if (regionAddress) {
          pooledSource = regionAddress.id.startsWith('pool-v2-') ? 'address-pool-v2' : 'address-pool-v1';
          ipMatchLevel = 'region';
          resolvedFilters = regionFilters;
          resolvedTarget = regionTarget;
          return regionAddress;
        }
      }

      const countryAddress = await toleratePoolFailure(() => pickAddressPoolV2Address(
        context.env.ADDRESS_DB, country.code, residential, filters, undefined, seed
      )) || await toleratePoolFailure(() => pickAddressPoolAddress(
        context.env.LOCATION_DB, country.code, residential, filters, undefined, seed
      ));
      if (countryAddress) {
        pooledSource = countryAddress.id.startsWith('pool-v2-') ? 'address-pool-v2' : 'address-pool-v1';
        ipMatchLevel = 'country';
        resolvedTarget = undefined;
      }
      if (countryAddress) return countryAddress;
      return undefined;
    }

    let current = await toleratePoolFailure(() =>
      pickAddressPoolV2Address(context.env.ADDRESS_DB, country.code, residential, filters, target, seed)
    );
    if (current) {
      pooledSource = 'address-pool-v2';
      filterMatchLevel = 'exact';
      return current;
    }
    const legacyExact = await toleratePoolFailure(() =>
      pickAddressPoolAddress(context.env.LOCATION_DB, country.code, residential, filters, target, seed)
    );
    if (legacyExact) {
      pooledSource = 'address-pool-v1';
      filterMatchLevel = 'exact';
      return legacyExact;
    }
    // Fallback chain so a country with data never 404s: nearby → region → country.
    if (hasLocationFilter) {
      if (target?.coordinates) {
        const nearby = await toleratePoolFailure(() => pickNearestAddressPoolV2Address(
          context.env.ADDRESS_DB, country.code, residential, target.coordinates, seed, 150
        ));
        if (nearby) {
          pooledSource = 'address-pool-v2';
          filterMatchLevel = 'nearby';
          ipDistanceKm = nearby.distanceKm;
          return nearby.address;
        }
      }
      if (target?.region) {
        const regionOnly: AddressFilters = { q: filters.q, region: target.region };
        const regionTarget: CatalogTarget = {
          coordinates: target.coordinates,
          regionId: target.regionId,
          region: target.region,
          regionNative: target.regionNative,
          regionCode: target.regionCode,
          regionAliases: target.regionAliases,
          cityAliases: [],
          bucket: `filter-region-${target.regionId || target.regionCode || target.region}`
        };
        const regionAddress = await toleratePoolFailure(() =>
          pickAddressPoolV2Address(context.env.ADDRESS_DB, country.code, residential, regionOnly, regionTarget, seed)
        ) || await toleratePoolFailure(() =>
          pickAddressPoolAddress(context.env.LOCATION_DB, country.code, residential, regionOnly, regionTarget, seed)
        );
        if (regionAddress) {
          pooledSource = regionAddress.id.startsWith('pool-v2-') ? 'address-pool-v2' : 'address-pool-v1';
          filterMatchLevel = 'region';
          resolvedFilters = regionOnly;
          resolvedTarget = regionTarget;
          return regionAddress;
        }
      }
    }
    const nationwide = await toleratePoolFailure(() =>
      pickAddressPoolV2Address(context.env.ADDRESS_DB, country.code, residential, { q: filters.q }, undefined, seed)
    ) || await toleratePoolFailure(() =>
      pickAddressPoolAddress(context.env.LOCATION_DB, country.code, residential, { q: filters.q }, undefined, seed)
    );
    if (nationwide) {
      pooledSource = nationwide.id.startsWith('pool-v2-') ? 'address-pool-v2' : 'address-pool-v1';
      filterMatchLevel = hasLocationFilter ? 'country' : 'exact';
      resolvedFilters = { q: filters.q };
      resolvedTarget = undefined;
      return nationwide;
    }
    return undefined;
  });
  if (pooled) {
    candidates = [pooled];
    sourcesTried.push(pooledSource);
  }
  if (candidates.length === 0) {
    throw new DomainError(
      ipRegionMode ? 'IP_REGION_NO_RESULT' : 'NO_POOL_COVERAGE',
      ipRegionMode
        ? `No live or synchronized address is available for the IP region in ${countryCode}.`
        : `No synchronized address is available for the selected area in ${countryCode}.`,
      404
    );
  }

  let result: GeneratedBundle | undefined;
  let selectedCandidate: VerifiedAddress | undefined;
  const maxAttempts = Math.min(12, candidates.length);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const selected = orderedCandidate(candidates, seed, attempt);
    const candidate = pooledSource || liveCandidatesLocalized
      ? selected
      : await measureStage(timings, 'localize', () => localizeAddress(selected, country, context.env));
    result = generateBundle(candidate, residential, seed, undefined);
    selectedCandidate = candidate;
    break;
  }
  if (!result) {
    throw new DomainError('GOOGLE_ADDRESS_NOT_RESOLVED', 'No Google Maps result passed the exact address gate.', 404);
  }
  context.header('Cache-Control', 'no-store');
  context.header('Server-Timing', serverTiming(startedAt, timings));
  const ipRegion = ipContext ? {
    source: ipContext.source,
    contextMatchLevel: ipContext.matchLevel,
    precisionLevel: ipContext.precisionLevel,
    targetRegion: selectedCandidate?.components.admin1 || resolvedTarget?.region,
    targetCity: selectedCandidate?.components.locality || resolvedTarget?.city,
    ...(ipDistanceKm === undefined ? {} : { distanceKm: Number(ipDistanceKm.toFixed(2)) })
  } : undefined;
  return context.json({
    data: {
      requestId,
      mode,
      strategy,
      country: countryCode,
      residential,
      filters: resolvedFilters,
      sourcesTried,
      ...(ipRegionMode ? { ipMatchLevel, ipRegion } : { filterMatchLevel: filterMatchLevel || (candidates.length ? 'exact' : undefined) }),
      result
    }
  });
});

app.get('/api/v1/data-health', async (context) => {
  const configuredCodes = (context.env.HOT_POOL_COUNTRIES || countries.map(({ code }) => code).join(','))
    .split(',').map((value) => value.trim().toUpperCase()).filter(Boolean);
  const requiredCountries = [...new Set(configuredCodes.filter(isCountryCode))];
  const invalidCountries = [...new Set(configuredCodes.filter((code) => !isCountryCode(code)))];
  const parsedMinimum = Number(context.env.HOT_POOL_MIN_PER_SLOT || '1');
  const minimumPerSlot = Number.isInteger(parsedMinimum) && parsedMinimum > 0 ? parsedMinimum : 1;
  const configurationErrors = [
    ...(invalidCountries.length ? [`Unsupported HOT_POOL_COUNTRIES: ${invalidCountries.join(',')}`] : []),
    ...(!Number.isInteger(parsedMinimum) || parsedMinimum <= 0
      ? ['HOT_POOL_MIN_PER_SLOT must be a positive integer.']
      : [])
  ];
  const checkedAt = new Date().toISOString();
  const [poolCounts, poolV2Counts, coverage] = await Promise.all([
    addressPoolCounts(context.env.LOCATION_DB),
    addressPoolV2Counts(context.env.ADDRESS_DB),
    hotPoolCoverage(context.env.ADDRESS_DB, requiredCountries, minimumPerSlot, checkedAt)
  ]);
  const coverageByCountry = new Map(coverage.countries.map((item) => [item.country_code, item]));
  const missingCountries = requiredCountries.filter((code) => !coverageByCountry.get(code)?.slot_count);
  const perCountry = countries.map((country) => {
    const v1 = poolCounts.get(country.code) || 0;
    const v2 = poolV2Counts.get(country.code);
    const hotPool = coverageByCountry.get(country.code);
    const hotPoolSlots = Number(hotPool?.slot_count || 0);
    const readyHotPoolSlots = Number(hotPool?.ready_slot_count || 0);
    return {
      country: country.code,
      mode: v1 || v2?.total ? 'offline-first' : 'dynamic',
      addressPoolRecords: Math.max(v1, v2?.total || 0),
      addressPoolV1Records: v1,
      addressPoolV2Records: v2?.total || 0,
      residentialPoolRecords: v2?.residential || 0,
      residential: country.residentialCapability,
      hotPoolRequired: requiredCountries.includes(country.code),
      hotPoolSlots,
      readyHotPoolSlots,
      lowWaterSlots: hotPoolSlots - readyHotPoolSlots,
      hotPoolCoverageRate: hotPoolSlots ? readyHotPoolSlots / hotPoolSlots : 0
    };
  });
  const totalSlots = perCountry.reduce((total, item) => total + item.hotPoolSlots, 0);
  const readySlots = perCountry.reduce((total, item) => total + item.readyHotPoolSlots, 0);
  const lowWaterSlotCount = totalSlots - readySlots;
  const hotPoolAvailable = coverage.available;
  const status = hotPoolAvailable && !missingCountries.length && !lowWaterSlotCount && !configurationErrors.length
    ? 'ready'
    : 'degraded';
  context.header('Cache-Control', 'no-store');
  return context.json({
    data: {
      status,
      checkedAt,
      configuredCountries: countries.length,
      requiredCountries,
      minimumPerSlot,
      addressRecords: perCountry.reduce((total, item) => total + item.addressPoolRecords, 0),
      residentialRecords: perCountry.reduce((total, item) => total + item.residentialPoolRecords, 0),
      hotPool: {
        available: hotPoolAvailable,
        totalSlots,
        readySlots,
        lowWaterSlotCount,
        coverageRate: totalSlots ? readySlots / totalSlots : 0,
        missingCountries,
        lowWaterSlots: coverage.lowWaterSlots.map((slot) => ({
          coverageKey: slot.coverage_key,
          country: slot.country_code,
          region: slot.admin1_key,
          locality: slot.locality_key,
          propertyType: slot.property_type,
          activeCount: Number(slot.active_count || 0),
          minimumCount: Number(slot.minimum_count || 0),
          deficit: Math.max(0, Number(slot.minimum_count || 0) - Number(slot.active_count || 0)),
          refreshStatus: slot.refresh_status,
          expiresAt: slot.expires_at
        })),
        lowWaterSlotsTruncated: lowWaterSlotCount > coverage.lowWaterSlots.length
      },
      configurationErrors,
      providers: {
        hkAls: true,
        amap: Boolean(context.env.AMAP_API_KEY),
        geoapify: Boolean(context.env.GEOAPIFY_API_KEY),
        oneMap: Boolean(context.env.ONEMAP_ACCESS_TOKEN),
        osDataHub: Boolean(context.env.OS_DATA_HUB_API_KEY),
        googleTranslate: true,
        youdao: Boolean(context.env.YOUDAO_APP_KEY && context.env.YOUDAO_APP_SECRET)
      },
      perCountry
    }
  });
});

app.notFound((context) => context.json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }, 404));

app.onError((error, context) => {
  if (error instanceof ManualIpLookupError) {
    return context.json(
      { error: { code: error.code, message: error.message } },
      error.status
    );
  }
  if (error instanceof DomainError) {
    const status = [400, 404, 502, 503].includes(error.status) ? error.status : 500;
    return context.json(
      { error: { code: error.code, message: error.message } },
      status as 400 | 404 | 500 | 502 | 503
    );
  }
  console.error(error);
  return context.json({ error: { code: 'INTERNAL_ERROR', message: 'Unexpected service error' } }, 500);
});

export default app;
