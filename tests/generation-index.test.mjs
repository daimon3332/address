import { describe, expect, it } from 'vitest';
import { openTestDatabase } from './helpers/postgres-test-database.mjs';
import { refreshAddressGenerationIndex, refreshStaleAddressGenerationIndexes } from '../server/database/generation-index.mjs';
import { pickAddressPoolV2Address } from '../server/api/repositories/address-pool-v2.ts';
import { refreshAddressCoverage } from '../server/control/coverage.ts';
import { storedVariantLooksLocalized } from '../src/domain/address-display.ts';
import { addressPublicationSqlClause } from '../server/database/generation-index.mjs';

describe('address generation index', () => {
  it('uses the reader language gate for every stored semantic field without inspecting identifiers', async () => {
    const database = openTestDatabase(':memory:');
    const fields = ['buildingName', 'street', 'locality', 'postalLocality', 'dependentLocality', 'district', 'admin1'];
    const native = { street: 'Fixture Road', locality: 'Berkeley', admin1: 'CA', houseNumber: '1', postcode: '94704' };
    const valid = { native, en: native, 'zh-CN': { ...native, street: '测试路', locality: '伯克利', admin1: '加利福尼亚州' } };
    try {
      await database.prepare(`INSERT INTO address_pool(id,country_code,admin1,locality,postal_locality,street,
        house_number,postcode,latitude,longitude,native_language,component_variants_json,address_variants_json,
        quality_score,generation,coverage,random_key,active,first_seen_at,last_seen_at)
        VALUES ('language-fixture','US','CA','Berkeley','Berkeley','Fixture Road','1','94704',37.86,-122.25,'en',
          ?,'{}',.95,'fixture','fixture',1,1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`)
        .bind(JSON.stringify(valid)).run();
      for (const language of ['en', 'zh-CN']) for (const field of fields) {
        const values = language === 'en' ? ['测试路', 'Fixture Road'] : ['الطريق', '测试路'];
        for (const value of values) {
          const variants = { ...valid, [language]: { ...valid[language], [field]: value } };
          await database.prepare('UPDATE address_pool SET component_variants_json=?')
            .bind(JSON.stringify(variants)).run();
          const eligible = Number(await database.prepare(`SELECT COUNT(*) AS total FROM address_pool
            WHERE ${addressPublicationSqlClause()}`).first('total'));
          // Chinese fields never block publication; the reader shows their English form until they are translated.
          expect(eligible, `${language}:${field}:${value}`).toBe(Number(storedVariantLooksLocalized(variants.en, 'en')));
        }
      }
      // A Japanese row stores its ward as the English district; the reader shows it as the dependent locality.
      await database.prepare(`UPDATE address_pool SET district='中央区',component_variants_json=?`).bind(JSON.stringify({
        ...valid, native: { ...native, district: '中央区' }, en: { ...valid.en, district: 'Chuo' }
      })).run();
      expect(Number(await database.prepare(`SELECT COUNT(*) AS total FROM address_pool WHERE ${addressPublicationSqlClause()}`)
        .first('total'))).toBe(1);
      await database.prepare(`UPDATE address_pool SET component_variants_json=?`).bind(JSON.stringify({
        ...valid, native: { ...native, district: '中央区' } })).run();
      expect(Number(await database.prepare(`SELECT COUNT(*) AS total FROM address_pool WHERE ${addressPublicationSqlClause()}`)
        .first('total'))).toBe(0);
      await database.prepare(`UPDATE address_pool SET district=''`).run();
      const identifiers = { houseNumber: '١', unit: '동1', postcode: '١٢٣' };
      await database.prepare('UPDATE address_pool SET component_variants_json=?').bind(JSON.stringify({
        ...valid, en: { ...valid.en, ...identifiers }, 'zh-CN': { ...valid['zh-CN'], ...identifiers }
      })).run();
      expect(await database.prepare(`SELECT COUNT(*) AS total FROM address_pool
        WHERE ${addressPublicationSqlClause()}`).first('total')).toBe(1);
    } finally {
      database.close();
    }
  }, 30_000);

  it('materializes only publishable rows and marks residential evidence', async () => {
    const database = openTestDatabase(':memory:');
    try {
      await database.prepare(`INSERT INTO address_sources(
        id,name,homepage_url,data_url,license_code,license_name,license_url,attribution_text,
        attribution_url,terms_url,share_alike,notice_required,redistribution_allowed,metadata_json,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
        'fixture-source', 'Fixture', 'https://example.test', 'https://example.test/data', 'fixture', 'Fixture',
        'https://example.test/license', 'Fixture', 'https://example.test', 'https://example.test/terms',
        0, 0, 1, '{}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
      ).run();
      await database.prepare(`INSERT INTO address_datasets(
        id,source_id,country_code,version,published_at,retrieved_at,imported_at,input_checksum,format,
        license_code,license_name,license_url,attribution_text,attribution_url,terms_url,
        share_alike,notice_required,redistribution_allowed,status
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
        'fixture-dataset', 'fixture-source', 'US', 'v1', null, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z',
        'a'.repeat(64), 'jsonl', 'fixture', 'Fixture', 'https://example.test/license', 'Fixture',
        'https://example.test', 'https://example.test/terms', 0, 0, 1, 'active'
      ).run();
      await database.prepare(`INSERT INTO address_pool(
        id,country_code,admin1,admin1_code,locality,postal_locality,district,postcode,street,house_number,
        building_name,latitude,longitude,native_language,component_variants_json,address_variants_json,
        admin1_key,admin1_code_key,locality_key,postal_locality_key,district_key,postcode_key,property_type,
        quality_score,generation,coverage,random_key,active,first_seen_at,last_seen_at,expires_at,retired_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
        'fixture-address', 'US', 'California', 'CA', 'Berkeley', 'Berkeley', '', '94704', 'College Avenue', '2704',
        '', 37.86, -122.25, 'en', JSON.stringify({ native: {}, en: {}, 'zh-CN': { street: '学院大道', locality: '伯克利', admin1: '加利福尼亚州' } }),
        JSON.stringify({ native: '2704 College Avenue', en: '2704 College Avenue', 'zh-CN': '美国加利福尼亚州伯克利学院大道2704号' }),
        'california', 'ca', 'berkeley', 'berkeley', '', '94704', 'residential', 0.95, 'fixture', 'fixture',
        42, 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', null, null
      ).run();
      await database.prepare(`INSERT INTO address_pool_evidence(
        id,address_id,dataset_id,source_record_id,record_url,observed_at,evidence_type,is_primary,is_current,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(
        'fixture-existence', 'fixture-address', 'fixture-dataset', 'fixture-address', 'https://example.test/address',
        '2026-01-01T00:00:00Z', 'address_existence', 1, 1, '2026-01-01T00:00:00Z'
      ).run();
      await database.prepare(`INSERT INTO address_pool_evidence(
        id,address_id,dataset_id,source_record_id,record_url,observed_at,evidence_type,is_primary,is_current,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(
        'fixture-residential', 'fixture-address', 'fixture-dataset', 'fixture-address', 'https://example.test/address',
        '2026-01-01T00:00:00Z', 'residential_use', 0, 1, '2026-01-01T00:00:00Z'
      ).run();
      expect(await refreshAddressGenerationIndex(database, 'US')).toBe(1);
      const row = await database.prepare(`SELECT address_id,country_rank,residential_rank,
        residential_ready,search_text FROM address_generation_index`).first();
      expect(row).toMatchObject({
        address_id: 'fixture-address', country_rank: 1, residential_rank: 1, residential_ready: 1
      });
      expect(row.search_text).toContain('college avenue');
      await expect(pickAddressPoolV2Address(database, 'US', true, {}, undefined, 'generation-seed'))
        .resolves.toMatchObject({ id: 'pool-v2-fixture-address' });
      for (const [name, mutation, restore, filters] of [
        ['expired', "UPDATE address_pool SET expires_at='2000-01-01T00:00:00Z'", 'UPDATE address_pool SET expires_at=NULL', {}],
        ['low quality', 'UPDATE address_pool SET quality_score=0.1', 'UPDATE address_pool SET quality_score=0.95', {}],
        ['revoked residential proof', "UPDATE address_pool_evidence SET is_current=0 WHERE evidence_type='residential_use'",
          "UPDATE address_pool_evidence SET is_current=1 WHERE evidence_type='residential_use'", {}],
        ['changed city', "UPDATE address_pool SET locality='Oakland',postal_locality='Oakland',locality_key='oakland',postal_locality_key='oakland'",
          "UPDATE address_pool SET locality='Berkeley',postal_locality='Berkeley',locality_key='berkeley',postal_locality_key='berkeley'", { city: 'Berkeley' }]
      ]) {
        await database.exec(mutation);
        expect.soft(await pickAddressPoolV2Address(database, 'US', true, filters, undefined, 'stale-index'), name).toBeUndefined();
        await database.exec(restore);
      }
      await database.prepare(`INSERT INTO address_pool(
        id,country_code,admin1,admin1_code,locality,postal_locality,postcode,street,house_number,
        latitude,longitude,native_language,component_variants_json,address_variants_json,
        admin1_key,admin1_code_key,locality_key,postal_locality_key,postcode_key,property_type,
        quality_score,generation,coverage,random_key,active,first_seen_at,last_seen_at
      ) SELECT 'replacement-address',country_code,admin1,admin1_code,locality,postal_locality,postcode,street,'2705',
        latitude,longitude,native_language,component_variants_json,address_variants_json,
        admin1_key,admin1_code_key,locality_key,postal_locality_key,postcode_key,property_type,
        quality_score,generation,coverage,43,active,first_seen_at,last_seen_at
      FROM address_pool WHERE id='fixture-address'`).run();
      await database.prepare(`INSERT INTO address_pool_evidence(
        id,address_id,dataset_id,source_record_id,record_url,observed_at,evidence_type,is_primary,is_current,created_at
      ) VALUES ('replacement-existence','replacement-address','fixture-dataset','replacement-address','',
        '2026-01-01T00:00:00Z','address_existence',1,1,'2026-01-01T00:00:00Z'),
        ('replacement-residential','replacement-address','fixture-dataset','replacement-address-building','',
        '2026-01-01T00:00:00Z','residential_use',0,1,'2026-01-01T00:00:00Z')`).run();
      await database.prepare("UPDATE address_pool SET expires_at='2000-01-01T00:00:00Z' WHERE id='fixture-address'").run();
      expect(await database.prepare('SELECT COUNT(*) AS total FROM address_generation_index WHERE active=1').first('total')).toBe(1);
      expect(await refreshStaleAddressGenerationIndexes(database)).toEqual(['US']);
      expect(await database.prepare('SELECT address_id FROM address_generation_index WHERE active=1').first('address_id'))
        .toBe('replacement-address');
      await database.prepare("DELETE FROM address_pool WHERE id='replacement-address'").run();
      await database.prepare("UPDATE address_pool SET expires_at=NULL WHERE id='fixture-address'").run();
      await refreshAddressGenerationIndex(database, 'US');
      await database.prepare("UPDATE address_pool SET locality='',locality_key='' WHERE id='fixture-address'").run();
      await refreshAddressGenerationIndex(database, 'US');
      await refreshAddressCoverage(database, { useGenerationIndex: true });
      expect(await database.prepare(`SELECT total_count FROM admin_coverage_stats
        WHERE node_key='US:loc:43616c69666f726e6961:4265726b656c6579'`).first('total_count')).toBe(1);
      await database.prepare("UPDATE address_pool SET locality='Berkeley',locality_key='berkeley' WHERE id='fixture-address'").run();
      await refreshAddressGenerationIndex(database, 'US');
      await database.prepare("UPDATE address_pool SET expires_at='2099-01-01'").run();
      expect(await refreshAddressGenerationIndex(database, 'US')).toBe(1);
      await database.prepare('UPDATE address_generation_index SET residential_rank=NULL').run();
      expect(await refreshStaleAddressGenerationIndexes(database)).toEqual(['US']);
      expect(await database.prepare('SELECT residential_rank FROM address_generation_index WHERE active=1').first('residential_rank')).toBe(1);
      // A retired neighbour leaves a rank gap; the nationwide pick probes on instead of reading a random-key window.
      await database.prepare('UPDATE address_generation_index SET country_rank=3,residential_rank=3').run();
      const prepare = database.prepare.bind(database);
      const statements = [];
      database.prepare = (sql) => { statements.push(sql); return prepare(sql); };
      await expect(pickAddressPoolV2Address(database, 'US', false, {}, undefined, 'gapped-rank'))
        .resolves.toMatchObject({ id: 'pool-v2-fixture-address' });
      database.prepare = prepare;
      expect(statements.some((sql) => sql.includes('random_key >='))).toBe(false);
      await database.prepare('UPDATE address_generation_index SET country_rank=5000').run();
      expect(await refreshStaleAddressGenerationIndexes(database)).toEqual(['US']);
      expect(await database.prepare('SELECT country_rank FROM address_generation_index WHERE active=1').first('country_rank')).toBe(1);
      await database.prepare("UPDATE address_pool SET expires_at='2000-01-01T00:00:00Z'").run();
      expect(await refreshAddressGenerationIndex(database, 'US')).toBe(0);
      await database.prepare('UPDATE address_pool SET component_variants_json=?').bind(JSON.stringify({
        native: {}, en: { street: 'الطريق' }, 'zh-CN': { street: 'الطريق', locality: '伯克利' }
      })).run();
      expect(await refreshAddressGenerationIndex(database, 'US')).toBe(0);
      await refreshAddressCoverage(database);
      expect(await database.prepare("SELECT total_count FROM admin_coverage_stats WHERE node_key='US'")
        .first('total_count')).toBe(0);
      expect(await pickAddressPoolV2Address(database, 'US', false, {}, undefined, 'invalid-language'))
        .toBeUndefined();
      await database.prepare("UPDATE address_pool SET component_variants_json='{}'").run();
      await refreshAddressCoverage(database);
      expect(await database.prepare("SELECT residential_count FROM admin_coverage_stats WHERE node_key='US'")
        .first('residential_count')).toBe(0);
      expect(await refreshAddressGenerationIndex(database, 'US')).toBe(0);
    } finally {
      database.close();
    }
  }, 30_000);
});
