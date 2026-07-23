import { translateValues, localizedFields, SqliteTranslationCache } from './address-etl.mjs';

const clean = (value) => String(value ?? '').replace(/\s+/gu, ' ').trim();
const nonLatin = /[^\p{Script=Latin}\p{N}\p{P}\p{Z}]/u;
const han = /\p{Script=Han}/u;

const boolean = (value, fallback = false) => value === undefined ? fallback : /^(1|true|yes)$/iu.test(String(value));
const integer = (value, fallback, minimum = 1) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : fallback;
};

const parseVariants = (value) => {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
};

// Field-level pending detection.
// - en is pending while it still contains non-Latin script.
// - zh is pending while it is byte-identical to the native value (the untranslated marker)
//   for rows whose native language is not Chinese; script sniffing cannot be used because
//   Japanese kanji are Han-script yet still need ja->zh translation.
const pendingFields = (variants, nativeLanguage) => {
  const nativeIsChinese = String(nativeLanguage || '').toLowerCase().startsWith('zh');
  const en = [];
  const zh = [];
  for (const field of localizedFields) {
    const source = clean(variants.native?.[field]);
    if (!source) continue;
    const enValue = clean(variants.en?.[field]);
    if (enValue && nonLatin.test(enValue)) en.push(field);
    if (!nativeIsChinese) {
      const zhValue = clean(variants['zh-CN']?.[field]);
      if (zhValue && zhValue === source && /\p{L}/u.test(source)) zh.push(field);
    }
  }
  return { en, zh };
};

// Scan cursor and failure backoff live per-process; a restart simply rescans
// (already-translated rows are skipped quickly).
const state = { cursor: 0, failedTicks: 0 };

export const runTranslationBackfillBatch = async ({
  database,
  environment = process.env,
  fetchImpl = fetch,
  pendingLimit = integer(environment.TRANSLATION_BACKFILL_BATCH, 300),
  scanLimit = integer(environment.TRANSLATION_BACKFILL_SCAN, 20000),
  now = () => new Date()
}) => {
  if (!boolean(environment.TRANSLATION_BACKFILL_ENABLED, false)) return { scanned: 0, updated: 0, done: true };
  if (state.failedTicks > 0) {
    state.failedTicks -= 1;
    return { scanned: 0, updated: 0, done: false, backoff: true };
  }
  const cache = new SqliteTranslationCache(database);
  const pending = [];
  let scanned = 0;
  while (pending.length < pendingLimit && scanned < scanLimit) {
    const rows = (await database.prepare(`SELECT rowid AS rid, id, native_language, component_variants_json
      FROM address_pool WHERE active = 1 AND native_language NOT LIKE 'en%' AND rowid > ? ORDER BY rowid LIMIT 500`)
      .bind(state.cursor).all()).results || [];
    if (!rows.length) {
      // End of table: restart from the top on the NEXT tick.
      state.cursor = 0;
      break;
    }
    for (const row of rows) {
      state.cursor = row.rid;
      scanned += 1;
      if (String(row.native_language || '').toLowerCase().startsWith('en')) continue;
      const variants = parseVariants(row.component_variants_json);
      if (!variants) continue;
      const fields = pendingFields(variants, row.native_language);
      if (fields.en.length || fields.zh.length) {
        pending.push({ row, variants, fields });
        if (pending.length >= pendingLimit) break;
      }
    }
  }
  if (!pending.length) return { scanned, updated: 0, done: scanned === 0 };

  const enValues = [...new Set(pending.flatMap(({ variants, fields }) =>
    fields.en.map((field) => clean(variants.native?.[field])).filter(Boolean)))];
  const zhValues = [...new Set(pending.flatMap(({ variants, fields }) =>
    fields.zh.map((field) => clean(variants.native?.[field])).filter(Boolean)))];

  const [english, chinese] = await Promise.all([
    enValues.length ? translateValues(enValues, 'en', environment, fetchImpl, cache) : new Map(),
    zhValues.length ? translateValues(zhValues, 'zh-CN', environment, fetchImpl, cache) : new Map()
  ]);

  let updated = 0;
  const updatedAt = now().toISOString();
  for (const { row, variants, fields } of pending) {
    let changed = false;
    for (const field of fields.en) {
      const source = clean(variants.native?.[field]);
      const translation = clean(english.get(source));
      if (translation && translation !== source && !nonLatin.test(translation)) {
        variants.en[field] = translation;
        changed = true;
      }
    }
    for (const field of fields.zh) {
      const source = clean(variants.native?.[field]);
      const translation = clean(chinese.get(source));
      if (translation && translation !== source && han.test(translation)) {
        variants['zh-CN'][field] = translation;
        changed = true;
      }
    }
    if (!changed) continue;
    await database.prepare('UPDATE address_pool SET component_variants_json = ?, last_seen_at = ? WHERE id = ?')
      .bind(JSON.stringify(variants), updatedAt, row.id).run();
    updated += 1;
  }
  // Translation service unavailable: everything came back unchanged. Back off ~10 ticks.
  if (updated === 0 && (enValues.length || zhValues.length)) state.failedTicks = 10;
  return { scanned, updated, done: false };
};

export const startTranslationBackfill = ({
  database,
  environment = process.env,
  isBusy = () => false,
  intervalMs = integer(environment.TRANSLATION_BACKFILL_INTERVAL_MS, 60_000),
  setTimer = setTimeout,
  now = () => new Date()
}) => {
  if (!boolean(environment.TRANSLATION_BACKFILL_ENABLED, false)) return () => {};
  let timer;
  let stopped = false;
  let logged = 0;
  const schedule = (delay) => {
    if (stopped) return;
    timer = setTimer(async () => {
      try {
        if (!isBusy()) {
          const result = await runTranslationBackfillBatch({ database, environment, now });
          logged += result.updated;
          if (result.updated > 0 && logged % 1000 < result.updated) {
            console.log(`[translation-backfill] cumulative updated=${logged}`);
          }
        }
      } catch (error) {
        console.error('Translation backfill batch failed', error);
      } finally {
        schedule(intervalMs);
      }
    }, Math.max(1, delay));
    timer.unref?.();
  };
  schedule(intervalMs);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
};
