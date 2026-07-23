import type { AddressComponents, AddressLanguage, CountryCode } from './types.ts';

export const europeAmericasCountryCodes = [
  'US', 'CA', 'MX', 'GB', 'DE', 'FR', 'IT', 'ES', 'NL', 'RU', 'BR'
] as const satisfies readonly CountryCode[];

export type EuropeAmericasCountryCode = typeof europeAmericasCountryCodes[number];
export type SemanticAddressField =
  | 'buildingName'
  | 'street'
  | 'locality'
  | 'postalLocality'
  | 'dependentLocality'
  | 'district'
  | 'admin1';
export type LocalizationAction = 'preserve' | 'official-name' | 'transliterate' | 'translate';
export type AddressScript = 'Latn' | 'Cyrl' | 'Hans';
export type LocalizationSource =
  | 'provider-target-language'
  | 'official-source-variant'
  | 'catalog-official-name'
  | 'native-component'
  | 'unicode-transliteration'
  | 'component-translation';

export interface AddressVariantPolicy {
  targetLocale: string;
  sourcePriority: readonly LocalizationSource[];
  fields: Readonly<Record<SemanticAddressField, LocalizationAction>>;
  allowedScripts: Readonly<Partial<Record<SemanticAddressField, readonly AddressScript[]>>>;
}

export interface PostalComponentPolicy {
  locality: 'postal-locality-first';
  localityRole: 'postal-city' | 'post-town' | 'locality';
  admin1: 'code' | 'name' | 'omit';
  district: 'dependent-locality' | 'district' | 'omit';
  streetOrder: 'house-first' | 'street-first';
}

export interface EuropeAmericasLocalizationPolicy {
  countryCode: EuropeAmericasCountryCode;
  nativeLocales: readonly string[];
  nativeScript: AddressScript;
  variants: Readonly<Record<AddressLanguage, AddressVariantPolicy>>;
  postal: PostalComponentPolicy;
}

const semanticFields: readonly SemanticAddressField[] = [
  'buildingName', 'street', 'locality', 'postalLocality', 'dependentLocality', 'district', 'admin1'
];

const fieldActions = (
  defaultAction: LocalizationAction,
  overrides: Partial<Record<SemanticAddressField, LocalizationAction>> = {}
): Record<SemanticAddressField, LocalizationAction> => Object.fromEntries(
  semanticFields.map((field) => [field, overrides[field] || defaultAction])
) as Record<SemanticAddressField, LocalizationAction>;

const latinScript: AddressVariantPolicy['allowedScripts'] = {
  street: ['Latn'],
  locality: ['Latn'],
  postalLocality: ['Latn'],
  admin1: ['Latn']
};

const latinChineseScript: AddressVariantPolicy['allowedScripts'] = {
  street: ['Latn'],
  locality: ['Hans', 'Latn'],
  postalLocality: ['Hans', 'Latn'],
  admin1: ['Hans', 'Latn']
};

const nativeVariant = (targetLocale: string, nativeScript: AddressScript): AddressVariantPolicy => ({
  targetLocale,
  sourcePriority: ['official-source-variant', 'provider-target-language', 'native-component'],
  fields: fieldActions('preserve'),
  allowedScripts: nativeScript === 'Cyrl'
    ? { street: ['Cyrl'], locality: ['Cyrl'], postalLocality: ['Cyrl'], admin1: ['Cyrl'] }
    : latinScript
});

const latinEnglishVariant = (nativeEnglish: boolean): AddressVariantPolicy => ({
  targetLocale: 'en',
  sourcePriority: nativeEnglish
    ? ['official-source-variant', 'provider-target-language', 'native-component']
    : ['provider-target-language', 'official-source-variant', 'catalog-official-name', 'native-component'],
  fields: fieldActions('preserve', nativeEnglish ? {} : {
    locality: 'official-name',
    postalLocality: 'official-name',
    admin1: 'official-name'
  }),
  allowedScripts: latinScript
});

const latinChineseVariant = (): AddressVariantPolicy => ({
  targetLocale: 'zh-CN',
  sourcePriority: ['provider-target-language', 'catalog-official-name', 'official-source-variant', 'native-component'],
  fields: fieldActions('preserve', {
    locality: 'official-name',
    postalLocality: 'official-name',
    admin1: 'official-name'
  }),
  allowedScripts: latinChineseScript
});

const postal = (
  localityRole: PostalComponentPolicy['localityRole'],
  admin1: PostalComponentPolicy['admin1'],
  district: PostalComponentPolicy['district'],
  streetOrder: PostalComponentPolicy['streetOrder']
): PostalComponentPolicy => ({ locality: 'postal-locality-first', localityRole, admin1, district, streetOrder });

const latinPolicy = (
  countryCode: Exclude<EuropeAmericasCountryCode, 'RU'>,
  nativeLocales: readonly string[],
  nativeEnglish: boolean,
  postalPolicy: PostalComponentPolicy
): EuropeAmericasLocalizationPolicy => ({
  countryCode,
  nativeLocales,
  nativeScript: 'Latn',
  variants: {
    native: nativeVariant(nativeLocales[0], 'Latn'),
    en: latinEnglishVariant(nativeEnglish),
    'zh-CN': latinChineseVariant()
  },
  postal: postalPolicy
});

const policies: Record<EuropeAmericasCountryCode, EuropeAmericasLocalizationPolicy> = {
  US: latinPolicy('US', ['en-US'], true, postal('postal-city', 'code', 'omit', 'house-first')),
  CA: latinPolicy('CA', ['en-CA', 'fr-CA'], true, postal('locality', 'code', 'omit', 'house-first')),
  MX: latinPolicy('MX', ['es-MX'], false, postal('locality', 'name', 'district', 'street-first')),
  GB: latinPolicy('GB', ['en-GB'], true, postal('post-town', 'omit', 'dependent-locality', 'house-first')),
  DE: latinPolicy('DE', ['de-DE'], false, postal('locality', 'omit', 'omit', 'street-first')),
  FR: latinPolicy('FR', ['fr-FR'], false, postal('locality', 'omit', 'omit', 'street-first')),
  IT: latinPolicy('IT', ['it-IT'], false, postal('locality', 'code', 'omit', 'street-first')),
  ES: latinPolicy('ES', ['es-ES', 'ca-ES', 'eu-ES', 'gl-ES'], false, postal('locality', 'name', 'omit', 'street-first')),
  NL: latinPolicy('NL', ['nl-NL'], false, postal('locality', 'omit', 'omit', 'street-first')),
  RU: {
    countryCode: 'RU',
    nativeLocales: ['ru-RU'],
    nativeScript: 'Cyrl',
    variants: {
      native: nativeVariant('ru-RU', 'Cyrl'),
      en: {
        targetLocale: 'en',
        sourcePriority: ['provider-target-language', 'official-source-variant', 'unicode-transliteration'],
        fields: fieldActions('transliterate'),
        allowedScripts: latinScript
      },
      'zh-CN': {
        targetLocale: 'zh-CN',
        sourcePriority: ['provider-target-language', 'catalog-official-name', 'component-translation'],
        fields: fieldActions('translate'),
        allowedScripts: {
          street: ['Hans'],
          locality: ['Hans'],
          postalLocality: ['Hans'],
          admin1: ['Hans']
        }
      }
    },
    postal: postal('locality', 'name', 'omit', 'street-first')
  },
  BR: latinPolicy('BR', ['pt-BR'], false, postal('locality', 'code', 'district', 'street-first'))
};

export const europeAmericasLocalizationPolicies: Readonly<Record<EuropeAmericasCountryCode, EuropeAmericasLocalizationPolicy>> = policies;

export const europeAmericasLocalizationResearch = {
  reviewedAt: '2026-07-16',
  sources: [
    'https://www.upu.int/en/Postal-Solutions/Programmes-Services/Addressing-Solutions',
    'https://github.com/google/libaddressinput/wiki/AddressValidationMetadata',
    'https://www.unicode.org/reports/tr35/tr35-general.html#Transforms'
  ]
} as const;

export const europeAmericasLocalizationPolicyFor = (
  countryCode: CountryCode
): EuropeAmericasLocalizationPolicy | undefined => policies[countryCode as EuropeAmericasCountryCode];

export const fieldsRequiringLocalization = (
  policy: EuropeAmericasLocalizationPolicy,
  language: AddressLanguage
): SemanticAddressField[] => semanticFields.filter((field) => policy.variants[language].fields[field] !== 'preserve');

export const preserveAddressIdentifiers = (
  source: AddressComponents,
  localized: AddressComponents
): AddressComponents => ({
  ...localized,
  houseNumber: source.houseNumber,
  unit: source.unit,
  postcode: source.postcode,
  admin1Code: source.admin1Code
});

export const postalLocalityFor = (components: AddressComponents): string =>
  components.postalLocality || components.locality;

export const postalAdmin1For = (
  policy: EuropeAmericasLocalizationPolicy,
  components: AddressComponents
): string => policy.postal.admin1 === 'omit'
  ? ''
  : policy.postal.admin1 === 'code'
    ? components.admin1Code || components.admin1 || ''
    : components.admin1 || components.admin1Code || '';

const scriptPattern: Record<AddressScript, RegExp> = {
  Latn: /\p{Script=Latin}/u,
  Cyrl: /\p{Script=Cyrillic}/u,
  Hans: /\p{Script=Han}/u
};

const usesAllowedScripts = (value: string, scripts: readonly AddressScript[]): boolean => {
  const letters = [...value.normalize('NFC')].filter((character) => /\p{Letter}/u.test(character));
  return letters.length === 0 || letters.every((character) => scripts.some((script) => scriptPattern[script].test(character)));
};

export const localizedComponentScriptIssues = (
  policy: EuropeAmericasLocalizationPolicy,
  language: AddressLanguage,
  components: AddressComponents
): SemanticAddressField[] => {
  const allowed = policy.variants[language].allowedScripts;
  return semanticFields.filter((field) => {
    const scripts = allowed[field];
    const value = components[field];
    return Boolean(scripts?.length && value && !usesAllowedScripts(value, scripts));
  });
};
