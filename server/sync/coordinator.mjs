import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

class SyncBusyError extends Error {
  constructor(jobId) {
    super('An address sync job is already running');
    this.jobId = jobId || null;
  }
}

const errorText = (error) => error instanceof Error ? error.message : String(error);
const jobFileName = (id) => `${id}.json`;

export class SyncCoordinator {
  constructor({
    stateDir,
    runSync,
    now = () => new Date(),
    idFactory = randomUUID,
    lockStaleMs = 5 * 60 * 1000,
    processIsAlive = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    }
  }) {
    this.stateDir = resolve(stateDir);
    this.jobsDir = resolve(this.stateDir, 'jobs');
    this.lockFile = resolve(this.stateDir, 'sync.lock');
    this.runSync = runSync;
    this.now = now;
    this.idFactory = idFactory;
    this.lockStaleMs = lockStaleMs;
    this.processIsAlive = processIsAlive;
    this.currentJob = null;
    this.currentTask = null;
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;
    await mkdir(this.jobsDir, { recursive: true });
    const lock = await this.recoverLock();
    if (!lock?.invalid) await this.reconcileJobs(lock?.jobId || null);
    this.initialized = true;
  }

  async trigger(trigger = 'manual', { shards = ['all'] } = {}) {
    await this.initialize();
    if (this.currentJob) return { accepted: false, job: this.currentJob };

    const id = `sync-${this.now().toISOString().replace(/[-:.TZ]/gu, '')}-${this.idFactory()}`;
    const job = {
      id,
      trigger,
      status: 'queued',
      phase: 'queued',
      createdAt: this.now().toISOString(),
      startedAt: null,
      completedAt: null,
      releaseId: null,
      shards: [...new Set(shards)],
      error: null
    };

    let lock;
    try {
      lock = await this.acquireLock(id);
    } catch (error) {
      if (error instanceof SyncBusyError) {
        const runningJob = error.jobId ? await this.getJob(error.jobId) : null;
        return { accepted: false, job: runningJob || { id: error.jobId, status: 'running' } };
      }
      throw error;
    }

    try {
      await this.writeJob(job);
    } catch (error) {
      await this.releaseLock(lock);
      throw error;
    }
    this.currentJob = job;
    this.currentTask = this.execute(job, lock);
    return { accepted: true, job };
  }

  async execute(job, lock) {
    const heartbeat = setInterval(() => {
      void this.writeLock(lock, job.id).catch(() => {});
    }, 60_000);
    heartbeat.unref?.();
    try {
      Object.assign(job, { status: 'running', phase: 'build-and-publish', startedAt: this.now().toISOString() });
      await this.writeJob(job);
      const result = await this.runSync({ id: job.id, trigger: job.trigger, shards: job.shards });
      Object.assign(job, {
        status: 'succeeded',
        phase: 'published',
        completedAt: this.now().toISOString(),
        releaseId: result?.releaseId || job.id
      });
    } catch (error) {
      Object.assign(job, {
        status: 'failed',
        phase: 'failed',
        completedAt: this.now().toISOString(),
        error: errorText(error).slice(0, 1000)
      });
    } finally {
      clearInterval(heartbeat);
      try {
        await this.writeJob(job);
      } finally {
        try {
          await this.releaseLock(lock);
        } finally {
          this.currentJob = null;
          this.currentTask = null;
        }
      }
    }
  }

  async acquireLock(jobId, retried = false) {
    try {
      const token = randomUUID();
      const handle = await open(this.lockFile, 'wx');
      const lock = { handle, token };
      await this.writeLock(lock, jobId);
      return lock;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (!retried && await this.lockIsStale()) {
        const staleFile = `${this.lockFile}.stale-${randomUUID()}`;
        try {
          await rename(this.lockFile, staleFile);
          await rm(staleFile, { force: true });
          return this.acquireLock(jobId, true);
        } catch (renameError) {
          if (renameError?.code === 'ENOENT') return this.acquireLock(jobId, true);
        }
      }
      throw new SyncBusyError(await this.readLockJobId());
    }
  }

  async writeLock(lock, jobId) {
    const value = Buffer.from(JSON.stringify({
      jobId,
      token: lock.token,
      pid: process.pid,
      heartbeatAt: this.now().toISOString()
    }));
    await lock.handle.write(value, 0, value.length, 0);
    await lock.handle.truncate(value.length);
    await lock.handle.sync();
  }

  async releaseLock(lock) {
    await lock.handle.close().catch(() => {});
    try {
      const current = JSON.parse(await readFile(this.lockFile, 'utf8'));
      if (current.token === lock.token) await rm(this.lockFile, { force: true });
    } catch {}
  }

  async lockIsStale() {
    try {
      const metadata = await stat(this.lockFile);
      return this.now().getTime() - metadata.mtimeMs > this.lockStaleMs;
    } catch {
      return false;
    }
  }

  async readLock() {
    try {
      return JSON.parse(await readFile(this.lockFile, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      return { invalid: true };
    }
  }

  async removeLockFile() {
    const staleFile = `${this.lockFile}.stale-${randomUUID()}`;
    try {
      await rename(this.lockFile, staleFile);
      await rm(staleFile, { force: true });
      return true;
    } catch (error) {
      if (error?.code === 'ENOENT') return true;
      return false;
    }
  }

  async recoverLock() {
    const lock = await this.readLock();
    if (!lock) return null;
    const ownerAlive = Number.isSafeInteger(lock.pid) && lock.pid > 0
      ? this.processIsAlive(lock.pid)
      : null;
    if (ownerAlive === false || await this.lockIsStale()) {
      if (await this.removeLockFile()) return null;
    }
    return lock;
  }

  async reconcileJobs(activeJobId) {
    const files = (await readdir(this.jobsDir)).filter((name) => /^sync-[a-zA-Z0-9-]+\.json$/u.test(name));
    for (const name of files) {
      const file = resolve(this.jobsDir, name);
      let job;
      try {
        job = JSON.parse(await readFile(file, 'utf8'));
      } catch {
        continue;
      }
      if (!['queued', 'running'].includes(job.status) || job.id === activeJobId) continue;
      Object.assign(job, {
        status: 'failed',
        phase: 'interrupted',
        completedAt: this.now().toISOString(),
        error: 'Synchronization interrupted before completion'
      });
      await this.writeJob(job);
    }
  }

  async readLockJobId() {
    try {
      return JSON.parse(await readFile(this.lockFile, 'utf8')).jobId || null;
    } catch {
      return null;
    }
  }

  async writeJob(job) {
    const target = resolve(this.jobsDir, jobFileName(job.id));
    const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
    await writeFile(temporary, `${JSON.stringify(job, null, 2)}\n`, 'utf8');
    try {
      await rename(temporary, target);
    } catch (error) {
      if (!['EEXIST', 'EPERM'].includes(error?.code)) throw error;
      await rm(target, { force: true });
      await rename(temporary, target);
    }
  }

  async getJob(id) {
    await this.initialize();
    if (!/^sync-[a-zA-Z0-9-]+$/u.test(String(id || ''))) return null;
    try {
      return JSON.parse(await readFile(resolve(this.jobsDir, jobFileName(id)), 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  async latestJob() {
    await this.initialize();
    if (this.currentJob) return this.currentJob;
    const files = (await readdir(this.jobsDir)).filter((name) => /^sync-[a-zA-Z0-9-]+\.json$/u.test(name));
    const jobs = (await Promise.all(files.map(async (name) => {
      const file = resolve(this.jobsDir, name);
      return { file, modifiedAt: (await stat(file)).mtimeMs };
    }))).sort((left, right) => right.modifiedAt - left.modifiedAt);
    if (!jobs.length) return null;
    return JSON.parse(await readFile(jobs[0].file, 'utf8'));
  }

  async waitForIdle() {
    await this.currentTask;
  }
}
