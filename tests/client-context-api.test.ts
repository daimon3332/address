import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../server/api/index';
import { lookupManualIpContext } from '../server/api/services/ip-geolocation';

const components = {
  houseNumber: '1', street: "Queen's Road East", locality: 'Wan Chai',
  admin1: 'Hong Kong', admin1Code: 'HK', postcode: ''
};

const addressRow = {
  id: 'hk-nearby', country_code: 'HK', admin1: components.admin1, admin1_code: components.admin1Code,
  locality: components.locality, postal_locality: components.locality, district: '', postcode: '',
  street: components.street, house_number: components.houseNumber, building_name: '',
  latitude: 22.276, longitude: 114.175, native_language: 'zh-TW', property_type: 'residential',
  generation: 'test', quality_score: 0.95, first_seen_at: '2026-07-15T00:00:00Z',
  expires_at: '2027-07-15T00:00:00Z',
  component_variants_json: JSON.stringify({ native: components, en: components, 'zh-CN': components }),
  address_variants_json: JSON.stringify({
    native: '香港灣仔皇后大道東1號', en: "1 Queen's Road East, Wan Chai, Hong Kong",
    'zh-CN': '香港湾仔皇后大道东1号'
  }),
  source_id: 'fixture', source_name: 'Fixture', source_url: 'https://example.test/source',
  source_record_id: 'hk-nearby', record_url: 'https://example.test/source/hk-nearby',
  observed_at: '2026-07-15T00:00:00Z', evidence_type: 'address_existence', residential_evidence: 1,
  dataset_id: 'fixture-v2', dataset_version: 'test', source_updated_at: '2026-07-15T00:00:00Z',
  imported_at: '2026-07-16T00:00:00Z'
};

const addressDb = {
  prepare() {
    const statement = {
      bind() { return statement; },
      async all() { return { results: [addressRow] }; },
      async first() { return addressRow; }
    };
    return statement;
  }
};

const hongKongLookup = () => Response.json({
  success: true,
  country: 'Hong Kong',
  country_code: 'HK',
  region: 'Hong Kong',
  city: 'Hong Kong',
  latitude: 22.276022,
  longitude: 114.1751471,
  timezone: 'Asia/Hong_Kong'
});

afterEach(() => vi.unstubAllGlobals());

describe('self-hosted client context API', () => {
  it('resolves the direct request socket and preserves the detected public IP', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return hongKongLookup();
    }));

    const response = await app.request('/api/v1/client-context', {}, {
      ALLOWED_ORIGIN: '*', incoming: { socket: { remoteAddress: '::ffff:162.141.137.231' } }
    });
    const payload = await response.json() as { data: Record<string, unknown> };

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(calls).toEqual(['https://ipwho.is/162.141.137.231']);
    expect(payload.data).toMatchObject({
      country: 'HK', region: 'Hong Kong', city: 'Hong Kong', publicIp: '162.141.137.231',
      latitude: 22.276022, longitude: 114.1751471, source: 'manual-database',
      supported: true, matchLevel: 'city', precisionLevel: 'coordinates'
    });
  });

  it('uses forwarding headers only when trusted-proxy mode is enabled', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => hongKongLookup()));
    const headers = { 'X-Forwarded-For': '162.141.137.231, 10.0.0.2' };

    const untrusted = await app.request('/api/v1/client-context', { headers }, {
      incoming: { socket: { remoteAddress: '127.0.0.1' } }
    });
    const trusted = await app.request('/api/v1/client-context', { headers }, {
      TRUST_PROXY: 'true', incoming: { socket: { remoteAddress: '127.0.0.1' } }
    });

    await expect(untrusted.json()).resolves.toMatchObject({ data: {
      supported: false, source: 'request-socket'
    } });
    await expect(trusted.json()).resolves.toMatchObject({ data: {
      country: 'HK', publicIp: '162.141.137.231', source: 'manual-database'
    } });
  });

  it('looks up an explicitly supplied IP without echoing it into generated data', async () => {
    const calls: string[] = [];
    const data = await lookupManualIpContext('162.141.137.231', undefined, async (input) => {
      calls.push(String(input));
      return hongKongLookup();
    });

    expect(calls).toEqual(['https://ipwho.is/162.141.137.231']);
    expect(data).toMatchObject({
      country: 'HK', region: 'Hong Kong', city: 'Hong Kong',
      latitude: 22.276022, longitude: 114.1751471, precisionLevel: 'coordinates'
    });
    expect(data).not.toHaveProperty('publicIp');
  });

  it('uses the secondary IP database when the primary lookup fails', async () => {
    const calls: string[] = [];
    const data = await lookupManualIpContext('162.141.137.231', undefined, async (input) => {
      calls.push(String(input));
      if (calls.length === 1) return new Response(null, { status: 503 });
      return Response.json({
        country_code: 'HK', region: 'Hong Kong', region_code: 'HK', city: 'Hong Kong',
        postal: '', latitude: 22.276022, longitude: 114.1751471, timezone: 'Asia/Hong_Kong'
      });
    });

    expect(calls).toEqual([
      'https://ipwho.is/162.141.137.231',
      'https://ipapi.co/162.141.137.231/json/'
    ]);
    expect(data).toMatchObject({ country: 'HK', regionCode: 'HK', latitude: 22.276022, longitude: 114.1751471 });
  });

  it('returns structured errors for invalid input and a disabled lookup endpoint', async () => {
    const invalid = await app.request('/api/v1/client-context?ip=not-an-ip', {}, { ALLOWED_ORIGIN: '*' });
    const unavailable = await app.request('/api/v1/client-context?ip=198.51.100.7', {}, {
      ALLOWED_ORIGIN: '*', IP_GEOLOCATION_API_URL: ''
    });

    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({ error: { code: 'INVALID_IP' } });
    expect(unavailable.status).toBe(503);
    await expect(unavailable.json()).resolves.toMatchObject({ error: { code: 'IP_DATABASE_UNAVAILABLE' } });
  });

  it('generates from the nearest local SQLite row for 162.141.137.231', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => hongKongLookup()));
    const response = await app.request(
      '/api/v1/generate?mode=ip-region&ip=162.141.137.231&residential=true&seed=hk-nearby&requestId=hk-nearby',
      {},
      { ALLOWED_ORIGIN: '*', ADDRESS_DB: addressDb, OVERPASS_MOCK: JSON.stringify({ elements: [] }) }
    );
    const payload = await response.json() as { data: Record<string, unknown> };

    expect(response.status).toBe(200);
    expect(payload.data).toMatchObject({
      requestId: 'hk-nearby', country: 'HK', mode: 'ip-region', ipMatchLevel: 'coordinate',
      sourcesTried: ['osm-overpass', 'address-pool-v2'],
      ipRegion: { source: 'manual-database', precisionLevel: 'coordinates' }
    });
    expect(JSON.stringify(payload)).not.toContain('162.141.137.231');
  });
});
