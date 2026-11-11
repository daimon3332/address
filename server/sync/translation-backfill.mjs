import { createHash } from 'node:crypto';
import { createPostgresPool, PostgresDatabase } from '../database/postgres.mjs';
import { translateValues, translateNumberedValues, localizedFormattedAddress, usableTranslation, PostgresTranslationCache } from './address-etl.mjs';
import { componentLooksLocalized, semanticAddressFields as localizedFields } from '../../src/domain/address-localization.mjs';
import { diagnoseStoredAddressPoolV2Row, storedAddressPoolV2RowCanRecoverTranslations, storedAddressPoolV2RowIsFullyTranslated, storedAddressPoolV2RowIsPublishable } from '../api/repositories/address-pool-v2';
import { findNonResidentialMatch } from '../../src/domain/non-residential.mjs';
import { matchesCustomBlacklist } from '../lib/custom-blacklist.mjs';
import { refreshAddressGenerationIndex } from '../database/generation-index.mjs';
import { adjustCountryCounts, generationIndexContribution, refreshCountryCounts } from '../database/published-pool.mjs';
import { refreshResidentialCoverage } from '../database/residential-coverage.mjs';
import { administrativeAssignmentJoin, projectAdministrativeRow, refreshAdministrativeAssignments } from '../database/administrative-assignments.mjs';
import { createBackfillProviders, readBackfillProgress, writeBackfillProgress } from './translation-providers.mjs';
import { administrativeNameCountries, loadAdministrativeNames, repairRetirement } from './administrative-names.mjs';
import { staleCoverage } from './stale-coverage.mjs';

const clean = (value) => String(value ?? '').trim();
const placeFields = new Set(['admin1', 'locality', 'postalLocality', 'district', 'dependentLocality']);
const integer = (value, fallback, max) => Math.min(max, Math.max(1, Number.parseInt(value, 10) || fallback));
const fingerprint = (row) => createHash('sha256').update(JSON.stringify([
  'semantic-recovery-v1', row.component_variants_json, row.address_variants_json, row.generation,
  row.active, row.retired_at, row.dataset_id, row.dataset_version, row.evidence_id,
  row.admin1, row.admin1_code, row.locality, row.street, row.house_number, row.postcode,
  row.latitude, row.longitude, row.property_type, row.quality_score, row.residential_evidence,
  ...(row.administrative_patch_json && row.administrative_patch_json !== '{}' ? [row.administrative_patch_json] : [])
])).digest('hex');
const parse = (value) => { try { return JSON.parse(value) || {}; } catch { return {}; } };
const eligibleRetirement = (row) => row.active === 1
  || String(row.retired_at || '').startsWith('publication-validation:') && !repairRetirement.test(String(row.retired_at));
function* recoveryCandidates(groups, first) {
  for (let index = 0; index < Math.max(...groups.map((group) => group.length)); index++) {
    for (let lane = 0; lane < groups.length; lane++) {
      const row = groups[(first + lane) % groups.length][index];
      if (row) yield row;
    }
  }
}
const stateRevision = (revision, status, reason) => status === 'rejected' && reason === 'base_contract'
  ? createHash('sha256').update(JSON.stringify(['native-source-contract-v3', revision])).digest('hex')
  : status === 'failed' && reason === 'translation_or_publication_rejected'
    ? createHash('sha256').update(JSON.stringify(['semantic-field-recovery-v2', revision])).digest('hex') : revision;

const safeTranslatedField = (row, field, value) => !matchesCustomBlacklist([value])
  && !(field === 'buildingName' && (row?.residential_evidence || ['residential', 'apartment'].includes(row?.property_type))
    && findNonResidentialMatch({ countryCode: row.country_code, buildingName: value }).excluded);

export const pendingTranslationFields = (variants, nativeLanguage, row) => Object.fromEntries(['en', 'zh-CN'].map((language) => [
  language, localizedFields.filter((field) => {
    const original = clean(variants.native?.[field]);
    if (!original) return false;
    const value = clean(variants[language]?.[field]);
    // An untranslated Chinese place name stays pending; English-language streets may publish with their English name.
    return !usableTranslation(value, language, original, field) || !safeTranslatedField(row, field, value)
      || language === 'zh-CN' && !String(nativeLanguage).startsWith('zh') && value === original && /\p{L}/u.test(original)
        && (!String(nativeLanguage).startsWith('en') || placeFields.has(field));
  })
]));

const sourceRows = async (database, ids) => {
  if (!ids.length) return new Map();
  const placeholders = ids.map(() => '?').join(',');
  const rows = (await database.prepare(`SELECT address.*,administrative.patch_json AS administrative_patch_json,
  evidence.id AS evidence_id,evidence.source_record_id,evidence.record_url,evidence.observed_at,evidence.evidence_type,
  dataset.id AS dataset_id,dataset.version AS dataset_version,dataset.published_at AS source_updated_at,
  dataset.imported_at,dataset.license_code AS source_license,dataset.license_url,
  source.id AS source_id,source.name AS source_name,source.homepage_url AS source_url,
  source.attribution_text,source.attribution_url,
  CASE WHEN residential.address_id IS NULL THEN 0 ELSE 1 END AS residential_evidence
  FROM address_pool address
  ${administrativeAssignmentJoin('address')}
  JOIN address_pool_evidence evidence ON evidence.address_id=address.id
    AND evidence.is_primary=1 AND evidence.is_current=1 AND evidence.evidence_type='address_existence'
  JOIN address_datasets dataset ON dataset.id=evidence.dataset_id
    AND dataset.status='active' AND dataset.redistribution_allowed=1 AND dataset.country_code=address.country_code
  JOIN address_sources source ON source.id=dataset.source_id AND source.redistribution_allowed=1
  LEFT JOIN (SELECT DISTINCT evidence.address_id FROM address_pool_evidence evidence
    JOIN address_datasets dataset ON dataset.id=evidence.dataset_id AND dataset.status='active' AND dataset.redistribution_allowed=1
    JOIN address_sources source ON source.id=dataset.source_id AND source.redistribution_allowed=1
    WHERE evidence.address_id IN (${placeholders}) AND evidence.evidence_type='residential_use' AND evidence.is_current=1
  ) residential ON residential.address_id=address.id
  WHERE address.id IN (${placeholders})`).bind(...ids, ...ids).all()).results;
  return new Map(rows.map((row) => [row.id, row]));
};

// English-first publication: rows publication validation retired while their Chinese fields were untranslated publish
// again once their English variant passes, country by country and once per revision; translation recovery keeps
// translating their Chinese names afterwards. Repair retirements (outside the country, import gate) are never touched.
export const ENGLISH_FIRST_REPUBLICATION_REVISION = 'english-first-republish-v1';
export const republishEnglishReadyRows = async ({ database, countryCode, pageSize = 500, pauseMs = 200, now = () => new Date() }) => {
  const country = String(countryCode || '').toUpperCase();
  const key = `${ENGLISH_FIRST_REPUBLICATION_REVISION}:${country}`;
  const state = await readBackfillProgress(database, key, { cursor: '', done: false });
  const summary = { countryCode: country, scanned: 0, republished: 0 };
  if (state.done) return summary;
  for (;;) {
    const ids = (await database.prepare(`SELECT id FROM address_pool WHERE country_code=? AND active=0
      AND retired_at LIKE 'publication-validation:address-reader-%' AND id>? ORDER BY id LIMIT ?`)
      .bind(country, state.cursor, pageSize).all()).results.map((row) => row.id);
    const ready = [...(await sourceRows(database, ids)).values()].filter((row) => storedAddressPoolV2RowIsPublishable(row, now()));
    if (ready.length) {
      const activated = new Set((await database.prepare(`UPDATE address_pool SET active=1,retired_at=NULL
        WHERE id IN (${ready.map(() => '?').join(',')}) AND active=0 AND retired_at LIKE 'publication-validation:address-reader-%'
        RETURNING id`).bind(...ready.map((row) => row.id)).all()).results.map((row) => row.id));
      if (activated.size) {
        await refreshAddressGenerationIndex(database, country, { addressIds: [...activated] });
        const datasets = new Map();
        for (const row of ready.filter((item) => activated.has(item.id))) datasets.set(row.dataset_id, (datasets.get(row.dataset_id) || 0) + 1);
        for (const [dataset, count] of datasets) {
          await database.prepare('UPDATE address_datasets SET active_count=active_count+? WHERE id=?').bind(count, dataset).run();
        }
        summary.republished += activated.size;
      }
    }
    summary.scanned += ids.length;
    state.cursor = ids.at(-1) || state.cursor;
    state.done = ids.length < pageSize;
    await writeBackfillProgress(database, key, state, now());
    if (state.done) break;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, pauseMs));
  }
  if (summary.republished) {
    await refreshCountryCounts(database, country, now().toISOString(), { useGenerationIndex: true });
    staleCoverage.add(country);
  }
  return summary;
};

const saveState = (database, row, revision, status, attempts, retryAt, reason, now, diagnostics = []) => database.prepare(`
  INSERT INTO translation_recovery(address_id,input_hash,service_revision,status,attempts,next_attempt_at,reason,updated_at,diagnostics_json)
  VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(address_id) DO UPDATE SET input_hash=excluded.input_hash,
    service_revision=excluded.service_revision,status=excluded.status,attempts=excluded.attempts,
    next_attempt_at=excluded.next_attempt_at,reason=excluded.reason,updated_at=excluded.updated_at,diagnostics_json=excluded.diagnostics_json`)
  .bind(row.id, fingerprint(row), stateRevision(revision, status, reason), status, attempts, retryAt, reason, now.toISOString(), JSON.stringify(diagnostics)).run();

// Catalog region and city names replace machine translations; regions resolve from the admin1 text, not the code.
const canonicalTranslations = async (database, row, variants, catalogs) => {
  if (!administrativeNameCountries(row.country_code)) return;
  if (!catalogs.has(row.country_code)) catalogs.set(row.country_code, await loadAdministrativeNames(database, row.country_code));
  const corrections = catalogs.get(row.country_code).names(variants.native, variants);
  for (const language of ['en', 'zh-CN']) {
    for (const [field, name] of Object.entries(corrections[language])) {
      if (clean(variants.native?.[field]) && usableTranslation(name, language, variants.native[field])) variants[language][field] = name;
    }
  }
};

const localizedRow = (row, variants) => ({ ...row, component_variants_json: JSON.stringify(variants),
  address_variants_json: JSON.stringify({ ...parse(row.address_variants_json),
    en: localizedFormattedAddress(variants.en, row.country_code, 'en'),
    'zh-CN': localizedFormattedAddress(variants['zh-CN'], row.country_code, 'zh-CN') }) });
const translationDiagnostics = (row, variants) => Object.entries(pendingTranslationFields(variants, row.native_language, row))
  .flatMap(([language, fields]) => fields.map((field) => ({ stage: 'translation', language, field, code: 'invalid_or_missing_translation' })));
// English-first publication: an address publishes once its English variant is complete; Chinese fields still
// untranslated carry the English (or source) text and the row stays queued until the Chinese names replace them.
const chinesePending = (row, variants) => pendingTranslationFields(variants, row.native_language, row)['zh-CN'].length > 0;
const CHINESE_FALLBACK_REASONS = ['chinese_fallback', 'chinese_street_fallback'];
// A pending Chinese value that already reads in Chinese script (a Japanese place written in kanji) stays; only an empty or
// unusable one takes the English or source text.
const applyChineseFallback = (row, variants) => {
  for (const field of pendingTranslationFields(variants, row.native_language, row)['zh-CN']) {
    const current = clean(variants['zh-CN']?.[field]);
    const original = clean(variants.native?.[field]);
    if (current && /\p{Script=Han}/u.test(current) && usableTranslation(current, 'zh-CN', original, field)) continue;
    const fallback = [clean(variants.en?.[field]), original].find((value) => value && componentLooksLocalized(value, 'zh-CN'));
    variants['zh-CN'] = { ...variants['zh-CN'], [field]: fallback || '' };
  }
};
const readyToPublish = (row, variants, now) => {
  applyChineseFallback(row, variants);
  const issues = translationDiagnostics(row, variants).filter((issue) => issue.language === 'en');
  return !issues.length && storedAddressPoolV2RowIsPublishable(localizedRow(row, variants), now);
};

// Node-level coverage is rebuilt at most once per interval per country; publication itself only takes row locks.
const COVERAGE_REFRESH_INTERVAL_MS = 10 * 60_000;
const PUBLICATION_WINDOW_MS = 120_000;
const CHINESE_FALLBACK_RETRY_MS = 6 * 60 * 60_000;
const DEFERRED_CHINESE_BACKLOG = 200;
const TERMINAL_FAILURE_REASONS = ['translation_or_publication_rejected', 'retry_limit', 'publication_timeout', 'publication_conflict'];
const coverageRefreshedAt = new Map();

export const refreshStaleCoverage = async (database, now, { force = false } = {}) => {
  // One country per cycle keeps the table lock short and leaves the rest of the cycle to publication.
  const due = [...staleCoverage]
    .filter((country) => force || Date.now() - (coverageRefreshedAt.get(country) || 0) >= COVERAGE_REFRESH_INTERVAL_MS)
    .sort((left, right) => (coverageRefreshedAt.get(left) || 0) - (coverageRefreshedAt.get(right) || 0));
  for (const country of force ? due : due.slice(0, 1)) {
    try {
      await database.transaction(async (transaction) => {
        await transaction.exec("SET LOCAL lock_timeout TO '250ms'");
        await transaction.exec("SET LOCAL statement_timeout TO '120s'");
        await transaction.exec(`LOCK TABLE address_pool,address_pool_evidence,address_datasets,address_sources,
          address_generation_index,admin_coverage_stats,residential_coverage,sync_country_state
          IN SHARE ROW EXCLUSIVE MODE`);
        await refreshResidentialCoverage(transaction, country, now().toISOString(), undefined,
          { useGenerationIndex: true, inTransaction: true });
      });
      staleCoverage.delete(country);
      coverageRefreshedAt.set(country, Date.now());
    } catch (error) {
      if (!['55P03', '57014', '40001', '40P01'].includes(error.code)) throw error;
    }
  }
};

const publish = async (database, candidates, revision, now, signal, outcome, countries, startBefore = Infinity) => {
  const { published, busy, failed, started, deferred, timings } = outcome;
  let mark = Date.now();
  const lap = (stage) => { const at = Date.now(); timings[stage] = (timings[stage] || 0) + at - mark; mark = at; };
  for (const country of countries) {
    signal.throwIfAborted();
    // Countries that would start past the deadline wait for the next batch.
    if (published.size && Date.now() >= startBefore) {
      candidates.filter(({ row }) => row.country_code === country).forEach(({ row }) => deferred.add(row.id));
      continue;
    }
    try {
    const completed = await database.transaction(async (transaction) => {
      await transaction.exec("SET LOCAL lock_timeout TO '2s'");
      await transaction.exec("SET LOCAL statement_timeout TO '60s'");
      mark = Date.now();
      const ids = candidates.filter(({ row }) => row.country_code === country).map(({ row }) => row.id).sort();
      // Row locks serialize with imports touching the same addresses; the reread below sees their committed state.
      await transaction.prepare(`SELECT id FROM address_pool WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY id FOR UPDATE`)
        .bind(...ids).all();
      ids.forEach((id) => started.add(id));
      lap('lock');
      const currentRows = await sourceRows(transaction, ids);
      lap('read');
      const updates = [];
      const activated = new Map();
      for (const { row, variants } of candidates.filter((item) => item.row.country_code === country)) {
        signal.throwIfAborted();
        const current = currentRows.get(row.id);
        if (!current || fingerprint(current) !== fingerprint(row) || !eligibleRetirement(current)) continue;
        const candidate = localizedRow(current, variants);
        if (!storedAddressPoolV2RowIsPublishable(candidate, now())) continue;
        const stored = parse(current.component_variants_json);
        if (current.administrative_patch_json && stored.native) candidate.component_variants_json = JSON.stringify({ ...variants, native: stored.native });
        await transaction.prepare(`UPDATE address_pool SET component_variants_json=?,address_variants_json=?,active=1,retired_at=NULL WHERE id=?`)
          .bind(candidate.component_variants_json, candidate.address_variants_json, row.id).run();
        if (Number(current.active) !== 1) activated.set(current.dataset_id, (activated.get(current.dataset_id) || 0) + 1);
        updates.push(row);
      }
      lap('write');
      if (!updates.length) return [];
      signal.throwIfAborted();
      const addressIds = updates.map((row) => row.id);
      const before = await generationIndexContribution(transaction, country, addressIds);
      await refreshAddressGenerationIndex(transaction, country, { addressIds });
      lap('index');
      signal.throwIfAborted();
      // Recounting a large country per batch took up to a minute and hit the statement timeout.
      const after = await generationIndexContribution(transaction, country, addressIds);
      await adjustCountryCounts(transaction, country,
        { total: after.total - before.total, residential: after.residential - before.residential }, now().toISOString());
      lap('counts');
      // Only reactivated rows change a dataset's active count; recounting large datasets per batch is too slow.
      for (const [dataset, count] of activated) {
        await transaction.prepare('UPDATE address_datasets SET active_count=active_count+? WHERE id=?').bind(count, dataset).run();
      }
      await transaction.prepare(`INSERT INTO address_pool_revisions(kind,version) VALUES ('translation',?)
        ON CONFLICT(kind) DO UPDATE SET version=excluded.version`).bind(now().toISOString()).run();
      const publishedRows = await sourceRows(transaction, updates.map((row) => row.id));
      for (const row of updates) {
        const current = publishedRows.get(row.id);
        const { attempts, variants } = candidates.find((item) => item.row.id === row.id);
        if (chinesePending(row, variants)) {
          await saveState(transaction, current, revision, 'waiting', attempts, new Date(now().getTime() + CHINESE_FALLBACK_RETRY_MS).toISOString(),
            'chinese_fallback', now());
        } else await transaction.prepare('DELETE FROM translation_recovery WHERE address_id=?').bind(current.id).run();
      }
      lap('state');
      signal.throwIfAborted();
      return updates.map((row) => row.id);
    });
    completed.forEach((id) => published.add(id));
    if (completed.length) staleCoverage.add(country);
    } catch (error) {
      if (!['55P03', '57014', '40001', '40P01'].includes(error.code)) throw error;
      for (const { row } of candidates.filter(({ row }) => row.country_code === country)) {
        if (error.code === '55P03') busy.add(row.id);
        else failed.set(row.id, error.code === '57014' ? 'publication_timeout' : 'publication_conflict');
      }
    }
  }
};

const runTranslationBatch = async ({ database, environment = process.env, fetchImpl = fetch,
  pendingLimit = integer(environment.TRANSLATION_BACKFILL_BATCH, 1_000, 2_000),
  scanLimit = integer(environment.TRANSLATION_BACKFILL_SCAN, 2000, 20_000),
  now = () => new Date(), signal: parentSignal, brokerClient, cacheOnly: onlyCached = false, countryCodes = [] }) => {
  const countries = [...new Set(countryCodes.map((country) => String(country).toUpperCase()))];
  if (countries.some((country) => !/^[A-Z]{2}$/u.test(country) || country === 'CN')) throw new Error('INVALID_RECOVERY_COUNTRY');
  const countryScope = countries.length ? ` AND address.country_code IN (${countries.map(() => '?').join(',')})` : '';
  const progressKey = onlyCached || countries.length ? `scan:${onlyCached ? 'cache' : 'online'}:${countries.sort().join(',') || 'all'}` : 'scan';
  const timeoutMs = integer(environment.TRANSLATION_BACKFILL_TIMEOUT_MS, 300_000, 600_000);
  const timeout = AbortSignal.timeout(timeoutMs);
  const translationDeadlineAt = Date.now() + timeoutMs * 0.75;
  const signal = parentSignal ? AbortSignal.any([parentSignal, timeout]) : timeout;
  const services = await createBackfillProviders({ database, environment, fetchImpl, signal, now, brokerClient });
  if (!services.enabled && !onlyCached) return { scanned: 0, updated: 0, done: true };
  const progress = await readBackfillProgress(database, progressKey, { phase: onlyCached ? 'all' : 'street', cursor: '' });
  const cacheProgress = await readBackfillProgress(database, 'terminal-cache', { cursor: '' });
  const terminal = onlyCached ? [] : (await database.prepare(`SELECT recovery.address_id AS id,address.country_code FROM translation_recovery recovery
    JOIN address_pool address ON address.id=recovery.address_id
    WHERE recovery.status='failed' AND recovery.reason IN ('translation_or_publication_rejected','retry_limit')
      AND recovery.address_id>?${countryScope} ORDER BY recovery.address_id LIMIT ?`).bind(cacheProgress.cursor, ...countries, pendingLimit).all()).results;
  // Bound each due branch through the recovery indexes before joining addresses; hundreds of thousands of
  // deferred rows can be due at once, and sorting all of them exceeds the statement timeout.
  const scopedRecovery = countries.length
    ? ` AND address_id IN (SELECT id FROM address_pool address WHERE 1=1${countryScope})` : '';
  const dueBranch = async (where, bindings, order) => (await database.prepare(`SELECT recovery.address_id AS id,
      address.country_code,address.match_level,address.active,recovery.updated_at
    FROM (SELECT address_id,updated_at FROM translation_recovery WHERE ${where}${scopedRecovery} ORDER BY ${order} LIMIT ?) recovery
    JOIN address_pool address ON address.id=recovery.address_id`).bind(...bindings, ...countries, scanLimit).all()).results;
  // A status list with an OR on the attempt time reads every waiting row and timed out under load; each status and
  // attempt-time form walks the (status,next_attempt_at,address_id) index in order and stops at the limit.
  const retryDue = [];
  for (const status of onlyCached ? [] : ['pending', 'waiting']) {
    retryDue.push(...await dueBranch('status=? AND next_attempt_at<=?', [status, now().toISOString()], 'next_attempt_at,address_id'),
      ...await dueBranch('status=? AND next_attempt_at IS NULL', [status], 'next_attempt_at,address_id'));
  }
  const due = onlyCached ? [] : [
    ...retryDue,
    ...await dueBranch(`status='failed' AND reason NOT IN (${TERMINAL_FAILURE_REASONS.map(() => '?').join(',')})`,
      TERMINAL_FAILURE_REASONS, 'address_id'),
    // One status per branch: a status list cannot walk the (status,address_id) index in order, and the primary-key
    // scan it falls back to reads every recovery row when no revision is stale.
    ...await dueBranch(`status='rejected' AND service_revision<>CASE WHEN reason='base_contract' THEN ? ELSE ? END`,
      [stateRevision(services.revision, 'rejected', 'base_contract'), services.revision], 'address_id'),
    ...await dueBranch(`status='failed' AND service_revision<>CASE WHEN reason='translation_or_publication_rejected' THEN ? ELSE ? END`,
      [stateRevision(services.revision, 'failed', 'translation_or_publication_rejected'), services.revision], 'address_id')
  ].sort((left, right) => Number(left.match_level !== 'street') - Number(right.match_level !== 'street')
    || Number(right.active) - Number(left.active) || String(left.updated_at).localeCompare(String(right.updated_at)))
    .slice(0, scanLimit).map(({ id, country_code: countryCode }) => ({ id, country_code: countryCode }));
  // The cursor bounds both join sides, or the merge join walks every recovery row before it.
  const rows = (await database.prepare(`SELECT address.id,address.country_code,address.component_variants_json,address.native_language,
      address.active,address.retired_at,recovery.status AS recovery_status
    FROM address_pool address LEFT JOIN translation_recovery recovery ON recovery.address_id=address.id AND recovery.address_id>?
    WHERE address.country_code<>'CN' AND address.id>?
      AND (address.active=1 OR address.retired_at LIKE 'publication-validation:%')
      ${progress.phase === 'street' ? "AND address.match_level='street'" : ''}${countryScope} ORDER BY address.id LIMIT ?`)
    .bind(progress.cursor, progress.cursor, ...countries, scanLimit).all()).results;
  let scanned = 0;
  const pending = [];
  const outcome = { published: new Set(), busy: new Set(), failed: new Map(), started: new Set(), timings: {} };
  const deferred = new Set();
  let ready = [];
  let interrupted = null;
  let publicationSignal;
  let phase = 'preparation';
  const cache = new PostgresTranslationCache(database);
  const catalogs = new Map();
  const seen = new Set();
  try {
    for (const country of ['HK', 'SG']) {
      const addressIds = [...new Set([...due, ...terminal, ...rows].filter((row) => row.country_code === country).map((row) => row.id))];
      await refreshAdministrativeAssignments(database, country, { addressIds, signal });
    }
    const firstLane = Number(progress.lane || 0) % 3;
    progress.lane = (firstLane + 1) % 3;
    // Countries still below their address target are translated and published first.
    const belowTarget = new Set((await database.prepare(`SELECT policy.country_code FROM sync_country_policies policy
      LEFT JOIN sync_country_state state ON state.country_code=policy.country_code
      WHERE policy.enabled=1 AND coalesce(state.address_count,0)<policy.target_count`).all().catch(() => ({ results: [] })))
      .results.map((row) => row.country_code));
    const candidates = [...recoveryCandidates([due, rows, terminal], firstLane)]
      .sort((left, right) => Number(belowTarget.has(right.country_code)) - Number(belowTarget.has(left.country_code)));
    let prefetched = new Map();
    let recoveryStates = new Map();
    let cachedValues = {};
    for (let index = 0; index < candidates.length; index++) {
      signal.throwIfAborted();
      if (pending.length >= pendingLimit) break;
      if (index % 200 === 0) {
        const ids = [...new Set(candidates.slice(index, index + 200).map((row) => row.id))];
        prefetched = await sourceRows(database, ids);
        const states = (await database.prepare(`SELECT * FROM translation_recovery WHERE address_id IN (${ids.map(() => '?').join(',')})`)
          .bind(...ids).all()).results;
        recoveryStates = new Map(states.map((state) => [state.address_id, state]));
        // Cache-only passes read both languages and a backlog reads Chinese names, once per 200 candidates.
        if (onlyCached || candidates.length >= DEFERRED_CHINESE_BACKLOG) {
          const values = [...new Set([...prefetched.values()].flatMap((row) => {
            const native = parse(projectAdministrativeRow(row).component_variants_json).native || {};
            return localizedFields.map((field) => clean(native[field])).filter(Boolean);
          }))];
          cachedValues = { en: onlyCached ? await cache.get(values, 'en', signal) : new Map(), 'zh-CN': await cache.get(values, 'zh-CN', signal) };
        }
      }
      const scannedRow = candidates[index];
      if (rows.includes(scannedRow)) { progress.cursor = scannedRow.id; scanned += 1; }
      if (terminal.includes(scannedRow)) cacheProgress.cursor = scannedRow.id;
      if (seen.has(scannedRow.id)) continue;
      seen.add(scannedRow.id);
      const row = prefetched.get(scannedRow.id);
      if (!row || !eligibleRetirement(row)) {
        await database.prepare(`UPDATE translation_recovery SET status='rejected',reason='source_unavailable',
          diagnostics_json='[{"stage":"source","code":"source_unavailable"}]',
          service_revision=?,next_attempt_at=NULL,updated_at=? WHERE address_id=?`)
          .bind(services.revision, now().toISOString(), scannedRow.id).run();
        continue;
      }
      const previous = recoveryStates.get(row.id);
      if (row.active === 1 && storedAddressPoolV2RowIsFullyTranslated(row, now())) {
        if (previous) await database.prepare('DELETE FROM translation_recovery WHERE address_id=?').bind(row.id).run();
        continue;
      }
      const unchanged = previous?.input_hash === fingerprint(row)
        && previous?.service_revision === stateRevision(services.revision, previous?.status, previous?.reason);
      // Earlier releases stored waits that ran out of attempts as terminal failures; they get one final attempt.
      const transientFailure = previous?.status === 'failed' && !TERMINAL_FAILURE_REASONS.includes(previous.reason);
      const cacheOnly = onlyCached || unchanged && (previous.status === 'failed'
        && ['translation_or_publication_rejected', 'retry_limit'].includes(previous.reason)
        || previous.status === 'waiting' && previous.attempts >= 3
          && ['publication_busy', 'publication_deferred', 'cancelled', 'batch_timeout'].includes(previous.reason));
      if (unchanged && !onlyCached && (previous.status === 'rejected'
        || previous.status === 'failed' && !cacheOnly && !transientFailure
        || previous.next_attempt_at && previous.next_attempt_at > now().toISOString())) continue;
      if (!storedAddressPoolV2RowCanRecoverTranslations(row, now())) {
        if (!onlyCached) await saveState(database, row, services.revision, 'rejected', 0, null, 'base_contract', now(),
          diagnoseStoredAddressPoolV2Row(row, { recovery: true, now: now() }).issues);
        continue;
      }
      const attempts = cacheOnly ? Number(previous?.attempts || 0) : transientFailure ? 3 : unchanged ? previous.attempts + 1 : 1;
      if (attempts > 3) {
        await saveState(database, row, services.revision, 'failed', 3, null, 'retry_limit', now());
        continue;
      }
      const retryAt = new Date(now().getTime() + 60_000 * 2 ** (attempts - 1)).toISOString();
      const variants = parse(projectAdministrativeRow(row).component_variants_json);
      variants.en = { ...variants.native, ...variants.en };
      variants['zh-CN'] = { ...variants.native, ...variants['zh-CN'] };
      for (const language of ['en', 'zh-CN']) {
        for (const [field, value] of Object.entries(variants.native || {})) {
          if (!localizedFields.includes(field)) variants[language][field] = value;
        }
      }
      await canonicalTranslations(database, row, variants, catalogs);
      let fields = pendingTranslationFields(variants, row.native_language, row);
      if (cacheOnly) {
        for (const language of ['en', 'zh-CN']) {
          const cached = onlyCached ? cachedValues[language]
            : await cache.get(fields[language].map((field) => clean(variants.native[field])), language, signal);
          for (const field of fields[language]) {
            const original = clean(variants.native[field]);
            const value = cached.get(original);
            if (usableTranslation(value, language, original, field) && safeTranslatedField(row, field, value)) variants[language][field] = value;
          }
        }
        if (row.active === 1 && chinesePending(row, variants) && storedAddressPoolV2RowIsPublishable(row, now())) continue;
        if (!readyToPublish(row, variants, now())) continue;
        fields = { en: [], 'zh-CN': [] };
      }
      // Under a backlog, Chinese names come from the cache only; providers translate English first so addresses
      // publish, and the Chinese fields follow on the later fallback retry.
      if (!cacheOnly && candidates.length >= DEFERRED_CHINESE_BACKLOG && !CHINESE_FALLBACK_REASONS.includes(previous?.reason)
        && fields['zh-CN'].length) {
        const cached = cachedValues['zh-CN'];
        for (const field of fields['zh-CN']) {
          const original = clean(variants.native[field]);
          const value = cached.get(original);
          if (usableTranslation(value, 'zh-CN', original, field) && safeTranslatedField(row, field, value)) variants['zh-CN'][field] = value;
        }
        fields = { ...fields, 'zh-CN': [] };
        // A published address with only Chinese names left waits for its fallback retry instead of a publication slot.
        if (!fields.en.length && row.active === 1 && storedAddressPoolV2RowIsPublishable(row, now())) {
          await saveState(database, row, services.revision, 'waiting', attempts,
            new Date(now().getTime() + CHINESE_FALLBACK_RETRY_MS).toISOString(), 'chinese_fallback', now());
          continue;
        }
      }
      pending.push({ row, variants, attempts, retryAt, fields, cacheOnly });
      if (!cacheOnly) await saveState(database, row, services.revision, 'pending', attempts, retryAt, 'in_progress', now());
    }
    signal.throwIfAborted();
    phase = 'translation';
    // Provider calls stop at a soft deadline; chunks finished by then are cached and still publish this batch.
    const translationSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, translationDeadlineAt - Date.now()))]);
    for (const language of ['en', 'zh-CN']) {
      const values = [...new Set(pending.flatMap(({ variants, fields }) => fields[language].map((field) => clean(variants.native[field]))))];
      const accepts = (value, target, original) => usableTranslation(value, target, original)
          && pending.every(({ row, variants, fields }) => fields[target].every((field) => clean(variants.native[field]) !== original
            || usableTranslation(value, target, original, field) && safeTranslatedField(row, field, value)));
      const providerEnvironment = { ...environment, GOOGLE_TRANSLATION_ENABLED: String(services.googleEnabled) };
      let translations;
      try {
        translations = await translateValues(values, language, providerEnvironment, fetchImpl, cache, translationSignal, services.providers, accepts);
        const repaired = await translateNumberedValues(values.filter((value) => !accepts(translations.get(value), language, value)),
          language, providerEnvironment, fetchImpl, cache, translationSignal, services.providers, accepts);
        for (const [value, translated] of repaired) translations.set(value, translated);
      } catch (error) {
        if (signal.aborted || !translationSignal.aborted) throw error;
        translations = await cache.get(values, language, signal);
      }
      for (const { row, variants, fields } of pending) {
        for (const field of fields[language]) {
          const original = clean(variants.native[field]);
          const value = translations.get(original);
          if (usableTranslation(value, language, original, field) && safeTranslatedField(row, field, value)) variants[language][field] = value;
        }
      }
    }
    ready = pending.filter(({ row, variants }) => readyToPublish(row, variants, now()));
    // Publish below-target countries first, then those with the most ready rows.
    const readyByCountry = new Map();
    for (const { row } of ready) readyByCountry.set(row.country_code, (readyByCountry.get(row.country_code) || 0) + 1);
    const publicationOrder = [...readyByCountry].sort((left, right) => Number(belowTarget.has(right[0])) - Number(belowTarget.has(left[0]))
      || right[1] - left[1]).map(([country]) => country);
    phase = 'publication';
    // Publication has its own window so a slow translation phase cannot abort it halfway.
    const publicationTimeout = AbortSignal.timeout(PUBLICATION_WINDOW_MS);
    publicationSignal = parentSignal ? AbortSignal.any([parentSignal, publicationTimeout]) : publicationTimeout;
    await publish(database, ready, services.revision, now, publicationSignal, { ...outcome, deferred }, publicationOrder,
      Date.now() + PUBLICATION_WINDOW_MS * 0.85);
  } catch (error) {
    if (!signal.aborted && !publicationSignal?.aborted) throw error;
    interrupted = parentSignal?.aborted ? 'cancelled' : 'batch_timeout';
  }
  const readyIds = new Set(ready.map(({ row }) => row.id));
  for (const { row, variants, fields, attempts, cacheOnly } of pending) {
    if (outcome.published.has(row.id)) continue;
    const hasProviderResult = (predicate) => Object.entries(fields).some(([language, names]) =>
      names.some((field) => predicate(clean(variants.native[field]), language)));
    const publicationFailure = outcome.failed.get(row.id);
    const waitingReason = deferred.has(row.id) ? 'publication_deferred'
      : outcome.busy.has(row.id) ? 'publication_busy' : interrupted;
    const waiting = waitingReason ? { reason: waitingReason, retryAt: new Date(now().getTime() + 60_000).toISOString() }
      : !publicationFailure && !readyIds.has(row.id) ? services.wait : null;
    const spentAttempt = !deferred.has(row.id) && !outcome.busy.has(row.id) && Boolean(publicationFailure || (interrupted
      ? outcome.started.has(row.id) || hasProviderResult(services.wasDispatched)
      : !waiting || hasProviderResult(services.failed)));
    const usedAttempts = attempts - Number(!spentAttempt && !cacheOnly);
    const retryAt = new Date(now().getTime() + 60_000 * 2 ** Math.max(0, usedAttempts - 1)).toISOString();
    let nextAttemptAt = waiting?.retryAt || retryAt;
    if (spentAttempt && nextAttemptAt < retryAt) nextAttemptAt = retryAt;
    // A provider cooldown or quota is a wait, not a translation failure: the row retries after the reset with its
    // final provider attempt still in reserve. Interrupted rows that spent every attempt resume from the cache.
    const providerWait = Boolean(waiting && !waitingReason);
    const storedAttempts = providerWait ? Math.min(usedAttempts, 2) : usedAttempts;
    const status = waiting ? 'waiting' : storedAttempts >= 3 ? 'failed' : 'pending';
    await saveState(database, row, services.revision, status, storedAttempts,
      status === 'failed' ? null : nextAttemptAt,
      publicationFailure || waiting?.reason || 'translation_or_publication_rejected', now(),
      [...translationDiagnostics(row, variants), ...diagnoseStoredAddressPoolV2Row(localizedRow(row, variants), { now: now() }).issues]);
  }
  const completed = !interrupted && (!rows.length || scanned === rows.length && rows.length < scanLimit);
  if (completed) {
    progress.cursor = '';
    progress.phase = onlyCached || progress.phase === 'street' ? 'all' : 'street';
  }
  await writeBackfillProgress(database, progressKey, progress, now());
  if (!onlyCached) {
    if (!terminal.length || cacheProgress.cursor === terminal.at(-1)?.id && terminal.length < pendingLimit) cacheProgress.cursor = '';
    await writeBackfillProgress(database, 'terminal-cache', cacheProgress, now());
  }
  return { scanned, updated: outcome.published.size, attempted: pending.length, requests: services.requests, done: onlyCached && completed,
    ...(outcome.busy.size ? { publicationBusy: outcome.busy.size } : {}),
    ...(Object.keys(outcome.timings).length ? { publicationMs: outcome.timings } : {}),
    ...(interrupted ? { interrupted, phase } : {}) };
};

export const runTranslationBackfillBatch = async (options) => {
  const environment = options.environment || process.env;
  if (/^(0|false|no)$/iu.test(String(environment.TRANSLATION_BACKFILL_ENABLED))) return { scanned: 0, updated: 0, done: true };
  const lease = await options.database.pool.connect();
  let acquired = false;
  try {
    acquired = Boolean((await lease.query('SELECT pg_try_advisory_lock(172901,1) AS acquired')).rows[0]?.acquired);
    if (!acquired) return { scanned: 0, updated: 0, attempted: 0, requests: 0, done: false, waiting: 'recovery_in_progress' };
    return await runTranslationBatch(options);
  } finally {
    let discard = false;
    try { if (acquired) await lease.query('SELECT pg_advisory_unlock(172901,1)'); }
    catch { discard = true; }
    lease.release(discard);
  }
};

export const startTranslationBackfill = ({ database, environment = process.env, isBusy = () => false,
  intervalMs = integer(environment.TRANSLATION_BACKFILL_INTERVAL_MS, 60_000, 3_600_000),
  setTimer = setTimeout, now = () => new Date(), fetchImpl = fetch, workerPool }) => {
  if (/^(0|false|no)$/iu.test(String(environment.TRANSLATION_BACKFILL_ENABLED))) return async () => {};
  // Import uses a legacy transaction connection; this worker needs its own transaction context.
  const pool = workerPool || createPostgresPool({ ...database.pool.options, max: 2, min: 0,
    statement_timeout: 15_000, application_name: 'address-translation-backfill' });
  const workerDatabase = new PostgresDatabase(pool);
  const controller = new AbortController();
  let timer;
  let running = Promise.resolve();
  // A non-empty batch means a backlog; keep draining it instead of idling a full interval.
  let backlog = false;
  const schedule = () => {
    if (controller.signal.aborted) return;
    timer = setTimer(() => {
      running = runTranslationBackfillBatch({ database: workerDatabase, environment, now, fetchImpl, signal: controller.signal })
        .then((result) => {
          backlog = Number(result.attempted || 0) > 0;
          if (result.attempted) console.log(JSON.stringify({ event: 'translation_backfill', ...result, duringSync: isBusy() }));
        })
        .then(async () => {
          controller.signal.throwIfAborted();
          const result = await runTranslationBackfillBatch({ database: workerDatabase, environment, now, fetchImpl,
            signal: controller.signal, cacheOnly: true, pendingLimit: 300 });
          if (result.updated) console.log(JSON.stringify({ event: 'translation_cache_recovery', ...result }));
          await refreshStaleCoverage(workerDatabase, now);
        })
        .catch((error) => { if (!controller.signal.aborted) console.error('Translation backfill failed',
          error.name, typeof error.code === 'string' ? error.code : ''); })
        .finally(schedule);
      return running;
    }, backlog ? 1_000 : intervalMs);
    timer.unref?.();
  };
  schedule();
  return async () => {
    controller.abort(); clearTimeout(timer); await running;
    if (pool !== database.pool) await pool.end();
  };
};
