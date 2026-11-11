import { countryByCode } from './countries';
import { chinaPinyinComponents, formatAddressPresentation, formatChinaPinyinPresentation } from './address-format';
import { localizedCountryName } from './locales';
import { loadPinyin, pinyinReady } from './pinyin-runtime';
import type {
  AddressComponents,
  AddressLanguage,
  AddressPresentation,
  CountryCode,
  GeneratedUnit,
  Locale,
  VerifiedAddress
} from './types';
import type { FavoriteAddressPresentationSource } from './favorites';
export { componentLooksLocalized, storedVariantLooksLocalized } from './address-localization.mjs';

export type AddressDisplayLanguage = 'native' | Locale | 'pinyin';

const primaryLanguage = (tag: string): string => tag.split('-')[0].toLowerCase();
const chineseScript = (tag: string): 'Hans' | 'Hant' =>
  ['zh-TW', 'zh-HK', 'zh-MO'].includes(tag) || tag.includes('Hant') ? 'Hant' : 'Hans';

// A display locale in the address's own language (de → German address,
// pt → Brazilian address, zh-TW → Taiwan/Hong Kong address) renders the stored
// native variant directly — no translation is needed for a same-language target.
export const matchesNativeLanguage = (language: string, nativeLanguage: string): boolean =>
  primaryLanguage(language) === primaryLanguage(nativeLanguage)
  && (primaryLanguage(language) !== 'zh' || chineseScript(language) === chineseScript(nativeLanguage));

// Until the pinyin dictionary has arrived the native form is shown; usePinyinReady re-renders once it is there.
const pinyinRequested = (bundle: FavoriteAddressPresentationSource, language: AddressDisplayLanguage): boolean => {
  if (language !== 'pinyin' || bundle.address.countryCode !== 'CN') return false;
  if (!pinyinReady()) void loadPinyin().catch(() => undefined);
  return pinyinReady();
};

const trustedLanguage = (language: AddressDisplayLanguage, nativeLanguage: string): AddressLanguage | undefined => {
  if (language === 'native' || language === 'en' || language === 'zh-CN') return language;
  return matchesNativeLanguage(language, nativeLanguage) ? 'native' : undefined;
};

export const addressDisplayComponents = (
  bundle: FavoriteAddressPresentationSource,
  language: AddressDisplayLanguage
): AddressComponents => {
  if (pinyinRequested(bundle, language)) return chinaPinyinComponents(bundle.address.componentVariants.native);
  return bundle.address.componentVariants[trustedLanguage(language, bundle.address.nativeLanguage) || 'en']
    || bundle.address.componentVariants.native;
};

export const addressDisplayCountryName = (
  countryCode: CountryCode,
  language: AddressDisplayLanguage,
  fallbackLocale: Locale
): string => {
  const country = countryByCode.get(countryCode);
  if (!country) return countryCode;
  if (language === 'native') return country.nativeName;
  if (language === 'pinyin') return 'Zhongguo';
  if (language === 'en') return country.name.en;
  if (language === 'zh-CN') return country.name['zh-CN'];
  return localizedCountryName(countryCode, language, localizedCountryName(countryCode, fallbackLocale, country.name.en));
};

export const addressDisplayPresentation = (
  bundle: FavoriteAddressPresentationSource,
  language: AddressDisplayLanguage,
  fallbackLocale: Locale,
  generatedUnit?: GeneratedUnit
): AddressPresentation => {
  if (pinyinRequested(bundle, language)) {
    return formatChinaPinyinPresentation(bundle.address.componentVariants.native, '', generatedUnit);
  }
  const trusted = trustedLanguage(language, bundle.address.nativeLanguage);
  if (trusted) {
    const stored = bundle.addressFormats?.[trusted];
    if (stored) return stored;
    const fallback = bundle.addressFormats?.native || bundle.addressFormats?.en || bundle.addressFormats?.['zh-CN'];
    if (fallback) return fallback;
  }

  const source = bundle.addressFormats?.en || bundle.addressFormats?.native || bundle.addressFormats?.['zh-CN'];
  if (!source) return { language: 'native', postalLines: [], singleLine: '' };
  const sourceCountry = source.postalLines.at(-1) || '';
  const countryName = addressDisplayCountryName(bundle.address.countryCode, language, fallbackLocale)
    .toLocaleUpperCase(language);
  const postalLines = source.postalLines.length
    ? [...source.postalLines.slice(0, -1), countryName]
    : [countryName];
  const singleLine = sourceCountry && source.singleLine.endsWith(sourceCountry)
    ? `${source.singleLine.slice(0, -sourceCountry.length)}${countryName}`
    : `${source.singleLine}, ${countryName}`;

  return { ...source, postalLines, singleLine };
};

const latinScriptLocales = new Set<Locale>(['en', 'de', 'fr', 'es', 'pt']);

// Formats fully translated components with the SOURCE country's postal line
// order, then localizes the destination-country line to the target locale.
export const composeTranslatedPresentation = (
  countryCode: CountryCode,
  components: AddressComponents,
  language: Locale,
  fallbackLocale: Locale
): AddressPresentation => {
  const formatLanguage: AddressLanguage = latinScriptLocales.has(language) ? 'en' : 'native';
  const draft = {
    countryCode,
    componentVariants: { native: components, en: components, 'zh-CN': components }
  } as unknown as VerifiedAddress;
  const source = formatAddressPresentation(draft, formatLanguage, '');
  const country = countryByCode.get(countryCode);
  const countryName = addressDisplayCountryName(countryCode, language, fallbackLocale).toLocaleUpperCase(language);
  const comparable = (value: string): string => value.normalize('NFKC').toLocaleLowerCase('en').trim();
  const sourceCountry = source.postalLines.at(-1) || '';
  const hasCountryLine = Boolean(country) && [country!.nativeName, country!.name.en, country!.name['zh-CN']]
    .some((name) => comparable(name) === comparable(sourceCountry));
  const postalLines = hasCountryLine
    ? [...source.postalLines.slice(0, -1), countryName]
    : [...source.postalLines, countryName];
  const singleLine = hasCountryLine && source.singleLine.endsWith(sourceCountry)
    ? `${source.singleLine.slice(0, -sourceCountry.length)}${countryName}`
    : `${source.singleLine}, ${countryName}`;
  return { language: formatLanguage, postalLines, singleLine };
};
