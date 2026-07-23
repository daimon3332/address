import { describe, expect, it } from 'vitest';
import { formatAddressPresentation } from '../src/domain/address-format';
import { countries } from '../src/domain/countries';
import type { AddressComponents, CountryCode, VerifiedAddress } from '../src/domain/types';
import { localizeAddress } from '../server/api/services/address-localizer';

const nativeStreets: Record<CountryCode, string> = {
  US: 'Main Street', CA: 'King Street', MX: 'Avenida Reforma', GB: 'High Street', DE: 'Hauptstraße',
  FR: 'Rue de Rivoli', IT: 'Via Roma', ES: 'Calle Mayor', NL: 'Damrak', RU: 'Тверская улица',
  JP: '桜通り', HK: '皇后大道中', SG: 'Orchard Road', TW: '信義路', KR: '세종대로',
  MY: 'Jalan Ampang', CN: '人民路', TH: 'ถนนสุขุมวิท', PH: 'Rizal Avenue', VN: 'Đường Nguyễn Huệ',
  TR: 'Atatürk Caddesi', SA: 'شارع الملك فهد', IN: 'MG Road', AU: 'George Street',
  BR: 'Avenida Paulista', NG: 'Broad Street', ZA: 'Long Street'
};

const englishStreets: Record<CountryCode, string> = {
  ...nativeStreets,
  MX: 'Reforma Avenue', DE: 'Main Street', FR: 'Rivoli Street', IT: 'Rome Street', ES: 'Main Street',
  NL: 'Damrak Street', RU: 'Tverskaya Street', JP: 'Sakura Street', HK: "Queen's Road Central",
  TW: 'Xinyi Road', KR: 'Sejong-daero', CN: 'Renmin Road', TH: 'Sukhumvit Road',
  VN: 'Nguyen Hue Street', TR: 'Ataturk Avenue', SA: 'King Fahd Road', BR: 'Paulista Avenue'
};

const postcodes: Record<CountryCode, string> = {
  US: '10001', CA: 'M5V 3A8', MX: '06600', GB: 'SW1A 1AA', DE: '10115', FR: '75001', IT: '00184',
  ES: '28013', NL: '1012 JS', RU: '101000', JP: '100-0001', HK: '', SG: '238823', TW: '110',
  KR: '03154', MY: '50000', CN: '100000', TH: '10110', PH: '1000', VN: '700000', TR: '34000',
  SA: '12345', IN: '560001', AU: '2000', BR: '01310-100', NG: '100001', ZA: '8001'
};

const adminCodes: Partial<Record<CountryCode, string>> = {
  US: 'NY', CA: 'ON', AU: 'NSW', BR: 'SP'
};

const scriptPolicy: Partial<Record<CountryCode, RegExp>> = {
  RU: /[\u0400-\u04ff]/u,
  JP: /[\u3040-\u30ff\u3400-\u9fff]/u,
  HK: /[\u3400-\u9fff]/u,
  TW: /[\u3400-\u9fff]/u,
  KR: /[\uac00-\ud7af]/u,
  CN: /[\u3400-\u9fff]/u,
  TH: /[\u0e00-\u0e7f]/u,
  SA: /[\u0600-\u06ff]/u
};

const nonEnglishNative = new Set<CountryCode>([
  'MX', 'DE', 'FR', 'IT', 'ES', 'NL', 'RU', 'JP', 'HK', 'TW', 'KR', 'CN', 'TH', 'VN', 'TR', 'SA', 'BR'
]);

const normalized = (value: string): string => value.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const digits = (value: string): string => value.replace(/\D/g, '');

const sampleAddress = (code: CountryCode): VerifiedAddress => {
  const country = countries.find((item) => item.code === code)!;
  const city = country.popularCities[0];
  const admin = country.adminShortcuts[0];
  const specialPlaces: Partial<Record<CountryCode, {
    nativeLocality: string; enLocality: string; zhLocality: string;
    nativeAdmin: string; enAdmin: string; zhAdmin: string;
  }>> = {
    IN: { nativeLocality: 'Bengaluru', enLocality: 'Bengaluru', zhLocality: '班加罗尔', nativeAdmin: 'Karnataka', enAdmin: 'Karnataka', zhAdmin: '卡纳塔克邦' },
    SA: { nativeLocality: 'الرياض', enLocality: 'Riyadh', zhLocality: '利雅得', nativeAdmin: 'منطقة الرياض', enAdmin: 'Riyadh Province', zhAdmin: '利雅得省' },
    AU: { nativeLocality: 'Sydney', enLocality: 'Sydney', zhLocality: '悉尼', nativeAdmin: 'New South Wales', enAdmin: 'New South Wales', zhAdmin: '新南威尔士州' },
    NG: { nativeLocality: 'Lagos', enLocality: 'Lagos', zhLocality: '拉各斯', nativeAdmin: 'Lagos State', enAdmin: 'Lagos State', zhAdmin: '拉各斯州' },
    ZA: { nativeLocality: 'Cape Town', enLocality: 'Cape Town', zhLocality: '开普敦', nativeAdmin: 'Western Cape', enAdmin: 'Western Cape', zhAdmin: '西开普省' }
  };
  const place = specialPlaces[code];
  const base = (street: string, locality: string, admin1: string): AddressComponents => ({
    houseNumber: '42', street, locality, admin1, admin1Code: adminCodes[code], postcode: postcodes[code]
  });
  const componentVariants = {
    native: base(nativeStreets[code], place?.nativeLocality || city?.value || country.nativeName, place?.nativeAdmin || admin?.value || ''),
    en: base(englishStreets[code], place?.enLocality || city?.label.en || country.name.en, place?.enAdmin || admin?.label.en || ''),
    'zh-CN': base(`示例街道 42`, place?.zhLocality || city?.label['zh-CN'] || country.name['zh-CN'], place?.zhAdmin || admin?.label['zh-CN'] || '')
  };
  return {
    id: `localization-matrix-${code.toLowerCase()}`,
    countryCode: code,
    nativeAddress: '', formattedAddress: '', nativeLanguage: country.nativeLanguage,
    addressVariants: { native: '', en: '', 'zh-CN': '' },
    components: componentVariants.native,
    componentVariants,
    coordinates: country.fallbackCenter,
    addressStatus: 'verified', propertyType: 'residential', unitStatus: 'building_only',
    matchLevel: 'premise', verificationLevel: 'L2', sourceVersion: 'matrix-v1', sourceUpdatedAt: '2026-07-16',
    verifiedAt: '2026-07-16', expiresAt: '2026-07-23',
    evidence: [{
      sourceId: 'localization-matrix', sourceName: 'Localization matrix', sourceUrl: 'https://example.test/',
      sourceFamily: 'fixture', type: 'address_existence', value: 'fixture', observedAt: '2026-07-16'
    }],
    exclusionFlags: []
  };
};

describe('27-country localization QA matrix', () => {
  it('keeps three independent variants, required scripts and postal identifiers', async () => {
    for (const country of countries) {
      const localized = await localizeAddress(sampleAddress(country.code), country, {});
      const variants = localized.componentVariants;
      expect(variants.native, country.code).not.toBe(variants.en);
      expect(variants.en, country.code).not.toBe(variants['zh-CN']);
      expect(localized.addressVariants.en, country.code).toMatch(/[A-Za-z]/u);
      expect(localized.addressVariants['zh-CN'], country.code).toMatch(/[\u3400-\u9fff]/u);
      expect(localized.addressVariants['zh-CN'], country.code).not.toBe(localized.addressVariants.en);
      if (nonEnglishNative.has(country.code)) {
        expect(localized.addressVariants.native, country.code).not.toBe(localized.addressVariants.en);
      }
      const expectedScript = scriptPolicy[country.code];
      if (expectedScript) expect(localized.addressVariants.native, country.code).toMatch(expectedScript);
      for (const language of ['native', 'en', 'zh-CN'] as const) {
        expect(digits(variants[language].houseNumber), `${country.code}:${language}:house`).toBe('42');
        expect(variants[language].postcode.replace(/\s/g, '').toUpperCase(), `${country.code}:${language}:postcode`)
          .toBe(postcodes[country.code].replace(/\s/g, '').toUpperCase());
        expect(variants[language].admin1Code, `${country.code}:${language}:admin-code`).toBe(adminCodes[country.code]);
      }
    }
  });

  it('formats one destination-country line and no duplicate postal lines', async () => {
    for (const country of countries) {
      const localized = await localizeAddress(sampleAddress(country.code), country, {});
      for (const language of ['native', 'en', 'zh-CN'] as const) {
        const presentation = formatAddressPresentation(localized, language, 'QA Recipient');
        const expectedCountry = language === 'native'
          ? country.nativeName
          : language === 'en' ? country.name.en : country.name['zh-CN'];
        const normalizedLines = presentation.postalLines.map(normalized);
        const countryLineCount = country.code === 'CN' && language !== 'en' ? 0 : 1;
        expect(normalizedLines.filter((line) => line === normalized(expectedCountry)), `${country.code}:${language}:country`).toHaveLength(countryLineCount);
        expect(new Set(normalizedLines).size, `${country.code}:${language}:duplicate-line`).toBe(normalizedLines.length);
        if (country.code === 'CN') {
          expect(presentation.singleLine, `${country.code}:${language}:postcode`).not.toContain(postcodes.CN);
        } else if (postcodes[country.code]) {
          expect(presentation.singleLine, `${country.code}:${language}:postcode`).toContain(postcodes[country.code]);
        }
      }
    }
  });
});

describe('IN / SA / AU / NG / ZA researched postal invariants', () => {
  it('places India PIN after the locality and before the state', async () => {
    const country = countries.find(({ code }) => code === 'IN')!;
    const lines = formatAddressPresentation(await localizeAddress(sampleAddress('IN'), country, {}), 'en', 'QA');
    expect(lines.postalLines).toContain('Bengaluru 560001');
    expect(lines.postalLines.indexOf('Bengaluru 560001')).toBeLessThan(lines.postalLines.indexOf('Karnataka'));
  });

  it('keeps Saudi native Arabic with the five-digit postcode above its locality', async () => {
    const country = countries.find(({ code }) => code === 'SA')!;
    const localized = await localizeAddress(sampleAddress('SA'), country, {});
    const native = formatAddressPresentation(localized, 'native', 'QA');
    expect(native.singleLine).toMatch(/[\u0600-\u06ff]/u);
    expect(native.postalLines).toContain('12345');
    expect(native.postalLines).toContain('الرياض');
    expect(native.postalLines.indexOf('12345')).toBeLessThan(native.postalLines.indexOf('الرياض'));
  });

  it('uses the mandatory Australian state abbreviation before its four-digit postcode', async () => {
    const country = countries.find(({ code }) => code === 'AU')!;
    expect(country.addressSchema.postalAdmin1Style).toBe('code');
    const lines = formatAddressPresentation(await localizeAddress(sampleAddress('AU'), country, {}), 'en', 'QA');
    expect(lines.postalLines).toContain('Sydney NSW 2000');
  });

  it('keeps the Nigerian six-digit postcode with locality and state on the following line', async () => {
    const country = countries.find(({ code }) => code === 'NG')!;
    const lines = formatAddressPresentation(await localizeAddress(sampleAddress('NG'), country, {}), 'en', 'QA');
    expect(lines.postalLines).toContain('Lagos 100001');
    expect(lines.postalLines.indexOf('Lagos 100001')).toBeLessThan(lines.postalLines.indexOf('Lagos State'));
  });

  it('keeps the South African four-digit postcode as a separate postal line', async () => {
    const country = countries.find(({ code }) => code === 'ZA')!;
    const lines = formatAddressPresentation(await localizeAddress(sampleAddress('ZA'), country, {}), 'en', 'QA');
    expect(lines.postalLines).toContain('Cape Town');
    expect(lines.postalLines).toContain('8001');
  });
});
