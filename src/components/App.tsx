import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type SyntheticEvent } from 'react';
import { countries, countryByCode, isCountryCode } from '../domain/countries';
import { countryCodeFrom, resolveInitialSelection, type ClientContext, type GenerationMode } from '../domain/client-context';
import { messages } from '../domain/i18n';
import { isChineseNativeCountry, nativeProfileLabel } from '../domain/profile-native-labels';
import type { AddressComponents, AddressFilterField, AddressLanguage, AddressResultField, CountryCode, CountryGroup, GeneratedBundle, Locale, LocationOption, LocationShortcut } from '../domain/types';

interface AppProps { locale: Locale; apiBaseUrl: string }
interface Locations { regions: LocationOption[]; cities: LocationOption[]; postcodes: LocationOption[]; matches: LocationOption[] }
interface LocationMeta { total: number; nextCursor?: string }
interface GenerationOptions {
  countryCode?: CountryCode;
  region?: string;
  regionId?: string;
  city?: string;
  cityId?: string;
  postcode?: string;
  postcodeId?: string;
  mode?: Mode;
  strategy?: 'instant' | 'random';
  ipRegion?: boolean;
  ip?: string;
}
interface IpRegionResult {
  matchLevel?: 'coordinate' | 'city' | 'region' | 'country';
  source?: string;
  precisionLevel?: string;
  targetRegion?: string;
  targetCity?: string;
  distanceKm?: number;
}
interface GenerateResponseData {
  requestId: string;
  mode: Mode | 'ip-region';
  country: CountryCode;
  sourcesTried?: string[];
  filterMatchLevel?: 'exact' | 'nearby' | 'region' | 'country';
  ipMatchLevel?: IpRegionResult['matchLevel'];
  ipRegion?: Omit<IpRegionResult, 'matchLevel'>;
  result: GeneratedBundle;
}
interface GenerationRequestSpec {
  country: CountryCode;
  mode: Mode;
  region: string;
  regionId: string;
  city: string;
  cityId: string;
  postcode: string;
  postcodeId: string;
  ipRegion: boolean;
  ip: string;
  live: boolean;
}
type Mode = GenerationMode;

const emptyLocations: Locations = { regions: [], cities: [], postcodes: [], matches: [] };
const groupOrder: CountryGroup[] = ['north-america', 'europe', 'east-asia', 'southeast-asia', 'south-asia', 'oceania', 'middle-east', 'south-america', 'africa'];
const groupMessage = {
  'north-america': 'northAmerica', europe: 'europe', 'east-asia': 'eastAsia',
  'southeast-asia': 'southeastAsia', 'south-asia': 'southAsia', oceania: 'oceania',
  'middle-east': 'middleEast', 'south-america': 'southAmerica', africa: 'africa'
} as const;
const countrySessionKey = 'address-generator-country';
interface CryptoSource {
  randomUUID?: () => string;
  getRandomValues?: (array: Uint8Array) => Uint8Array;
}

export const GENERATION_REQUEST_TIMEOUT_MS = 20_000;
export const IP_GENERATION_REQUEST_TIMEOUT_MS = 60_000;
export const CLIENT_CONTEXT_REQUEST_TIMEOUT_MS = 12_000;
export const LOCATION_REQUEST_TIMEOUT_MS = 60_000;

export const createRequestId = (source: CryptoSource | undefined = globalThis.crypto as unknown as CryptoSource): string => {
  if (typeof source?.randomUUID === 'function') return source.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof source?.getRandomValues === 'function') source.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
};

export const fetchWithTimeout = async (
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = GENERATION_REQUEST_TIMEOUT_MS,
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<Response> => {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort(init.signal?.reason);
  if (init.signal?.aborted) abortFromCaller();
  else init.signal?.addEventListener('abort', abortFromCaller, { once: true });
  const timer = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await fetchImpl(input, { ...init, signal: controller.signal });
  } catch (reason) {
    if (timedOut) throw new Error('REQUEST_TIMEOUT');
    throw reason;
  } finally {
    globalThis.clearTimeout(timer);
    init.signal?.removeEventListener('abort', abortFromCaller);
  }
};

const randomSeed = () => createRequestId().slice(0, 12);
const sameLocation = (left: string, right: string): boolean => {
  const normalize = (value: string) => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase().replace(/^city of\s+|\s+city$/g, '').trim();
  return normalize(left) === normalize(right);
};
const normalizeLocationSearch = (value: string): string => value
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLocaleLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, '')
  .trim();
const locationSearchForms = (value: string): string[] => {
  const normalized = normalizeLocationSearch(value);
  if (!normalized) return [];
  const simplified = normalized
    .replace(/^cityof/u, '')
    .replace(/(?:specialadministrativeregion|autonomousregion|municipality|prefecture|city|特别行政区|自治区|自治州|地区|市|区|县)$/u, '');
  return simplified && simplified !== normalized ? [normalized, simplified] : [normalized];
};
export const LOCATION_OPTION_RENDER_LIMIT = 200;
export const filterLocationOptions = (options: LocationOption[], query: string): LocationOption[] => {
  const searches = locationSearchForms(query);
  if (!searches.length) return options;
  return options.filter((option) => [option.value, option.label, option.native, option.en, option.zhCN]
    .some((value) => value && locationSearchForms(value)
      .some((candidate) => searches.some((search) => candidate.includes(search)))));
};
type GenerationErrorMessageKey = 'retry' | 'noPoolCoverage' | 'ipNoResult' | 'ipLookupFailed' | 'requestFailed';
export const generationErrorMessageKey = (code: string, ipRegion: boolean): GenerationErrorMessageKey => {
  if (code === 'NO_POOL_COVERAGE') return 'noPoolCoverage';
  if (code === 'IP_REGION_NO_RESULT') return 'ipNoResult';
  if (code.toUpperCase().includes('TIMEOUT')) return 'retry';
  return ipRegion ? 'ipLookupFailed' : 'requestFailed';
};
const extensionValueLabels: Record<string, [string, string]> = {
  secondary: ['Secondary school', '中学'], associate: ['Associate degree', '专科'], bachelor: ["Bachelor's degree", '本科'],
  master: ["Master's degree", '硕士'], doctorate: ['Doctorate', '博士'], employed: ['Employed', '在职'],
  'self-employed': ['Self-employed', '自雇'], student: ['Student', '学生'], 'between-jobs': ['Between jobs', '待业'], retired: ['Retired', '退休'],
  mr: ['Mr.', '先生'], ms: ['Ms.', '女士'], 'full-time': ['Full-time', '全职'], 'part-time': ['Part-time', '兼职'],
  capricorn: ['Capricorn', '摩羯座'], aquarius: ['Aquarius', '水瓶座'], pisces: ['Pisces', '双鱼座'],
  aries: ['Aries', '白羊座'], taurus: ['Taurus', '金牛座'], gemini: ['Gemini', '双子座'],
  cancer: ['Cancer', '巨蟹座'], leo: ['Leo', '狮子座'], virgo: ['Virgo', '处女座'], libra: ['Libra', '天秤座'],
  scorpio: ['Scorpio', '天蝎座'], sagittarius: ['Sagittarius', '射手座'],
  'Customer Service Representative': ['Customer Service Representative', '客户服务代表'],
  'Retail Store Supervisor': ['Retail Store Supervisor', '零售店主管'],
  'Warehouse Coordinator': ['Warehouse Coordinator', '仓储协调员'],
  'Administrative Assistant': ['Administrative Assistant', '行政助理'],
  'Maintenance Technician': ['Maintenance Technician', '维修技术员'],
  'Network Support Specialist': ['Network Support Specialist', '网络支持专员'],
  'Systems Support Technician': ['Systems Support Technician', '系统支持技术员'],
  'Accounting Technician': ['Accounting Technician', '会计技术员'],
  'Payroll Specialist': ['Payroll Specialist', '薪资专员'],
  Paralegal: ['Paralegal', '律师助理'],
  'Legal Operations Specialist': ['Legal Operations Specialist', '法务运营专员'],
  'Software Engineer': ['Software Engineer', '软件工程师'],
  'Civil Engineer': ['Civil Engineer', '土木工程师'],
  'Quality Engineer': ['Quality Engineer', '质量工程师'],
  'Financial Analyst': ['Financial Analyst', '财务分析师'],
  'Management Accountant': ['Management Accountant', '管理会计师'],
  'Human Resources Specialist': ['Human Resources Specialist', '人力资源专员'],
  'Talent Acquisition Specialist': ['Talent Acquisition Specialist', '人才招聘专员'],
  'Marketing Specialist': ['Marketing Specialist', '市场营销专员'],
  'Communications Specialist': ['Communications Specialist', '传播专员'],
  'Product Manager': ['Product Manager', '产品经理'],
  'Business Intelligence Manager': ['Business Intelligence Manager', '商业智能经理'],
  'Data Scientist': ['Data Scientist', '数据科学家'],
  'Clinical Research Coordinator': ['Clinical Research Coordinator', '临床研究协调员'],
  'Urban Planner': ['Urban Planner', '城市规划师'],
  'Research Scientist': ['Research Scientist', '研究科学家'],
  'University Lecturer': ['University Lecturer', '大学讲师'],
  'Clinical Psychologist': ['Clinical Psychologist', '临床心理学家'],
  'Customer Operations': ['Customer Operations', '客户运营'], Operations: ['Operations', '运营'],
  'Information Technology': ['Information Technology', '信息技术'], Finance: ['Finance', '财务'], Legal: ['Legal', '法务'],
  Engineering: ['Engineering', '工程'], 'People Operations': ['People Operations', '人力资源运营'], Marketing: ['Marketing', '市场营销'],
  Product: ['Product', '产品'], Research: ['Research', '研究'], Owner: ['Owner', '负责人'],
  'What was the name of your first pet?': ['What was the name of your first pet?', '你的第一只宠物叫什么名字？'],
  'What was your childhood nickname?': ['What was your childhood nickname?', '你小时候的昵称是什么？'],
  'In what city did your parents meet?': ['In what city did your parents meet?', '你的父母在哪座城市相识？'],
  "What was your favorite teacher's surname?": ["What was your favorite teacher's surname?", '你最喜欢的老师姓什么？'],
  'Checking Account': ['Checking Account', '支票账户'], 'Everyday Account': ['Everyday Account', '日常账户'], 'Current Account': ['Current Account', '活期账户'],
  'Savings Account': ['Savings Account', '储蓄账户']
};

export const localizedExtensionValue = (value: string, locale: Locale): string => {
  const languageIndex = locale === 'zh-CN' ? 1 : 0;
  const direct = extensionValueLabels[value];
  if (direct) return direct[languageIndex];
  if (locale !== 'zh-CN') return value;
  if (value.startsWith('Independent ')) {
    const occupation = value.slice('Independent '.length);
    return `独立${extensionValueLabels[occupation]?.[1] || occupation}`;
  }
  const accountType = ['Checking Account', 'Everyday Account', 'Current Account', 'Savings Account'].find((type) =>
    value.endsWith(` · ${type}`)
  );
  return accountType
    ? `${value.slice(0, -accountType.length)}${extensionValueLabels[accountType][1]}`
    : value;
};

// Resolves a profile data value to the chosen display language. "native" prefers the
// country's own language dictionary, then Chinese for CN-family countries, then English.
export const profileValue = (value: string, language: AddressLanguage, countryCode: CountryCode): string => {
  if (language === 'zh-CN') return localizedExtensionValue(value, 'zh-CN');
  if (language === 'en') return localizedExtensionValue(value, 'en');
  const native = nativeProfileLabel(value, countryCode);
  if (native) return native;
  return localizedExtensionValue(value, isChineseNativeCountry(countryCode) ? 'zh-CN' : 'en');
};

const hasEmploymentDetails = (
  employment: GeneratedBundle['extensions']['employment']
): employment is Extract<GeneratedBundle['extensions']['employment'], { employmentStatus: 'employed' | 'self-employed' }> =>
  employment.employmentStatus === 'employed' || employment.employmentStatus === 'self-employed';

const streetValue = (countryCode: CountryCode, components: AddressComponents): string => {
  if (countryCode === 'CN') {
    const suffix = /^[0-9][0-9-]*$/.test(components.houseNumber) ? '号' : '';
    return [`${components.street}${components.houseNumber}${suffix}`, components.unit].filter(Boolean).join('');
  }
  if (countryCode === 'KR') return [[components.street, components.houseNumber].filter(Boolean).join(' '), components.unit].filter(Boolean).join(' ');
  const eastAsian = ['JP', 'HK', 'TW'].includes(countryCode);
  return eastAsian
    ? [components.street, components.houseNumber, components.unit].filter(Boolean).join('')
    : [[components.houseNumber, components.street].filter(Boolean).join(' '), components.unit].filter(Boolean).join(' ');
};

export default function App({ locale, apiBaseUrl }: AppProps) {
  const t = messages[locale];
  const endpoint = apiBaseUrl.replace(/\/$/, '');
  const [mode, setMode] = useState<Mode>('address');
  const [countryCode, setCountryCode] = useState<CountryCode>('US');
  const [region, setRegion] = useState('');
  const [regionId, setRegionId] = useState('');
  const [city, setCity] = useState('');
  const [cityId, setCityId] = useState('');
  const [postcode, setPostcode] = useState('');
  const [postcodeId, setPostcodeId] = useState('');
  const [locations, setLocations] = useState<Locations>(emptyLocations);
  const [locationMeta, setLocationMeta] = useState<Record<'region' | 'city' | 'postcode', LocationMeta>>({ region: { total: 0 }, city: { total: 0 }, postcode: { total: 0 } });
  const [result, setResult] = useState<GeneratedBundle | null>(null);
  const [addressLanguage, setAddressLanguage] = useState<AddressLanguage>('native');
  const [sectionLanguages, setSectionLanguages] = useState<Record<'profile' | 'employment' | 'finance' | 'internet', AddressLanguage>>({
    profile: 'native', employment: 'native', finance: 'native', internet: 'native'
  });
  const setSectionLanguage = (section: 'profile' | 'employment' | 'finance' | 'internet', language: AddressLanguage) =>
    setSectionLanguages((current) => ({ ...current, [section]: language }));
  const [loading, setLoading] = useState(false);
  const [ipLoading, setIpLoading] = useState(false);
  const [error, setError] = useState('');
  const [locationErrors, setLocationErrors] = useState<Partial<Record<'region' | 'city' | 'postcode', string>>>({});
  const [manualIp, setManualIp] = useState('');
  const [liveApi, setLiveApi] = useState(false);
  const liveApiRef = useRef(false);
  const [ipContext, setIpContext] = useState<ClientContext | null>(null);
  const [ipRegionResult, setIpRegionResult] = useState<IpRegionResult | null>(null);
  const [copied, setCopied] = useState('');
  const [fallbackNotice, setFallbackNotice] = useState('');
  const [copyToast, setCopyToast] = useState<{ kind: 'success' | 'error'; message: string } | null>(null);
  const [residentialCountries, setResidentialCountries] = useState<Set<CountryCode>>(new Set(countries.filter((country) => country.residentialCapability).map((country) => country.code)));
  const activeRequest = useRef<{ requestId: string; country: CountryCode; mode: Mode } | null>(null);
  const selectionRef = useRef<{ country: CountryCode; mode: Mode }>({ country: 'US', mode: 'address' });
  const generationController = useRef<AbortController | null>(null);
  const locationControllers = useRef<Partial<Record<'region' | 'city' | 'postcode', AbortController>>>({});
  const locationQueries = useRef<Record<'region' | 'city' | 'postcode', string>>({ region: '', city: '', postcode: '' });
  const copyToastTimer = useRef<number | undefined>(undefined);
  const prefetchedResults = useRef<Map<string, GeneratedBundle[]>>(new Map());
  const prefetchController = useRef<AbortController | null>(null);
  const prefetchingKey = useRef('');
  const userNavigated = useRef(false);

  const residential = mode === 'residential';
  const selectedCountry = countryByCode.get(countryCode) || countries[0];
  const addressSchema = selectedCountry.addressSchema;
  const filterFields: AddressFilterField[] = addressSchema.filters;
  const visibleCountries = useMemo(() => countries.filter((country) => mode === 'address' || residentialCountries.has(country.code)), [mode, residentialCountries]);
  const countryGroups = useMemo(() => groupOrder.map((group) => ({ group, countries: visibleCountries.filter((country) => country.group === group) })).filter((item) => item.countries.length), [visibleCountries]);

  const updateUrl = (nextCountry: CountryCode, nextMode: Mode, action: 'push' | 'replace') => {
    const url = new URL(window.location.href);
    url.searchParams.set('country', nextCountry.toLowerCase());
    url.searchParams.set('mode', nextMode);
    window.history[action === 'push' ? 'pushState' : 'replaceState']({}, '', url);
  };

  const loadClientContext = async (): Promise<ClientContext> => {
    const response = await fetchWithTimeout(`${endpoint}/v1/client-context`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store'
    }, CLIENT_CONTEXT_REQUEST_TIMEOUT_MS);
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
      throw new Error('CLIENT_CONTEXT_UNAVAILABLE');
    }
    const payload = await response.json() as { data?: ClientContext };
    if (!payload.data) throw new Error('CLIENT_CONTEXT_UNAVAILABLE');
    return payload.data;
  };

  const useCurrentIp = async () => {
    setIpLoading(true);
    setError('');
    try {
      const detected = await loadClientContext();
      setIpContext(detected);
      setManualIp(detected.publicIp || '');
    } catch {
      setManualIp('');
      setError(t.ipLookupFailed);
    } finally {
      setIpLoading(false);
    }
  };

  const queueKeyFor = (spec: GenerationRequestSpec): string => [
    spec.country, spec.mode, spec.regionId || spec.region, spec.cityId || spec.city,
    spec.postcodeId || spec.postcode, spec.live ? 'live' : 'pool'
  ].join(':');

  const paramsFor = (spec: GenerationRequestSpec, requestId: string, strategy: 'instant' | 'random') => {
    const params = new URLSearchParams({
      requestId, country: spec.country, residential: String(spec.mode === 'residential'),
      seed: randomSeed(), strategy, live: String(spec.live)
    });
    if (spec.ipRegion) params.set('mode', 'ip-region');
    if (spec.ip.trim()) params.set('ip', spec.ip.trim());
    if (spec.region) params.set('region', spec.region);
    if (spec.regionId) params.set('regionId', spec.regionId);
    if (spec.city) params.set('city', spec.city);
    if (spec.cityId) params.set('cityId', spec.cityId);
    if (spec.postcode) params.set('postcode', spec.postcode);
    if (spec.postcodeId) params.set('postcodeId', spec.postcodeId);
    return params;
  };

  const fillPrefetchQueue = async (spec: GenerationRequestSpec, key: string) => {
    if (prefetchingKey.current === key) return;
    prefetchController.current?.abort();
    const controller = new AbortController();
    prefetchController.current = controller;
    prefetchingKey.current = key;
    if (!prefetchedResults.current.has(key)) prefetchedResults.current.clear();
    const existing = prefetchedResults.current.get(key) || [];
    const needed = Math.max(0, 5 - existing.length);
    try {
      const responses = await Promise.allSettled(Array.from({ length: needed }, async () => {
        const requestId = createRequestId();
        const response = await fetchWithTimeout(`${endpoint}/v1/generate?${paramsFor(spec, requestId, 'instant')}`, { signal: controller.signal });
        if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return undefined;
        const payload = await response.json() as { data?: GenerateResponseData };
        if (payload.data?.requestId !== requestId || !payload.data.sourcesTried?.includes('address-pool-v2')) return undefined;
        return payload.data.result;
      }));
      if (controller.signal.aborted) return;
      const queued = [...existing];
      const ids = new Set(queued.map((item) => item.address.id));
      for (const response of responses) {
        if (response.status !== 'fulfilled' || !response.value || ids.has(response.value.address.id)) continue;
        ids.add(response.value.address.id);
        queued.push(response.value);
      }
      prefetchedResults.current.set(key, queued.slice(0, 5));
    } finally {
      if (prefetchController.current === controller) {
        prefetchController.current = null;
        prefetchingKey.current = '';
      }
    }
  };

  const clearPrefetchQueue = () => {
    prefetchController.current?.abort();
    prefetchController.current = null;
    prefetchedResults.current.clear();
    prefetchingKey.current = '';
  };

  const loadOptions = async (
    field: 'region' | 'city' | 'postcode',
    query = '',
    overrides: { country?: CountryCode; residential?: boolean; region?: string; regionId?: string; cityId?: string; cursor?: string; append?: boolean } = {}
  ) => {
    locationControllers.current[field]?.abort();
    const controller = new AbortController();
    locationControllers.current[field] = controller;
    locationQueries.current[field] = query;
    const params = new URLSearchParams({
      country: overrides.country || countryCode,
      residential: String(overrides.residential ?? residential),
      field,
      schema: '6',
      limit: field === 'postcode' ? '100' : '20000'
    });
    if (field !== 'city' && query.trim()) params.set('q', query.trim());
    const parentRegion = overrides.region ?? region;
    if (parentRegion) params.set('region', parentRegion);
    const parentRegionId = overrides.regionId ?? regionId;
    if (parentRegionId) params.set('regionId', parentRegionId);
    const parentCityId = overrides.cityId ?? cityId;
    if (parentCityId) params.set('cityId', parentCityId);
    if (field !== 'city' && overrides.cursor) params.set('cursor', overrides.cursor);
    try {
      const response = await fetchWithTimeout(`${endpoint}/v1/locations/search?${params}`, { signal: controller.signal }, LOCATION_REQUEST_TIMEOUT_MS);
      if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error('API response is not JSON');
      const payload = await response.json() as { data?: Locations & LocationMeta };
      if (locationControllers.current[field] !== controller || locationQueries.current[field] !== query) return;
      const values = field === 'region' ? payload.data?.regions : field === 'city' ? payload.data?.cities : payload.data?.postcodes;
      const key = field === 'region' ? 'regions' : field === 'city' ? 'cities' : 'postcodes';
      setLocations((current) => ({ ...current, [key]: overrides.append ? [...current[key], ...(values || [])] : values || [] }));
      setLocationMeta((current) => ({
        ...current,
        [field]: {
          total: payload.data?.total ?? values?.length ?? 0,
          nextCursor: field === 'city' ? undefined : payload.data?.nextCursor
        }
      }));
      setLocationErrors((current) => ({ ...current, [field]: '' }));
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === 'AbortError') return;
      if (locationControllers.current[field] !== controller || locationQueries.current[field] !== query) return;
      setLocations((current) => ({ ...current, [`${field === 'region' ? 'regions' : field === 'city' ? 'cities' : 'postcodes'}`]: [] }));
      setLocationErrors((current) => ({ ...current, [field]: t.locationLoadFailed }));
    }
  };

  const resetFor = (nextCountry: CountryCode, nextMode: Mode, history: 'push' | 'replace' | 'none' = 'replace') => {
    generationController.current?.abort();
    clearPrefetchQueue();
    activeRequest.current = null;
    selectionRef.current = { country: nextCountry, mode: nextMode };
    setCountryCode(nextCountry); setMode(nextMode); setRegion(''); setRegionId(''); setCity(''); setCityId(''); setPostcode(''); setPostcodeId('');
    setLocations(emptyLocations); setLocationMeta({ region: { total: 0 }, city: { total: 0 }, postcode: { total: 0 } }); setAddressLanguage('native'); setError(''); setLocationErrors({}); setLoading(false); setFallbackNotice('');
    setResult(null); setIpRegionResult(null);
    if (history !== 'none') updateUrl(nextCountry, nextMode, history);
    window.setTimeout(() => void generate({
      countryCode: nextCountry,
      region: '', regionId: '', city: '', cityId: '', postcode: '', postcodeId: '',
      mode: nextMode,
      strategy: 'instant'
    }), 0);
  };

  useEffect(() => {
    let disposed = false;
    const bootstrap = async () => {
      const params = new URLSearchParams(window.location.search);
      const urlCountry = countryCodeFrom(params.get('country'));
      const sessionCountry = countryCodeFrom(window.sessionStorage.getItem(countrySessionKey));
      const initialMode: Mode = params.get('mode') === 'residential' ? 'residential' : 'address';
      let ipCountry: CountryCode | undefined;
      try {
        const detected = await loadClientContext();
        if (!disposed) setIpContext(detected);
        if (detected.supported) ipCountry = countryCodeFrom(detected.country);
      } catch {}
      if (disposed || userNavigated.current) return;
      const selection = resolveInitialSelection({ urlCountry, sessionCountry, ipCountry, mode: initialMode });
      const initialCountry = selection.mode === 'residential' && !countryByCode.get(selection.country)?.residentialCapability ? 'US' : selection.country;
      resetFor(initialCountry, selection.mode, 'replace');
    };
    const restoreHistory = () => {
      userNavigated.current = true;
      const params = new URLSearchParams(window.location.search);
      const code = params.get('country')?.toUpperCase();
      const nextMode: Mode = params.get('mode') === 'residential' ? 'residential' : 'address';
      let nextCountry = code && isCountryCode(code) ? code : 'US';
      if (nextMode === 'residential' && !countryByCode.get(nextCountry)?.residentialCapability) nextCountry = 'US';
      window.sessionStorage.setItem(countrySessionKey, nextCountry);
      resetFor(nextCountry, nextMode, 'replace');
    };
    window.addEventListener('popstate', restoreHistory);
    void bootstrap();
    return () => {
      disposed = true;
      window.removeEventListener('popstate', restoreHistory);
    };
  }, []);

  const loadResidentialCountries = async () => {
    try {
      const response = await fetch(`${endpoint}/v1/countries`);
      if (!response.ok) return;
      const payload = await response.json() as { data?: Array<{ code: CountryCode; residentialAvailable?: boolean }> };
      const available = new Set((payload.data || []).filter((country) => country.residentialAvailable).map((country) => country.code));
      if (available.size) setResidentialCountries(available);
    } catch {}
  };

  useEffect(() => { void loadResidentialCountries(); }, []);
  useEffect(() => () => {
    window.clearTimeout(copyToastTimer.current);
    prefetchController.current?.abort();
  }, []);
  useEffect(() => {
    const pageTitle = locale === 'zh-CN' ? `${selectedCountry.name[locale]}地址生成器` : `${selectedCountry.name[locale]} Address Generator`;
    document.title = `${pageTitle} | ${t.brand}`;
  }, [countryCode, locale]);

  useEffect(() => {
    void loadOptions('region');
    void loadOptions('city');
    return () => Object.values(locationControllers.current).forEach((controller) => controller?.abort());
  }, [countryCode, mode]);

  const changeCountry = (nextCountry: CountryCode) => {
    if (nextCountry === countryCode) return;
    userNavigated.current = true;
    window.sessionStorage.setItem(countrySessionKey, nextCountry);
    resetFor(nextCountry, mode, 'push');
  };
  const changeMode = (nextMode: Mode) => {
    if (nextMode === mode) return;
    const nextCountry = nextMode === 'residential' && !residentialCountries.has(countryCode)
      ? [...residentialCountries][0] || 'US'
      : countryCode;
    userNavigated.current = true;
    window.sessionStorage.setItem(countrySessionKey, nextCountry);
    resetFor(nextCountry, nextMode, 'push');
  };

  const generate = async (overrides: GenerationOptions = {}) => {
    const context = {
      requestId: createRequestId(), country: overrides.countryCode ?? countryCode, mode: overrides.mode ?? mode
    };
    const nextRegion = overrides.region ?? region;
    const nextRegionId = overrides.regionId ?? regionId;
    const nextCity = overrides.city ?? city;
    const nextCityId = overrides.cityId ?? cityId;
    const nextPostcode = overrides.postcode ?? postcode;
    const nextPostcodeId = overrides.postcodeId ?? postcodeId;
    const strategy = overrides.strategy || 'random';
    const requestedIp = overrides.ip?.trim() || '';
    const spec: GenerationRequestSpec = {
      country: context.country,
      mode: context.mode,
      region: nextRegion,
      regionId: nextRegionId,
      city: nextCity,
      cityId: nextCityId,
      postcode: nextPostcode,
      postcodeId: nextPostcodeId,
      ipRegion: Boolean(overrides.ipRegion),
      ip: requestedIp,
      live: liveApiRef.current
    };
    const queueKey = queueKeyFor(spec);
    if (spec.ipRegion || spec.live) clearPrefetchQueue();
    if (!spec.ipRegion && !spec.live && strategy === 'random' && selectionRef.current.country === spec.country && selectionRef.current.mode === spec.mode) {
      const queue = prefetchedResults.current.get(queueKey);
      const queued = queue?.shift();
      if (queued) {
        generationController.current?.abort(); activeRequest.current = null;
        setResult(queued); setAddressLanguage('native'); setIpRegionResult(null); setError(''); setFallbackNotice(''); setLoading(false);
        void fillPrefetchQueue(spec, queueKey);
        return;
      }
    }
    generationController.current?.abort();
    const controller = new AbortController();
    generationController.current = controller;
    activeRequest.current = context;
    setLoading(true); setError('');
    try {
      const params = paramsFor(spec, context.requestId, strategy);
      const response = await fetchWithTimeout(
        `${endpoint}/v1/generate?${params}`,
        { signal: controller.signal },
        spec.ipRegion ? IP_GENERATION_REQUEST_TIMEOUT_MS : GENERATION_REQUEST_TIMEOUT_MS
      );
      if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('API response is not JSON');
      const payload = await response.json() as {
        data?: GenerateResponseData;
        error?: { code?: string }
      };
      const current = activeRequest.current;
      if (!current || current.requestId !== context.requestId || current.country !== context.country || current.mode !== context.mode) return;
      if (!response.ok || !payload.data) throw new Error(payload.error?.code || 'API_ERROR');
      const expectedMode = overrides.ipRegion ? 'ip-region' : context.mode;
      if (payload.data.requestId !== context.requestId || payload.data.mode !== expectedMode) return;
      if (!overrides.ipRegion && payload.data.country !== context.country) return;
      if (!overrides.ipRegion && selectionRef.current.country !== context.country) return;
      if (overrides.ipRegion) {
        const nextCountry = payload.data.country;
        userNavigated.current = true;
        selectionRef.current = { country: nextCountry, mode: context.mode };
        window.sessionStorage.setItem(countrySessionKey, nextCountry);
        setCountryCode(nextCountry); setRegion(''); setRegionId(''); setCity(''); setCityId(''); setPostcode(''); setPostcodeId('');
        setLocations(emptyLocations); setLocationMeta({ region: { total: 0 }, city: { total: 0 }, postcode: { total: 0 } });
        updateUrl(nextCountry, context.mode, 'replace');
        setIpRegionResult({ matchLevel: payload.data.ipMatchLevel, ...payload.data.ipRegion });
        void loadOptions('region', '', { country: nextCountry, residential: context.mode === 'residential', region: '', regionId: '', cityId: '' });
        void loadOptions('city', '', { country: nextCountry, residential: context.mode === 'residential', region: '', regionId: '', cityId: '' });
      } else {
        setIpRegionResult(null);
        const level = payload.data.filterMatchLevel;
        setFallbackNotice(level === 'nearby' ? t.fallbackNearby : level === 'region' ? t.fallbackRegion : level === 'country' ? t.fallbackCountry : '');
        if (!spec.live && payload.data.sourcesTried?.includes('address-pool-v2')) void fillPrefetchQueue(spec, queueKey);
      }
      setResult(payload.data.result); setAddressLanguage('native');
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === 'AbortError') return;
      if (activeRequest.current?.requestId !== context.requestId) return;
      if (!overrides.ipRegion) setResult(null);
      const errorCode = reason instanceof Error ? reason.message : 'API_ERROR';
      setAddressLanguage('native'); setError(t[generationErrorMessageKey(errorCode, Boolean(overrides.ipRegion))]);
    } finally {
      if (activeRequest.current?.requestId === context.requestId) setLoading(false);
    }
  };

  const generateForIp = () => {
    setError('');
    void generate({ ipRegion: true, ip: manualIp, strategy: 'instant' });
  };

  const submit = (event: SyntheticEvent<HTMLFormElement, SubmitEvent>) => { event.preventDefault(); void generate(); };
  const showCopyToast = (kind: 'success' | 'error') => {
    window.clearTimeout(copyToastTimer.current);
    setCopyToast({ kind, message: kind === 'success' ? t.copySuccess : t.copyFailed });
    copyToastTimer.current = window.setTimeout(() => { setCopyToast(null); setCopied(''); }, 2200);
  };
  const fallbackCopy = (value: string): boolean => {
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.readOnly = true;
    textarea.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0';
    document.body.appendChild(textarea);
    try {
      textarea.select();
      textarea.setSelectionRange(0, value.length);
      return (document as unknown as { execCommand(command: string): boolean }).execCommand('copy');
    } finally {
      textarea.remove();
    }
  };
  const copy = async (key: string, value: string) => {
    if (!value.trim()) { setCopied(''); showCopyToast('error'); return; }
    try {
      let succeeded = false;
      if (navigator.clipboard?.writeText) {
        try { await navigator.clipboard.writeText(value); succeeded = true; } catch {}
      }
      if (!succeeded) succeeded = fallbackCopy(value);
      if (!succeeded) throw new Error('COPY_FAILED');
      setCopied(key);
      showCopyToast('success');
    } catch {
      setCopied('');
      showCopyToast('error');
    }
  };
  const applyShortcut = (shortcut: LocationShortcut) => {
    clearPrefetchQueue();
    const overrides: GenerationOptions = {};
    if (shortcut.type === 'region') {
      setRegion(shortcut.value); setRegionId(''); setCity(''); setCityId(''); setPostcode(''); setPostcodeId('');
      Object.assign(overrides, { region: shortcut.value, regionId: '', city: '', cityId: '', postcode: '', postcodeId: '' });
      void loadOptions('city', '', { region: shortcut.value, regionId: '' });
    }
    if (shortcut.type === 'city') {
      setCity(shortcut.value); setCityId(''); setPostcode(''); setPostcodeId('');
      Object.assign(overrides, { city: shortcut.value, cityId: '', postcode: '', postcodeId: '' });
    }
    if (shortcut.type === 'postcode') {
      setPostcode(shortcut.value); setPostcodeId('');
      Object.assign(overrides, { postcode: shortcut.value, postcodeId: '' });
    }
    void generate(overrides);
  };

  const localeUrl = `/${locale === 'en' ? 'zh-CN' : 'en'}/?country=${countryCode.toLowerCase()}&mode=${mode}`;
  const presentation = result?.addressFormats[addressLanguage];
  const components = result?.address.componentVariants[addressLanguage];
  const source = result?.address.evidence[0];
  const fullCopy = result && presentation ? [presentation.singleLine, result.profile.fullName, result.profile.phone, result.profile.email].join('\n') : '';
  const rowProps = { copy, copied, copyLabel: t.copy };
  const resultFields = addressSchema.resultFields.map(({ field, label }) => ({ field, label: label[locale] }));
  const resultValues: Record<AddressResultField, string | undefined> = {
    country: selectedCountry.name[locale],
    street: result && components ? streetValue(result.address.countryCode, components) : undefined,
    completeAddress: presentation?.singleLine,
    locality: components?.postalLocality || components?.locality,
    district: components?.dependentLocality || components?.district,
    admin1: components?.admin1,
    admin1Code: components?.admin1Code,
    postcode: components?.postcode
  };
  const extensions = result?.extensions;
  const locationError = Object.values(locationErrors).find(Boolean) || '';
  const ipLocation = ipContext
    ? [ipContext.country, ipContext.regionCode || ipContext.region, ipContext.city].filter(Boolean).join(' · ')
    : '';
  const ipMatchLabel = ipRegionResult?.matchLevel === 'coordinate' ? t.coordinateMatch
    : ipRegionResult?.matchLevel === 'city' ? t.cityMatch
      : ipRegionResult?.matchLevel === 'region' ? t.regionMatch
        : ipRegionResult?.matchLevel === 'country' ? t.countryMatch : '';
  const currency = (amount: number, code: string) => new Intl.NumberFormat(locale, { style: 'currency', currency: code, maximumFractionDigits: 0 }).format(amount);

  return <div className="site-shell">
    <header className="topbar">
      <a className="logo" href={`/${locale}/`}><b>{t.brand}</b></a>
      <nav className="top-links">
        <a href={`/${locale}/api/`}>{t.apiDocs}</a>
        <a className="language" href={localeUrl}>{t.language}</a>
        <a className="github-link" href="https://github.com/daimon3332/address" target="_blank" rel="noopener noreferrer" aria-label="GitHub">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 .7a11.5 11.5 0 0 0-3.64 22.4c.58.1.79-.25.79-.56v-2.23c-3.23.7-3.91-1.37-3.91-1.37-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.71.08-.71 1.17.08 1.78 1.2 1.78 1.2 1.04 1.78 2.72 1.27 3.39.97.1-.75.4-1.27.74-1.56-2.58-.3-5.29-1.29-5.29-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.47.11-3.06 0 0 .97-.31 3.16 1.18A10.9 10.9 0 0 1 12 6.08c.98 0 1.95.13 2.86.39 2.2-1.49 3.16-1.18 3.16-1.18.63 1.59.23 2.77.11 3.06.74.81 1.19 1.84 1.19 3.1 0 4.42-2.72 5.39-5.3 5.68.42.36.79 1.07.79 2.15v3.26c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .7Z" /></svg>
        </a>
      </nav>
    </header>

    <main className="container">
      <div className="mode-tabs" role="tablist">
        <button type="button" className={mode === 'address' ? 'active' : ''} onClick={() => changeMode('address')}><b>{t.normalMode}</b><span>{t.modeHintNormal}</span></button>
        <button type="button" className={mode === 'residential' ? 'active' : ''} onClick={() => changeMode('residential')}><b>{t.residentialMode}</b><span>{t.modeHintResidential}</span></button>
      </div>

      <section className="country-browser" aria-label={t.countryRegion}>
        {countryGroups.map(({ group, countries: items }) => <div className="country-group" key={group}>
          <h2>{t[groupMessage[group]]}</h2><div>{items.map((country) => <button type="button" key={country.code} aria-current={country.code === countryCode ? 'page' : undefined} className={country.code === countryCode ? 'active' : ''} onClick={() => changeCountry(country.code)}><img className="country-flag" src={`https://flagcdn.com/24x18/${country.code.toLowerCase()}.png`} width="24" height="18" alt=""/>{country.name[locale]}</button>)}</div>
        </div>)}
      </section>

      <div className="workspace-grid">
        <div className="content-column">
          <section className="ip-region-panel panel">
            <div className="ip-region-heading"><h2>{t.ipRegionTitle}</h2><div>{ipContext?.publicIp && <span><b>{t.publicIp}</b>{ipContext.publicIp}</span>}{ipLocation && <span><b>{t.detectedRegion}</b>{ipLocation}</span>}</div></div>
            <div className="ip-region-controls">
              <button type="button" onClick={() => void useCurrentIp()} disabled={loading || ipLoading}>{t.currentIp}</button>
              <input name="ip" aria-label={t.manualIp} value={manualIp} onChange={(event) => setManualIp(event.target.value)} placeholder={t.manualIp} inputMode="text" autoComplete="off"/>
              <button type="button" onClick={generateForIp} disabled={loading || ipLoading || !manualIp.trim()}>{t.generateNearIp}</button>
            </div>
            {ipRegionResult && <div className="ip-region-result"><span><b>{t.matchLevel}</b>{ipMatchLabel}</span><span>{[ipRegionResult.targetRegion, ipRegionResult.targetCity].filter(Boolean).join(' · ')}</span>{ipRegionResult.distanceKm !== undefined && <span>{ipRegionResult.distanceKm.toFixed(1)} km</span>}</div>}
          </section>
          <section className="generator-card panel">
            <header className="generator-heading"><div><span>{mode === 'residential' ? t.residentialMode : t.normalMode}</span><h1>{locale === 'zh-CN' ? `${selectedCountry.name[locale]}地址生成器` : `${selectedCountry.name[locale]} Address Generator`}</h1></div></header>
            <form className={`filter-grid filters-${filterFields.length}`} onSubmit={submit}>
              {filterFields.includes('region') && <Combobox label={selectedCountry.searchLabels.region[locale]} value={region} options={locations.regions} placeholder={t.allRegions} total={locationMeta.region.total} hasMore={Boolean(locationMeta.region.nextCursor)} onLoadMore={() => loadOptions('region', locationQueries.current.region, { cursor: locationMeta.region.nextCursor, append: true })} onSearch={(query) => loadOptions('region', query)} onChange={(value, option) => {
                clearPrefetchQueue();
                setRegion(value); setRegionId(option.id || ''); setCity(''); setCityId(''); setPostcode(''); setPostcodeId('');
                void loadOptions('city', '', { region: value, regionId: option.id || '' });
              }}/>}
              {filterFields.includes('city') && <Combobox label={selectedCountry.searchLabels.city[locale]} value={city} options={locations.cities} placeholder={t.allCities} total={locationMeta.city.total} clientFilter onChange={(value, option) => {
                clearPrefetchQueue();
                setCity(value); setCityId(option.id || ''); setPostcode(''); setPostcodeId('');
                if (value && option.regionId && option.regionValue) { setRegion(option.regionValue); setRegionId(option.regionId); }
                if (filterFields.includes('postcode')) void loadOptions('postcode', '', { regionId: option.regionId || regionId, cityId: option.id || '' });
              }}/>}
              {filterFields.includes('postcode') && <Combobox label={selectedCountry.searchLabels.postcode[locale]} value={postcode} options={locations.postcodes} placeholder={t.allPostcodes} total={locationMeta.postcode.total} hasMore={Boolean(locationMeta.postcode.nextCursor)} onLoadMore={() => loadOptions('postcode', locationQueries.current.postcode, { cursor: locationMeta.postcode.nextCursor, append: true })} onSearch={(query) => loadOptions('postcode', query)} onChange={(value, option) => {
                clearPrefetchQueue();
                setPostcode(value); setPostcodeId(option.id || '');
                if (value && option.parentId && option.parentValue) { setCity(option.parentValue); setCityId(option.parentId); }
                if (value && option.regionId && option.regionValue) { setRegion(option.regionValue); setRegionId(option.regionId); }
              }}/>}
              <button className="generate-button" disabled={loading} type="submit">{loading ? t.generating : t.generate}</button>
            </form>
            <label className="live-api-toggle"><input type="checkbox" checked={liveApi} onChange={(event) => { liveApiRef.current = event.target.checked; setLiveApi(event.target.checked); }}/><span><b>{t.liveApiLabel}</b>{t.liveApiHint}</span></label>
            {(error || locationError) && <div className="compact-error" role="alert">{error || locationError}</div>}
            {!error && !locationError && fallbackNotice && <div className="compact-notice" role="status">{fallbackNotice}</div>}
          </section>

          {result && presentation && components && <>
            <section className="address-card panel">
              <header className="section-heading"><h2>{t.address}</h2><button type="button" className="text-button" onClick={() => void copy('all', fullCopy)}>{copied === 'all' ? t.copied : t.copyAll}</button></header>
              <div className="language-tabs" role="tablist">{([['native', t.originalAddress], ['en', t.englishAddress], ['zh-CN', t.chineseAddress]] as Array<[AddressLanguage, string]>).map(([language, label]) => <button type="button" role="tab" aria-selected={addressLanguage === language} className={addressLanguage === language ? 'active' : ''} key={language} onClick={() => setAddressLanguage(language)}>{label}</button>)}</div>
              <div className="address-table">
                {resultFields.map(({ field, label }) => {
                  const value = resultValues[field];
                  return value?.trim() ? <ResultRow key={field} id={field} label={label} value={value} {...rowProps}/> : null;
                })}
              </div>
              <div className="address-format-grid">
                <AddressBlock title={t.standardAddress} copyLabel={copied === 'postal' ? t.copied : t.copy} onCopy={() => void copy('postal', presentation.postalLines.join('\n'))}><address>{presentation.postalLines.map((line, index) => <span key={`${line}-${index}`}>{line}</span>)}</address></AddressBlock>
                <AddressBlock title={t.singleLine} copyLabel={copied === 'single' ? t.copied : t.copy} onCopy={() => void copy('single', presentation.singleLine)}><p>{presentation.singleLine}</p></AddressBlock>
              </div>
              <div className="address-meta"><span><b>{t.propertyType}</b>{result.address.propertyType === 'apartment' ? t.apartment : result.address.propertyType === 'residential' ? t.residential : t.unknown}</span>{result.generatedUnit?.provenance === 'synthetic' && <span><b>{t.unitSource}</b>{t.syntheticUnit}</span>}{source && <span><b>{t.source}</b><a href={source.sourceUrl} target="_blank" rel="noreferrer">{source.sourceName}</a></span>}{source?.sourceLicense && <span><b>{t.license}</b>{source.sourceLicenseUrl ? <a href={source.sourceLicenseUrl} target="_blank" rel="noreferrer">{source.sourceLicense}</a> : source.sourceLicense}</span>}</div>
            </section>

            <div className="details-grid">
              <section className="profile-card panel"><header className="section-heading"><h2>{t.basicProfile}</h2><SectionLanguageTabs value={sectionLanguages.profile} onChange={(language) => setSectionLanguage('profile', language)} labels={[t.originalAddress, t.englishAddress, t.chineseAddress]}/></header><ResultRow id="name" label={t.fullName} value={result.profile.fullName} {...rowProps}/><ResultRow id="gender" label={t.gender} value={t[result.profile.gender]} {...rowProps}/><ResultRow id="birth" label={t.birthDate} value={result.profile.dateOfBirth} {...rowProps}/><ResultRow id="phone" label={t.phone} value={result.profile.phone} {...rowProps}/><ResultRow id="email" label={t.email} value={result.profile.email} {...rowProps}/>{extensions && <><ResultRow id="age" label={t.age} value={String(extensions.basic.age)} {...rowProps}/><ResultRow id="honorific" label={t.honorific} value={profileValue(extensions.basic.honorific, sectionLanguages.profile, countryCode)} {...rowProps}/><ResultRow id="zodiac" label={t.zodiacSign} value={profileValue(extensions.basic.zodiacSign, sectionLanguages.profile, countryCode)} {...rowProps}/><ResultRow id="height" label={t.height} value={`${extensions.basic.heightCm} cm`} {...rowProps}/><ResultRow id="weight" label={t.weight} value={`${extensions.basic.weightKg} kg`} {...rowProps}/><ResultRow id="bmi" label={t.bmi} value={String(extensions.basic.bmi)} {...rowProps}/><ResultRow id="blood" label={t.bloodType} value={extensions.basic.bloodType} {...rowProps}/><ResultRow id="education" label={t.education} value={profileValue(extensions.basic.education, sectionLanguages.profile, countryCode)} {...rowProps}/></>}</section>
              <section className="card-section panel"><header className="section-heading"><h2>{t.testCard}</h2></header><p className="sandbox-notice">{t.cardNotice}</p><ResultRow id="card-holder" label={t.fullName} value={result.profile.fullName} {...rowProps}/><ResultRow id="card-network" label={t.cardNetwork} value={result.card.network} {...rowProps}/><ResultRow id="card" label={t.testCard} value={result.card.number} {...rowProps}/><ResultRow id="expiry" label={t.expiry} value={result.card.expiry} {...rowProps}/><ResultRow id="cvc" label={t.cvc} value={result.card.cvc} {...rowProps}/></section>
            </div>

            {extensions && <div className="extension-grid">
              <section className="extension-section panel">
                <header className="section-heading"><h2>{t.employment}</h2><SectionLanguageTabs value={sectionLanguages.employment} onChange={(language) => setSectionLanguage('employment', language)} labels={[t.originalAddress, t.englishAddress, t.chineseAddress]}/></header>
                <ResultRow id="employment-status" label={t.employmentStatus} value={profileValue(extensions.employment.employmentStatus, sectionLanguages.employment, countryCode)} {...rowProps}/>
                {hasEmploymentDetails(extensions.employment) && <>
                  <ResultRow id="work-schedule" label={t.workSchedule} value={profileValue(extensions.employment.workSchedule, sectionLanguages.employment, countryCode)} {...rowProps}/>
                  <ResultRow id="occupation" label={t.occupation} value={profileValue(extensions.employment.occupation, sectionLanguages.employment, countryCode)} {...rowProps}/>
                  <ResultRow id="company" label={t.company} value={extensions.employment.company} {...rowProps}/>
                  <ResultRow id="department" label={t.department} value={profileValue(extensions.employment.department, sectionLanguages.employment, countryCode)} {...rowProps}/>
                  <ResultRow id="company-size" label={t.companySize} value={extensions.employment.companySize} {...rowProps}/>
                  <ResultRow id="salary" label={t.salary} value={currency(extensions.employment.salary.amount, extensions.employment.salary.currency)} {...rowProps}/>
                </>}
              </section>
              <section className="extension-section panel"><header className="section-heading"><h2>{t.finance}</h2><SectionLanguageTabs value={sectionLanguages.finance} onChange={(language) => setSectionLanguage('finance', language)} labels={[t.originalAddress, t.englishAddress, t.chineseAddress]}/></header><ResultRow id="account-name" label={t.accountDisplayName} value={profileValue(extensions.finance.accountDisplayName, sectionLanguages.finance, countryCode)} {...rowProps}/>{extensions.finance.incomeRange && <ResultRow id="income" label={t.incomeRange} value={`${currency(extensions.finance.incomeRange.min, extensions.finance.incomeRange.currency)} - ${currency(extensions.finance.incomeRange.max, extensions.finance.incomeRange.currency)}`} {...rowProps}/>}<ResultRow id="transaction" label={t.transactionDescription} value={extensions.finance.transactionDescription} {...rowProps}/></section>
              <section className="extension-section panel extension-wide"><header className="section-heading"><h2>{t.internetProfile}</h2><SectionLanguageTabs value={sectionLanguages.internet} onChange={(language) => setSectionLanguage('internet', language)} labels={[t.originalAddress, t.englishAddress, t.chineseAddress]}/></header><div className="extension-columns"><div><ResultRow id="username" label={t.username} value={extensions.internet.username} {...rowProps}/><ResultRow id="password" label={t.testPassword} value={extensions.internet.testPassword} {...rowProps}/><ResultRow id="os" label={t.operatingSystem} value={extensions.internet.os} {...rowProps}/><ResultRow id="user-agent" label={t.userAgent} value={extensions.internet.userAgent} {...rowProps}/></div><div><ResultRow id="ip" label={t.ipAddress} value={extensions.internet.ipAddress} {...rowProps}/><ResultRow id="mac" label={t.macAddress} value={extensions.internet.macAddress} {...rowProps}/><ResultRow id="uuid" label={t.uuid} value={extensions.internet.uuid} {...rowProps}/><ResultRow id="profile-url" label={t.personalUrl} value={extensions.internet.url} {...rowProps}/><ResultRow id="security-question" label={t.securityQuestion} value={profileValue(extensions.internet.securityQuestion, sectionLanguages.internet, countryCode)} {...rowProps}/><ResultRow id="security-answer" label={t.securityAnswer} value={extensions.internet.securityAnswer} {...rowProps}/></div></div></section>
            </div>}

            <section className="map-section panel"><header className="section-heading"><h2>{t.mapPreview}</h2><span className="map-links"><a href={result.googleMaps.openUrl} target="_blank" rel="noreferrer">{t.openGoogle}</a>{result.googleMaps.searchUrl && <a href={result.googleMaps.searchUrl} target="_blank" rel="noreferrer">{t.searchGoogle}</a>}{result.googleMaps.amapUrl && <a href={result.googleMaps.amapUrl} target="_blank" rel="noreferrer">{t.openAmap}</a>}</span></header><p className="map-hint">{t.mapHint}</p><div className="map-frame"><iframe title={t.mapPreview} src={result.googleMaps.embedUrl} loading="lazy" allowFullScreen referrerPolicy="no-referrer-when-downgrade"/></div></section>
          </>}
        </div>

        <aside className="quick-sidebar">
          <ShortcutSection title={t.popularCities} items={residential ? selectedCountry.popularCities.filter((item) => locations.cities.some((cityOption) => sameLocation(cityOption.value, item.value))) : selectedCountry.popularCities} locale={locale} apply={applyShortcut}/>
          <ShortcutSection title={t.adminShortcuts} items={residential ? selectedCountry.adminShortcuts.filter((item) => locations.regions.some((regionOption) => sameLocation(regionOption.value, item.value))) : selectedCountry.adminShortcuts} locale={locale} apply={applyShortcut}/>
        </aside>
      </div>
    </main>
    {copyToast && <div className={`copy-toast ${copyToast.kind}`} role={copyToast.kind === 'error' ? 'alert' : 'status'} aria-live={copyToast.kind === 'error' ? 'assertive' : 'polite'} aria-atomic="true"><span aria-hidden="true">{copyToast.kind === 'success' ? '✓' : '!'}</span>{copyToast.message}</div>}
    <footer>{t.attribution} · <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">ODbL</a></footer>
  </div>;
}

function Combobox({ label, value, options, placeholder, total, hasMore = false, clientFilter = false, onLoadMore, onChange, onSearch }: {
  label: string; value: string; options: LocationOption[]; placeholder: string;
  total: number; hasMore?: boolean; clientFilter?: boolean; onLoadMore?: () => void | Promise<void>;
  onChange: (value: string, option: LocationOption) => void; onSearch?: (query: string) => void | Promise<void>;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(value);
  const [activeIndex, setActiveIndex] = useState(0);
  const skipValueSync = useRef(false);
  const selected = options.find((option) => option.value === value);
  useEffect(() => {
    if (skipValueSync.current) { skipValueSync.current = false; return; }
    setQuery(selected?.label || value);
  }, [value, selected?.label]);
  useEffect(() => {
    if (!open || clientFilter || !onSearch) return;
    const searchQuery = selected?.label === query ? '' : query;
    const timer = window.setTimeout(() => void onSearch(searchQuery), 280);
    return () => window.clearTimeout(timer);
  }, [query, open, selected?.label, clientFilter, onSearch]);
  useEffect(() => setActiveIndex(0), [query, clientFilter]);
  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) { setOpen(false); setQuery(selected?.label || value); }
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [selected?.label, value]);
  const searchQuery = selected?.label === query ? '' : query;
  const visibleOptions = clientFilter ? filterLocationOptions(options, searchQuery) : options;
  const renderedOptions = visibleOptions.slice(0, LOCATION_OPTION_RENDER_LIMIT);
  const values: LocationOption[] = [{ value: '', label: placeholder }, ...renderedOptions];
  const select = (option: LocationOption) => {
    setQuery(option.label === placeholder ? '' : option.label); onChange(option.value, option); setOpen(false); setActiveIndex(0);
  };
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); setActiveIndex((index) => Math.min(index + 1, values.length - 1)); }
    if (event.key === 'ArrowUp') { event.preventDefault(); setActiveIndex((index) => Math.max(index - 1, 0)); }
    if (event.key === 'Enter' && open) { event.preventDefault(); select(values[activeIndex] || values[0]); }
    if (event.key === 'Escape') { setOpen(false); setQuery(selected?.label || value); }
  };
  return <div className="filter custom-combobox" ref={root}>
    <label htmlFor={id}>{label}</label>
    <div className={`combobox-control ${open ? 'open' : ''}`}>
      <input id={id} role="combobox" aria-expanded={open} aria-controls={`${id}-list`} aria-autocomplete="list" value={query} placeholder={placeholder} onFocus={() => setOpen(true)} onChange={(event) => {
        const nextQuery = event.target.value;
        if (value && nextQuery !== selected?.label) {
          skipValueSync.current = true;
          onChange('', { value: '', label: placeholder });
        }
        setQuery(nextQuery); setOpen(true); setActiveIndex(0);
      }} onKeyDown={keyDown}/>
      <button type="button" aria-label={label} onClick={() => setOpen((current) => !current)}>▾</button>
    </div>
    {open && <div className="combobox-popup" id={`${id}-list`} role="listbox">
      {values.map((option, index) => <button type="button" role="option" aria-selected={!option.value ? !value : option.value === value} className={index === activeIndex ? 'active' : ''} key={`${option.value}-${index}`} onMouseDown={(event) => event.preventDefault()} onClick={() => select(option)}>{option.label}</button>)}
      <div className="combobox-status"><span>{visibleOptions.length}/{clientFilter ? options.length : total}</span>{hasMore && onLoadMore && <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => void onLoadMore()}>+100</button>}</div>
    </div>}
  </div>;
}
function SectionLanguageTabs({ value, onChange, labels }: { value: AddressLanguage; onChange: (language: AddressLanguage) => void; labels: [string, string, string] | string[] }) {
  const options: Array<[AddressLanguage, string]> = [['native', labels[0]], ['en', labels[1]], ['zh-CN', labels[2]]];
  return <div className="language-tabs profile-language-tabs" role="tablist">{options.map(([language, label]) =>
    <button type="button" role="tab" aria-selected={value === language} className={value === language ? 'active' : ''} key={language} onClick={() => onChange(language)}>{label}</button>)}</div>;
}
function ResultRow({ id, label, value, copy, copied, copyLabel }: { id: string; label: string; value: string; copy: (key: string, value: string) => Promise<void>; copied: string; copyLabel: string }) {
  if (!value.trim()) return null;
  return <div className="result-row"><span>{label}</span><strong onDoubleClick={() => void copy(id, value)}>{value}</strong><button type="button" onClick={() => void copy(id, value)}>{copied === id ? '✓' : copyLabel}</button></div>;
}
function AddressBlock({ title, copyLabel, onCopy, children }: { title: string; copyLabel: string; onCopy: () => void; children: ReactNode }) {
  return <section className="address-block"><header><h3>{title}</h3><button type="button" onClick={onCopy}>{copyLabel}</button></header>{children}</section>;
}
function ShortcutSection({ title, items, locale, apply }: { title: string; items: LocationShortcut[]; locale: Locale; apply: (item: LocationShortcut) => void }) {
  const [expanded, setExpanded] = useState(false);
  if (!items.length) return null;
  const shown = expanded ? items : items.slice(0, 10);
  return <section className="shortcut-card panel"><header><h2>{title}</h2></header><div>{shown.map((item) => <button type="button" key={`${item.type}-${item.value}`} onClick={() => apply(item)}>{item.label[locale]}</button>)}</div>{items.length > 10 && <button type="button" className="show-all" onClick={() => setExpanded(!expanded)}>{expanded ? '收起' : '查看全部'}</button>}</section>;
}
