import { refreshAddressGenerationIndex } from '../database/generation-index.mjs';
import { latinPremise } from '../../src/domain/latin-premise.mjs';
import { staleCoverage } from './stale-coverage.mjs';

export const ENGLISH_PREMISE_REVISION = 'english-premise-v1';

// Whether the reader can show the house number and unit in Latin script (Taiwan through its Chunghwa Post form).
export const premiseLatinizable = async (countryCode, variants) => {
  if (countryCode === 'CN') return true;
  if (countryCode === 'TW') {
    // Loaded on use: the formatter is TypeScript, which plain-Node audit scripts cannot load.
    const { taiwanEnglishPremise } = await import('../../src/domain/address-format.ts');
    if (taiwanEnglishPremise(String(variants.native?.houseNumber || ''), String(variants.native?.unit || ''))) return true;
  }
  return ['houseNumber', 'unit'].every((field) => latinPremise(countryCode, field, variants.en?.[field] ?? variants.native?.[field]) !== undefined);
};

// Retires published rows whose house number or unit holds local-script text the reader cannot write in Latin (a
// Thai soi name, a Korean building name in the unit): after an import for the rows it wrote, and once per country
// and revision for the whole pool. The reader already refuses to show them; retiring keeps the counts honest.
export const retireUnlatinizablePremises = async ({ database, countryCode, addressIds, pageSize = 20_000, now = () => new Date() }) => {
  const country = String(countryCode || '').toUpperCase();
  const summary = { countryCode: country, checked: 0, retired: 0 };
  if (country === 'CN') return summary;
  const scoped = Array.isArray(addressIds);
  const markerKey = `${ENGLISH_PREMISE_REVISION}:${country}`;
  if (!scoped && await database.prepare('SELECT value_json FROM translation_backfill_progress WHERE key=?')
    .bind(markerKey).first('value_json')) return summary;
  const retiredAt = `publication-validation:${ENGLISH_PREMISE_REVISION}:${now().toISOString()}`;
  const ids = scoped ? [...new Set(addressIds.map(String))] : [];
  let cursor = '';
  for (let offset = 0; ; offset += pageSize) {
    const batch = ids.slice(offset, offset + pageSize);
    if (scoped && !batch.length) break;
    // The whole-country pass walks id windows through the index; within a window only rows with a non-ASCII house
    // number or unit are read, so no single statement scans a large country.
    const end = scoped ? '' : (await database.prepare(`SELECT max(id) AS id FROM (SELECT id FROM address_pool
      WHERE country_code=? AND active=1 AND id>? ORDER BY id LIMIT ?) page`).bind(country, cursor, pageSize).first('id'));
    if (!scoped && !end) break;
    const rows = (await database.prepare(`SELECT id,component_variants_json FROM address_pool
      WHERE country_code=? AND active=1 AND ${scoped ? `id IN (${batch.map(() => '?').join(',')})` : 'id>? AND id<=?'}
        AND (house_number ~ '[^\\x01-\\x7f]' OR component_variants_json ~ '"unit":"[^"]*[^\\x01-\\x7f]')
      ORDER BY id`).bind(country, ...(scoped ? batch : [cursor, end])).all()).results;
    if (!scoped) cursor = end;
    const failing = [];
    for (const row of rows) {
      const variants = JSON.parse(row.component_variants_json || '{}');
      if (!['houseNumber', 'unit'].some((field) => /[^\x00-\x7f]/u.test(String(variants.en?.[field] ?? variants.native?.[field] ?? '')))) continue;
      summary.checked += 1;
      if (!await premiseLatinizable(country, variants)) failing.push(row.id);
    }
    if (failing.length) {
      await database.prepare(`UPDATE address_pool SET active=0,retired_at=? WHERE id IN (${failing.map(() => '?').join(',')})`)
        .bind(retiredAt, ...failing).run();
      await refreshAddressGenerationIndex(database, country, { addressIds: failing });
      summary.retired += failing.length;
    }
  }
  if (summary.retired) {
    const { refreshCountryCounts } = await import('../database/published-pool.mjs');
    await refreshCountryCounts(database, country, now().toISOString(), { useGenerationIndex: true });
    staleCoverage.add(country);
  }
  if (!scoped) {
    await database.prepare(`INSERT INTO translation_backfill_progress(key,value_json,updated_at) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`)
      .bind(markerKey, JSON.stringify({ done: true, retired: summary.retired }), now().toISOString()).run();
  }
  return summary;
};
