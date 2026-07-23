import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initializeSqliteDatabase, openDatabase } from '../server/database/sqlite.mjs';

describe('SQLite database adapter', () => {
  let database;

  beforeEach(async () => {
    database = openDatabase(':memory:');
    await initializeSqliteDatabase(database);
  });

  afterEach(() => database.close());

  it('supports prepare, bind, run, first, all and raw', async () => {
    const write = await database.prepare('INSERT INTO translation_cache VALUES (?, ?, ?, ?)')
      .bind('key', 'zh-CN', '{"street":"Test"}', '2026-07-16T00:00:00Z').run();
    expect(write.meta.changes).toBe(1);

    expect(await database.prepare('SELECT value FROM translation_cache WHERE cache_key = ?')
      .bind('key').first('value')).toBe('{"street":"Test"}');
    expect((await database.prepare('SELECT target_language FROM translation_cache').all()).results)
      .toEqual([{ target_language: 'zh-CN' }]);
    expect(await database.prepare('SELECT cache_key, target_language FROM translation_cache').raw({ columnNames: true }))
      .toEqual([['cache_key', 'target_language'], ['key', 'zh-CN']]);
  });

  it('rolls back every statement when a batch member fails', async () => {
    const first = database.prepare('INSERT INTO translation_cache VALUES (?, ?, ?, ?)')
      .bind('key', 'en', '{}', '2026-07-16T00:00:00Z');
    const duplicate = database.prepare('INSERT INTO translation_cache VALUES (?, ?, ?, ?)')
      .bind('key', 'en', '{}', '2026-07-16T00:00:00Z');

    await expect(database.batch([first, duplicate])).rejects.toThrow();
    expect(await database.prepare('SELECT COUNT(*) AS total FROM translation_cache').first('total')).toBe(0);
  });

  it('uses the coverage index for publication counts', async () => {
    const plan = await database.prepare(`EXPLAIN QUERY PLAN UPDATE pool_coverage SET
      active_count=(SELECT COUNT(*) FROM address_pool WHERE address_pool.coverage=pool_coverage.coverage_key AND address_pool.active=1),
      residential_count=(SELECT COUNT(*) FROM address_pool WHERE address_pool.coverage=pool_coverage.coverage_key
        AND address_pool.active=1 AND address_pool.property_type IN ('residential','apartment'))
      WHERE country_code=?`).bind('DE').all();
    const details = plan.results.map(({ detail }) => detail).join('\n');
    expect(details).toContain('USING COVERING INDEX idx_address_pool_coverage');
    expect(details).not.toMatch(/SCAN address_pool/u);
  });

  it('uses the partial residential index without sorting the random selection', async () => {
    const plan = await database.prepare(`EXPLAIN QUERY PLAN SELECT id FROM address_pool
      WHERE country_code=? AND active=1 AND quality_score>=0.7
        AND property_type IN ('residential','apartment') AND random_key>=?
      ORDER BY random_key,id LIMIT 16`).bind('DE', 1_000_000_000).all();
    const details = plan.results.map(({ detail }) => detail).join('\n');

    expect(details).toContain('USING INDEX idx_address_pool_residential_random');
    expect(details).not.toContain('USE TEMP B-TREE FOR ORDER BY');
  });

  it('keeps runtime evidence and the RTree coordinate index queryable', async () => {
    const now = '2026-07-16T00:00:00Z';
    await database.prepare(`INSERT INTO address_sources VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      'source', 'Source', 'https://example.com', 'https://example.com/data', 'ODbL-1.0', 'ODbL',
      'https://example.com/license', 'Source attribution', 'https://example.com/attribution',
      'https://example.com/terms', 1, 1, 1, '{}', now, now
    ).run();
    await database.prepare(`INSERT INTO address_datasets (
      id, source_id, country_code, version, published_at, retrieved_at, imported_at, input_checksum, format,
      license_code, license_name, license_url, attribution_text, attribution_url, terms_url,
      share_alike, notice_required, redistribution_allowed, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      'dataset', 'source', 'HK', '1', now, now, now, 'a'.repeat(64), 'parquet', 'ODbL-1.0', 'ODbL',
      'https://example.com/license', 'Source attribution', 'https://example.com/attribution',
      'https://example.com/terms', 1, 1, 1, 'active'
    ).run();
    await database.prepare(`INSERT INTO address_pool (
      id, country_code, locality, street, house_number, latitude, longitude, native_language,
      component_variants_json, address_variants_json, property_type, quality_score, generation,
      coverage, random_key, first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      'address', 'HK', 'Wan Chai', 'Queen\'s Road East', '1', 22.276, 114.175, 'zh-TW', '{}', '{}',
      'residential', 0.95, 'generation-1', 'HK:wan-chai', 1, now, now
    ).run();
    await database.prepare(`INSERT INTO address_pool_evidence VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      'evidence', 'address', 'dataset', 'record', '', now, 'address_existence', 1, 1, now
    ).run();

    expect(await database.prepare('SELECT COUNT(*) AS total FROM address_pool_runtime').first('total')).toBe(1);
    expect(await database.prepare(`SELECT COUNT(*) AS total FROM address_pool address
      JOIN address_coordinate_index coordinate ON coordinate.address_rowid = address.rowid
      WHERE coordinate.min_latitude BETWEEN ? AND ? AND coordinate.min_longitude BETWEEN ? AND ?`)
      .bind(22, 23, 114, 115).first('total')).toBe(1);
  });
});
