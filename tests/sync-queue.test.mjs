import { readdirSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initializeTestDatabase, openTestDatabase } from './helpers/postgres-test-database.mjs';
import { createSyncApi } from '../server/sync/api.mjs';
import { loadSourceCatalog, sourceAdapterRevisions } from '../server/sync/source-adapters.mjs';
import { CHINA_PRIORITY_TARGET } from '../server/sync/address-policy.mjs';
import {
  computeQueueSnapshot, countryFingerprint, createQueueSources, createSyncQueue, evaluateAttempt,
  estimateDuration, executionFailureFingerprint, legacyCountryFingerprint, nextQuotaResetTime, nextWakeAt, orderRunnable,
  PostgresQueueStateStore, QueueStateStore, sourceCapabilityRevision
} from '../server/sync/queue.mjs';

const directories = [];
const stateDir = () => {
  const directory = resolve('.data-cache', 'sync-queue-tests', randomUUID());
  directories.push(directory);
  return directory;
};
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const iso = (value) => new Date(value).toISOString();

describe('queue ordering', () => {
  it('puts quota-bound countries with an open window first, then largest deficit', () => {
    const ordered = orderRunnable([
      { countryCode: 'TH', deficit: 8590, quotaBound: false },
      { countryCode: 'KR', deficit: 442, quotaBound: true, quotaAvailable: true, quotaResetAt: '2026-08-03T00:03:00Z' },
      { countryCode: 'VN', deficit: 9874, quotaBound: false },
      { countryCode: 'IN', deficit: 18475, quotaBound: false }
    ]);
    expect(ordered.map((entry) => entry.countryCode)).toEqual(['KR', 'IN', 'VN', 'TH']);
  });

  it('orders multiple quota-bound countries by earliest upcoming reset', () => {
    const ordered = orderRunnable([
      { countryCode: 'AA', deficit: 1, quotaBound: true, quotaAvailable: true, quotaResetAt: '2026-08-03T12:00:00Z' },
      { countryCode: 'BB', deficit: 900, quotaBound: true, quotaAvailable: true, quotaResetAt: '2026-08-03T00:00:00Z' }
    ]);
    expect(ordered.map((entry) => entry.countryCode)).toEqual(['BB', 'AA']);
  });

  it('rotates unmetered work to a country that has not run recently', () => {
    const ordered = orderRunnable([
      { countryCode: 'US', deficit: 40_000, lastDispatchedAt: '2026-08-05T05:00:00Z' },
      { countryCode: 'ZA', deficit: 100, lastDispatchedAt: null }
    ]);
    expect(ordered.map((entry) => entry.countryCode)).toEqual(['ZA', 'US']);
  });
});

describe('duration estimates', () => {
  it('requires three clean samples and reports median and p80', () => {
    expect(estimateDuration([30_000, 60_000])).toBeNull();
    expect(estimateDuration([30_000, 60_000, 90_000, 120_000, 150_000])).toEqual({
      sampleCount: 5, medianMs: 90_000, p80Ms: 120_000
    });
  });

  it('builds ETA samples only from exact single-source runs', async () => {
    const database = openTestDatabase();
    await initializeTestDatabase(database, new URL('../server/control/schema.sql', import.meta.url));
    await database.prepare(`INSERT INTO sync_country_policies(
      country_code,enabled,target_count,level1_limit,level2_limit,level3_limit,level4_limit,updated_at
    ) VALUES ('US',1,100,0,0,0,0,'2026-08-01T00:00:00Z')`).run();
    const samples = [10, 20, 30];
    for (const [index, minutes] of samples.entries()) {
      const id = `exact-${index}`;
      const completedAt = new Date(Date.UTC(2026, 7, 5, 0, minutes)).toISOString();
      await database.prepare(`INSERT INTO sync_runs(
        id,kind,target_json,status,progress_json,created_at,started_at,completed_at,updated_at
      ) VALUES (?,'address-pool',?,'succeeded','{}','2026-08-05T00:00:00Z','2026-08-05T00:00:00Z',?,?)`)
        .bind(id, JSON.stringify({ shards: ['oa-us'] }), completedAt, completedAt).run();
      await database.prepare(`INSERT INTO sync_run_countries(
        run_id,country_code,source_id,trigger_name,status,started_at,completed_at,created_at,updated_at
      ) VALUES (?,'US','oa-us','queue','succeeded','2026-08-05T00:00:00Z',?,'2026-08-05T00:00:00Z',?)`)
        .bind(id, completedAt, completedAt).run();
    }
    await database.prepare(`INSERT INTO sync_runs(
      id,kind,target_json,status,progress_json,created_at,started_at,completed_at,updated_at
    ) VALUES ('legacy-all','address-pool','{"shards":["all"]}','failed','{}','2026-08-04T00:00:00Z',
      '2026-08-04T00:00:00Z','2026-08-04T12:00:00Z','2026-08-04T12:00:00Z')`).run();
    await database.prepare(`INSERT INTO sync_run_countries(
      run_id,country_code,source_id,trigger_name,status,started_at,completed_at,created_at,updated_at
    ) VALUES ('legacy-all','US','oa-us','startup','failed','2026-08-04T00:00:00Z','2026-08-04T12:00:00Z',
      '2026-08-04T00:00:00Z','2026-08-04T12:00:00Z')`).run();
    await database.prepare(`INSERT INTO sync_runs(
      id,kind,target_json,status,progress_json,created_at,started_at,completed_at,updated_at
    ) VALUES ('exact-failed','address-pool','{"shards":["oa-us"]}','failed','{}','2026-08-03T00:00:00Z',
      '2026-08-03T00:00:00Z','2026-08-03T12:00:00Z','2026-08-03T12:00:00Z')`).run();
    await database.prepare(`INSERT INTO sync_run_countries(
      run_id,country_code,source_id,trigger_name,status,started_at,completed_at,created_at,updated_at
    ) VALUES ('exact-failed','US','oa-us','queue','failed','2026-08-03T00:00:00Z','2026-08-03T12:00:00Z',
      '2026-08-03T00:00:00Z','2026-08-03T12:00:00Z')`).run();
    const facts = await createQueueSources({ addressDatabase: database, controlDatabase: database }).addressFacts();
    expect(facts.durationSamples.sources['oa-us']).toEqual([30 * 60_000, 20 * 60_000, 10 * 60_000]);
    database.close();
  });
});

describe('attempt evaluation and latching', () => {
  const base = {
    fingerprintBefore: 'fp-1',
    fingerprintAfter: 'fp-1',
    completedAt: '2026-08-02T10:00:00.000Z'
  };

  it('latches a fruitless successful run as source_limited_cache', () => {
    const result = evaluateAttempt({ ...base, jobSucceeded: true, netGrowth: 0 });
    expect(result).toMatchObject({ action: 'latch', reason: 'source_limited_cache', fingerprint: 'fp-1' });
  });

  it('keeps running when the total is capped but administrative goals improve', () => {
    const result = evaluateAttempt({ ...base, jobSucceeded: true, netGrowth: 0,
      goalDeficitBefore: 25, goalDeficitAfter: 23 });
    expect(result.action).toBe('checked');
  });

  it('reruns a growing source soon only when its per-run growth step capped the import', () => {
    const capped = evaluateAttempt({ ...base, jobSucceeded: true, netGrowth: 50_000, growthCapped: true, probeIntervalMs: 30 * 86_400_000 });
    const finished = evaluateAttempt({ ...base, jobSucceeded: true, netGrowth: 50_000, probeIntervalMs: 30 * 86_400_000 });
    expect(capped).toMatchObject({ action: 'checked', reason: 'source_growth_step', nextAttemptAt: '2026-08-02T10:01:00.000Z' });
    expect(finished).toMatchObject({ action: 'checked', reason: 'source_version_checked', nextAttemptAt: '2026-09-01T10:00:00.000Z' });
  });

  it('continues a successful checkpointed source until its full scan is complete', () => {
    const result = evaluateAttempt({
      ...base,
      jobSucceeded: true,
      netGrowth: 25,
      sourceComplete: false
    });
    expect(result).toMatchObject({
      action: 'checked', reason: 'source_partial_checkpoint', fingerprint: 'fp-1', consecutiveFailures: 0
    });
  });

  it('retries a request-budget checkpoint without treating it as source exhaustion', () => {
    const result = evaluateAttempt({
      ...base,
      jobSucceeded: true,
      netGrowth: 10,
      sourceComplete: false,
      checkpointToken: 'checkpoint-budget-2',
      previousCheckpointToken: 'checkpoint-budget-1',
      checkpointStage: 'request_budget'
    });
    expect(result).toMatchObject({ action: 'checked', reason: 'source_partial_checkpoint' });
    expect(result.nextAttemptAt).toBe(iso(Date.parse(base.completedAt) + 60_000));
  });

  it('continues when a partial checkpoint advances and suspends after three identical checkpoints', () => {
    const progressed = evaluateAttempt({
      ...base, jobSucceeded: true, netGrowth: 0, sourceComplete: false,
      checkpointToken: 'checkpoint-2', previousCheckpointToken: 'checkpoint-1', partialStalls: 2
    });
    expect(progressed).toMatchObject({
      action: 'checked', reason: 'source_partial_checkpoint', checkpointToken: 'checkpoint-2', consecutiveFailures: 0
    });
    expect(progressed.nextAttemptAt).toBe(iso(Date.parse(base.completedAt) + 60_000));

    const first = evaluateAttempt({
      ...base, jobSucceeded: true, netGrowth: 0, sourceComplete: false,
      checkpointToken: 'checkpoint-2', previousCheckpointToken: 'checkpoint-2', partialStalls: 0
    });
    expect(first).toMatchObject({ action: 'checked', consecutiveFailures: 1 });
    expect(first.nextAttemptAt).toBe(iso(Date.parse(base.completedAt) + 5 * 60_000));
    const second = evaluateAttempt({
      ...base, jobSucceeded: true, netGrowth: 0, sourceComplete: false,
      checkpointToken: 'checkpoint-2', previousCheckpointToken: 'checkpoint-2', partialStalls: 1
    });
    expect(second).toMatchObject({ action: 'checked', consecutiveFailures: 2 });
    expect(second.nextAttemptAt).toBe(iso(Date.parse(base.completedAt) + 10 * 60_000));
    const third = evaluateAttempt({
      ...base, jobSucceeded: true, netGrowth: 0, sourceComplete: false,
      checkpointToken: 'checkpoint-2', previousCheckpointToken: 'checkpoint-2', partialStalls: 2
    });
    expect(third).toMatchObject({
      action: 'suspend', reason: 'source_partial_stalled', failureCode: 'SOURCE_PARTIAL_STALLED',
      checkpointToken: 'checkpoint-2', consecutiveFailures: 3
    });
  });

  it('latches a checkpointed source after three evaluated batches make no publish or goal progress', () => {
    const attempt = (partialStalls) => evaluateAttempt({
      ...base,
      jobSucceeded: true,
      netGrowth: 0,
      sourceComplete: false,
      checkpointToken: `checkpoint-${partialStalls + 2}`,
      previousCheckpointToken: `checkpoint-${partialStalls + 1}`,
      partialStalls,
      partialWorkCount: 25,
      partialProgressEvaluationReady: true,
      maxPartialStalls: 3
    });
    expect(attempt(0)).toMatchObject({
      action: 'checked', reason: 'source_partial_checkpoint', consecutiveFailures: 1
    });
    expect(attempt(1)).toMatchObject({ action: 'checked', consecutiveFailures: 2 });
    expect(attempt(2)).toMatchObject({
      action: 'latch', reason: 'source_limited_cache', checkpointToken: 'checkpoint-4', consecutiveFailures: 3
    });
  });

  it('does not classify a quota-only partial resume as source exhaustion', () => {
    const result = evaluateAttempt({
      ...base,
      jobSucceeded: true,
      netGrowth: 0,
      sourceComplete: false,
      checkpointToken: 'checkpoint-2',
      previousCheckpointToken: 'checkpoint-2',
      checkpointStage: 'credential',
      partialStalls: 2,
      partialWorkCount: 0,
      partialProgressEvaluationReady: true
    });
    expect(result).toMatchObject({ action: 'checked', consecutiveFailures: 2 });
    expect(result.waitReason).toBe('credential');
    expect(result.reason).not.toBe('source_limited_cache');
  });

  it('counts Google no-progress stalls only after a meaningful evaluated batch', () => {
    const smallBatch = evaluateAttempt({
      ...base, jobSucceeded: true, netGrowth: 0, sourceComplete: false,
      checkpointToken: 'checkpoint-2', previousCheckpointToken: 'checkpoint-1', partialStalls: 2,
      partialWorkCount: 1, partialMinimumWorkCount: 50, partialProgressEvaluationReady: true
    });
    expect(smallBatch).toMatchObject({ action: 'checked', consecutiveFailures: 0 });

    const evaluatedBatch = evaluateAttempt({
      ...base, jobSucceeded: true, netGrowth: 0, sourceComplete: false,
      checkpointToken: 'checkpoint-2', previousCheckpointToken: 'checkpoint-1', partialStalls: 2,
      partialWorkCount: 50, partialMinimumWorkCount: 50, partialProgressEvaluationReady: true
    });
    expect(evaluatedBatch).toMatchObject({
      action: 'latch', reason: 'source_limited_cache', consecutiveFailures: 3
    });
  });

  it('treats a failed SOURCE_PARTIAL outcome as checkpoint progress instead of a generic failure', () => {
    const result = evaluateAttempt({
      ...base, jobSucceeded: false, netGrowth: 0, sourceComplete: false,
      failureCode: 'SOURCE_PARTIAL', checkpointToken: 'checkpoint-2',
      previousCheckpointToken: 'checkpoint-1', partialStalls: 2
    });
    expect(result).toMatchObject({
      action: 'checked', reason: 'source_partial_checkpoint', checkpointToken: 'checkpoint-2', consecutiveFailures: 0
    });
  });

  it('latches deterministic quality failures immediately', () => {
    const result = evaluateAttempt({ ...base, jobSucceeded: false, netGrowth: 0, deterministicFailure: true });
    expect(result.action).toBe('latch');
  });

  it('checks a growing source once and latches a new version that produces no growth', () => {
    const growth = evaluateAttempt({ ...base, jobSucceeded: true, netGrowth: 25 });
    expect(growth).toMatchObject({ action: 'checked', reason: 'source_version_checked', fingerprint: 'fp-1' });
    expect(Date.parse(growth.nextAttemptAt)).toBeGreaterThan(Date.parse(base.completedAt));
    expect(evaluateAttempt({ ...base, jobSucceeded: true, netGrowth: 0, fingerprintAfter: 'fp-2' }))
      .toMatchObject({ action: 'latch', fingerprint: 'fp-2' });
  });

  it('backs off transient failures with a bounded exponential delay instead of latching', () => {
    const first = evaluateAttempt({ ...base, jobSucceeded: false, netGrowth: 0, consecutiveFailures: 0 });
    expect(first).toMatchObject({ action: 'backoff', consecutiveFailures: 1 });
    expect(first.nextAttemptAt).toBe(iso(Date.parse(base.completedAt) + 5 * 60_000));
    const eighth = evaluateAttempt({ ...base, jobSucceeded: false, netGrowth: 0, consecutiveFailures: 7 });
    expect(eighth).toMatchObject({ action: 'suspend', consecutiveFailures: 8, reason: 'retry_suspended' });
    expect(Date.parse(eighth.nextAttemptAt)).toBeGreaterThan(Date.parse(base.completedAt));
  });

  it('waits for storage without counting a failure or suspending the source', () => {
    const result = evaluateAttempt({
      ...base, jobSucceeded: false, netGrowth: 0, failureCode: 'ADDRESS_STORAGE_HARD_LIMIT', consecutiveFailures: 7
    });
    expect(result).toMatchObject({ action: 'backoff', reason: 'storage_wait', consecutiveFailures: 7 });
    expect(result.nextAttemptAt).toBe(iso(Date.parse(base.completedAt) + 60 * 60_000));
  });

  it('retains the latest checkpoint across an interruption backoff', () => {
    const result = evaluateAttempt({
      ...base,
      jobSucceeded: false,
      netGrowth: 0,
      failureCode: 'SYNC_JOB_INTERRUPTED',
      previousCheckpointToken: 'checkpoint-2',
      consecutiveFailures: 2
    });
    expect(result).toMatchObject({
      action: 'backoff', checkpointToken: 'checkpoint-2', consecutiveFailures: 2,
      failureCode: 'SYNC_JOB_INTERRUPTED'
    });
    expect(result.nextAttemptAt).toBe(iso(Date.parse(base.completedAt) + 60_000));
  });

  it('suspends a country after two consecutive timeout failures', () => {
    const first = evaluateAttempt({
      ...base, jobSucceeded: false, netGrowth: 0, failureCode: 'SYNC_PROCESS_TIMEOUT', consecutiveFailures: 0
    });
    expect(first).toMatchObject({ action: 'backoff', consecutiveFailures: 1, failureCode: 'SYNC_PROCESS_TIMEOUT' });
    const second = evaluateAttempt({
      ...base, jobSucceeded: false, netGrowth: 0, failureCode: 'SYNC_PROCESS_TIMEOUT', consecutiveFailures: 1
    });
    expect(second).toMatchObject({ action: 'suspend', consecutiveFailures: 2, failureCode: 'SYNC_PROCESS_TIMEOUT' });
  });

  it('treats PostgreSQL statement cancellation as a bounded timeout failure', () => {
    const first = evaluateAttempt({
      ...base, jobSucceeded: false, netGrowth: 0, failureCode: '57014', consecutiveFailures: 0
    });
    expect(first).toMatchObject({ action: 'backoff', consecutiveFailures: 1, failureCode: '57014' });
    const second = evaluateAttempt({
      ...base, jobSucceeded: false, netGrowth: 0, failureCode: '57014', consecutiveFailures: 1
    });
    expect(second).toMatchObject({ action: 'suspend', consecutiveFailures: 2, failureCode: '57014' });
  });

  it('moves quota-bound countries to waiting_quota instead of latching when the quota is spent', () => {
    const result = evaluateAttempt({
      ...base, jobSucceeded: false, netGrowth: 0,
      quotaBound: true, quotaAvailable: false, quotaResetAt: '2026-08-03T00:03:00Z'
    });
    expect(result).toMatchObject({ action: 'waiting_quota', nextAttemptAt: '2026-08-03T00:03:00Z' });
  });

  it('preserves a successful result when the quota becomes exhausted at completion', () => {
    const result = evaluateAttempt({
      ...base, jobSucceeded: true, netGrowth: 25,
      quotaBound: true, quotaAvailable: false, quotaResetAt: '2026-08-03T00:03:00Z'
    });
    expect(result).toMatchObject({ action: 'checked', fingerprint: 'fp-1' });
  });

  it('preserves a partial checkpoint when quota is exhausted and lets the next snapshot wait for reset', () => {
    const result = evaluateAttempt({
      ...base, jobSucceeded: true, netGrowth: 10, sourceComplete: false,
      checkpointToken: 'checkpoint-2', previousCheckpointToken: 'checkpoint-1',
      quotaBound: true, quotaAvailable: false, quotaResetAt: '2026-08-03T00:03:00Z',
      partialNextAttemptAt: '2026-08-03T00:03:00Z'
    });
    expect(result).toMatchObject({
      action: 'checked', reason: 'source_partial_checkpoint', checkpointToken: 'checkpoint-2', consecutiveFailures: 0,
      nextAttemptAt: '2026-08-03T00:03:00Z'
    });
  });

  it('changes the source fingerprint only when that source version or adapter capability changes', () => {
    const inputs = {
      importRevision: 'rev-1', policyUpdatedAt: 'p1', nodeTargetsUpdatedAt: 'n1', catalogVersion: 'c1',
      adapterRevisions: [['shard-a', 'adapter-v1']], sourceVersions: [['shard-a', 'v1']]
    };
    const fingerprint = countryFingerprint(inputs);
    expect(countryFingerprint({ ...inputs })).toBe(fingerprint);
    expect(countryFingerprint({ ...inputs, importRevision: 'rev-2' })).toBe(fingerprint);
    expect(countryFingerprint({ ...inputs, policyUpdatedAt: 'p2' })).toBe(fingerprint);
    expect(countryFingerprint({ ...inputs, nodeTargetsUpdatedAt: 'n2' })).toBe(fingerprint);
    expect(countryFingerprint({ ...inputs, catalogVersion: 'c2' })).toBe(fingerprint);
    expect(countryFingerprint({ ...inputs, adapterRevisions: [['shard-a', 'adapter-v2']] })).not.toBe(fingerprint);
    expect(countryFingerprint({ ...inputs, sourceVersions: [['shard-a', 'v2']] })).not.toBe(fingerprint);
    expect(legacyCountryFingerprint({ importRevision: 'rev-1', sourceVersions: inputs.sourceVersions }))
      .not.toBe(legacyCountryFingerprint({ importRevision: 'rev-2', sourceVersions: inputs.sourceVersions }));
  });

  it('versions execution failures by phase without changing source exhaustion fingerprints', () => {
    const sourceFingerprint = countryFingerprint({
      adapterRevisions: [['oa-us', 'g69']], sourceVersions: [['oa-us', 'v1']]
    });
    const publishFailure = executionFailureFingerprint(sourceFingerprint, '', 'import');
    expect(executionFailureFingerprint(sourceFingerprint, '', 'import')).toBe(publishFailure);
    expect(executionFailureFingerprint(sourceFingerprint, '', 'materialize')).not.toBe(publishFailure);
    expect(countryFingerprint({
      adapterRevisions: [['oa-us', 'g69']], sourceVersions: [['oa-us', 'v1']]
    })).toBe(sourceFingerprint);
  });

  it('releases only adapter-specific materialize failures without changing source fingerprints', () => {
    const sourceFingerprint = countryFingerprint({
      adapterRevisions: [['japan-abr-residential', 'abr-v1']], sourceVersions: [['japan-abr-residential', 'v1']]
    });
    const japan = executionFailureFingerprint(sourceFingerprint, '', 'materialize', 'japan-abr');
    const korea = executionFailureFingerprint(sourceFingerprint, '', 'materialize', 'korea-kapt');
    expect(japan).not.toBe(executionFailureFingerprint(sourceFingerprint, '', 'materialize', 'overture'));
    expect(japan).not.toBe(korea);
    expect(countryFingerprint({
      adapterRevisions: [['japan-abr-residential', 'abr-v1']], sourceVersions: [['japan-abr-residential', 'v1']]
    })).toBe(sourceFingerprint);
  });

  it('releases Geofabrik redirect discovery failures without touching materialize failures', () => {
    const sourceFingerprint = countryFingerprint({ adapterRevisions: [['google-residential-enrichment-ph', 'g-v9']], sourceVersions: [] });
    const generic = (phase) => executionFailureFingerprint(sourceFingerprint, '', phase, 'overture');
    for (const adapter of ['google-residential-enrichment', 'geofabrik']) {
      expect(executionFailureFingerprint(sourceFingerprint, '', 'discover', adapter)).not.toBe(generic('discover'));
    }
    expect(executionFailureFingerprint(sourceFingerprint, '', 'materialize', 'geofabrik')).toBe(generic('materialize'));
  });
});

describe('published queue snapshots', () => {
  it('publishes changed snapshots and throttles recomputation while China blocks the queue', async () => {
    const facts = stubFacts();
    const sources = { ...stubSources(facts, {}), chinaPriority: async () => ({ blocksQueue: true, executionState: 'running' }) };
    const addressFacts = vi.spyOn(sources, 'addressFacts');
    const history = { schedulerHeartbeat: vi.fn(async () => {}), publishQueueSnapshot: vi.fn(async () => {}) };
    let current = new Date('2026-08-02T10:00:00Z');
    const log = { log: vi.fn(), error: () => {} };
    const queue = createSyncQueue({
      environment: {}, coordinator: { currentJob: null }, stateDir: stateDir(), sources, history,
      loadCatalog: async () => ({ shards: stubCatalogShards }), now: () => current, cooldownMs: 0, log
    });

    await queue.tick();
    current = new Date(current.getTime() + 5_000);
    await queue.tick();
    expect(addressFacts).toHaveBeenCalledTimes(1);
    expect(history.publishQueueSnapshot).toHaveBeenCalledTimes(1);
    const [json, at] = history.publishQueueSnapshot.mock.calls[0];
    expect(at).toBe('2026-08-02T10:00:00.000Z');
    expect(JSON.parse(json)).toMatchObject({ generatedAt: at, entries: expect.any(Array) });
    expect(JSON.parse(json).entries.every((entry) => !('sourceExecution' in entry))).toBe(true);
    expect(log.log).toHaveBeenCalledTimes(1);

    current = new Date(current.getTime() + 60_000);
    await queue.tick();
    expect(addressFacts).toHaveBeenCalledTimes(2);
    expect(history.publishQueueSnapshot).toHaveBeenCalledTimes(2);
  });
});

describe('storage gate', () => {
  it('starts no job while storage is full and resumes once space is free', async () => {
    const facts = stubFacts();
    facts.deficits.belowTarget.add('US');
    let full = true;
    const sources = { ...stubSources(facts, {}), storageStatus: vi.fn(async () => ({ full, usedBytes: 1, freeBytes: 1, softLimitBytes: 1 })) };
    const coordinator = { currentJob: null, trigger: vi.fn(async () => ({ accepted: false })), waitForIdle: async () => {} };
    let current = new Date('2026-08-02T10:00:00Z');
    const queue = createSyncQueue({
      environment: {}, coordinator, stateDir: stateDir(), sources,
      loadCatalog: async () => ({ shards: [{ id: 'overture-addresses-us', countryCode: 'US', popularCities: true, source: { adapter: 'overture' } }] }),
      now: () => current, cooldownMs: 0, log: { log: () => {}, error: () => {} }
    });
    await queue.tick();
    current = new Date(current.getTime() + 30_000);
    await queue.tick();
    expect(coordinator.trigger).not.toHaveBeenCalled();
    expect(sources.storageStatus).toHaveBeenCalledTimes(1);
    full = false;
    current = new Date(current.getTime() + 60_000);
    await queue.tick();
    expect(sources.storageStatus).toHaveBeenCalledTimes(2);
    expect(coordinator.trigger).toHaveBeenCalled();
  });

  it('releases sources suspended only by the storage limit once storage is available', async () => {
    const facts = stubFacts();
    const sources = { ...stubSources(facts, {}), storageStatus: async () => ({ full: false, usedBytes: 1, freeBytes: 1, softLimitBytes: 2 }) };
    const queue = createSyncQueue({
      environment: {}, coordinator: { currentJob: null, trigger: async () => ({ accepted: false }), waitForIdle: async () => {} },
      stateDir: stateDir(), sources, loadCatalog: async () => ({ shards: [] }),
      now: () => new Date('2026-08-02T10:00:00Z'), cooldownMs: 0, log: { log: () => {}, error: () => {} }
    });
    const suspend = (failureCode) => ({ action: 'suspend', fingerprint: 'f', consecutiveFailures: 8, failureCode,
      nextAttemptAt: '2026-09-01T00:00:00Z' });
    await queue.store.apply('US', suspend('ADDRESS_STORAGE_HARD_LIMIT'), '2026-08-02T09:00:00Z', 'storage-source');
    await queue.store.apply('US', suspend('SYNC_PROCESS_TIMEOUT'), '2026-08-02T09:00:00Z', 'timeout-source');
    await queue.tick();
    const shards = (await queue.store.load()).countries.US.shards;
    expect(shards['storage-source']).toBeUndefined();
    expect(shards['timeout-source']).toMatchObject({ state: 'suspended', failureCode: 'SYNC_PROCESS_TIMEOUT' });
  });
});

describe('exhausted source metadata probes', () => {
  it('does not periodically probe terminal sources unless explicitly enabled', async () => {
    const facts = stubFacts();
    facts.deficits.belowTarget = new Set(['US']);
    facts.shards.US = [{ shardId: 'oa-us', status: 'ready', sourceVersion: 'v1', updatedAt: '' }];
    const probeSource = vi.fn(async () => ({ version: 'v2' }));
    const queue = createSyncQueue({
      environment: {}, coordinator: { currentJob: null }, stateDir: stateDir(), sources: stubSources(facts, {}),
      loadCatalog: async () => ({ shards: stubCatalogShards }), probeSource,
      now: () => new Date('2026-08-02T10:00:00Z'), cooldownMs: 0,
      log: { log: () => {}, error: () => {} }
    });
    await queue.store.apply('US', {
      action: 'latch', fingerprint: countryFingerprint({
        adapterRevisions: [['oa-us', '']], sourceVersions: [['oa-us', 'v1']]
      }), latchedAt: '2026-08-01T00:00:00Z', nextAttemptAt: '2026-08-02T09:00:00Z'
    }, '2026-08-01T00:00:00Z', 'oa-us');

    await queue.tick();
    expect(probeSource).not.toHaveBeenCalled();
    expect((await queue.snapshot()).entries.find(({ countryCode }) => countryCode === 'US'))
      .toMatchObject({ state: 'source_limited', reason: 'source_limited_cache' });
  });

  it('keeps an unchanged source exhausted and unlocks only a newer upstream version', async () => {
    const facts = stubFacts();
    facts.deficits.belowTarget = new Set(['US']);
    facts.shards.US = [{ shardId: 'oa-us', status: 'ready', sourceVersion: 'v1', updatedAt: '' }];
    const coordinator = {
      calls: [],
      currentJob: null,
      trigger: async (trigger, { shards }) => {
        coordinator.calls.push({ trigger, shards });
        return { accepted: true, job: { id: 'unexpected-probe-job' } };
      },
      waitForIdle: async () => {},
      getJob: async () => ({ status: 'succeeded' })
    };
    let current = new Date('2026-08-02T10:00:00Z');
    let upstreamVersion = 'v1';
    const queue = createSyncQueue({
      environment: {}, enableSourceProbes: true, coordinator, stateDir: stateDir(), sources: stubSources(facts, {}),
      loadCatalog: async () => ({ shards: stubCatalogShards }),
      probeSource: async () => ({ version: upstreamVersion }),
      now: () => current,
      cooldownMs: 0,
      log: { log: () => {}, error: () => {} }
    });
    const fingerprint = countryFingerprint({
      adapterRevisions: [['oa-us', '']],
      sourceVersions: [['oa-us', 'v1']]
    });
    await queue.store.apply('US', {
      action: 'latch', fingerprint, latchedAt: '2026-08-01T00:00:00Z',
      nextAttemptAt: '2026-08-02T09:00:00Z'
    }, '2026-08-01T00:00:00Z', 'oa-us');

    await queue.tick();
    expect(coordinator.calls).toHaveLength(0);
    const unchanged = (await queue.store.load()).countries.US.shards['oa-us'];
    expect(unchanged).toMatchObject({ state: 'latched', fingerprint });
    expect(Date.parse(unchanged.nextAttemptAt)).toBeGreaterThan(current.getTime());

    current = new Date(Date.parse(unchanged.nextAttemptAt) + 1);
    upstreamVersion = 'v2';
    await queue.tick();
    expect((await queue.store.load()).countries.US).toBeUndefined();
    expect(coordinator.calls).toHaveLength(0);
  });

  it('records the first lightweight postcode probe and unlocks only when its metadata later changes', async () => {
    const facts = stubFacts();
    facts.policies = { NL: facts.policies.NL };
    facts.counts = { NL: facts.counts.NL };
    facts.deficits.belowTarget = new Set(['NL']);
    facts.shards = { NL: [{
      shardId: 'oa-nl', status: 'ready', sourceVersion: '2026-08-01-p1111111111111111', failureCode: null
    }] };
    let current = new Date('2026-08-02T10:00:00Z');
    let probeVersion = '2026-08-01-p2222222222222222';
    const queue = createSyncQueue({
      environment: {}, enableSourceProbes: true, coordinator: { currentJob: null }, stateDir: stateDir(), sources: stubSources(facts, {}),
      loadCatalog: async () => ({ shards: [{
        id: 'oa-nl', countryCode: 'NL', source: { adapter: 'geofabrik' }
      }] }),
      probeSource: async () => ({ version: probeVersion }), now: () => current, cooldownMs: 0,
      log: { log: () => {}, error: () => {} }
    });
    const fingerprint = countryFingerprint({
      adapterRevisions: [['oa-nl', sourceAdapterRevisions.geofabrik]],
      sourceVersions: [['oa-nl', facts.shards.NL[0].sourceVersion]]
    });
    await queue.store.apply('NL', {
      action: 'latch', fingerprint, latchedAt: '2026-08-01T00:00:00Z', nextAttemptAt: current.toISOString()
    }, '2026-08-01T00:00:00Z', 'oa-nl');

    await queue.tick();
    const initialized = (await queue.store.load()).countries.NL.shards['oa-nl'];
    expect(initialized).toMatchObject({ state: 'latched', fingerprint, probeVersion });

    current = new Date(Date.parse(initialized.nextAttemptAt) + 1);
    probeVersion = '2026-08-01-p3333333333333333';
    await queue.tick();
    expect((await queue.store.load()).countries.NL).toBeUndefined();
  });

  it('runs a new source before probing an exhausted source in the same country', async () => {
    const facts = stubFacts();
    facts.policies = { NL: facts.policies.NL };
    facts.counts = { NL: facts.counts.NL };
    facts.deficits.belowTarget = new Set(['NL']);
    facts.shards = { NL: [
      ...facts.shards.NL,
      { shardId: 'nl-new', status: 'ready', sourceVersion: 'v1', failureCode: null }
    ] };
    const coordinator = {
      calls: [], currentJob: null,
      trigger: async (trigger, { shards }) => {
        coordinator.calls.push({ trigger, shards });
        return { accepted: true, job: { id: 'sync-new-source' } };
      },
      waitForIdle: async () => {},
      getJob: async () => ({ id: 'sync-new-source', status: 'succeeded' })
    };
    const probeSource = vi.fn(async () => ({ version: 'v1' }));
    const queue = createSyncQueue({
      environment: {}, enableSourceProbes: true, coordinator, stateDir: stateDir(), sources: stubSources(facts, {}),
      loadCatalog: async () => ({ shards: [
        { id: 'oa-nl', countryCode: 'NL' }, { id: 'nl-new', countryCode: 'NL' }
      ] }),
      probeSource,
      now: () => new Date('2026-08-02T10:00:00Z'),
      cooldownMs: 0,
      log: { log: () => {}, error: () => {} }
    });
    await queue.store.apply('NL', {
      action: 'latch',
      fingerprint: countryFingerprint({ adapterRevisions: [['oa-nl', '']], sourceVersions: [['oa-nl', 'v1']] }),
      latchedAt: '2026-08-01T00:00:00Z',
      nextAttemptAt: null
    }, '2026-08-01T00:00:00Z', 'oa-nl');

    await queue.tick();
    expect(coordinator.calls).toEqual([{ trigger: 'queue', shards: ['nl-new'] }]);
    expect(probeSource).not.toHaveBeenCalled();
  });

  it('backs off repeated probe failures and then returns to the normal source interval', async () => {
    const facts = stubFacts();
    facts.policies = { NL: facts.policies.NL };
    facts.counts = { NL: facts.counts.NL };
    facts.deficits.belowTarget = new Set(['NL']);
    facts.shards = { NL: facts.shards.NL };
    let current = new Date('2026-08-02T10:00:00Z');
    const queue = createSyncQueue({
      environment: {}, enableSourceProbes: true, coordinator: { currentJob: null }, stateDir: stateDir(), sources: stubSources(facts, {}),
      loadCatalog: async () => ({ shards: [{ id: 'oa-nl', countryCode: 'NL', intervalDays: 1 }] }),
      probeSource: vi.fn(async () => { throw new Error('fixture probe failure'); }),
      now: () => current, cooldownMs: 0, log: { log: () => {}, error: () => {} }
    });
    const fingerprint = countryFingerprint({
      adapterRevisions: [['oa-nl', '']], sourceVersions: [['oa-nl', 'v1']]
    });
    await queue.store.apply('NL', {
      action: 'latch', fingerprint, latchedAt: '2026-08-01T00:00:00Z', nextAttemptAt: current.toISOString()
    }, '2026-08-01T00:00:00Z', 'oa-nl');

    const delays = [];
    for (let failure = 1; failure <= 3; failure += 1) {
      await queue.tick();
      const saved = (await queue.store.load()).countries.NL.shards['oa-nl'];
      expect(saved.probeFailures).toBe(failure);
      delays.push(Date.parse(saved.nextAttemptAt) - current.getTime());
      current = new Date(Date.parse(saved.nextAttemptAt) + 1);
    }
    expect(delays).toEqual([5 * 60_000, 10 * 60_000, 24 * 60 * 60_000]);
  });

  it('does not probe a source after all three country goals are complete', async () => {
    const facts = stubFacts();
    facts.policies = { SG: facts.policies.SG };
    facts.counts = { SG: facts.counts.SG };
    facts.deficits.belowTarget = new Set();
    facts.shards = { SG: facts.shards.SG };
    const probeSource = vi.fn(async () => ({ version: 'v2' }));
    const queue = createSyncQueue({
      environment: {}, enableSourceProbes: true, coordinator: { currentJob: null }, stateDir: stateDir(), sources: stubSources(facts, {}),
      loadCatalog: async () => ({ shards: [{ id: 'sg-hdb', countryCode: 'SG' }] }), probeSource,
      now: () => new Date('2026-08-02T10:00:00Z'), cooldownMs: 0,
      log: { log: () => {}, error: () => {} }
    });
    await queue.store.apply('SG', {
      action: 'latch', fingerprint: countryFingerprint({
        adapterRevisions: [['sg-hdb', '']], sourceVersions: [['sg-hdb', 'v1']]
      }), latchedAt: '2026-08-01T00:00:00Z', nextAttemptAt: '2026-08-02T09:00:00Z'
    }, '2026-08-01T00:00:00Z', 'sg-hdb');

    await queue.tick();
    expect(probeSource).not.toHaveBeenCalled();
    expect((await queue.snapshot()).entries.find(({ countryCode }) => countryCode === 'SG').state).toBe('done');
  });

  it('keeps probe scheduling internal to the public queue snapshot', async () => {
    const facts = stubFacts();
    facts.policies = { NL: facts.policies.NL };
    facts.counts = { NL: facts.counts.NL };
    facts.deficits.belowTarget = new Set(['NL']);
    facts.shards = { NL: facts.shards.NL };
    const queue = createSyncQueue({
      environment: {}, coordinator: { currentJob: null, recoveredJobs: [] }, stateDir: stateDir(),
      sources: stubSources(facts, {}), loadCatalog: async () => ({ shards: [{ id: 'oa-nl', countryCode: 'NL' }] })
    });
    await queue.store.apply('NL', {
      action: 'latch',
      fingerprint: countryFingerprint({ adapterRevisions: [['oa-nl', '']], sourceVersions: [['oa-nl', 'v1']] }),
      latchedAt: '2026-08-01T00:00:00Z',
      nextAttemptAt: null
    }, '2026-08-01T00:00:00Z', 'oa-nl');

    const entry = (await queue.snapshot()).entries[0];
    expect(entry).toMatchObject({ countryCode: 'NL', state: 'source_limited' });
    expect(entry).not.toHaveProperty('probeShardIds');
  });
});

describe('PostgreSQL queue state', () => {
  it('imports the legacy state once and persists per-source execution state', async () => {
    const database = openTestDatabase();
    const directory = stateDir();
    const legacyFile = resolve(directory, 'queue-state.json');
    await mkdir(directory, { recursive: true });
    await writeFile(legacyFile, JSON.stringify({ schemaVersion: 1, countries: {
      NL: { shards: { 'oa-nl': {
        state: 'latched', latched: true, reason: 'source_limited_cache', fingerprint: 'fp-nl',
        latchedAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z'
      } } }
    } }));
    const store = new PostgresQueueStateStore(database, legacyFile);
    expect(await store.load()).toMatchObject({ countries: { NL: { shards: { 'oa-nl': {
      state: 'latched', fingerprint: 'fp-nl'
    } } } } });
    await expect(readFile(legacyFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await database.prepare(`SELECT state,source_fingerprint FROM sync_source_execution_state
      WHERE country_code='NL' AND source_id='oa-nl'`).first()).toEqual({ state: 'exhausted', source_fingerprint: 'fp-nl' });
    await store.apply('NL', { action: 'backoff', fingerprint: 'failure-fp', consecutiveFailures: 1,
      failureCode: 'NETWORK', nextAttemptAt: '2026-08-02T01:00:00Z' }, '2026-08-02T00:00:00Z', 'oa-nl');
    expect(await store.load()).toMatchObject({ countries: { NL: { shards: { 'oa-nl': {
      state: 'backoff', fingerprint: 'failure-fp', consecutiveFailures: 1
    } } } } });
    await store.apply('NL', { action: 'checked', reason: 'source_partial_checkpoint', fingerprint: 'fp-nl',
      checkpointToken: 'checkpoint-2', waitReason: 'quota', nextAttemptAt: '2026-09-01T00:00:00Z' },
    '2026-08-02T00:01:00Z', 'oa-nl');
    expect(await store.load()).toMatchObject({ countries: { NL: { shards: { 'oa-nl': {
      state: 'checked', waitReason: 'quota', checkpointToken: 'checkpoint-2'
    } } } } });
    expect(await database.prepare(`SELECT wait_reason FROM sync_source_execution_state
      WHERE country_code='NL' AND source_id='oa-nl'`).first('wait_reason')).toBe('quota');
    database.close();
  });

  it('merges missing legacy sources when PostgreSQL already has partial state', async () => {
    const database = openTestDatabase();
    const directory = stateDir();
    const legacyFile = resolve(directory, 'queue-state.json');
    await mkdir(directory, { recursive: true });
    await writeFile(legacyFile, JSON.stringify({ countries: { US: { state: 'latched' } } }));
    await database.prepare(`INSERT INTO sync_source_execution_state(
      country_code,source_id,state,consecutive_failures,updated_at
    ) VALUES ('NL','oa-nl','checked',0,'2026-08-01T00:00:00Z')`).run();
    const store = new PostgresQueueStateStore(database, legacyFile);
    expect(await store.load()).toMatchObject({ countries: {
      NL: { shards: { 'oa-nl': { state: 'checked' } } },
      US: { shards: { US: { state: 'latched' } } }
    } });
    await expect(readFile(legacyFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    database.close();
  });

  it('does not delete or ignore a corrupt legacy queue state file', async () => {
    const database = openTestDatabase();
    const directory = stateDir();
    const legacyFile = resolve(directory, 'queue-state.json');
    await mkdir(directory, { recursive: true });
    await writeFile(legacyFile, '{"countries":');
    const store = new PostgresQueueStateStore(database, legacyFile);
    await expect(store.load()).rejects.toMatchObject({ code: 'QUEUE_STATE_INVALID' });
    expect(await readFile(legacyFile, 'utf8')).toBe('{"countries":');
    database.close();
  });

  it('clears one exact source without unlocking the other sources in its country', async () => {
    const database = openTestDatabase();
    const store = new PostgresQueueStateStore(database, resolve(stateDir(), 'queue-state.json'));
    await store.apply('US', { action: 'latch', fingerprint: 'fp-a', latchedAt: '2026-08-01T00:00:00Z' },
      '2026-08-01T00:00:00Z', 'oa-us-a');
    await store.apply('US', { action: 'latch', fingerprint: 'fp-b', latchedAt: '2026-08-01T00:00:00Z' },
      '2026-08-01T00:00:00Z', 'oa-us-b');
    await store.clear(['oa-us-a']);
    const state = await store.load();
    expect(state.countries.US.shards['oa-us-a']).toBeUndefined();
    expect(state.countries.US.shards['oa-us-b']).toMatchObject({ state: 'latched' });
    database.close();
  });
});

describe('sleep-until-wake computation', () => {
  const now = new Date('2026-08-02T10:00:00Z');
  it('wakes at the earliest future quota reset or retry time', () => {
    const wake = nextWakeAt([
      { nextAttemptAt: '2026-08-03T00:03:00Z' },
      { nextAttemptAt: '2026-08-02T12:00:00Z' },
      { nextAttemptAt: '2026-08-02T09:00:00Z' },
      { nextAttemptAt: null }
    ], now);
    expect(wake.toISOString()).toBe('2026-08-02T12:00:00.000Z');
  });
  it('returns null when nothing schedules a wake-up', () => {
    expect(nextWakeAt([{ nextAttemptAt: null }, {}], now)).toBeNull();
  });
  it('computes provider quota reset boundaries like the control store', () => {
    expect(nextQuotaResetTime('day', 0, new Date('2026-08-02T10:00:00Z')).toISOString()).toBe('2026-08-03T00:00:00.000Z');
    expect(nextQuotaResetTime('month', 0, new Date('2026-08-02T10:00:00Z')).toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(nextQuotaResetTime('day', 480, new Date('2026-08-02T20:00:00Z')).toISOString()).toBe('2026-08-03T16:00:00.000Z');
  });
});

describe('queue state reset', () => {
  it('clears every terminal state when force targets all countries', async () => {
    const store = new QueueStateStore(resolve(stateDir(), 'queue.json'));
    await store.save({ schemaVersion: 1, countries: {
      PH: { state: 'latched' }, US: { state: 'suspended' }
    } });
    await store.clear(['all']);
    expect((await store.load()).countries).toEqual({});
  });
});

const stubFacts = () => ({
  policies: {
    US: { enabled: true, targetCount: 50_000, updatedAt: 'p-us' },
    NL: { enabled: true, targetCount: 25_000, updatedAt: 'p-nl' },
    KR: { enabled: true, targetCount: 20_000, updatedAt: 'p-kr' },
    SG: { enabled: true, targetCount: 8_000, updatedAt: 'p-sg' },
    NG: { enabled: true, targetCount: 8_000, updatedAt: 'p-ng' },
    TR: { enabled: false, targetCount: 10_000, updatedAt: 'p-tr' },
    CN: { enabled: true, targetCount: 30_000, updatedAt: 'p-cn' }
  },
  counts: { US: 49_938, NL: 6_446, KR: 9_558, SG: 8_000, NG: 0 },
  rules: {
    US: {
      total: { current: 49_938, target: 50_000, met: false },
      administrativeCoverage: { actual: 0.75, target: 1, met: false, covered: 3, total: 4 },
      regionalMinimums: {
        actual: 0.5, target: 1, met: false,
        lowest: { level: 2, minimum: 5, total: 4, covered: 3, qualified: 2, coverageRatio: 0.75, floorRatio: 0.5 },
        level1: null, level2: null,
        overrides: { satisfied: 0, total: 0, met: true }
      }
    }
  },
  shards: {
    US: [{ shardId: 'oa-us', status: 'ready', sourceVersion: 'v1', failureCode: null }],
    NL: [{ shardId: 'oa-nl', status: 'ready', sourceVersion: 'v1', failureCode: null }],
    KR: [{ shardId: 'korea-kapt-residential', status: 'ready', sourceVersion: 'v1', failureCode: null }],
    SG: [{ shardId: 'sg-hdb', status: 'ready', sourceVersion: 'v1', failureCode: null }],
    NG: [{ shardId: 'geofabrik-osm-ng', status: 'failed', sourceVersion: '', failureCode: null }]
  },
  nodeFloorsUpdatedAt: {},
  deficits: { belowTarget: new Set(['US', 'NL', 'KR', 'NG']), belowFloor: new Set() }
});
const stubCatalogShards = [
  { id: 'oa-us', countryCode: 'US' },
  { id: 'oa-nl', countryCode: 'NL' },
  { id: 'korea-kapt-residential', countryCode: 'KR' },
  { id: 'sg-hdb', countryCode: 'SG' }
];
const stubSources = (facts, quota) => ({
  addressFacts: async () => ({
    ...facts,
    deficits: { belowTarget: new Set(facts.deficits.belowTarget), belowFloor: new Set(facts.deficits.belowFloor) }
  }),
  quotaStatus: async (provider) => quota[provider] || { provider, known: false, available: true, nextResetAt: null }
});

describe('queue snapshot', () => {
  const now = new Date('2026-08-02T10:00:00Z');

  it('projects a missing provider credential as blocked with an actionable reason', async () => {
    const facts = stubFacts();
    const snapshot = await computeQueueSnapshot({
      sources: stubSources(facts, {
        geoapify: {
          provider: 'geoapify', known: false, available: false,
          nextResetAt: null, waitState: 'blocked', reason: 'missing_api_key:geoapify'
        }
      }),
      catalogShards: stubCatalogShards,
      queueState: { schemaVersion: 1, countries: {} },
      now
    });
    expect(snapshot.entries.find((entry) => entry.countryCode === 'KR')).toMatchObject({
      state: 'blocked', reason: 'missing_api_key:geoapify', position: null
    });
  });

  it('releases only popular-region shards whose cap was raised', () => {
    const shard = (extra) => ({ id: 'geofabrik-osm-de-by', countryCode: 'DE', maxRecords: 50_000, source: { adapter: 'geofabrik' }, ...extra });
    const plain = sourceCapabilityRevision(shard());
    expect(sourceCapabilityRevision(shard({ maxRecords: 80_000 }))).toBe(plain);
    const popular = sourceCapabilityRevision(shard({ priority: 2, maxRecords: 80_000 }));
    expect(popular.startsWith(`${plain}:popular-`)).toBe(true);
    expect(sourceCapabilityRevision(shard({ priority: 2, maxRecords: 100_000 }))).not.toBe(popular);
  });

  it('runs popular-region shards before the rest of the catalogue', async () => {
    const facts = stubFacts();
    facts.deficits.belowTarget.add('US');
    const shard = (id, priority) => ({ id, countryCode: 'US', ...(priority ? { priority } : {}), source: { adapter: 'overture' } });
    const snapshot = await computeQueueSnapshot({
      sources: stubSources(facts, {}),
      catalogShards: [shard('overture-us-al'), shard('overture-us-tx', 2), shard('overture-us-ca', 1)],
      queueState: { schemaVersion: 1, countries: {} },
      now
    });
    expect(snapshot.entries.find((entry) => entry.countryCode === 'US')?.runnableShardId).toBe('overture-us-ca');
  });

  it('runs the popular-city export before popular-region shards', async () => {
    const facts = stubFacts();
    facts.deficits.belowTarget.add('US');
    const shard = (id, extra = {}) => ({ id, countryCode: 'US', ...extra, source: { adapter: 'overture' } });
    const snapshot = await computeQueueSnapshot({
      sources: stubSources(facts, {}),
      catalogShards: [shard('overture-us-ca', { priority: 1 }), shard('overture-addresses-us', { popularCities: true }), shard('overture-us-al')],
      queueState: { schemaVersion: 1, countries: {} },
      now
    });
    expect(snapshot.entries.find((entry) => entry.countryCode === 'US')?.runnableShardId).toBe('overture-addresses-us');
  });

  it('marks countrywide Overture shards as popular-city exports', async () => {
    const { shards } = await loadSourceCatalog();
    expect(shards.find((item) => item.id === 'overture-addresses-us')).toMatchObject({ popularCities: true });
    expect(shards.find((item) => item.id === 'overture-usa-structures-ca')?.popularCities).toBeUndefined();
  });

  it('keeps an incomplete Singapore source waiting when OneMap is not configured', async () => {
    const facts = stubFacts();
    facts.deficits.belowTarget.add('SG');
    const catalog = [{
      id: 'sg-hdb', countryCode: 'SG', quotaProvider: 'onemap',
      source: { adapter: 'singapore-hdb' }
    }];
    const snapshot = await computeQueueSnapshot({
      sources: stubSources(facts, {
        onemap: {
          provider: 'onemap', known: false, available: false,
          nextResetAt: null, waitState: 'blocked', reason: 'missing_api_key:onemap'
        }
      }),
      catalogShards: catalog,
      queueState: { schemaVersion: 1, countries: {} },
      now
    });
    expect(snapshot.entries.find((entry) => entry.countryCode === 'SG')).toMatchObject({
      state: 'blocked', reason: 'missing_api_key:onemap', position: null,
      quotaBound: true, quotaProvider: 'onemap'
    });
  });

  it('isolates a missing optional source setting without stopping other countries', async () => {
    const facts = stubFacts();
    const catalog = stubCatalogShards.map((shard) => shard.id === 'oa-nl' ? {
      ...shard,
      source: { configurationError: 'missing_source_configuration:ADDRESS_SYNC_CUSTOM_FEED_URL' }
    } : shard);
    const snapshot = await computeQueueSnapshot({
      sources: stubSources(facts, {}), catalogShards: catalog,
      queueState: { schemaVersion: 1, countries: {} }, now
    });
    expect(snapshot.entries.find((entry) => entry.countryCode === 'NL')).toMatchObject({
      state: 'blocked', reason: 'missing_source_configuration:ADDRESS_SYNC_CUSTOM_FEED_URL'
    });
    expect(snapshot.entries.find((entry) => entry.countryCode === 'US')).toMatchObject({ state: 'queued' });
  });

  it('classifies countries and orders the runnable queue', async () => {
    const facts = stubFacts();
    const snapshot = await computeQueueSnapshot({
      sources: stubSources(facts, {
        geoapify: { provider: 'geoapify', known: true, available: false, nextResetAt: '2026-08-03T00:03:00Z' }
      }),
      catalogShards: stubCatalogShards,
      queueState: { schemaVersion: 1, countries: {} },
      now
    });
    const byCountry = Object.fromEntries(snapshot.entries.map((entry) => [entry.countryCode, entry]));
    expect(byCountry.CN).toBeUndefined();
    expect(byCountry.TR).toBeUndefined();
    expect(byCountry.SG.state).toBe('done');
    expect(byCountry.NG).toMatchObject({ state: 'no_source', reason: 'no_source_shard', position: null });
    expect(byCountry.KR).toMatchObject({ state: 'quota_wait', nextAttemptAt: '2026-08-03T00:03:00Z', quotaBound: true });
    expect(byCountry.NL).toMatchObject({ state: 'queued', position: 1, deficit: 18_554 });
    expect(byCountry.US).toMatchObject({ state: 'queued', position: 2, deficit: 62, target: 50_000, current: 49_938 });
    expect(byCountry.US.rules).toMatchObject({
      total: { met: false },
      administrativeCoverage: { actual: 0.75, met: false },
      regionalMinimums: { actual: 0.5, met: false }
    });
  });

  it('prioritizes a quota-bound country the moment its window opens', async () => {
    const facts = stubFacts();
    const snapshot = await computeQueueSnapshot({
      sources: stubSources(facts, {
        geoapify: { provider: 'geoapify', known: true, available: true, nextResetAt: '2026-08-03T00:03:00Z' }
      }),
      catalogShards: stubCatalogShards,
      queueState: { schemaVersion: 1, countries: {} },
      now
    });
    const queued = snapshot.entries.filter((entry) => entry.state === 'queued');
    expect(queued.map((entry) => entry.countryCode)).toEqual(['KR', 'NL', 'US']);
    expect(queued[0].position).toBe(1);
  });

  it('omits a stale ETA after a running source exceeds its historical P80', async () => {
    const facts = stubFacts();
    facts.durationSamples = { countries: {}, sources: { 'oa-us': [60_000, 120_000, 180_000] } };
    const snapshot = await computeQueueSnapshot({
      sources: stubSources(facts, {}),
      catalogShards: stubCatalogShards,
      queueState: { schemaVersion: 1, countries: {} },
      runningJob: {
        id: 'running-us', phase: 'materialize', shards: ['oa-us'],
        startedAt: '2026-08-02T09:56:00Z', heartbeatAt: '2026-08-02T10:00:00Z',
        deadlineAt: '2026-08-02T11:26:00Z'
      },
      now
    });
    expect(snapshot.entries.find((entry) => entry.countryCode === 'US')).toMatchObject({
      state: 'running', eta: null
    });
  });

  it('keeps an unmetered source runnable while another source in the country waits for quota', async () => {
    const facts = stubFacts();
    facts.shards.KR.push({ shardId: 'geofabrik-osm-kr', status: 'ready', sourceVersion: 'v1', failureCode: null });
    const catalog = [...stubCatalogShards, { id: 'geofabrik-osm-kr', countryCode: 'KR' }];
    const snapshot = await computeQueueSnapshot({
      sources: stubSources(facts, {
        geoapify: { provider: 'geoapify', known: true, available: false, nextResetAt: '2026-08-03T00:03:00Z' }
      }),
      catalogShards: catalog,
      queueState: { schemaVersion: 1, countries: {} },
      now
    });
    expect(snapshot.entries.find((entry) => entry.countryCode === 'KR')).toMatchObject({
      state: 'queued', runnableShardId: 'geofabrik-osm-kr', quotaBound: false
    });
  });

  it('keeps an unmetered source runnable while another source is missing its API key', async () => {
    const facts = stubFacts();
    facts.shards.KR.push({ shardId: 'geofabrik-osm-kr', status: 'ready', sourceVersion: 'v1', failureCode: null });
    const catalog = [...stubCatalogShards, { id: 'geofabrik-osm-kr', countryCode: 'KR' }];
    const snapshot = await computeQueueSnapshot({
      sources: stubSources(facts, {
        geoapify: {
          provider: 'geoapify', known: false, available: false,
          nextResetAt: null, waitState: 'blocked', reason: 'missing_api_key:geoapify'
        }
      }),
      catalogShards: catalog,
      queueState: { schemaVersion: 1, countries: {} },
      now
    });
    expect(snapshot.entries.find((entry) => entry.countryCode === 'KR')).toMatchObject({
      state: 'queued', runnableShardId: 'geofabrik-osm-kr', quotaBound: false
    });
  });

  it('runs a ready fallback source instead of waiting on another source backoff', async () => {
    const facts = stubFacts();
    facts.shards.KR.push({ shardId: 'geofabrik-osm-kr', status: 'ready', sourceVersion: 'v1', failureCode: null });
    const catalog = [...stubCatalogShards, { id: 'geofabrik-osm-kr', countryCode: 'KR' }];
    const sources = stubSources(facts, {
      geoapify: { provider: 'geoapify', known: true, available: true, nextResetAt: null, revision: 'credential-v1' }
    });
    const initial = await computeQueueSnapshot({
      sources, catalogShards: catalog, queueState: { schemaVersion: 1, countries: {} }, now
    });
    const korea = initial.entries.find((entry) => entry.countryCode === 'KR');
    const snapshot = await computeQueueSnapshot({
      sources,
      catalogShards: catalog,
      queueState: { schemaVersion: 1, countries: { KR: { shards: {
        'korea-kapt-residential': {
          state: 'backoff', fingerprint: korea.failureFingerprints['korea-kapt-residential'],
          nextAttemptAt: '2026-08-02T11:00:00Z', consecutiveFailures: 1
        }
      } } } },
      now
    });
    expect(snapshot.entries.find((entry) => entry.countryCode === 'KR')).toMatchObject({
      state: 'queued', runnableShardId: 'geofabrik-osm-kr', quotaBound: false
    });
  });

  it('honours a latch only while the fingerprint matches and reflects the running job', async () => {
    const facts = stubFacts();
    const fingerprint = countryFingerprint({
      adapterRevisions: [['oa-nl', '']],
      sourceVersions: [['oa-nl', 'v1']]
    });
    const queueState = { schemaVersion: 1, countries: {
      NL: { shards: { 'oa-nl': {
        state: 'latched', latched: true, reason: 'source_limited_cache', fingerprint, latchedAt: '2026-08-01T00:00:00Z'
      } } }
    } };
    const latched = await computeQueueSnapshot({
      sources: stubSources(facts, {}), catalogShards: stubCatalogShards, queueState, now,
      runningJob: { id: 'sync-1', phase: 'build-and-publish', trigger: 'manual', shards: ['US'] }
    });
    const entries = Object.fromEntries(latched.entries.map((entry) => [entry.countryCode, entry]));
    expect(entries.NL).toMatchObject({ state: 'source_limited', reason: 'source_limited_cache' });
    expect(entries.US).toMatchObject({ state: 'running', jobId: 'sync-1', jobPhase: 'build-and-publish' });
    expect(latched.job).toMatchObject({ id: 'sync-1', shards: ['US'] });

    facts.shards.NL[0].sourceVersion = 'v2';
    const unlatched = await computeQueueSnapshot({
      sources: stubSources(facts, {}), catalogShards: stubCatalogShards, queueState, now
    });
    expect(unlatched.entries.find((entry) => entry.countryCode === 'NL').state).toBe('queued');
  });

  it('keeps a v2 country latch compatible without letting policy edits unlock it', async () => {
    const facts = stubFacts();
    const fingerprint = legacyCountryFingerprint({ sourceVersions: [['oa-nl', 'v1']] });
    const queueState = { schemaVersion: 1, countries: {
      NL: { state: 'latched', latched: true, reason: 'source_limited_cache', fingerprint }
    } };
    const first = await computeQueueSnapshot({
      sources: stubSources(facts, {}), catalogShards: stubCatalogShards, queueState, now
    });
    expect(first.entries.find((entry) => entry.countryCode === 'NL').state).toBe('source_limited');
    facts.policies.NL.updatedAt = 'policy-edited';
    const afterPolicyEdit = await computeQueueSnapshot({
      sources: stubSources(facts, {}), catalogShards: stubCatalogShards, queueState, now
    });
    expect(afterPolicyEdit.entries.find((entry) => entry.countryCode === 'NL').state).toBe('source_limited');
  });

  it('requeues a checked source when its opted-in extraction capability changes', async () => {
    const facts = stubFacts();
    const oldCatalog = [{
      id: 'oa-us', countryCode: 'US', source: { adapter: 'overture', capabilityInputs: { maxRecords: 15_000 } }
    }];
    const oldFingerprint = countryFingerprint({
      adapterRevisions: [['oa-us', sourceCapabilityRevision(oldCatalog[0])]],
      sourceVersions: [['oa-us', 'v1']]
    });
    const queueState = { schemaVersion: 1, countries: { US: { shards: {
      'oa-us': { state: 'checked', reason: 'source_version_checked', fingerprint: oldFingerprint,
        nextAttemptAt: '2026-08-20T00:00:00Z' }
    } } } };
    const currentCatalog = [{
      id: 'oa-us', countryCode: 'US', source: { adapter: 'overture', capabilityInputs: { maxRecords: 80_000 } }
    }];
    const snapshot = await computeQueueSnapshot({
      sources: stubSources(facts, {}), catalogShards: currentCatalog, queueState, now
    });
    expect(snapshot.entries.find((entry) => entry.countryCode === 'US')).toMatchObject({
      state: 'queued', runnableShardId: 'oa-us'
    });
  });

  it('resumes a due partial checkpoint without enabling periodic source probes', async () => {
    const facts = stubFacts();
    const shard = stubCatalogShards.find((candidate) => candidate.id === 'oa-us');
    const fingerprint = countryFingerprint({
      adapterRevisions: [['oa-us', sourceCapabilityRevision(shard)]],
      sourceVersions: [['oa-us', 'v1']]
    });
    const queueState = { schemaVersion: 1, countries: { US: { shards: {
      'oa-us': {
        state: 'checked', reason: 'source_partial_checkpoint', fingerprint,
        checkpointToken: 'checkpoint-1', nextAttemptAt: '2026-08-02T09:59:00Z'
      }
    } } } };

    const due = await computeQueueSnapshot({
      sources: stubSources(facts, {}), catalogShards: stubCatalogShards, queueState, now,
      enableSourceProbes: false
    });
    expect(due.entries.find((entry) => entry.countryCode === 'US')).toMatchObject({
      state: 'queued', runnableShardId: 'oa-us'
    });

    // A growth step runs the same source version again once its short wait is over.
    queueState.countries.US.shards['oa-us'] = { state: 'checked', reason: 'source_growth_step', fingerprint, nextAttemptAt: '2026-08-02T09:59:00Z' };
    expect((await computeQueueSnapshot({
      sources: stubSources(facts, {}), catalogShards: stubCatalogShards, queueState, now, enableSourceProbes: false
    })).entries.find((entry) => entry.countryCode === 'US')).toMatchObject({ state: 'queued', runnableShardId: 'oa-us' });
    queueState.countries.US.shards['oa-us'].nextAttemptAt = '2026-08-02T10:30:00Z';
    expect((await computeQueueSnapshot({
      sources: stubSources(facts, {}), catalogShards: stubCatalogShards, queueState, now, enableSourceProbes: false
    })).entries.find((entry) => entry.countryCode === 'US')).toMatchObject({ runnableShardId: null });

    queueState.countries.US.shards['oa-us'].reason = 'source_version_checked';
    const terminal = await computeQueueSnapshot({
      sources: stubSources(facts, {}), catalogShards: stubCatalogShards, queueState, now,
      enableSourceProbes: false
    });
    expect(terminal.entries.find((entry) => entry.countryCode === 'US')).toMatchObject({
      state: 'scheduled_wait', runnableShardId: null, reason: 'source_version_checked'
    });
  });

  it('keeps credential-wait checkpoints visible and resumes them as soon as quota becomes available', async () => {
    const facts = stubFacts();
    const shard = stubCatalogShards.find((candidate) => candidate.id === 'korea-kapt-residential');
    const fingerprint = countryFingerprint({
      adapterRevisions: [[shard.id, sourceCapabilityRevision(shard)]],
      sourceVersions: [[shard.id, 'v1']]
    });
    const queueState = { schemaVersion: 1, countries: { KR: { shards: {
      [shard.id]: {
        state: 'checked', reason: 'source_partial_checkpoint', waitReason: 'credential', fingerprint,
        checkpointToken: 'checkpoint-1', nextAttemptAt: '2026-09-01T00:00:00Z'
      }
    } } } };
    const waiting = await computeQueueSnapshot({
      sources: stubSources(facts, { geoapify: {
        provider: 'geoapify', known: true, available: false, waitState: 'quota_wait',
        nextResetAt: '2026-09-01T00:00:00Z', revision: 'credential-v1'
      } }),
      catalogShards: stubCatalogShards, queueState, now
    });
    expect(waiting.entries.find((entry) => entry.countryCode === 'KR')).toMatchObject({
      state: 'quota_wait', runnableShardId: shard.id, nextAttemptAt: '2026-09-01T00:00:00Z'
    });

    const ready = await computeQueueSnapshot({
      sources: stubSources(facts, { geoapify: {
        provider: 'geoapify', known: true, available: true, nextResetAt: null, revision: 'credential-v1'
      } }),
      catalogShards: stubCatalogShards, queueState, now
    });
    expect(ready.entries.find((entry) => entry.countryCode === 'KR')).toMatchObject({
      state: 'queued', runnableShardId: shard.id
    });
  });

  it('recovers a legacy Google quota checkpoint after its stale monthly wake time', async () => {
    const facts = stubFacts();
    facts.policies.IN = { enabled: true, targetCount: 8_000, updatedAt: 'p-in' };
    facts.counts.IN = 0;
    facts.shards.IN = [{ shardId: 'google-residential-enrichment-in', status: 'ready', sourceVersion: 'v1' }];
    facts.deficits.belowTarget.add('IN');
    const shard = {
      id: 'google-residential-enrichment-in', countryCode: 'IN', quotaProvider: 'google-geocoding',
      source: { adapter: 'google-residential-enrichment' }
    };
    const fingerprint = countryFingerprint({
      adapterRevisions: [[shard.id, sourceCapabilityRevision(shard)]],
      sourceVersions: [[shard.id, 'v1']]
    });
    const queueState = { schemaVersion: 1, countries: { IN: { shards: {
      [shard.id]: {
        state: 'checked', reason: 'source_partial_checkpoint', fingerprint,
        checkpointToken: 'google-checkpoint-1', nextAttemptAt: '2026-09-01T08:00:00Z'
      }
    } } } };
    const snapshot = await computeQueueSnapshot({
      sources: stubSources(facts, {
        'google-geocoding': { provider: 'google-geocoding', known: true, available: true, nextResetAt: null }
      }),
      catalogShards: [shard], queueState, now
    });
    expect(snapshot.entries.find((entry) => entry.countryCode === 'IN')).toMatchObject({
      state: 'queued', runnableShardId: shard.id, quotaAvailable: true
    });
    const waiting = await computeQueueSnapshot({
      sources: stubSources(facts, {
        'google-geocoding': {
          provider: 'google-geocoding', known: true, available: false,
          waitState: 'quota_wait', nextResetAt: '2026-09-01T08:00:00Z'
        }
      }),
      catalogShards: [shard], queueState, now
    });
    expect(waiting.entries.find((entry) => entry.countryCode === 'IN')).toMatchObject({
      state: 'quota_wait', runnableShardId: shard.id, quotaAvailable: false,
      nextAttemptAt: '2026-09-01T08:00:00Z'
    });
  });

  it('uses an available source instead of a different source waiting for quota', async () => {
    const facts = stubFacts();
    facts.policies.IN = { enabled: true, targetCount: 8_000, updatedAt: 'p-in' };
    facts.counts.IN = 0;
    facts.deficits.belowTarget.add('IN');
    const google = {
      id: 'google-residential-enrichment-in', countryCode: 'IN', quotaProvider: 'google-geocoding',
      source: { adapter: 'google-residential-enrichment', sourceVersion: 'google-v1' }
    };
    const mappls = {
      id: 'mappls-in-residential', countryCode: 'IN', quotaProvider: 'mappls',
      source: { adapter: 'mappls-residential', sourceVersion: 'mappls-v1' }
    };
    const googleFingerprint = countryFingerprint({
      adapterRevisions: [[google.id, sourceCapabilityRevision(google)]],
      sourceVersions: [[google.id, 'google-v1']]
    });
    const queueState = { schemaVersion: 1, countries: { IN: { shards: {
      [google.id]: {
        state: 'checked', reason: 'source_partial_checkpoint', waitReason: 'quota',
        fingerprint: googleFingerprint, checkpointToken: 'google-checkpoint-1',
        nextAttemptAt: '2026-09-01T08:00:00Z'
      }
    } } } };
    const snapshot = await computeQueueSnapshot({
      sources: stubSources(facts, {
        'google-geocoding': {
          provider: 'google-geocoding', known: true, available: false,
          waitState: 'quota_wait', nextResetAt: '2026-09-01T08:00:00Z'
        },
        mappls: { provider: 'mappls', known: true, available: true, nextResetAt: null }
      }),
      catalogShards: [google, mappls], queueState, now
    });
    expect(snapshot.entries.find((entry) => entry.countryCode === 'IN')).toMatchObject({
      state: 'queued', runnableShardId: mappls.id, quotaProvider: 'mappls', quotaAvailable: true
    });

    const mapplsFingerprint = countryFingerprint({
      adapterRevisions: [[mappls.id, sourceCapabilityRevision(mappls)]],
      sourceVersions: [[mappls.id, 'mappls-v1']]
    });
    queueState.countries.IN.shards[mappls.id] = {
      state: 'checked', reason: 'source_partial_checkpoint', fingerprint: mapplsFingerprint,
      checkpointToken: 'mappls-checkpoint-1', nextAttemptAt: '2026-08-02T10:01:00Z'
    };
    const delayed = await computeQueueSnapshot({
      sources: stubSources(facts, {
        'google-geocoding': {
          provider: 'google-geocoding', known: true, available: false,
          waitState: 'quota_wait', nextResetAt: '2026-09-01T08:00:00Z'
        },
        mappls: { provider: 'mappls', known: true, available: true, nextResetAt: null }
      }),
      catalogShards: [google, mappls], queueState, now
    });
    expect(delayed.entries.find((entry) => entry.countryCode === 'IN')).toMatchObject({
      state: 'retry_wait', runnableShardId: mappls.id, quotaProvider: 'mappls', quotaAvailable: true,
      nextAttemptAt: '2026-08-02T10:01:00.000Z'
    });
  });

  it('does not migrate an old Netherlands BAG latch across an adapter capability revision', async () => {
    const facts = stubFacts();
    facts.shards.NL = [{
      shardId: 'pdok-bag-nl-residential', status: 'ready',
      sourceVersion: '2026-08-01-strict-active-residential-coverage-round-robin-v1', failureCode: null
    }];
    const catalog = [{
      id: 'pdok-bag-nl-residential', countryCode: 'NL', source: { adapter: 'pdok-bag' }
    }];
    const queueState = { schemaVersion: 1, countries: { NL: {
      state: 'latched', latched: true, reason: 'source_limited_cache',
      fingerprint: legacyCountryFingerprint({ sourceVersions: [[
        'pdok-bag-nl-residential', '2026-08-01-strict-active-residential-coverage-round-robin-v1'
      ]] })
    } } };
    const snapshot = await computeQueueSnapshot({
      sources: stubSources(facts, {}), catalogShards: catalog, queueState, now
    });
    expect(snapshot.entries.find((entry) => entry.countryCode === 'NL')).toMatchObject({
      state: 'queued', runnableShardId: 'pdok-bag-nl-residential', legacyMigration: null
    });
  });

  it('runs only the changed source when another source in the country is exhausted', async () => {
    const facts = stubFacts();
    facts.shards.NL.push({ shardId: 'nl-new', status: 'ready', sourceVersion: 'v2', failureCode: null });
    const catalog = [...stubCatalogShards, { id: 'nl-new', countryCode: 'NL' }];
    const exhausted = countryFingerprint({ adapterRevisions: [['oa-nl', '']], sourceVersions: [['oa-nl', 'v1']] });
    const queueState = { schemaVersion: 1, countries: { NL: { shards: {
      'oa-nl': { state: 'latched', latched: true, reason: 'source_limited_cache', fingerprint: exhausted }
    } } } };
    const snapshot = await computeQueueSnapshot({
      sources: stubSources(facts, {}), catalogShards: catalog, queueState, now
    });
    expect(snapshot.entries.find((entry) => entry.countryCode === 'NL')).toMatchObject({
      state: 'queued', runnableShardId: 'nl-new'
    });
  });

  it('stops terminal failures for identical inputs and resumes after a source version change', async () => {
    const facts = stubFacts();
    const initial = await computeQueueSnapshot({
      sources: stubSources(facts, {}), catalogShards: stubCatalogShards,
      queueState: { schemaVersion: 1, countries: {} }, now
    });
    const nl = initial.entries.find((entry) => entry.countryCode === 'NL');
    const queueState = { schemaVersion: 1, countries: { NL: { shards: { 'oa-nl': {
      state: 'suspended', reason: 'retry_suspended', fingerprint: nl.failureFingerprints['oa-nl'],
      consecutiveFailures: 3, nextAttemptAt: null
    } } } } };
    const stopped = await computeQueueSnapshot({
      sources: stubSources(facts, {}), catalogShards: stubCatalogShards, queueState, now
    });
    expect(stopped.entries.find((entry) => entry.countryCode === 'NL')).toMatchObject({
      state: 'suspended', reason: 'retry_suspended', nextAttemptAt: null
    });
    facts.shards.NL[0].sourceVersion = 'v2';
    const resumed = await computeQueueSnapshot({
      sources: stubSources(facts, {}), catalogShards: stubCatalogShards, queueState, now
    });
    expect(resumed.entries.find((entry) => entry.countryCode === 'NL')).toMatchObject({
      state: 'queued', runnableShardId: 'oa-nl', consecutiveFailures: 0
    });
  });

  it('selectively releases JP and KR suspended materialize failures while keeping exhausted sources terminal', async () => {
    const facts = stubFacts();
    facts.policies.JP = { enabled: true, targetCount: 20_000, updatedAt: 'p-jp' };
    facts.counts.JP = 19_533;
    facts.deficits.belowTarget.add('JP');
    facts.shards.JP = [{ shardId: 'japan-abr-residential', status: 'ready', sourceVersion: 'v1', failureCode: null }];
    const catalog = [...stubCatalogShards, {
      id: 'japan-abr-residential', countryCode: 'JP', source: { adapter: 'japan-abr' }
    }];
    const initial = await computeQueueSnapshot({
      sources: stubSources(facts, {}), catalogShards: catalog,
      queueState: { schemaVersion: 1, countries: {} }, now
    });
    const jp = initial.entries.find((entry) => entry.countryCode === 'JP');
    const oldFailure = executionFailureFingerprint(jp.sourceFingerprints['japan-abr-residential'], '', 'materialize');
    const exhausted = countryFingerprint({ adapterRevisions: [['oa-nl', '']], sourceVersions: [['oa-nl', 'v1']] });
    const resumed = await computeQueueSnapshot({
      sources: stubSources(facts, {}), catalogShards: catalog,
      queueState: { schemaVersion: 1, countries: { JP: { shards: {
        'japan-abr-residential': { state: 'suspended', fingerprint: oldFailure, consecutiveFailures: 2 }
      } }, NL: { shards: {
        'oa-nl': { state: 'latched', latched: true, fingerprint: exhausted }
      } } } }, now
    });
    expect(resumed.entries.find((entry) => entry.countryCode === 'JP')).toMatchObject({
      state: 'queued', runnableShardId: 'japan-abr-residential'
    });
    expect(resumed.entries.find((entry) => entry.countryCode === 'NL')).toMatchObject({
      state: 'source_limited'
    });
  });
});

describe('queue engine', () => {
  const fakeCoordinator = () => {
    const coordinator = {
      currentJob: null,
      calls: [],
      jobStatus: 'succeeded',
      trigger: async (trigger, { shards }) => {
        coordinator.calls.push({ trigger, shards });
        return { accepted: true, job: { id: `sync-${coordinator.calls.length}` } };
      },
      waitForIdle: async () => {},
      sourceOutcomes: [],
      getJob: async (id) => ({ id, status: coordinator.jobStatus, sourceOutcomes: coordinator.sourceOutcomes })
    };
    return coordinator;
  };

  it('recovers an unapplied terminal history outcome before dispatching more work', async () => {
    const facts = stubFacts();
    facts.policies = { NL: facts.policies.NL };
    facts.counts = { NL: facts.counts.NL };
    facts.deficits.belowTarget = new Set(['NL']);
    facts.shards = { NL: facts.shards.NL };
    const coordinator = fakeCoordinator();
    const history = {
      schedulerHeartbeat: vi.fn(async () => {}),
      pendingSourceStateApplications: vi.fn(async () => [{
        run_id: 'sync-crash-window', country_code: 'NL', source_id: 'oa-nl', status: 'succeeded',
        completed_at: '2026-08-02T09:00:00Z', net_growth: 0,
        before_goals_json: '{}', after_goals_json: '{}', source_complete: 1,
        error_code: null, error_message: null, failure_phase: null
      }]),
      markSourceStateApplied: vi.fn(async () => {})
    };
    const queue = createSyncQueue({
      environment: {}, coordinator, history, stateDir: stateDir(), sources: stubSources(facts, {}),
      loadCatalog: async () => ({ shards: [{ id: 'oa-nl', countryCode: 'NL' }] }),
      now: () => new Date('2026-08-02T10:00:00Z'), cooldownMs: 0,
      log: { log: () => {}, error: () => {} }
    });

    await queue.tick();
    expect(coordinator.calls).toHaveLength(0);
    expect((await queue.store.load()).countries.NL.shards['oa-nl']).toMatchObject({ state: 'latched' });
    expect(history.markSourceStateApplied).toHaveBeenCalledWith({
      runId: 'sync-crash-window', countryCode: 'NL', sourceId: 'oa-nl', appliedAt: '2026-08-02T09:00:00Z'
    });
  });

  it('checks for newly pending terminal outcomes on every tick and ignores stale fingerprints', async () => {
    const facts = stubFacts();
    facts.policies = { NL: facts.policies.NL };
    facts.counts = { NL: facts.counts.NL };
    facts.deficits.belowTarget = new Set(['NL']);
    facts.shards = { NL: facts.shards.NL };
    const coordinator = fakeCoordinator();
    let recoveryPass = 0;
    const history = {
      schedulerHeartbeat: vi.fn(async () => {}),
      pendingSourceStateApplications: vi.fn(async () => {
        recoveryPass += 1;
        if (recoveryPass === 1) return [];
        return [{
          run_id: 'stale-run', country_code: 'NL', source_id: 'oa-nl', status: 'succeeded',
          completed_at: '2026-08-02T09:30:00Z', net_growth: 0,
          before_goals_json: '{}', after_goals_json: '{}', source_complete: 1,
          source_fingerprint: 'stale-source-fingerprint', checkpoint_token: null,
          error_code: null, error_message: null, failure_phase: null
        }];
      }),
      markSourceStateApplied: vi.fn(async () => {})
    };
    const queue = createSyncQueue({
      environment: {}, coordinator, history, stateDir: stateDir(), sources: stubSources(facts, {}),
      loadCatalog: async () => ({ shards: [{ id: 'oa-nl', countryCode: 'NL' }] }),
      now: () => new Date('2026-08-02T10:00:00Z'), cooldownMs: 0,
      log: { log: () => {}, error: () => {} }
    });
    const currentFingerprint = countryFingerprint({
      adapterRevisions: [['oa-nl', '']], sourceVersions: [['oa-nl', 'v1']]
    });
    await queue.store.apply('NL', {
      action: 'checked', fingerprint: currentFingerprint, nextAttemptAt: '2026-08-03T10:00:00Z'
    }, '2026-08-02T09:00:00Z', 'oa-nl');

    await queue.tick();
    await queue.tick();

    expect(history.pendingSourceStateApplications).toHaveBeenCalledTimes(2);
    expect(history.markSourceStateApplied).toHaveBeenCalledWith({
      runId: 'stale-run', countryCode: 'NL', sourceId: 'oa-nl', appliedAt: '2026-08-02T09:30:00Z'
    });
    expect((await queue.store.load()).countries.NL.shards['oa-nl']).toMatchObject({
      state: 'checked', fingerprint: currentFingerprint
    });
    expect(coordinator.calls).toHaveLength(0);
  });

  it('recovers a successful upstream version upgrade without repeating the completed source', async () => {
    const facts = stubFacts();
    facts.policies = { NL: facts.policies.NL };
    facts.counts = { NL: facts.counts.NL };
    facts.deficits.belowTarget = new Set(['NL']);
    facts.shards = { NL: [{ shardId: 'oa-nl', status: 'ready', sourceVersion: 'v2', failureCode: null }] };
    const coordinator = fakeCoordinator();
    const history = {
      schedulerHeartbeat: vi.fn(async () => {}),
      pendingSourceStateApplications: vi.fn(async () => [{
        run_id: 'upstream-upgrade', country_code: 'NL', source_id: 'oa-nl', status: 'succeeded',
        completed_at: '2026-08-02T09:30:00Z', net_growth: 100,
        before_goals_json: '{}', after_goals_json: '{}', source_complete: 1,
        source_fingerprint: countryFingerprint({ adapterRevisions: [['oa-nl', '']], sourceVersions: [['oa-nl', 'v1']] }),
        source_version_before: 'v1', source_version_after: 'v2', adapter_revision: '', checkpoint_token: null,
        error_code: null, error_message: null, failure_phase: null
      }]),
      markSourceStateApplied: vi.fn(async () => {})
    };
    const queue = createSyncQueue({
      environment: {}, coordinator, history, stateDir: stateDir(), sources: stubSources(facts, {}),
      loadCatalog: async () => ({ shards: [{ id: 'oa-nl', countryCode: 'NL' }] }),
      now: () => new Date('2026-08-02T10:00:00Z'), cooldownMs: 0,
      log: { log: () => {}, error: () => {} }
    });

    await queue.tick();

    expect(coordinator.calls).toHaveLength(0);
    expect((await queue.store.load()).countries.NL.shards['oa-nl']).toMatchObject({
      state: 'checked', fingerprint: countryFingerprint({
        adapterRevisions: [['oa-nl', '']], sourceVersions: [['oa-nl', 'v2']]
      })
    });
    expect(history.markSourceStateApplied).toHaveBeenCalledTimes(1);
  });

  it('consumes terminal history for a source that no longer exists', async () => {
    const facts = stubFacts();
    facts.policies = { NL: facts.policies.NL };
    facts.counts = { NL: facts.counts.NL };
    facts.deficits.belowTarget = new Set(['NL']);
    facts.shards = { NL: [] };
    const coordinator = fakeCoordinator();
    const history = {
      schedulerHeartbeat: vi.fn(async () => {}),
      pendingSourceStateApplications: vi.fn(async () => [{
        run_id: 'removed-source-run', country_code: 'NL', source_id: 'removed-source', status: 'failed',
        completed_at: '2026-08-02T09:30:00Z', net_growth: 0,
        before_goals_json: '{}', after_goals_json: '{}', source_complete: 1,
        error_code: 'SYNC_JOB_INTERRUPTED', error_message: null, failure_phase: 'interrupted'
      }]),
      markSourceStateApplied: vi.fn(async () => {})
    };
    const queue = createSyncQueue({
      environment: {}, coordinator, history, stateDir: stateDir(), sources: stubSources(facts, {}),
      loadCatalog: async () => ({ shards: [] }), now: () => new Date('2026-08-02T10:00:00Z'),
      cooldownMs: 0, log: { log: () => {}, error: () => {} }
    });

    await queue.tick();

    expect(history.markSourceStateApplied).toHaveBeenCalledWith({
      runId: 'removed-source-run', countryCode: 'NL', sourceId: 'removed-source', appliedAt: '2026-08-02T09:30:00Z'
    });
    expect(coordinator.calls).toHaveLength(0);
  });

  it('migrates a legacy country latch to the most recently executed source shard', async () => {
    const facts = stubFacts();
    facts.deficits.belowTarget = new Set(['NL']);
    facts.shards.NL.push({
      shardId: 'nl-secondary', status: 'ready', sourceVersion: 'v1', failureCode: null,
      updatedAt: '2026-08-01T00:00:00Z'
    });
    facts.shards.NL[0].updatedAt = '2026-08-02T00:00:00Z';
    const catalog = [...stubCatalogShards, { id: 'nl-secondary', countryCode: 'NL' }];
    const queue = createSyncQueue({
      environment: {}, coordinator: fakeCoordinator(), stateDir: stateDir(),
      sources: stubSources(facts, {}), loadCatalog: async () => ({ shards: catalog }),
      cooldownMs: 0, log: { log: () => {}, error: () => {} }
    });
    await queue.store.save({ schemaVersion: 1, countries: { NL: {
      state: 'latched', latched: true, reason: 'source_limited_cache',
      fingerprint: legacyCountryFingerprint({ sourceVersions: [['oa-nl', 'v1'], ['nl-secondary', 'v1']] })
    } } });
    const snapshot = await queue.snapshot();
    expect(snapshot.entries.find((entry) => entry.countryCode === 'NL')).toMatchObject({
      state: 'queued', runnableShardId: 'nl-secondary'
    });
    const migrated = (await queue.store.load()).countries.NL;
    expect(migrated.latched).toBeUndefined();
    expect(Object.keys(migrated.shards)).toEqual(['oa-nl']);
    expect(migrated.shards['oa-nl']).toMatchObject({ state: 'latched', latched: true });
  });

  it('runs the deepest deficit, latches a fruitless country, and unlatches on a source change', async () => {
    const facts = stubFacts();
    facts.deficits.belowTarget = new Set(['NL']);
    const coordinator = fakeCoordinator();
    const queue = createSyncQueue({
      environment: {},
      coordinator,
      stateDir: stateDir(),
      sources: stubSources(facts, {}),
      loadCatalog: async () => ({ shards: stubCatalogShards }),
      cooldownMs: 0,
      log: { log: () => {}, error: () => {} }
    });

    expect(await queue.tick()).toBe(0);
    expect(coordinator.calls).toEqual([{ trigger: 'queue', shards: ['oa-nl'] }]);
    const state = await queue.store.load();
    expect(state.countries.NL.shards['oa-nl']).toMatchObject({ latched: true, reason: 'source_limited_cache' });

    const idle = await queue.tick();
    expect(coordinator.calls).toHaveLength(1);
    expect(idle).toBeGreaterThan(0);
    expect((await queue.snapshot()).entries.find((entry) => entry.countryCode === 'NL').state).toBe('source_limited');

    facts.shards.NL[0].sourceVersion = 'v3';
    expect((await queue.snapshot()).entries.find((entry) => entry.countryCode === 'NL').state).toBe('queued');
    await queue.tick();
    expect(coordinator.calls).toHaveLength(2);
  });

  it('defers a country whose imported rows are still waiting for publication', async () => {
    const facts = stubFacts();
    facts.deficits.belowTarget = new Set(['NL']);
    const coordinator = fakeCoordinator();
    let backlog = 20_001;
    const log = { log: vi.fn(), error: () => {} };
    const queue = createSyncQueue({
      environment: {}, coordinator, stateDir: stateDir(),
      sources: { ...stubSources(facts, {}), unpublishedBacklog: async () => backlog },
      loadCatalog: async () => ({ shards: stubCatalogShards }), cooldownMs: 0, log, backlogDeferMs: 60_000
    });
    await queue.tick();
    expect(coordinator.calls).toEqual([]);
    expect(log.log).toHaveBeenCalledWith('[sync-queue] NL deferred unpublished=20001');
    backlog = 20_000;
    await queue.tick();
    expect(coordinator.calls).toEqual([]);
    const later = createSyncQueue({
      environment: {}, coordinator, stateDir: stateDir(),
      sources: { ...stubSources(facts, {}), unpublishedBacklog: async () => backlog },
      loadCatalog: async () => ({ shards: stubCatalogShards }), cooldownMs: 0, log: { log: () => {}, error: () => {} }
    });
    await later.tick();
    expect(coordinator.calls).toEqual([{ trigger: 'queue', shards: ['oa-nl'] }]);
  });

  it('backs off after a transient failure and checks the current source after growth', async () => {
    const facts = stubFacts();
    facts.deficits.belowTarget = new Set(['US']);
    const coordinator = fakeCoordinator();
    coordinator.jobStatus = 'failed';
    const queue = createSyncQueue({
      environment: {},
      coordinator,
      stateDir: stateDir(),
      sources: stubSources(facts, {}),
      loadCatalog: async () => ({ shards: stubCatalogShards }),
      cooldownMs: 0,
      log: { log: () => {}, error: () => {} }
    });
    await queue.tick();
    const afterFailure = await queue.store.load();
    expect(afterFailure.countries.US.shards['oa-us']).toMatchObject({ latched: false, consecutiveFailures: 1 });
    const entry = (await queue.snapshot()).entries.find((value) => value.countryCode === 'US');
    expect(entry.state).toBe('retry_wait');
    expect(entry.reason).toBe('retry_backoff');
    expect(Date.parse(entry.nextAttemptAt)).toBeGreaterThan(Date.now());
    expect(entry.position).toBeNull();

    coordinator.jobStatus = 'succeeded';
    coordinator.trigger = async (trigger, { shards }) => {
      coordinator.calls.push({ trigger, shards });
      facts.counts.US += 40;
      facts.rules.US.total.current += 40;
      coordinator.sourceOutcomes = [{ shardId: 'oa-us', status: 'imported', netGrowth: 40, changedCount: 40 }];
      return { accepted: true, job: { id: 'sync-growth' } };
    };
    // Force the retry to be due immediately.
    await queue.store.apply('US', {
      action: 'backoff', consecutiveFailures: 1, fingerprint: afterFailure.countries.US.shards['oa-us'].fingerprint,
      nextAttemptAt: new Date(Date.now() - 1000).toISOString()
    }, new Date().toISOString(), 'oa-us');
    await queue.tick();
    expect((await queue.store.load()).countries.US.shards['oa-us']).toMatchObject({
      state: 'checked', reason: 'source_version_checked', consecutiveFailures: 0
    });
    expect((await queue.snapshot()).entries.find((value) => value.countryCode === 'US'))
      .toMatchObject({ state: 'scheduled_wait', reason: 'source_version_checked' });
  });

  it('latches a source whose own import added nothing while translations raised the country total', async () => {
    const facts = stubFacts();
    facts.deficits.belowTarget = new Set(['US']);
    const coordinator = fakeCoordinator();
    coordinator.trigger = async (trigger, { shards }) => {
      coordinator.calls.push({ trigger, shards });
      facts.counts.US += 40;
      facts.rules.US.total.current += 40;
      coordinator.sourceOutcomes = [{ shardId: 'oa-us', status: 'unchanged', netGrowth: 0, changedCount: 0 }];
      return { accepted: true, job: { id: 'sync-background-growth' } };
    };
    const queue = createSyncQueue({
      environment: {}, coordinator, stateDir: stateDir(), sources: stubSources(facts, {}),
      loadCatalog: async () => ({ shards: stubCatalogShards }), cooldownMs: 0, log: { log: () => {}, error: () => {} }
    });
    await queue.tick();
    expect((await queue.store.load()).countries.US.shards['oa-us']).toMatchObject({ latched: true });
  });

  it('opens a country-adapter circuit after two shards hit the same systemic failure', async () => {
    const facts = stubFacts();
    facts.deficits.belowTarget = new Set(['US']);
    facts.shards.US = ['us-a', 'us-b', 'us-c'].map((shardId) => ({
      shardId, status: 'ready', sourceVersion: 'v1', failureCode: null
    }));
    const catalog = ['us-a', 'us-b', 'us-c'].map((id) => ({
      id, countryCode: 'US', source: { adapter: 'geofabrik' }
    }));
    const coordinator = fakeCoordinator();
    coordinator.jobStatus = 'failed';
    coordinator.getJob = async (id) => ({
      id, status: 'failed', errorCode: '57014', error: 'canceling statement due to statement timeout',
      failurePhase: 'import'
    });
    const queue = createSyncQueue({
      environment: {}, coordinator, stateDir: stateDir(), sources: stubSources(facts, {}),
      loadCatalog: async () => ({ shards: catalog }), cooldownMs: 0,
      log: { log: () => {}, error: () => {} }
    });

    await queue.tick();
    await queue.tick();

    expect(coordinator.calls.map(({ shards }) => shards[0])).toEqual(['us-a', 'us-b']);
    expect((await queue.snapshot()).entries.find(({ countryCode }) => countryCode === 'US'))
      .toMatchObject({ state: 'suspended', reason: 'shared_failure_circuit' });
    const states = (await queue.store.load()).countries.US.shards;
    expect(Object.fromEntries(Object.entries(states).map(([id, state]) => [id, state.state])))
      .toEqual({ 'us-a': 'suspended', 'us-b': 'suspended', 'us-c': 'suspended' });
  });

  it('updates exact-source history only after the queue confirms quota exhaustion', async () => {
    const facts = stubFacts();
    facts.deficits.belowTarget = new Set(['KR']);
    let quotaAvailable = true;
    const historyCalls = [];
    const coordinator = fakeCoordinator();
    coordinator.jobStatus = 'failed';
    coordinator.trigger = async (trigger, { shards }) => {
      coordinator.calls.push({ trigger, shards });
      quotaAvailable = false;
      return { accepted: true, job: { id: 'sync-quota' } };
    };
    coordinator.getJob = async () => ({
      id: 'sync-quota', status: 'failed', errorCode: 'SOURCE_CREDENTIAL_UNAVAILABLE'
    });
    const queue = createSyncQueue({
      environment: {}, coordinator, stateDir: stateDir(),
      sources: {
        ...stubSources(facts, {}),
        quotaStatus: async () => ({
          provider: 'geoapify', known: true, available: quotaAvailable,
          nextResetAt: '2026-08-03T00:03:00Z'
        })
      },
      history: {
        schedulerHeartbeat: async () => {},
        pauseForQuota: async (value) => { historyCalls.push(value); }
      },
      loadCatalog: async () => ({ shards: stubCatalogShards }),
      cooldownMs: 0,
      log: { log: () => {}, error: () => {} }
    });
    await queue.tick();
    expect(historyCalls).toEqual([{
      runId: 'sync-quota', countryCode: 'KR', sourceId: 'korea-kapt-residential'
    }]);
  });

  it('repairs a pre-deployment quota failure from the confirmed queue snapshot', async () => {
    const facts = stubFacts();
    facts.deficits.belowTarget = new Set(['KR']);
    const repairs = [];
    const queue = createSyncQueue({
      environment: {}, coordinator: fakeCoordinator(), stateDir: stateDir(),
      sources: stubSources(facts, {
        geoapify: {
          provider: 'geoapify', known: true, available: false,
          nextResetAt: '2026-08-03T00:03:00Z'
        }
      }),
      history: {
        schedulerHeartbeat: async () => {},
        repairQuotaWait: async (value) => { repairs.push(value); }
      },
      loadCatalog: async () => ({ shards: stubCatalogShards }),
      cooldownMs: 0,
      log: { log: () => {}, error: () => {} }
    });
    expect(await queue.tick()).toBeGreaterThan(0);
    expect(repairs).toEqual([{ countryCode: 'KR', sourceId: 'korea-kapt-residential' }]);
  });
});

describe('China queue priority', () => {
  it('does not block generic work before the independent China runtime initializes', async () => {
    const database = openTestDatabase();
    await database.prepare(`INSERT INTO sync_country_policies(
      country_code,enabled,target_count,level1_limit,level2_limit,level3_limit,level4_limit,updated_at
    ) VALUES ('CN',1,1,10,10,10,10,'2026-08-02T00:00:00Z')`).run();
    const sources = createQueueSources({ addressDatabase: database });
    await expect(sources.chinaPriority(new Date('2026-08-02T10:00:00Z'))).resolves.toMatchObject({
      blocksQueue: false,
      executionState: 'uninitialized'
    });
    database.close();
  });

  it('rotates China with other countries once its original volume goal and coverage are met', async () => {
    const database = openTestDatabase();
    await database.prepare(`INSERT INTO sync_country_policies(
      country_code,enabled,target_count,level1_limit,level2_limit,level3_limit,level4_limit,coverage_ratio,updated_at
    ) VALUES ('CN',1,1000000000,0,0,0,0,0,'2026-08-02T00:00:00Z')`).run();
    await database.prepare(`INSERT INTO sync_country_state(country_code,address_count,updated_at)
      VALUES ('CN',?,'2026-08-02T00:00:00Z')`).bind(CHINA_PRIORITY_TARGET).run();
    await database.prepare(`INSERT INTO sync_country_runtime(country_code,goal_state,execution_state,updated_at)
      VALUES ('CN','incomplete','below_target','2026-08-02T00:00:00Z')`).run();
    const sources = createQueueSources({ addressDatabase: database });
    await expect(sources.chinaPriority(new Date('2026-08-02T10:00:00Z'))).resolves.toMatchObject({ blocksQueue: false });
    await database.prepare("UPDATE sync_country_state SET address_count=? WHERE country_code='CN'").bind(CHINA_PRIORITY_TARGET - 1).run();
    await expect(sources.chinaPriority(new Date('2026-08-02T10:00:00Z'))).resolves.toMatchObject({ blocksQueue: true });
    database.close();
  });
});

describe('queue provider configuration', () => {
  it('surfaces database failures instead of projecting an empty queue or a missing key', async () => {
    const failure = Object.assign(new Error('fixture database unavailable'), { code: 'ECONNRESET' });
    const database = { prepare: () => { throw failure; } };
    const sources = createQueueSources({ addressDatabase: database, controlDatabase: database });
    await expect(sources.addressFacts()).rejects.toBe(failure);
    await expect(sources.quotaStatus('geoapify')).rejects.toBe(failure);
  });

  it('blocks an unconfigured Geoapify source instead of attempting it', async () => {
    const database = openTestDatabase();
    await initializeTestDatabase(database, new URL('../server/control/schema.sql', import.meta.url));
    const sources = createQueueSources({
      addressDatabase: database,
      controlDatabase: database,
      environment: {}
    });
    await expect(sources.quotaStatus('geoapify', new Date('2026-08-02T10:00:00Z'))).resolves.toMatchObject({
      known: false,
      available: false,
      waitState: 'blocked',
      reason: 'missing_api_key:geoapify'
    });
    await database.close();
  });

  it('blocks an unconfigured OneMap source with an explicit missing-key reason', async () => {
    const database = openTestDatabase();
    await initializeTestDatabase(database, new URL('../server/control/schema.sql', import.meta.url));
    const sources = createQueueSources({
      addressDatabase: database,
      controlDatabase: database,
      environment: {}
    });
    await expect(sources.quotaStatus('onemap', new Date('2026-08-02T10:00:00Z'))).resolves.toMatchObject({
      known: false,
      available: false,
      waitState: 'blocked',
      reason: 'missing_api_key:onemap'
    });
    await database.close();
  });

  it('blocks an unconfigured Google Geocoding source with an explicit missing-key reason', async () => {
    const database = openTestDatabase();
    await initializeTestDatabase(database, new URL('../server/control/schema.sql', import.meta.url));
    const sources = createQueueSources({
      addressDatabase: database,
      controlDatabase: database,
      environment: {}
    });
    await expect(sources.quotaStatus('google-geocoding', new Date('2026-08-02T10:00:00Z'))).resolves.toMatchObject({
      known: false,
      available: false,
      waitState: 'blocked',
      reason: 'missing_api_key:google-geocoding'
    });
    await database.close();
  });

  it('does not dispatch numbered environment credentials before the API imports them', async () => {
    const database = openTestDatabase();
    await initializeTestDatabase(database, new URL('../server/control/schema.sql', import.meta.url));
    const sources = createQueueSources({
      addressDatabase: database,
      controlDatabase: database,
      environment: { GEOAPIFY_API_KEY_2: 'fixture-key' }
    });
    await expect(sources.quotaStatus('geoapify', new Date('2026-08-02T10:00:00Z'))).resolves.toMatchObject({
      available: false,
      waitState: 'blocked',
      reason: 'credential_import_pending:geoapify'
    });
    await database.close();
  });

  it('does not dispatch a source whose required API key is missing', async () => {
    const facts = stubFacts();
    facts.policies = { KR: facts.policies.KR };
    facts.counts = { KR: facts.counts.KR };
    facts.shards = { KR: facts.shards.KR };
    facts.deficits = { belowTarget: new Set(['KR']), belowFloor: new Set() };
    const coordinator = {
      currentJob: null,
      calls: [],
      trigger: async (trigger, { shards }) => {
        coordinator.calls.push({ trigger, shards });
        return { accepted: true, job: { id: 'unexpected' } };
      },
      waitForIdle: async () => {},
      getJob: async () => null
    };
    const onIdle = vi.fn(async () => {});
    const queue = createSyncQueue({
      environment: {}, coordinator, stateDir: stateDir(),
      sources: stubSources(facts, {
        geoapify: {
          provider: 'geoapify', known: false, available: false,
          nextResetAt: null, waitState: 'blocked', reason: 'missing_api_key:geoapify'
        }
      }),
      loadCatalog: async () => ({ shards: [stubCatalogShards[2]] }),
      onIdle,
      cooldownMs: 0,
      log: { log: () => {}, error: () => {} }
    });
    await queue.tick();
    expect(coordinator.calls).toEqual([]);
    expect(onIdle).toHaveBeenCalledOnce();
  });

  it('runs artifact cleanup after a recovered job becomes idle', async () => {
    const coordinator = {
      currentJob: { id: 'recovered-job' },
      waitForIdle: async () => { coordinator.currentJob = null; }
    };
    const onIdle = vi.fn(async () => {});
    const queue = createSyncQueue({
      environment: {}, coordinator, stateDir: stateDir(), sources: stubSources(stubFacts(), {}),
      loadCatalog: async () => ({ shards: stubCatalogShards }), onIdle,
      log: { log: () => {}, error: () => {} }
    });

    await queue.tick();

    expect(onIdle).toHaveBeenCalledOnce();
  });
});

describe('queue state store', () => {
  it('persists latches across instances and clears on requeue', async () => {
    const directory = stateDir();
    await mkdir(directory, { recursive: true });
    const file = resolve(directory, 'queue-state.json');
    const store = new QueueStateStore(file);
    await store.apply('NG', { action: 'latch', reason: 'source_limited_cache', fingerprint: 'fp-ng' }, '2026-08-02T00:00:00Z');
    const reloaded = new QueueStateStore(file);
    expect((await reloaded.load()).countries.NG).toMatchObject({ latched: true, fingerprint: 'fp-ng' });
    await reloaded.apply('NG', { action: 'requeue' }, '2026-08-02T01:00:00Z');
    expect((await store.load()).countries.NG).toBeUndefined();
  });

  it('fails closed instead of treating a corrupt queue state file as empty', async () => {
    const directory = stateDir();
    await mkdir(directory, { recursive: true });
    const file = resolve(directory, 'queue-state.json');
    await writeFile(file, '{"schemaVersion":1,');
    await expect(new QueueStateStore(file).load()).rejects.toMatchObject({ code: 'QUEUE_STATE_INVALID' });
    expect(await readFile(file, 'utf8')).toBe('{"schemaVersion":1,');
  });
});

describe('queue API endpoint', () => {
  it('requires the admin bearer token and returns queue entries', async () => {
    const api = createSyncApi({
      coordinator: {},
      token: 'queue-token',
      queue: { snapshot: async () => ({
        generatedAt: '2026-08-02T10:00:00.000Z',
        job: null,
        entries: [{ countryCode: 'US', state: 'queued', position: 1, nextAttemptAt: null, reason: null, deficit: 62, target: 50_000, current: 49_938 }]
      }) }
    });
    const denied = await api(new Request('http://sync.test/api/v1/sync/queue'));
    expect(denied.status).toBe(401);
    const response = await api(new Request('http://sync.test/api/v1/sync/queue', {
      headers: { Authorization: 'Bearer queue-token' }
    }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.entries).toEqual([expect.objectContaining({
      countryCode: 'US', state: 'queued', position: 1, deficit: 62, target: 50_000, current: 49_938
    })]);
  });

  it('reports the queue as unavailable when no engine is attached', async () => {
    const api = createSyncApi({ coordinator: {}, token: 'queue-token' });
    const response = await api(new Request('http://sync.test/api/v1/sync/queue', {
      headers: { Authorization: 'Bearer queue-token' }
    }));
    expect(response.status).toBe(503);
  });
});

describe('queue admin surface structure', () => {
  const adminSource = ['src/components/SyncAdmin.tsx', ...readdirSync('src/components/admin').map((file) => `src/components/admin/${file}`)]
    .map((file) => readFileSync(file, 'utf8')).join('\n');
  const adminApiSource = readFileSync('server/control/admin-api.ts', 'utf8');
  it('merges the queue into the country workspace with visibility-aware polling', () => {
    expect(adminSource).toContain('export function CountryWorkspace');
    expect(adminSource).toContain("request<SyncQueueData>('/sync/queue'");
    expect(adminSource).toContain('queue-row');
    expect(adminSource).toContain("if (value === 'syncQueue') return 'addressData';");
    expect(adminSource).not.toContain("if (view === 'syncQueue')");
    expect(adminSource).not.toContain('SyncQueuePanel');
    expect(adminSource).toContain("queueTitle: '同步队列'");
    expect(adminSource).toContain("queueTitle: 'Sync queue'");
    expect(adminSource).toContain("if (code === 'missing_api_key')");
    expect(adminSource).toContain("total: '国家总量'");
    expect(adminSource).toContain("coverage: '行政区覆盖'");
    expect(adminSource).toContain("minimums: '层级/节点最低数量'");
    expect(adminSource).toContain('rules.administrativeCoverage');
    expect(adminSource).toContain('rules.regionalMinimums');
    expect(adminSource).toContain("'administrative_coverage'");
    expect(adminSource).toContain("'regional_minimums'");
    expect(adminSource).toContain('ui.queueStale');
    expect(adminSource.match(/queueTitle:/gu)).toHaveLength(10);
    expect(adminSource.match(/queueResetIn:/gu)).toHaveLength(10);
  });
  it('reads the published queue snapshot from the database with the CN worker row merged', () => {
    expect(adminApiSource).toContain("app.get('/admin/api/sync/queue'");
    expect(adminApiSource).toContain('SELECT queue_snapshot_json,queue_snapshot_at FROM sync_scheduler_state');
    expect(adminApiSource).toContain('if (!row?.queue_snapshot_json) return fetchSyncQueueUpstream();');
    expect(adminApiSource).toContain("engine: 'china-worker'");
    expect(adminApiSource).toContain('rules: goal.rules');
    expect(adminApiSource).toContain('rules: countryGoal.rules');
    expect(adminApiSource).toContain("'missing_api_key:china_maps'");
  });
});
