import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode, type SyntheticEvent } from 'react';
import { Activity, Bookmark, ChevronDown, X } from 'lucide-react';
import AmapPreview from './AmapPreview';
import {
  addressDisplayComponents,
  addressDisplayCountryName,
  addressDisplayPresentation,
  matchesNativeLanguage,
  storedVariantLooksLocalized,
  type AddressDisplayLanguage
} from '../domain/address-display';
import { countries, countryByCode, isCountryCode } from '../domain/countries';
import { favoriteIdFor } from '../domain/favorites';
import { favoritesCopy } from '../domain/favorites-i18n';
import { countryCodeFrom, type ClientContext, type GenerationMode } from '../domain/client-context';
import { messages } from '../domain/i18n';
import { pinyinStore } from '../domain/pinyin-runtime';
import { localeDefinitions, localizedCountryName, pathForLocale, uiTextLocale } from '../domain/locales';
import { locationOptionLabel } from '../domain/location-options';
import { localizedProfileValue, profileLanguageControlText, profileLanguageNames, resolvedProfileLocale } from '../domain/profile-localization';
import { isChineseNativeCountry, nativeProfileLabel } from '../domain/profile-native-labels';
import { supportedLocales, type AddressComponents, type AddressFilterField, type AddressResultField, type CountryCode, type CountryGroup, type CountryShortcutConfig, type GeneratedBundle, type Locale, type LocationOption, type LocationShortcut, type ProfileLanguage } from '../domain/types';
import { listFavorites, removeFavorite, saveFavorite, subscribeToFavorites } from '../services/favorite-store';

interface AppProps { locale: Locale; apiBaseUrl: string }
const monitorLabels: Record<Locale, string> = {
  en: 'Address count monitor', 'zh-CN': '地址数量监控', 'zh-TW': '地址數量監控', ja: '住所数モニター', ko: '주소 수 모니터',
  de: 'Adresszahlen', fr: "Nombre d'adresses", es: 'Cantidad de direcciones', pt: 'Quantidade de endereços'
};
interface Locations { regions: LocationOption[]; cities: LocationOption[]; districts: LocationOption[]; postcodes: LocationOption[]; matches: LocationOption[] }
interface LocationMeta { total: number; availableTotal: number; nextCursor?: string }
interface LocationOverrides { country?: CountryCode; residential?: boolean; region?: string; regionId?: string; city?: string; cityId?: string; cursor?: string; append?: boolean }
interface LocationCacheEntry { expiresAt: number; values: LocationOption[]; meta: LocationMeta }
interface CountryAvailability { code: CountryCode; available?: boolean; residentialAvailable: boolean }
interface GenerationOptions {
  countryCode?: CountryCode;
  region?: string;
  regionId?: string;
  city?: string;
  cityId?: string;
  district?: string;
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
  eligibleCount?: number;
  sourcesTried?: string[];
  filterMatchLevel?: 'exact' | 'nearby' | 'region' | 'country';
  ipMatchLevel?: IpRegionResult['matchLevel'];
  ipRegion?: Omit<IpRegionResult, 'matchLevel'>;
  result: GeneratedBundle;
}
interface MapDisplayConfig {
  countryCode: CountryCode;
  googleEnabled: boolean;
  amapEnabled: boolean;
  amapConfigured: boolean;
  amapApiKey?: string;
  serviceHost?: string;
}
interface GenerationRequestSpec {
  country: CountryCode;
  mode: Mode;
  region: string;
  regionId: string;
  city: string;
  cityId: string;
  district: string;
  postcode: string;
  postcodeId: string;
  ipRegion: boolean;
  ip: string;
}
type Mode = GenerationMode;
type LocationField = 'region' | 'city' | 'district' | 'postcode';
type LocationLoadState = 'idle' | 'loading' | 'ready' | 'error';
const emptyLocationMeta: Record<LocationField, LocationMeta> = {
  region: { total: 0, availableTotal: 0 }, city: { total: 0, availableTotal: 0 },
  district: { total: 0, availableTotal: 0 }, postcode: { total: 0, availableTotal: 0 }
};

const emptyLocations: Locations = { regions: [], cities: [], districts: [], postcodes: [], matches: [] };
const groupOrder: CountryGroup[] = ['north-america', 'europe', 'east-asia', 'southeast-asia', 'south-asia', 'oceania', 'middle-east', 'south-america', 'africa'];
const groupMessage = {
  'north-america': 'northAmerica', europe: 'europe', 'east-asia': 'eastAsia',
  'southeast-asia': 'southeastAsia', 'south-asia': 'southAsia', oceania: 'oceania',
  'middle-east': 'middleEast', 'south-america': 'southAmerica', africa: 'africa'
} as const;
const countrySessionKey = 'address-generator-country';
const availabilityStorageKey = 'address-generator-availability-v1';
interface AddressBoot {
  generate?: { country: string; requestId: string; payload: Promise<{ data?: GenerateResponseData; error?: { code?: string } } | null> };
  availability?: Promise<{ data?: CountryAvailability[] } | null>;
}
// The page's inline script starts these requests before the bundle loads; each is consumed once.
const takeBoot = <K extends keyof AddressBoot>(key: K): AddressBoot[K] | undefined => {
  const boot = (globalThis as { __addressBoot?: AddressBoot }).__addressBoot;
  const value = boot?.[key];
  if (boot) delete boot[key];
  return value;
};
const storedAvailability = (): Set<CountryCode> | null => {
  try {
    const codes = JSON.parse(window.localStorage.getItem(availabilityStorageKey) || 'null') as string[] | null;
    const known = Array.isArray(codes) ? codes.filter((code): code is CountryCode => isCountryCode(code)) : [];
    return known.length ? new Set(known) : null;
  } catch { return null; }
};
export const addressLanguageStorageKey = 'address-generator-address-language';
export const profileLanguageStorageKey = 'address-generator-profile-language';
const displayLanguages = new Set<string>(['native', 'pinyin', ...supportedLocales]);
type LanguageStorage = Pick<Storage, 'getItem' | 'setItem'>;

// A visit starts in the page language; an explicit choice lasts for the browser session only.
export const readStoredDisplayLanguage = <T extends AddressDisplayLanguage | ProfileLanguage>(
  key: string,
  fallback: Locale = 'en',
  storage?: LanguageStorage
): T | Locale => {
  try {
    const source = storage || (typeof window === 'undefined' ? undefined : window.sessionStorage);
    const value = source?.getItem(key);
    return value && displayLanguages.has(value) ? value as T : fallback;
  } catch {
    return fallback;
  }
};
const emptyLocationLoadState: Record<LocationField, LocationLoadState> = {
  region: 'idle', city: 'idle', district: 'idle', postcode: 'idle'
};

export const storeDisplayLanguage = (key: string, value: AddressDisplayLanguage | ProfileLanguage, storage?: LanguageStorage): void => {
  try {
    (storage || (typeof window === 'undefined' ? undefined : window.sessionStorage))?.setItem(key, value);
  } catch {
    // Storage can be unavailable in restricted browser contexts; state remains authoritative.
  }
};
interface CryptoSource {
  randomUUID?: () => string;
  getRandomValues?: (array: Uint8Array) => Uint8Array;
}

export const GENERATION_REQUEST_TIMEOUT_MS = 20_000;
export const IP_GENERATION_REQUEST_TIMEOUT_MS = 60_000;
export const CLIENT_CONTEXT_REQUEST_TIMEOUT_MS = 12_000;
export const LOCATION_REQUEST_TIMEOUT_MS = 60_000;
export const LOCATION_CACHE_TTL_MS = 30_000;
export const TRANSLATION_REQUEST_TIMEOUT_MS = 15_000;

type AddressTranslation =
  | { status: 'ready'; components: AddressComponents; postalLines: string[]; singleLine: string }
  | { status: 'fallback' };

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
const LOCATION_OPTION_RENDER_STEP = 100;
export const selectAvailableCountry = (requested: CountryCode | undefined, available: ReadonlySet<CountryCode>): CountryCode | undefined => {
  if (requested && available.has(requested)) return requested;
  if (available.has('US')) return 'US';
  return countries.find(({ code }) => available.has(code))?.code;
};
// Marks the first accent- and case-insensitive occurrence of the query in a label.
const highlightMatch = (label: string, query: string): ReactNode => {
  const needle = query.trim();
  if (!needle) return label;
  const fold = (value: string) => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase();
  const folded = [...label].map((character) => fold(character));
  const target = fold(needle);
  for (let index = 0; index < folded.length; index += 1) {
    let joined = '';
    for (let end = index; end < folded.length && joined.length < target.length; end += 1) {
      joined += folded[end];
      if (joined === target) {
        const chars = [...label];
        return <>{chars.slice(0, index).join('')}<mark>{chars.slice(index, end + 1).join('')}</mark>{chars.slice(end + 1).join('')}</>;
      }
    }
  }
  return label;
};
export const filterLocationOptions = (options: LocationOption[], query: string): LocationOption[] => {
  const searches = locationSearchForms(query);
  if (!searches.length) return options;
  return options.filter((option) => [option.value, option.label, option.native, option.en, option.zhCN]
    .some((value) => value && locationSearchForms(value)
      .some((candidate) => searches.some((search) => candidate.includes(search)))));
};
export const sameLocationOption = (left: LocationOption | undefined, right: LocationOption): boolean =>
  Boolean(left) && left!.value === right.value && (!left!.id || !right.id || left!.id === right.id);
export const exactLocationMatches = (options: LocationOption[], query: string, locale: Locale): LocationOption[] => {
  const typed = normalizeLocationSearch(query);
  return typed ? options.filter((option) => [option.value, option.label, option.native, option.en, option.zhCN, locationOptionLabel(option, locale)]
    .some((name) => name && normalizeLocationSearch(name) === typed)) : [];
};
type GenerationErrorMessageKey = 'retry' | 'noPoolCoverage' | 'ipNoResult' | 'ipLookupFailed' | 'requestFailed';
export const GENERATION_BUSY_RETRIES = 3;
export const generationErrorCode = (error: { code?: string } | string | undefined): string =>
  (typeof error === 'string' ? error : error?.code) || 'API_ERROR';
export const abortableDelay = (milliseconds: number, signal: AbortSignal): Promise<void> => new Promise((resolveDelay, reject) => {
  const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolveDelay(); }, milliseconds);
  const abort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
  if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
});
export const generationErrorMessageKey = (code: string, ipRegion: boolean): GenerationErrorMessageKey => {
  if (code === 'NO_POOL_COVERAGE') return 'noPoolCoverage';
  if (code === 'GENERATION_BUSY') return 'retry';
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

export const generatorTitle = (countryName: string, locale: Locale, residentialLabel: string): string =>
  `${countryName}${locale === 'zh-CN' || locale === 'zh-TW' || locale === 'ja' ? '' : ' '}${residentialLabel}`;

export const generationResponseMode = (countryCode: CountryCode, ipRegion = false): string =>
  ipRegion ? 'ip-region' : countryCode === 'CN' ? 'residential' : 'address';

// Resolves a profile data value to the chosen display language. "native" prefers the
// country's own language dictionary, then Chinese for CN-family countries, then English.
export const profileValue = (value: string, language: ProfileLanguage, countryCode: CountryCode): string => {
  const localized = localizedProfileValue(value, language, countryCode);
  if (localized) return localized;
  if (language === 'zh-CN') return localizedExtensionValue(value, 'zh-CN');
  if (language === 'en') return localizedExtensionValue(value, 'en');
  if (language !== 'native') return value;
  const native = nativeProfileLabel(value, countryCode);
  if (native) return native;
  return localizedExtensionValue(value, isChineseNativeCountry(countryCode) ? 'zh-CN' : 'en');
};

const hasEmploymentDetails = (
  employment: GeneratedBundle['extensions']['employment']
): employment is Extract<GeneratedBundle['extensions']['employment'], { employmentStatus: 'employed' | 'self-employed' }> =>
  employment.employmentStatus === 'employed' || employment.employmentStatus === 'self-employed';

export const streetValue = (countryCode: CountryCode, components: AddressComponents): string => {
  if (countryCode === 'CN') {
    if (!/\p{Script=Han}/u.test(components.street)) {
      return [components.houseNumber, components.street, components.unit].filter(Boolean).join(' ');
    }
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
  const textLocale = uiTextLocale(locale);
  const endpoint = apiBaseUrl.replace(/\/$/, '');
  const [mode, setMode] = useState<Mode>('residential');
  const [countryCode, setCountryCode] = useState<CountryCode>('US');
  const [region, setRegion] = useState('');
  const [regionId, setRegionId] = useState('');
  const [city, setCity] = useState('');
  const [cityId, setCityId] = useState('');
  const [district, setDistrict] = useState('');
  const [postcode, setPostcode] = useState('');
  const [postcodeId, setPostcodeId] = useState('');
  const [locations, setLocations] = useState<Locations>(emptyLocations);
  const [locationMeta, setLocationMeta] = useState<Record<LocationField, LocationMeta>>(emptyLocationMeta);
  const [locationLoadState, setLocationLoadState] = useState<Record<LocationField, LocationLoadState>>(emptyLocationLoadState);
  const [result, setResult] = useState<GeneratedBundle | null>(null);
  useSyncExternalStore(...pinyinStore);
  const [addressLanguage, setAddressLanguage] = useState<AddressDisplayLanguage>(() => readStoredDisplayLanguage<AddressDisplayLanguage>(addressLanguageStorageKey, locale));
  const [addressTranslations, setAddressTranslations] = useState<Record<string, AddressTranslation>>({});
  const [translationRetry, setTranslationRetry] = useState(0);
  const [profileLanguage, setProfileLanguage] = useState<ProfileLanguage>(() => readStoredDisplayLanguage<ProfileLanguage>(profileLanguageStorageKey, locale));
  const [loading, setLoading] = useState(false);
  const [ipLoading, setIpLoading] = useState(false);
  const [error, setError] = useState('');
  const [locationErrors, setLocationErrors] = useState<Partial<Record<LocationField, string>>>({});
  const [manualIp, setManualIp] = useState('');
  const [ipContext, setIpContext] = useState<ClientContext | null>(null);
  const [ipRegionResult, setIpRegionResult] = useState<IpRegionResult | null>(null);
  const [copied, setCopied] = useState('');
  const [fallbackNotice, setFallbackNotice] = useState('');
  const [copyToast, setCopyToast] = useState<{ kind: 'success' | 'error'; message: string } | null>(null);
  // Hydrate with every country, as the server rendered, then apply the last known availability before the first
  // paint; the live list replaces it when it arrives.
  const [residentialCountries, setResidentialCountries] = useState<Set<CountryCode>>(() => new Set(countries.map((country) => country.code)));
  useLayoutEffect(() => {
    const stored = storedAvailability();
    if (stored) { residentialCountriesRef.current = stored; setResidentialCountries(stored); }
  }, []);
  const [countriesReady, setCountriesReady] = useState(true);
  const [mapDisplay, setMapDisplay] = useState<MapDisplayConfig | null>(null);
  const [shortcutConfigs, setShortcutConfigs] = useState<Partial<Record<CountryCode, CountryShortcutConfig>>>({});
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());
  const [favoriteCount, setFavoriteCount] = useState(0);
  const activeRequest = useRef<{ requestId: string; country: CountryCode; mode: Mode } | null>(null);
  const selectionRef = useRef<{ country: CountryCode; mode: Mode }>({ country: 'US', mode: 'residential' });
  const generationController = useRef<AbortController | null>(null);
  const locationControllers = useRef<Partial<Record<LocationField, AbortController>>>({});
  const locationRetries = useRef<Partial<Record<LocationField, LocationOverrides>>>({});
  const locationRequestKeys = useRef<Partial<Record<LocationField, string>>>({});
  const locationCache = useRef<Map<string, LocationCacheEntry>>(new Map());
  const locationRevisions = useRef<Map<CountryCode, string>>(new Map());
  const locationQueries = useRef<Record<LocationField, string>>({ region: '', city: '', district: '', postcode: '' });
  const copyToastTimer = useRef<number | undefined>(undefined);
  const prefetchTimer = useRef<number | undefined>(undefined);
  const prefetchedResults = useRef<Map<string, GeneratedBundle[]>>(new Map());
  const recentAddressIds = useRef<Map<string, string[]>>(new Map());
  const eligibleCounts = useRef<Map<string, number>>(new Map());
  const prefetchController = useRef<AbortController | null>(null);
  const prefetchingKey = useRef('');
  const userNavigated = useRef(false);
  const residentialCountriesRef = useRef<Set<CountryCode>>(residentialCountries);

  const refreshFavoriteState = async () => {
    const { values } = await listFavorites();
    setFavoriteIds(new Set(values.map(({ id }) => id))); setFavoriteCount(values.length);
  };
  useEffect(() => { void refreshFavoriteState(); return subscribeToFavorites(() => void refreshFavoriteState()); }, []);

  const residential = countryCode === 'CN';
  const selectedCountry = countryByCode.get(countryCode) || countries[0];
  const selectedShortcuts = shortcutConfigs[countryCode] || selectedCountry;
  const addressSchema = selectedCountry.addressSchema;
  const filterFields: AddressFilterField[] = addressSchema.filters;
  const visibleCountries = useMemo(() => countries.filter((country) => residentialCountries.has(country.code)), [residentialCountries]);
  const countryGroups = useMemo(() => groupOrder.map((group) => ({ group, countries: visibleCountries.filter((country) => country.group === group) })).filter((item) => item.countries.length), [visibleCountries]);

  const updateUrl = (nextCountry: CountryCode, action: 'push' | 'replace') => {
    const url = new URL(window.location.href);
    url.searchParams.set('country', nextCountry.toLowerCase());
    url.searchParams.delete('mode');
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
    spec.district, spec.postcodeId || spec.postcode
  ].join(':');

  const paramsFor = (spec: GenerationRequestSpec, requestId: string, strategy: 'instant' | 'random') => {
    const params = new URLSearchParams({
      requestId, country: spec.country, residential: String(spec.country === 'CN'),
      seed: randomSeed(), strategy
    });
    if (spec.ipRegion) params.set('mode', 'ip-region');
    if (spec.ip.trim()) params.set('ip', spec.ip.trim());
    if (spec.region) params.set('region', spec.region);
    if (spec.regionId) params.set('regionId', spec.regionId);
    if (spec.city) params.set('city', spec.city);
    if (spec.cityId) params.set('cityId', spec.cityId);
    if (spec.district) params.set('district', spec.district);
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
    const existing = prefetchedResults.current.get(key) || [];
    const needed = Math.max(0, 2 - existing.length);
    try {
      const responses = await Promise.allSettled(Array.from({ length: needed }, async () => {
        const requestId = createRequestId();
        const response = await fetchWithTimeout(`${endpoint}/v1/generate?${paramsFor(spec, requestId, 'instant')}`, {
          signal: controller.signal, headers: { 'X-Generation-Prefetch': '1' }
        });
        if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return undefined;
        const payload = await response.json() as { data?: GenerateResponseData };
        if (payload.data?.requestId !== requestId) return undefined;
        return { result: payload.data.result, eligibleCount: payload.data.eligibleCount };
      }));
      if (controller.signal.aborted) return;
      const queued = [...existing];
      const ids = new Set(queued.map((item) => item.address.id));
      const reportedCount = responses.flatMap((response) =>
        response.status === 'fulfilled' && response.value?.eligibleCount ? [response.value.eligibleCount] : []
      )[0];
      if (reportedCount) eligibleCounts.current.set(key, reportedCount);
      const eligibleCount = reportedCount || eligibleCounts.current.get(key) || 100;
      const recentLimit = Math.min(20, Math.max(1, Math.floor(eligibleCount / 2)));
      const recent = new Set((recentAddressIds.current.get(key) || []).slice(-recentLimit));
      for (const response of responses) {
        const result = response.status === 'fulfilled' ? response.value?.result : undefined;
        if (!result || ids.has(result.address.id) || recent.has(result.address.id)) continue;
        ids.add(result.address.id);
        queued.push(result);
      }
      if (!prefetchedResults.current.has(key) && prefetchedResults.current.size >= 32) {
        prefetchedResults.current.delete(prefetchedResults.current.keys().next().value as string);
      }
      prefetchedResults.current.delete(key);
      prefetchedResults.current.set(key, queued.slice(0, 2));
    } finally {
      if (prefetchController.current === controller) {
        prefetchController.current = null;
        prefetchingKey.current = '';
      }
    }
  };

  const abortPrefetch = () => {
    prefetchController.current?.abort();
    prefetchController.current = null;
    prefetchingKey.current = '';
  };

  const rememberAddress = (key: string, addressId: string) => {
    const recent = (recentAddressIds.current.get(key) || []).filter((id) => id !== addressId);
    recent.push(addressId);
    recentAddressIds.current.set(key, recent.slice(-20));
  };

  const cancelGeneration = () => {
    generationController.current?.abort(); activeRequest.current = null;
    abortPrefetch(); setLoading(false); setError(''); setFallbackNotice('');
  };
  const cancelLocationFields = (fields: LocationField[]) => {
    for (const field of fields) {
      locationControllers.current[field]?.abort();
      delete locationControllers.current[field]; delete locationRequestKeys.current[field];
      delete locationRetries.current[field]; locationQueries.current[field] = '';
    }
  };
  const loadOptions = async (field: LocationField, query = '', overrides: LocationOverrides = {}) => {
    const requestCountry = overrides.country || countryCode;
    const requestResidential = overrides.residential ?? (requestCountry === 'CN');
    const parentRegion = field === 'region' ? '' : overrides.region ?? region;
    const parentRegionId = field === 'region' ? '' : overrides.regionId ?? regionId;
    const parentCity = field === 'postcode' || field === 'district' ? overrides.city ?? city : '';
    const parentCityId = field === 'postcode' || field === 'district' ? overrides.cityId ?? cityId : '';
    const requestParts = [requestCountry, requestResidential, field, query.trim(), parentRegion, parentRegionId,
      parentCity, parentCityId, overrides.cursor || '', locale];
    const knownRevision = locationRevisions.current.get(requestCountry) || '';
    const requestKey = JSON.stringify([...requestParts, knownRevision]);
    if (locationRequestKeys.current[field] === requestKey && locationControllers.current[field] && !locationControllers.current[field]?.signal.aborted) return;
    const optionKey = field === 'region' ? 'regions' : field === 'city' ? 'cities' : field === 'district' ? 'districts' : 'postcodes';
    if (!overrides.append) {
      const cached = locationCache.current.get(requestKey);
      if (cached && cached.expiresAt > Date.now()) {
        locationControllers.current[field]?.abort();
        delete locationControllers.current[field];
        locationQueries.current[field] = query;
        locationRetries.current[field] = overrides;
        locationRequestKeys.current[field] = requestKey;
        setLocations((current) => ({ ...current, [optionKey]: cached.values }));
        setLocationMeta((current) => ({ ...current, [field]: cached.meta }));
        setLocationErrors((current) => ({ ...current, [field]: '' }));
        setLocationLoadState((current) => ({ ...current, [field]: 'ready' }));
        return;
      }
      if (cached) locationCache.current.delete(requestKey);
    }
    locationControllers.current[field]?.abort();
    const controller = new AbortController();
    locationControllers.current[field] = controller;
    locationQueries.current[field] = query;
    locationRetries.current[field] = overrides;
    locationRequestKeys.current[field] = requestKey;
    const params = new URLSearchParams({
      country: requestCountry,
      residential: String(requestResidential),
      field,
      schema: '6',
      limit: field === 'postcode' ? '100' : '200'
    });
    if (query.trim()) params.set('q', query.trim());
    if (parentRegion) params.set('region', parentRegion);
    if (parentRegionId) params.set('regionId', parentRegionId);
    if (parentCityId) params.set('cityId', parentCityId);
    if (parentCity) params.set('city', parentCity);
    if (overrides.cursor) params.set('cursor', overrides.cursor);
    setLocationLoadState((current) => ({ ...current, [field]: 'loading' }));
    try {
      const response = await fetchWithTimeout(`${endpoint}/v1/locations/search?${params}`, { signal: controller.signal }, LOCATION_REQUEST_TIMEOUT_MS);
      if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error('API response is not JSON');
      const payload = await response.json() as { data?: Locations & LocationMeta & { revision?: string } };
      if (locationControllers.current[field] !== controller || locationRequestKeys.current[field] !== requestKey) return;
      const responseRevision = payload.data?.revision || response.headers.get('X-Address-Catalog-Revision') || '';
      if (responseRevision && responseRevision !== knownRevision) {
        locationRevisions.current.set(requestCountry, responseRevision);
        locationCache.current.clear();
      }
      const supplied = field === 'region' ? payload.data?.regions : field === 'city' ? payload.data?.cities : field === 'district' ? payload.data?.districts : payload.data?.postcodes;
      const values = (supplied || []).filter((option) => !option.disabled && option.availableCount !== 0);
      const meta = {
        total: payload.data?.total ?? values?.length ?? 0,
        availableTotal: payload.data?.availableTotal ?? values?.filter((option) => !option.disabled).length ?? 0,
        nextCursor: payload.data?.nextCursor
      };
      setLocations((current) => ({ ...current, [optionKey]: overrides.append ? [...new Map([...current[optionKey], ...values].map((option) => [option.id || option.value, option])).values()] : values }));
      setLocationMeta((current) => ({ ...current, [field]: meta }));
      if (!overrides.append) {
        const cacheKey = responseRevision && responseRevision !== knownRevision
          ? JSON.stringify([...requestParts, responseRevision]) : requestKey;
        locationCache.current.set(cacheKey, { expiresAt: Date.now() + LOCATION_CACHE_TTL_MS, values, meta });
        while (locationCache.current.size > 100) locationCache.current.delete(locationCache.current.keys().next().value!);
      }
      setLocationErrors((current) => ({ ...current, [field]: '' }));
      setLocationLoadState((current) => ({ ...current, [field]: 'ready' }));
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === 'AbortError') return;
      if (locationControllers.current[field] !== controller || locationRequestKeys.current[field] !== requestKey) return;
      if (!overrides.append) setLocations((current) => ({ ...current, [optionKey]: [] }));
      setLocationErrors((current) => ({ ...current, [field]: t.locationLoadFailed }));
      setLocationLoadState((current) => ({ ...current, [field]: 'error' }));
    } finally {
      if (locationControllers.current[field] === controller) delete locationControllers.current[field];
    }
  };

  const resetFor = (nextCountry: CountryCode, nextMode: Mode, history: 'push' | 'replace' | 'none' = 'replace') => {
    cancelGeneration();
    cancelLocationFields(['region', 'city', 'district', 'postcode']);
    selectionRef.current = { country: nextCountry, mode: nextMode };
    setCountryCode(nextCountry); setMode(nextMode); setRegion(''); setRegionId(''); setCity(''); setCityId(''); setDistrict(''); setPostcode(''); setPostcodeId('');
    setLocations(emptyLocations); setLocationMeta(emptyLocationMeta); setLocationLoadState(emptyLocationLoadState); setError(''); setLocationErrors({}); setLoading(false); setFallbackNotice('');
    setResult(null); setIpRegionResult(null);
    if (history !== 'none') updateUrl(nextCountry, history);
    void generate({
      countryCode: nextCountry,
      region: '', regionId: '', city: '', cityId: '', district: '', postcode: '', postcodeId: '',
      mode: nextMode,
      strategy: 'instant'
    });
  };

  const loadResidentialCountries = async (): Promise<Set<CountryCode>> => {
    let payload = await takeBoot('availability');
    if (!payload) {
      const response = await fetchWithTimeout(`${endpoint}/v1/availability`, { headers: { Accept: 'application/json' } }, 8000);
      if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error('COUNTRIES_UNAVAILABLE');
      payload = await response.json() as { data?: CountryAvailability[] };
    }
    const records = payload.data || [];
    const available = new Set(records.filter((country) => country.available ?? country.residentialAvailable).map((country) => country.code));
    if (!available.size) throw new Error('COUNTRIES_UNAVAILABLE');
    try { window.localStorage.setItem(availabilityStorageKey, JSON.stringify([...available])); } catch { /* storage is optional */ }
    residentialCountriesRef.current = available;
    setResidentialCountries(available);
    setCountriesReady(true);
    return available;
  };

  useEffect(() => {
    let disposed = false;
    const bootstrap = async () => {
      const params = new URLSearchParams(window.location.search);
      const urlCountry = countryCodeFrom(params.get('country'));
      const requestedCountry = urlCountry || 'US';
      resetFor(requestedCountry, 'residential', 'replace');
      void loadClientContext().then((value) => { if (!disposed) setIpContext(value); }).catch(() => undefined);
      const availableResult = await Promise.resolve(loadResidentialCountries()).then(
        (value) => ({ status: 'fulfilled' as const, value }),
        () => ({ status: 'rejected' as const })
      );
      if (disposed) return;
      const available = availableResult.status === 'fulfilled'
        ? availableResult.value
        : new Set(countries.map((country) => country.code));
      if (availableResult.status === 'rejected') {
        residentialCountriesRef.current = available;
        setResidentialCountries(available);
        setCountriesReady(true);
      }
      if (userNavigated.current) return;
      const nextCountry = selectAvailableCountry(requestedCountry, available);
      if (nextCountry && nextCountry !== requestedCountry) resetFor(nextCountry, 'residential', 'replace');
    };
    const restoreHistory = () => {
      userNavigated.current = true;
      const params = new URLSearchParams(window.location.search);
      const code = params.get('country')?.toUpperCase();
      const requested = code && isCountryCode(code) ? code : undefined;
      const nextCountry = selectAvailableCountry(requested, residentialCountriesRef.current);
      if (!nextCountry) return;
      window.sessionStorage.setItem(countrySessionKey, nextCountry);
      resetFor(nextCountry, 'residential', 'replace');
    };
    window.addEventListener('popstate', restoreHistory);
    void bootstrap();
    return () => {
      disposed = true;
      window.removeEventListener('popstate', restoreHistory);
    };
  }, []);
  useEffect(() => () => {
    window.clearTimeout(copyToastTimer.current);
    window.clearTimeout(prefetchTimer.current);
    prefetchController.current?.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`${endpoint}/v1/config/country-shortcuts`, {
      cache: 'no-store', headers: { Accept: 'application/json' }, signal: controller.signal
    }).then(async (response) => {
      if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return;
      const payload = await response.json() as { data?: Partial<Record<CountryCode, CountryShortcutConfig>> };
      if (payload.data) setShortcutConfigs(payload.data);
    }).catch(() => undefined);
    return () => controller.abort();
  }, [endpoint]);
  useEffect(() => {
    const pageTitle = `${localizedCountryName(selectedCountry.code, locale, selectedCountry.name[textLocale])} · ${t.brand}`;
    document.title = `${pageTitle} | ${t.brand}`;
  }, [countryCode, locale]);

  useEffect(() => {
    const country = result?.address.countryCode;
    if (!country) { setMapDisplay(null); return; }
    const controller = new AbortController();
    setMapDisplay(null);
    void fetch(`${endpoint}/v1/config/maps?country=${encodeURIComponent(country)}`, {
      cache: 'no-store', signal: controller.signal, headers: { Accept: 'application/json' }
    }).then(async (response) => {
      if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return;
      const payload = await response.json() as { data?: MapDisplayConfig };
      if (payload.data?.countryCode === country) setMapDisplay(payload.data);
    }).catch(() => undefined);
    return () => controller.abort();
  }, [endpoint, result?.address.countryCode]);

  const countryAvailable = countriesReady && residentialCountries.has(countryCode);
  useEffect(() => {
    if (!countryAvailable) return;
    void loadOptions('region');
    return () => Object.values(locationControllers.current).forEach((controller) => controller?.abort());
  }, [countryCode, mode, countryAvailable]);
  // Warm the country-wide city list once the regions are in, so opening or searching the city filter is instant.
  useEffect(() => {
    if (locationLoadState.region !== 'ready' || locationLoadState.city !== 'idle' || !filterFields.includes('city') || region) return;
    const idle = (globalThis as { requestIdleCallback?: (callback: () => void) => number }).requestIdleCallback;
    const handle = idle ? idle(() => void loadOptions('city')) : window.setTimeout(() => void loadOptions('city'), 300);
    return () => {
      const cancel = (globalThis as { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback;
      if (idle && cancel) cancel(handle); else window.clearTimeout(handle);
    };
  }, [locationLoadState.region, locationLoadState.city, countryCode, region]);

  // Passing the pointer over the country list must not fire a prefetch for every button it crosses.
  const scheduleCountryPrefetch = (nextCountry: CountryCode) => {
    window.clearTimeout(prefetchTimer.current);
    prefetchTimer.current = window.setTimeout(() => prefetchCountry(nextCountry), 250);
  };
  const cancelCountryPrefetch = () => window.clearTimeout(prefetchTimer.current);

  const changeCountry = (nextCountry: CountryCode) => {
    cancelCountryPrefetch();
    if (nextCountry === countryCode) return;
    userNavigated.current = true;
    window.sessionStorage.setItem(countrySessionKey, nextCountry);
    resetFor(nextCountry, 'residential', 'push');
  };

  const prefetchCountry = (nextCountry: CountryCode) => {
    if (nextCountry === countryCode) return;
    const spec: GenerationRequestSpec = {
      country: nextCountry,
      mode: 'residential',
      region: '', regionId: '', city: '', cityId: '', district: '', postcode: '', postcodeId: '',
      ipRegion: false,
      ip: ''
    };
    const key = queueKeyFor(spec);
    if ((prefetchedResults.current.get(key) || []).length) return;
    void fillPrefetchQueue(spec, key);
  };

  const generate = async (overrides: GenerationOptions = {}) => {
    const context = {
      requestId: createRequestId(), country: overrides.countryCode ?? countryCode, mode: overrides.mode ?? mode
    };
    const nextRegion = overrides.region ?? region;
    const nextRegionId = overrides.regionId ?? regionId;
    const nextCity = overrides.city ?? city;
    const nextCityId = overrides.cityId ?? cityId;
    const nextDistrict = overrides.district ?? district;
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
      district: nextDistrict,
      postcode: nextPostcode,
      postcodeId: nextPostcodeId,
      ipRegion: Boolean(overrides.ipRegion),
      ip: requestedIp
    };
    const queueKey = queueKeyFor(spec);
    if (spec.ipRegion) abortPrefetch();
    if (!spec.ipRegion && selectionRef.current.country === spec.country && selectionRef.current.mode === spec.mode) {
      const queue = prefetchedResults.current.get(queueKey);
      const queued = queue?.shift();
      if (queued) {
        generationController.current?.abort(); activeRequest.current = null;
        rememberAddress(queueKey, queued.address.id);
        setResult(queued); setIpRegionResult(null); setError(''); setFallbackNotice(''); setLoading(false);
        void fillPrefetchQueue(spec, queueKey);
        return;
      }
    }
    generationController.current?.abort();
    const controller = new AbortController();
    generationController.current = controller;
    const unfiltered = !spec.ipRegion && !spec.ip && ![spec.region, spec.regionId, spec.city, spec.cityId, spec.district, spec.postcode, spec.postcodeId].some(Boolean);
    const boot = strategy === 'instant' && unfiltered ? takeBoot('generate') : undefined;
    const adoptBoot = boot?.country === spec.country;
    if (adoptBoot) context.requestId = boot!.requestId;
    activeRequest.current = context;
    setLoading(true); setError('');
    try {
      let ok = true;
      let payload: { data?: GenerateResponseData; error?: { code?: string } | string };
      const bootPayload = adoptBoot ? await boot!.payload : null;
      if (bootPayload?.data) payload = bootPayload;
      else {
        // An IP offers only its nearby addresses; a pick shown in the last few draws is drawn again, at most twice.
        const recentIp = spec.ipRegion ? new Set((recentAddressIds.current.get(`ip:${spec.ip}`) || []).slice(-5)) : undefined;
        for (let draw = 0; ; draw += 1) {
          const params = paramsFor(spec, context.requestId, strategy);
          let response: Response;
          // A busy server answers 429 within milliseconds; a short bounded retry hides that from the user.
          for (let attempt = 0; ; attempt += 1) {
            response = await fetchWithTimeout(
              `${endpoint}/v1/generate?${params}`,
              { signal: controller.signal },
              spec.ipRegion ? IP_GENERATION_REQUEST_TIMEOUT_MS : GENERATION_REQUEST_TIMEOUT_MS
            );
            if (response.status !== 429 || attempt >= GENERATION_BUSY_RETRIES) break;
            await abortableDelay(400 * 2 ** attempt, controller.signal);
          }
          if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('API response is not JSON');
          payload = await response.json() as { data?: GenerateResponseData; error?: { code?: string } | string };
          ok = response.ok;
          const drawnId = payload.data?.result?.address.id;
          if (!recentIp || !ok || draw >= 2 || !drawnId || !recentIp.has(drawnId)) break;
        }
      }
      const current = activeRequest.current;
      if (!current || current.requestId !== context.requestId || current.country !== context.country || current.mode !== context.mode) return;
      if (!ok || !payload.data) throw new Error(generationErrorCode(payload.error));
      const expectedMode = generationResponseMode(context.country, overrides.ipRegion);
      if (payload.data.requestId !== context.requestId || payload.data.mode !== expectedMode) return;
      if (!overrides.ipRegion && payload.data.country !== context.country) return;
      if (!overrides.ipRegion && selectionRef.current.country !== context.country) return;
      if (overrides.ipRegion) {
        const nextCountry = payload.data.country;
        userNavigated.current = true;
        selectionRef.current = { country: nextCountry, mode: context.mode };
        window.sessionStorage.setItem(countrySessionKey, nextCountry);
        setCountryCode(nextCountry); setRegion(''); setRegionId(''); setCity(''); setCityId(''); setDistrict(''); setPostcode(''); setPostcodeId('');
        setLocations(emptyLocations); setLocationMeta(emptyLocationMeta);
        updateUrl(nextCountry, 'replace');
        setIpRegionResult({ matchLevel: payload.data.ipMatchLevel, ...payload.data.ipRegion });
        void loadOptions('region', '', { country: nextCountry, residential: nextCountry === 'CN', region: '', regionId: '', city: '', cityId: '' });
        void loadOptions('city', '', { country: nextCountry, residential: nextCountry === 'CN', region: '', regionId: '', city: '', cityId: '' });
      } else {
        setIpRegionResult(null);
        const level = payload.data.filterMatchLevel;
        setFallbackNotice(level === 'nearby' ? t.fallbackNearby : level === 'region' ? t.fallbackRegion : level === 'country' ? t.fallbackCountry : '');
        if (payload.data.eligibleCount) eligibleCounts.current.set(queueKey, payload.data.eligibleCount);
        void fillPrefetchQueue(spec, queueKey);
      }
      rememberAddress(overrides.ipRegion ? `ip:${spec.ip}` : queueKey, payload.data.result.address.id);
      setResult(payload.data.result);
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === 'AbortError') return;
      if (activeRequest.current?.requestId !== context.requestId) return;
      if (!overrides.ipRegion) setResult(null);
      const errorCode = reason instanceof Error ? reason.message : 'API_ERROR';
      setError(t[generationErrorMessageKey(errorCode, Boolean(overrides.ipRegion))]);
    } finally {
      if (activeRequest.current?.requestId === context.requestId) setLoading(false);
    }
  };

  const generateForIp = () => {
    setError('');
    void generate({ ipRegion: true, ip: manualIp, strategy: 'instant' });
  };

  const submit = (event: SyntheticEvent<HTMLFormElement, SubmitEvent>) => { event.preventDefault(); if (!loading) void generate(); };
  const showToastMessage = (kind: 'success' | 'error', message: string) => {
    window.clearTimeout(copyToastTimer.current);
    setCopyToast({ kind, message });
    copyToastTimer.current = window.setTimeout(() => { setCopyToast(null); setCopied(''); }, 2200);
  };
  const showCopyToast = (kind: 'success' | 'error') => showToastMessage(kind, kind === 'success' ? t.copySuccess : t.copyFailed);
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
    cancelGeneration(); cancelLocationFields(['region', 'city', 'district', 'postcode']);
    setLocations(emptyLocations); setLocationMeta(emptyLocationMeta); setLocationLoadState(emptyLocationLoadState); setLocationErrors({});
    const overrides: GenerationOptions = {};
    // A shortcut selects the dropdown option it names, exactly as choosing that option would.
    const option = shortcut.option;
    if (option?.field === 'region' || !option && shortcut.type === 'region') {
      const value = option?.value || shortcut.value;
      const id = option?.id || '';
      setRegion(value); setRegionId(id); setCity(''); setCityId(''); setDistrict(''); setPostcode(''); setPostcodeId('');
      Object.assign(overrides, { region: value, regionId: id, city: '', cityId: '', district: '', postcode: '', postcodeId: '' });
      void loadOptions('city', '', { region: value, regionId: id });
    }
    if (option?.field === 'city' || !option && shortcut.type === 'city') {
      const value = option?.value || shortcut.value;
      const regionValue = option?.regionValue || '';
      const parentId = option?.regionId || '';
      setRegion(regionValue); setRegionId(parentId); setCity(value); setCityId(option?.id || ''); setDistrict(''); setPostcode(''); setPostcodeId('');
      Object.assign(overrides, { region: regionValue, regionId: parentId, city: value, cityId: option?.id || '', district: '', postcode: '', postcodeId: '' });
      if (option) void loadOptions('city', '', { region: regionValue, regionId: parentId });
    }
    // The selected options show their labels once their lists are loaded again.
    if (option) void loadOptions('region', '', { region: '', regionId: '' });
    if (shortcut.type === 'postcode') {
      setRegion(''); setRegionId(''); setCity(''); setCityId(''); setDistrict(''); setPostcode(shortcut.value); setPostcodeId('');
      Object.assign(overrides, { region: '', regionId: '', city: '', cityId: '', district: '', postcode: shortcut.value, postcodeId: '' });
    }
    void generate(overrides);
  };
  const changeAddressLanguage = (language: AddressDisplayLanguage) => {
    setAddressLanguage(language);
    storeDisplayLanguage(addressLanguageStorageKey, language);
  };
  const changeProfileLanguage = (language: ProfileLanguage) => {
    setProfileLanguage(language);
    storeDisplayLanguage(profileLanguageStorageKey, language);
  };
  const toggleFavorite = async () => {
    if (!result) return;
    const id = favoriteIdFor(result);
    try {
      if (favoriteIds.has(id)) {
        await removeFavorite(id);
        showToastMessage('success', favoritesCopy[locale].removed);
      } else {
        await saveFavorite(result);
        showToastMessage('success', favoritesCopy[locale].saved);
      }
      await refreshFavoriteState();
    } catch {
      showToastMessage('error', t.copyFailed);
    }
  };

  // Unified display pipeline for every selected locale: a locale matching the
  // address's own language renders the stored native variant; en/zh-CN render
  // the stored variant only when every semantic component already reads in the
  // target script; every other case goes through the translation endpoint.
  const storedVariantTrusted = Boolean(result) && (addressLanguage === 'en' || addressLanguage === 'zh-CN')
    && storedVariantLooksLocalized(result!.address.componentVariants[addressLanguage], addressLanguage);
  const isChinaPinyin = Boolean(result) && result!.address.countryCode === 'CN' && addressLanguage === 'pinyin';
  const untrustedAddressLanguage = Boolean(result) && !isChinaPinyin && addressLanguage !== 'native'
    && !matchesNativeLanguage(addressLanguage, result!.address.nativeLanguage)
    && !storedVariantTrusted;
  const translationKey = result && untrustedAddressLanguage ? `${result.address.id}:${addressLanguage}` : '';

  useEffect(() => {
    if (!translationKey || !result || addressTranslations[translationKey]) return;
    const controller = new AbortController();
    const request = { addressId: result.address.id, targetLocale: addressLanguage };
    void (async () => {
      let entry: AddressTranslation = { status: 'fallback' };
      try {
        const response = await fetchWithTimeout(`${endpoint}/v1/address-translation`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(request),
          signal: controller.signal
        }, TRANSLATION_REQUEST_TIMEOUT_MS);
        if (response.ok && response.headers.get('content-type')?.includes('application/json')) {
          const payload = await response.json() as { data?: { components?: AddressComponents; lines?: string[]; singleLine?: string } };
          if (payload.data?.components && payload.data.lines?.length && payload.data.singleLine) {
            entry = { status: 'ready', components: payload.data.components, postalLines: payload.data.lines, singleLine: payload.data.singleLine };
          }
        }
      } catch { /* Keep the complete original address available when translation fails. */ }
      if (controller.signal.aborted) return;
      setAddressTranslations((current) => {
        const entries = Object.entries(current);
        const bounded = entries.length >= 60 ? Object.fromEntries(entries.slice(-30)) : current;
        return { ...bounded, [translationKey]: entry };
      });
    })();
    return () => controller.abort();
  }, [translationKey, translationRetry]);

  const translationEntry = translationKey ? addressTranslations[translationKey] : undefined;
  const translationReady = translationEntry?.status === 'ready';
  const translationLoading = Boolean(translationKey) && !translationEntry;
  // An untrusted display locale renders the server translation when it is
  // ready and the complete original address otherwise — never a mixed line.
  const displayedAddressLanguage: AddressDisplayLanguage = untrustedAddressLanguage && !translationReady ? 'native' : addressLanguage;
  const presentation = result
    ? translationReady
      ? { language: 'native' as const, postalLines: translationEntry.postalLines, singleLine: translationEntry.singleLine }
      : addressDisplayPresentation(result, displayedAddressLanguage, locale, result.generatedUnit)
    : undefined;
  const components = result
    ? translationReady
      ? translationEntry.components
      : addressDisplayComponents(result, displayedAddressLanguage)
    : undefined;
  const source = result?.address.evidence[0];
  const profileLocale = resolvedProfileLocale(profileLanguage, countryCode);
  const profileValueText = profileLocale ? messages[profileLocale] : t;
  const profilePresentation = profileLocale ? result?.profilePresentations?.[profileLocale] : undefined;
  const displayedFullName = profilePresentation?.fullName || result?.profile.fullName || '';
  const fullCopy = result && presentation ? [presentation.singleLine, displayedFullName, result.profile.phone, result.profile.email].join('\n') : '';
  const rowProps = { copy, copied, copyLabel: t.copy };
  const profileRowProps = { copy, copied, copyLabel: t.copy };
  const selectedCountryName = localizedCountryName(selectedCountry.code, locale, selectedCountry.name[textLocale]);
  const resultFields = addressSchema.resultFields.map(({ field, label }) => ({ field, label: label[textLocale] }));
  const resultValues: Record<AddressResultField, string | undefined> = {
    country: addressDisplayCountryName(selectedCountry.code, displayedAddressLanguage, locale),
    buildingName: components?.buildingName,
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
  const googleMapEnabled = Boolean(mapDisplay?.googleEnabled);
  const amapMapEnabled = Boolean(mapDisplay?.amapEnabled && mapDisplay.amapConfigured && mapDisplay.amapApiKey && mapDisplay.serviceHost);
  const mapPreviewEnabled = googleMapEnabled || amapMapEnabled;
  const profileCurrency = (amount: number, code: string) => new Intl.NumberFormat(profileLocale || locale, { style: 'currency', currency: code, maximumFractionDigits: 0 }).format(amount);

  return <div className="site-shell">
    <header className="topbar">
      <a className="logo" href={`/${locale}/`}><b>{t.brand}</b></a>
      <nav className="top-links">
        <a className="favorites-link" href={`/${locale}/favorites/`} aria-label={favoritesCopy[locale].title} title={favoritesCopy[locale].title}><Bookmark size={17} aria-hidden="true"/>{favoriteCount > 0 && <span>{favoriteCount > 99 ? '99+' : favoriteCount}</span>}</a>
        <a className="monitor-link" href={`/${locale}/monitor/`}><Activity size={17} aria-hidden="true" /><span>{monitorLabels[locale]}</span></a>
        <a href={`/${locale}/api/`}>{t.apiDocs}</a>
        <select className="language-select" aria-label="Language" value={locale} onChange={(event) => {
          const target = pathForLocale(window.location.pathname, event.target.value as Locale);
          window.location.assign(`${target}${window.location.search}${window.location.hash}`);
        }}>{localeDefinitions.map((definition) => <option key={definition.code} value={definition.code}>{definition.label}</option>)}</select>
        <a className="github-link" href="https://github.com/daimon3332/address" target="_blank" rel="noopener noreferrer" aria-label="GitHub">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 .7a11.5 11.5 0 0 0-3.64 22.4c.58.1.79-.25.79-.56v-2.23c-3.23.7-3.91-1.37-3.91-1.37-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.71.08-.71 1.17.08 1.78 1.2 1.78 1.2 1.04 1.78 2.72 1.27 3.39.97.1-.75.4-1.27.74-1.56-2.58-.3-5.29-1.29-5.29-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.47.11-3.06 0 0 .97-.31 3.16 1.18A10.9 10.9 0 0 1 12 6.08c.98 0 1.95.13 2.86.39 2.2-1.49 3.16-1.18 3.16-1.18.63 1.59.23 2.77.11 3.06.74.81 1.19 1.84 1.19 3.1 0 4.42-2.72 5.39-5.3 5.68.42.36.79 1.07.79 2.15v3.26c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .7Z" /></svg>
        </a>
      </nav>
    </header>

    <main className="container">
      {!countriesReady ? <section className="panel availability-state">{t.loading}</section>
        : !visibleCountries.length ? <section className="panel availability-state">{t.noCountriesAvailable}</section> : <>
      <section className="country-browser" aria-label={t.countryRegion}>
        {countryGroups.map(({ group, countries: items }) => <div className="country-group" key={group}>
          <h2>{t[groupMessage[group]]}</h2><div>{items.map((country) => <button type="button" key={country.code} aria-current={country.code === countryCode ? 'page' : undefined} className={country.code === countryCode ? 'active' : ''} onMouseEnter={() => scheduleCountryPrefetch(country.code)} onMouseLeave={cancelCountryPrefetch} onFocus={() => scheduleCountryPrefetch(country.code)} onClick={() => changeCountry(country.code)}><img className="country-flag" src={`/flags/${country.code.toLowerCase()}.svg`} width="24" height="18" alt="" decoding="async"/>{localizedCountryName(country.code, locale, country.name[textLocale])}</button>)}</div>
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
            <header className="generator-heading"><h1>{generatorTitle(selectedCountryName, locale, residential ? t.residentialMode : t.normalMode)}</h1></header>
            <form className={`filter-grid filters-${filterFields.length}`} onSubmit={submit}>
              {filterFields.includes('region') && <Combobox locale={locale} label={selectedCountry.searchLabels.region[textLocale]} value={region} options={locations.regions} placeholder={t.allRegions} unavailableLabel={t.noAddressOption} loadingLabel={t.loading} errorLabel={locationErrors.region} state={locationLoadState.region} total={locationMeta.region.total} hasMore={Boolean(locationMeta.region.nextCursor)} onOpen={() => void loadOptions('region')} onRetry={() => void loadOptions('region', locationQueries.current.region, locationRetries.current.region)} onLoadMore={() => loadOptions('region', locationQueries.current.region, { cursor: locationMeta.region.nextCursor, append: true })} onSearch={(query) => loadOptions('region', query)} onChange={(value, option) => {
                cancelGeneration(); cancelLocationFields(['city', 'district', 'postcode']);
                setRegion(value); setRegionId(option.id || ''); setCity(''); setCityId(''); setDistrict(''); setPostcode(''); setPostcodeId('');
                setLocations((current) => ({ ...current, cities: [], districts: [], postcodes: [] }));
                setLocationMeta((current) => ({ ...current, city: emptyLocationMeta.city, district: emptyLocationMeta.district, postcode: emptyLocationMeta.postcode }));
                setLocationLoadState((current) => ({ ...current, city: 'idle', district: 'idle', postcode: 'idle' }));
                setLocationErrors((current) => ({ ...current, city: '', district: '', postcode: '' }));
                void loadOptions('city', '', { region: value, regionId: option.id || '' });
              }}/>}
              {filterFields.includes('city') && <Combobox locale={locale} label={selectedCountry.searchLabels.city[textLocale]} value={city} options={locations.cities} placeholder={t.allCities} unavailableLabel={t.noAddressOption} loadingLabel={t.loading} errorLabel={locationErrors.city} state={locationLoadState.city} total={locationMeta.city.total} hasMore={Boolean(locationMeta.city.nextCursor)} onOpen={() => void loadOptions('city')} onRetry={() => void loadOptions('city', locationQueries.current.city, locationRetries.current.city)} onLoadMore={() => loadOptions('city', locationQueries.current.city, { cursor: locationMeta.city.nextCursor, append: true })} onSearch={(query) => loadOptions('city', query)} showContext={!region} onChange={(value, option) => {
                cancelGeneration(); cancelLocationFields(['district', 'postcode']);
                setCity(value); setCityId(option.id || ''); setDistrict(''); setPostcode(''); setPostcodeId('');
                setLocations((current) => ({ ...current, districts: [], postcodes: [] }));
                setLocationMeta((current) => ({ ...current, district: emptyLocationMeta.district, postcode: emptyLocationMeta.postcode }));
                setLocationLoadState((current) => ({ ...current, district: 'idle', postcode: 'idle' }));
                setLocationErrors((current) => ({ ...current, district: '', postcode: '' }));
                if (value && option.regionId && option.regionValue) { setRegion(option.regionValue); setRegionId(option.regionId); }
                if (filterFields.includes('district')) void loadOptions('district', '', { region: option.regionValue || region, regionId: option.regionId || regionId, city: value, cityId: option.id || '' });
                if (filterFields.includes('postcode')) void loadOptions('postcode', '', { region: option.regionValue || region, regionId: option.regionId || regionId, city: value, cityId: option.id || '' });
              }}/>}
              {filterFields.includes('district') && <Combobox locale={locale} label={(selectedCountry.searchLabels.district || selectedCountry.searchLabels.city)[textLocale]} value={district} options={locations.districts} placeholder={t.allCities} unavailableLabel={t.noAddressOption} loadingLabel={t.loading} errorLabel={locationErrors.district} state={locationLoadState.district} total={locationMeta.district.total} hasMore={Boolean(locationMeta.district.nextCursor)} onOpen={() => void loadOptions('district')} onRetry={() => void loadOptions('district', locationQueries.current.district, locationRetries.current.district)} onLoadMore={() => loadOptions('district', locationQueries.current.district, { cursor: locationMeta.district.nextCursor, append: true })} onSearch={(query) => loadOptions('district', query)} showContext={!city} onChange={(value, option) => {
                cancelGeneration();
                setDistrict(value);
                // District names repeat across cities, so a district fixes its own city and province.
                if (value && option.parentValue) { setCity(option.parentValue); setCityId(option.parentId || ''); }
                if (value && option.regionValue) { setRegion(option.regionValue); setRegionId(option.regionId || ''); }
              }}/>}
              {filterFields.includes('postcode') && <Combobox locale={locale} label={selectedCountry.searchLabels.postcode[textLocale]} value={postcode} options={locations.postcodes} placeholder={t.allPostcodes} unavailableLabel={t.noAddressOption} loadingLabel={t.loading} errorLabel={locationErrors.postcode} state={locationLoadState.postcode} total={locationMeta.postcode.total} hasMore={Boolean(locationMeta.postcode.nextCursor)} onOpen={() => void loadOptions('postcode')} onRetry={() => void loadOptions('postcode', locationQueries.current.postcode, locationRetries.current.postcode)} onLoadMore={() => loadOptions('postcode', locationQueries.current.postcode, { cursor: locationMeta.postcode.nextCursor, append: true })} onSearch={(query) => loadOptions('postcode', query)} onChange={(value, option) => {
                cancelGeneration();
                setPostcode(value); setPostcodeId(option.id || '');
              }}/>}
              <button className="generate-button" disabled={loading} type="submit">{loading ? t.generating : t.generate}</button>
            </form>
            {(error || locationError) && <div className="compact-error" role="alert">{error || locationError}</div>}
            {!error && !locationError && fallbackNotice && <div className="compact-notice" role="status">{fallbackNotice}</div>}
          </section>

          {!result && loading && <section className="address-card panel address-skeleton" aria-busy="true" aria-label={t.loading}>
            <span className="skeleton-line wide" /><span className="skeleton-line" /><span className="skeleton-line" /><span className="skeleton-line short" /><span className="skeleton-line wide" />
          </section>}
          {result && presentation && components && <>
            <section className="address-card panel">
              <header className="section-heading"><h2>{t.address}</h2><span className="address-heading-actions"><button type="button" className={`favorite-toggle ${favoriteIds.has(favoriteIdFor(result)) ? 'active' : ''}`} aria-pressed={favoriteIds.has(favoriteIdFor(result))} aria-label={favoritesCopy[locale].save} title={favoritesCopy[locale].save} onClick={() => void toggleFavorite()}><Bookmark aria-hidden="true"/></button><button type="button" className="text-button" onClick={() => void copy('all', fullCopy)}>{copied === 'all' ? t.copied : t.copyAll}</button></span></header>
              <AddressLanguageControl value={addressLanguage} onChange={changeAddressLanguage} locale={locale} countryCode={result.address.countryCode} />
              {translationEntry?.status === 'fallback' && <div className="translation-error compact-notice" role="status">
                <span>{translationErrorText[locale]}</span><button type="button" className="text-button" onClick={() => {
                  setAddressTranslations((current) => { const next = { ...current }; delete next[translationKey]; return next; });
                  setTranslationRetry((value) => value + 1);
                }}>{filterRetryLabel[locale]}</button>
              </div>}
              <div className="address-table" aria-busy={translationLoading || undefined} style={translationLoading ? { opacity: 0.55, transition: 'opacity .2s' } : undefined}>
                {resultFields.map(({ field, label }) => {
                  const value = resultValues[field];
                  return value?.trim() ? <ResultRow key={field} id={field} label={label} value={value} {...rowProps}/> : null;
                })}
              </div>
              <div className="address-format-grid" aria-busy={translationLoading || undefined} style={translationLoading ? { opacity: 0.55, transition: 'opacity .2s' } : undefined}>
                <AddressBlock title={t.standardAddress} copyLabel={copied === 'postal' ? t.copied : t.copy} onCopy={() => void copy('postal', presentation.postalLines.join('\n'))}><address>{presentation.postalLines.map((line, index) => <span key={`${line}-${index}`}>{line}</span>)}</address></AddressBlock>
                <AddressBlock title={t.singleLine} copyLabel={copied === 'single' ? t.copied : t.copy} onCopy={() => void copy('single', presentation.singleLine)}><p>{presentation.singleLine}</p></AddressBlock>
              </div>
              <div className="address-meta">{result.address.matchLevel === 'street' ? <span><b>{t.matchLevel}</b>{t.street}</span> : <span><b>{t.propertyType}</b>{result.address.propertyType === 'apartment' ? t.apartment : result.address.propertyType === 'residential' ? t.residential : t.unknown}</span>}{result.generatedUnit?.provenance === 'synthetic' && <span><b>{t.unitSource}</b>{t.syntheticUnit}</span>}{source && <span><b>{t.source}</b><a href={source.sourceUrl} target="_blank" rel="noreferrer">{source.sourceName}</a></span>}{source?.sourceLicense && <span><b>{t.license}</b>{source.sourceLicenseUrl ? <a href={source.sourceLicenseUrl} target="_blank" rel="noreferrer">{source.sourceLicense}</a> : source.sourceLicense}</span>}</div>
            </section>

            <ProfileLanguageControl value={profileLanguage} onChange={changeProfileLanguage} locale={locale} />

            <div className="details-grid">
              <section className="profile-card panel"><header className="section-heading"><h2>{t.basicProfile}</h2></header><ResultRow id="name" label={t.fullName} value={displayedFullName} {...profileRowProps}/><ResultRow id="gender" label={t.gender} value={profileValueText[result.profile.gender]} {...profileRowProps}/><ResultRow id="birth" label={t.birthDate} value={result.profile.dateOfBirth} {...profileRowProps}/><ResultRow id="phone" label={t.phone} value={result.profile.phone} {...profileRowProps}/><ResultRow id="email" label={t.email} value={result.profile.email} {...profileRowProps}/>{extensions && <><ResultRow id="age" label={t.age} value={String(extensions.basic.age)} {...profileRowProps}/><ResultRow id="honorific" label={t.honorific} value={profileValue(extensions.basic.honorific, profileLanguage, countryCode)} {...profileRowProps}/><ResultRow id="zodiac" label={t.zodiacSign} value={profileValue(extensions.basic.zodiacSign, profileLanguage, countryCode)} {...profileRowProps}/><ResultRow id="height" label={t.height} value={`${extensions.basic.heightCm} cm`} {...profileRowProps}/><ResultRow id="weight" label={t.weight} value={`${extensions.basic.weightKg} kg`} {...profileRowProps}/><ResultRow id="bmi" label={t.bmi} value={String(extensions.basic.bmi)} {...profileRowProps}/><ResultRow id="blood" label={t.bloodType} value={extensions.basic.bloodType} {...profileRowProps}/><ResultRow id="education" label={t.education} value={profileValue(extensions.basic.education, profileLanguage, countryCode)} {...profileRowProps}/></>}</section>
              <section className="card-section panel"><header className="section-heading"><h2>{t.testCard}</h2></header><p className="sandbox-notice">{t.cardNotice}</p><ResultRow id="card-holder" label={t.fullName} value={displayedFullName} {...profileRowProps}/><ResultRow id="card-network" label={t.cardNetwork} value={result.card.network} {...profileRowProps}/><ResultRow id="card" label={t.testCard} value={result.card.number} {...profileRowProps}/><ResultRow id="expiry" label={t.expiry} value={result.card.expiry} {...profileRowProps}/><ResultRow id="cvc" label={t.cvc} value={result.card.cvc} {...profileRowProps}/></section>
            </div>

            {extensions && <div className="extension-grid">
              <section className="extension-section panel">
                <header className="section-heading"><h2>{t.employment}</h2></header>
                <ResultRow id="employment-status" label={t.employmentStatus} value={profileValue(extensions.employment.employmentStatus, profileLanguage, countryCode)} {...profileRowProps}/>
                {hasEmploymentDetails(extensions.employment) && <>
                  <ResultRow id="work-schedule" label={t.workSchedule} value={profileValue(extensions.employment.workSchedule, profileLanguage, countryCode)} {...profileRowProps}/>
                  <ResultRow id="occupation" label={t.occupation} value={profileValue(extensions.employment.occupation, profileLanguage, countryCode)} {...profileRowProps}/>
                  <ResultRow id="company" label={t.company} value={profilePresentation?.company || extensions.employment.company} {...profileRowProps}/>
                  <ResultRow id="department" label={t.department} value={profileValue(extensions.employment.department, profileLanguage, countryCode)} {...profileRowProps}/>
                  <ResultRow id="company-size" label={t.companySize} value={extensions.employment.companySize} {...profileRowProps}/>
                  <ResultRow id="salary" label={t.salary} value={profileCurrency(extensions.employment.salary.amount, extensions.employment.salary.currency)} {...profileRowProps}/>
                </>}
              </section>
              <section className="extension-section panel"><header className="section-heading"><h2>{t.finance}</h2></header><ResultRow id="account-name" label={t.accountDisplayName} value={profilePresentation?.accountDisplayName || extensions.finance.accountDisplayName} {...profileRowProps}/>{extensions.finance.incomeRange && <ResultRow id="income" label={t.incomeRange} value={`${profileCurrency(extensions.finance.incomeRange.min, extensions.finance.incomeRange.currency)} - ${profileCurrency(extensions.finance.incomeRange.max, extensions.finance.incomeRange.currency)}`} {...profileRowProps}/>}<ResultRow id="transaction" label={t.transactionDescription} value={profilePresentation?.transactionDescription || extensions.finance.transactionDescription} {...profileRowProps}/></section>
              <section className="extension-section panel extension-wide"><header className="section-heading"><h2>{t.internetProfile}</h2></header><div className="extension-columns"><div><ResultRow id="username" label={t.username} value={extensions.internet.username} {...profileRowProps}/><ResultRow id="password" label={t.testPassword} value={extensions.internet.testPassword} {...profileRowProps}/><ResultRow id="os" label={t.operatingSystem} value={extensions.internet.os} {...profileRowProps}/><ResultRow id="user-agent" label={t.userAgent} value={extensions.internet.userAgent} {...profileRowProps}/></div><div><ResultRow id="ip" label={t.ipAddress} value={extensions.internet.ipAddress} {...profileRowProps}/><ResultRow id="mac" label={t.macAddress} value={extensions.internet.macAddress} {...profileRowProps}/><ResultRow id="uuid" label={t.uuid} value={extensions.internet.uuid} {...profileRowProps}/><ResultRow id="profile-url" label={t.personalUrl} value={extensions.internet.url} {...profileRowProps}/><ResultRow id="security-question" label={t.securityQuestion} value={profileValue(extensions.internet.securityQuestion, profileLanguage, countryCode)} {...profileRowProps}/><ResultRow id="security-answer" label={t.securityAnswer} value={profilePresentation?.securityAnswer || extensions.internet.securityAnswer} {...profileRowProps}/></div></div></section>
            </div>}

            {mapPreviewEnabled && <section className="map-section panel">
              <header className="section-heading"><h2>{t.mapPreview}</h2><span className="map-links">
                {googleMapEnabled && <><a href={result.googleMaps.openUrl} target="_blank" rel="noreferrer">{t.openGoogle}</a>{result.googleMaps.searchUrl && <a href={result.googleMaps.searchUrl} target="_blank" rel="noreferrer">{t.searchGoogle}</a>}</>}
                {amapMapEnabled && result.googleMaps.amapUrl && <a href={result.googleMaps.amapUrl} target="_blank" rel="noreferrer">{t.openAmap}</a>}
              </span></header>
              <p className="map-hint">{t.mapHint}</p>
              <div className={`map-grid ${googleMapEnabled && amapMapEnabled ? 'map-grid-double' : ''}`}>
                {googleMapEnabled && <article className="map-provider-card"><h3>{t.googleMap}</h3><div className="map-frame" data-map-provider="google"><iframe title={t.googleMap} src={result.googleMaps.embedUrl} loading="lazy" allowFullScreen referrerPolicy="no-referrer-when-downgrade"/></div></article>}
                {amapMapEnabled && mapDisplay?.amapApiKey && mapDisplay.serviceHost && <article className="map-provider-card"><h3>{t.amapMap}</h3><AmapPreview
                  apiKey={mapDisplay.amapApiKey} serviceHost={mapDisplay.serviceHost} countryCode={result.address.countryCode}
                  latitude={result.address.coordinates.latitude} longitude={result.address.coordinates.longitude}
                  label={presentation.singleLine} locale={locale} errorText={t.mapLoadFailed} retryText={filterRetryLabel[locale]}/></article>}
              </div>
            </section>}
          </>}
        </div>

        <aside className="quick-sidebar">
          <ShortcutSection tone="special" title={selectedShortcuts.specialAreaTitle[textLocale] || t.specialAreas} items={selectedShortcuts.specialAreas} locale={locale} apply={applyShortcut}/>
          <ShortcutSection tone="admin" title={t.adminShortcuts} items={selectedShortcuts.adminShortcuts} locale={locale} apply={applyShortcut}/>
          <ShortcutSection tone="cities" title={t.popularCities} items={selectedShortcuts.popularCities} locale={locale} apply={applyShortcut}/>
        </aside>
      </div>
      </>}
    </main>
    {copyToast && <div className={`copy-toast ${copyToast.kind}`} role={copyToast.kind === 'error' ? 'alert' : 'status'} aria-live={copyToast.kind === 'error' ? 'assertive' : 'polite'} aria-atomic="true"><span aria-hidden="true">{copyToast.kind === 'success' ? '✓' : '!'}</span>{copyToast.message}</div>}
    <footer>{t.attribution} · <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">ODbL</a></footer>
  </div>;
}

const translationErrorText: Record<Locale, string> = {
  en: 'Translation is unavailable. Showing the original address.',
  'zh-CN': '翻译暂时不可用，当前显示完整原文。', 'zh-TW': '翻譯暫時無法使用，目前顯示完整原文。',
  ja: '翻訳を利用できません。元の住所を表示しています。', ko: '번역을 사용할 수 없습니다. 원래 주소를 표시합니다.',
  de: 'Übersetzung nicht verfügbar. Die Originaladresse wird angezeigt.',
  fr: 'Traduction indisponible. L’adresse d’origine est affichée.',
  es: 'La traducción no está disponible. Se muestra la dirección original.',
  pt: 'Tradução indisponível. O endereço original é exibido.'
};
const filterRetryLabel: Record<Locale, string> = {
  en: 'Retry', 'zh-CN': '重试', 'zh-TW': '重試', ja: '再試行', ko: '다시 시도',
  de: 'Erneut versuchen', fr: 'Réessayer', es: 'Reintentar', pt: 'Tentar novamente'
};

const optionPageText: Record<Locale, [string, string, string]> = {
  en: ['Previous page', 'Next page', 'Load more'], 'zh-CN': ['上一页', '下一页', '加载更多'], 'zh-TW': ['上一頁', '下一頁', '載入更多'],
  ja: ['前のページ', '次のページ', 'さらに読み込む'], ko: ['이전 페이지', '다음 페이지', '더 불러오기'],
  de: ['Vorherige Seite', 'Nächste Seite', 'Mehr laden'], fr: ['Page précédente', 'Page suivante', 'Charger plus'],
  es: ['Página anterior', 'Página siguiente', 'Cargar más'], pt: ['Página anterior', 'Próxima página', 'Carregar mais']
};

function Combobox({ locale, label, value, options, placeholder, unavailableLabel, loadingLabel, errorLabel, state, total, hasMore = false, clientFilter = false, showContext = false, onOpen, onRetry, onLoadMore, onChange, onSearch }: {
  locale: Locale; label: string; value: string; options: LocationOption[]; placeholder: string; unavailableLabel: string;
  loadingLabel: string; errorLabel?: string; state: LocationLoadState; total: number; hasMore?: boolean; clientFilter?: boolean; showContext?: boolean;
  onOpen?: () => void | Promise<void>; onRetry?: () => void | Promise<void>; onLoadMore?: () => void | Promise<void>;
  onChange: (value: string, option: LocationOption) => void; onSearch?: (query: string) => void | Promise<void>;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  // The input shows the active filter until the user types; only typed text searches.
  const [typing, setTyping] = useState(false);
  // -1 follows the query: the first match while searching, otherwise the selected option.
  const [activeIndex, setActiveIndex] = useState(-1);
  const [renderCount, setRenderCount] = useState(LOCATION_OPTION_RENDER_STEP);
  // The chosen option outlives the loaded page, so reopening still shows and marks it.
  const [chosen, setChosen] = useState<LocationOption | undefined>();
  const searchedQuery = useRef('');
  const onSearchRef = useRef(onSearch);
  const onOpenRef = useRef(onOpen);
  const selected = value ? options.find((option) => option.value === value && (!chosen?.id || !option.id || option.id === chosen.id))
    || (chosen?.value === value ? chosen : { value, label: value }) : undefined;
  const selectedLabel = selected ? locationOptionLabel(selected, locale) : '';
  const text = optionPageText[locale];
  useEffect(() => { onSearchRef.current = onSearch; }, [onSearch]);
  useEffect(() => { onOpenRef.current = onOpen; }, [onOpen]);
  useEffect(() => { if (chosen && chosen.value !== value) setChosen(undefined); }, [value]);
  const searchQuery = typing ? query : '';
  // Loaded options are filtered instantly; the server is asked only when the loaded list is incomplete.
  const complete = !hasMore && total <= options.length;
  useEffect(() => {
    if (!open || clientFilter || !onSearchRef.current) return;
    if (searchedQuery.current === searchQuery || (complete && searchedQuery.current === '')) return;
    const timer = window.setTimeout(() => { searchedQuery.current = searchQuery; void onSearchRef.current?.(searchQuery); }, 150);
    return () => window.clearTimeout(timer);
  }, [searchQuery, open, clientFilter, complete]);
  useEffect(() => { setActiveIndex(-1); setRenderCount(LOCATION_OPTION_RENDER_STEP); }, [searchQuery, clientFilter]);
  const visibleOptions = filterLocationOptions(options, searchQuery)
    .filter((option) => !option.disabled && option.availableCount !== 0);
  const pinned = selected && !searchQuery && !visibleOptions.some((option) => sameLocationOption(selected, option)) ? [selected] : [];
  const renderedOptions = [...pinned, ...visibleOptions.slice(0, renderCount)]
    .map((option) => ({ ...option, label: locationOptionLabel(option, locale) }));
  const values: LocationOption[] = [{ value: '', label: placeholder }, ...renderedOptions];
  const selectedIndex = selected ? values.findIndex((option, index) => index > 0 && sameLocationOption(selected, option)) : 0;
  const currentIndex = activeIndex >= 0 ? Math.min(activeIndex, values.length - 1)
    : searchQuery ? (values.length > 1 ? 1 : 0) : Math.max(0, selectedIndex);
  useEffect(() => {
    if (open) document.getElementById(`${id}-option-${currentIndex}`)?.scrollIntoView({ block: 'nearest' });
  }, [id, currentIndex, open]);
  const showMore = () => {
    if (renderCount < visibleOptions.length) setRenderCount((count) => count + LOCATION_OPTION_RENDER_STEP);
    else if (hasMore && state !== 'loading') void onLoadMore?.();
  };
  const openMenu = () => {
    if (!open) { searchedQuery.current = ''; void onOpenRef.current?.(); setRenderCount(LOCATION_OPTION_RENDER_STEP); setActiveIndex(-1); }
    setOpen(true);
  };
  const select = (option: LocationOption) => {
    setChosen(option.value ? option : undefined); setTyping(false); setQuery('');
    onChange(option.value, option); setOpen(false); setActiveIndex(-1);
  };
  // Leaving the field keeps it truthful: a single exact name match is chosen, anything else reverts to the active filter.
  const leave = () => {
    const exact = exactLocationMatches(visibleOptions, searchQuery, locale);
    setOpen(false);
    if (exact.length === 1) select(exact[0]);
    else setTyping(false);
  };
  const leaveRef = useRef(leave);
  leaveRef.current = leave;
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) leaveRef.current(); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) { openMenu(); return; }
      const next = Math.max(0, Math.min(currentIndex + (event.key === 'ArrowDown' ? 1 : -1), values.length - 1));
      if (next >= values.length - 3) showMore();
      setActiveIndex(next);
    }
    if ((event.key === 'PageDown' || event.key === 'PageUp') && open) {
      event.preventDefault();
      setActiveIndex(Math.max(0, Math.min(currentIndex + (event.key === 'PageDown' ? 10 : -10), values.length - 1)));
    }
    if (event.key === 'Enter' && open) { event.preventDefault(); select(values[currentIndex] || values[0]); }
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false); setTyping(false); }
  };
  return <div className="filter custom-combobox" ref={root} onBlur={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget)) leave();
  }}>
    <label htmlFor={id}>{label}</label>
    <div className={`combobox-control ${open ? 'open' : ''}`}>
      <input id={id} role="combobox" aria-expanded={open} aria-controls={`${id}-list`} aria-activedescendant={open ? `${id}-option-${currentIndex}` : undefined} aria-autocomplete="list" aria-busy={state === 'loading'} value={typing ? query : selectedLabel} placeholder={placeholder} onFocus={openMenu} onChange={(event) => {
        setQuery(event.target.value); setTyping(true); setOpen(true);
      }} onKeyDown={keyDown}/>
      {value && <button type="button" className="combobox-clear" aria-label={`${label}: ${placeholder}`} title={placeholder} onMouseDown={(event) => event.preventDefault()} onClick={() => select(values[0])}><X size={14} aria-hidden="true" /></button>}
      <button type="button" aria-label={label} aria-expanded={open} onMouseDown={(event) => event.preventDefault()} onClick={() => open ? leave() : openMenu()}><ChevronDown size={16} aria-hidden="true" /></button>
    </div>
    {open && <div className="combobox-popup">
      <div className="combobox-options" id={`${id}-list`} role="listbox" aria-label={label} onScroll={(event) => {
        const list = event.currentTarget;
        if (list.scrollTop + list.clientHeight >= list.scrollHeight - 48) showMore();
      }}>
        {values.map((option, index) => <button id={`${id}-option-${index}`} type="button" role="option" tabIndex={-1} aria-selected={index ? sameLocationOption(selected, option) : !value} className={index === currentIndex ? 'active' : ''} key={`${option.id || ''}:${option.value}`} onMouseDown={(event) => event.preventDefault()} onClick={() => select(option)}><span>{index ? highlightMatch(option.label, searchQuery) : option.label}{index > 0 && showContext && option.parentLabel && <em className="combobox-option-context">{option.parentLabel}</em>}</span>{option.availableCount !== undefined && <small>{new Intl.NumberFormat(locale).format(option.availableCount)}</small>}</button>)}
      </div>
      <div className="combobox-status" role="status" aria-live="polite">
        {state === 'loading' ? <span>{loadingLabel}</span>
          : state === 'error' ? <><span>{errorLabel}</span>{onRetry && <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => void onRetry()}>{filterRetryLabel[locale]}</button>}</>
            : <span>{visibleOptions.length ? `${new Intl.NumberFormat(locale).format(visibleOptions.length)} / ${new Intl.NumberFormat(locale).format(searchQuery ? visibleOptions.length : Math.max(total, visibleOptions.length))}` : unavailableLabel}</span>}
        {state !== 'error' && hasMore && onLoadMore && <button type="button" disabled={state === 'loading'} onMouseDown={(event) => event.preventDefault()} onClick={() => void onLoadMore()}>{text[2]}</button>}
      </div>
    </div>}
  </div>;
}
function AddressLanguageControl({ value, onChange, locale, countryCode }: { value: AddressDisplayLanguage; onChange: (language: AddressDisplayLanguage) => void; locale: Locale; countryCode: CountryCode }) {
  const t = messages[locale];
  const otherLanguages = localeDefinitions.filter(({ code }) => code !== 'en' && code !== 'zh-CN');
  const otherSelected = value !== 'native' && value !== 'en' && value !== 'zh-CN';
  return <div className="language-tabs address-language-control" role="group" aria-label={t.address}>
    <button type="button" className={value === 'en' ? 'active' : ''} aria-pressed={value === 'en'} onClick={() => onChange('en')}>{profileLanguageNames.en}</button>
    <button type="button" className={value === 'zh-CN' ? 'active' : ''} aria-pressed={value === 'zh-CN'} onClick={() => onChange('zh-CN')}>{profileLanguageNames['zh-CN']}</button>
    <button type="button" className={value === 'native' ? 'active' : ''} aria-pressed={value === 'native'} onClick={() => onChange('native')}>{t.originalAddress}</button>
    {countryCode === 'CN' && <button type="button" className={value === 'pinyin' ? 'active' : ''} aria-pressed={value === 'pinyin'} onClick={() => onChange('pinyin')}>{locale === 'zh-CN' ? '拼音' : 'Pinyin'}</button>}
    <select className={otherSelected ? 'active' : ''} aria-label={profileLanguageControlText[locale].other} value={otherSelected ? value : ''} onChange={(event) => onChange(event.target.value as Locale)}>
      <option value="" disabled>{profileLanguageControlText[locale].other}</option>
      {otherLanguages.map(({ code }) => <option key={code} value={code}>{profileLanguageNames[code]}</option>)}
    </select>
  </div>;
}
function ProfileLanguageControl({ value, onChange, locale }: { value: ProfileLanguage; onChange: (language: ProfileLanguage) => void; locale: Locale }) {
  const text = profileLanguageControlText[locale];
  const otherLanguages = localeDefinitions.filter(({ code }) => code !== 'en' && code !== 'zh-CN');
  const otherSelected = value !== 'native' && value !== 'en' && value !== 'zh-CN';
  return <div className="profile-language-control panel" role="group" aria-label={text.label}>
    <span>{text.label}</span>
    <div>
      <button type="button" className={value === 'en' ? 'active' : ''} aria-pressed={value === 'en'} onClick={() => onChange('en')}>{profileLanguageNames.en}</button>
      <button type="button" className={value === 'zh-CN' ? 'active' : ''} aria-pressed={value === 'zh-CN'} onClick={() => onChange('zh-CN')}>{profileLanguageNames['zh-CN']}</button>
      <button type="button" className={value === 'native' ? 'active' : ''} aria-pressed={value === 'native'} onClick={() => onChange('native')}>{text.native}</button>
      <select className={otherSelected ? 'active' : ''} aria-label={text.other} value={otherSelected ? value : ''} onChange={(event) => onChange(event.target.value as Locale)}>
        <option value="" disabled>{text.other}</option>
        {otherLanguages.map(({ code }) => <option key={code} value={code}>{profileLanguageNames[code]}</option>)}
      </select>
    </div>
  </div>;
}
function ResultRow({ id, label, value, copy, copied, copyLabel }: { id: string; label: string; value: string; copy: (key: string, value: string) => Promise<void>; copied: string; copyLabel: string }) {
  if (!value.trim()) return null;
  return <div className="result-row"><span>{label}</span><strong onDoubleClick={() => void copy(id, value)}>{value}</strong><button type="button" onClick={() => void copy(id, value)}>{copied === id ? '✓' : copyLabel}</button></div>;
}
function AddressBlock({ title, copyLabel, onCopy, children }: { title: string; copyLabel: string; onCopy: () => void; children: ReactNode }) {
  return <section className="address-block"><header><h3>{title}</h3><button type="button" onClick={onCopy}>{copyLabel}</button></header>{children}</section>;
}
function ShortcutSection({ tone, title, items, locale, apply }: { tone: 'special' | 'admin' | 'cities'; title: string; items: LocationShortcut[]; locale: Locale; apply: (item: LocationShortcut) => void }) {
  if (!items.length) return null;
  return <section className={`shortcut-card shortcut-card-${tone} panel`}><header><h2>{title}</h2></header><div>{items.map((item) => <button type="button" key={`${item.type}-${item.value}`} onClick={() => apply(item)}>{item.label[uiTextLocale(locale)]}</button>)}</div></section>;
}
