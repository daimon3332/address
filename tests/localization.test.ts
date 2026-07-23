import { describe, expect, it } from 'vitest';
import { countryByCode } from '../src/domain/countries';
import { gcj02ToWgs84 } from '../src/domain/coordinates';
import type { AddressComponents, VerifiedAddress } from '../src/domain/types';
import { localizeAddress } from '../server/api/services/address-localizer';

const component = (street: string, locality: string, admin1: string): AddressComponents => ({
  houseNumber: '45-9', street, locality, admin1, postcode: '168-0063'
});

const address = (components: AddressComponents): VerifiedAddress => ({
  id: 'localization-test', countryCode: 'JP', nativeAddress: '', formattedAddress: '', nativeLanguage: 'ja',
  addressVariants: { native: '', en: '', 'zh-CN': '' }, components,
  componentVariants: { native: components, en: components, 'zh-CN': components },
  coordinates: { latitude: 35.6762, longitude: 139.6503 }, addressStatus: 'verified', propertyType: 'residential',
  unitStatus: 'building_only', matchLevel: 'premise', verificationLevel: 'L2', sourceVersion: 'test', sourceUpdatedAt: '2026-07-15',
  verifiedAt: '2026-07-15', expiresAt: '2026-07-22', evidence: [{
    sourceId: 'geoapify', sourceName: 'Geoapify', sourceUrl: 'https://www.geoapify.com/', sourceFamily: 'geoapify',
    type: 'address_existence', value: '45-9 Izumi 2-chome, Tokyo, Japan', observedAt: '2026-07-15'
  }], exclusionFlags: []
});

describe('complete address localization', () => {
  it('falls back to deterministic Pinyin for missing China English components', async () => {
    const country = countryByCode.get('CN')!;
    const native: AddressComponents = {
      houseNumber: '95号',
      buildingName: '新华小区',
      street: '连州大道',
      locality: '清远市',
      dependentLocality: '连州镇',
      district: '连州市',
      admin1: '广东省',
      postcode: '513400'
    };
    const source = address(native);
    source.countryCode = 'CN';
    source.nativeLanguage = 'zh-CN';
    source.evidence[0].sourceId = 'fixture';
    source.componentVariants = {
      native,
      en: {
        ...native,
        buildingName: '新华小区',
        street: 'Lianzhou Avenue',
        locality: '',
        dependentLocality: '连州镇',
        district: '连州市',
        admin1: ''
      },
      'zh-CN': native
    };
    const fetcher = async (): Promise<Response> => { throw new Error('translation unavailable'); };

    const result = await localizeAddress(source, country, {}, fetcher as typeof fetch);

    expect(result.componentVariants.en).toMatchObject({
      houseNumber: '95',
      buildingName: 'Xinhua Residential Community',
      street: 'Lianzhou Avenue',
      locality: 'Qingyuan City',
      dependentLocality: 'Lianzhou Town',
      district: 'Lianzhou City',
      admin1: 'Guangdong Province',
      postcode: '513400'
    });
    expect(result.formattedAddress).toBe(
      'Xinhua Residential Community, 95 Lianzhou Avenue, Lianzhou Town, Lianzhou City, Qingyuan City, Guangdong Province, CHINA'
    );
    expect(result.formattedAddress).not.toContain('513400');
    expect(result.formattedAddress).not.toMatch(/[\u3400-\u9fff]/u);
  });

  it('maps China administrative, road and residence suffixes during Pinyin fallback', async () => {
    const country = countryByCode.get('CN')!;
    const cases: Array<{ native: AddressComponents; expected: Partial<AddressComponents> }> = [
      {
        native: {
          houseNumber: '18号', buildingName: '漓江花园', street: '人民大道', locality: '桂林市',
          dependentLocality: '福利镇', district: '阳朔县', admin1: '广西壮族自治区', postcode: '541900'
        },
        expected: {
          buildingName: 'Lijiang Garden', street: 'Renmin Avenue', locality: 'Guilin City',
          dependentLocality: 'Fuli Town', district: 'Yangshuo County', admin1: 'Guangxi Zhuang Autonomous Region'
        }
      },
      {
        native: {
          houseNumber: '30号', buildingName: '龙湖豪庭', street: '文化路', locality: '唐山市',
          dependentLocality: '丰润乡', district: '丰润区', admin1: '河北省', postcode: '064000'
        },
        expected: {
          buildingName: 'Longhu Residence', street: 'Wenhua Road', locality: 'Tangshan City',
          dependentLocality: 'Fengrun Township', district: 'Fengrun District', admin1: 'Hebei Province'
        }
      },
      {
        native: {
          houseNumber: '6号', buildingName: '望京家园', street: '建国街', locality: '北京市',
          dependentLocality: '朝阳街道', district: '朝阳区', admin1: '北京市', postcode: '100102'
        },
        expected: {
          buildingName: 'Wangjing Residence', street: 'Jianguo Street', locality: 'Beijing',
          dependentLocality: 'Chaoyang Subdistrict', district: 'Chaoyang District', admin1: 'Beijing'
        }
      },
      {
        native: {
          houseNumber: '9号', buildingName: '桃源公寓', street: '桃源巷', locality: '苏州市',
          dependentLocality: '木渎镇', district: '吴中区', admin1: '江苏省', postcode: '215101'
        },
        expected: {
          buildingName: 'Taoyuan Apartments', street: 'Taoyuan Lane', locality: 'Suzhou City',
          dependentLocality: 'Mudu Town', district: 'Wuzhong District', admin1: 'Jiangsu Province'
        }
      }
    ];
    const fetcher = async (): Promise<Response> => { throw new Error('translation unavailable'); };

    for (const [index, item] of cases.entries()) {
      const source = address(item.native);
      source.id = `cn-pinyin-${index}`;
      source.countryCode = 'CN';
      source.nativeLanguage = 'zh-CN';
      source.evidence[0].sourceId = 'fixture';
      source.componentVariants = { native: item.native, en: item.native, 'zh-CN': item.native };

      const result = await localizeAddress(source, country, {}, fetcher as typeof fetch);

      expect(result.componentVariants.en).toMatchObject(item.expected);
      expect(result.formattedAddress).not.toMatch(/[\u3400-\u9fff]/u);
    }
  });

  it('adds China administrative types to existing English names without changing the translated stem', async () => {
    const country = countryByCode.get('CN')!;
    const native: AddressComponents = {
      houseNumber: '1号', buildingName: '香蜜湖小区', street: '福中三路', locality: '深圳市',
      district: '福田区', admin1: '广东省', postcode: '518000'
    };
    const source = address(native);
    source.countryCode = 'CN';
    source.nativeLanguage = 'zh-CN';
    source.componentVariants = {
      native,
      en: {
        houseNumber: '1', buildingName: 'Xiangmihu Residential Community', street: 'Fuzhong 3rd Road',
        locality: 'Shenzhen', district: 'Futian', admin1: 'Guangdong', postcode: '518000'
      },
      'zh-CN': native
    };

    const result = await localizeAddress(source, country, {});

    expect(result.componentVariants.en).toMatchObject({
      street: 'Fuzhong 3rd Road', locality: 'Shenzhen City', district: 'Futian District', admin1: 'Guangdong Province'
    });
    expect(result.formattedAddress).toContain('Futian District, Shenzhen City, Guangdong Province, CHINA');
  });

  it('builds native Japanese, English and Simplified Chinese from localized components', async () => {
    const variants: Record<string, AddressComponents> = {
      ja: component('和泉二丁目', '東京', '東京都'),
      en: component('Izumi 2-chome', 'Tokyo', 'Tokyo'),
      zh: component('和泉二丁目', '东京', '东京都')
    };
    let requests = 0;
    const fetcher = async (input: RequestInfo | URL) => {
      requests += 1;
      const language = new URL(String(input)).searchParams.get('lang') || 'en';
      const value = variants[language];
      return new Response(JSON.stringify({ results: [{
        housenumber: value.houseNumber, street: value.street, city: value.locality,
        state: value.admin1, postcode: value.postcode
      }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const country = countryByCode.get('JP')!;
    const source = address(component('Izumi 2-chome', 'Tokyo', 'Tokyo'));
    source.componentVariants = { native: variants.ja, en: variants.en, 'zh-CN': variants.zh };
    const result = await localizeAddress(source, country, { GEOAPIFY_API_KEY: 'test' }, fetcher as typeof fetch);
    expect(result.addressVariants.native).toContain('和泉二丁目');
    expect(result.addressVariants.en).toContain('Izumi 2-chome');
    expect(result.addressVariants['zh-CN']).toContain('东京');
    expect(result.componentVariants.native.street).toBe('和泉二丁目');
    expect(requests).toBe(0);
  });

  it('falls back to component-level Youdao batches when Google translation is unavailable', async () => {
    const country = countryByCode.get('RU')!;
    const source = address(component('Тверская улица', 'Москва', 'Москва'));
    source.countryCode = 'RU';
    source.nativeLanguage = 'ru';
    source.componentVariants = { native: source.components, en: source.components, 'zh-CN': source.components };
    source.evidence[0].sourceId = 'fixture';
    const requests: URLSearchParams[] = [];
    const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const form = new URLSearchParams(String(init?.body));
      requests.push(form);
      const values = form.getAll('q');
      const translated = form.get('to') === 'en'
        ? ['Tverskaya Street', 'Moscow']
        : ['特维尔大街', '莫斯科'];
      const byValue = new Map(values.map((value, index) => [value, translated[Math.min(index, translated.length - 1)]]));
      return new Response(JSON.stringify({
        errorCode: '0',
        translateResults: values.map((value) => ({ query: value, translation: byValue.get(value), type: `${form.get('from')}2${form.get('to')}` }))
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const result = await localizeAddress(source, country, {
      YOUDAO_APP_KEY: 'test-app', YOUDAO_APP_SECRET: 'test-secret'
    }, fetcher as typeof fetch);

    expect(result.componentVariants.en).toEqual(expect.objectContaining({
      street: 'Tverskaya ulitsa', locality: 'Moskva', houseNumber: '45-9', postcode: '168-0063'
    }));
    expect(result.componentVariants['zh-CN']).toEqual(expect.objectContaining({
      street: '特维尔大街', locality: '莫斯科', houseNumber: '45-9', postcode: '168-0063'
    }));
    expect(requests.filter((form) => form.has('appKey')).map((form) => [form.get('from'), form.get('to')]))
      .toEqual([['auto', 'zh-CHS']]);
  });

  it('rejects a nearby reverse result with the same house number but a different street and locality', async () => {
    const country = countryByCode.get('JP')!;
    const native = component('和泉二丁目', '杉並区', '東京都');
    const source = address(native);
    source.componentVariants = { native, en: native, 'zh-CN': native };
    const fetcher = async () => new Response(JSON.stringify({ results: [{
      housenumber: '45-9', street: '隣町通り', city: '中野区', state: '東京都', postcode: '164-0001', country_code: 'jp'
    }] }), { status: 200, headers: { 'content-type': 'application/json' } });

    const result = await localizeAddress(source, country, { GEOAPIFY_API_KEY: 'test' }, fetcher as typeof fetch);

    expect(result.componentVariants.en.street).toBe('和泉二丁目');
    expect(result.componentVariants.en.locality).toBe('杉並区');
  });

  it('preserves the provider postal locality when reverse geocoding returns an administrative city', async () => {
    const country = countryByCode.get('JP')!;
    const native = { ...component('和泉二丁目', '東京', '東京都'), postalLocality: '杉並区' };
    const source = address(native);
    source.componentVariants = { native, en: native, 'zh-CN': native };
    const fetcher = async () => new Response(JSON.stringify({ results: [{
      housenumber: '45-9', street: '和泉二丁目', city: '東京', state: '東京都', postcode: '168-0063', country_code: 'jp'
    }] }), { status: 200, headers: { 'content-type': 'application/json' } });

    const result = await localizeAddress(source, country, { GEOAPIFY_API_KEY: 'test' }, fetcher as typeof fetch);

    expect(result.componentVariants.en.postalLocality).toBe('杉並区');
    expect(result.componentVariants['zh-CN'].postalLocality).toBe('杉并区');
  });

  it('does not collapse equal source city and state names into one translated administrative role', async () => {
    const country = countryByCode.get('SA')!;
    const native = component('شارع الاختبار', 'نيويورك', 'نيويورك');
    const source = address(native);
    source.countryCode = 'SA';
    source.nativeLanguage = 'ar';
    source.evidence[0].sourceId = 'fixture';
    source.componentVariants = {
      native,
      en: component('Test Street', 'New York', 'New York'),
      'zh-CN': component('测试街', '纽约市', '纽约州')
    };

    const result = await localizeAddress(source, country, {});

    expect(result.componentVariants['zh-CN'].locality).toBe('纽约市');
    expect(result.componentVariants['zh-CN'].admin1).toBe('纽约州');
  });

  it('restores canonical postal identifiers and rejects translated numeric substrings', async () => {
    const country = countryByCode.get('SA')!;
    const native = { ...component('Route 12', 'Riyadh', 'Riyadh'), houseNumber: '12', unit: '4B', postcode: '12345', admin1Code: '01' };
    const source = address(native);
    source.countryCode = 'SA';
    source.nativeLanguage = 'ar';
    source.evidence[0].sourceId = 'fixture';
    source.componentVariants = {
      native,
      en: { ...native, houseNumber: '312', unit: '9Z', postcode: '99999', admin1Code: 'XX' },
      'zh-CN': { ...native, houseNumber: '312', unit: '9Z', postcode: '99999', admin1Code: 'XX' }
    };
    const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const form = new URLSearchParams(String(init?.body));
      const values = form.getAll('q');
      return new Response(JSON.stringify({
        errorCode: '0',
        translateResults: values.map((value) => ({ query: value, translation: value === 'Route 12' ? '道路312' : '测试地点' }))
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const result = await localizeAddress(source, country, {
      YOUDAO_APP_KEY: 'test-app', YOUDAO_APP_SECRET: 'test-secret'
    }, fetcher as typeof fetch);

    expect(result.componentVariants['zh-CN'].street).toBe('Route 12');
    for (const language of ['en', 'zh-CN'] as const) {
      expect(result.componentVariants[language]).toMatchObject({
        houseNumber: '12', unit: '4B', postcode: '12345', admin1Code: '01'
      });
    }
  });

  it('converts Amap GCJ-02 coordinates before Google Maps use', () => {
    const result = gcj02ToWgs84(39.833836, 116.30127);
    expect(result.latitude).toBeCloseTo(39.83244, 3);
    expect(result.longitude).toBeCloseTo(116.29511, 3);
  });
});
