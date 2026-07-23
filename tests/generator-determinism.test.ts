import { describe, expect, it } from 'vitest';
import { countries } from '../src/domain/countries';
import { generateBundle } from '../src/domain/generator';
import type { CountryCode, Iso4217Currency } from '../src/domain/types';
import { eligibleAddresses } from './fixtures/catalog';

const now = new Date('2026-07-20T00:00:00.000Z');

const currencyByCountry: Record<CountryCode, Iso4217Currency> = {
  US: 'USD', CA: 'CAD', MX: 'MXN', GB: 'GBP', DE: 'EUR', FR: 'EUR', IT: 'EUR',
  ES: 'EUR', NL: 'EUR', RU: 'RUB', JP: 'JPY', HK: 'HKD', SG: 'SGD', TW: 'TWD',
  KR: 'KRW', MY: 'MYR', CN: 'CNY', TH: 'THB', PH: 'PHP', VN: 'VND', TR: 'TRY',
  SA: 'SAR', IN: 'INR', AU: 'AUD', BR: 'BRL', NG: 'NGN', ZA: 'ZAR'
};

const expectedAge = (dateOfBirth: string): number => {
  const birthDate = new Date(`${dateOfBirth}T00:00:00.000Z`);
  let age = now.getUTCFullYear() - birthDate.getUTCFullYear();
  if (now.getUTCMonth() < birthDate.getUTCMonth()
    || (now.getUTCMonth() === birthDate.getUTCMonth() && now.getUTCDate() < birthDate.getUTCDate())) {
    age -= 1;
  }
  return age;
};

describe('request-local profile generation', () => {
  it('is exactly reproducible for the same address, seed and time', () => {
    const address = eligibleAddresses('US', false, now)[0];
    expect(generateBundle(address, false, 'repeatable', undefined, now)).toEqual(
      generateBundle(address, false, 'repeatable', undefined, now)
    );
  });

  it('has no A/B/A request-order pollution', () => {
    const addressA = eligibleAddresses('JP', false, now)[0];
    const addressB = eligibleAddresses('BR', false, now)[0];
    const firstA = generateBundle(addressA, false, 'alpha', undefined, now);
    generateBundle(addressB, false, 'beta', undefined, now);
    const secondA = generateBundle(addressA, false, 'alpha', undefined, now);
    expect(secondA).toEqual(firstA);
  });

  it('does not mutate input addresses or share extension objects', () => {
    const address = eligibleAddresses('CN', false, now)[0];
    const snapshot = structuredClone(address);
    const first = generateBundle(address, false, 'isolated', undefined, now);
    const second = generateBundle(address, false, 'isolated', undefined, now);
    expect(address).toEqual(snapshot);
    expect(first.extensions).not.toBe(second.extensions);
    expect(first.extensions.basic).not.toBe(second.extensions.basic);
    expect(first.extensions).toEqual(second.extensions);
  });
});

describe('generated extension constraints', () => {
  it('preserves the existing profile and sandbox-card contract', () => {
    const bundle = generateBundle(eligibleAddresses('US', false, now)[0], false, 'compat', undefined, now);
    expect(Object.keys(bundle.profile)).toEqual(['fullName', 'gender', 'email', 'phone', 'dateOfBirth']);
    expect(Object.keys(bundle.card)).toEqual([
      'network', 'number', 'expiry', 'cvc', 'testDataOnly'
    ]);
  });

  it('uses the correct ISO 4217 currency and safe fixture values in all 27 countries', () => {
    expect(countries).toHaveLength(27);
    for (const country of countries) {
      const address = eligibleAddresses(country.code, false, now)[0];
      const bundle = generateBundle(address, false, `extensions-${country.code}`, undefined, now);
      const { basic, employment, finance, internet } = bundle.extensions;

      expect(basic.age, country.code).toBe(expectedAge(bundle.profile.dateOfBirth));
      expect(basic.zodiacSign, country.code).toMatch(
        /^(aries|taurus|gemini|cancer|leo|virgo|libra|scorpio|sagittarius|capricorn|aquarius|pisces)$/
      );
      expect(basic.heightCm, country.code).toBeGreaterThanOrEqual(150);
      expect(basic.heightCm, country.code).toBeLessThanOrEqual(200);
      expect(basic.weightKg, country.code).toBeGreaterThanOrEqual(45);
      expect(basic.weightKg, country.code).toBeLessThanOrEqual(110);
      expect(basic.bmi, country.code).toBeCloseTo(
        basic.weightKg / (basic.heightCm / 100) ** 2,
        1
      );

      if (employment.employmentStatus === 'employed' || employment.employmentStatus === 'self-employed') {
        expect(employment.occupation.trim(), country.code).toBeTruthy();
        expect(employment.company.trim(), country.code).toBeTruthy();
        expect(employment.department.trim(), country.code).toBeTruthy();
        expect(employment.salary.currency, country.code).toBe(currencyByCountry[country.code]);
        expect(employment.salary.amount, country.code).toBeGreaterThan(0);
        expect(finance.incomeRange?.currency, country.code).toBe(currencyByCountry[country.code]);
        expect(finance.incomeRange?.min, country.code).toBeLessThan(finance.incomeRange?.max || 0);
      } else {
        expect(Object.keys(employment), country.code).toEqual(['employmentStatus']);
        expect(finance, country.code).not.toHaveProperty('incomeRange');
      }
      expect(finance, country.code).not.toHaveProperty('accountNumber');
      expect(finance, country.code).not.toHaveProperty('iban');
      expect(finance, country.code).not.toHaveProperty('routingNumber');

      expect(internet.uuid, country.code).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );
      expect(internet.ipAddress, country.code).toMatch(
        /^(192\.0\.2|198\.51\.100|203\.0\.113)\.(?:[1-9]|[1-9]\d|1\d{2}|2[0-4]\d|25[0-4])$/
      );
      expect(internet.macAddress, country.code).toMatch(/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/);
      const firstOctet = Number.parseInt(internet.macAddress.slice(0, 2), 16);
      expect(firstOctet & 0x02, country.code).toBe(0x02);
      expect(firstOctet & 0x01, country.code).toBe(0);
      expect(new URL(internet.url).protocol, country.code).toBe('https:');
      expect(new URL(internet.url).hostname, country.code).not.toMatch(/\.example$/);
      expect(internet.testPassword, country.code).toMatch(/^[A-Z][a-z]+[A-Z][a-z]+\d{2}!$/);
      expect(internet.os, country.code).toBeTruthy();
      expect(internet.securityQuestion, country.code).toMatch(/\?$/);
      expect(internet.securityAnswer.trim(), country.code).toBeTruthy();
    }
  });
});
