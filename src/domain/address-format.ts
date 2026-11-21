import { countryByCode } from './countries.ts';
import { chinaPinyinComponent } from './china-address-language';
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

const sourceUnit = (countryCode: CountryCode, value: string | undefined, language: AddressLanguage): string => {
  const unit = (value || '').trim();
  if (!/^\d+[A-Za-z]?$/u.test(unit)) return unit;
  if (language === 'zh-CN') return `${unit}室`;
  if (countryCode === 'JP' && language === 'native') return `${unit}号室`;
  if (countryCode === 'KR' && language === 'native') return `${unit}호`;
  if (['HK', 'TW'].includes(countryCode) && language === 'native') return `${unit}室`;
  const prefixes: Partial<Record<CountryCode, string>> = {
    US: 'Apt', GB: 'Flat', IN: 'Flat', CA: 'Unit', AU: 'Unit', SG: 'Unit', MY: 'Unit',
    PH: 'Unit', ZA: 'Unit', DE: 'Wohnung', FR: 'Appartement', IT: 'Interno', ES: 'Piso',
    NL: 'Appartement', MX: 'Depto.', BR: 'Apto.', TR: 'Daire', RU: 'кв.'
  };
  return `${prefixes[countryCode] || 'Unit'} ${unit}`;
};

const addressLine = (countryCode: CountryCode, components: AddressComponents, language: AddressLanguage): string => {
  const renderedUnit = sourceUnit(countryCode, components.unit, language);
  const unit = renderedUnit ? ` ${renderedUnit}` : '';
  if (countryCode === 'CN' && language !== 'en') {
    return `${components.street}${components.houseNumber}${chinaHouseNumberSuffix(components.houseNumber)}${renderedUnit}`;
  }
  if (countryCode === 'HK' && language !== 'en') {
    return `${components.street}${components.houseNumber}${hongKongHouseNumberSuffix(components.houseNumber)}${renderedUnit}`;
  }
  if (countryCode === 'KR' && language !== 'en') return `${components.street} ${components.houseNumber}${unit}`;
  if (eastAsian.has(countryCode) && language !== 'en') return `${components.street}${components.houseNumber}${renderedUnit}`;
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

const chineseDigits: Record<string, number> = { 〇: 0, 零: 0, 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const chineseNumber = (value: string): number | undefined => {
  if (/^\d+$/u.test(value)) return Number(value);
  const match = /^([一二兩三四五六七八九])?(十)?([〇零一二兩三四五六七八九])?$/u.exec(value);
  if (!match || !value) return undefined;
  const [, tens, ten, ones] = match;
  if (!ten) return tens && ones ? undefined : chineseDigits[tens || ones];
  return (tens ? chineseDigits[tens] : 1) * 10 + (ones ? chineseDigits[ones] : 0);
};

// Taiwanese house numbers in Chunghwa Post English: 34號 with unit 之1 is "No. 34-1", 四樓之2 is "4F.-2", 地下一樓 (or
// 地下一層) is "B1F.", a bare room number is "Rm. 5", 之1三樓 is "No. 34-1, 3F.", 底層 (ground floor) is "1F." and an
// unnumbered 地下 is "Basement". Returns undefined when the native parts follow no such pattern.
const taiwanFloor = (value: string): string | undefined => {
  const basement = /^地下(?:室|層)?(?:之(\d+))?$/u.exec(value);
  if (basement) return `Basement${basement[1] ? `-${basement[1]}` : ''}`;
  const ground = /^底一?層(?:之(\d+))?$/u.exec(value);
  if (ground) return `1F.${ground[1] ? `-${ground[1]}` : ''}`;
  const floor = /^(地下)?第?(\S+?)[樓層](?:之(\d+))?$/u.exec(value);
  const number = floor ? chineseNumber(floor[2]) : undefined;
  return number === undefined ? undefined : `${floor![1] ? 'B' : ''}${number}F.${floor![3] ? `-${floor![3]}` : ''}`;
};

export const taiwanEnglishPremise = (houseNumber: string, unit: string): { houseNumber: string; unit: string } | undefined => {
  const house = /^(\d+)(?:之(\d+))?號?(?:之(\d+))?$/u.exec(houseNumber.trim());
  if (!house) return houseNumber.trim() ? undefined : { houseNumber: '', unit: '' };
  let sub = house[2] || house[3] || '';
  let room = '';
  const rest = unit.trim();
  const subUnit = /^之(\d+)號?$/u.exec(rest);
  const subFloor = /^之(\d+)(.+)$/u.exec(rest);
  if (subUnit && !sub) sub = subUnit[1];
  else if (/^\d+$/u.test(rest)) room = `Rm. ${rest}`;
  else if (subFloor && !sub && taiwanFloor(subFloor[2])) {
    sub = subFloor[1];
    room = taiwanFloor(subFloor[2])!;
  } else if (rest) {
    const floor = taiwanFloor(rest);
    if (!floor) return undefined;
    room = floor;
  }
  return { houseNumber: `No. ${house[1]}${sub ? `-${sub}` : ''}`, unit: room };
};

const chinaEnglishHouseNumber = (value: string): string =>
  value.replace(/(?:号|號|弄)$/u, '');

export const chinaPinyinComponents = (components: AddressComponents): AddressComponents => Object.fromEntries(
  Object.entries(components).map(([field, value]) => [
    field,
    ['postcode', 'admin1Code'].includes(field) ? value
      : field === 'houseNumber' && value && !/\p{Script=Han}/u.test(value) ? `${value} Hao`
      : chinaPinyinComponent(String(value || ''))
  ])
) as AddressComponents;

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
    const singleLine = `${administrative}${delivery}${components.postcode ? ` 邮编${components.postcode}` : ''}`;
    return {
      language,
      postalLines: [administrative, delivery, components.postcode ? `邮编${components.postcode}` : '', recipient].map(cleanLine).filter(Boolean),
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
  if (components.postcode) deliveryLines.splice(deliveryLines.length - 1, 0, components.postcode);
  return {
    language,
    postalLines: [withoutHan(recipient), ...deliveryLines].filter(Boolean),
    singleLine: deliveryLines.join(', ')
  };
};

export const formatChinaPinyinPresentation = (
  components: AddressComponents,
  recipient: string,
  generatedUnit?: GeneratedUnit
): AddressPresentation => {
  const pinyinComponents = chinaPinyinComponents(components);
  const administration = uniquePlaces([pinyinComponents.admin1, pinyinComponents.locality,
    pinyinComponents.district, pinyinComponents.dependentLocality]);
  const delivery = [
    pinyinComponents.street,
    pinyinComponents.houseNumber,
    pinyinComponents.buildingName,
    generatedUnit ? `${generatedUnit.components.building} Dong ${generatedUnit.components.unit} Danyuan ${generatedUnit.components.room} Shi` : pinyinComponents.unit
  ].filter(Boolean).join(' ');
  const lines = [delivery, ...administration, pinyinComponents.postcode, 'Zhongguo'].filter(Boolean);
  return { language: 'native', postalLines: [recipient, ...lines].filter((value): value is string => Boolean(value)), singleLine: lines.join(', ') };
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
    D: countryCode === 'JP' && dependentLocality && (components.street || '').startsWith(dependentLocality) ? '' : distinctFromStreet(dependentLocality),
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
