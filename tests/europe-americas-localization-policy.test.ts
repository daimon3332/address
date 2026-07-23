import { describe, expect, it } from 'vitest';
import { countryByCode } from '../src/domain/countries';
import type { AddressComponents } from '../src/domain/types';
import {
  europeAmericasCountryCodes,
  europeAmericasLocalizationPolicies,
  europeAmericasLocalizationPolicyFor,
  fieldsRequiringLocalization,
  localizedComponentScriptIssues,
  postalAdmin1For,
  postalLocalityFor,
  preserveAddressIdentifiers
} from '../src/domain/europe-americas-localization-policy';

const components = (overrides: Partial<AddressComponents> = {}): AddressComponents => ({
  houseNumber: '12',
  unit: '4B',
  buildingName: 'Central House',
  street: 'Main Street',
  locality: 'New York',
  postalLocality: 'Brooklyn',
  district: 'Kings County',
  admin1: 'New York',
  admin1Code: 'NY',
  postcode: '11217',
  ...overrides
});

describe('Europe and Americas localization policies', () => {
  it('covers the eleven assigned countries with native locales matching the registry', () => {
    expect(Object.keys(europeAmericasLocalizationPolicies).sort()).toEqual([...europeAmericasCountryCodes].sort());
    for (const code of europeAmericasCountryCodes) {
      const country = countryByCode.get(code)!;
      const policy = europeAmericasLocalizationPolicyFor(code)!;
      expect(policy.countryCode).toBe(code);
      expect(policy.nativeLocales.some((locale) => locale.startsWith(country.nativeLanguage.split('-')[0]))).toBe(true);
    }
  });

  it('keeps Latin-script street and building proper names out of generic translation', () => {
    for (const code of europeAmericasCountryCodes.filter((country) => country !== 'RU')) {
      const policy = europeAmericasLocalizationPolicies[code];
      expect(policy.variants.en.fields.street).toBe('preserve');
      expect(policy.variants.en.fields.buildingName).toBe('preserve');
      expect(policy.variants['zh-CN'].fields.street).toBe('preserve');
      expect(policy.variants['zh-CN'].fields.buildingName).toBe('preserve');
      expect(policy.variants['zh-CN'].fields.locality).toBe('official-name');
      expect(policy.variants['zh-CN'].fields.admin1).toBe('official-name');
    }
  });

  it('uses transliteration for Russian English and component translation for Simplified Chinese', () => {
    const policy = europeAmericasLocalizationPolicies.RU;
    expect(fieldsRequiringLocalization(policy, 'en')).toEqual([
      'buildingName', 'street', 'locality', 'postalLocality', 'dependentLocality', 'district', 'admin1'
    ]);
    expect(new Set(Object.values(policy.variants.en.fields))).toEqual(new Set(['transliterate']));
    expect(new Set(Object.values(policy.variants['zh-CN'].fields))).toEqual(new Set(['translate']));
    expect(policy.variants.en.sourcePriority.at(-1)).toBe('unicode-transliteration');
    expect(policy.variants['zh-CN'].sourcePriority.at(-1)).toBe('component-translation');
  });

  it('enforces Cyrillic, Latin and Simplified-Chinese script expectations for Russian components', () => {
    const policy = europeAmericasLocalizationPolicies.RU;
    const native = components({ street: 'Тверская улица', locality: 'Москва', postalLocality: 'Москва', admin1: 'Москва' });
    const english = components({ street: 'Tverskaya Street', locality: 'Moscow', postalLocality: 'Moscow', admin1: 'Moscow' });
    const chinese = components({ street: '特维尔大街', locality: '莫斯科', postalLocality: '莫斯科', admin1: '莫斯科' });
    expect(localizedComponentScriptIssues(policy, 'native', native)).toEqual([]);
    expect(localizedComponentScriptIssues(policy, 'en', english)).toEqual([]);
    expect(localizedComponentScriptIssues(policy, 'zh-CN', chinese)).toEqual([]);
    expect(localizedComponentScriptIssues(policy, 'en', native)).toEqual(expect.arrayContaining(['street', 'locality', 'admin1']));
    expect(localizedComponentScriptIssues(policy, 'zh-CN', native)).toEqual(expect.arrayContaining(['street', 'locality', 'admin1']));
  });

  it('accepts accented Latin proper names and Chinese official place names without changing Latin streets', () => {
    const german = components({ street: 'Müllerstraße', locality: 'München', postalLocality: 'München', admin1: 'Bayern' });
    const germanZh = components({ street: 'Müllerstraße', locality: '慕尼黑', postalLocality: '慕尼黑', admin1: '巴伐利亚州' });
    expect(localizedComponentScriptIssues(europeAmericasLocalizationPolicies.DE, 'native', german)).toEqual([]);
    expect(localizedComponentScriptIssues(europeAmericasLocalizationPolicies.DE, 'zh-CN', germanZh)).toEqual([]);
  });

  it('preserves identifiers and applies postal-locality and administrative-area rules', () => {
    const source = components();
    const localized = components({ houseNumber: '十二', unit: '四乙', postcode: 'translated', admin1Code: '纽约', street: '主街' });
    expect(preserveAddressIdentifiers(source, localized)).toMatchObject({
      houseNumber: '12', unit: '4B', postcode: '11217', admin1Code: 'NY', street: '主街'
    });
    expect(postalLocalityFor(source)).toBe('Brooklyn');
    expect(postalAdmin1For(europeAmericasLocalizationPolicies.US, source)).toBe('NY');
    expect(postalAdmin1For(europeAmericasLocalizationPolicies.CA, components({ admin1: 'Ontario', admin1Code: 'ON' }))).toBe('ON');
    expect(postalAdmin1For(europeAmericasLocalizationPolicies.GB, source)).toBe('');
    expect(postalAdmin1For(europeAmericasLocalizationPolicies.RU, components({ admin1: 'Москва', admin1Code: 'MOW' }))).toBe('Москва');
  });

  it('models postal cities, post towns, district usage and street ordering per country', () => {
    expect(europeAmericasLocalizationPolicies.US.postal).toMatchObject({ localityRole: 'postal-city', admin1: 'code', district: 'omit', streetOrder: 'house-first' });
    expect(europeAmericasLocalizationPolicies.GB.postal).toMatchObject({ localityRole: 'post-town', admin1: 'omit', district: 'dependent-locality', streetOrder: 'house-first' });
    expect(europeAmericasLocalizationPolicies.MX.postal).toMatchObject({ admin1: 'name', district: 'district', streetOrder: 'street-first' });
    expect(europeAmericasLocalizationPolicies.BR.postal).toMatchObject({ admin1: 'code', district: 'district', streetOrder: 'street-first' });
    expect(europeAmericasLocalizationPolicies.DE.postal.admin1).toBe('omit');
    expect(europeAmericasLocalizationPolicies.FR.postal.admin1).toBe('omit');
    expect(europeAmericasLocalizationPolicies.NL.postal.admin1).toBe('omit');
  });
});
