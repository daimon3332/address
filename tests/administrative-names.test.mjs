import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeTestDatabase, openTestDatabase } from './helpers/postgres-test-database.mjs';
import { PostgresDatabase } from '../server/database/postgres.mjs';
import { addressCanonicalKey, localityIssue, validateAddressQuality } from '../src/domain/address-quality.mjs';
import { administrativeNamesRevision, createAdministrativeNames, singaporeRegion } from '../server/sync/administrative-names.mjs';
import { bdnbDepartment, repairAdministrativeNames, wrongPostalArea } from '../server/sync/administrative-names-repair.mjs';

const at = '2026-10-12T00:00:00.000Z';
const noRegions = async () => new Map();
const canada = createAdministrativeNames('CA', [
  { id: 1, parent_id: null, code: 'QC', name: 'Quebec', native_name: 'Québec', zh_name: '魁北克省' },
  { id: 2, parent_id: null, code: 'NB', name: 'New Brunswick', native_name: 'New Brunswick', zh_name: '新不伦瑞克省' },
  { id: 3, parent_id: null, code: 'AB', name: 'Alberta', native_name: 'Alberta', zh_name: '阿尔伯塔省' }
], [{ region_id: 3, name: 'Calgary', native_name: 'Calgary', zh_name: '卡尔加里' }]);

describe('administrative names', () => {
  it('takes the region from the admin1 text, corrects a centroid code and never machine-translates the code', () => {
    expect(canada.names({ admin1: 'QC', admin1Code: 'NB', locality: 'Dorval' })).toEqual({
      native: { admin1Code: 'QC' }, en: { admin1: 'QC' }, 'zh-CN': { admin1: '魁北克省' }
    });
    expect(canada.names({ admin1: 'Alberta', admin1Code: 'AB', locality: 'Calgary' })).toEqual({
      native: {}, en: { admin1: 'Alberta' }, 'zh-CN': { admin1: '阿尔伯塔省', locality: '卡尔加里' }
    });
    expect(canada.names({ admin1: '', admin1Code: 'NB' })['zh-CN']).toEqual({ admin1: '新不伦瑞克省' });
  });

  it('renames merged Vietnamese provinces, recognizes official spellings and locates unrecognized regions by polygon', () => {
    const vietnam = createAdministrativeNames('VN', [
      { id: 1, parent_id: null, code: 'DN', name: 'Da Nang', native_name: 'Đà Nẵng', zh_name: '岘港市' },
      { id: 2, parent_id: null, code: 'HN', name: 'Hanoi', native_name: 'Hà Nội', zh_name: '河内' }
    ]);
    expect(vietnam.names({ admin1: 'Tỉnh Quảng Nam' }).native).toEqual({ admin1: 'Đà Nẵng' });
    expect(vietnam.names({ admin1: 'Thành phố Hà Nội' })).toEqual({ native: {}, en: { admin1: 'Hanoi' }, 'zh-CN': { admin1: '河内' } });
    expect(vietnam.regionRecognized({ admin1: '05113628339' })).toBe(false);
    expect(vietnam.unrecognizedRegion({ admin1: '05113628339' }, { code: 'VN-DN' })).toMatchObject({ admin1: 'Đà Nẵng', admin1Code: 'DN' });
    expect(vietnam.unrecognizedRegion({ admin1: 'Hà Nội' }, { code: 'VN-DN' })).toBeNull();
    const france = createAdministrativeNames('FR', [{ id: 1, parent_id: null, code: '971', name: 'Guadeloupe', native_name: 'Guadeloupe', zh_name: '瓜德罗普' },
      { id: 2, parent_id: null, code: 'IDF', name: 'Île-de-France', native_name: 'Île-de-France', zh_name: '法兰西岛' }],
    [{ region_id: 1, name: 'Pointe-à-Pitre', native_name: 'Pointe-à-Pitre', zh_name: '' }, { region_id: 1, name: 'Paris', native_name: 'Paris', zh_name: '' },
      { region_id: 2, name: 'Paris', native_name: 'Paris', zh_name: '' }]);
    expect(france.unrecognizedRegion({ admin1: '', locality: 'Pointe-A-Pitre' }, { code: '' })).toMatchObject({ admin1: 'Guadeloupe', admin1Code: '971' });
    expect(france.unrecognizedRegion({ admin1: '', locality: 'Paris' }, { code: '' })).toBeNull();
    expect(france.unrecognizedRegion({ admin1: 'Typo', locality: 'Pointe-A-Pitre' }, { code: '' })).toBeNull();
    const islands = createAdministrativeNames('FR', [{ id: 1, parent_id: null, code: '971', name: 'Guadeloupe', native_name: 'Guadeloupe', zh_name: '' },
      { id: 2, parent_id: null, code: '972', name: 'Martinique', native_name: 'Martinique', zh_name: '' }],
    [{ region_id: 1, name: 'Les Abymes', native_name: 'Les Abymes', zh_name: '', latitude: 16.27, longitude: -61.5 },
      { region_id: 2, name: 'Fort-de-France', native_name: 'Fort-de-France', zh_name: '', latitude: 14.6, longitude: -61.07 }]);
    expect(islands.unrecognizedRegion({ admin1: '', locality: 'Pointe-A-Pitre' }, { code: '' }, { latitude: 16.25, longitude: -61.55 }))
      .toMatchObject({ admin1: 'Guadeloupe' });
    expect(islands.unrecognizedRegion({ admin1: '', locality: 'Nowhere' }, { code: '' }, { latitude: 15.5, longitude: -61.3 })).toBeNull();
    const philippines = createAdministrativeNames('PH', [{ id: 1, parent_id: null, code: '00', name: 'National Capital Region (Metro Manila)',
      native_name: 'National Capital Region (Metro Manila)', zh_name: '国家首都区' }]);
    expect(philippines.names({ admin1: 'Metro Manila' })).toMatchObject({ native: {}, en: { admin1: 'Metro Manila' } });
    const singapore = singaporeRegion([{ name: 'Central Singapore', native_name: 'Central Singapore', zh_name: '新加坡中部' }]);
    expect(singapore({ admin1: '東京都' })).toMatchObject({ admin1: 'Singapore', admin1Zh: '新加坡' });
    expect([singapore({ admin1: 'Singapore' }), singapore({ admin1: 'Central Singapore' }), singapore({ admin1: '' })]).toEqual([null, null, null]);
    const india = createAdministrativeNames('IN', [{ id: 1, parent_id: null, code: 'KL', name: 'Kerala', native_name: 'Kerala', zh_name: '喀拉拉邦' }]);
    expect(india.names({ admin1: 'kerala', locality: 'Pathanamthitta' }, { en: { admin1: 'Kerala', locality: 'Pattanamtitta' }, 'zh-CN': {} }))
      .toMatchObject({ native: { admin1: 'Kerala' }, en: { admin1: 'Kerala', locality: 'Pathanamthitta' } });
    const japanShort = createAdministrativeNames('JP', [{ id: 1, parent_id: null, code: '27', name: 'Ōsaka', native_name: '大阪', zh_name: '大阪' }]);
    expect(japanShort.regionRecognized({ admin1: '大阪府' })).toBe(true);
    expect(japanShort.unrecognizedRegion({ admin1: '大阪府' }, { code: 'JP-27' })).toBeNull();
    const japan = createAdministrativeNames('JP', [{ id: 1, parent_id: null, code: '27', name: 'Ōsaka', native_name: '大阪府', zh_name: '大阪' }]);
    expect(japan.names({ admin1: '大阪', admin1Code: '27' }).native).toEqual({ admin1: '大阪府' });
    expect(japan.names({ admin1: '大阪府', admin1Code: '27' }).native).toEqual({});
    const kyoto = createAdministrativeNames('JP', [{ id: 1, parent_id: null, code: '26', name: 'Kyōto', native_name: '京都府', zh_name: '京都' }]);
    expect(kyoto.names({ admin1: '京都', admin1Code: '26' }).native).toEqual({ admin1: '京都府' });
    const korea = createAdministrativeNames('KR', [{ id: 1, parent_id: null, code: '29', name: 'Gwangju', native_name: '광주', zh_name: '光州' }]);
    expect(korea.unrecognizedRegion({ admin1: '전남광주통합특별시' }, { code: 'KR-29' })).toBeNull();
    expect(korea.unrecognizedRegion({ admin1: '전남특별자치도' }, { code: '', name: '전남광주통합특별시' }))
      .toMatchObject({ admin1: '전남광주통합특별시', admin1Zh: '全罗南道光州统一特别市' });
    expect(korea.names({ admin1: '전남광주통합특별시' })).toEqual({ native: {}, en: { admin1: 'Jeonnam Gwangju Unified Special City' },
      'zh-CN': { admin1: '全罗南道光州统一特别市' } });
    const states = createAdministrativeNames('US', [{ id: 1, parent_id: null, code: 'TX', name: 'Texas', native_name: 'Texas', zh_name: '德克萨斯州' }]);
    expect(states.unrecognizedRegion({ admin1: 'PR', admin1Code: 'PR' }, { code: 'US-TX' })).toBeNull();
    expect(states.unrecognizedRegion({ admin1: 'Tejas' }, { code: 'US-TX' })).toMatchObject({ admin1: 'TX', admin1Code: 'TX' });
  });

  it('names regions written as codes outside postal-code countries and keeps Italian province codes', () => {
    const germany = createAdministrativeNames('DE', [{ id: 1, parent_id: null, code: 'BW', name: 'Baden-Württemberg', native_name: 'Baden-Württemberg', zh_name: '巴登-符腾堡州' }]);
    expect(germany.names({ admin1: 'BW', locality: 'Stuttgart' })).toEqual({
      native: { admin1: 'Baden-Württemberg' }, en: { admin1: 'Baden-Württemberg' }, 'zh-CN': { admin1: '巴登-符腾堡州' }
    });
    const italy = createAdministrativeNames('IT', [
      { id: 1, parent_id: null, code: '21', name: 'Piedmont', native_name: 'Piemonte', zh_name: '皮埃蒙特' },
      { id: 2, parent_id: 1, code: 'CN', name: 'Cuneo', native_name: 'Cuneo', zh_name: '库尼奥' }
    ]);
    expect(italy.names({ admin1: 'Piemonte', admin1Code: 'CN' })).toEqual({ native: {}, en: { admin1: 'Piedmont' }, 'zh-CN': { admin1: '皮埃蒙特' } });
    expect(italy.names({ admin1: 'Cuneo', admin1Code: 'CN' })).toEqual({ native: {}, en: { admin1: 'Cuneo' }, 'zh-CN': { admin1: '库尼奥' } });
    expect(italy.regionFor({ admin1: 'Cuneo' }).root.native_name).toBe('Piemonte');
  });

  it('skips catalog names shared by two regions, keeps Japanese Chinese names and only fills missing English cities', () => {
    const russia = createAdministrativeNames('RU', [
      { id: 1, parent_id: null, code: 'MOW', name: 'Moscow', native_name: 'Москва', zh_name: '莫斯科' },
      { id: 2, parent_id: null, code: 'MOS', name: 'Moscow', native_name: 'Московская область', zh_name: '莫斯科州' }
    ], [{ region_id: 2, name: 'Sasovo', native_name: 'Сасово', zh_name: '萨索沃' }]);
    const stored = { en: { admin1: 'Moscow Oblast', locality: 'Sasovo' }, 'zh-CN': {} };
    expect(russia.names({ admin1: 'Московская область', locality: 'Сасово' }, stored))
      .toEqual({ native: {}, en: {}, 'zh-CN': { admin1: '莫斯科州', locality: '萨索沃' } });
    expect(russia.names({ admin1: 'Московская область', locality: 'Сасово' }, { en: { locality: 'Сасово' }, 'zh-CN': {} }).en)
      .toEqual({ locality: 'Sasovo' });
    const japan = createAdministrativeNames('JP', [{ id: 1, parent_id: null, code: '28', name: 'Hyōgo', native_name: '兵庫県', zh_name: '兵库县' }],
      [{ region_id: 1, name: 'Sumoto Shi', native_name: '洲本市', zh_name: '洲本士' }]);
    expect(japan.names({ admin1: '兵庫県', locality: '洲本市' }, { en: { locality: 'Sumoto City' }, 'zh-CN': { admin1: '兵库县', locality: '洲本市' } })['zh-CN']).toEqual({});
  });

  it('finds the region of a catalog postcode from its full code or outward part', () => {
    const names = createAdministrativeNames('CA', [
      { id: 1, parent_id: null, code: 'QC', name: 'Quebec', native_name: 'Québec', zh_name: '魁北克省' },
      { id: 2, parent_id: null, code: 'NB', name: 'New Brunswick', native_name: 'New Brunswick', zh_name: '新不伦瑞克省' }
    ], [], [{ region_id: 1, code: 'H9S' }, { region_id: 2, code: 'E1A' }, { region_id: 1, code: 'K1A' }, { region_id: 2, code: 'K1A' }]);
    expect(names.postcodeRegionFor('H9S 2G2')?.code).toBe('QC');
    expect(names.postcodeRegionFor('e1a 1a1')?.code).toBe('NB');
    expect(names.postcodeRegionFor('K1A 0B1')).toBeNull();
    expect(names.postcodeRegionFor('X0A 0H0')).toBeNull();
  });

  it('reads bilingual and punctuated regions and defers text naming no region to a code the city confirms', () => {
    expect(canada.names({ admin1: 'New Brunswick / Nouveau-Brunswick', admin1Code: 'NB' })).toEqual({
      native: { admin1: 'New Brunswick' }, en: { admin1: 'New Brunswick' }, 'zh-CN': { admin1: '新不伦瑞克省' }
    });
    expect(canada.names({ admin1: 'a.b.', admin1Code: 'AB', locality: 'Calgary' }).native).toEqual({ admin1: 'AB' });
    const brazil = createAdministrativeNames('BR', [
      { id: 1, parent_id: null, code: 'PI', name: 'Piauí', native_name: 'Piauí', zh_name: '皮奥伊州' },
      { id: 2, parent_id: null, code: 'MA', name: 'Maranhão', native_name: 'Maranhão', zh_name: '马拉尼昂州' }
    ], [{ region_id: 1, name: 'Teresina', native_name: 'Teresina', zh_name: '特雷西纳' }, { region_id: 2, name: 'Timon', native_name: 'Timon', zh_name: '' }]);
    expect(brazil.names({ admin1: 'Brasil', admin1Code: 'PI', locality: 'Teresina' })).toEqual({
      native: { admin1: 'PI' }, en: { admin1: 'PI', locality: 'Teresina' }, 'zh-CN': { admin1: '皮奥伊州', locality: '特雷西纳' }
    });
    expect(brazil.regionFor({ admin1: 'Brasil', admin1Code: 'PI', locality: 'Timon' })).toBeNull();
    expect(brazil.regionFor({ admin1: 'Brasil', admin1Code: 'MA' })).toBeNull();
    const russia = createAdministrativeNames('RU', [{ id: 1, parent_id: null, code: 'BEL', name: 'Belgorod', native_name: 'Белгород', zh_name: '别尔哥罗德' }],
      [{ region_id: 1, name: 'Stroitel', native_name: 'Строитель', zh_name: '斯特罗伊捷利' }]);
    expect(russia.names({ admin1: 'Белгородская область', admin1Code: 'BEL', locality: 'Строитель' })).toEqual({ native: {},
      en: { admin1: 'Belgorod', locality: 'Stroitel' }, 'zh-CN': { admin1: '别尔哥罗德', locality: '斯特罗伊捷利' } });
  });

  it('moves an admin1 from another first-level region into the polygon region, keeping its level', () => {
    const spain = createAdministrativeNames('ES', [
      { id: 1, parent_id: null, code: 'EX', name: 'Extremadura', native_name: 'Extremadura', zh_name: '埃斯特雷马杜拉' },
      { id: 2, parent_id: null, code: 'CL', name: 'Castile and Leon', native_name: 'Castilla y León', zh_name: '卡斯蒂利亚-莱昂' },
      { id: 3, parent_id: 1, code: 'CC', name: 'Caceres', native_name: 'Cáceres', zh_name: '卡塞雷斯省' },
      { id: 4, parent_id: 2, code: 'SA', name: 'Salamanca', native_name: 'Salamanca', zh_name: '萨拉曼卡省' },
      { id: 5, parent_id: 1, code: 'BA', name: 'Badajoz', native_name: 'Badajoz', zh_name: '巴达霍斯省' }
    ], [
      { region_id: 3, name: 'Jaraiz de la Vera', native_name: 'Jaraíz de la Vera', zh_name: '', latitude: 40.06, longitude: -5.75 },
      { region_id: 5, name: 'Merida', native_name: 'Mérida', zh_name: '', latitude: 38.9, longitude: -6.3 }
    ], [{ region_id: 3, code: '10400' }, { region_id: 5, code: '06800' }]);
    const jaraiz = { postcode: '10400', latitude: 40.06, longitude: -5.75 };
    expect(spain.regionInBoundary({ admin1: 'Salamanca', admin1Code: 'SA' }, { code: 'ES-EX' }, jaraiz))
      .toEqual({ admin1: 'Cáceres', admin1Code: 'CC', admin1En: 'Caceres', admin1Zh: '卡塞雷斯省' });
    expect(spain.regionInBoundary({ admin1: 'Salamanca' }, { code: 'ES-EX' }, { latitude: 40.07, longitude: -5.74 })).toMatchObject({ admin1Code: 'EX' });
    expect(spain.regionInBoundary({ admin1: 'Salamanca' }, { code: 'ES-EX' }, { latitude: 39.5, longitude: -5 })).toMatchObject({ admin1: 'Extremadura', admin1Code: 'EX' });
    expect(spain.regionInBoundary({ admin1: 'Castilla y León' }, { code: 'ES-EX' }, jaraiz)).toMatchObject({ admin1: 'Extremadura' });
    expect(spain.regionInBoundary({ admin1: 'Badajoz' }, { code: 'ES-EX' }, jaraiz)).toMatchObject({ admin1Code: 'CC' });
    expect(spain.regionInBoundary({ admin1: 'Badajoz' }, { code: 'ES-EX' }, { postcode: '10400', latitude: 38.9, longitude: -6.3 })).toBeNull();
    expect(spain.regionInBoundary({ admin1: 'Cáceres' }, { code: 'ES-EX' }, jaraiz)).toBeNull();
    expect(spain.regionInBoundary({ admin1: 'Extremadura' }, { code: 'ES-EX' }, jaraiz)).toBeNull();
    expect(spain.regionInBoundary({ admin1: 'Vera' }, { code: 'ES-EX' }, jaraiz)).toBeNull();
    expect(spain.regionInBoundary({ admin1: 'Salamanca' }, { code: 'PT-11' }, jaraiz)).toBeNull();
    expect(createAdministrativeNames('DE', []).regionInBoundary({ admin1: 'Bayern' }, { code: 'DE-BY' })).toBeNull();
    // The official prefix names the province where the catalog postcode table does not.
    expect(spain.regionInBoundary({ admin1: 'Salamanca' }, { code: 'ES-EX' }, { postcode: '06900' })).toMatchObject({ admin1Code: 'BA' });
    const france = createAdministrativeNames('FR', [
      { id: 1, parent_id: null, code: 'IDF', name: 'Île-de-France', native_name: 'Île-de-France', zh_name: '法兰西岛' },
      { id: 2, parent_id: null, code: 'NAQ', name: 'Nouvelle-Aquitaine', native_name: 'Nouvelle-Aquitaine', zh_name: '新阿基坦' },
      { id: 3, parent_id: 1, code: '75C', name: 'Paris', native_name: 'Paris', zh_name: '巴黎' },
      { id: 4, parent_id: 1, code: '92', name: 'Hauts-de-Seine', native_name: 'Hauts-de-Seine', zh_name: '上塞纳省' },
      { id: 5, parent_id: 1, code: '6AE', name: 'Alsace', native_name: 'Alsace', zh_name: '阿尔萨斯' }
    ], [
      { region_id: 4, name: 'Montrouge', native_name: 'Montrouge', zh_name: '', latitude: 48.8167, longitude: 2.3167 },
      { region_id: 3, name: 'Paris', native_name: 'Paris', zh_name: '巴黎', latitude: 48.8566, longitude: 2.3522 }
    ]);
    expect(france.regionInBoundary({ admin1: 'Paris' }, { code: 'FR-IDF' }, { postcode: '92120', latitude: 48.8176, longitude: 2.3199 }))
      .toMatchObject({ admin1: 'Hauts-de-Seine', admin1Code: '92' });
    expect(france.regionInBoundary({ admin1: 'Nouvelle-Aquitaine' }, { code: 'FR-IDF' }, { postcode: '75018' })).toMatchObject({ admin1: 'Île-de-France' });
    expect(france.regionInBoundary({ admin1: 'Creuse' }, { code: 'FR-IDF' }, { postcode: '75018' })).toBeNull();
    expect(france.regionInBoundary({ admin1: 'Alsace' }, { code: 'FR-IDF' }, { postcode: '92120', latitude: 48.8176, longitude: 2.3199 })).toBeNull();
    const italy = createAdministrativeNames('IT', [
      { id: 1, parent_id: null, code: '32', name: 'Trentino-South Tyrol', native_name: 'Trentino-Alto Adige', zh_name: '特伦蒂诺-上阿迪杰' },
      { id: 2, parent_id: null, code: '34', name: 'Veneto', native_name: 'Veneto', zh_name: '威尼托' },
      { id: 3, parent_id: 1, code: 'BZ', name: 'South Tyrol', native_name: 'Bolzano', zh_name: '博尔扎诺' },
      { id: 4, parent_id: 2, code: 'BL', name: 'Belluno', native_name: 'Belluno', zh_name: '贝卢诺' }
    ]);
    expect(italy.regionInBoundary({ admin1: 'Belluno', admin1Code: 'BL' }, { code: 'IT-32' }, { postcode: '39030' }))
      .toMatchObject({ admin1: 'Bolzano', admin1Code: 'BZ' });
    expect(italy.regionInBoundary({ admin1: 'Belluno', admin1Code: 'BL' }, { code: 'IT-32' }, {})).toMatchObject({ admin1: 'Trentino-Alto Adige', admin1Code: '' });
  });

  it('corrects the department BDNB exported as Creuse from the postcode', () => {
    const bdnb = 'france-bdnb-rhone-residential-2026-02-a';
    expect(bdnbDepartment('FR', { generation: bdnb, postcode: '69003', district: 'Creuse' })).toBe('Rhône');
    expect(bdnbDepartment('FR', { generation: bdnb, postcode: '13001', district: 'Creuse' })).toBe('');
    expect(bdnbDepartment('FR', { generation: bdnb, postcode: '75012', district: 'Creuse', locality: 'Paris' })).toBe('');
    expect(bdnbDepartment('FR', { generation: bdnb, postcode: '23000', district: 'Creuse' })).toBeNull();
    expect(bdnbDepartment('FR', { generation: 'geofabrik-osm-fr', postcode: '69003', district: 'Creuse' })).toBeNull();
    expect(wrongPostalArea('ZA', { generation: 'cape-town-za', postcode: '7975' })).toBe(false);
    expect(wrongPostalArea('ZA', { generation: 'cape-town-za', postcode: '4001' })).toBe(true);
    expect(wrongPostalArea('ZA', { generation: 'ethekwini-za', postcode: '4001' })).toBe(false);
  });

  it('settles a shortened region name by the code it is part of', () => {
    const russia = createAdministrativeNames('RU', [
      { id: 1, parent_id: null, code: 'AL', name: 'Altai Republic', native_name: 'Республика Алтай', zh_name: '阿尔泰共和国' },
      { id: 2, parent_id: null, code: 'ALT', name: 'Altai Krai', native_name: 'Алтайский край', zh_name: '阿尔泰边疆区' }
    ]);
    expect(russia.names({ admin1: 'Алтай', admin1Code: 'ALT' })).toEqual({
      native: { admin1: 'Алтайский край' }, en: { admin1: 'Altai Krai' }, 'zh-CN': { admin1: '阿尔泰边疆区' }
    });
    expect(russia.names({ admin1: 'Алтай', admin1Code: 'AL' }).native).toEqual({ admin1: 'Республика Алтай' });
    expect(russia.regionFor({ admin1: 'Алтай' })).toBeNull();
  });

  it('names US territories that the state catalog omits', () => {
    const states = createAdministrativeNames('US', [{ id: 1, parent_id: null, code: 'AL', name: 'Alabama', native_name: 'Alabama', zh_name: '阿拉巴马州' }]);
    expect(states.names({ admin1: 'AL', admin1Code: 'AL' })).toEqual({ native: {}, en: { admin1: 'AL' }, 'zh-CN': { admin1: '阿拉巴马州' } });
    expect(states.names({ admin1: 'PR', admin1Code: 'PR', locality: 'San Juan' })['zh-CN']).toEqual({ admin1: '波多黎各' });
  });

  it('rejects city fields that hold a region code, a number, a postcode or a chained Thai address', () => {
    expect(localityIssue('US', { admin1: 'VI', admin1Code: 'VI', locality: 'VI' })).toBe('locality_region_code');
    expect(localityIssue('VN', { admin1: 'Hồ Chí Minh', locality: '9' })).toBe('locality_number');
    expect(localityIssue('ES', { admin1: 'Málaga', locality: '29649' })).toBe('locality_number');
    expect(localityIssue('FR', { admin1: 'Provence-Alpes-Côte d’Azur', locality: 'Entrevennes0' })).toBe('locality_trailing_number');
    expect(localityIssue('US', { admin1: 'NM', locality: 'SOCORR0' })).toBe('locality_trailing_number');
    expect(localityIssue('VN', { admin1: 'Hồ Chí Minh', locality: 'Phường 12' })).toBe('');
    expect(localityIssue('FR', { admin1: 'Île-de-France', locality: 'Paris 15e Arrondissement' })).toBe('');
    expect(localityIssue('TH', { admin1: 'อุตรดิตถ์', locality: 'ตําบล ท่าอิฐ อําเภอเมืองอุตรดิตถ์ อุตรดิตถ์ 53000' })).toBe('locality_postcode');
    expect(localityIssue('TH', { admin1: 'กรุงเทพมหานคร', locality: 'บางไผ่ บางแค กรุงเทพฯ' })).toBe('locality_concatenated');
    expect(localityIssue('TH', { admin1: 'เชียงราย', locality: 'ตำบลป่าแดด อำเภอเมือง' })).toBe('locality_concatenated');
    expect(localityIssue('TH', { admin1: 'เชียงราย', locality: 'อําเภอเวียงแก่น' })).toBe('');
    for (const [country, locality] of [['AU', 'RYE'], ['US', 'Fifty Six'], ['GB', 'London'], ['NG', 'Ikeja']]) {
      expect(localityIssue(country, { admin1: 'VIC', locality })).toBe('');
    }
    expect(validateAddressQuality({ countryCode: 'US', components: { street: 'Marina Drive', houseNumber: '3241', locality: 'VI', admin1: 'VI', admin1Code: 'VI' } }).reasons)
      .toContain('invalid_locality');
  });
});

const insert = (database, id, native, { latitude = 45.44, longitude = -73.77, zh = {}, countryCode = 'CA', generation = 'v1' } = {}) => database.prepare(`INSERT INTO address_pool(
    id,canonical_key,country_code,admin1,admin1_code,locality,postal_locality,postcode,street,house_number,latitude,longitude,native_language,
    component_variants_json,address_variants_json,property_type,quality_score,generation,coverage,random_key,active,first_seen_at,last_seen_at,match_level)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'en',?,'{}','residential',.9,?,'x',1,1,?,?,'premise')`).bind(
  id, addressCanonicalKey(countryCode, native, 'premise'), countryCode, native.admin1, native.admin1Code || '', native.locality, native.postalLocality || '',
  native.postcode || '', native.street, native.houseNumber, latitude, longitude, JSON.stringify({ native, en: native, 'zh-CN': { ...native, ...zh } }),
  generation, at, at
).run();

describe('administrative names repair', () => {
  let database;
  beforeEach(async () => {
    database = openTestDatabase();
    const exec = PostgresDatabase.prototype.exec;
    vi.spyOn(PostgresDatabase.prototype, 'exec').mockImplementation(function (sql) {
      if (/^(LOCK TABLE|SET LOCAL)/u.test(sql)) return Promise.resolve();
      return exec.call(this, sql);
    });
    await initializeTestDatabase(database, new URL('../server/control/schema.sql', import.meta.url));
    await database.exec(`INSERT INTO catalog_regions(id,country_code,code,name,native_name,zh_name,path,latitude,longitude)
      VALUES (1,'CA','QC','Quebec','Québec','魁北克省','/1/',52.9,-73.5),(2,'CA','NB','New Brunswick','New Brunswick','新不伦瑞克省','/2/',46.5,-66.2)`);
  });
  afterEach(async () => { await database.close(); vi.restoreAllMocks(); });

  it('corrects codes and Chinese names, retires rows whose city is a code, and runs once', async () => {
    await insert(database, 'dorval', { street: 'Avenue Dorval', houseNumber: '10', locality: 'Dorval', admin1: 'QC', admin1Code: 'NB' }, { zh: { admin1: '质量控制' } });
    await insert(database, 'code-city', { street: 'Rue Principale', houseNumber: '5', locality: 'QC', admin1: 'QC', admin1Code: 'QC' });
    await insert(database, 'fine', { street: 'Main Street', houseNumber: '7', locality: 'Moncton', admin1: 'NB', admin1Code: 'NB' },
      { latitude: 46.09, longitude: -64.78, zh: { admin1: '新不伦瑞克省' } });
    await insert(database, 'same-district', { street: 'Rue Saint-Jean', houseNumber: '3', locality: 'Laval', district: 'Laval', admin1: 'QC', admin1Code: 'NB' });
    await insert(database, 'v1-retired', { street: 'Rue Notre-Dame', houseNumber: '9', locality: 'Lachine', admin1: 'QC', admin1Code: 'QC' });
    await database.prepare("UPDATE address_pool SET active=0,retired_at='publication-validation:administrative-names-v1:2026-10-12T10:00:00.000Z' WHERE id='v1-retired'").run();

    expect(await repairAdministrativeNames({ database, countryCode: 'CA', regionLookup: noRegions, pauseMs: 0, now: () => new Date(at) }))
      .toEqual({ countryCode: 'CA', changed: 3, codes: 2, localities: 0, postcodes: 0, retired: 1, duplicates: 0, restored: 1 });
    const rows = new Map((await database.prepare('SELECT * FROM address_pool').all()).results.map((row) => [row.id, row]));
    expect(rows.get('dorval')).toMatchObject({ admin1_code: 'QC', admin1_code_key: 'qc', active: 1 });
    expect(JSON.parse(rows.get('dorval').component_variants_json)['zh-CN'].admin1).toBe('魁北克省');
    expect(JSON.parse(rows.get('dorval').address_variants_json)['zh-CN']).toContain('魁北克省');
    expect(rows.get('code-city')).toMatchObject({ active: 0, retired_at: `publication-validation:${administrativeNamesRevision('CA')}:${at}` });
    expect(rows.get('same-district')).toMatchObject({ admin1_code: 'QC', active: 1 });
    expect(rows.get('v1-retired')).toMatchObject({ active: 1, retired_at: null });
    expect(rows.get('fine')).toMatchObject({ admin1_code: 'NB', active: 1 });
    expect(await repairAdministrativeNames({ database, countryCode: 'CA', regionLookup: noRegions, pauseMs: 0 })).toMatchObject({ changed: 0 });
  });

  it('judges only the given published rows outside the country pass and leaves the revision unrecorded', async () => {
    await insert(database, 'filled', { street: 'Avenue Dorval', houseNumber: '10', locality: 'Dorval', admin1: 'QC', admin1Code: 'NB' });
    await insert(database, 'other', { street: 'Rue Principale', houseNumber: '5', locality: 'Laval', admin1: 'QC', admin1Code: 'NB' });

    expect(await repairAdministrativeNames({ database, countryCode: 'CA', regionLookup: noRegions, pauseMs: 0, addressIds: ['filled'] }))
      .toMatchObject({ changed: 1, codes: 1 });
    const codes = Object.fromEntries((await database.prepare('SELECT id,admin1_code FROM address_pool').all()).results
      .map((row) => [row.id, row.admin1_code]));
    expect(codes).toEqual({ filled: 'QC', other: 'NB' });
    expect(await repairAdministrativeNames({ database, countryCode: 'CA', regionLookup: noRegions, pauseMs: 0 })).toMatchObject({ changed: 1 });
  });

  it('repairs retired rows without publishing them and names a refilled postal city in every variant', async () => {
    await database.exec(`INSERT INTO catalog_cities(id,country_code,region_id,name,native_name,zh_name,latitude,longitude)
      VALUES (1,'CA',1,'Montreal','Montréal','蒙特利尔',45.5,-73.6)`);
    await insert(database, 'retired', { street: 'Rue Wellington', houseNumber: '4', locality: 'Verdun', admin1: 'QC', admin1Code: 'NB' });
    await insert(database, 'retired-twin', { street: 'Rue Wellington', houseNumber: '4', locality: 'Verdun', admin1: 'QC', admin1Code: 'QC' });
    await database.prepare("UPDATE address_pool SET active=0,retired_at='publication-validation:translation:2026-10-11T00:00:00.000Z' WHERE id IN ('retired','retired-twin')").run();
    await insert(database, 'published', { street: 'Rue Wellington', houseNumber: '4', locality: 'Verdun', admin1: 'QC', admin1Code: 'NB' }, { latitude: 45.46 });
    await insert(database, 'postal-code-city', { street: 'Rue Sherbrooke', houseNumber: '8', locality: 'QC', postalLocality: 'QC', admin1: 'QC', admin1Code: 'QC' });

    expect(await repairAdministrativeNames({ database, countryCode: 'CA', regionLookup: noRegions, pauseMs: 0, now: () => new Date(at) }))
      .toMatchObject({ retired: 0, duplicates: 2 });
    const rows = new Map((await database.prepare('SELECT * FROM address_pool').all()).results.map((row) => [row.id, row]));
    expect([...rows.keys()].sort()).toEqual(['postal-code-city', 'published']);
    expect(rows.get('published')).toMatchObject({ admin1_code: 'QC', active: 1 });
    const variants = JSON.parse(rows.get('postal-code-city').component_variants_json);
    expect(variants.native).toMatchObject({ locality: 'Montréal', postalLocality: 'Montréal' });
    expect(variants.en).toMatchObject({ locality: 'Montreal', postalLocality: 'Montreal' });
    expect(variants['zh-CN']).toMatchObject({ locality: '蒙特利尔', postalLocality: '蒙特利尔' });
  });

  it('drops a district repeating the city and retires rows the import gate rejects', async () => {
    await insert(database, 'twin-district', { street: 'Main Street', houseNumber: '7', locality: 'Moncton', district: 'Moncton', admin1: 'NB', admin1Code: 'NB' },
      { latitude: 46.09, longitude: -64.78, zh: { admin1: '新不伦瑞克省' } });
    await insert(database, 'whole-address', { street: 'Main Street, Moncton, NB E1C 1A1', houseNumber: '9', locality: 'Moncton', admin1: 'NB', admin1Code: 'NB' },
      { latitude: 46.09, longitude: -64.78, zh: { admin1: '新不伦瑞克省' } });
    await database.prepare("UPDATE address_pool SET district='Moncton' WHERE id='twin-district'").run();
    await repairAdministrativeNames({ database, countryCode: 'CA', regionLookup: noRegions, pauseMs: 0, now: () => new Date(at) });
    const rows = new Map((await database.prepare('SELECT * FROM address_pool').all()).results.map((row) => [row.id, row]));
    expect(rows.get('twin-district')).toMatchObject({ district: '', active: 1 });
    expect(JSON.parse(rows.get('twin-district').component_variants_json).native.district).toBeUndefined();
    expect(rows.get('whole-address')).toMatchObject({ active: 0, retired_at: `publication-validation:${administrativeNamesRevision('CA')}:${at}` });
  });

  it('fills a missing region with the catalog region nearest the point', async () => {
    await insert(database, 'no-region', { street: 'Main Street', houseNumber: '12', locality: 'Bathurst', admin1: '' }, { latitude: 47.6, longitude: -65.65 });
    expect(await repairAdministrativeNames({ database, countryCode: 'CA', regionLookup: noRegions, pauseMs: 0, now: () => new Date(at) }))
      .toMatchObject({ changed: 1, retired: 0 });
    const row = await database.prepare("SELECT * FROM address_pool WHERE id='no-region'").first();
    expect(row).toMatchObject({ admin1: 'NB', admin1_code: 'NB', active: 1 });
    expect(JSON.parse(row.component_variants_json)['zh-CN'].admin1).toBe('新不伦瑞克省');
  });

  it('moves regions by polygon and clears Cape Town postcodes matched to a suburb elsewhere', async () => {
    await database.exec(`INSERT INTO catalog_regions(id,country_code,code,name,native_name,zh_name,parent_id,path,latitude,longitude)
      VALUES (10,'ES','EX','Extremadura','Extremadura','埃斯特雷马杜拉',NULL,'/10/',39.2,-6.1),
        (11,'ES','CL','Castile and Leon','Castilla y León','卡斯蒂利亚-莱昂',NULL,'/11/',41.8,-4.6),
        (12,'ES','CC','Caceres','Cáceres','卡塞雷斯省',10,'/10/12/',39.7,-6.1),
        (13,'ES','SA','Salamanca','Salamanca','萨拉曼卡省',11,'/11/13/',40.8,-6),
        (20,'ZA','WC','Western Cape','Western Cape','西开普省',NULL,'/20/',-33.2,19.9);
      INSERT INTO catalog_cities(id,country_code,region_id,name,native_name,zh_name,latitude,longitude)
      VALUES (10,'ES',12,'Jaraiz de la Vera','Jaraíz de la Vera','',40.06,-5.75),(20,'ZA',20,'Cape Town','Cape Town','开普敦',-33.92,18.42);
      INSERT INTO catalog_postcodes(id,country_code,region_id,code) VALUES (10,'ES',12,'10400')`);
    await insert(database, 'jaraiz', { street: 'Calle Cáceres', houseNumber: '16', locality: 'Jaraíz de la Vera', admin1: 'Salamanca', admin1Code: 'SA', postcode: '10400' },
      { countryCode: 'ES', latitude: 40.0609, longitude: -5.752 });
    await insert(database, 'sandown', { street: 'Ruschia Street', houseNumber: '1', locality: 'SANDTON', postalLocality: 'SANDTON', admin1: 'Western Cape', postcode: '2196' },
      { countryCode: 'ZA', latitude: -33.79, longitude: 18.5, generation: 'cape-town-za-residential-2026-10-05' });
    const regionLookup = vi.fn(async ({ points }) => new Map(points.map((point) => [point.id, { code: 'ES-EX', name: 'Extremadura' }])));
    expect(await repairAdministrativeNames({ database, countryCode: 'ES', regionLookup, pauseMs: 0, now: () => new Date(at) }))
      .toMatchObject({ changed: 1, codes: 1 });
    expect(await repairAdministrativeNames({ database, countryCode: 'ZA', regionLookup, pauseMs: 0, now: () => new Date(at) }))
      .toMatchObject({ changed: 1, postcodes: 1, localities: 1 });
    expect(regionLookup).toHaveBeenCalledTimes(2);
    const rows = new Map((await database.prepare('SELECT * FROM address_pool').all()).results.map((row) => [row.id, row]));
    expect(rows.get('jaraiz')).toMatchObject({ admin1: 'Cáceres', admin1_code: 'CC', postcode: '10400', active: 1 });
    expect(JSON.parse(rows.get('jaraiz').component_variants_json)['zh-CN'].admin1).toBe('卡塞雷斯省');
    expect(rows.get('sandown')).toMatchObject({ postcode: '', postcode_key: '', locality: 'Cape Town', active: 1 });
  });

  it('retires published addresses whose names carry emoji or object-replacement marks', async () => {
    await insert(database, 'emoji', { street: 'Avenue Dorval', houseNumber: '12', buildingName: 'Garage \u{1F697}', locality: 'Dorval', admin1: 'QC', admin1Code: 'QC' });
    await database.prepare("UPDATE address_pool SET building_name=? WHERE id='emoji'").bind('Garage \u{1F697}').run();
    await insert(database, 'marker', { street: '\uFFFC Rue Principale', houseNumber: '3', locality: 'Dorval', admin1: 'QC', admin1Code: 'QC' });
    expect(await repairAdministrativeNames({ database, countryCode: 'CA', regionLookup: noRegions, pauseMs: 0, now: () => new Date(at) }))
      .toMatchObject({ retired: 2 });
    expect((await database.prepare('SELECT active FROM address_pool').all()).results.map((row) => row.active)).toEqual([0, 0]);
  });

  it('retires published points outside every region polygon', async () => {
    await insert(database, 'san-marino', { street: 'Contrada Omagnano', houseNumber: '5', locality: 'Dorval', admin1: 'QC', admin1Code: 'QC' });
    await insert(database, 'inside', { street: 'Avenue Dorval', houseNumber: '10', locality: 'Dorval', admin1: 'QC', admin1Code: 'QC' });
    const regionLookup = vi.fn(async ({ points }) => new Map(points.map((point) => [point.id,
      point.id === 'san-marino' ? { outside: true } : { code: 'CA-QC', name: 'Québec' }])));
    expect(await repairAdministrativeNames({ database, countryCode: 'CA', regionLookup, pauseMs: 0, now: () => new Date(at) }))
      .toMatchObject({ retired: 1 });
    const rows = new Map((await database.prepare('SELECT id,active FROM address_pool').all()).results.map((row) => [row.id, row.active]));
    expect(Object.fromEntries(rows)).toEqual({ 'san-marino': 0, inside: 1 });
  });

  it('gives retired points outside the country the repair retirement so translation recovery cannot republish them', async () => {
    await insert(database, 'crimea', { street: 'Avenue Dorval', houseNumber: '14', locality: 'Dorval', admin1: 'QC', admin1Code: 'QC' });
    await database.prepare("UPDATE address_pool SET active=0,retired_at='publication-validation:translation:2026-10-11T00:00:00.000Z' WHERE id='crimea'").run();
    const regionLookup = vi.fn(async ({ points }) => new Map(points.map((point) => [point.id, { outside: true }])));
    expect(await repairAdministrativeNames({ database, countryCode: 'CA', regionLookup, pauseMs: 0, now: () => new Date(at) }))
      .toMatchObject({ retired: 1 });
    expect(await database.prepare("SELECT active,retired_at FROM address_pool WHERE id='crimea'").first())
      .toEqual({ active: 0, retired_at: `publication-validation:${administrativeNamesRevision('ES')}:${at}` });
  });
});
