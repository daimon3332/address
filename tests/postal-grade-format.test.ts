import { describe, expect, it } from 'vitest';
import { formatAddressPresentation } from '../src/domain/address-format';
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

  it('produces per-country synthetic unit variants from the generator', () => {
    const gbBundle = generateBundle(addressFor('GB', {
      admin1: 'Greater London', locality: 'London', street: 'Baker Street', houseNumber: '21', postcode: 'NW1 6XE'
    }), false, 'unit-i18n-seed', undefined, now);
    expect(gbBundle.generatedUnit?.variants.en).toMatch(/^Flat \d+$/);
    expect(gbBundle.addressFormats.en.singleLine).toMatch(/Flat \d+, 21 Baker Street/);

    const krBundle = generateBundle(addressFor('KR', {
      admin1: '서울특별시', locality: '관악구', street: '신원로3길', houseNumber: '57', postcode: '08753'
    }), false, 'unit-i18n-seed', undefined, now);
    expect(krBundle.generatedUnit?.variants.native).toMatch(/^\d+동 \d+호$/);
    expect(krBundle.addressFormats.native.singleLine).toMatch(/신원로3길 57 \d+동 \d+호/);
  });
});
