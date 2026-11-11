// pinyin-pro carries a 117 KB (compressed) dictionary that browsers only need once a Chinese address is shown in
// pinyin, so it loads on demand there. Node requires it synchronously, in a form bundlers do not follow.
type Pinyin = typeof import('pinyin-pro').pinyin;

type NodeProcess = { getBuiltinModule?: (id: string) => { createRequire: (url: string) => (id: string) => { pinyin: Pinyin } } };
const nodeModule = (globalThis as { process?: NodeProcess }).process?.getBuiltinModule?.('node:module');

let implementation: Pinyin | undefined = nodeModule?.createRequire(import.meta.url)('pinyin-pro').pinyin;
let loading: Promise<void> | undefined;
const listeners = new Set<() => void>();

export const pinyinReady = (): boolean => Boolean(implementation);

export const loadPinyin = (): Promise<void> => loading ||= import('pinyin-pro').then((module) => {
  implementation = module.pinyin;
  for (const listener of listeners) listener();
}, (error) => { loading = undefined; throw error; });

export const onPinyinReady = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

// useSyncExternalStore arguments: components showing pinyin re-render when the dictionary arrives.
export const pinyinStore = [onPinyinReady, pinyinReady, () => true] as const;

export const pinyin = ((...parameters: Parameters<Pinyin>) => {
  if (!implementation) throw new Error('PINYIN_NOT_LOADED');
  return implementation(...parameters);
}) as Pinyin;
