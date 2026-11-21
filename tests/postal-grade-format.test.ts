import { describe, expect, it } from 'vitest';
import { formatAddressPresentation, taiwanEnglishPremise } from '../src/domain/address-format';
import { generateBundle } from '../src/domain/generator';
import type { AddressComponents, CountryCode, GeneratedUnit, VerifiedAddress } from '../src/domain/types';

const now = new Date('2026-07-20T00:00:00.000Z');

const addressFor = (countryCode: CountryCode, components: AddressComponents, propertyType: VerifiedAddress['propertyType'] = 'apartment'): VerifiedAddress => ({
  id: `${countryCode.toLowerCase()}-postal-grade`,
  countryCode,
  nativeAddress: 'source native',
  formattedAddress: 'source formatted',
  nativeLanguage: 'en',
  addressVariants: { native: 'source native', en: 'source en', 'zh-CN': 'source zh' },
  components,
  componentVariants: { native: components, en: { ...components }, 'zh-CN': { ...components } },
  coordinates: { latitude: 10, longitude: 10 },
  addressStatus: 'verified',
  propertyType,
  unitStatus: 'building_only',
  unitProvenance: 'none',
  matchLevel: 'premise',
  verificationLevel: 'L2',
  sourceVersion: 'test-v1',
  sourceUpdatedAt: '2026-07-16',
  verifiedAt: '2026-07-16T00:00:00.000Z',
  expiresAt: '2026-07-30T00:00:00.000Z',
  evidence: [{
    sourceId: 'test', sourceName: 'Test', sourceUrl: 'https://example.com', sourceFamily: 'test',
    type: 'address_existence', value: 'source', observedAt: '2026-07-16'
  }],
  exclusionFlags: []
});

const syntheticUnit = (variants: GeneratedUnit['variants']): GeneratedUnit => ({
  components: { building: '3', unit: '1', room: '1203' },
  variants,
  provenance: 'synthetic',
  unitProvenance: 'synthetic'
});

describe('postal-grade formats per docs/address-formats.md', () => {
  it('renders source-tagged numeric units with the country convention', () => {
    const us = addressFor('US', {
      admin1: 'California', admin1Code: 'CA', locality: 'Berkeley', street: 'College Avenue',
      houseNumber: '2704', unit: '3', postcode: '94704'
    });
    expect(formatAddressPresentation(us, 'en', '').singleLine).toContain('2704 College Avenue Apt 3');
  });

  it('renders Canada with the province abbreviation', () => {
    const address = addressFor('CA', {
      admin1: 'Ontario', admin1Code: 'ON', locality: 'Toronto',
      street: 'Queen St W', houseNumber: '88', postcode: 'M5H 2N2'
    });
    const singleLine = formatAddressPresentation(address, 'en', '').singleLine;
    expect(singleLine).toContain('Toronto ON M5H 2N2');
    expect(singleLine).not.toContain('Ontario');
  });

  it('renders Brazil with the São Paulo-SP state pattern', () => {
    const address = addressFor('BR', {
      admin1: 'São Paulo', admin1Code: 'SP', locality: 'São Paulo', district: 'Bela Vista',
      street: 'Av. Paulista', houseNumber: '1578', postcode: '01310-200'
    });
    const singleLine = formatAddressPresentation(address, 'native', '').singleLine;
    expect(singleLine).toContain('São Paulo-SP');
    expect(singleLine).toContain('01310-200');
  });

  it('renders Korea with the postcode in parentheses on the native layout', () => {
    const address = addressFor('KR', {
      admin1: '서울특별시', locality: '관악구', street: '신원로3길', houseNumber: '57', postcode: '08753'
    });
    const native = formatAddressPresentation(address, 'native', '').singleLine;
    expect(native).toContain('(08753)');
    const english = formatAddressPresentation(address, 'en', '').singleLine;
    expect(english).not.toContain('(08753)');
    expect(english).toContain('08753');
  });

  it('keeps the Korean layout clean when the postcode is missing', () => {
    const address = addressFor('KR', {
      admin1: '서울특별시', locality: '관악구', street: '신원로3길', houseNumber: '57', postcode: ''
    });
    expect(formatAddressPresentation(address, 'native', '').singleLine).not.toContain('()');
  });

  it('renders Turkey with the No: house-number prefix', () => {
    const address = addressFor('TR', {
      admin1: 'İstanbul', locality: 'Şişli', street: 'Valide Sultan Caddesi', houseNumber: '23', postcode: '34400'
    });
    expect(formatAddressPresentation(address, 'native', '').singleLine).toContain('Valide Sultan Caddesi No:23');
  });

  it('merges the synthetic unit into postal lines per country convention', () => {
    const gb = addressFor('GB', {
      admin1: 'Greater London', locality: 'London', street: 'Baker Street', houseNumber: '21', postcode: 'NW1 6XE'
    });
    const gbLine = formatAddressPresentation(gb, 'en', '', syntheticUnit({ native: 'Flat 2', en: 'Flat 2', 'zh-CN': '3栋1单元1203室' })).singleLine;
    expect(gbLine).toContain('Flat 2, 21 Baker Street');

    const us = addressFor('US', {
      admin1: 'New York', admin1Code: 'NY', locality: 'Brooklyn', street: 'Dean Street', houseNumber: '150', postcode: '11238'
    });
    const usLine = formatAddressPresentation(us, 'en', '', syntheticUnit({ native: 'Apt 1203', en: 'Apt 1203', 'zh-CN': '3栋1单元1203室' })).singleLine;
    expect(usLine).toContain('150 Dean Street Apt 1203');

    const hk = addressFor('HK', {
      admin1: 'Kowloon', locality: '香港', district: '油尖旺區', street: '彌敦道', houseNumber: '100', postcode: ''
    });
    const hkLine = formatAddressPresentation(hk, 'native', '', syntheticUnit({ native: '12樓A室', en: 'Flat A, 12/F', 'zh-CN': '12楼A室' })).singleLine;
    expect(hkLine).toContain('彌敦道100號12樓A室');

    const de = addressFor('DE', {
      admin1: 'Hessen', locality: 'Frankfurt', street: 'Hauptstraße', houseNumber: '5', postcode: '60311'
    });
    const deLine = formatAddressPresentation(de, 'native', '', syntheticUnit({ native: 'Apt 1203', en: 'Apt 1203', 'zh-CN': '3栋1单元1203室' })).singleLine;
    expect(deLine).not.toContain('Apt');
  });

  it('does not produce synthetic unit variants from the generator', () => {
    const gbBundle = generateBundle(addressFor('GB', {
      admin1: 'Greater London', locality: 'London', street: 'Baker Street', houseNumber: '21', postcode: 'NW1 6XE'
    }), false, 'unit-i18n-seed', undefined, now);
    expect(gbBundle.generatedUnit).toBeUndefined();
    expect(gbBundle.addressFormats.en.singleLine).toContain('21 Baker Street');
    expect(gbBundle.addressFormats.en.singleLine).not.toMatch(/Flat \d+/);

    const krBundle = generateBundle(addressFor('KR', {
      admin1: '서울특별시', locality: '관악구', street: '신원로3길', houseNumber: '57', postcode: '08753'
    }), false, 'unit-i18n-seed', undefined, now);
    expect(krBundle.generatedUnit).toBeUndefined();
    expect(krBundle.addressFormats.native.singleLine).toContain('신원로3길 57');
    expect(krBundle.addressFormats.native.singleLine).not.toMatch(/\d+동 \d+호/);
  });
});

describe('Japanese town lines', () => {
  it('does not repeat the town a Japanese street already begins with', () => {
    const address = addressFor('JP', { houseNumber: '32-34', street: 'Kitaterao 6-chome', district: 'Kitaterao',
      locality: 'Tsurumi-ku, Yokohama-shi', admin1: 'Kanagawa', postcode: '230-0074' });
    const line = formatAddressPresentation(address, 'en', '').singleLine;
    expect(line).toContain('Kitaterao 6-chome');
    expect(line.match(/Kitaterao/gu)).toHaveLength(1);
  });
});

describe('Taiwanese English house numbers', () => {
  it('writes 號, 之 and 樓 in Chunghwa Post English', () => {
    expect(taiwanEnglishPremise('34號', '之1')).toEqual({ houseNumber: 'No. 34-1', unit: '' });
    expect(taiwanEnglishPremise('41', '之2號')).toEqual({ houseNumber: 'No. 41-2', unit: '' });
    expect(taiwanEnglishPremise('12之3號', '')).toEqual({ houseNumber: 'No. 12-3', unit: '' });
    expect(taiwanEnglishPremise('8號之2', '')).toEqual({ houseNumber: 'No. 8-2', unit: '' });
    expect(taiwanEnglishPremise('5號', '四樓之2')).toEqual({ houseNumber: 'No. 5', unit: '4F.-2' });
    expect(taiwanEnglishPremise('5號', '十二樓')).toEqual({ houseNumber: 'No. 5', unit: '12F.' });
    expect(taiwanEnglishPremise('5號', '地下一樓')).toEqual({ houseNumber: 'No. 5', unit: 'B1F.' });
    expect(taiwanEnglishPremise('66號', '7')).toEqual({ houseNumber: 'No. 66', unit: 'Rm. 7' });
    expect(taiwanEnglishPremise('', '')).toEqual({ houseNumber: '', unit: '' });
    expect(taiwanEnglishPremise('46號', '之1三樓')).toEqual({ houseNumber: 'No. 46-1', unit: '3F.' });
    expect(taiwanEnglishPremise('77號', '之1五樓之2')).toEqual({ houseNumber: 'No. 77-1', unit: '5F.-2' });
    expect(taiwanEnglishPremise('168號', '地下一層')).toEqual({ houseNumber: 'No. 168', unit: 'B1F.' });
    expect(taiwanEnglishPremise('7號', '地下二層之197')).toEqual({ houseNumber: 'No. 7', unit: 'B2F.-197' });
    expect(taiwanEnglishPremise('48號', '地下')).toEqual({ houseNumber: 'No. 48', unit: 'Basement' });
    expect(taiwanEnglishPremise('100號', '地下之34')).toEqual({ houseNumber: 'No. 100', unit: 'Basement-34' });
    expect(taiwanEnglishPremise('133號', '底層')).toEqual({ houseNumber: 'No. 133', unit: '1F.' });
    expect(taiwanEnglishPremise('349號', '底一層之24')).toEqual({ houseNumber: 'No. 349', unit: '1F.-24' });
    expect(taiwanEnglishPremise('148號', '附2')).toBeUndefined();
    expect(taiwanEnglishPremise('5號', '頂樓加蓋')).toBeUndefined();
    expect(taiwanEnglishPremise('A棟', '')).toBeUndefined();
  });
});
