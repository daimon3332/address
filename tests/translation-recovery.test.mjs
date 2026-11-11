import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeTestDatabase, openTestDatabase } from './helpers/postgres-test-database.mjs';
import { refreshStaleCoverage, republishEnglishReadyRows, runTranslationBackfillBatch, startTranslationBackfill } from '../server/sync/translation-backfill.mjs';
import { createBackfillProviders, readBackfillProgress, writeBackfillProgress } from '../server/sync/translation-providers.mjs';
import { PostgresTranslationCache } from '../server/sync/address-etl.mjs';
import { ControlStore } from '../server/control/store.ts';
import { PostgresDatabase } from '../server/database/postgres.mjs';
import { pickAddressPoolV2Address } from '../server/api/repositories/address-pool-v2.ts';
import { applyAdministrativeCatalogOverrides } from '../server/database/administrative-catalog-overrides.ts';

const observedAt = '2026-09-01T00:00:00.000Z';
const now = () => new Date('2026-09-08T16:00:00.000Z');
const native = { houseNumber: '', street: 'Main Street 21', locality: 'Springfield',
  admin1: 'Illinois', admin1Code: 'IL', postcode: '62701' };
const chinese = { ...native, street: '\u4e3b\u8857 21', locality: '\u65af\u666e\u6797\u83f2\u5c14\u5fb7', admin1: '\u4f0a\u5229\u8bfa\u4f0a\u5dde' };
const translations = new Map(Object.keys(native).map((field) => [native[field], chinese[field]]));
// A street written in Cyrillic needs an English translation before its address can publish.
const cyrillicStreet = 'Мейн-стрит 21';
translations.set(cyrillicStreet, chinese.street);
const englishTranslations = new Map([[cyrillicStreet, native.street]]);
const translate = vi.fn(async (url) => {
  const boundary = '[[[ADDRESS_COMPONENT_BOUNDARY]]]';
  const values = new URL(url).searchParams.get('q').split(`\n${boundary}\n`);
  const english = new URL(url).searchParams.get('tl') === 'en';
  return Response.json([[[values.map((value) => (english ? englishTranslations : translations).get(value) || value).join(`\n${boundary}\n`)]]]);
});
// A provider answer that is no usable translation in either target language.
const unusable = vi.fn(async (url) => {
  const boundary = '[[[ADDRESS_COMPONENT_BOUNDARY]]]';
  const values = new URL(url).searchParams.get('q').split(`\n${boundary}\n`);
  const english = new URL(url).searchParams.get('tl') === 'en';
  return Response.json([[[values.map((value) => english ? '无效' : value).join(`\n${boundary}\n`)]]]);
});

describe('source-backed translation recovery', () => {
  let database;
  // Moves the clock past the publication start deadline once the first country commits.
  const expireAfterFirstPublication = () => {
    const transaction = database.transaction.bind(database);
    vi.spyOn(database, 'transaction').mockImplementation(async (work) => {
      const result = await transaction(work);
      vi.spyOn(Date, 'now').mockReturnValue(Number.MAX_SAFE_INTEGER);
      return result;
    });
  };

  it('strictly revalidates only changed addresses when publishing a translation batch', async () => {
    const prepare = vi.spyOn(PostgresDatabase.prototype, 'prepare');
    expect((await runTranslationBackfillBatch({ database, environment: {}, fetchImpl: translate, now })).updated).toBe(1);
    const insert = prepare.mock.calls.find(([sql]) => sql.includes('INSERT INTO address_generation_index'))?.[0];
    expect(insert).toContain('runtime.id IN (');
    expect(insert).toContain('component_variants_json');
  });
  beforeEach(async () => {
    database = openTestDatabase();
    const exec = PostgresDatabase.prototype.exec;
    vi.spyOn(PostgresDatabase.prototype, 'exec').mockImplementation(function (sql) {
      if (/^(LOCK TABLE|SET LOCAL)/u.test(sql)) return Promise.resolve();
      return exec.call(this, sql);
    });
    await initializeTestDatabase(database, new URL('../server/control/schema.sql', import.meta.url));
    await database.exec(`INSERT INTO system_settings(key,value_json,updated_at)
      VALUES ('google_translation_enabled','true','${observedAt}');
      INSERT INTO catalog_regions(id,country_code,code,name,native_name,zh_name,path)
      VALUES (1,'US','IL','Illinois','Illinois','Illinois','US/IL');
      INSERT INTO catalog_cities(id,country_code,region_id,name,native_name,zh_name)
      VALUES (1,'US',1,'Springfield','Springfield','Springfield');
      INSERT INTO address_sources(id,name,homepage_url,data_url,license_code,license_name,license_url,
        attribution_text,attribution_url,terms_url,share_alike,notice_required,redistribution_allowed,created_at,updated_at)
      VALUES ('fixture','Fixture','https://example.test','https://example.test/data','CC0','CC0','https://example.test/license',
        'Fixture','https://example.test','https://example.test/terms',0,0,1,'${observedAt}','${observedAt}');
      INSERT INTO address_datasets(id,source_id,country_code,version,retrieved_at,imported_at,input_checksum,
        format,license_code,license_name,license_url,attribution_text,attribution_url,terms_url,share_alike,notice_required,
        redistribution_allowed,status)
      VALUES ('dataset','fixture','US','v1','${observedAt}','${observedAt}','${'a'.repeat(64)}',
        'jsonl','CC0','CC0','https://example.test/license','Fixture','https://example.test','https://example.test/terms',0,0,1,'active');`);
    await database.prepare(`INSERT INTO address_pool(id,country_code,admin1,admin1_code,locality,street,
      house_number,postcode,latitude,longitude,native_language,component_variants_json,address_variants_json,property_type,
      quality_score,generation,coverage,random_key,active,first_seen_at,last_seen_at,retired_at,match_level)
      VALUES ('street-fixture','US','Illinois','IL','Springfield','Main Street 21','','62701',39.78,-89.65,'en',?,?,'unknown',
        .95,'v1','US/IL',1,0,?,?,'publication-validation:fixture','street')`)
      .bind(JSON.stringify({ native, en: native, 'zh-CN': native }),
        JSON.stringify({ native: 'Main Street 21, Springfield, Illinois', en: '', 'zh-CN': '' }), observedAt, observedAt).run();
    await database.prepare(`INSERT INTO address_pool_evidence(id,address_id,dataset_id,source_record_id,
      observed_at,evidence_type,is_primary,is_current,created_at)
      VALUES ('evidence','street-fixture','dataset','way/21',?,'address_existence',1,1,?)`)
      .bind(observedAt, observedAt).run();
    translate.mockClear();
  });
  afterEach(async () => { await database.close(); vi.restoreAllMocks(); });
  // English-first publication: only a missing English street blocks publication, so retry and wait behaviour is
  // exercised on a record whose English variant still needs translation.
  const requireEnglish = async () => {
    const source = { ...native, street: cyrillicStreet };
    await database.prepare("UPDATE address_pool SET street=?,component_variants_json=? WHERE id='street-fixture'")
      .bind(cyrillicStreet, JSON.stringify({ native: source, en: source, 'zh-CN': source })).run();
  };
  const cacheTranslations = async () => {
    const cache = new PostgresTranslationCache(database);
    await cache.set(translations, 'zh-CN');
    await cache.set(englishTranslations, 'en');
  };

  it('publishes an ordinary address with its English street when the Chinese street is not translated yet', async () => {
    const partial = vi.fn(async (url) => {
      const boundary = '[[[ADDRESS_COMPONENT_BOUNDARY]]]';
      const values = new URL(url).searchParams.get('q').split(`\n${boundary}\n`);
      return Response.json([[[values.map((value) => value === native.street ? value : translations.get(value) || value)
        .join(`\n${boundary}\n`)]]]);
    });
    const result = await runTranslationBackfillBatch({ database, environment: {}, fetchImpl: partial, now });
    expect(result.updated).toBe(1);
    const row = await database.prepare("SELECT active,component_variants_json FROM address_pool WHERE id='street-fixture'").first();
    expect(row.active).toBe(1);
    expect(JSON.parse(row.component_variants_json)['zh-CN']).toMatchObject({ street: native.street, admin1: chinese.admin1 });
    expect(await database.prepare('SELECT status,reason FROM translation_recovery').first())
      .toEqual({ status: 'waiting', reason: 'chinese_fallback' });
    expect(await database.prepare("SELECT COUNT(*) AS total FROM address_generation_index WHERE active=1").first('total')).toBe(1);
  });

  it('publishes once the English variant is translated while Chinese names are still missing', async () => {
    await requireEnglish();
    const englishOnly = vi.fn(async (url) => {
      const boundary = '[[[ADDRESS_COMPONENT_BOUNDARY]]]';
      const values = new URL(url).searchParams.get('q').split(`\n${boundary}\n`);
      const english = new URL(url).searchParams.get('tl') === 'en';
      return Response.json([[[values.map((value) => english ? englishTranslations.get(value) || value : value).join(`\n${boundary}\n`)]]]);
    });
    expect((await runTranslationBackfillBatch({ database, environment: {}, fetchImpl: englishOnly, now })).updated).toBe(1);
    const row = await database.prepare("SELECT active,component_variants_json FROM address_pool WHERE id='street-fixture'").first();
    expect(row.active).toBe(1);
    const variants = JSON.parse(row.component_variants_json);
    expect(variants.en.street).toBe(native.street);
    expect(variants['zh-CN'].street).toBe(native.street);
    expect(await database.prepare('SELECT status,reason FROM translation_recovery').first())
      .toEqual({ status: 'waiting', reason: 'chinese_fallback' });
  });

  it('republishes rows retired only for untranslated Chinese names once, leaving repair retirements alone', async () => {
    await database.exec(`UPDATE address_pool SET retired_at='publication-validation:address-reader-v7-implausible-phrases:2026-09-01'`);
    await database.exec(`INSERT INTO address_pool(id,country_code,admin1,admin1_code,locality,street,house_number,latitude,longitude,native_language,
        component_variants_json,address_variants_json,property_type,quality_score,generation,coverage,random_key,active,first_seen_at,last_seen_at,retired_at,match_level)
        SELECT 'outside',country_code,admin1,admin1_code,locality,street,house_number,latitude,longitude,native_language,component_variants_json,
        address_variants_json,property_type,quality_score,generation,coverage,2,active,first_seen_at,last_seen_at,
        'publication-validation:administrative-names-v19:2026-09-01',match_level FROM address_pool WHERE id='street-fixture';
      INSERT INTO address_pool_evidence(id,address_id,dataset_id,source_record_id,observed_at,evidence_type,is_primary,is_current,created_at)
        VALUES ('outside-evidence','outside','dataset','way/23','${observedAt}','address_existence',1,1,'${observedAt}');`);
    expect(await republishEnglishReadyRows({ database, countryCode: 'US', pauseMs: 0, now }))
      .toEqual({ countryCode: 'US', scanned: 1, republished: 1 });
    const rows = new Map((await database.prepare('SELECT id,active FROM address_pool').all()).results.map((row) => [row.id, row.active]));
    expect(Object.fromEntries(rows)).toEqual({ 'street-fixture': 1, outside: 0 });
    expect(await database.prepare("SELECT COUNT(*) AS total FROM address_generation_index WHERE active=1").first('total')).toBe(1);
    expect(await republishEnglishReadyRows({ database, countryCode: 'US', pauseMs: 0, now })).toMatchObject({ scanned: 0, republished: 0 });
  });

  it('publishes a backlog of addresses without first sending their Chinese names to providers', async () => {
    for (let index = 0; index < 200; index++) {
      const id = `backlog-${String(index).padStart(3, '0')}`;
      await database.exec(`INSERT INTO address_pool(id,country_code,admin1,admin1_code,locality,street,house_number,latitude,longitude,native_language,
        component_variants_json,address_variants_json,property_type,quality_score,generation,coverage,random_key,active,first_seen_at,last_seen_at,retired_at,match_level)
        SELECT '${id}',country_code,admin1,admin1_code,locality,'Backlog Street ${index}',house_number,latitude,longitude,native_language,
        replace(component_variants_json,'Main Street 21','Backlog Street ${index}'),address_variants_json,property_type,quality_score,generation,coverage,
        ${index + 2},active,first_seen_at,last_seen_at,retired_at,match_level FROM address_pool WHERE id='street-fixture';
        INSERT INTO address_pool_evidence(id,address_id,dataset_id,source_record_id,observed_at,evidence_type,is_primary,is_current,created_at)
        VALUES ('evidence-${id}','${id}','dataset','way/${id}','${observedAt}','address_existence',1,1,'${observedAt}');`);
    }
    const result = await runTranslationBackfillBatch({ database, environment: {}, fetchImpl: translate, now });
    const requested = translate.mock.calls.map(([url]) => new URL(url).searchParams.get('q')).join('\n');
    expect(requested).not.toContain('Backlog Street');
    expect(result.updated).toBeGreaterThan(100);
    expect(await database.prepare("SELECT COUNT(*) AS total FROM translation_recovery WHERE reason='chinese_fallback'").first('total'))
      .toBeGreaterThan(100);
  }, 120_000);

  it('defers a competing recovery worker without moving its cursor or dispatching requests', async () => {
    let release;
    let started;
    const pending = new Promise((resolve) => { release = resolve; });
    const dispatched = new Promise((resolve) => { started = resolve; });
    const running = runTranslationBackfillBatch({ database, environment: {}, now, fetchImpl: async (...args) => {
      started(); await pending; return translate(...args);
    } });
    await dispatched;
    try {
      const competing = await runTranslationBackfillBatch({ database, environment: {}, now, cacheOnly: true, countryCodes: ['US'] });
      expect(competing).toMatchObject({ scanned: 0, updated: 0, requests: 0, waiting: 'recovery_in_progress' });
      expect(await database.prepare("SELECT value_json FROM translation_backfill_progress WHERE key='scan:cache:US'").first()).toBeNull();
    } finally { release(); await running; }
    expect((await runTranslationBackfillBatch({ database, environment: {}, now, cacheOnly: true })).waiting).toBeUndefined();
  });

  it('publishes cached translations with providers disabled and no spent attempts', async () => {
    await database.exec("UPDATE system_settings SET value_json='false' WHERE key='google_translation_enabled'");
    await new PostgresTranslationCache(database).set(translations, 'zh-CN');
    const fetchImpl = vi.fn(() => { throw new Error('Cache recovery must not call a provider'); });
    const result = await runTranslationBackfillBatch({ database, environment: {}, fetchImpl, now,
      cacheOnly: true, countryCodes: ['US'] });
    expect(result).toMatchObject({ updated: 1, requests: 0, done: true });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await database.prepare('SELECT status,attempts FROM translation_recovery').first())
      .toBeFalsy();
    expect(await database.prepare('SELECT COUNT(*) AS total FROM address_generation_index WHERE active=1').first('total')).toBe(1);
  });

  it('leaves rows the region repairs retired for their own next revision', async () => {
    await new PostgresTranslationCache(database).set(translations, 'zh-CN');
    for (const retiredAt of ['publication-validation:administrative-names-v5:2026-10-13T00:00:00.000Z',
      'publication-validation:address-structure-v1:2026-10-12T00:00:00.000Z']) {
      await database.prepare("UPDATE address_pool SET retired_at=? WHERE id='street-fixture'").bind(retiredAt).run();
      expect((await runTranslationBackfillBatch({ database, environment: {}, fetchImpl: vi.fn(), now, cacheOnly: true, countryCodes: ['US'] }))
        .updated).toBe(0);
      expect(await database.prepare("SELECT active,retired_at FROM address_pool WHERE id='street-fixture'").first())
        .toEqual({ active: 0, retired_at: retiredAt });
    }
  });

  it('updates multiple source dataset counts without recounting them', async () => {
    await database.exec(`INSERT INTO address_datasets(id,source_id,country_code,version,retrieved_at,imported_at,input_checksum,
      format,license_code,license_name,license_url,attribution_text,attribution_url,terms_url,share_alike,notice_required,redistribution_allowed,status)
      SELECT 'dataset-2',source_id,country_code,'v2',retrieved_at,imported_at,input_checksum,format,license_code,license_name,
      license_url,attribution_text,attribution_url,terms_url,share_alike,notice_required,redistribution_allowed,status FROM address_datasets;
      INSERT INTO address_pool(id,country_code,admin1,admin1_code,locality,street,house_number,latitude,longitude,native_language,
      component_variants_json,address_variants_json,property_type,quality_score,generation,coverage,random_key,active,first_seen_at,last_seen_at,retired_at,match_level)
      SELECT 'street-2',country_code,admin1,admin1_code,locality,'Example Street 22',house_number,latitude,longitude,native_language,
      component_variants_json,address_variants_json,property_type,quality_score,generation,coverage,2,active,first_seen_at,last_seen_at,retired_at,match_level FROM address_pool;
      INSERT INTO address_pool_evidence(id,address_id,dataset_id,source_record_id,observed_at,evidence_type,is_primary,is_current,created_at)
      VALUES ('evidence-2','street-2','dataset-2','way/22','${observedAt}','address_existence',1,1,'${observedAt}');`);
    await database.prepare("UPDATE address_pool SET component_variants_json=? WHERE id='street-2'").bind(JSON.stringify({
      native: { ...native, street: 'Example Street 22' }, en: { ...native, street: 'Example Street 22' },
      'zh-CN': { ...chinese, street: '示例街 22' }
    })).run();
    await new PostgresTranslationCache(database).set(translations, 'zh-CN');
    const prepare = vi.spyOn(PostgresDatabase.prototype, 'prepare');
    expect((await runTranslationBackfillBatch({ database, environment: {}, cacheOnly: true, now })).updated).toBe(2);
    expect((await database.prepare('SELECT id,active_count FROM address_datasets ORDER BY id').all()).results)
      .toEqual([{ id: 'dataset', active_count: 1 }, { id: 'dataset-2', active_count: 1 }]);
    expect(prepare.mock.calls.filter(([sql]) => sql.includes('COUNT(DISTINCT evidence.address_id)'))).toHaveLength(0);
  });

  it('keeps discovering records while a due record repeatedly waits for provider cooldown', async () => {
    await requireEnglish();
    await database.exec(`INSERT INTO address_pool(id,country_code,admin1,admin1_code,locality,street,
      house_number,latitude,longitude,native_language,component_variants_json,address_variants_json,property_type,
      quality_score,generation,coverage,random_key,active,first_seen_at,last_seen_at,retired_at,match_level)
      SELECT 'zz-new',country_code,admin1,admin1_code,locality,street,house_number,latitude,longitude,
      native_language,component_variants_json,address_variants_json,property_type,quality_score,generation,
      coverage,2,active,first_seen_at,last_seen_at,retired_at,match_level FROM address_pool;
      INSERT INTO address_pool_evidence(id,address_id,dataset_id,source_record_id,observed_at,evidence_type,is_primary,is_current,created_at)
      VALUES ('new-evidence','zz-new','dataset','way/22','${observedAt}','address_existence',1,1,'${observedAt}');`);
    const clock = Date.now();
    const limited = async () => Response.json({}, { status: 429, headers: { 'Retry-After': '60' } });
    for (let batch = 0; batch < 4; batch++) await runTranslationBackfillBatch({
      database, environment: {}, pendingLimit: 1, fetchImpl: limited,
      now: () => new Date(clock + batch * 65_000)
    });
    expect(await database.prepare("SELECT status,attempts FROM translation_recovery WHERE address_id='zz-new'").first())
      .toEqual({ status: 'waiting', attempts: 0 });
  });

  it('restores an OpenAI route after its cooldown expires without manual credential changes', async () => {
    const control = new ControlStore(database, Buffer.alloc(32, 31));
    const id = await control.addCredential({ provider: 'openai-compatible', label: 'Fixture',
      apiKey: 'synthetic-key-only', baseUrl: 'https://example.test/v1', model: 'fixture-model' });
    await database.prepare("UPDATE provider_credentials SET status='cooldown',cooldown_until=? WHERE id=?")
      .bind('2026-09-01T00:00:00Z', id).run();
    const services = await createBackfillProviders({ database, environment: {}, now,
      signal: new AbortController().signal,
      brokerClient: { availability: async () => ({ 'openai-compatible': { available: true } }) } });
    expect(services.translationChain.some((route) => route.id === `openai:${id}`)).toBe(true);
  });

  it.each([false, true])('repairs a malformed target variant from cache without weakening the source gate (legacy rejection %s)', async (legacy) => {
    const source = { ...native, houseNumber: '1', postcode: '62701' };
    const target = { ...source, locality: 'government office 구청' };
    await database.prepare(`UPDATE address_pool SET house_number='1',postcode='62701',match_level='premise',
      property_type='residential',component_variants_json=?,address_variants_json=?`)
      .bind(JSON.stringify({ native: source, en: source, 'zh-CN': target }),
        JSON.stringify({ native: '1 Main Street 21, Springfield, Illinois 62701',
          en: '1 Main Street 21, Springfield, Illinois 62701', 'zh-CN': 'government office 구청' })).run();
    await new PostgresTranslationCache(database).set(translations, 'zh-CN');
    if (legacy) {
      const { revision } = await createBackfillProviders({ database, environment: {}, fetchImpl: translate,
        now, signal: new AbortController().signal });
      await database.prepare(`INSERT INTO translation_recovery(address_id,input_hash,service_revision,status,attempts,reason,updated_at)
        VALUES ('street-fixture','legacy-base-input',?,'rejected',0,'base_contract',?)`).bind(revision, observedAt).run();
    }
    await writeBackfillProgress(database, 'scan', { phase: 'all', cursor: legacy ? 'zzzz' : '' }, now());
    expect((await runTranslationBackfillBatch({ database, environment: {}, fetchImpl: translate, now })).updated).toBe(1);
    expect(translate).not.toHaveBeenCalled();
    const recovered = await database.prepare('SELECT component_variants_json,active,retired_at FROM address_pool').first();
    expect(recovered).toMatchObject({ active: 1, retired_at: null });
    expect(JSON.parse(recovered.component_variants_json)).toEqual({ native: source, en: source,
      'zh-CN': { ...chinese, houseNumber: '1', postcode: '62701' } });
    expect(await database.prepare('SELECT status,attempts FROM translation_recovery').first()).toBeFalsy();
  });

  it('reevaluates a legacy base rejection once while preserving unchanged genuine source failures', async () => {
    await database.exec('UPDATE address_pool SET latitude=0,longitude=0');
    const { revision } = await createBackfillProviders({ database, environment: {}, fetchImpl: translate,
      now, signal: new AbortController().signal });
    await database.prepare(`INSERT INTO translation_recovery(address_id,input_hash,service_revision,status,attempts,reason,updated_at)
      VALUES ('street-fixture','legacy-base-input',?,'rejected',0,'base_contract',?)`).bind(revision, observedAt).run();
    await writeBackfillProgress(database, 'scan', { phase: 'all', cursor: 'zzzz' }, now());
    await runTranslationBackfillBatch({ database, environment: {}, fetchImpl: translate, now });
    const state = await database.prepare('SELECT * FROM translation_recovery').first();
    expect(state).toMatchObject({ status: 'rejected', attempts: 0, reason: 'base_contract', updated_at: now().toISOString() });
    expect(state.service_revision).not.toBe(revision);
    await runTranslationBackfillBatch({ database, environment: {}, fetchImpl: translate,
      now: () => new Date(now().getTime() + 600_000) });
    expect(await database.prepare('SELECT * FROM translation_recovery').first()).toEqual(state);
    expect(translate).not.toHaveBeenCalled();
  });

  it('uses the configured provider to restore a retired street and all publication projections', async () => {
    const result = await runTranslationBackfillBatch({ database, environment: {}, fetchImpl: translate, now });
    expect(result.updated).toBe(1);
    const row = await database.prepare("SELECT * FROM address_pool WHERE id='street-fixture'").first();
    expect(row).toMatchObject({ active: 1, retired_at: null, house_number: '', postcode: '62701',
      first_seen_at: observedAt, last_seen_at: observedAt, generation: 'v1' });
    expect(JSON.parse(row.component_variants_json)).toEqual({ native, en: native, 'zh-CN': chinese });
    expect(JSON.parse(row.address_variants_json)['zh-CN']).toContain(chinese.street);
    expect(JSON.parse(row.address_variants_json).native).toBe('Main Street 21, Springfield, Illinois');
    expect(await database.prepare('SELECT COUNT(*) AS total FROM address_generation_index WHERE active=1').first('total')).toBe(1);
    expect(await database.prepare("SELECT address_count,residential_count FROM sync_country_state WHERE country_code='US'").first())
      .toEqual({ address_count: 1, residential_count: 0 });
    await refreshStaleCoverage(database, now, { force: true });
    expect(await database.prepare("SELECT total_count,address_count FROM residential_coverage WHERE country_code='US'").first())
      .toEqual({ total_count: 1, address_count: 0 });
    expect(await pickAddressPoolV2Address(database, 'US', false, {}, undefined, 'recovered-street'))
      .toMatchObject({ matchLevel: 'street', propertyType: 'unknown', addressStatus: 'verified' });
    expect(await pickAddressPoolV2Address(database, 'US', true, {}, undefined, 'residential')).toBeUndefined();
    const calls = translate.mock.calls.length;
    await runTranslationBackfillBatch({ database, environment: {}, fetchImpl: translate, now });
    expect(translate).toHaveBeenCalledTimes(calls);
  });

  it.each(['retirement', 'source', 'dataset', 'evidence', 'native', 'china'])(
    'does not translate or restore ineligible %s records', async (fault) => {
    const queries = {
      retirement: "UPDATE address_pool SET retired_at='operator:retired'",
      source: 'UPDATE address_sources SET redistribution_allowed=0',
      dataset: "UPDATE address_datasets SET status='retired'",
      evidence: 'UPDATE address_pool_evidence SET is_current=0',
      native: "UPDATE address_pool SET latitude=0,longitude=0",
      china: "UPDATE address_pool SET country_code='CN'"
    };
    await database.exec(queries[fault]);
    expect((await runTranslationBackfillBatch({ database, environment: {}, fetchImpl: translate, now })).updated).toBe(0);
    expect(translate).not.toHaveBeenCalled();
    expect(await database.prepare('SELECT active FROM address_pool').first('active')).toBe(0);
  });

  it.each(['source', 'data'])('revalidates concurrent %s changes before publication', async (fault) => {
    const fetchImpl = async (url) => {
      await database.exec(fault === 'source' ? 'UPDATE address_sources SET redistribution_allowed=0'
        : "UPDATE address_pool SET street='Changed Street'");
      return translate(url);
    };
    expect((await runTranslationBackfillBatch({ database, environment: {}, fetchImpl, now })).updated).toBe(0);
    expect(await database.prepare('SELECT active FROM address_pool').first('active')).toBe(0);
  });

  it('persists finite repeated failure across worker invocations', async () => {
    await requireEnglish();
    const fetchImpl = vi.fn(async () => { throw new Error('fixture outage'); });
    for (let index = 0; index < 12; index += 1) {
      await runTranslationBackfillBatch({ database, environment: {}, fetchImpl,
        now: () => new Date(now().getTime() + index * 600_000) });
    }
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(await database.prepare('SELECT status,attempts FROM translation_recovery').first())
      .toMatchObject({ status: 'failed', attempts: 3 });
  });

  it('recovers an unchanged terminal translation from newly valid cache without resetting attempts or calling a provider', async () => {
    await requireEnglish();
    for (let index = 0; index < 3; index++) await runTranslationBackfillBatch({ database, environment: {}, fetchImpl: unusable,
      now: () => new Date(now().getTime() + index * 600_000) });
    expect(await database.prepare('SELECT status,attempts FROM translation_recovery').first()).toEqual({ status: 'failed', attempts: 3 });
    await cacheTranslations();
    await writeBackfillProgress(database, 'scan', { phase: 'all', cursor: 'zzzz' }, now());
    translate.mockClear();
    expect((await runTranslationBackfillBatch({ database, environment: {}, fetchImpl: translate, now })).updated).toBe(1);
    expect(translate).not.toHaveBeenCalled();
    expect(await database.prepare('SELECT status,attempts FROM translation_recovery').first()).toBeFalsy();
  });

  it('publishes cached translations when the translation soft deadline stops provider calls', async () => {
    await new PostgresTranslationCache(database).set(translations, 'zh-CN');
    const timeout = AbortSignal.timeout;
    const timeoutMock = vi.spyOn(AbortSignal, 'timeout')
      .mockImplementation((duration) => duration > 200_000 && duration <= 225_000 ? AbortSignal.abort() : timeout(duration));
    const result = await runTranslationBackfillBatch({ database, environment: {}, fetchImpl: translate, now });
    const deadlines = timeoutMock.mock.calls.filter(([duration]) => duration > 200_000 && duration <= 225_000);
    timeoutMock.mockRestore();
    expect(deadlines).toHaveLength(1);
    expect(result).toMatchObject({ updated: 1 });
    expect(result.interrupted).toBeUndefined();
    expect(translate).not.toHaveBeenCalled();
  });

  it('finishes publication in its own window when the batch deadline passes after translation', async () => {
    const controller = new AbortController();
    const timeout = AbortSignal.timeout;
    const timeoutMock = vi.spyOn(AbortSignal, 'timeout')
      .mockImplementation((duration) => duration === 300_000 ? controller.signal : timeout(duration));
    const transaction = database.transaction.bind(database);
    vi.spyOn(database, 'transaction').mockImplementationOnce(async (work) => {
      controller.abort();
      return transaction(work);
    });
    const result = await runTranslationBackfillBatch({ database, environment: {}, fetchImpl: translate, now });
    timeoutMock.mockRestore();
    expect(result.updated).toBe(1);
  });

  it.each(['cancelled', 'batch_timeout'])('resumes cache-only recovery directly after %s without a fourth provider attempt', async (reason) => {
    await requireEnglish();
    for (let index = 0; index < 3; index++) await runTranslationBackfillBatch({ database, environment: {}, fetchImpl: unusable,
      now: () => new Date(now().getTime() + index * 600_000) });
    await cacheTranslations();
    const controller = new AbortController();
    const timeout = AbortSignal.timeout;
    const timeoutMock = reason === 'batch_timeout' ? vi.spyOn(AbortSignal, 'timeout')
      .mockImplementation((duration) => duration === 300_000 ? controller.signal : timeout(duration)) : null;
    vi.spyOn(database, 'transaction').mockImplementationOnce(async () => {
      controller.abort();
      throw controller.signal.reason;
    });
    const interrupted = await runTranslationBackfillBatch({ database, environment: {}, fetchImpl: translate,
      now, ...(reason === 'cancelled' ? { signal: controller.signal } : {}) });
    expect(interrupted).toMatchObject({ updated: 0, interrupted: reason });
    expect(await database.prepare('SELECT status,attempts,reason FROM translation_recovery').first())
      .toEqual({ status: 'waiting', attempts: 3, reason });
    timeoutMock?.mockRestore();
    expect((await runTranslationBackfillBatch({ database, environment: {}, fetchImpl: translate,
      now: () => new Date(now().getTime() + 600_000) })).updated).toBe(1);
    expect(translate).not.toHaveBeenCalled();
    expect(await database.prepare('SELECT status,attempts FROM translation_recovery').first())
      .toBeFalsy();
  });

  it('uses unique localized administrative identities before requesting translations', async () => {
    await database.prepare('UPDATE catalog_regions SET zh_name=?').bind(chinese.admin1).run();
    await database.prepare('UPDATE catalog_cities SET zh_name=?').bind(chinese.locality).run();
    await new PostgresTranslationCache(database).set(new Map([[native.street, chinese.street]]), 'zh-CN');
    expect((await runTranslationBackfillBatch({ database, environment: {}, fetchImpl: translate, now })).updated).toBe(1);
    expect(translate).not.toHaveBeenCalled();
  });

  it('recovers an altered street number by translating text spans and preserving source numerals', async () => {
    const fetchImpl = vi.fn(async (url) => {
      const boundary = '\n[[[ADDRESS_COMPONENT_BOUNDARY]]]\n';
      const values = new URL(url).searchParams.get('q').split(boundary);
      return Response.json([[[values.map((value) => value === native.street ? '主街 22'
        : value.trim() === 'Main Street' ? '主街' : translations.get(value) || value).join(boundary)]]]);
    });
    expect((await runTranslationBackfillBatch({ database, environment: {}, fetchImpl, now })).updated).toBe(1);
    const variants = JSON.parse(await database.prepare('SELECT component_variants_json FROM address_pool').first('component_variants_json'));
    expect(variants['zh-CN'].street).toBe('主街 21');
    expect(variants.native.street).toBe(native.street);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])('recovers the Hong Kong parent without overwriting source facts (legacy district %s)', async (legacy) => {
    await applyAdministrativeCatalogOverrides(database);
    const source = { houseNumber: '', street: '觀塘道', locality: '觀塘區', postalLocality: '香港', admin1: '香港', postcode: '' };
    if (legacy) { source.admin1 = '觀塘區'; source.admin1Code = 'KKT'; }
    const variants = { native: source,
      en: { ...source, street: 'Kwun Tong Road', locality: 'Kwun Tong', postalLocality: 'Hong Kong', admin1: 'Hong Kong' },
      'zh-CN': { ...source, street: '观塘道', locality: '观塘区' } };
    await database.exec("UPDATE address_datasets SET country_code='HK'");
    await database.prepare(`UPDATE address_pool SET country_code='HK',admin1='Hong Kong',admin1_code='',locality='Kwun Tong',
      postal_locality='Hong Kong',street='觀塘道',latitude=22.31,longitude=114.22,native_language='zh-HK',component_variants_json=?,
      address_variants_json=?`).bind(JSON.stringify(variants), JSON.stringify({ native: '香港觀塘區觀塘道', en: '', 'zh-CN': '' })).run();
    if (legacy) await database.exec("UPDATE address_pool SET admin1='Kwun Tong',admin1_code='KKT'");
    expect((await runTranslationBackfillBatch({ database, environment: {}, fetchImpl: translate, now })).updated).toBe(1);
    expect(translate).not.toHaveBeenCalled();
    const raw = await database.prepare('SELECT admin1,locality,component_variants_json FROM address_pool').first();
    expect(raw).toMatchObject({ admin1: legacy ? 'Kwun Tong' : 'Hong Kong', locality: 'Kwun Tong' });
    expect(JSON.parse(raw.component_variants_json).native).toEqual(source);
    expect(await pickAddressPoolV2Address(database, 'HK', false, {}, undefined, 'derived-hk'))
      .toMatchObject({ components: { admin1: '九龍', locality: '觀塘區' } });
    await refreshStaleCoverage(database, now, { force: true });
    expect(await database.prepare("SELECT region_name,city_name,total_count FROM residential_coverage WHERE country_code='HK'").first())
      .toEqual({ region_name: 'Kowloon', city_name: 'Kwun Tong', total_count: 1 });
  }, 20_000);

  it('wakes a terminal record after a real service configuration change without waiting for a full pool rescan', async () => {
    await requireEnglish();
    for (let index = 0; index < 3; index += 1) {
      await runTranslationBackfillBatch({ database, environment: {}, fetchImpl: unusable,
        now: () => new Date(now().getTime() + index * 600_000) });
    }
    expect(await database.prepare('SELECT status,attempts FROM translation_recovery').first())
      .toEqual({ status: 'failed', attempts: 3 });
    await database.exec(`UPDATE translation_recovery SET service_revision='previous-service-configuration';
      UPDATE translation_backfill_progress SET value_json='{"phase":"all","cursor":"zzzz"}' WHERE key='scan'`);
    expect((await runTranslationBackfillBatch({ database, environment: {}, fetchImpl: translate,
      now: () => new Date(now().getTime() + 3_600_000) })).updated).toBe(1);
    expect(await database.prepare('SELECT status FROM translation_recovery').first('status')).toBeFalsy();
  });

  it.each([false, true])('reconciles a stale failed state for an already published record without another supplier request (changed config %s)', async (changed) => {
    expect((await runTranslationBackfillBatch({ database, environment: {}, fetchImpl: translate, now })).updated).toBe(1);
    await database.exec(`UPDATE translation_recovery SET status='failed',attempts=3,reason='retry_limit'
      ${changed ? ",service_revision='previous-service-configuration'" : ''};
      UPDATE translation_backfill_progress SET value_json='{"phase":"all","cursor":"${changed ? 'zzzz' : ''}"}' WHERE key='scan'`);
    translate.mockClear();
    await runTranslationBackfillBatch({ database, environment: {}, fetchImpl: translate, now });
    expect(await database.prepare('SELECT status,attempts FROM translation_recovery').first())
      .toBeFalsy();
    expect(translate).not.toHaveBeenCalled();
  });

  it('preserves untouched attempts when the batch deadline interrupts preparation', async () => {
    const deadline = new AbortController();
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((duration) => duration === 300_000 ? deadline.signal : timeout(duration));
    const query = database.query.bind(database);
    vi.spyOn(database, 'query').mockImplementation(async (sql, values) => {
      const result = await query(sql, values);
      if (sql.includes('INSERT INTO translation_recovery') && values[3] === 'pending') {
        deadline.abort(new DOMException('Fixture batch deadline', 'TimeoutError'));
      }
      return result;
    });
    let error;
    const result = await runTranslationBackfillBatch({ database, environment: {}, fetchImpl: translate, now })
      .catch((value) => { error = value; });
    expect(deadline.signal.aborted).toBe(true);
    expect(translate).not.toHaveBeenCalled();
    expect(error && { name: error.name, code: error.code }).toBeUndefined();
    expect(result).toMatchObject({ updated: 0, done: false });
    expect(await database.prepare('SELECT status,attempts FROM translation_recovery').first())
      .toMatchObject({ status: 'waiting', attempts: 0 });
    expect(await database.prepare('SELECT active FROM address_pool').first('active')).toBe(0);
  });

  it('automatically resumes a real provider cooldown without treating it as exhaustion', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 429 }));
    await runTranslationBackfillBatch({ database, environment: {}, fetchImpl, now });
    expect(await database.prepare('SELECT status FROM translation_recovery').first('status')).toBe('waiting');
    expect((await runTranslationBackfillBatch({ database, environment: {}, fetchImpl: translate,
      now: () => new Date(Date.now() + 3_600_000) })).updated).toBe(1);
  });

  it('does not charge a Google attempt when cancellation precedes dispatch', async () => {
    const controller = new AbortController();
    const query = database.query.bind(database);
    vi.spyOn(database, 'query').mockImplementation(async (sql, values) => {
      const result = await query(sql, values);
      if (sql.includes('INSERT INTO translation_backfill_progress') && values[0] === 'providers') controller.abort();
      return result;
    });
    await runTranslationBackfillBatch({ database, environment: {}, fetchImpl: translate, now, signal: controller.signal });
    expect(translate).not.toHaveBeenCalled();
    expect(await readBackfillProgress(database, 'providers')).toMatchObject({ googleFailures: 0 });
    expect(await database.prepare('SELECT status,attempts,reason FROM translation_recovery').first())
      .toMatchObject({ status: 'waiting', attempts: 0, reason: 'cancelled' });
  });

  it('persists a lost in-flight response and finite backoff on cancellation', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => { controller.abort(); throw controller.signal.reason; });
    const result = await runTranslationBackfillBatch({ database, environment: {}, fetchImpl, now, signal: controller.signal });
    expect(result).toMatchObject({ updated: 0, interrupted: 'cancelled' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await readBackfillProgress(database, 'providers')).toMatchObject({
      googleFailures: 1, googleRetryAt: '2026-09-08T16:01:00.000Z'
    });
    expect(await database.prepare('SELECT status,attempts,next_attempt_at FROM translation_recovery').first())
      .toEqual({ status: 'waiting', attempts: 1, next_attempt_at: '2026-09-08T16:01:00.000Z' });
    expect(await database.prepare('SELECT active FROM address_pool').first('active')).toBe(0);
    expect((await runTranslationBackfillBatch({ database, environment: {}, fetchImpl: translate,
      now: () => new Date(now().getTime() + 120_000) })).updated).toBe(1);
  });

  it('does not consume record retries during repeated rate-limit waits', async () => {
    await requireEnglish();
    const fetchImpl = vi.fn(async () => new Response('', { status: 429 }));
    for (let index = 0; index < 5; index += 1) {
      await runTranslationBackfillBatch({ database, environment: {}, fetchImpl,
        now: () => new Date(Date.now() + index * 600_000) });
    }
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(await readBackfillProgress(database, 'providers')).toMatchObject({ googleFailures: 0 });
    expect(await database.prepare('SELECT status,attempts FROM translation_recovery').first())
      .toEqual({ status: 'waiting', attempts: 0 });
  });

  it('counts real provider failures without charging untouched cooldown passes', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('fixture outage'); });
    await runTranslationBackfillBatch({ database, environment: {}, fetchImpl, now });
    expect(await database.prepare('SELECT status,attempts FROM translation_recovery').first())
      .toEqual({ status: 'waiting', attempts: 1 });
    await runTranslationBackfillBatch({ database, environment: {}, fetchImpl, now });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await database.prepare('SELECT attempts FROM translation_recovery').first('attempts')).toBe(1);
  });

  it('keeps waiting through a Google cooldown on the final attempt and translates after the reset', async () => {
    await requireEnglish();
    const outage = vi.fn(async () => { throw new Error('fixture outage'); });
    for (let index = 0; index < 3; index += 1) {
      await writeBackfillProgress(database, 'providers', { googleFailures: 0, googleRetryAt: null }, now());
      await runTranslationBackfillBatch({ database, environment: {}, fetchImpl: outage,
        now: () => new Date(now().getTime() + index * 600_000) });
    }
    expect(outage).toHaveBeenCalledTimes(3);
    expect(await database.prepare('SELECT status,attempts,reason FROM translation_recovery').first())
      .toEqual({ status: 'waiting', attempts: 2, reason: 'google_cooldown' });
    expect((await runTranslationBackfillBatch({ database, environment: {}, fetchImpl: translate,
      now: () => new Date(now().getTime() + 3_600_000) })).updated).toBe(1);
  });

  it('retries rows that earlier releases stored as terminal Google cooldown failures', async () => {
    await runTranslationBackfillBatch({ database, environment: {}, fetchImpl: vi.fn(async () => new Response('', { status: 429 })), now });
    await database.exec(`UPDATE translation_recovery SET status='failed',attempts=3,reason='google_cooldown',next_attempt_at=NULL`);
    await writeBackfillProgress(database, 'providers', { googleFailures: 0, googleRetryAt: null }, now());
    expect((await runTranslationBackfillBatch({ database, environment: {}, fetchImpl: translate,
      now: () => new Date(now().getTime() + 600_000) })).updated).toBe(1);
    expect(await database.prepare('SELECT status FROM translation_recovery').first('status')).toBeFalsy();
  });

  it('bounds repeated publication statement timeouts without spending cached provider requests', async () => {
    let failures = 0;
    vi.spyOn(database, 'transaction').mockImplementation(async () => {
      failures += 1;
      throw Object.assign(new Error('fixture statement timeout'), { code: '57014' });
    });
    for (let index = 0; index < 5; index += 1) {
      await runTranslationBackfillBatch({ database, environment: {}, fetchImpl: translate,
        now: () => new Date(now().getTime() + index * 600_000) });
    }
    expect(failures).toBe(3);
    expect(translate).toHaveBeenCalledTimes(1);
    expect(await database.prepare('SELECT status,attempts,reason FROM translation_recovery').first())
      .toEqual({ status: 'failed', attempts: 3, reason: 'publication_timeout' });
    expect(await database.prepare('SELECT active FROM address_pool').first('active')).toBe(0);
  });

  it.each([false, true])('preserves committed work and resumes deferred countries from cache with post-commit cancellation %s', async (cancel) => {
    const controller = new AbortController();
    if (cancel) {
      const transaction = database.transaction.bind(database);
      vi.spyOn(database, 'transaction').mockImplementation(async (work) => {
        const result = await transaction(work);
        controller.abort();
        return result;
      });
    }
    const canadian = { ...native, locality: 'Ottawa', admin1: 'Ontario', admin1Code: 'ON', postcode: 'K1P 1J1' };
    await database.exec(`INSERT INTO address_datasets(id,source_id,country_code,version,retrieved_at,imported_at,input_checksum,
      format,license_code,license_name,license_url,attribution_text,attribution_url,terms_url,share_alike,notice_required,
      redistribution_allowed,status)
      SELECT 'canada-dataset',source_id,'CA',version,retrieved_at,imported_at,input_checksum,format,license_code,license_name,
        license_url,attribution_text,attribution_url,terms_url,share_alike,notice_required,redistribution_allowed,status
      FROM address_datasets WHERE id='dataset'`);
    await database.prepare(`INSERT INTO address_pool(id,country_code,admin1,admin1_code,locality,street,house_number,postcode,
      latitude,longitude,native_language,component_variants_json,address_variants_json,property_type,quality_score,
      generation,coverage,random_key,active,first_seen_at,last_seen_at,retired_at,match_level)
      VALUES ('z-canada','CA','Ontario','ON','Ottawa','Main Street 21','','K1P 1J1',45.42,-75.69,'en',?,?,'unknown',.95,
        'v1','CA/ON',2,0,?,?,'publication-validation:fixture','street')`)
      .bind(JSON.stringify({ native: canadian, en: canadian, 'zh-CN': canadian }),
        JSON.stringify({ native: 'Main Street 21, Ottawa, Ontario', en: '', 'zh-CN': '' }), observedAt, observedAt).run();
    await database.exec(`INSERT INTO address_pool_evidence(id,address_id,dataset_id,source_record_id,
      observed_at,evidence_type,is_primary,is_current,created_at)
      VALUES ('canada-evidence','z-canada','canada-dataset','way/22','${observedAt}','address_existence',1,1,'${observedAt}')`);
    const fetchImpl = vi.fn(async (url) => {
      const response = await translate(url);
      return new Response((await response.text()).replaceAll('Ottawa', '\u6e25\u592a\u534e').replaceAll('Ontario', '\u5b89\u5927\u7565\u7701'),
        { headers: { 'Content-Type': 'application/json' } });
    });
    expect((await runTranslationBackfillBatch({ database, environment: {}, fetchImpl, now, signal: controller.signal })).updated)
      .toBe(cancel ? 1 : 2);
    if (cancel) {
      expect(await database.prepare("SELECT status,attempts,reason FROM translation_recovery WHERE address_id='z-canada'").first())
        .toEqual({ status: 'waiting', attempts: 1, reason: 'cancelled' });
      expect(await database.prepare("SELECT active FROM address_pool WHERE id='z-canada'").first('active')).toBe(0);
    }
    expect((await runTranslationBackfillBatch({ database, environment: {}, fetchImpl,
      now: () => new Date(now().getTime() + 120_000) })).updated).toBe(cancel ? 1 : 0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((await database.prepare('SELECT status FROM translation_recovery').all()).results)
      .toEqual([]);
    expect(await database.prepare('SELECT COUNT(*) AS total FROM address_generation_index WHERE active=1').first('total')).toBe(2);
  });

  it('publishes the country with the most ready rows first and defers the rest past the start deadline', async () => {
    const canadian = { ...native, locality: 'Ottawa', admin1: 'Ontario', admin1Code: 'ON', postcode: 'K1P 1J1' };
    await database.exec(`INSERT INTO address_datasets(id,source_id,country_code,version,retrieved_at,imported_at,input_checksum,
      format,license_code,license_name,license_url,attribution_text,attribution_url,terms_url,share_alike,notice_required,
      redistribution_allowed,status)
      SELECT 'canada-dataset',source_id,'CA',version,retrieved_at,imported_at,input_checksum,format,license_code,license_name,
        license_url,attribution_text,attribution_url,terms_url,share_alike,notice_required,redistribution_allowed,status
      FROM address_datasets WHERE id='dataset'`);
    for (const [id, longitude] of [['z-canada-a', -75.69], ['z-canada-b', -75.7]]) {
      await database.prepare(`INSERT INTO address_pool(id,country_code,admin1,admin1_code,locality,street,house_number,
        latitude,longitude,native_language,component_variants_json,address_variants_json,property_type,quality_score,
        generation,coverage,random_key,active,first_seen_at,last_seen_at,retired_at,match_level)
        VALUES (?,'CA','Ontario','ON','Ottawa','Main Street 21','',45.42,?,'en',?,?,'unknown',.95,
          'v1','CA/ON',2,0,?,?,'publication-validation:fixture','street')`)
        .bind(id, longitude, JSON.stringify({ native: canadian, en: canadian, 'zh-CN': canadian }),
          JSON.stringify({ native: 'Main Street 21, Ottawa, Ontario', en: '', 'zh-CN': '' }), observedAt, observedAt).run();
      await database.prepare(`INSERT INTO address_pool_evidence(id,address_id,dataset_id,source_record_id,
        observed_at,evidence_type,is_primary,is_current,created_at)
        VALUES (?,?,'canada-dataset',?,?,'address_existence',1,1,?)`).bind(`${id}-evidence`, id, `way/${id}`, observedAt, observedAt).run();
    }
    const fetchImpl = vi.fn(async (url) => {
      const response = await translate(url);
      return new Response((await response.text()).replaceAll('Ottawa', '渥太华').replaceAll('Ontario', '安大略省'),
        { headers: { 'Content-Type': 'application/json' } });
    });
    expireAfterFirstPublication();
    expect((await runTranslationBackfillBatch({ database, environment: {}, fetchImpl, now })).updated).toBe(2);
    expect(await database.prepare("SELECT reason FROM translation_recovery WHERE address_id='street-fixture'").first('reason'))
      .toBe('publication_deferred');
  });

  it('publishes every ready country in one batch before the start deadline', async () => {
    const canadian = { ...native, locality: 'Ottawa', admin1: 'Ontario', admin1Code: 'ON', postcode: 'K1P 1J1' };
    await database.exec(`INSERT INTO address_datasets(id,source_id,country_code,version,retrieved_at,imported_at,input_checksum,
      format,license_code,license_name,license_url,attribution_text,attribution_url,terms_url,share_alike,notice_required,
      redistribution_allowed,status)
      SELECT 'canada-dataset',source_id,'CA',version,retrieved_at,imported_at,input_checksum,format,license_code,license_name,
        license_url,attribution_text,attribution_url,terms_url,share_alike,notice_required,redistribution_allowed,status
      FROM address_datasets WHERE id='dataset'`);
    await database.prepare(`INSERT INTO address_pool(id,country_code,admin1,admin1_code,locality,street,house_number,postcode,
      latitude,longitude,native_language,component_variants_json,address_variants_json,property_type,quality_score,
      generation,coverage,random_key,active,first_seen_at,last_seen_at,retired_at,match_level)
      VALUES ('z-canada','CA','Ontario','ON','Ottawa','Main Street 21','','K1P 1J1',45.42,-75.69,'en',?,?,'unknown',.95,
        'v1','CA/ON',2,0,?,?,'publication-validation:fixture','street')`)
      .bind(JSON.stringify({ native: canadian, en: canadian, 'zh-CN': canadian }),
        JSON.stringify({ native: 'Main Street 21, Ottawa, Ontario', en: '', 'zh-CN': '' }), observedAt, observedAt).run();
    await database.exec(`INSERT INTO address_pool_evidence(id,address_id,dataset_id,source_record_id,
      observed_at,evidence_type,is_primary,is_current,created_at)
      VALUES ('canada-evidence','z-canada','canada-dataset','way/22','${observedAt}','address_existence',1,1,'${observedAt}')`);
    const fetchImpl = vi.fn(async (url) => {
      const response = await translate(url);
      return new Response((await response.text()).replaceAll('Ottawa', '渥太华').replaceAll('Ontario', '安大略省'),
        { headers: { 'Content-Type': 'application/json' } });
    });
    expect((await runTranslationBackfillBatch({ database, environment: {}, fetchImpl, now })).updated).toBe(2);
    expect((await database.prepare('SELECT status FROM translation_recovery ORDER BY address_id').all()).results)
      .toEqual([]);
  });

  it('publishes countries still below their target before countries that already met it', async () => {
    const canadian = { ...native, locality: 'Ottawa', admin1: 'Ontario', admin1Code: 'ON', postcode: 'K1P 1J1' };
    await database.exec(`INSERT INTO address_datasets(id,source_id,country_code,version,retrieved_at,imported_at,input_checksum,
      format,license_code,license_name,license_url,attribution_text,attribution_url,terms_url,share_alike,notice_required,
      redistribution_allowed,status)
      SELECT 'canada-dataset',source_id,'CA',version,retrieved_at,imported_at,input_checksum,format,license_code,license_name,
        license_url,attribution_text,attribution_url,terms_url,share_alike,notice_required,redistribution_allowed,status
      FROM address_datasets WHERE id='dataset'`);
    await database.prepare(`INSERT INTO address_pool(id,country_code,admin1,admin1_code,locality,street,house_number,postcode,
      latitude,longitude,native_language,component_variants_json,address_variants_json,property_type,quality_score,
      generation,coverage,random_key,active,first_seen_at,last_seen_at,retired_at,match_level)
      VALUES ('z-canada','CA','Ontario','ON','Ottawa','Main Street 21','','K1P 1J1',45.42,-75.69,'en',?,?,'unknown',.95,
        'v1','CA/ON',2,0,?,?,'publication-validation:fixture','street')`)
      .bind(JSON.stringify({ native: canadian, en: canadian, 'zh-CN': canadian }),
        JSON.stringify({ native: 'Main Street 21, Ottawa, Ontario', en: '', 'zh-CN': '' }), observedAt, observedAt).run();
    await database.exec(`INSERT INTO address_pool_evidence(id,address_id,dataset_id,source_record_id,
      observed_at,evidence_type,is_primary,is_current,created_at)
      VALUES ('canada-evidence','z-canada','canada-dataset','way/22','${observedAt}','address_existence',1,1,'${observedAt}')`);
    await database.exec(`INSERT INTO sync_country_policies(country_code,enabled,target_count,level1_limit,level2_limit,
        level3_limit,level4_limit,updated_at)
      VALUES ('CA',1,100,0,0,0,0,'${observedAt}'),('US',1,1,0,0,0,0,'${observedAt}')
      ON CONFLICT (country_code) DO UPDATE SET enabled=excluded.enabled,target_count=excluded.target_count`);
    await database.exec(`INSERT INTO sync_country_state(country_code,status,address_count,updated_at)
      VALUES ('CA','ready',0,'${observedAt}'),('US','ready',5,'${observedAt}')
      ON CONFLICT (country_code) DO UPDATE SET address_count=excluded.address_count`);
    const fetchImpl = vi.fn(async (url) => {
      const response = await translate(url);
      return new Response((await response.text()).replaceAll('Ottawa', '渥太华').replaceAll('Ontario', '安大略省'),
        { headers: { 'Content-Type': 'application/json' } });
    });
    expireAfterFirstPublication();
    expect((await runTranslationBackfillBatch({ database, environment: {}, fetchImpl, now })).updated).toBe(1);
    expect(await database.prepare("SELECT active FROM address_pool WHERE id='z-canada'").first('active')).toBe(1);
    expect(await database.prepare("SELECT address_count FROM sync_country_state WHERE country_code='CA'").first('address_count')).toBe(1);
    expect(await database.prepare("SELECT reason FROM translation_recovery WHERE address_id='street-fixture'").first('reason'))
      .toBe('publication_deferred');
  });

  it('waits on an occupied publication lock and retries cached results without charging attempts', async () => {
    vi.spyOn(database, 'transaction').mockRejectedValueOnce(Object.assign(new Error('fixture lock busy'), { code: '55P03' }));
    expect((await runTranslationBackfillBatch({ database, environment: {}, fetchImpl: translate, now })).updated).toBe(0);
    expect(await database.prepare('SELECT status,attempts,reason FROM translation_recovery').first())
      .toEqual({ status: 'waiting', attempts: 0, reason: 'publication_busy' });
    expect((await runTranslationBackfillBatch({ database, environment: {}, fetchImpl: translate,
      now: () => new Date(now().getTime() + 120_000) })).updated).toBe(1);
    expect(translate).toHaveBeenCalledTimes(1);
  });

  it('runs while source synchronization is busy and waits for cancellation on shutdown', async () => {
    let tick;
    const stop = startTranslationBackfill({ database, workerPool: database.pool, environment: {}, fetchImpl: translate, now, isBusy: () => true,
      setTimer: (callback) => { tick = callback; return { unref() {} }; } });
    await tick();
    await stop();
    expect(await database.prepare('SELECT active FROM address_pool').first('active')).toBe(1);
  });

  it('enforces the separate daily Youdao character ceiling, including lost responses', async () => {
    const control = new ControlStore(database, Buffer.alloc(32, 23));
    await control.addCredential({ provider: 'youdao', label: 'Fixture',
      secret: JSON.stringify({ appKey: 'fixture-key', appSecret: 'fixture-secret' }), qpsLimit: 1, quotaLimit: 100000 });
    const brokerClient = { availability: async () => ({ youdao: { available: true, revision: 'fixture' } }),
      request: vi.fn(async () => { throw new Error('lost response'); }) };
    const environment = { TRANSLATION_BACKFILL_YOUDAO_DAILY_CHARACTERS: '5' };
    for (let index = 0; index < 3; index += 1) {
      const services = await createBackfillProviders({ database, environment, fetchImpl: translate,
        now, brokerClient, signal: new AbortController().signal });
      await services.providers.youdao(['Road'], 'zh-CN');
    }
    expect(brokerClient.request).toHaveBeenCalledTimes(1);
    expect(brokerClient.request.mock.calls[0][2].maxDispatches).toBe(1);
    expect(await database.prepare('SELECT reserved_characters FROM translation_backfill_usage').first('reserved_characters')).toBe(4);
    const services = await createBackfillProviders({ database, environment, fetchImpl: translate,
      now: () => new Date(now().getTime() + 86_400_000), brokerClient, signal: new AbortController().signal });
    await services.providers.youdao(['Road'], 'zh-CN');
    expect(brokerClient.request).toHaveBeenCalledTimes(2);
  });
});
