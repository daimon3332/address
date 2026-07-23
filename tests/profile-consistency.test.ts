import { describe, expect, it } from 'vitest';
import { countries } from '../src/domain/countries';
import { generateBundle } from '../src/domain/generator';
import { isLuhnValid } from '../src/domain/sandbox-card';
import { eligibleAddresses } from './fixtures/catalog';

const now = new Date('2026-07-20T00:00:00.000Z');

const uaMatchesOs = (os: string, userAgent: string): boolean => {
  if (os === 'Windows 11') return userAgent.includes('Windows NT 10.0');
  if (os === 'macOS 15.7') return /Mac OS X 15[_\.]7/.test(userAgent);
  if (os === 'Android 16') return userAgent.includes('Android 16');
  if (os === 'iOS 18.6') return userAgent.includes('iPhone OS 18_6');
  return false;
};

describe('constraint-driven synthetic profiles', () => {
  it('keeps anthropometrics, education, employment and UA tuples coherent', () => {
    const statuses = new Set<string>();
    const ageBands = new Set<string>();
    for (const country of countries) {
      for (let index = 0; index < 40; index += 1) {
        const bundle = generateBundle(
          eligibleAddresses(country.code, false, now)[0],
          false,
          `coherence-${country.code}-${index}`,
          undefined,
          now
        );
        const { basic, employment, finance, internet } = bundle.extensions;

        expect(basic.age).toBeGreaterThanOrEqual(18);
        expect(basic.age).toBeLessThanOrEqual(74);
        expect(basic.honorific).toBe(bundle.profile.gender === 'male' ? 'mr' : 'ms');
        expect(bundle.profile.fullName).not.toMatch(/^(?:Mr\.?|Mrs\.?|Ms\.?|Miss|Herr|Frau|M |Mme |Sr\.?|Sra\.?|Dott\.?|Bay |Bayan )\s/i);
        expect(bundle.profile.fullName).not.toMatch(/\s(?:PhD|DDS|MD|Jr\.?|Sr\.?)$/i);
        ageBands.add(basic.age <= 24 ? '18-24' : basic.age <= 34 ? '25-34'
          : basic.age <= 44 ? '35-44' : basic.age <= 54 ? '45-54'
            : basic.age <= 64 ? '55-64' : '65-74');
        if (basic.education === 'associate') expect(basic.age).toBeGreaterThanOrEqual(20);
        if (basic.education === 'bachelor') expect(basic.age).toBeGreaterThanOrEqual(21);
        if (basic.education === 'master') expect(basic.age).toBeGreaterThanOrEqual(23);
        if (basic.education === 'doctorate') expect(basic.age).toBeGreaterThanOrEqual(28);
        expect(basic.bmi).toBeGreaterThanOrEqual(18);
        expect(basic.bmi).toBeLessThanOrEqual(37);
        expect(Math.abs(basic.bmi - basic.weightKg / (basic.heightCm / 100) ** 2)).toBeLessThanOrEqual(0.051);

        statuses.add(employment.employmentStatus);
        if (employment.employmentStatus === 'employed' || employment.employmentStatus === 'self-employed') {
          const incomeRange = finance.incomeRange;
          expect(incomeRange).toBeDefined();
          if (!incomeRange) throw new Error('Expected income for active employment');
          expect(employment.salary.amount).toBeGreaterThan(0);
          expect(['full-time', 'part-time']).toContain(employment.workSchedule);
          expect(incomeRange.min).toBeLessThan(employment.salary.amount);
          expect(incomeRange.max).toBeGreaterThan(employment.salary.amount);
          if (employment.employmentStatus === 'self-employed') {
            expect(employment.department).toBe('Owner');
            expect(employment.companySize).toBe('1-10');
            expect(employment.occupation).toMatch(/^Independent /);
          }
        } else {
          expect(Object.keys(employment)).toEqual(['employmentStatus']);
          expect(finance).not.toHaveProperty('incomeRange');
          if (employment.employmentStatus === 'retired') expect(basic.age).toBeGreaterThanOrEqual(60);
        }

        expect(uaMatchesOs(internet.os, internet.userAgent)).toBe(true);
        expect(internet.userAgent).not.toMatch(/bot|crawler|spider/i);
        expect(internet.username).toMatch(/^[a-z0-9._-]{4,30}$/);
        expect(internet.username).not.toMatch(new RegExp(`^${country.code.toLowerCase()}_\\d+$`));
        expect(finance.accountDisplayName).not.toMatch(/test|sandbox/i);
        expect(finance.transactionDescription).toMatch(/^CARD PURCHASE · \S.{0,63}$/);
        if (country.code === 'US' || country.code === 'CA') {
          expect(finance.accountDisplayName).toMatch(/ · (?:Checking|Savings) Account$/);
        }
        expect(new URL(internet.url).hostname).not.toMatch(/\.example$/i);
      }
    }
    expect(statuses).toEqual(new Set(['employed', 'self-employed', 'student', 'between-jobs', 'retired']));
    expect(ageBands).toEqual(new Set(['18-24', '25-34', '35-44', '45-54', '55-64', '65-74']));
  }, 15_000);

  it('generates Luhn-valid test cards with network-correct prefixes and future expiry', () => {
    const prefixesByNetwork: Record<string, RegExp> = {
      Visa: /^4/,
      Mastercard: /^(5[1-5]|2[2-7])/
    };
    const seenNetworks = new Set<string>();
    for (let index = 0; index < 200; index += 1) {
      const card = generateBundle(
        eligibleAddresses('US', false, now)[0], false, `card-${index}`, undefined, now
      ).card;
      const digits = card.number.replace(/\s/g, '');
      const [month, year] = card.expiry.split('/').map(Number);
      const expiry = new Date(Date.UTC(year, month, 1));

      seenNetworks.add(card.network);
      expect(['Visa', 'Mastercard']).toContain(card.network);
      expect(card.testDataOnly).toBe(true);
      expect(isLuhnValid(card.number)).toBe(true);
      expect(expiry.getTime()).toBeGreaterThan(now.getTime());
      expect(digits).toMatch(prefixesByNetwork[card.network]);
      expect(digits).toHaveLength(16);
      expect(card.cvc).toMatch(/^\d{3}$/);
    }
    expect(seenNetworks.size).toBe(2);
  });
});
