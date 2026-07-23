import { describe, expect, it } from 'vitest';
import App, { localizedExtensionValue, profileValue } from '../src/components/App';
import { generateBundle } from '../src/domain/generator';
import { eligibleAddresses } from './fixtures/catalog';

const now = new Date('2026-07-20T00:00:00.000Z');

const nationalPhoneParts = (phone: string): [string, string, string] => {
  const parts = phone.replace(/^\+1 /, '').split(' ');
  expect(parts).toHaveLength(3);
  return parts as [string, string, string];
};

describe('regional phone generation', () => {
  it('uses address-local US and Canadian area codes without a 555 exchange', () => {
    const brooklyn = structuredClone(eligibleAddresses('US', false, now)[0]);
    const philadelphia = structuredClone(brooklyn);
    philadelphia.components.locality = 'Philadelphia';
    philadelphia.components.admin1 = 'Pennsylvania';
    philadelphia.components.admin1Code = 'PA';
    const toronto = structuredClone(eligibleAddresses('CA', false, now)[0]);
    const vancouver = structuredClone(toronto);
    vancouver.components.locality = 'Vancouver';
    vancouver.components.admin1 = 'British Columbia';
    vancouver.components.admin1Code = 'BC';

    const cases = [
      { address: brooklyn, seed: 'brooklyn-phone', areaCodes: ['347', '718', '917', '929'] },
      { address: philadelphia, seed: 'philadelphia-phone', areaCodes: ['215', '267', '445'] },
      { address: toronto, seed: 'toronto-phone', areaCodes: ['416', '437', '647'] },
      { address: vancouver, seed: 'vancouver-phone', areaCodes: ['236', '604', '672', '778'] }
    ];

    for (const { address, seed, areaCodes } of cases) {
      const phone = generateBundle(address, false, seed, undefined, now).profile.phone;
      const [areaCode, exchange, line] = nationalPhoneParts(phone);
      expect(areaCodes).toContain(areaCode);
      expect(exchange).toMatch(/^[2-9]\d{2}$/);
      expect(exchange).not.toBe('555');
      expect(exchange).not.toMatch(/^[2-9]11$/);
      expect(line).toMatch(/^\d{4}$/);
      expect(generateBundle(address, false, seed, undefined, now).profile.phone).toBe(phone);
    }
  });

  it('uses valid international mobile prefixes and grouping for Mexico, Italy, the Netherlands and Russia', () => {
    const patterns = {
      MX: /^\+52 55 \d{4} \d{4}$/,
      IT: /^\+39 320 \d{3} \d{4}$/,
      NL: /^\+31 6 \d{4} \d{4}$/,
      RU: /^\+7 9\d{2} \d{3} \d{4}$/
    } as const;
    for (const [countryCode, pattern] of Object.entries(patterns)) {
      for (let index = 0; index < 20; index += 1) {
        const address = eligibleAddresses(countryCode as keyof typeof patterns, false, now)[0];
        expect(generateBundle(address, false, `phone-${countryCode}-${index}`, undefined, now).profile.phone)
          .toMatch(pattern);
      }
    }
  });
});

describe('profile result presentation', () => {
  it('localizes generated labels without changing stored deterministic values', () => {
    expect(localizedExtensionValue('Software Engineer', 'zh-CN')).toBe('软件工程师');
    expect(localizedExtensionValue('Independent Software Engineer', 'zh-CN')).toBe('独立软件工程师');
    expect(localizedExtensionValue('Information Technology', 'zh-CN')).toBe('信息技术');
    expect(localizedExtensionValue('What was your childhood nickname?', 'zh-CN')).toBe('你小时候的昵称是什么？');
    expect(localizedExtensionValue('Morgan Lee · Savings Account', 'zh-CN')).toBe('Morgan Lee · 储蓄账户');
    expect(localizedExtensionValue('Morgan Lee · Checking Account', 'zh-CN')).toBe('Morgan Lee · 支票账户');
    expect(localizedExtensionValue('part-time', 'zh-CN')).toBe('兼职');
    expect(localizedExtensionValue('ms', 'zh-CN')).toBe('女士');
    expect(localizedExtensionValue('Software Engineer', 'en')).toBe('Software Engineer');

    // profileValue: native resolves to the country's language (zh for CN-family, else English).
    expect(profileValue('Software Engineer', 'zh-CN', 'US')).toBe('软件工程师');
    expect(profileValue('Software Engineer', 'en', 'US')).toBe('Software Engineer');
    expect(profileValue('Software Engineer', 'native', 'US')).toBe('Software Engineer');
    expect(profileValue('Software Engineer', 'native', 'CN')).toBe('软件工程师');
    expect(profileValue('Software Engineer', 'native', 'TW')).toBe('软件工程师');
    // Closed enum sets carry real native-language dictionaries.
    expect(profileValue('master', 'native', 'JP')).toBe('修士');
    expect(profileValue('employed', 'native', 'KR')).toBe('재직 중');
    expect(profileValue('Savings Account', 'native', 'DE')).toBe('Sparkonto');
    expect(profileValue('What was the name of your first pet?', 'native', 'SA')).toBe('ما اسم أول حيوان أليف لك؟');
    expect(profileValue('libra', 'native', 'FR')).toBe('Balance');

    const bundle = generateBundle(eligibleAddresses('US', false, now)[0], false, 'localized-view', undefined, now);
    const stored = structuredClone(bundle.extensions);
    localizedExtensionValue(bundle.extensions.finance.accountDisplayName, 'zh-CN');
    localizedExtensionValue(bundle.extensions.internet.securityQuestion, 'zh-CN');
    expect(bundle.extensions).toEqual(stored);
  });

  it('renders physical profile fields in basic information instead of the internet panel', () => {
    const source = App.toString();
    const basicStart = source.indexOf('profile-card panel');
    const cardStart = source.indexOf('card-section panel');
    const internetStart = source.indexOf('internetProfile');
    expect(basicStart).toBeGreaterThanOrEqual(0);
    expect(cardStart).toBeGreaterThan(basicStart);
    expect(internetStart).toBeGreaterThan(cardStart);
    for (const field of ['heightCm', 'weightKg', 'basic.bmi', 'basic.bloodType', 'basic.education']) {
      const fieldIndex = source.indexOf(field);
      expect(fieldIndex, field).toBeGreaterThan(basicStart);
      expect(fieldIndex, field).toBeLessThan(cardStart);
      expect(source.slice(internetStart), field).not.toContain(field);
    }
    expect(source).toContain('extensions.basic.honorific');
    expect(source).toContain('extensions.employment.workSchedule');
    expect(source).toContain('cardNotice');
  });
});
