import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const cacheDirectory = resolve('.data-cache');
const readyDatabaseFile = join(cacheDirectory, `production-readiness-${process.pid}.sqlite`);
const incompleteDatabaseFile = join(cacheDirectory, `production-readiness-incomplete-${process.pid}.sqlite`);
const nonResidentialDatabaseFile = join(cacheDirectory, `production-readiness-non-residential-${process.pid}.sqlite`);
const failedDatabaseFile = join(cacheDirectory, `production-readiness-failed-${process.pid}.sqlite`);
const brokenDatabaseFile = join(cacheDirectory, `production-readiness-broken-${process.pid}.sqlite`);
const missingDatabaseFile = join(cacheDirectory, `production-readiness-missing-${process.pid}.sqlite`);
const files = [readyDatabaseFile, incompleteDatabaseFile, nonResidentialDatabaseFile, failedDatabaseFile, brokenDatabaseFile, missingDatabaseFile];
const now = '2026-07-16T00:00:00Z';

const insertCountry = (database, country) => {
  const datasetId = `dataset-${country}`;
  const addressId = `address-${country}`;
  const component = { street: 'Main Street', houseNumber: '1', locality: 'Example' };
  database.prepare(`INSERT INTO address_datasets (
    id, source_id, country_code, version, retrieved_at, imported_at, input_checksum, format,
    license_code, license_name, license_url, attribution_text, attribution_url, terms_url,
    share_alike, notice_required, redistribution_allowed, accepted_count, active_count, status
  ) VALUES (?, 'source', ?, '1', ?, ?, ?, 'parquet', 'CC0-1.0', 'CC0',
    'https://example.test/license', 'Fixture', 'https://example.test', 'https://example.test/terms',
    0, 0, 1, 1, 1, 'active')`).run(datasetId, country, now, now, country.toLowerCase().repeat(32));
  database.prepare(`INSERT INTO address_pool (
    id, country_code, locality, street, house_number, latitude, longitude, native_language,
    component_variants_json, address_variants_json, property_type, quality_score, generation,
    coverage, random_key, first_seen_at, last_seen_at
  ) VALUES (?, ?, 'Example', 'Main Street', '1', 1, 1, 'en', ?, ?, 'residential', 0.95,
    'initial', ?, 1, ?, ?)`).run(
    addressId,
    country,
    JSON.stringify({ native: component, en: component, 'zh-CN': component }),
    JSON.stringify({ native: '1 Main Street', en: '1 Main Street', 'zh-CN': 'Main Street 1' }),
    `pool:${country}:example:residential`,
    now,
    now
  );
  const evidence = database.prepare(`INSERT INTO address_pool_evidence (
    id, address_id, dataset_id, source_record_id, observed_at, evidence_type, is_primary, is_current, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`);
  evidence.run(`existence-${country}`, addressId, datasetId, `record-${country}`, now, 'address_existence', 1, now);
  evidence.run(`residential-${country}`, addressId, datasetId, `record-${country}`, now, 'residential_use', 0, now);
  database.prepare(`INSERT INTO sync_country_state (
    country_code, status, last_success_at, next_sync_at, active_dataset_id,
    address_count, residential_count, updated_at
  ) VALUES (?, 'ready', ?, '2026-08-15T00:00:00Z', ?, 1, 1, ?)`).run(country, now, datasetId, now);
};

const createDatabase = (file, countries) => {
  const database = new DatabaseSync(file);
  database.exec(readFileSync('server/database/schema.sql', 'utf8'));
  database.prepare(`INSERT INTO address_sources (
    id, name, homepage_url, data_url, license_code, license_name, license_url, attribution_text,
    attribution_url, terms_url, share_alike, notice_required, redistribution_allowed,
    metadata_json, created_at, updated_at
  ) VALUES ('source', 'Fixture', 'https://example.test', 'https://example.test/data',
    'CC0-1.0', 'CC0', 'https://example.test/license', 'Fixture', 'https://example.test',
    'https://example.test/terms', 0, 0, 1, '{}', ?, ?)`).run(now, now);
  for (const country of countries) insertCountry(database, country);
  database.close();
};

beforeAll(() => {
  mkdirSync(cacheDirectory, { recursive: true });
  createDatabase(readyDatabaseFile, ['US', 'JP']);
  createDatabase(incompleteDatabaseFile, ['US']);
  createDatabase(nonResidentialDatabaseFile, ['US']);
  const nonResidential = new DatabaseSync(nonResidentialDatabaseFile);
  nonResidential.prepare("DELETE FROM address_pool_evidence WHERE evidence_type='residential_use'").run();
  nonResidential.prepare("UPDATE sync_country_state SET residential_count=0").run();
  nonResidential.close();
  createDatabase(failedDatabaseFile, ['US']);
  const failed = new DatabaseSync(failedDatabaseFile);
  failed.prepare("UPDATE sync_country_state SET status='failed', failure_count=2, last_error='fixture'").run();
  failed.close();
  const broken = new DatabaseSync(brokenDatabaseFile);
  broken.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);');
  broken.close();
});

afterAll(() => {
  for (const file of files) if (existsSync(file)) rmSync(file);
});

const run = (database, countries) => {
  const result = spawnSync(process.execPath, [
    'scripts/check-production-readiness.mjs', '--database', database, '--countries', countries
  ], { cwd: resolve('.'), encoding: 'utf8' });
  return { ...result, report: result.stdout ? JSON.parse(result.stdout) : undefined };
};

describe('self-hosted SQLite production readiness', () => {
  it('passes when integrity, schema, sync state and active country data are present', () => {
    const result = run(readyDatabaseFile, 'US,JP');

    expect(result.status).toBe(0);
    expect(result.report).toMatchObject({
      status: 'ready', schemaVersion: 1, hardLimitBytes: 45 * 1024 ** 3, errors: [],
      countries: [
        { country: 'US', total: 1, residential: 1, syncStatus: 'ready', failureCount: 0 },
        { country: 'JP', total: 1, residential: 1, syncStatus: 'ready', failureCount: 0 }
      ]
    });
    expect(result.report.storageBytes).toBeGreaterThan(0);
    expect(result.report.storageBytes).toBeLessThan(result.report.hardLimitBytes);
  });

  it('reports a country with no active synchronized addresses', () => {
    const result = run(incompleteDatabaseFile, 'US,JP');

    expect(result.status).toBe(1);
    expect(result.report.status).toBe('degraded');
    expect(result.report.errors).toContain('JP has no active addresses');
    expect(result.report.countries.find(({ country }) => country === 'JP')).toMatchObject({
      total: 0, residential: 0, syncStatus: 'pending'
    });
  });

  it('reports a country without residential evidence', () => {
    const result = run(nonResidentialDatabaseFile, 'US');

    expect(result.status).toBe(1);
    expect(result.report.status).toBe('degraded');
    expect(result.report.errors).toContain('US has no active residential addresses');
  });

  it('reports a failed country synchronization even when the previous pool remains available', () => {
    const result = run(failedDatabaseFile, 'US');

    expect(result.status).toBe(1);
    expect(result.report.status).toBe('degraded');
    expect(result.report.errors).toEqual(expect.arrayContaining([
      'US sync status is failed',
      'US has 2 synchronization failures'
    ]));
  });

  it('reports missing unified schema tables instead of accepting a summary-only database', () => {
    const result = run(brokenDatabaseFile, 'US');

    expect(result.status).toBe(1);
    expect(result.report.status).toBe('degraded');
    expect(result.report.errors).toEqual(expect.arrayContaining([
      'required table address_pool is missing',
      'required table sync_country_state is missing',
      'required table sync_jobs is missing'
    ]));
  });

  it('returns a structured degraded report when the database has not been initialized', () => {
    const result = run(missingDatabaseFile, 'US');

    expect(result.status).toBe(1);
    expect(result.report).toMatchObject({
      status: 'degraded', storageBytes: 0, countries: [], errors: ['database file does not exist']
    });
  });

  it('rejects countries outside the project registry', () => {
    const result = run(readyDatabaseFile, 'ZZ');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unsupported country code');
  });
});
