import { lstat, readdir } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

export const GIBIBYTE = 1024 ** 3;
export const DEFAULT_SOFT_LIMIT_BYTES = 40 * GIBIBYTE;
export const DEFAULT_HARD_LIMIT_BYTES = 45 * GIBIBYTE;

export class StorageBudgetExceededError extends Error {
  constructor({ projectedBytes, hardLimitBytes }) {
    super(`Address storage hard limit exceeded: ${projectedBytes} > ${hardLimitBytes} bytes`);
    this.name = 'StorageBudgetExceededError';
    this.code = 'ADDRESS_STORAGE_HARD_LIMIT';
    this.projectedBytes = projectedBytes;
    this.hardLimitBytes = hardLimitBytes;
  }
}

const pathSize = async (path) => {
  let entry;
  try { entry = await lstat(path); } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
  if (!entry.isDirectory() || entry.isSymbolicLink()) return entry.size;
  const children = await readdir(path, { withFileTypes: true });
  const sizes = await Promise.all(children.map((child) => pathSize(resolve(path, child.name))));
  return sizes.reduce((total, size) => total + size, 0);
};

const topLevelPaths = (paths) => {
  const unique = [...new Set(paths.filter(Boolean).map((path) => resolve(path)))].sort((left, right) => left.length - right.length);
  return unique.filter((path, index) => !unique.slice(0, index).some((parent) => path.startsWith(`${parent}${sep}`)));
};

export const measureStorageBytes = async (paths) => {
  const sizes = await Promise.all(topLevelPaths(Array.isArray(paths) ? paths : [paths]).map(pathSize));
  return sizes.reduce((total, size) => total + size, 0);
};

export const evaluateStorageBudget = ({
  currentBytes,
  additionalBytes = 0,
  softLimitBytes = DEFAULT_SOFT_LIMIT_BYTES,
  hardLimitBytes = DEFAULT_HARD_LIMIT_BYTES
}) => {
  if (!Number.isSafeInteger(currentBytes) || currentBytes < 0) throw new Error('currentBytes must be a non-negative safe integer');
  if (!Number.isSafeInteger(additionalBytes) || additionalBytes < 0) throw new Error('additionalBytes must be a non-negative safe integer');
  if (!Number.isSafeInteger(softLimitBytes) || !Number.isSafeInteger(hardLimitBytes)
    || softLimitBytes < 1 || hardLimitBytes <= softLimitBytes) {
    throw new Error('Storage limits must be positive safe integers and hardLimitBytes must exceed softLimitBytes');
  }
  const projectedBytes = currentBytes + additionalBytes;
  return {
    currentBytes,
    additionalBytes,
    projectedBytes,
    softLimitBytes,
    hardLimitBytes,
    level: projectedBytes >= hardLimitBytes ? 'hard' : projectedBytes >= softLimitBytes ? 'soft' : 'normal',
    allowWrite: projectedBytes < hardLimitBytes,
    allowShadowExpansion: projectedBytes < softLimitBytes,
    remainingBytes: Math.max(0, hardLimitBytes - projectedBytes)
  };
};

export const assertStorageBudget = (options) => {
  const budget = evaluateStorageBudget(options);
  if (!budget.allowWrite) throw new StorageBudgetExceededError(budget);
  return budget;
};
