import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';

const nextRunAt = (now, utcHour) => {
  const target = new Date(now);
  target.setUTCHours(utcHour, 0, 0, 0);
  if (target <= now) target.setUTCDate(target.getUTCDate() + 1);
  return target;
};

const utcDate = (date) => date.toISOString().slice(0, 10);
const wait = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));

const readScheduleState = async (stateFile) => {
  try {
    return JSON.parse(await readFile(stateFile, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw error;
  }
};

const writeScheduleState = async (stateFile, state) => {
  await mkdir(dirname(stateFile), { recursive: true });
  const temporary = `${stateFile}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await rename(temporary, stateFile);
};

const completedJob = async (coordinator, result) => {
  if (!result.accepted) return result.job || null;
  await coordinator.waitForIdle?.();
  return coordinator.getJob ? coordinator.getJob(result.job.id) : { ...result.job, status: 'succeeded' };
};

export const triggerDailySync = async ({
  coordinator,
  stateFile,
  trigger,
  now = () => new Date(),
  utcHour = 3,
  maxAttempts = 3,
  retryBaseMs = 60_000,
  waitFor = wait
}) => {
  const first = now();
  if (trigger === 'startup' && first.getUTCHours() < utcHour) return { accepted: false, reason: 'before-window' };
  const file = resolve(stateFile);

  while (true) {
    const current = now();
    const date = utcDate(current);
    const state = await readScheduleState(file);
    if (state.lastSuccessDate === date) return { accepted: false, reason: 'already-succeeded' };
    const attemptCount = state.lastAttemptDate === date ? Number(state.attemptCount || 1) : 0;
    if (attemptCount >= maxAttempts) return { accepted: false, reason: 'attempts-exhausted' };
    const retryAt = state.lastAttemptDate === date ? new Date(state.nextRetryAt || 0).getTime() : 0;
    if (retryAt > current.getTime()) await waitFor(retryAt - current.getTime());

    const result = await coordinator.trigger(trigger, { shards: ['all'] });
    if (!result.accepted) return result;
    const startedAt = now();
    const nextAttemptCount = attemptCount + 1;
    await writeScheduleState(file, {
      ...state,
      lastAttemptDate: utcDate(startedAt),
      attemptCount: nextAttemptCount,
      lastJobId: result.job.id,
      lastAttemptAt: startedAt.toISOString(),
      nextRetryAt: null,
      updatedAt: startedAt.toISOString()
    });

    const job = await completedJob(coordinator, result);
    const completedAt = now();
    if (job?.status === 'succeeded') {
      await writeScheduleState(file, {
        lastAttemptDate: utcDate(startedAt),
        attemptCount: nextAttemptCount,
        lastSuccessDate: utcDate(completedAt),
        lastJobId: job.id,
        lastAttemptAt: startedAt.toISOString(),
        lastSuccessAt: completedAt.toISOString(),
        nextRetryAt: null,
        updatedAt: completedAt.toISOString()
      });
      return { ...result, job };
    }

    const retryDelay = Math.min(60 * 60 * 1000, retryBaseMs * 2 ** (nextAttemptCount - 1));
    const nextRetryAt = new Date(completedAt.getTime() + retryDelay).toISOString();
    await writeScheduleState(file, {
      ...state,
      lastAttemptDate: utcDate(startedAt),
      attemptCount: nextAttemptCount,
      lastJobId: job?.id || result.job.id,
      lastAttemptAt: startedAt.toISOString(),
      lastFailureAt: completedAt.toISOString(),
      lastError: job?.error || 'Address synchronization failed',
      nextRetryAt,
      updatedAt: completedAt.toISOString()
    });
    if (nextAttemptCount >= maxAttempts) return { ...result, job, reason: 'attempts-exhausted' };
    await waitFor(retryDelay);
  }
};

export const triggerInitialSync = async ({
  coordinator,
  stateFile,
  now = () => new Date(),
  retryBaseMs = 5 * 60_000
}) => {
  const file = resolve(stateFile);
  const state = await readScheduleState(file);
  if (state.completed) return { accepted: false, completed: true, reason: 'already-completed' };
  const current = now();
  const result = await coordinator.trigger('initial', { shards: ['all'] });
  if (!result.accepted) return result;
  await writeScheduleState(file, {
    ...state,
    completed: false,
    lastJobId: result.job.id,
    lastAttemptAt: current.toISOString(),
    updatedAt: current.toISOString()
  });
  const job = await completedJob(coordinator, result);
  const completedAt = now();
  if (job?.status === 'succeeded') {
    await writeScheduleState(file, {
      completed: true,
      failureCount: 0,
      lastJobId: job.id,
      lastAttemptAt: current.toISOString(),
      completedAt: completedAt.toISOString(),
      nextRetryAt: null,
      updatedAt: completedAt.toISOString()
    });
    return { ...result, job, completed: true };
  }
  const failureCount = Number(state.failureCount || 0) + 1;
  const retryDelay = Math.min(6 * 60 * 60_000, retryBaseMs * 2 ** Math.min(failureCount - 1, 6));
  const nextRetryAt = new Date(completedAt.getTime() + retryDelay).toISOString();
  await writeScheduleState(file, {
    completed: false,
    failureCount,
    lastJobId: job?.id || result.job.id,
    lastAttemptAt: current.toISOString(),
    lastFailureAt: completedAt.toISOString(),
    lastError: job?.error || 'Initial address synchronization failed',
    nextRetryAt,
    updatedAt: completedAt.toISOString()
  });
  return { ...result, job, completed: false, nextRetryAt };
};

export const startInitialScheduler = ({
  coordinator,
  stateFile,
  now = () => new Date(),
  retryBaseMs = 5 * 60_000,
  setTimer = setTimeout,
  onComplete = () => {}
}) => {
  let timer;
  let stopped = false;
  const schedule = (delay = 1) => {
    if (stopped) return;
    timer = setTimer(async () => {
      try {
        const state = await readScheduleState(resolve(stateFile));
        const retryAt = new Date(state.nextRetryAt || 0).getTime();
        if (retryAt > now().getTime()) {
          schedule(retryAt - now().getTime());
          return;
        }
        const result = await triggerInitialSync({ coordinator, stateFile, now, retryBaseMs });
        if (result.completed) onComplete();
        else {
          const next = new Date(result.nextRetryAt || 0).getTime();
          schedule(Math.max(1_000, next - now().getTime() || retryBaseMs));
        }
      } catch (error) {
        console.error('Initial address synchronization continuation failed', error);
        schedule(retryBaseMs);
      }
    }, Math.max(1, delay));
    timer.unref?.();
  };
  schedule();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
};

export const startDailyScheduler = ({ coordinator, stateFile, utcHour = 3, now = () => new Date(), setTimer = setTimeout }) => {
  let timer;
  let stopped = false;
  const schedule = () => {
    if (stopped) return;
    const delay = Math.max(1, nextRunAt(now(), utcHour).getTime() - now().getTime());
    timer = setTimer(async () => {
      try {
        await triggerDailySync({ coordinator, stateFile, trigger: 'scheduled', now, utcHour });
      } catch (error) {
        console.error('Scheduled address synchronization failed', error);
      } finally {
        schedule();
      }
    }, delay);
    timer.unref?.();
  };
  schedule();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
};

export const triggerStartupSync = (coordinator, options) => triggerDailySync({ coordinator, trigger: 'startup', ...options });

export { nextRunAt };
