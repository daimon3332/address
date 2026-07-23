import { describe, expect, it } from 'vitest';
import { formatAddressPresentation } from '../src/domain/address-format';
import { countryByCode } from '../src/domain/countries';
import { generateBundle } from '../src/domain/generator';
import type { AddressComponents, VerifiedAddress } from '../src/domain/types';

const now = new Date('2026-07-20T00:00:00.000Z');

const chinaAddress = (municipality = false): VerifiedAddress => {
  const native: AddressComponents = municipality ? {
    admin1: '北京市', locality: '北京市', district: '朝阳区', dependentLocality: '望京街道',
    street: '阜通东大街', houseNumber: '6号', buildingName: '望京花园', postcode: '100102'
  } : {
    admin1: '河北省', locality: '唐山市', district: '丰润区', dependentLocality: '丰润镇',
    street: '文化路', houseNumber: '18号', buildingName: '光明小区', postcode: '064000'
  };
  const en: AddressComponents = municipality ? {
    admin1: 'Beijing', locality: 'Beijing', district: 'Chaoyang District', dependentLocality: 'Wangjing Subdistrict',
    street: 'Futong East Street', houseNumber: '6', buildingName: 'Wangjing Garden', postcode: '100102'
  } : {
    admin1: 'Hebei Province', locality: 'Tangshan City', district: 'Fengrun District', dependentLocality: 'Fengrun Town',
    street: 'Wenhua Road', houseNumber: '18', buildingName: 'Guangming Residential Community', postcode: '064000'
  };
  const postcode = native.postcode;
  return {
    id: municipality ? 'cn-municipality' : 'cn-hierarchy',
    countryCode: 'CN',
    nativeAddress: `${native.admin1}${native.locality}${native.district}${native.street}${native.houseNumber}${native.buildingName} 邮编${postcode}`,
    formattedAddress: `source address ${postcode}`,
    nativeLanguage: 'zh-CN',
    addressVariants: {
      native: `source native ${postcode}`,
      en: `source English ${postcode}`,
      'zh-CN': `source Chinese ${postcode}`
    },
    components: native,
    componentVariants: { native, en, 'zh-CN': { ...native } },
    coordinates: municipality
      ? { latitude: 39.995, longitude: 116.47 }
      : { latitude: 39.832, longitude: 118.162 },
    addressStatus: 'verified',
    propertyType: 'apartment',
    unitStatus: 'building_only',
    unitProvenance: 'none',
    matchLevel: 'premise',
    verificationLevel: 'L2',
    sourceVersion: 'cn-test-v1',
    sourceUpdatedAt: '2026-07-16',
    verifiedAt: '2026-07-16T00:00:00.000Z',
    expiresAt: '2026-07-23T00:00:00.000Z',
    evidence: [{
      sourceId: 'cn-test', sourceName: 'China address fixture', sourceUrl: 'https://example.test/cn',
      sourceFamily: 'fixture', type: 'address_existence', value: 'same-chain fixture', observedAt: '2026-07-16'
    }],
    exclusionFlags: []
  };
};

describe('China address domain rules', () => {
  it('shows postcode as a standalone field but keeps it out of filters and the complete address', () => {
    const schema = countryByCode.get('CN')!.addressSchema;
    expect(schema.filters).toEqual(['region', 'city']);
    expect(schema.resultFields.map(({ field }) => field)).toContain('postcode');
  });

  it('formats the complete hierarchy and synthetic indoor components in country order', () => {
    const address = chinaAddress();
    const bundle = generateBundle(address, true, 'cn-hierarchy-seed', undefined, now);
    const unit = bundle.generatedUnit!;
    const nativeUnit = `${unit.components.building}栋${unit.components.unit}单元${unit.components.room}室`;
    const englishUnit = `Room ${unit.components.room}, Unit ${unit.components.unit}, Building ${unit.components.building}`;

    expect(unit).toMatchObject({ provenance: 'synthetic', unitProvenance: 'synthetic' });
    // Decision ②: China swaps in a synthetic house number (1-2999) and a lexicon
    // community while road, admin hierarchy and coordinates stay real.
    const presented = bundle.address.components;
    const houseNumber = Number(presented.houseNumber);
    expect(houseNumber).toBeGreaterThanOrEqual(1);
    expect(houseNumber).toBeLessThanOrEqual(2999);
    expect(presented.street).toBe(address.components.street);
    const community = presented.buildingName!;
    expect(['世纪花园', '幸福家园', '阳光小区', '翡翠湾', '锦绣华庭', '龙湖天街', '绿地公馆', '保利花园', '中海国际社区', '招商雍景湾']).toContain(community);
    expect(bundle.address.coordinates).toEqual(address.coordinates);
    expect(bundle.address.unitProvenance).toBe('none');
    expect(bundle.addressFormats.native.singleLine).toBe(`河北省唐山市丰润区丰润镇文化路${houseNumber}号${community}${nativeUnit}`);
    expect(bundle.addressFormats['zh-CN'].singleLine).toBe(`河北省唐山市丰润区丰润镇文化路${houseNumber}号${community}${nativeUnit}`);

    const english = bundle.addressFormats.en.singleLine;
    const englishCommunity = bundle.address.componentVariants.en.buildingName!;
    const ordered = [
      englishUnit, englishCommunity, `${houseNumber} Wenhua Road`, 'Fengrun Town',
      'Fengrun District', 'Tangshan City', 'Hebei Province', 'CHINA'
    ];
    for (let index = 1; index < ordered.length; index += 1) {
      expect(english.indexOf(ordered[index - 1])).toBeLessThan(english.indexOf(ordered[index]));
    }
    expect(english).not.toMatch(/[\u3400-\u9fff]/u);
    for (const language of ['native', 'en', 'zh-CN'] as const) {
      expect(bundle.addressFormats[language].singleLine).not.toContain(address.components.postcode);
    }
    expect(new URL(bundle.googleMaps.openUrl).searchParams.get('query')).toBe('39.832,118.162');
    // Map search skeleton excludes the synthetic house number and community.
    const searchQuery = new URL(bundle.googleMaps.searchUrl!).searchParams.get('query')!;
    expect(searchQuery).toContain('文化路');
    expect(searchQuery).not.toContain(community);
    expect(bundle.googleMaps.amapUrl).toContain('uri.amap.com/marker');
    expect(generateBundle(address, true, 'cn-hierarchy-seed', undefined, now).generatedUnit).toEqual(unit);
    expect(generateBundle(address, true, 'cn-hierarchy-seed', undefined, now).address.components).toEqual(presented);
  });

  it('prefers a real nearby community over the lexicon when attached', () => {
    const address = { ...chinaAddress(), nearbyCommunities: [{ zh: '天湖城', en: 'Tianhucheng' }] };
    const bundle = generateBundle(address, true, 'cn-community-seed', undefined, now);
    expect(bundle.address.components.buildingName).toBe('天湖城');
    expect(bundle.address.componentVariants.en.buildingName).toBe('Tianhucheng');
    expect(bundle.addressFormats.native.singleLine).toContain('天湖城');
    // Deterministic per seed.
    expect(generateBundle(address, true, 'cn-community-seed', undefined, now).address.components.buildingName).toBe('天湖城');
  });

  it('deduplicates a municipality in Chinese and English output', () => {
    const bundle = generateBundle(chinaAddress(true), true, 'cn-municipality-seed', undefined, now);
    for (const language of ['native', 'zh-CN'] as const) {
      expect(bundle.addressFormats[language].singleLine.match(/北京市/g)).toHaveLength(1);
      expect(bundle.addressFormats[language].singleLine).not.toContain('100102');
    }
    const english = bundle.addressFormats.en.singleLine;
    expect(english.match(/Beijing/g)).toHaveLength(1);
    expect(english).toContain('Chaoyang District, Beijing, CHINA');
    expect(english).not.toContain('100102');
    expect(english).not.toMatch(/[\u3400-\u9fff]/u);
  });

  it('normalizes a Chinese lane suffix without dropping the English house number', () => {
    const address = chinaAddress();
    address.componentVariants.en = {
      ...address.componentVariants.en,
      street: 'Xiaomuqiao Road',
      houseNumber: '360弄'
    };
    const english = formatAddressPresentation(address, 'en', '').singleLine;
    expect(english).toContain('360 Xiaomuqiao Road');
    expect(english).not.toMatch(/[\u3400-\u9fff]/u);
  });
});
