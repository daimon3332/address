import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { pickAddressPoolV2Address, pickNearestAddressPoolV2Address } from '../server/api/repositories/address-pool-v2';

describe('unified SQLite address schema', () => {
  it('defines the runtime view, evidence model, RTree and synchronization state together', () => {
    const schema = readFileSync('server/database/schema.sql', 'utf8');
    expect(schema).toContain('CREATE VIEW IF NOT EXISTS address_pool_runtime');
    expect(schema).toContain('CREATE VIRTUAL TABLE IF NOT EXISTS address_coordinate_index USING rtree');
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS address_pool_evidence');
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS sync_country_state');
    expect(schema).not.toContain('address_pool_meta');
  });
});

describe('ADDRESS_DB v2 repository', () => {
  const row = {
    id: 'fixture-address', country_code: 'JP', admin1: '東京都', admin1_code: '13',
    locality: '杉並区', postal_locality: '杉並区', district: '永福', postcode: '168-0064',
    street: '永福', house_number: '4-27-7', building_name: '', latitude: 35.676, longitude: 139.642,
    native_language: 'ja', property_type: 'residential', generation: 'fixture-2026-07', quality_score: 0.95,
    first_seen_at: '2026-07-16T00:00:00Z', expires_at: '2027-07-15T00:00:00Z',
    component_variants_json: JSON.stringify({
      native: { houseNumber: '4-27-7', street: '永福', locality: '杉並区', postcode: '168-0064' },
      en: { houseNumber: '4-27-7', street: 'Eifuku', locality: 'Suginami', postcode: '168-0064' },
      'zh-CN': { houseNumber: '4-27-7', street: '永福', locality: '杉并区', postcode: '168-0064' }
    }),
    address_variants_json: JSON.stringify({ native: '東京都杉並区永福4-27-7', en: '4-27-7 Eifuku, Suginami, Tokyo 168-0064', 'zh-CN': '东京都杉并区永福4-27-7' }),
    source_id: 'fixture', source_name: 'Fixture Source', source_url: 'https://example.test/source',
    source_record_id: 'jp-1', record_url: 'https://example.test/source/jp-1', observed_at: '2026-07-15T00:00:00Z',
    evidence_type: 'address_existence', residential_evidence: 1,
    dataset_id: 'fixture-dataset', dataset_version: '2026-07-15',
    source_updated_at: '2026-07-15T00:00:00Z', imported_at: '2026-07-16T00:00:00Z'
  };

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
      id: 'pool-v2-fixture-address', nativeLanguage: 'ja', nativeAddress: '東京都杉並区永福4-27-7',
      formattedAddress: '4-27-7 Eifuku, Suginami, Tokyo 168-0064', sourceVersion: 'fixture-dataset:2026-07-15'
    }));
    expect(address?.componentVariants['zh-CN'].locality).toBe('杉并区');
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

  it('only treats a missing v2 runtime view as a compatibility miss', async () => {
    const missing = { prepare() { throw new Error('no such table: address_pool_runtime'); } };
    const broken = { prepare() { throw new Error('SQLITE_BUSY: database is locked'); } };
    await expect(pickAddressPoolV2Address(missing, 'US', false, {}, undefined, 'seed')).resolves.toBeUndefined();
    await expect(pickAddressPoolV2Address(broken, 'US', false, {}, undefined, 'seed')).rejects.toThrow('database is locked');
  });

  it('skips a v2 US row whose state field contains Philadelphia', async () => {
    const components = {
      houseNumber: '10', street: 'Market Street', locality: 'Philadelphia', postalLocality: 'Philadelphia',
      admin1: 'Pennsylvania', admin1Code: 'PA', postcode: '19103'
    };
    const base = {
      ...row, country_code: 'US', locality: 'Philadelphia', postal_locality: 'Philadelphia', district: '',
      postcode: '19103', street: 'Market Street', house_number: '10', latitude: 39.95, longitude: -75.16,
      native_language: 'en', component_variants_json: JSON.stringify({ native: components, en: components, 'zh-CN': components }),
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

  it('preserves indexed candidate order after batch materialization', async () => {
    const first = { ...row, id: 'first' };
    const second = { ...row, id: 'second' };
    const database = {
      prepare(sql) {
        const statement = {
          bind() { return statement; },
          async all() {
            return { results: sql.startsWith('SELECT id FROM address_pool')
              ? [{ id: first.id }, { id: second.id }]
              : [second, first] };
          }
        };
        return statement;
      }
    };

    await expect(pickAddressPoolV2Address(database, 'JP', false, {}, undefined, 'ordered-seed'))
      .resolves.toMatchObject({ id: 'pool-v2-first' });
  });

  it('normalizes a 112xx v2 postal locality to Brooklyn', async () => {
    const components = {
      houseNumber: '478', street: 'Dean Street', locality: 'New York', postalLocality: 'New York',
      admin1: 'New York', admin1Code: 'NY', postcode: '11217'
    };
    const brooklyn = {
      ...row, id: 'brooklyn', country_code: 'US', admin1: 'New York', admin1_code: 'NY',
      locality: 'New York', postal_locality: 'New York', district: 'Kings County', postcode: '11217',
      street: 'Dean Street', house_number: '478', latitude: 40.681116, longitude: -73.975375,
      native_language: 'en', component_variants_json: JSON.stringify({ native: components, en: components, 'zh-CN': components }),
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
});
