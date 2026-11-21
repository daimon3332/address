import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeTestDatabase, openTestDatabase } from './helpers/postgres-test-database.mjs';
import { PostgresDatabase } from '../server/database/postgres.mjs';
import { retireUnlatinizablePremises } from '../server/sync/english-premise.mjs';
import { repairJapaneseLocalizedAddresses } from '../server/sync/japan-english-repair.mjs';

const at = '2026-11-21T00:00:00.000Z';
const insert = (database, id, country, native, en = native, zh = native) => database.prepare(`INSERT INTO address_pool(id,country_code,admin1,
    admin1_code,locality,postal_locality,street,house_number,postcode,postcode_key,latitude,longitude,native_language,component_variants_json,
    address_variants_json,property_type,quality_score,generation,coverage,random_key,active,first_seen_at,last_seen_at,match_level)
  VALUES (?,?,?,?,?,'',?,?,?,?,35,139,'ja',?,?,'unknown',.9,'v1','x',1,1,?,?,'premise')`).bind(
  id, country, native.admin1, native.admin1, native.locality, native.street, native.houseNumber, native.postcode || '1', native.postcode || '1',
  JSON.stringify({ native, en, 'zh-CN': zh }), JSON.stringify({ native: 'x', en: 'x', 'zh-CN': 'x' }), at, at).run();

describe('English premises', () => {
  let database;
  beforeEach(async () => {
    database = openTestDatabase();
    const exec = PostgresDatabase.prototype.exec;
    vi.spyOn(PostgresDatabase.prototype, 'exec').mockImplementation(function (sql) {
      if (/^(LOCK TABLE|SET LOCAL)/u.test(sql)) return Promise.resolve();
      return exec.call(this, sql);
    });
    await initializeTestDatabase(database, new URL('../server/control/schema.sql', import.meta.url));
  });
  afterEach(async () => { await database.close(); vi.restoreAllMocks(); });

  it('retires only rows whose house number or unit cannot be written in Latin script, once per revision', async () => {
    const base = { admin1: 'กรุงเทพมหานคร', locality: 'เขตบางรัก', street: 'ถนนสีลม' };
    await insert(database, 'moo', 'TH', { ...base, houseNumber: '100/7 หมู่4' });
    await insert(database, 'soi', 'TH', { ...base, houseNumber: '85 ซอยบ้านตั้งสิน' });
    await insert(database, 'plain', 'TH', { ...base, houseNumber: '12' });
    expect(await retireUnlatinizablePremises({ database, countryCode: 'TH', now: () => new Date(at) }))
      .toMatchObject({ checked: 2, retired: 1 });
    const rows = new Map((await database.prepare('SELECT id,active,retired_at FROM address_pool').all()).results.map((row) => [row.id, row]));
    expect(rows.get('soi')).toMatchObject({ active: 0, retired_at: expect.stringContaining('english-premise-v1') });
    expect(rows.get('moo').active).toBe(1);
    expect(rows.get('plain').active).toBe(1);
    expect(await retireUnlatinizablePremises({ database, countryCode: 'TH' })).toMatchObject({ checked: 0, retired: 0 });
    await insert(database, 'later', 'TH', { ...base, houseNumber: 'บ้านลังกา' });
    expect(await retireUnlatinizablePremises({ database, countryCode: 'TH', addressIds: ['later'] })).toMatchObject({ retired: 1 });
  });

  it('rewrites Japanese English and Chinese town fields from the registry romanization once', async () => {
    const native = { houseNumber: '1番地3', street: '西中島四丁目', district: '西中島', locality: '大阪市淀川区', admin1: '大阪府', postcode: '532-0011' };
    await insert(database, 'jp', 'JP', native, { ...native, street: 'The four western central islands', district: 'Nishinakajima' },
      { ...native, street: '中西四岛', district: '西中岛' });
    const romaji = { '大阪府|大阪市淀川区': { city: 'Osaka-shi', ward: 'Yodogawa-ku', towns: { 西中島: 'Nishinakajima' } } };
    expect(await repairJapaneseLocalizedAddresses({ database, romaji, now: () => new Date(at) })).toMatchObject({ repaired: 1, unresolved: 0 });
    const row = await database.prepare("SELECT component_variants_json,address_variants_json FROM address_pool WHERE id='jp'").first();
    const variants = JSON.parse(row.component_variants_json);
    expect(variants.en).toMatchObject({ houseNumber: '1-3', street: 'Nishinakajima 4-chome', district: 'Nishinakajima' });
    expect(variants['zh-CN']).toMatchObject({ street: '西中島4丁目', district: '西中島' });
    expect(JSON.parse(row.address_variants_json).en).toContain('1-3 Nishinakajima 4-chome');
    expect(await repairJapaneseLocalizedAddresses({ database, romaji })).toMatchObject({ repaired: 0 });
  });
});
