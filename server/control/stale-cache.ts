// Read models that take about a second to compute: a fresh value is returned as is, an expired one is returned
// while one refresh runs in the background, and only a missing or long-expired value makes the caller wait.
export const createStaleCache = <T>(freshMs: number, staleMs: number, maximumEntries = 500) => {
  const entries = new Map<string, { value?: T; loadedAt: number; pending?: Promise<T> }>();
  return (key: string, load: () => Promise<T>, { force = false } = {}): Promise<T> => {
    const entry = entries.get(key);
    const age = entry?.value === undefined ? Infinity : Date.now() - entry.loadedAt;
    if (!force && age < freshMs) return Promise.resolve(entry!.value as T);
    const pending = (!force && entry?.pending) || load().then((value) => {
      entries.delete(key);
      entries.set(key, { value, loadedAt: Date.now() });
      while (entries.size > maximumEntries) entries.delete(entries.keys().next().value as string);
      return value;
    }, (error) => {
      const current = entries.get(key);
      if (current?.pending === pending) delete current.pending;
      throw error;
    });
    entries.set(key, { ...entry, loadedAt: entry?.loadedAt || 0, pending });
    if (!force && age < staleMs) {
      void pending.catch(() => undefined);
      return Promise.resolve(entry!.value as T);
    }
    return pending;
  };
};
