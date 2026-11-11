import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStaleCache } from '../server/control/stale-cache';

describe('stale read-model cache', () => {
  afterEach(() => vi.useRealTimers());

  it('serves an expired value while one refresh runs and waits only when the value is too old', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const read = createStaleCache<number>(1_000, 10_000);
    const load = async () => ++calls;
    expect(await read('key', load)).toBe(1);
    expect(await read('key', load)).toBe(1);
    vi.advanceTimersByTime(2_000);
    expect(await Promise.all([read('key', load), read('key', load)])).toEqual([1, 1]);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(2);
    expect(await read('key', load)).toBe(2);
    vi.advanceTimersByTime(20_000);
    expect(await read('key', load)).toBe(3);
    expect(await read('key', load, { force: true })).toBe(4);
  });

  it('keeps the previous value when a refresh fails and retries on the next read', async () => {
    vi.useFakeTimers();
    const read = createStaleCache<string>(1_000, 10_000);
    expect(await read('key', async () => 'first')).toBe('first');
    vi.advanceTimersByTime(2_000);
    expect(await read('key', async () => { throw new Error('down'); })).toBe('first');
    await vi.advanceTimersByTimeAsync(0);
    expect(await read('key', async () => 'second')).toBe('first');
    await vi.advanceTimersByTimeAsync(0);
    expect(await read('key', async () => 'unused')).toBe('second');
    await expect(createStaleCache<string>(1_000, 10_000)('key', async () => { throw new Error('down'); })).rejects.toThrow('down');
  });
});
