import { describe, expect, it } from 'vitest';
import { countryLanguages, nonResidentialRules } from '../src/domain/non-residential-rules.mjs';
import { findNonResidentialMatch, isNonResidentialAddress, isVerifiedAddressNonResidential } from '../src/domain/non-residential.mjs';
import { normalizeAddress } from '../scripts/lib/address-pool.mjs';

describe('non-residential rule coverage', () => {
  it('maps every supported country to complete rule languages', () => {
    expect(Object.keys(countryLanguages)).toHaveLength(27);
    expect(Object.keys(nonResidentialRules)).toEqual([
      'government',
      'military_law_justice',
      'education_research',
      'healthcare_care',
      'finance',
      'fire_utilities',
      'transport_logistics',
      'religious_funeral_public',
      'hospitality_commercial_industrial',
      'localCommerce'
    ]);
    for (const languages of Object.values(countryLanguages)) {
      for (const language of languages) {
        for (const rule of Object.values(nonResidentialRules)) expect(rule.terms[language]?.length).toBeGreaterThan(0);
      }
    }
  });

  it.each([
    ['US', 'Philadelphia City Hall'], ['CA', 'Hotel de Ville de Montreal'], ['MX', 'Hospital General'],
    ['GB', 'Central Police Station'], ['DE', 'Berliner Rathaus'], ['FR', 'Banque de France'],
    ['IT', 'Stazione di Polizia Centrale'], ['ES', 'Universidad Central'], ['NL', 'Brandweerkazerne Centrum'],
    ['RU', 'Городская больница'], ['JP', '新宿区役所'], ['HK', '香港警察局'], ['SG', 'National University'],
    ['TW', '臺大醫院'], ['KR', '서울대학교'], ['MY', 'Balai Polis Sentral'], ['CN', '北京大学'],
    ['TH', 'โรงพยาบาลกลาง'], ['PH', 'Himpilan ng Pulis'], ['VN', 'Bệnh viện Trung ương'],
    ['TR', 'Merkez Polis Karakolu'], ['SA', 'مركز شرطة الرياض'], ['IN', 'Central High School'],
    ['AU', 'Central Fire Station'], ['BR', 'Banco Central'], ['NG', 'State University'], ['ZA', 'Central Shopping Mall']
  ])('recognizes an institution in %s using its mapped languages', (countryCode, buildingName) => {
    expect(isNonResidentialAddress({ countryCode, buildingName })).toBe(true);
  });

  it.each([
    ['government', 'US', 'City Hall'],
    ['military_law_justice', 'US', 'Central Police Station'],
    ['education_research', 'US', 'State University'],
    ['healthcare_care', 'US', 'General Hospital'],
    ['finance', 'US', 'Community Bank'],
    ['fire_utilities', 'US', 'North Fire Station'],
    ['transport_logistics', 'US', 'Regional Logistics Center'],
    ['religious_funeral_public', 'US', 'Central Library'],
    ['hospitality_commercial_industrial', 'US', 'Grand Hotel'],
    ['localCommerce', 'US', 'Main Street Barber Shop']
  ])('reports the stable %s category', (category, countryCode, buildingName) => {
    expect(findNonResidentialMatch({ countryCode, buildingName })).toMatchObject({ excluded: true, category });
  });

  it.each([
    '某某有限公司', '光明理发店', '幸福超市', '老王汽修厂', '中石化加油站', '菜鸟驿站',
    '万达售楼处', '兰州拉面馆', '红星美容院', '飞翔网吧', '康泰大药房', '如家招待所'
  ])('excludes common Chinese commercial POI: %s', (buildingName) => {
    expect(isNonResidentialAddress({ countryCode: 'CN', buildingName })).toBe(true);
  });

  it.each(['幸福家园', '世纪花园', '中海国际社区', '万科城市花园', '恒大名都', '翡翠湾'])
    ('keeps Chinese residential community names: %s', (buildingName) => {
      expect(isNonResidentialAddress({ countryCode: 'CN', buildingName })).toBe(false);
    });

  it.each(['Bank Street', 'Church Street', 'Hospital Road', 'Hotel Street', 'University Avenue'])
    ('does not treat a street name as an institution: %s', (street) => {
      expect(isNonResidentialAddress({
        countryCode: 'US', street, formattedAddress: `10 ${street}, Philadelphia, PA 19103`
      })).toBe(false);
    });

  it.each(['Bankston House', 'Churchill Court', 'Hospitality House', 'Hotelier Residence'])
    ('uses token boundaries for alphabetic building names: %s', (buildingName) => {
      expect(isNonResidentialAddress({ countryCode: 'US', buildingName })).toBe(false);
    });

  it('protects a CJK street match while rejecting an explicit CJK institution', () => {
    expect(isNonResidentialAddress({
      countryCode: 'CN', street: '医院路', formattedAddress: '医院路12号，北京市'
    })).toBe(false);
    expect(findNonResidentialMatch({ countryCode: 'CN', buildingName: '北京大学人民医院' }))
      .toMatchObject({ excluded: true });
  });

  it.each([
    '唐山市财政局', '丰润区税务局', '西安海关', '铜川市检察院', '城北拘留所',
    '中国期货交易所', '华北基金公司', '中央清算中心', '东城典当行',
    '荔枝角收押所', '探訪登記室', '香港懲教署', '政府合署', '廉政公署', '九龙健康院'
  ])('rejects an explicitly excluded Chinese institution: %s', (buildingName) => {
    expect(isNonResidentialAddress({ countryCode: 'CN', buildingName })).toBe(true);
  });

  it.each([
    ['US', 'International Financial Center'], ['HK', '香港金融管理局'], ['CN', '上海金融中心'],
    ['JP', '東京金融庁'], ['DE', 'Frankfurt Finanzzentrum'], ['FR', 'Autorité Monétaire'],
    ['BR', 'Centro Financeiro Central'], ['SA', 'هيئة الرقابة المالية']
  ])('rejects financial centers and regulators in %s: %s', (countryCode, buildingName) => {
    expect(findNonResidentialMatch({ countryCode, buildingName })).toMatchObject({ excluded: true, category: 'finance' });
  });

  it('revalidates a serialized provider candidate using all localized variants', () => {
    expect(isVerifiedAddressNonResidential({
      countryCode: 'HK', propertyType: 'unknown', nativeAddress: '九龍荔枝角收押所探訪登記室香港',
      formattedAddress: 'VISIT REGISTRATION ROOM, LAI CHI KOK RECEPTION CENTRE, HONG KONG',
      addressVariants: {
        native: '九龍荔枝角收押所探訪登記室香港',
        en: 'VISIT REGISTRATION ROOM, LAI CHI KOK RECEPTION CENTRE, HONG KONG',
        'zh-CN': '九龙荔枝角收押所探访登记室香港'
      },
      componentVariants: {
        native: { street: '蝴蝶谷道', buildingName: '探訪登記室', locality: '荔枝角', postcode: '', houseNumber: '3-5號' },
        en: { street: 'BUTTERFLY VALLEY ROAD', buildingName: 'VISIT REGISTRATION ROOM', locality: 'LAI CHI KOK', postcode: '', houseNumber: '3-5' },
        'zh-CN': { street: '蝴蝶谷道', buildingName: '探访登记室', locality: '荔枝角', postcode: '', houseNumber: '3-5号' }
      }
    })).toBe(true);
  });

  it.each(['CN', 'JP', 'FR'])('applies common English provider terms in %s', (countryCode) => {
    expect(isNonResidentialAddress({ countryCode, buildingName: 'Central Police Station' })).toBe(true);
  });

  it('rejects provider classifications without relying on display text', () => {
    expect(findNonResidentialMatch({ countryCode: 'US', classifications: ['dormitory'] }))
      .toEqual({ excluded: true, category: 'hospitality_commercial_industrial', term: 'dormitory', field: 'classification' });
  });

  it('rejects an institution before the offline importer writes it', () => {
    const { errors } = normalizeAddress({
      country_code: 'US', street: 'Market Street', house_number: '1', building_name: 'Central Police Station',
      latitude: '39.95', longitude: '-75.16', property_type: 'unknown', source_id: 'fixture',
      source_name: 'Fixture', source_url: 'https://example.test/source', source_license: 'CC0-1.0'
    });
    expect(errors).toContain('non-residential:military_law_justice:buildingName:police station');
  });

  it('rejects a US city stored as a state while accepting the real subdivision', () => {
    const source = {
      country_code: 'US', street: 'Market Street', house_number: '10', locality: 'Philadelphia',
      latitude: '39.95', longitude: '-75.16', property_type: 'residential', source_id: 'fixture',
      source_name: 'Fixture', source_url: 'https://example.test/source', source_license: 'CC0-1.0'
    };
    expect(normalizeAddress({ ...source, admin1: 'Philadelphia' }).errors)
      .toContain('administrative-hierarchy:invalid-us-admin1');
    expect(normalizeAddress({ ...source, admin1: 'Pennsylvania', admin1_code: 'PA' }).errors).toEqual([]);
  });

  it('normalizes a 112xx postal locality to Brooklyn during import', () => {
    const { address, errors } = normalizeAddress({
      country_code: 'US', admin1: 'New York', admin1_code: 'NY', locality: 'New York',
      postal_locality: 'New York', postcode: '11217', street: 'Dean Street', house_number: '478',
      latitude: '40.681116', longitude: '-73.975375', property_type: 'residential', source_id: 'fixture',
      source_name: 'Fixture', source_url: 'https://example.test/source', source_license: 'CC0-1.0'
    });
    expect(errors).toEqual([]);
    expect(address.postalLocality).toBe('Brooklyn');
  });
});
