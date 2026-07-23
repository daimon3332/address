import { describe, expect, it, vi } from 'vitest';
import App, {
  createRequestId,
  fetchWithTimeout,
  generationErrorMessageKey,
  IP_GENERATION_REQUEST_TIMEOUT_MS,
  LOCATION_OPTION_RENDER_LIMIT
} from '../src/components/App';
import { countries } from '../src/domain/countries';
import { messages } from '../src/domain/i18n';

const appSource = App.toString();

describe('dual-mode generator page structure', () => {
  it('defaults to the United States and exposes 27 countries in nine ordered groups', () => {
    expect(countries[0].code).toBe('US');
    expect(new Set(countries.map((country) => country.group)).size).toBe(9);
    expect(countries).toHaveLength(27);
    expect(appSource).toContain('useState)("US")');
    expect(appSource).toContain('country-browser');
  });

  it('uses separate ordinary and residential modes with three address languages', () => {
    expect(messages['zh-CN'].normalMode).toBe('普通地址');
    expect(messages['zh-CN'].residentialMode).toBe('真实住宅地址');
    expect(appSource).toContain('mode-tabs');
    expect(appSource).not.toContain('residential-toggle');
    expect(appSource).toContain('language-tabs');
    expect(appSource).toContain('googleMaps.embedUrl');
  });

  it('links the top navigation GitHub icon to the public repository', () => {
    expect(appSource).toContain('https://github.com/daimon3332/address');
    expect(appSource).toContain('github-link');
    expect(appSource).toMatch(/"aria-label"\s*:\s*"GitHub"/);
    expect(appSource).toContain('noopener noreferrer');
    expect(appSource).toContain('_blank');
  });

  it('renders structured address, profile, simple card and map groups', () => {
    expect(appSource).toContain('address-table');
    expect(appSource).toContain('profile-card');
    expect(appSource).toContain('card-section');
    expect(appSource).toContain('map-frame');
    expect(appSource).toContain('extension-grid');
    expect(appSource).not.toContain('test-card');
    expect(countries.find(({ code }) => code === 'HK')?.name['zh-CN']).toBe('香港');
    expect(countries.find(({ code }) => code === 'TW')?.name['zh-CN']).toBe('台湾');
  });

  it('uses searchable filter inputs and working sidebar shortcuts', () => {
    expect(appSource).toContain('Combobox');
    expect(appSource).toContain('loadOptions');
    expect(appSource).not.toContain('datalist');
    expect(appSource).toContain('void generate(overrides)');
    expect(appSource).toContain('params.set("regionId"');
    expect(appSource).toContain('params.set("cityId"');
    expect(appSource).toContain('params.set("postcodeId"');
    expect(appSource).toContain('option.regionValue');
  });

  it('loads complete city parent sets and filters cities without server-side search', () => {
    expect(appSource).toContain('field === "postcode" ? "100" : "20000"');
    expect(appSource).toContain('field !== "city" && query.trim()');
    expect(appSource).toContain('clientFilter: true');
    expect(LOCATION_OPTION_RENDER_LIMIT).toBe(200);
  });

  it('guards JSON responses and stale generation contexts', () => {
    expect(appSource).toContain('content-type');
    expect(appSource).toContain('API response is not JSON');
    expect(appSource).toContain('activeRequest');
    expect(appSource).toContain('requestId');
    expect(appSource).toContain('locationControllers.current[field] !== controller');
  });

  it('creates request IDs without requiring crypto.randomUUID', () => {
    const fallback = createRequestId({
      getRandomValues: (bytes) => {
        bytes.fill(0xab);
        return bytes;
      }
    });
    expect(fallback).toBe('abababab-abab-4bab-abab-abababababab');
    expect(createRequestId({ randomUUID: () => 'native-id' })).toBe('native-id');
  });

  it('aborts stalled frontend requests with a visible timeout code', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    })) as unknown as typeof fetch;
    const request = fetchWithTimeout('/api/v1/generate', {}, 25, fetchImpl);
    const rejection = expect(request).rejects.toThrow('REQUEST_TIMEOUT');
    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    vi.useRealTimers();
  });

  it('maps generation error codes to specific messages', () => {
    expect(generationErrorMessageKey('NO_POOL_COVERAGE', false)).toBe('noPoolCoverage');
    expect(generationErrorMessageKey('IP_REGION_NO_RESULT', true)).toBe('ipNoResult');
    expect(generationErrorMessageKey('UPSTREAM_TIMEOUT', false)).toBe('retry');
    expect(generationErrorMessageKey('NO_SOURCE_RESULT', false)).toBe('requestFailed');
    expect(generationErrorMessageKey('IP_DATABASE_UNAVAILABLE', true)).toBe('ipLookupFailed');
    expect(messages['zh-CN'].noPoolCoverage).toBe('当前筛选暂无已同步地址，请更换筛选或等待下次同步。');
  });

  it('renders IP-region controls and submits the dedicated generation mode', () => {
    expect(appSource).toContain('ip-region-panel');
    expect(appSource).toContain('/v1/client-context');
    expect(appSource).toContain('params.set("mode", "ip-region")');
    expect(appSource).toContain('ipMatchLevel');
    expect(appSource).toContain('ip-region-result');
    expect(messages.en.generateNearIp).toBeTruthy();
    expect(messages['zh-CN'].generateNearIp).toBeTruthy();
    expect(messages.en.publicIp).toBeTruthy();
    expect(messages['zh-CN'].publicIp).toBeTruthy();
    expect(IP_GENERATION_REQUEST_TIMEOUT_MS).toBeGreaterThan(20_000);
  });

  it('copies the detected public IP into the manual field without generating', () => {
    expect(appSource).toContain('useCurrentIp');
    expect(appSource).toContain('setManualIp(detected.publicIp || "")');
    expect(appSource).toContain('ip: requestedIp');
    expect(appSource).not.toContain('cdn-cgi/trace');
    expect(appSource).not.toContain('setManualIp("");void generate({ipRegion:true,ip:"",strategy:"instant"})');
  });

  it('prefetches only results confirmed by address-pool-v2', () => {
    expect(appSource).toContain('prefetchedResults');
    expect(appSource).toContain('paramsFor(spec, requestId, "instant")');
    expect(appSource).toContain('!payload.data.sourcesTried?.includes("address-pool-v2")');
    expect(appSource).toContain('if (!spec.live && payload.data.sourcesTried?.includes("address-pool-v2"))');
  });

  it('renders coherent profile, network and sandbox-card fields', () => {
    expect(appSource).toContain('extensions.basic.bmi');
    expect(appSource).toContain('extensions.internet.os');
    expect(appSource).toContain('extensions.internet.securityQuestion');
    expect(appSource).toContain('extensions.internet.securityAnswer');
    expect(appSource).toContain('extensions.internet.ipAddress');
    expect(appSource).toContain('extensions.internet.macAddress');
    expect(appSource).toContain('result.card.network');
    expect(appSource).toContain('result.card.number');
    expect(appSource).toContain('result.card.cvc');
    const profileStart = appSource.indexOf('profile-card');
    const phone = appSource.indexOf('id: "phone"');
    const addressFormat = appSource.indexOf('address-format-grid');
    expect(phone).toBeGreaterThan(profileStart);
    expect(phone).toBeGreaterThan(addressFormat);
  });

  it('hides employment and income details for non-working statuses', () => {
    expect(appSource).toContain('hasEmploymentDetails(extensions.employment)');
    expect(appSource).toContain('extensions.finance.incomeRange &&');
  });

  it('renders filters and result rows from each country address schema', () => {
    expect(appSource).toContain('selectedCountry.addressSchema');
    expect(appSource).toContain('addressSchema.filters');
    expect(appSource).toContain('addressSchema.resultFields');
    expect(appSource).toContain('filterFields.includes("region")');
    expect(appSource).toContain('filterFields.includes("city")');
    expect(appSource).toContain('filterFields.includes("postcode")');
  });

  it('provides visible and accessible copy feedback with a DOM fallback', () => {
    expect(appSource).toContain('copy-toast');
    expect(appSource).toContain('aria-live');
    expect(appSource).toContain('aria-atomic');
    expect(appSource).toContain('document.execCommand("copy")');
    expect(appSource).toContain('navigator.clipboard');
    expect(messages.en.copySuccess).toBeTruthy();
    expect(messages.en.copyFailed).toBeTruthy();
    expect(messages['zh-CN'].copySuccess).toBeTruthy();
    expect(messages['zh-CN'].copyFailed).toBeTruthy();
  });
});
