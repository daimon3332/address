import { describe, expect, it } from 'vitest';
import {
  coverageKey,
  localizedAddressData,
  normalizeAddress,
  validateLocalizedAddressVariants
} from '../scripts/lib/address-pool.mjs';

const address = {
  countryCode: 'US',
  admin1: 'Pennsylvania',
  admin1Code: 'PA',
  locality: 'Philadelphia',
  postalLocality: 'Philadelphia',
  postcode: '19103',
  propertyType: 'residential'
};

describe('address pool coverage slots', () => {
  it('groups postcodes within the same country, region, city and property type', () => {
    expect(coverageKey(address, 'release')).toBe(
      coverageKey({ ...address, postcode: '19147' }, 'release')
    );
  });

  it('keeps different cities and property types in separate slots', () => {
    const key = coverageKey(address, 'release');
    expect(coverageKey({ ...address, locality: 'Pittsburgh', postalLocality: 'Pittsburgh' }, 'release')).not.toBe(key);
    expect(coverageKey({ ...address, propertyType: 'commercial' }, 'release')).not.toBe(key);
  });

  it('requires a source row declaration before treating a residential label as evidence', () => {
    const defaults = { countryCode: 'US', propertyType: 'residential' };
    const row = {
      street: 'Market Street', house_number: '1', latitude: '39.95', longitude: '-75.16',
      source_id: 'fixture', source_name: 'Fixture', source_url: 'https://example.test/source',
      source_license: 'CC0-1.0'
    };
    expect(normalizeAddress(row, defaults).address).toMatchObject({
      propertyType: 'residential', residentialEvidence: false
    });
    expect(normalizeAddress({ ...row, property_type: 'residential', residential_evidence: 'true' }, defaults).address).toMatchObject({
      propertyType: 'residential', residentialEvidence: true
    });
  });

  it('enforces China English-script and no-postcode presentation at the v2 import gate', () => {
    const china = {
      countryCode: 'CN', admin1: '河北省', admin1Code: '13', locality: '唐山市', postalLocality: '唐山市',
      district: '丰润区', postcode: '064000', street: '文化路', houseNumber: '30号', buildingName: '光明小区'
    };
    const valid = {
      address_native: '中国河北省唐山市丰润区文化路30号光明小区',
      address_en: 'Guangming Residential Community, 30 Wenhua Road, Fengrun District, Tangshan City, Hebei Province, China',
      address_zh_cn: '中国河北省唐山市丰润区文化路30号光明小区',
      admin1_en: 'Hebei Province', locality_en: 'Tangshan City', postal_locality_en: 'Tangshan City',
      district_en: 'Fengrun District', street_en: 'Wenhua Road', building_name_en: 'Guangming Residential Community',
      admin1_zh_cn: '河北省', locality_zh_cn: '唐山市', postal_locality_zh_cn: '唐山市',
      district_zh_cn: '丰润区', street_zh_cn: '文化路', building_name_zh_cn: '光明小区'
    };
    const accepted = localizedAddressData(valid, china);
    expect(accepted.errors).toEqual([]);
    expect(Object.values(accepted.localized.componentVariants).every((components) => components.postcode === '')).toBe(true);
    expect(accepted.localized.componentVariants.en.houseNumber).toBe('30');
    expect(JSON.stringify(accepted.localized.componentVariants.en)).not.toMatch(/\p{Script=Han}/u);

    expect(localizedAddressData({
      ...valid,
      address_native: `${valid.address_native} 邮编064000`,
      address_en: '光明小区, 30 Wenhua Road, Tangshan, postal code 064000',
      building_name_en: '光明小区'
    }, china).errors).toEqual(expect.arrayContaining([
      'address_en must not contain Han characters for CN',
      'English components must not contain Han characters for CN',
      'address_native must not contain a postcode for CN',
      'address_en must not contain a postcode for CN'
    ]));
  });

  it('rejects Han characters in persisted China English variants', () => {
    const components = { native: {}, en: { buildingName: '光明小区' }, 'zh-CN': {} };
    const addresses = { native: '河北省唐山市文化路30号', en: '光明小区, 30 Wenhua Road', 'zh-CN': '河北省唐山市文化路30号' };
    expect(validateLocalizedAddressVariants('CN', components, addresses)).toEqual(expect.arrayContaining([
      'address_en must not contain Han characters for CN',
      'English components must not contain Han characters for CN'
    ]));
  });

  it('rejects missing, empty or malformed persisted localization structures', () => {
    expect(validateLocalizedAddressVariants('CN', {}, {})).toEqual(expect.arrayContaining([
      'componentVariants.native must be a non-empty object',
      'addressVariants.en must be a non-empty string'
    ]));
    expect(validateLocalizedAddressVariants('CN', {
      native: { street: '文化路' }, en: { street: { value: 'Wenhua Road' } }, 'zh-CN': { street: '文化路' }
    }, { native: '文化路30号', en: '30 Wenhua Road', 'zh-CN': '文化路30号' })).toContain(
      'componentVariants.en values must be strings'
    );
    const incomplete = { native: { postcode: '' }, en: { postcode: '' }, 'zh-CN': { postcode: '' } };
    const addresses = { native: '文化路30号', en: '30 Wenhua Road', 'zh-CN': '文化路30号' };
    expect(validateLocalizedAddressVariants('CN', incomplete, addresses)).toContain(
      'componentVariants.en must include houseNumber, street, locality and postcode strings'
    );
  });

  it('normalizes full-width digits before checking persisted China postcodes', () => {
    const components = { native: { street: '文化路' }, en: { street: 'Wenhua Road' }, 'zh-CN': { street: '文化路' } };
    const addresses = { native: '河北省唐山市文化路30号 ０６４０００', en: '30 Wenhua Road, Tangshan, China', 'zh-CN': '河北省唐山市文化路30号' };
    expect(validateLocalizedAddressVariants('CN', components, addresses)).toContain(
      'address_native must not contain a postcode for CN'
    );
  });

  it.each(['native', 'en', 'zh-CN'])('rejects a postcode in the persisted China %s address', (language) => {
    const components = { native: {}, en: {}, 'zh-CN': {} };
    const addresses = { native: '河北省唐山市文化路30号', en: '30 Wenhua Road, Tangshan, China', 'zh-CN': '河北省唐山市文化路30号' };
    addresses[language] += ' 064000';
    expect(validateLocalizedAddressVariants('CN', components, addresses)).toContain(
      `address_${language === 'zh-CN' ? 'zh_cn' : language} must not contain a postcode for CN`
    );
  });

  it.each(['native', 'en', 'zh-CN'])('rejects a postcode in the persisted China %s components', (language) => {
    const components = { native: {}, en: {}, 'zh-CN': {} };
    components[language].postcode = '064000';
    const addresses = { native: '河北省唐山市文化路30号', en: '30 Wenhua Road, Tangshan, China', 'zh-CN': '河北省唐山市文化路30号' };
    expect(validateLocalizedAddressVariants('CN', components, addresses)).toContain(
      `componentVariants.${language} must not contain a postcode for CN`
    );
  });
});
