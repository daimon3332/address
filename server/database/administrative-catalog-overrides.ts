import { hongKongDistricts, hongKongRegions } from '../../src/domain/hk-administrative-divisions.mjs';
import { catalogCityRegions, catalogHierarchyPaths, correctRegionParents } from './catalog-hierarchy.mjs';
import type { PostgresDatabase } from './postgres.mjs';
import { implausibleChineseTranslation } from '../../src/domain/address-localization.mjs';
import { chinaCityNames, chinaCityRegionCode } from './china-catalog-corrections.mjs';
import { catalogChineseCorrections, catalogNativeCorrections } from './catalog-native-names.mjs';

// Upstream first-level Chinese names that are mistranslations (Batman → 蝙蝠侠, Chihuahua → 吉娃娃, Edo → 江户), outdated
// (Seoul → 汉城) or a capital city's name for its region (Belgorod Oblast → 别尔哥罗德).
const chineseRegionCorrections = Object.entries({
  TR: { 16: '布尔萨', 72: '巴特曼省', 65: '凡省', 18: '昌克勒省' },
  BR: { AC: '阿克里州', AM: '亚马孙州' },
  MX: { CHH: '奇瓦瓦州', MIC: '米却肯州', VER: '韦拉克鲁斯州', COA: '科阿韦拉州' },
  NG: { ED: '埃多州', KO: '科吉州', PL: '高原州', RI: '河流州', DE: '三角洲州', NI: '尼日尔州' },
  PH: { 12: '索科斯克萨尔根', '03': '中吕宋', 10: '北棉兰老' },
  SA: { '06': '哈伊勒省', 11: '巴哈省', '08': '北部边疆省' },
  TH: { 55: '难府', 63: '达府', 83: '普吉府' },
  // Japanese prefectures keep their 都/道/府/県 suffix in Chinese (大阪府, 东京都); upstream drops it for most.
  JP: {
    '01': '北海道', '02': '青森县', '03': '岩手县', '04': '宫城县', '05': '秋田县', '06': '山形县', '07': '福岛县', '08': '茨城县',
    '09': '栃木县', '10': '群马县', '11': '埼玉县', '12': '千叶县', '13': '东京都', '14': '神奈川县', '15': '新潟县', '16': '富山县',
    '17': '石川县', '18': '福井县', '19': '山梨县', '20': '长野县', '21': '岐阜县', '22': '静冈县', '23': '爱知县', '24': '三重县',
    '25': '滋贺县', '26': '京都府', '27': '大阪府', '28': '兵库县', '29': '奈良县', '30': '和歌山县', '31': '鸟取县', '32': '岛根县',
    '33': '冈山县', '34': '广岛县', '35': '山口县', '36': '德岛县', '37': '香川县', '38': '爱媛县', '39': '高知县', '40': '福冈县',
    '41': '佐贺县', '42': '长崎县', '43': '熊本县', '44': '大分县', '45': '宫崎县', '46': '鹿儿岛县', '47': '冲绳县' },
  KR: { 11: '首尔', 49: '济州特别自治道', 50: '世宗特别自治市', 45: '全北特别自治道', 42: '江原特别自治道' },
  VN: { 33: '多乐省', DN: '岘港市', 71: '奠边省', 26: '顺化市' },
  ZA: { NW: '西北省' },
  RU: { AMU: '阿穆尔州', ARK: '阿尔汉格尔斯克州', AST: '阿斯特拉罕州', BEL: '别尔哥罗德州', BRY: '布良斯克州', CE: '车臣共和国',
    CHE: '车里雅宾斯克州', CHU: '楚科奇自治区', CU: '楚瓦什共和国', DA: '达吉斯坦共和国', IRK: '伊尔库茨克州', IVA: '伊万诺沃州',
    YEV: '犹太自治州', KB: '卡巴尔达-巴尔卡尔共和国', KGD: '加里宁格勒州', KLU: '卡卢加州', KAM: '堪察加边疆区',
    KC: '卡拉恰伊-切尔克斯共和国', KR: '卡累利阿共和国', KEM: '克麦罗沃州', KHA: '哈巴罗夫斯克边疆区', KK: '哈卡斯共和国',
    KHM: '汉特-曼西自治区', KIR: '基洛夫州', KO: '科米共和国', KOS: '科斯特罗马州', KDA: '克拉斯诺达尔边疆区',
    KYA: '克拉斯诺亚尔斯克边疆区', KGN: '库尔干州', KRS: '库尔斯克州', LEN: '列宁格勒州', LIP: '利佩茨克州', MAG: '马加丹州',
    ME: '马里埃尔共和国', MO: '莫尔多瓦共和国', MOS: '莫斯科州', MUR: '摩尔曼斯克州', NEN: '涅涅茨自治区', NIZ: '下诺夫哥罗德州',
    NGR: '诺夫哥罗德州', NVS: '新西伯利亚州', OMS: '鄂木斯克州', ORE: '奥伦堡州', ORL: '奥廖尔州', PNZ: '奔萨州', PER: '彼尔姆边疆区',
    PSK: '普斯科夫州', ROS: '罗斯托夫州', RYA: '梁赞州', SA: '萨哈共和国', SAK: '萨哈林州', SAM: '萨马拉州', SAR: '萨拉托夫州',
    SMO: '斯摩棱斯克州', STA: '斯塔夫罗波尔边疆区', SVE: '斯维尔德洛夫斯克州', TAM: '坦波夫州', TA: '鞑靼斯坦共和国', TOM: '托木斯克州',
    TUL: '图拉州', TY: '图瓦共和国', TVE: '特维尔州', TYU: '秋明州', UD: '乌德穆尔特共和国', ULY: '乌里扬诺夫斯克州',
    VLA: '弗拉基米尔州', VLG: '沃洛格达州', VOR: '沃罗涅日州', YAN: '亚马尔-涅涅茨自治区', YAR: '雅罗斯拉夫尔州', ZAB: '外贝加尔边疆区' }
}).flatMap(([countryCode, names]) => Object.entries(names).map(([code, zh]) => ({ countryCode, code, zh })));
// Upstream gives Altai Krai the Altai Republic's names in every language, so neither can be selected by name.
const regionNameCorrections = [
  { countryCode: 'RU', code: 'AL', name: 'Altai Republic', native: 'Республика Алтай', zh: '阿尔泰共和国' },
  { countryCode: 'RU', code: 'ALT', name: 'Altai Krai', native: 'Алтайский край', zh: '阿尔泰边疆区' }
];
// Upstream catalog Chinese names that are literal translations (Emerald → 翠) fall back to the source name, as for
// entries without a translation, so address translation supplies the Chinese name instead.
const repairChinaCatalog = async (transaction: Pick<PostgresDatabase, 'prepare'>) => {
  const regions = new Map(((await transaction.prepare(`SELECT id,code FROM catalog_regions
    WHERE country_code='CN' AND parent_id IS NULL`).all<{ id: number; code: string }>()).results || [])
    .map((region) => [region.code, Number(region.id)]));
  const codes = new Map([...regions].map(([code, id]) => [id, code]));
  const cities = (await transaction.prepare(`SELECT id,region_id,name,native_name,zh_name,latitude,longitude FROM catalog_cities
    WHERE country_code='CN'`).all<{ id: number; region_id: number | null; name: string; native_name: string; zh_name: string;
      latitude: number | null; longitude: number | null }>()).results || [];
  for (const city of cities) {
    const names = chinaCityNames({ name: city.name, native: city.native_name, zh: city.zh_name, latitude: city.latitude, longitude: city.longitude });
    const regionCode = city.region_id == null ? undefined : codes.get(Number(city.region_id));
    const regionId = regionCode ? regions.get(chinaCityRegionCode(regionCode, city.latitude)) ?? city.region_id : city.region_id;
    if (names.native === city.native_name && names.zh === city.zh_name && regionId === city.region_id) continue;
    await transaction.prepare('UPDATE catalog_cities SET native_name=?,zh_name=?,region_id=? WHERE id=?')
      .bind(names.native, names.zh, regionId, city.id).run();
  }
};

const repairCatalogChineseNames = async (transaction: Pick<PostgresDatabase, 'prepare'>) => {
  await repairChinaCatalog(transaction);
  // Reviewed city names that translate the name's words (Bath → 洗澡, Nice → 好的) take their transliteration.
  for (const [countryCode, cities] of Object.entries(catalogChineseCorrections.cities)) {
    const rows = (await transaction.prepare('SELECT id,name,zh_name FROM catalog_cities WHERE country_code=?')
      .bind(countryCode).all<{ id: number; name: string; zh_name: string }>()).results || [];
    for (const row of rows) {
      const [zh, ...replaced] = cities[row.name] || [];
      if (zh && replaced.includes(row.zh_name)) await transaction.prepare('UPDATE catalog_cities SET zh_name=? WHERE id=?').bind(zh, row.id).run();
    }
  }
  for (const { countryCode, code, zh } of chineseRegionCorrections) {
    await transaction.prepare("UPDATE catalog_regions SET zh_name=? WHERE country_code=? AND code=? AND parent_id IS NULL AND zh_name<>?")
      .bind(zh, countryCode, code, zh).run();
  }
  for (const { countryCode, code, name, native, zh } of regionNameCorrections) {
    await transaction.prepare(`UPDATE catalog_regions SET name=?,native_name=?,zh_name=? WHERE country_code=? AND code=? AND parent_id IS NULL
      AND (name<>? OR native_name<>? OR zh_name<>?)`).bind(name, native, zh, countryCode, code, name, native, zh).run();
  }
  for (const table of ['catalog_regions', 'catalog_cities']) {
    const rows = (await transaction.prepare(`SELECT id,name,native_name,zh_name FROM ${table}
      WHERE country_code<>'CN' AND zh_name<>''`).all<{ id: number; name: string; native_name: string; zh_name: string }>()).results || [];
    const implausible = rows.filter((row) => !/\p{Script=Han}/u.test(row.native_name || '')
      && implausibleChineseTranslation(row.native_name || row.name, row.zh_name));
    for (const row of implausible) {
      await transaction.prepare(`UPDATE ${table} SET zh_name=? WHERE id=?`).bind(row.native_name || row.name, row.id).run();
    }
  }
};

const catalogNativeRepairsSchema = `CREATE TABLE IF NOT EXISTS catalog_native_repairs (
  table_name TEXT NOT NULL, catalog_id BIGINT NOT NULL, country_code TEXT NOT NULL, region_id BIGINT,
  old_native TEXT NOT NULL, new_native TEXT NOT NULL, english_name TEXT NOT NULL, created_at TEXT NOT NULL, applied_at TEXT,
  CONSTRAINT catalog_native_repairs_identity PRIMARY KEY (table_name, catalog_id, old_native)
)`;

// Upstream native names are often machine translations (Alaska -> "Down"); the reviewed correction table replaces
// them. A Chinese name that fell back to the bad native follows it.
export const repairCatalogNativeNames = async (transaction: Pick<PostgresDatabase, 'prepare'>): Promise<number> => {
  let changed = 0;
  // Existing databases gain the table here; schema.sql creates it for new ones.
  const repairsTable = await transaction.prepare(`SELECT COUNT(*) AS total FROM information_schema.tables
    WHERE table_name='catalog_native_repairs'`).first<{ total: number }>();
  if (!Number(repairsTable?.total || 0)) await transaction.prepare(catalogNativeRepairsSchema).run();
  for (const [table, kind] of [['catalog_regions', 'regions'], ['catalog_cities', 'cities']] as const) {
    const entries = Object.entries(catalogNativeCorrections[kind] as Record<string, string>);
    for (let offset = 0; offset < entries.length; offset += 500) {
      const chunk = new Map(entries.slice(offset, offset + 500));
      const ids = [...chunk.keys()].map(Number);
      const regionColumn = table === 'catalog_cities' ? 'region_id' : 'parent_id';
      const rows = (await transaction.prepare(`SELECT id,country_code,name,native_name,zh_name,${regionColumn} AS region_id
        FROM ${table} WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids)
        .all<{ id: number; country_code: string; name: string; native_name: string; zh_name: string; region_id: number | null }>()).results || [];
      for (const row of rows) {
        const native = chunk.get(String(row.id));
        if (!native || native === row.native_name) continue;
        const chinese = row.zh_name === row.native_name && !/\p{Script=Han}/u.test(row.native_name || '') ? native : row.zh_name;
        await transaction.prepare(`UPDATE ${table} SET native_name=?,zh_name=? WHERE id=?`).bind(native, chinese, row.id).run();
        // Stored addresses filled with the old name are rewritten by the sync service.
        await transaction.prepare(`INSERT INTO catalog_native_repairs(table_name,catalog_id,country_code,region_id,old_native,
            new_native,english_name,created_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`)
          .bind(table, row.id, row.country_code, table === 'catalog_cities' ? row.region_id : row.id, row.native_name || '',
            native, row.name, new Date().toISOString()).run();
        changed += 1;
      }
    }
  }
  return changed;
};

const canonicalHongKongCatalog = async (database: PostgresDatabase): Promise<boolean> => {
  const [regions, districts, postcodes] = await Promise.all([
    database.prepare(`SELECT id,code,name,native_name,zh_name,type,parent_id,path FROM catalog_regions
      WHERE country_code='HK' ORDER BY id`).all<Record<string, unknown>>(),
    database.prepare(`SELECT id,region_id,name,native_name,zh_name,type FROM catalog_cities
      WHERE country_code='HK' ORDER BY id`).all<Record<string, unknown>>(),
    database.prepare("SELECT COUNT(*) AS total FROM catalog_postcodes WHERE country_code='HK'").first<{ total: number }>()
  ]);
  const expectedRegions = hongKongRegions.map((region) => ({
    id: region.id, code: region.code, name: region.name, native_name: region.native, zh_name: region.zh,
    type: 'region', parent_id: null, path: `/${region.id}/`
  }));
  const regionIds = new Map(hongKongRegions.map((region) => [region.code, region.id]));
  const expectedDistricts = hongKongDistricts.map((district) => ({
    id: district.id, region_id: regionIds.get(district.regionCode), name: district.name,
    native_name: district.native, zh_name: district.zh, type: 'district'
  }));
  return JSON.stringify(regions.results || []) === JSON.stringify(expectedRegions)
    && JSON.stringify(districts.results || []) === JSON.stringify(expectedDistricts)
    && Number(postcodes?.total || 0) === 0;
};

// Japanese addresses name a prefecture in full (東京都, 大阪府, 愛知県); upstream lists most without the suffix.
const japanesePrefecture = (native: string): string => ['大阪', '京都'].includes(native) ? `${native}府`
  : native === '東京' ? '東京都' : /[都道府県]$/u.test(native) ? native : `${native}県`;
const officialJapanesePrefectures = async (transaction: Pick<PostgresDatabase, 'prepare'>) => {
  const rows = (await transaction.prepare(`SELECT id,native_name FROM catalog_regions WHERE country_code='JP' AND parent_id IS NULL`)
    .all<{ id: number; native_name: string }>()).results || [];
  for (const row of rows) {
    const official = japanesePrefecture(row.native_name || '');
    if (row.native_name && official !== row.native_name) {
      await transaction.prepare('UPDATE catalog_regions SET native_name=? WHERE id=?').bind(official, row.id).run();
    }
  }
};

export const applyAdministrativeCatalogOverrides = async (database: PostgresDatabase): Promise<boolean> => {
  const catalogIsCanonical = await canonicalHongKongCatalog(database);
  const regionIds = new Map(hongKongRegions.map((region) => [region.code, region.id]));
  let changed = false;
  await database.transaction(async (transaction) => {
    for (const countryCode of ['ES', 'FR', 'IT', 'GB']) {
      const regions = (await transaction.prepare(`SELECT id,country_code,code,type,parent_id,path
        FROM catalog_regions WHERE country_code=?`).bind(countryCode).all<{
          id: number; country_code: string; code: string; type: string; parent_id: number | null; path: string;
        }>()).results;
      const corrected = correctRegionParents(regions);
      if (corrected.every((region, index) => region === regions[index]) && countryCode !== 'ES') continue;
      const paths = catalogHierarchyPaths(corrected);
      const repairs = corrected.filter((region, index) => region.parent_id !== regions[index].parent_id
        || paths.get(region.id) !== regions[index].path);
      if (repairs.length) {
        await transaction.batch(repairs.map((region) => transaction.prepare(`UPDATE catalog_regions
          SET parent_id=?,path=? WHERE country_code=? AND id=?`).bind(region.parent_id, paths.get(region.id), countryCode, region.id)));
        changed = true;
      }
    }
    for (const [countryCode, cities] of Object.entries(catalogCityRegions)) {
      const regionIds = new Map(((await transaction.prepare('SELECT id,code FROM catalog_regions WHERE country_code=?')
        .bind(countryCode).all<{ id: number; code: string }>()).results || []).map((region) => [region.code, Number(region.id)]));
      const current = new Map(((await transaction.prepare('SELECT id,region_id FROM catalog_cities WHERE country_code=?')
        .bind(countryCode).all<{ id: number; region_id: number | null }>()).results || []).map((city) => [Number(city.id), city.region_id]));
      const moves = [...cities].filter(([id, code]) => current.has(id) && regionIds.has(code) && current.get(id) !== regionIds.get(code));
      if (!moves.length) continue;
      await transaction.batch(moves.map(([id, code]) => transaction.prepare('UPDATE catalog_cities SET region_id=? WHERE country_code=? AND id=?')
        .bind(regionIds.get(code), countryCode, id)));
      changed = true;
    }
    const cleanup = await transaction.prepare(`UPDATE address_pool SET
        locality=REPLACE(locality,' &',''), postal_locality=REPLACE(postal_locality,' &',''),
        component_variants_json=REPLACE(component_variants_json,'中西區 &','中西區'),
        address_variants_json=REPLACE(address_variants_json,'中西區 &','中西區')
      WHERE country_code='HK' AND (
        locality LIKE '%&' OR postal_locality LIKE '%&'
        OR component_variants_json LIKE '%中西區 &%' OR address_variants_json LIKE '%中西區 &%'
      )`).run();
    changed ||= Number(cleanup.meta?.changes || 0) > 0;
    await repairCatalogNativeNames(transaction);
    await repairCatalogChineseNames(transaction);
    await officialJapanesePrefectures(transaction);
    if (catalogIsCanonical) return;
    changed = true;
    await transaction.prepare("DELETE FROM residential_coverage WHERE country_code='HK'").run();
    await transaction.prepare("DELETE FROM catalog_postcodes WHERE country_code='HK'").run();
    await transaction.prepare("DELETE FROM catalog_cities WHERE country_code='HK'").run();
    await transaction.prepare("DELETE FROM catalog_regions WHERE country_code='HK'").run();
    await transaction.batch(hongKongRegions.map((region) => transaction.prepare(`INSERT INTO catalog_regions(
        id,country_code,code,name,native_name,zh_name,type,parent_id,path,latitude,longitude
      ) VALUES (?,'HK',?,?,?,?, 'region',NULL,?,NULL,NULL)`).bind(
        region.id, region.code, region.name, region.native, region.zh, `/${region.id}/`
      )));
    await transaction.batch(hongKongDistricts.map((district) => transaction.prepare(`INSERT INTO catalog_cities(
        id,country_code,region_id,name,native_name,zh_name,type,population,latitude,longitude
      ) VALUES (?,'HK',?,?,?,?, 'district',NULL,NULL,NULL)`).bind(
        district.id, regionIds.get(district.regionCode), district.name, district.native, district.zh
      )));
  });
  return changed;
};
