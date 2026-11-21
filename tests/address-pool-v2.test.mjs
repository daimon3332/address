import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { openTestDatabase } from './helpers/postgres-test-database.mjs';
import {
  enrichPickedAddress,
  loadAddressPoolV2AddressById,
  pickAddressPoolV2Address,
  pickNearestAddressPoolV2Address,
  repairHongKongNativeVariants,
  storedAddressPoolV2RowCanRecoverTranslations,
  storedAddressPoolV2RowIsFullyTranslated,
  storedAddressPoolV2RowIsPublishable
} from '../server/api/repositories/address-pool-v2';

describe('unified PostgreSQL address schema', () => {
  it('defines the runtime view, evidence model, coordinate index and synchronization state together', () => {
    const schema = readFileSync('server/database/schema.sql', 'utf8');
    expect(schema).toContain('DROP VIEW IF EXISTS address_pool_runtime');
    expect(schema).toContain('CREATE VIEW address_pool_runtime');
    expect(schema).toContain('WHERE address_pool.active = 1');
    expect(schema).toContain('CREATE INDEX IF NOT EXISTS idx_address_pool_coordinates');
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS address_pool_evidence');
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS sync_country_state');
    expect(schema).toContain('idx_address_pool_zh_han_id');
    expect(schema).toContain('idx_address_pool_zh_han_random');
    expect(schema).toContain('idx_generation_country_residential_rank');
    expect(schema).not.toContain('address_pool_meta');
  });
});

describe('ADDRESS_DB v2 repository', () => {
  it('does not erase a source-only Latin street while repairing a Han-script variant', () => {
    const native = { houseNumber: '12', street: 'Example Road', locality: '東區', admin1: '香港島', buildingName: '示例大廈', postcode: '' };
    const variants = { native, en: native, 'zh-CN': native };
    expect(repairHongKongNativeVariants('HK', variants).native.street).toBe('Example Road');
    expect(variants.native).toBe(native);
  });

  it.each(['HK', 'TW'])('repairs individual %s native fields from an existing Han counterpart', (country) => {
    const native = { houseNumber: '12', street: 'Example Road', locality: '東區', admin1: '香港島', postcode: '' };
    const variants = { native, en: native, 'zh-CN': { ...native, street: '示例路' } };
    expect(repairHongKongNativeVariants(country, variants).native.street).toBe('示例路');
    expect(variants.native.street).toBe('Example Road');
  });

  it('repairs legacy Hong Kong native variants from simplified Chinese instead of exposing English', () => {
    const variants = {
      native: { houseNumber: '33', street: 'OI SHUN ROAD', locality: 'EASTERN DISTRICT', postcode: '' },
      en: { houseNumber: '33', street: 'OI SHUN ROAD', locality: 'EASTERN DISTRICT', postcode: '' },
      'zh-CN': { houseNumber: '33', street: '爱信道', locality: '东区', postcode: '' }
    };
    const repaired = repairHongKongNativeVariants('HK', variants);
    expect(repaired.native).toMatchObject({ street: '愛信道', locality: '東區' });
    expect(repaired.en).toBe(variants.en);
  });

  it('strips trailing English from bilingual Hong Kong native components', () => {
    const variants = {
      native: { houseNumber: '23', street: '康樂園第十九街 Hong Lok Yuen 19th Street', locality: '大埔區 Tai Po', admin1: '新界 New Territories', postcode: '' },
      en: { houseNumber: '23', street: 'Hong Lok Yuen 19th Street', locality: 'Tai Po', admin1: 'New Territories', postcode: '' },
      'zh-CN': { houseNumber: '23', street: '康乐园第十九街', locality: '大埔区', admin1: '新界', postcode: '' }
    };
    expect(repairHongKongNativeVariants('HK', variants).native).toMatchObject({
      street: '康樂園第十九街', locality: '大埔區', admin1: '新界'
    });
  });

  it('converts Taiwan native components to Taiwan traditional Chinese', () => {
    const variants = {
      native: { houseNumber: '10号', street: '忠孝东路', locality: '中正区', admin1: '台北市', postcode: '100001' },
      en: { houseNumber: '10', street: 'Zhongxiao East Road', locality: 'Zhongzheng', admin1: 'Taipei', postcode: '100001' },
      'zh-CN': { houseNumber: '10号', street: '忠孝东路', locality: '中正区', admin1: '台北市', postcode: '100001' }
    };
    expect(repairHongKongNativeVariants('TW', variants).native).toMatchObject({
      street: '忠孝東路', locality: '中正區', admin1: '臺北市'
    });
  });

  it('rebuilds Hong Kong and Taiwan native address variants without Latin country codes', async () => {
    const source = {
      id: 'fixture-han', country_code: 'TW', admin1: '臺北市', admin1_code: '', locality: '中正區', postal_locality: '中正區', district: '', postcode: '100003',
      street: '忠孝東路一段', house_number: '10號', building_name: '', latitude: 25.04, longitude: 121.52, native_language: 'zh-TW', property_type: 'residential', generation: 'fixture', quality_score: 0.95,
      first_seen_at: '2026-01-01T00:00:00Z', expires_at: '2027-01-01T00:00:00Z',
      component_variants_json: JSON.stringify({
        native: { houseNumber: '10號', street: '忠孝東路一段', locality: '中正區', postalLocality: '中正區', admin1: '臺北市', postcode: '100003' },
        en: { houseNumber: '10', street: 'Zhongxiao East Road Section 1', locality: 'Zhongzheng District', postalLocality: 'Zhongzheng District', admin1: 'Taipei City', postcode: '100003' },
        'zh-CN': { houseNumber: '10号', street: '忠孝东路一段', locality: '中正区', postalLocality: '中正区', admin1: '台北市', postcode: '100003' }
      }),
      address_variants_json: JSON.stringify({ native: '10號 忠孝東路一段, 中正區, 臺北市, TW' }), source_id: 'fixture', source_name: 'Fixture', source_url: 'https://example.test', source_record_id: 'tw', record_url: '', observed_at: '2026-01-01T00:00:00Z', evidence_type: 'address_existence', residential_evidence: 1, dataset_id: 'fixture', dataset_version: '1', source_updated_at: '2026-01-01T00:00:00Z', imported_at: '2026-01-01T00:00:00Z'
    };
    const db = { prepare: () => ({ bind: () => ({ all: async () => ({ results: [{ id: source.id }, source] }) }) }) };
    const address = await pickAddressPoolV2Address(db, 'TW', false, {}, undefined, 'tw-native');
    expect(address?.addressVariants.native).toMatch(/臺北市/u);
    expect(address?.addressVariants.native).not.toMatch(/\bTW\b/u);
  });

  const row = {
    id: 'fixture-address', country_code: 'JP', admin1: '東京都', admin1_code: '13',
    locality: '杉並区', postal_locality: '杉並区', district: '永福', postcode: '168-0064',
    street: '永福四丁目', house_number: '4-27-7', building_name: '', latitude: 35.676, longitude: 139.642,
    native_language: 'ja', property_type: 'residential', generation: 'fixture-2026-07', quality_score: 0.95,
    first_seen_at: '2026-07-16T00:00:00Z', expires_at: '2027-07-15T00:00:00Z',
    component_variants_json: JSON.stringify({
      native: { houseNumber: '4-27-7', street: '永福四丁目', locality: '杉並区', postalLocality: '杉並区', district: '永福', admin1: '東京都', admin1Code: '13', postcode: '168-0064' },
      en: { houseNumber: '4-27-7', street: 'Eifuku', locality: 'Suginami', postalLocality: 'Suginami', district: 'Eifuku', admin1: 'Tokyo', admin1Code: '13', postcode: '168-0064' },
      'zh-CN': { houseNumber: '4-27-7', street: '永福', locality: '杉并区', postalLocality: '杉并区', district: '永福', admin1: '东京都', admin1Code: '13', postcode: '168-0064' }
    }),
    address_variants_json: JSON.stringify({ native: '東京都杉並区永福四丁目4-27-7', en: '4-27-7 Eifuku, Suginami, Tokyo 168-0064', 'zh-CN': '东京都杉并区永福四丁目4-27-7' }),
    source_id: 'fixture', source_name: 'Fixture Source', source_url: 'https://example.test/source',
    source_record_id: 'jp-1', record_url: 'https://example.test/source/jp-1', observed_at: '2026-07-15T00:00:00Z',
    evidence_type: 'address_existence', residential_evidence: 1,
    dataset_id: 'fixture-dataset', dataset_version: '2026-07-15',
    source_updated_at: '2026-07-15T00:00:00Z', imported_at: '2026-07-16T00:00:00Z'
  };

  it('serves house numbers and units in Latin script in English and refuses the ones it cannot convert', async () => {
    const serve = async (country, nativeHouse, unit = '') => {
      const variants = JSON.parse(row.component_variants_json);
      const native = { ...variants.native, houseNumber: nativeHouse, unit };
      const source = { ...row, country_code: country, house_number: nativeHouse, address_variants_json: JSON.stringify({ native: 'x', en: `${nativeHouse} Eifuku` }),
        component_variants_json: JSON.stringify({ native, en: { ...variants.en, houseNumber: nativeHouse, unit }, 'zh-CN': { ...variants['zh-CN'], houseNumber: nativeHouse, unit } }) };
      const db = { prepare: (sql) => ({ bind: () => ({ all: async () => ({ results: sql.includes('address_pool_runtime') ? [source] : [{ id: row.id }] }) }) }) };
      return pickAddressPoolV2Address(db, country, false, {}, undefined, 'latin-premise', new Date('2026-07-20T00:00:00Z'));
    };
    const japan = await serve('JP', '11番10号');
    expect(japan?.componentVariants.en.houseNumber).toBe('11-10');
    expect(japan?.componentVariants['zh-CN'].houseNumber).toBe('11番10号');
    expect(japan?.addressVariants.en).toContain('11-10');
    expect(japan?.addressVariants.en).not.toMatch(/\p{Script=Han}/u);
    expect((await serve('JP', '3122番地20'))?.componentVariants.en.houseNumber).toBe('3122-20');
    expect(await serve('JP', '甲5番地')).toBeUndefined();
  });

  it('keeps date-only expiry valid through the end of its UTC date', () => {
    expect(storedAddressPoolV2RowIsPublishable({ ...row, expires_at: '2026-09-19' }, new Date('2026-09-19T23:59:59Z'))).toBe(true);
    expect(storedAddressPoolV2RowCanRecoverTranslations({ ...row, expires_at: '2026-09-19' }, new Date('2026-09-19T12:00:00Z'))).toBe(true);
    expect(storedAddressPoolV2RowIsPublishable({ ...row, expires_at: '2026-09-19' }, new Date('2026-09-20T00:00:00Z'))).toBe(false);
  });

  it('publishes ordinary and residential addresses with an untranslated Chinese street but keeps them queued', () => {
    const variants = JSON.parse(row.component_variants_json);
    variants['zh-CN'].street = 'Eifuku';
    const fallback = { ...row, component_variants_json: JSON.stringify(variants) };
    const ordinary = { ...fallback, property_type: 'unknown', residential_evidence: 0 };
    expect(storedAddressPoolV2RowIsPublishable(ordinary)).toBe(true);
    expect(storedAddressPoolV2RowIsFullyTranslated(ordinary)).toBe(false);
    expect(storedAddressPoolV2RowIsPublishable(fallback)).toBe(true);
    expect(storedAddressPoolV2RowIsFullyTranslated(fallback)).toBe(false);
    expect(storedAddressPoolV2RowIsFullyTranslated(row)).toBe(true);
  });

  it.each(['houseNumber', 'postcode', 'admin1Code', 'street'])('rejects a translated %s that changes source identifiers', (field) => {
    const variants = JSON.parse(row.component_variants_json);
    variants.en[field] = field === 'street' ? 'Eifuku 999' : '999';
    const candidate = { ...row, component_variants_json: JSON.stringify(variants) };
    expect(storedAddressPoolV2RowIsPublishable(candidate)).toBe(false);
    expect(storedAddressPoolV2RowCanRecoverTranslations(candidate)).toBe(true);
  });

  it.each(['native', 'en', 'zh-CN'])('separates source eligibility from a non-residential %s translation', (language) => {
    const components = JSON.parse(row.component_variants_json);
    const addresses = JSON.parse(row.address_variants_json);
    components[language].buildingName = 'government office';
    addresses[language] += ', government office';
    const candidate = { ...row, component_variants_json: JSON.stringify(components), address_variants_json: JSON.stringify(addresses) };
    expect(storedAddressPoolV2RowCanRecoverTranslations(candidate)).toBe(language !== 'native');
    expect(storedAddressPoolV2RowIsPublishable(candidate)).toBe(false);
  });

  it('uses normalized keys and preserves localized variants and provenance', async () => {
    const statements = [];
    const bindingCounts = [];
    const database = {
      prepare(sql) {
        statements.push(sql);
        const statement = {
          bind(...values) { bindingCounts.push(values.length); return statement; },
          async all() {
            if (sql.startsWith('SELECT id FROM address_pool')) {
              return { results: sql.includes('random_key >=') ? [{ id: row.id }] : [] };
            }
            return { results: sql.includes('FROM address_pool_runtime') ? [row] : [] };
          }
        };
        return statement;
      }
    };
    const target = {
      coordinates: { latitude: row.latitude, longitude: row.longitude },
      region: row.admin1, regionCode: row.admin1_code, regionAliases: [row.admin1, row.admin1_code],
      city: row.locality, cityAliases: [row.locality], postcode: row.postcode, bucket: 'postcode-168-0064'
    };
    const address = await pickAddressPoolV2Address(
      database, 'JP', false, { region: '13', city: '杉並区', postcode: '168-0064' }, target, 'seed', new Date('2026-07-20T00:00:00Z')
    );
    expect(address).toEqual(expect.objectContaining({
      id: 'pool-v2-fixture-address', nativeLanguage: 'ja', nativeAddress: '東京都杉並区永福四丁目4-27-7',
      formattedAddress: '4-27-7 Eifuku, Suginami, Tokyo 168-0064', sourceVersion: 'fixture-dataset:2026-07-15'
    }));
    expect(address?.componentVariants['zh-CN'].locality).toBe('杉并区');
    expect(address?.componentVariants.en.dependentLocality).toBe('Eifuku');
    expect(address?.componentVariants['zh-CN'].dependentLocality).toBe('永福');
    expect(address?.evidence[0]).toEqual(expect.objectContaining({ sourceId: 'fixture', sourceUrl: row.record_url }));
    expect(statements[0]).toContain('SELECT id FROM address_pool');
    expect(statements[0]).toContain('active = 1');
    expect(statements[0]).toContain('quality_score >= 0.7');
    expect(statements[0]).toContain('LIMIT 64');
    expect(statements[1]).toContain('FROM address_pool_runtime');
    expect(statements[1]).toContain('WHERE id IN (?)');
    expect(address?.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'residential_use' })]));
    expect(bindingCounts[0]).toBe((statements[0].match(/\?/g) || []).length);
    expect(bindingCounts[1]).toBe((statements[1].match(/\?/g) || []).length);
  });

  it('filters residential evidence through the indexed pool before materializing the runtime view', async () => {
    const statements = [];
    const database = {
      prepare(sql) {
        statements.push(sql);
        const statement = {
          bind() { return statement; },
          async all() {
            if (sql.startsWith('SELECT id FROM address_pool')) {
              return { results: sql.includes('random_key >=') ? [{ id: row.id }] : [] };
            }
            return { results: sql.includes('FROM address_pool_runtime') ? [row] : [] };
          }
        };
        return statement;
      }
    };

    await expect(pickAddressPoolV2Address(database, 'JP', true, {}, undefined, 'residential-seed'))
      .resolves.toMatchObject({ id: 'pool-v2-fixture-address' });
    expect(statements[0]).toContain('SELECT id FROM address_pool');
    expect(statements[0]).toContain("property_type IN ('residential','apartment')");
    expect(statements[0]).toContain("residential_evidence.evidence_type = 'residential_use'");
    expect(statements[0]).toContain('residential_evidence.address_id = address_pool.id');
    expect(statements[0]).toContain('LIMIT 16');
    expect(statements[1]).toContain('FROM address_pool_runtime');
    expect(statements[1]).toContain('WHERE id IN (?)');
  });

  it('applies district filters on the database generation path', async () => {
    const statements = [];
    const district = '阿佐谷';
    const native = JSON.parse(row.component_variants_json).native;
    const english = JSON.parse(row.component_variants_json).en;
    const chinese = JSON.parse(row.component_variants_json)['zh-CN'];
    const database = {
      exec() {},
      prepare(sql) {
        statements.push(sql);
        const statement = {
          bind() { return statement; },
          async all() {
            if (sql.includes('FROM address_generation_index') || sql.startsWith('SELECT id FROM address_pool')) {
              return { results: sql.includes('district_key') ? [{ id: 'district-match' }] : [] };
            }
            return { results: sql.includes('FROM address_pool_runtime')
              ? [{ ...row, id: 'district-match', district,
                component_variants_json: JSON.stringify({
                  native: { ...native, district }, en: { ...english, district: 'Asagaya' },
                  'zh-CN': { ...chinese, district }
                }) }]
              : [] };
          }
        };
        return statement;
      }
    };

    await expect(pickAddressPoolV2Address(database, 'JP', false, { district }, undefined, 'district-filter'))
      .resolves.toMatchObject({ id: 'pool-v2-district-match', components: { district } });
    expect(statements.some((sql) => sql.includes('district_key'))).toBe(true);
  });

  it('keeps SQL placeholders aligned with bindings for multi-alias city filters', async () => {
    const captured = [];
    const database = {
      exec() {},
      prepare(sql) {
        const statement = {
          bind(...values) {
            statement.values = values;
            captured.push({ sql, bindings: values.length });
            return statement;
          },
          async all() { return { results: [] }; },
          async first() { return null; }
        };
        return statement;
      }
    };
    const target = {
      region: '安大略省', regionNative: '安大略省', regionCode: 'ON',
      regionAliases: ['Ontario', '安大略省', 'ON'],
      city: '多伦多', cityNative: '多伦多', cityAliases: ['Toronto', '多伦多'],
      bucket: 'city-1'
    };
    await pickAddressPoolV2Address(database, 'CA', false, { city: 'Toronto', region: '安大略省' }, target, 'binding-alignment');
    expect(captured.length).toBeGreaterThan(0);
    for (const { sql, bindings } of captured) {
      expect(sql.match(/\?/gu)?.length || 0).toBe(bindings);
    }
  });

  it.each([
    ['google-residential-enrichment-th', 'openstreetmap'], ['mappls-in-residential', 'openstreetmap'],
    ['singapore-hdb-residential', 'hdb-property'], ['korea-kapt-residential', 'korea-kapt']
  ])('keeps independent residential evidence separate from API address evidence for %s', async (sourceId, expected) => {
    const value = { ...row, source_id: sourceId, record_url: 'https://example.test/geocoder' };
    const db = { prepare: () => ({ bind: () => ({ all: async () => ({ results: [{ id: value.id }, value] }) }) }) };
    const address = await pickAddressPoolV2Address(db, 'JP', false, {}, undefined, 'provenance');
    expect(address?.evidence.find(({ type }) => type === 'residential_use')?.sourceId).toBe(expected);
    expect(address?.evidence.find(({ type }) => type === 'address_existence')?.sourceUrl).toBe(value.record_url);
  });

  it('does not publish records whose stored English or Chinese variants still use the native script', async () => {
    const untranslated = {
      ...row,
      component_variants_json: JSON.stringify({
        native: { houseNumber: '4-27-7', street: '永福四丁目', locality: '杉並区', district: '永福', postcode: '168-0064' },
        en: { houseNumber: '4-27-7', street: '永福四丁目', locality: '杉並区', district: '永福', postcode: '168-0064' },
        'zh-CN': { houseNumber: '4-27-7', street: '永福', locality: '杉并区', district: '永福', postcode: '168-0064' }
      })
    };
    const database = {
      prepare(sql) {
        const statement = {
          bind() { return statement; },
          async all() { return { results: sql.startsWith('SELECT id FROM address_pool') ? [{ id: row.id }] : [untranslated] }; }
        };
        return statement;
      }
    };
    await expect(pickAddressPoolV2Address(database, 'JP', false, {}, undefined, 'translation-gate'))
      .resolves.toBeUndefined();
  });

  it('publishes a Chinese variant with an untranslated or unusable field in its English form', () => {
    const components = JSON.parse(row.component_variants_json);
    components['zh-CN'].street = 'Эйфуку';
    const candidate = { ...row, component_variants_json: JSON.stringify(components) };
    expect(storedAddressPoolV2RowIsPublishable(candidate)).toBe(true);
    expect(storedAddressPoolV2RowIsFullyTranslated(candidate)).toBe(false);
    components.en.street = 'Эйфуку';
    expect(storedAddressPoolV2RowIsPublishable({ ...row, component_variants_json: JSON.stringify(components) })).toBe(false);
  });

  it('publishes a Singapore row whose stored Chinese semantic fields are still Latin with their English text', async () => {
    const native = {
      houseNumber: '111B', street: 'PLANTATION CRES', locality: 'Tengah',
      postalLocality: 'Singapore', postcode: '699111'
    };
    const translated = {
      houseNumber: '111B', street: '种植园弯', locality: '登加',
      postalLocality: '新加坡', postcode: '699111'
    };
    const base = {
      ...row, country_code: 'SG', admin1: '', admin1_code: '', locality: 'Tengah',
      postal_locality: 'Singapore', district: '', postcode: '699111', street: 'PLANTATION CRES',
      house_number: '111B', latitude: 1.35, longitude: 103.72, native_language: 'en',
      address_variants_json: JSON.stringify({
        native: '111B PLANTATION CRES, Singapore 699111',
        en: '111B PLANTATION CRES, Singapore 699111',
        'zh-CN': '111B 种植园弯，新加坡 699111'
      })
    };
    const untranslated = {
      ...base, id: 'sg-untranslated',
      component_variants_json: JSON.stringify({ native, en: native, 'zh-CN': native })
    };
    const valid = {
      ...base, id: 'sg-translated',
      component_variants_json: JSON.stringify({ native, en: native, 'zh-CN': translated })
    };
    const database = {
      prepare(sql) {
        const statement = {
          bind() { return statement; },
          async all() {
            return { results: sql.startsWith('SELECT id FROM address_pool')
              ? [{ id: untranslated.id }]
              : [untranslated] };
          }
        };
        return statement;
      }
    };

    const picked = await pickAddressPoolV2Address(database, 'SG', false, {}, undefined, 'translation-gate');
    expect(picked).toMatchObject({ id: 'pool-v2-sg-untranslated' });
    expect(picked.componentVariants['zh-CN']).toMatchObject({ street: 'PLANTATION CRES', locality: 'Tengah' });
    expect(storedAddressPoolV2RowIsFullyTranslated(untranslated)).toBe(false);
    expect(storedAddressPoolV2RowIsFullyTranslated(valid)).toBe(true);
  });

  it('attributes Overture residential classification to the buildings theme', async () => {
    const overture = {
      ...row,
      source_id: 'overture-addresses',
      source_name: 'Overture Maps addresses',
      source_url: 'https://overturemaps.org/',
      record_url: 'https://stac.overturemaps.org/catalog.json'
    };
    const database = {
      prepare(sql) {
        const statement = {
          bind() { return statement; },
          async all() {
            return { results: sql.startsWith('SELECT id FROM address_pool') ? [{ id: overture.id }] : [overture] };
          }
        };
        return statement;
      }
    };

    const address = await pickAddressPoolV2Address(database, 'JP', true, {}, undefined, 'overture-source');
    expect(address?.evidence.find(({ type }) => type === 'address_existence')).toMatchObject({
      sourceId: 'overture-addresses'
    });
    expect(address?.evidence.find(({ type }) => type === 'residential_use')).toMatchObject({
      sourceId: 'overture-buildings', sourceFamily: 'overture-buildings',
      sourceUrl: 'https://docs.overturemaps.org/guides/buildings'
    });
  });

  it('only treats a missing v2 runtime view as a compatibility miss', async () => {
    const missing = { prepare() { throw new Error('relation "address_pool_runtime" does not exist'); } };
    const broken = { prepare() { throw new Error('connection terminated unexpectedly'); } };
    await expect(pickAddressPoolV2Address(missing, 'US', false, {}, undefined, 'seed')).resolves.toBeUndefined();
    await expect(pickAddressPoolV2Address(broken, 'US', false, {}, undefined, 'seed')).rejects.toThrow('connection terminated');
  });

  it('does not load an expired address by ID', async () => {
    const database = {
      prepare() {
        const statement = {
          bind() { return statement; },
          async first() { return { ...row, expires_at: '2000-01-01T00:00:00Z' }; }
        };
        return statement;
      }
    };
    await expect(loadAddressPoolV2AddressById(database, 'pool-v2-fixture-address', new Date('2026-07-20T00:00:00Z')))
      .resolves.toBeUndefined();
  });

  it('skips a v2 US row whose state field contains Philadelphia', async () => {
    const components = {
      houseNumber: '10', street: 'Market Street', locality: 'Philadelphia', postalLocality: 'Philadelphia',
      admin1: 'Pennsylvania', admin1Code: 'PA', postcode: '19103'
    };
    const chinese = {
      houseNumber: '10', street: '市场街', locality: '费城', postalLocality: '费城',
      admin1: '宾夕法尼亚州', admin1Code: 'PA', postcode: '19103'
    };
    const base = {
      ...row, country_code: 'US', locality: 'Philadelphia', postal_locality: 'Philadelphia', district: '',
      postcode: '19103', street: 'Market Street', house_number: '10', latitude: 39.95, longitude: -75.16,
      native_language: 'en', component_variants_json: JSON.stringify({ native: components, en: components, 'zh-CN': chinese }),
      address_variants_json: JSON.stringify({
        native: '10 Market Street, Philadelphia, PA 19103', en: '10 Market Street, Philadelphia, PA 19103',
        'zh-CN': '美国宾夕法尼亚州费城市场街10号'
      })
    };
    const invalid = { ...base, id: 'bad-state', admin1: 'Philadelphia', admin1_code: '' };
    const valid = { ...base, id: 'valid-state', admin1: 'Pennsylvania', admin1_code: 'PA' };
    const statements = [];
    const database = {
      prepare(sql) {
        statements.push(sql);
        const statement = {
          bind() { return statement; },
          async all() {
            if (sql.startsWith('SELECT id FROM address_pool')) {
              return { results: [{ id: invalid.id }, { id: valid.id }] };
            }
            return { results: [valid, invalid] };
          }
        };
        return statement;
      }
    };

    await expect(pickAddressPoolV2Address(database, 'US', false, {}, undefined, 'seed'))
      .resolves.toMatchObject({ id: 'pool-v2-valid-state', components: { admin1: 'Pennsylvania', admin1Code: 'PA' } });
    expect(statements[0]).toContain('SELECT id FROM address_pool');
    expect(statements[1]).toContain('WHERE id IN (?,?)');
  });

  it('skips premises without a ZIP and drops legacy numeric building names', async () => {
    const components = {
      houseNumber: '2704', street: 'College Avenue', locality: 'Berkeley', postalLocality: 'Berkeley',
      admin1: 'California', admin1Code: 'CA', postcode: '94704', buildingName: '3'
    };
    const chinese = {
      houseNumber: '2704', street: '学院大道', locality: '伯克利', postalLocality: '伯克利',
      admin1: '加利福尼亚州', admin1Code: 'CA', postcode: '94704', buildingName: '3'
    };
    const valid = {
      ...row, id: 'legacy-unit', country_code: 'US', admin1: 'California', admin1_code: 'CA',
      locality: 'Berkeley', postal_locality: 'Berkeley', district: '', postcode: '94704',
      street: 'College Avenue', house_number: '2704', building_name: '3', latitude: 37.86, longitude: -122.25,
      native_language: 'en',
      component_variants_json: JSON.stringify({ native: components, en: components, 'zh-CN': chinese }),
      address_variants_json: JSON.stringify({ native: '3, 2704 College Avenue, Berkeley, CA 94704', en: '3, 2704 College Avenue, Berkeley, CA 94704', 'zh-CN': '3, 2704 College Avenue' })
    };
    const missingZip = { ...valid, id: 'missing-zip', postcode: '', component_variants_json: JSON.stringify({
      native: { ...components, postcode: '' }, en: { ...components, postcode: '' }, 'zh-CN': { ...chinese, postcode: '' }
    }) };
    const database = {
      prepare(sql) {
        const statement = {
          bind() { return statement; },
          async all() {
            if (sql.startsWith('SELECT id FROM address_pool')) return { results: [{ id: missingZip.id }, { id: valid.id }] };
            return { results: [missingZip, valid] };
          }
        };
        return statement;
      }
    };
    const address = await pickAddressPoolV2Address(database, 'US', false, {}, undefined, 'unit-seed');
    expect(address).toMatchObject({ id: 'pool-v2-legacy-unit', components: { houseNumber: '2704', postcode: '94704' },
      unitStatus: 'not_present', unitProvenance: 'none' });
    expect(address?.components).not.toHaveProperty('unit');
    expect(address?.components).not.toHaveProperty('buildingName');
    expect(address?.nativeAddress).not.toMatch(/^3,/u);
  });

  it('preserves the selected candidate order after batch materialization', async () => {
    const first = { ...row, id: 'first' };
    const second = { ...row, id: 'second' };
    const database = {
      prepare(sql) {
        const statement = {
          bind() { return statement; },
          async all() {
            return { results: sql.startsWith('SELECT id FROM address_pool')
              ? [{ id: first.id }, { id: second.id }]
              : [first, second] };
          }
        };
        return statement;
      }
    };

    await expect(pickAddressPoolV2Address(database, 'JP', false, {}, undefined, 'ordered-seed'))
      .resolves.toMatchObject({ id: 'pool-v2-second' });
  });

  it('distributes deterministic seeds across the indexed candidate window', async () => {
    const candidates = Array.from({ length: 16 }, (_, index) => ({ ...row, id: `candidate-${index}` }));
    const database = {
      prepare(sql) {
        const statement = {
          bind() { return statement; },
          async all() {
            return { results: sql.startsWith('SELECT id FROM address_pool')
              ? candidates.map(({ id }) => ({ id }))
              : candidates };
          }
        };
        return statement;
      }
    };
    const selected = new Set();
    for (let index = 0; index < 64; index += 1) {
      selected.add((await pickAddressPoolV2Address(
        database, 'JP', true, {}, undefined, `distribution-${index}`
      ))?.id);
    }
    expect(selected.size).toBeGreaterThanOrEqual(12);
  });

  it('preserves a required admin1 when a capital has the same locality name', async () => {
    const native = {
      houseNumber: '57', street: 'ซอย 6', locality: 'กรุงเทพมหานคร', district: 'เขตทุ่งครุ',
      admin1: 'กรุงเทพมหานคร', postcode: '10290'
    };
    const address = {
      id: 'thai-capital', countryCode: 'TH', components: native,
      componentVariants: {
        native,
        en: { ...native, street: 'Soi 6', locality: 'Bangkok', district: 'Thung Khru', admin1: 'Bangkok' },
        'zh-CN': { ...native, street: '6号巷', locality: '曼谷', district: '童库区', admin1: '曼谷' }
      }
    };
    const database = {
      prepare(sql) {
        const statement = {
          bind() { return statement; },
          async first() { return sql.startsWith('SELECT 1 AS present') ? { present: 1 } : undefined; }
        };
        return statement;
      }
    };
    const enriched = await enrichPickedAddress(database, address);
    expect(enriched.componentVariants.native.admin1).toBe('กรุงเทพมหานคร');
    expect(enriched.componentVariants.en.admin1).toBe('Bangkok');
    expect(enriched.componentVariants['zh-CN'].admin1).toBe('曼谷');
  });

  it('does not choose a same-name city translation from another region by population', async () => {
    const database = openTestDatabase();
    try {
      await database.exec(`INSERT INTO catalog_regions(id,country_code,code,name,native_name,zh_name,path)
        VALUES (1,'CA','BC','British Columbia','British Columbia','不列颠哥伦比亚省','/1/'),
          (2,'CA','ON','Ontario','Ontario','安大略省','/2/');
        INSERT INTO catalog_cities(id,country_code,region_id,name,native_name,zh_name,population)
        VALUES (1,'CA',1,'Fixture Town','Fixture Town','甲镇',1),(2,'CA',2,'Fixture Town','Fixture Town','乙镇',1000)`);
      const components = { houseNumber: '1', street: 'Fixture Road', locality: 'Fixture Town', admin1: 'British Columbia', admin1Code: 'BC', postcode: '' };
      const result = await enrichPickedAddress(database, { countryCode: 'CA', components,
        componentVariants: { native: components, en: components, 'zh-CN': { ...components, street: '示例路' } } });
      expect(result.componentVariants['zh-CN'].locality).toBe('甲镇');
    } finally { await database.close(); }
  });

  it('normalizes a 112xx v2 postal locality to Brooklyn', async () => {
    const components = {
      houseNumber: '478', street: 'Dean Street', locality: 'New York', postalLocality: 'New York',
      admin1: 'New York', admin1Code: 'NY', postcode: '11217'
    };
    const chinese = {
      houseNumber: '478', street: '迪恩街', locality: '纽约', postalLocality: '纽约',
      admin1: '纽约州', admin1Code: 'NY', postcode: '11217'
    };
    const brooklyn = {
      ...row, id: 'brooklyn', country_code: 'US', admin1: 'New York', admin1_code: 'NY',
      locality: 'New York', postal_locality: 'New York', district: 'Kings County', postcode: '11217',
      street: 'Dean Street', house_number: '478', latitude: 40.681116, longitude: -73.975375,
      native_language: 'en', component_variants_json: JSON.stringify({ native: components, en: components, 'zh-CN': chinese }),
      address_variants_json: JSON.stringify({
        native: '478 Dean Street, New York, NY 11217', en: '478 Dean Street, New York, NY 11217',
        'zh-CN': '美国纽约州纽约市迪恩街478号'
      })
    };
    const database = {
      prepare() {
        const statement = { bind() { return statement; }, async all() { return { results: [brooklyn] }; } };
        return statement;
      }
    };

    await expect(pickAddressPoolV2Address(database, 'US', false, {}, undefined, 'seed'))
      .resolves.toMatchObject({ components: { postalLocality: 'Brooklyn', admin1: 'New York', admin1Code: 'NY' } });
  });

  it('selects a residential address within the requested IP radius', async () => {
    const database = {
      prepare(_sql) {
        const statement = {
          bind() { return statement; },
          async all() {
            return { results: [
              { ...row, id: 'near', latitude: 35.6761, longitude: 139.6421 },
              { ...row, id: 'far', latitude: 37.0, longitude: 141.0 }
            ] };
          }
        };
        return statement;
      }
    };
    const selected = await pickNearestAddressPoolV2Address(
      database, 'JP', true, { latitude: 35.676, longitude: 139.642 }, 'nearby', 25,
      new Date('2026-07-20T00:00:00Z')
    );

    expect(selected?.address.id).toBe('pool-v2-near');
    expect(selected?.distanceKm).toBeLessThan(1);
  });

  it('widens the IP search box while it holds too few candidates for variety', async () => {
    const boxes = [];
    const database = {
      prepare(sql) {
        const statement = {
          bind(...values) { if (sql.includes('distance_score')) boxes.push(values.slice(-4)); return statement; },
          async all() {
            const [south, north] = boxes.at(-1);
            return { results: north - south > 0.1 ? [{ ...row, id: 'suburb', latitude: 35.72, longitude: 139.642 }] : [] };
          }
        };
        return statement;
      }
    };
    const selected = await pickNearestAddressPoolV2Address(
      database, 'JP', true, { latitude: 35.676, longitude: 139.642 }, 'widening', 25, new Date('2026-07-20T00:00:00Z')
    );
    expect(selected?.address.id).toBe('pool-v2-suburb');
    expect(boxes.map(([south, north]) => Math.round((north - south) * 111.32 * 5) / 10)).toEqual([0.5, 2, 8, 25]);
  });

  it('reads the IP box from the pool index and checks only its nearest rows against the generation index', async () => {
    const statements = [];
    const near = Array.from({ length: 40 }, (_, index) => ({ id: `near-${index}`, latitude: 35.676 + index / 100000, longitude: 139.642 }));
    const database = {
      prepare(sql) {
        const statement = {
          bind(...values) { statements.push({ sql, values }); return statement; },
          async all() {
            if (sql.includes('distance_score')) return { results: [...near, { id: 'unpublished', latitude: 35.676, longitude: 139.642 }] };
            if (sql.includes('address_generation_index')) return { results: near.map(({ id }) => ({ id })) };
            return { results: statements.at(-1).values.map((id) => ({ ...row, id, latitude: 35.6761, longitude: 139.6421 })) };
          }
        };
        return statement;
      }
    };
    const pick = (seed) => pickNearestAddressPoolV2Address(database, 'JP', true, { latitude: 35.676, longitude: 139.642 }, seed, 25,
      new Date('2026-07-20T00:00:00Z'));
    const selected = await pick('index');
    expect(statements[0].sql).not.toContain('address_generation_index');
    expect(statements[0].sql).toContain("pool.property_type IN ('residential','apartment')");
    expect(statements[1].sql).toContain('generation.residential_ready=1');
    expect(statements[1].values).toHaveLength(41);
    // Forty publishable rows within 0.5 km are enough; the pick reads one batch of eight through the runtime view.
    const boxReads = statements.filter(({ sql }) => sql.includes('distance_score'));
    const runtimeReads = statements.filter(({ sql }) => sql.includes('address_pool_runtime'));
    expect(boxReads).toHaveLength(1);
    expect(runtimeReads).toHaveLength(1);
    expect(runtimeReads[0].sql).toContain('address_pool_runtime WHERE active = 1 AND id IN (?,?,?,?,?,?,?,?)');
    expect(runtimeReads[0].values).not.toContain('unpublished');
    expect(selected?.address.id).toMatch(/^pool-v2-near-/u);
    const picks = new Set();
    for (let index = 0; index < 20; index += 1) picks.add((await pick(`seed-${index}`))?.address.id);
    expect(picks.size).toBeGreaterThan(10);
  });

  it('falls back to the whole box when its nearest rows are all unpublishable', async () => {
    const statements = [];
    const database = {
      prepare(sql) {
        const statement = {
          bind(...values) { statements.push({ sql, values }); return statement; },
          async all() {
            if (sql.includes('JOIN address_generation_index')) return { results: [{ id: 'published', latitude: 35.6761, longitude: 139.6421 }] };
            if (sql.includes('distance_score')) return { results: Array.from({ length: 64 }, (_, index) => ({ id: `hidden-${index}`, latitude: 35.676, longitude: 139.642 })) };
            if (sql.includes('address_generation_index')) return { results: [] };
            return { results: [{ ...row, id: 'published', latitude: 35.6761, longitude: 139.6421 }] };
          }
        };
        return statement;
      }
    };
    const selected = await pickNearestAddressPoolV2Address(
      database, 'JP', true, { latitude: 35.676, longitude: 139.642 }, 'fallback', 25, new Date('2026-07-20T00:00:00Z')
    );
    expect(statements[2].sql).toContain('JOIN address_generation_index generation');
    expect(selected?.address.id).toBe('pool-v2-published');
  });
});
