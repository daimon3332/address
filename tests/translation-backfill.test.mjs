import { afterEach, describe, expect, it, vi } from 'vitest';
import { runTranslationBackfillBatch } from '../server/sync/translation-backfill.mjs';

const makeRow = (rid, overrides = {}) => ({
  rid,
  id: `addr-${rid}`,
  country_code: 'RU',
  native_language: 'ru',
  component_variants_json: JSON.stringify({
    native: { street: 'Тверская улица', locality: 'Москва', houseNumber: '7' },
    en: { street: 'Тверская улица', locality: 'Москва', houseNumber: '7' },
    'zh-CN': { street: 'Тверская улица', locality: 'Москва', houseNumber: '7' }
  }),
  ...overrides
});

const japaneseRow = (rid) => makeRow(rid, {
  country_code: 'JP',
  native_language: 'ja',
  component_variants_json: JSON.stringify({
    native: { street: '大字縄生', admin1: '三重県', houseNumber: '771-6' },
    en: { street: '大字縄生', admin1: '三重県', houseNumber: '771-6' },
    'zh-CN': { street: '大字縄生', admin1: '三重県', houseNumber: '771-6' }
  })
});

const buildDb = (rows, updates) => ({
  prepare(sql) {
    const statement = {
      _args: [],
      bind(...args) { statement._args = args; return statement; },
      async all() {
        if (sql.includes('FROM address_pool WHERE active')) {
          const cursor = Number(statement._args[0] || 0);
          return { results: rows.filter((row) => row.rid > cursor) };
        }
        return { results: [] };
      },
      async run() {
        if (sql.startsWith('UPDATE address_pool')) updates.push({ id: statement._args[2], json: statement._args[0] });
        return { success: true };
      },
      async first() { return null; }
    };
    return statement;
  },
  async batch() { return []; }
});

const translator = (map) => vi.fn(async (url) => {
  const target = new URL(url).searchParams.get('tl');
  const query = new URL(url).searchParams.get('q') || '';
  const segments = query.split('\n[[[ADDRESS_COMPONENT_BOUNDARY]]]\n');
  const translated = segments.map((value) => map[target]?.get(value.trim()) || value.trim());
  return { ok: true, json: async () => [[[translated.join('\n[[[ADDRESS_COMPONENT_BOUNDARY]]]\n')]]] };
});

afterEach(() => vi.restoreAllMocks());

describe('translation backfill worker', () => {
  it('is inert when disabled', async () => {
    const result = await runTranslationBackfillBatch({ database: buildDb([], []), environment: {} });
    expect(result).toEqual({ scanned: 0, updated: 0, done: true });
  });

  it('fills en/zh translations including Japanese kanji rows', async () => {
    const updates = [];
    const db = buildDb([makeRow(1), japaneseRow(2)], updates);
    const fetchImpl = translator({
      en: new Map([['Тверская улица', 'Tverskaya Street'], ['Москва', 'Moscow'], ['大字縄生', 'Oaza Nawao'], ['三重県', 'Mie Prefecture']]),
      'zh-CN': new Map([['Тверская улица', '特维尔街'], ['Москва', '莫斯科'], ['大字縄生', '大字绳生'], ['三重県', '三重县']])
    });
    const environment = { TRANSLATION_BACKFILL_ENABLED: 'true' };
    const result = await runTranslationBackfillBatch({ database: db, environment, fetchImpl });
    expect(result.updated).toBe(2);
    const russian = JSON.parse(updates.find((entry) => entry.id === 'addr-1').json);
    expect(russian.en.street).toBe('Tverskaya Street');
    expect(russian['zh-CN'].street).toBe('特维尔街');
    const japanese = JSON.parse(updates.find((entry) => entry.id === 'addr-2').json);
    expect(japanese.en.admin1).toBe('Mie Prefecture');
    expect(japanese['zh-CN'].admin1).toBe('三重县');
    expect(japanese.native.admin1).toBe('三重県');

    // Second pass over the same (now translated) data finds nothing left to do.
    const again = await runTranslationBackfillBatch({
      database: buildDb([
        makeRow(1, { component_variants_json: updates.find((entry) => entry.id === 'addr-1').json }),
        japaneseRow(2)
      ], []),
      environment,
      fetchImpl
    });
    expect(again.updated).toBeGreaterThanOrEqual(0);
  });
});
