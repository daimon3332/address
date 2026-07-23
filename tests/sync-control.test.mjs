import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSyncApi } from '../server/sync/api.mjs';
import { SyncCoordinator } from '../server/sync/coordinator.mjs';
import { createSyncRuntime } from '../server/sync/index.mjs';
import { runAddressSync } from '../server/sync/run-address-sync.mjs';
import { nextRunAt, triggerDailySync, triggerInitialSync, triggerStartupSync } from '../server/sync/scheduler.mjs';

const testDirectories = [];
const testStateDir = () => {
  const directory = resolve('.data-cache', 'sync-control-tests', randomUUID());
  testDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(testDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const deferred = () => {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
};

describe('address sync coordinator', () => {
  it('persists task status and rejects concurrent manual runs', async () => {
    const execution = deferred();
    const coordinator = new SyncCoordinator({
      stateDir: testStateDir(),
      now: () => new Date('2026-07-16T03:00:00.000Z'),
      idFactory: () => 'job-a',
      runSync: () => execution.promise
    });

    const first = await coordinator.trigger('manual');
    const second = await coordinator.trigger('manual');
    expect(first.accepted).toBe(true);
    expect(second).toMatchObject({ accepted: false, job: { id: first.job.id } });

    execution.resolve({ releaseId: 'release-a' });
    await coordinator.waitForIdle();
    await expect(coordinator.getJob(first.job.id)).resolves.toMatchObject({
      status: 'succeeded',
      phase: 'published',
      releaseId: 'release-a',
      trigger: 'manual'
    });
  });

  it('stores failures as terminal task state', async () => {
    const coordinator = new SyncCoordinator({
      stateDir: testStateDir(),
      idFactory: () => 'job-b',
      runSync: async () => { throw new Error('candidate validation failed'); }
    });
    const result = await coordinator.trigger('scheduled');
    await coordinator.waitForIdle();
    await expect(coordinator.getJob(result.job.id)).resolves.toMatchObject({
      status: 'failed',
      phase: 'failed',
      trigger: 'scheduled',
      error: 'candidate validation failed'
    });
  });

  it('recovers an orphaned job and removes its dead process lock on startup', async () => {
    const stateDir = testStateDir();
    const jobsDir = resolve(stateDir, 'jobs');
    const job = {
      id: 'sync-orphan', trigger: 'initial', status: 'running', phase: 'build-and-publish',
      createdAt: '2026-07-16T03:00:00.000Z', startedAt: '2026-07-16T03:00:01.000Z', completedAt: null,
      releaseId: null, shards: ['all'], error: null
    };
    await mkdir(jobsDir, { recursive: true });
    await writeFile(resolve(jobsDir, `${job.id}.json`), JSON.stringify(job));
    await writeFile(resolve(stateDir, 'sync.lock'), JSON.stringify({ jobId: job.id, token: 'old', pid: 999_999 }));
    const coordinator = new SyncCoordinator({
      stateDir,
      runSync: async () => ({}),
      processIsAlive: () => false,
      now: () => new Date('2026-07-17T03:00:00.000Z')
    });

    await coordinator.initialize();

    await expect(coordinator.getJob(job.id)).resolves.toMatchObject({
      status: 'failed', phase: 'interrupted', completedAt: '2026-07-17T03:00:00.000Z'
    });
    await expect(readFile(resolve(stateDir, 'sync.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('sync management API', () => {
  it('serves health under the /sync-control prefix', async () => {
    const runtime = await createSyncRuntime({
      environment: { SYNC_ADMIN_TOKEN: 'fixture-token' },
      stateDir: testStateDir(),
      runSync: async ({ releaseId }) => ({ releaseId, changed: false })
    });
    const response = await runtime.api(new Request('http://localhost/sync-control/healthz'));
    expect(response.status).toBe(200);
    await runtime.close();
  });

  it('requires a bearer token and returns a queryable task ID', async () => {
    const execution = deferred();
    const coordinator = new SyncCoordinator({
      stateDir: testStateDir(),
      idFactory: () => 'job-c',
      runSync: () => execution.promise
    });
    const api = createSyncApi({ coordinator, token: 'test-token' });

    const denied = await api(new Request('http://sync.test/api/v1/sync/jobs', { method: 'POST' }));
    expect(denied.status).toBe(401);

    const accepted = await api(new Request('http://sync.test/api/v1/sync/jobs', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ shards: ['HK'] })
    }));
    const body = await accepted.json();
    expect(accepted.status).toBe(202);
    expect(body.job.id).toMatch(/^sync-/u);
    expect(body.job.shards).toEqual(['HK']);

    const status = await api(new Request(`http://sync.test/api/v1/sync/jobs/${body.job.id}`, {
      headers: { Authorization: 'Bearer test-token' }
    }));
    expect(status.status).toBe(200);
    expect((await status.json()).job.id).toBe(body.job.id);

    execution.resolve({ releaseId: body.job.id });
    await coordinator.waitForIdle();
  });

  it('accepts a locked initial synchronization job', async () => {
    const coordinator = { trigger: vi.fn(async (trigger, { shards }) => ({
      accepted: true,
      job: { id: 'sync-initial', trigger, shards, status: 'queued' }
    })) };
    const api = createSyncApi({ coordinator, token: 'test-token' });
    const response = await api(new Request('http://sync.test/api/v1/sync/jobs', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'initial', shards: ['all'] })
    }));
    expect(response.status).toBe(202);
    expect(coordinator.trigger).toHaveBeenCalledWith('initial', { shards: ['all'] });
  });

});

describe('atomic address release command', () => {
  it('forces a metadata check for a manual shard sync', async () => {
    let options;
    await runAddressSync({
      releaseId: 'manual-check',
      environment: { ADDRESS_SYNC_TRIGGER: 'manual', ADDRESS_SYNC_SHARDS: 'HK' },
      runEtl: async (value) => {
        options = value;
        return { dryRun: true, changed: false };
      }
    });
    expect(options).toMatchObject({ requestedShards: ['HK'], force: true });
  });

  it('publishes only through a successful SQLite ETL transaction', async () => {
    const result = await runAddressSync({
      releaseId: 'release-ok',
      runEtl: async () => ({ changed: true, releaseTargets: [{ countryCode: 'US' }] })
    });
    expect(result).toMatchObject({ releaseId: 'release-ok', changed: true });
  });

  it('propagates an SQLite country transaction failure', async () => {
    await expect(runAddressSync({
      releaseId: 'release-failed',
      runEtl: async () => { throw new Error('SQLite transaction failed'); }
    })).rejects.toThrow('SQLite transaction failed');
  });

  it('retries a failed country synchronization with bounded exponential backoff', async () => {
    const waits = [];
    let calls = 0;
    const result = await runAddressSync({
      releaseId: 'release-retry',
      environment: { ADDRESS_SYNC_RETRY_ATTEMPTS: '3', ADDRESS_SYNC_RETRY_BASE_MS: '7' },
      runEtl: async () => {
        calls += 1;
        if (calls < 3) throw new Error('temporary source failure');
        return { changed: true };
      },
      wait: async (milliseconds) => waits.push(milliseconds)
    });
    expect(result.changed).toBe(true);
    expect(calls).toBe(3);
    expect(waits).toEqual([7, 14]);
  });
});

describe('daily due-shard synchronization schedule', () => {
  it('checks for due 30-day shards at the next 03:00 UTC boundary', () => {
    expect(nextRunAt(new Date('2026-07-16T10:30:00.000Z'), 3).toISOString())
      .toBe('2026-07-17T03:00:00.000Z');
    expect(nextRunAt(new Date('2026-07-19T03:00:00.000Z'), 3).toISOString())
      .toBe('2026-07-20T03:00:00.000Z');
  });

  it('runs at most one automatic job per UTC day after the configured hour', async () => {
    const coordinator = { trigger: vi.fn(async () => ({ accepted: true, job: { id: 'sync-startup' } })) };
    const stateFile = resolve(testStateDir(), 'daily-schedule.json');
    const now = () => new Date('2026-07-16T03:10:00.000Z');
    await triggerStartupSync(coordinator, { stateFile, utcHour: 3, now });
    await triggerDailySync({ coordinator, stateFile, utcHour: 3, now, trigger: 'scheduled' });
    expect(coordinator.trigger).toHaveBeenCalledWith('startup', { shards: ['all'] });
    expect(coordinator.trigger).toHaveBeenCalledTimes(1);
  });

  it('does not start the daily country sync before 03:00 UTC', async () => {
    const coordinator = { trigger: vi.fn(async () => ({ accepted: true, job: { id: 'sync-early' } })) };
    const result = await triggerStartupSync(coordinator, {
      stateFile: resolve(testStateDir(), 'daily-schedule.json'),
      utcHour: 3,
      now: () => new Date('2026-07-16T02:59:59.000Z')
    });
    expect(result).toMatchObject({ accepted: false, reason: 'before-window' });
    expect(coordinator.trigger).not.toHaveBeenCalled();
  });

  it('records success rather than acceptance and compensates a same-day failure', async () => {
    const jobs = [
      { id: 'sync-failed', status: 'failed', error: 'temporary failure' },
      { id: 'sync-succeeded', status: 'succeeded' }
    ];
    let index = 0;
    const coordinator = {
      trigger: vi.fn(async () => ({ accepted: true, job: jobs[index++] })),
      waitForIdle: vi.fn(async () => {}),
      getJob: vi.fn(async (id) => jobs.find((job) => job.id === id))
    };
    const waits = [];
    const stateFile = resolve(testStateDir(), 'daily-schedule.json');
    let currentTime = new Date('2026-07-17T03:10:00.000Z').getTime();
    const result = await triggerDailySync({
      coordinator,
      stateFile,
      trigger: 'scheduled',
      now: () => new Date(currentTime),
      maxAttempts: 2,
      retryBaseMs: 25,
      waitFor: async (milliseconds) => {
        waits.push(milliseconds);
        currentTime += milliseconds;
      }
    });
    expect(result.job.status).toBe('succeeded');
    expect(coordinator.trigger).toHaveBeenCalledTimes(2);
    expect(waits).toEqual([25]);
    expect(JSON.parse(await readFile(stateFile, 'utf8'))).toMatchObject({
      lastSuccessDate: '2026-07-17', attemptCount: 2, lastJobId: 'sync-succeeded'
    });
  });

  it('persists failed initial work and marks it complete after a resumed run', async () => {
    const jobs = [
      { id: 'sync-initial-failed', status: 'failed', error: 'source unavailable' },
      { id: 'sync-initial-ok', status: 'succeeded' }
    ];
    let index = 0;
    const coordinator = {
      trigger: vi.fn(async () => ({ accepted: true, job: jobs[index++] })),
      waitForIdle: vi.fn(async () => {}),
      getJob: vi.fn(async (id) => jobs.find((job) => job.id === id))
    };
    const stateFile = resolve(testStateDir(), 'initial-schedule.json');
    const now = () => new Date('2026-07-17T03:10:00.000Z');
    const failed = await triggerInitialSync({ coordinator, stateFile, now, retryBaseMs: 25 });
    expect(failed).toMatchObject({ completed: false, job: { status: 'failed' } });
    expect(JSON.parse(await readFile(stateFile, 'utf8'))).toMatchObject({ completed: false, failureCount: 1 });

    const resumed = await triggerInitialSync({ coordinator, stateFile, now, retryBaseMs: 25 });
    expect(resumed).toMatchObject({ completed: true, job: { status: 'succeeded' } });
    expect(JSON.parse(await readFile(stateFile, 'utf8'))).toMatchObject({ completed: true, failureCount: 0 });
  });
});
