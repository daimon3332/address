import { countryByCode } from './countries.ts';
import type {
  AddressComponents,
  AddressLanguage,
  AddressPresentation,
  CountryCode,
  GeneratedUnit,
  VerifiedAddress
} from './types.ts';

const eastAsian = new Set<CountryCode>(['JP', 'HK', 'TW', 'KR', 'CN']);
const houseFirst = new Set<CountryCode>(['US', 'CA', 'GB', 'FR', 'SG', 'MY', 'PH', 'IN', 'AU', 'NG', 'ZA', 'SA', 'VN', 'TH']);

const chinaHouseNumberSuffix = (houseNumber: string): string =>
  /^[0-9][0-9-]*$/.test(houseNumber) ? '号' : '';

const hongKongHouseNumberSuffix = (houseNumber: string): string =>
  /^[0-9][0-9-]*$/.test(houseNumber) ? '號' : '';

const addressLine = (countryCode: CountryCode, components: AddressComponents, language: AddressLanguage): string => {
  const unit = components.unit ? ` ${components.unit}` : '';
  if (countryCode === 'CN' && language !== 'en') {
    return `${components.street}${components.houseNumber}${chinaHouseNumberSuffix(components.houseNumber)}${components.unit || ''}`;
  }
  if (countryCode === 'HK' && language !== 'en') {
    return `${components.street}${components.houseNumber}${hongKongHouseNumberSuffix(components.houseNumber)}${components.unit || ''}`;
  }
  if (countryCode === 'KR' && language !== 'en') return `${components.street} ${components.houseNumber}${components.unit ? ` ${components.unit}` : ''}`;
  if (eastAsian.has(countryCode) && language !== 'en') return `${components.street}${components.houseNumber}${components.unit || ''}`;
  if (countryCode === 'HK' && language === 'en') return `${components.houseNumber} ${components.street}${unit}`;
  if (countryCode === 'TR') {
    const house = /^no[:.]?\s*/iu.test(components.houseNumber) ? components.houseNumber : `No:${components.houseNumber}`;
    return components.houseNumber ? `${components.street} ${house}${unit}` : `${components.street}${unit}`;
  }
  if (houseFirst.has(countryCode)) return `${components.houseNumber} ${components.street}${unit}`;
  return `${components.street} ${components.houseNumber}${unit}`;
};

const comparablePlace = (value: string): string => value
  .normalize('NFKC')
  .toLocaleLowerCase('en')
  .replace(/[^\p{L}\p{N}]+/gu, '');

const samePlace = (left: string | undefined, right: string | undefined): boolean =>
  Boolean(left && right && comparablePlace(left) === comparablePlace(right));

const postalAdmin1 = (countryCode: CountryCode, components: AddressComponents): string => {
  const country = countryByCode.get(countryCode);
  if (!country || country.addressSchema.postalAdmin1Style === 'name') return components.admin1 || '';
  if (components.admin1Code) return components.admin1Code;
  const admin1 = components.admin1 || '';
  const match = country.adminShortcuts.find((shortcut) =>
    [shortcut.value, shortcut.label.en, shortcut.label['zh-CN']].some((value) => samePlace(value, admin1))
  );
  if (match) return match.value;
  if (countryCode === 'US' && ['districtofcolumbia', 'washingtondc'].includes(comparablePlace(admin1))) return 'DC';
  return admin1;
};

const destinationCountry = (countryCode: CountryCode, language: AddressLanguage): string => {
  const country = countryByCode.get(countryCode);
  if (!country) return countryCode;
  const name = language === 'native'
    ? country.nativeName
    : language === 'en'
      ? country.name.en
      : country.name['zh-CN'];
  return language === 'zh-CN' ? name : name.toLocaleUpperCase(country.nativeLanguage);
};

const cleanLine = (value: string): string => value
  .replace(/\s+/g, ' ')
  .replace(/\s+([,/])/g, '$1')
  .replace(/([,/])\s*\1+/g, '$1')
  .replace(/^[\s,/-]+|[\s,/-]+$/g, '')
  .trim();

const uniquePlaces = (values: Array<string | undefined>): string[] => {
  const seen = new Set<string>();
  return values.flatMap((value) => {
    const cleaned = cleanLine(value || '');
    if (!cleaned) return [];
    const key = comparablePlace(cleaned);
    if (seen.has(key)) return [];
    seen.add(key);
    return [cleaned];
  });
};

const chinaEnglishHouseNumber = (value: string): string =>
  value.replace(/(?:号|號|弄)$/u, '');

const formatChinaPresentation = (
  components: AddressComponents,
  language: AddressLanguage,
  recipient: string,
  generatedUnit?: GeneratedUnit
): AddressPresentation => {
  if (language !== 'en') {
    const streetKey = comparablePlace(components.street || '');
    const administrative = uniquePlaces([
      components.admin1,
      components.postalLocality || components.locality,
      components.district,
      components.dependentLocality
    ]).filter((value) => !streetKey || comparablePlace(value) !== streetKey).join('');
    const delivery = [
      `${components.street}${components.houseNumber}${chinaHouseNumberSuffix(components.houseNumber)}`,
      components.buildingName,
      generatedUnit?.variants[language] || components.unit
    ].map((value) => cleanLine(value || '')).filter(Boolean).join('');
    const singleLine = `${administrative}${delivery}`;
    return {
      language,
      postalLines: [administrative, delivery, recipient].map(cleanLine).filter(Boolean),
      singleLine
    };
  }

  const withoutHan = (value: string | undefined): string => {
    const cleaned = cleanLine(value || '');
    return /[\u3400-\u9fff]/u.test(cleaned) ? '' : cleaned;
  };
  const houseNumber = withoutHan(chinaEnglishHouseNumber(components.houseNumber));
  const street = withoutHan(components.street);
  const addressLine = cleanLine([houseNumber, street].filter(Boolean).join(' '));
  const administrative = uniquePlaces([
    components.dependentLocality,
    components.district,
    components.postalLocality || components.locality,
    components.admin1
  ]).map(withoutHan).filter(Boolean);
  const deliveryLines = [
    generatedUnit?.variants.en || withoutHan(components.unit),
    withoutHan(components.buildingName),
    addressLine,
    ...administrative,
    'CHINA'
  ].filter(Boolean);
  return {
    language,
    postalLines: [withoutHan(recipient), ...deliveryLines].filter(Boolean),
    singleLine: deliveryLines.join(', ')
  };
};

// Countries whose synthetic unit is merged into the street line of the postal
// output. GB flats lead the line; the rest trail it (or concatenate for CJK).
const unitMergeCountries = new Set<CountryCode>(['HK', 'SG', 'JP', 'KR', 'TW', 'GB', 'US', 'CA']);

const render = (
  template: string,
  countryCode: CountryCode,
  components: AddressComponents,
  recipient: string,
  language: AddressLanguage,
  generatedUnit?: GeneratedUnit
): string[] => {
  const syntheticUnit = !components.unit && generatedUnit && unitMergeCountries.has(countryCode)
    ? generatedUnit.variants[language] || generatedUnit.variants.native
    : '';
  const lineComponents = syntheticUnit && countryCode !== 'GB'
    ? { ...components, unit: syntheticUnit }
    : components;
  const baseLine = addressLine(countryCode, lineComponents, language);
  const admin1 = postalAdmin1(countryCode, components);
  const locality = components.postalLocality || components.locality;
  const dependentLocality = components.dependentLocality || components.district || '';
  const streetKey = comparablePlace(components.street || '');
  const distinctFromStreet = (value: string): string =>
    streetKey && comparablePlace(value) === streetKey ? '' : value;
  const fields: Record<string, string> = {
    N: recipient,
    O: components.buildingName || '',
    A: syntheticUnit && countryCode === 'GB' ? `${syntheticUnit}, ${baseLine}` : baseLine,
    C: ['CN', 'HK', 'SG'].includes(countryCode) && template.includes('%S') && samePlace(locality, admin1) ? '' : distinctFromStreet(locality),
    S: distinctFromStreet(admin1),
    D: distinctFromStreet(dependentLocality),
    Z: components.postcode
  };
  const seen = new Set<string>();
  return template
    .split('%n')
    .map((line) => cleanLine(line.replace(/%([NOACSDZ])/g, (_, key: string) => fields[key] || '')))
    .map((line) => (line === '〒' || line === '()' ? '' : line))
    .filter((line) => {
      if (!line) return false;
      const key = comparablePlace(line);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
};

export const formatAddressPresentation = (
  address: VerifiedAddress,
  language: AddressLanguage,
  recipient: string,
  generatedUnit?: GeneratedUnit
): AddressPresentation => {
  const country = countryByCode.get(address.countryCode);
  if (!country) throw new Error(`Missing country configuration: ${address.countryCode}`);
  const components = address.componentVariants[language];
  if (address.countryCode === 'CN') {
    return formatChinaPresentation(components, language, recipient, generatedUnit);
  }
  const template = language === 'en' && country.addressFormat.latin
    ? country.addressFormat.latin
    : country.addressFormat.native;
  const countryLine = destinationCountry(address.countryCode, language);
  const appendCountry = (lines: string[]): string[] => [
    ...lines.filter((line) => !samePlace(line, countryLine)),
    countryLine
  ];
  const postalLines = appendCountry(render(template, address.countryCode, components, recipient, language, generatedUnit));
  const singleLine = appendCountry(render(template, address.countryCode, components, '', language, generatedUnit)).join(', ');
  return { language, postalLines, singleLine };
};

export const formatAllAddressPresentations = (
  address: VerifiedAddress,
  recipient: string,
  generatedUnit?: GeneratedUnit
): Record<AddressLanguage, AddressPresentation> => ({
  native: formatAddressPresentation(address, 'native', recipient, generatedUnit),
  en: formatAddressPresentation(address, 'en', recipient, generatedUnit),
  'zh-CN': formatAddressPresentation(address, 'zh-CN', recipient, generatedUnit)
});
