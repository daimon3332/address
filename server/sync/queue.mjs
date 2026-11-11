import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { loadSourceCatalog, sourceAdapterRevisions, sourceCapabilityRevision } from './source-adapters.mjs';
import { evaluateCountryGoals } from './country-goals.mjs';
import { CHINA_PRIORITY_TARGET } from './address-policy.mjs';
import { ADDRESS_IMPORT_REVISION } from './postgres-address-importer.mjs';
import { createCredentialBrokerClient } from '../credential-broker/client.mjs';
import { statfs } from 'node:fs/promises';
import { measureStorageBytes, storageFull, storageLimits } from './storage-budget.mjs';

export const LATCH_REASON = 'source_limited_cache';
export const CHECKED_REASON = 'source_version_checked';
export const SUSPENDED_REASON = 'retry_suspended';
export const STORAGE_WAIT_REASON = 'storage_wait';
export const BACKOFF_REASON = 'retry_backoff';
export const SHARED_FAILURE_REASON = 'shared_failure_circuit';
export const PARTIAL_REASON = 'source_partial_checkpoint';
export const PARTIAL_STALLED_REASON = 'source_partial_stalled';
// A run that imported its per-run growth step while the source still holds more: the same version runs again.
export const GROWTH_REASON = 'source_growth_step';
const DEFAULT_SOURCE_PROBE_MS = 24 * 60 * 60_000;
const STALE_CREDENTIAL_CHECKPOINT_MS = 24 * 60 * 60_000;
// Failure codes that deterministically repeat for identical inputs; the ETL
// skips same-signature retries itself, so a fruitless pass latches immediately.
const deterministicFailureCodes = new Set(['SOURCE_QUALITY_FAILED', 'SNAPSHOT_QUALITY_FAILED']);
const timeoutFailureCodes = new Set([
  '57014', 'QUERY_CANCELED', 'SYNC_JOB_TIMEOUT', 'SYNC_WORKER_STUCK', 'SYNC_PROCESS_TIMEOUT', 'SYNC_PROCESS_ABORTED'
]);
const circuitBreakerFailureCodes = new Set([...timeoutFailureCodes, 'SYNC_PROCESS_FAILED']);
const executionCapabilityRevisions = Object.freeze({
  // v4: imports run on the dedicated 4C24G host with a 6 h job deadline and 10 min cancellation grace (2026-10-25).
  import: 'postgres-publish-v4-dedicated-host',
  materialize: 'child-process-diagnostics-v2',
  discover: 'source-discovery-v1',
  interrupted: 'restart-recovery-v3',
  runtime: 'sync-runtime-v3-recovery-index'
});
// Adapter-specific execution fixes release only matching suspended failures.
// They are intentionally excluded from source fingerprints, so exhausted and
// successfully checked sources remain terminal.
const adapterExecutionCapabilityRevisions = Object.freeze({
  'japan-abr': { materialize: 'japan-abr-materialize-v5-checkpoint-before-job-limit' },
  'korea-kapt': { materialize: 'korea-kapt-bridge-v3' },
  'google-residential-enrichment': { discover: 'google-checkpoint-discovery-v5-legacy-raw-url' },
  geofabrik: { discover: 'geofabrik-redirect-resolver-v3-dated-probe' }
});
// Countries whose synchronization consumes a metered provider quota. A shard
// may declare `quotaProvider` in source-shards.json to extend this; the
// korea-kapt shard does not yet, so KR -> geoapify is kept here on purpose.
const builtinQuotaProviders = { 'korea-kapt-residential': 'geoapify' };
const providerEnvironmentVariables = Object.freeze({
  geoapify: 'GEOAPIFY_API_KEY',
  'google-geocoding': 'GOOGLE_GEOCODING_API_KEY',
  mappls: 'MAPPLS_API_KEY',
  onemap: 'ONEMAP_ACCESS_TOKEN'
});
const revisionEmbeddedAdapters = new Set([
  'japan-abr', 'singapore-hdb', 'korea-kapt', 'inegi-residential', 'ethekwini-residential',
  'cape-town-residential', 'taiwan-residential', 'hong-kong-residential', 'mappls-residential',
  'pdok-bag', 'google-residential-enrichment'
]);

const timestamp = (value) => {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
};
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const initialProbeComparableVersion = (value, adapter) => String(value || '')
  .replace(adapter === 'geofabrik' ? /-p[a-f\d]{16}$/iu : /$^/u, '');
const parseJson = (value) => {
  try { return JSON.parse(String(value || '{}')); } catch { return {}; }
};
const integer = (value, fallback, minimum, maximum) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
};
const queueStateError = (message, cause) => Object.assign(new Error(message, { cause }), { code: 'QUEUE_STATE_INVALID' });
const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// Mirrors nextQuotaReset in server/control/store.ts (read-only reference).
export const nextQuotaResetTime = (period, offsetMinutes, date = new Date()) => {
  const offset = Number(offsetMinutes) || 0;
  const shifted = new Date(date.getTime() + offset * 60_000);
  if (period === 'month') shifted.setUTCMonth(shifted.getUTCMonth() + 1, 1);
  else shifted.setUTCDate(shifted.getUTCDate() + 1);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - offset * 60_000);
};
const quotaPeriodStart = (period, offsetMinutes, date = new Date()) => {
  const shifted = new Date(date.getTime() + (Number(offsetMinutes) || 0) * 60_000).toISOString();
  return period === 'month' ? shifted.slice(0, 7) : shifted.slice(0, 10);
};

const sortedPairs = (pairs) => [...pairs].map(([key, value]) => [String(key), String(value || '')])
  .sort(([left], [right]) => left.localeCompare(right));

export const countryFingerprint = ({ adapterRevisions = [], sourceVersions = [] }) =>
  sha256(JSON.stringify({
    adapterRevisions: sortedPairs(adapterRevisions),
    sourceVersions: sortedPairs(sourceVersions)
  }));

// Source capability changes must unlock only the opted-in source. Country
// policy edits intentionally stay outside this fingerprint. This allows an
// exporter capacity or strict extraction configuration change to re-evaluate
// an older snapshot without reopening unrelated exhausted sources.
export { sourceCapabilityRevision };

export const legacyCountryFingerprint = ({ importRevision = ADDRESS_IMPORT_REVISION, sourceVersions = [] }) =>
  sha256(JSON.stringify({ importRevision, sourceVersions: sortedPairs(sourceVersions) }));

const deprecatedCountryFingerprint = ({
  importRevision = ADDRESS_IMPORT_REVISION,
  policyUpdatedAt = '',
  nodeTargetsUpdatedAt = '',
  catalogVersion = '',
  adapterRevisions = [],
  sourceVersions = []
}) => sha256(JSON.stringify({
  importRevision,
  policyUpdatedAt: String(policyUpdatedAt || ''),
  nodeTargetsUpdatedAt: String(nodeTargetsUpdatedAt || ''),
  catalogVersion: String(catalogVersion || ''),
  adapterRevisions: sortedPairs(adapterRevisions),
  sourceVersions: sortedPairs(sourceVersions)
}));

export const normalizeFailurePhase = (value) => {
  const phase = String(value || '').trim().toLowerCase().split(':', 1)[0];
  return Object.hasOwn(executionCapabilityRevisions, phase) ? phase : 'runtime';
};

const inferredFailurePhase = (failureCode) => {
  const code = String(failureCode || '').toUpperCase();
  if (['57014', 'QUERY_CANCELED'].includes(code)) return 'import';
  if (code.startsWith('SYNC_PROCESS_')) return 'materialize';
  if (code === 'SYNC_JOB_INTERRUPTED') return 'interrupted';
  return 'runtime';
};

export const executionFailureFingerprint = (
  sourceFingerprint, credentialRevision = '', phase = 'runtime', adapter = ''
) => {
  const normalizedPhase = normalizeFailurePhase(phase);
  return sha256(JSON.stringify({
    sourceFingerprint,
    credentialRevision: String(credentialRevision || ''),
    phase: normalizedPhase,
    executionRevision: executionCapabilityRevisions[normalizedPhase],
    ...(adapterExecutionCapabilityRevisions[String(adapter || '').toLowerCase()]?.[normalizedPhase]
      ? { adapterExecutionRevision: adapterExecutionCapabilityRevisions[String(adapter).toLowerCase()][normalizedPhase] }
      : {})
  }));
};

export const systemicFailureSignature = ({ failureCode, error = '', failurePhase = 'runtime' }) => {
  const code = String(failureCode || '').toUpperCase();
  if (!circuitBreakerFailureCodes.has(code)) return null;
  const detail = timeoutFailureCodes.has(code) ? '' : String(error || '').toLowerCase()
    .replace(/[a-z]:\\[^\s]+|\/[\w./-]+/giu, '<path>')
    .replace(/\b\d+\b/gu, '<n>').replace(/\s+/gu, ' ').trim().slice(0, 500);
  return sha256(JSON.stringify({ code, phase: normalizeFailurePhase(failurePhase), detail }));
};

export const quotaProviderMap = (shards) => {
  const providers = { ...builtinQuotaProviders };
  for (const shard of shards || []) {
    if (shard.quotaProvider) providers[shard.id] = String(shard.quotaProvider);
  }
  return providers;
};

// Ordering rule: quota-bound countries whose quota window is open come first
// (use-it-or-lose-it, earliest upcoming reset first, i.e. least time left in
// the window); everything else follows by largest absolute deficit.
export const orderRunnable = (entries) => [...entries].sort((left, right) => {
  const leftQuota = left.quotaBound && left.quotaAvailable !== false ? 0 : 1;
  const rightQuota = right.quotaBound && right.quotaAvailable !== false ? 0 : 1;
  if (leftQuota !== rightQuota) return leftQuota - rightQuota;
  if (leftQuota === 0) {
    const leftReset = timestamp(left.quotaResetAt) || Number.MAX_SAFE_INTEGER;
    const rightReset = timestamp(right.quotaResetAt) || Number.MAX_SAFE_INTEGER;
    if (leftReset !== rightReset) return leftReset - rightReset;
  }
  const lastDispatched = timestamp(left.lastDispatchedAt) - timestamp(right.lastDispatchedAt);
  return lastDispatched || (right.deficit - left.deficit) || left.countryCode.localeCompare(right.countryCode);
});

export const estimateDuration = (samples, minimumSamples = 3) => {
  const values = (samples || []).map(Number).filter((value) => Number.isFinite(value) && value > 0)
    .sort((left, right) => left - right);
  if (values.length < minimumSamples) return null;
  const percentile = (value) => values[Math.max(0, Math.ceil(values.length * value) - 1)];
  return { sampleCount: values.length, medianMs: percentile(0.5), p80Ms: percentile(0.8) };
};

const goalDeficit = (rules) => {
  if (!rules) return Number.MAX_SAFE_INTEGER;
  const required = (summary, target = 1) => {
    if (!summary) return 0;
    return Math.max(0, Math.ceil(Number(summary.total || 0) * Number(target || 0)) - Number(summary.qualified || 0));
  };
  const coverage = rules.administrativeCoverage || {};
  const regional = rules.regionalMinimums || {};
  const total = rules.total || {};
  return Math.max(0, Number(total.target || 0) - Number(total.current || 0))
    + Math.max(0, Math.ceil(Number(coverage.total || 0) * Number(coverage.target || 0)) - Number(coverage.covered || 0))
    + required(regional.lowest, regional.target)
    + required(regional.level1, regional.target)
    + required(regional.level2, regional.target)
    + Math.max(0, Number(regional.overrides?.total || 0) - Number(regional.overrides?.satisfied || 0));
};

export const goalProgress = (rules) => ({
  deficit: goalDeficit(rules),
  total: Number(rules?.total?.current || 0),
  covered: Number(rules?.administrativeCoverage?.covered || 0),
  lowestQualified: Number(rules?.regionalMinimums?.lowest?.qualified || 0),
  level1Qualified: Number(rules?.regionalMinimums?.level1?.qualified || 0),
  level2Qualified: Number(rules?.regionalMinimums?.level2?.qualified || 0),
  overridesSatisfied: Number(rules?.regionalMinimums?.overrides?.satisfied || 0)
});

export const nextWakeAt = (entries, now = new Date()) => {
  let earliest = 0;
  for (const entry of entries || []) {
    const at = timestamp(entry.nextAttemptAt);
    if (at > now.getTime() && (!earliest || at < earliest)) earliest = at;
  }
  return earliest ? new Date(earliest) : null;
};

// A successful identical-input run with no goal progress exhausts that source.
// Transient failures back off, then stop for the same effective inputs after a
// bounded number of attempts.
export const evaluateAttempt = ({
  jobSucceeded,
  netGrowth,
  goalDeficitBefore = null,
  goalDeficitAfter = null,
  fingerprintAfter,
  failureFingerprintAfter = fingerprintAfter,
  deterministicFailure = false,
  failureCode = null,
  quotaBound = false,
  quotaAvailable = true,
  quotaResetAt = null,
  consecutiveFailures = 0,
  completedAt = new Date().toISOString(),
  backoffBaseMs = 5 * 60_000,
  backoffCapMs = 6 * 60 * 60_000,
  maxConsecutiveFailures = 8,
  maxTimeoutFailures = 2,
  probeIntervalMs = DEFAULT_SOURCE_PROBE_MS,
  adapter = null,
  failurePhase = null,
  failureSignature = null,
  sourceComplete = true,
  checkpointToken = null,
  previousCheckpointToken = null,
  checkpointStage = null,
  partialNextAttemptAt = null,
  partialStalls = 0,
  partialWorkCount = 0,
  partialMinimumWorkCount = 1,
  partialProgressEvaluationReady = false,
  maxPartialStalls = 3,
  growthCapped = false
}) => {
  const progressed = netGrowth > 0 || (goalDeficitBefore != null && goalDeficitAfter != null
    && Number(goalDeficitAfter) < Number(goalDeficitBefore));
  const retainedCheckpointToken = checkpointToken || previousCheckpointToken || null;
  if (sourceComplete === false && (jobSucceeded || failureCode === 'SOURCE_PARTIAL')) {
    const normalizedCheckpointStage = String(checkpointStage || '').toLowerCase();
    const checkpointProgressed = checkpointToken
      ? checkpointToken !== previousCheckpointToken
      : progressed;
    const workCount = Number(partialWorkCount || 0);
    const enoughEvaluatedWork = workCount >= Math.max(1, Number(partialMinimumWorkCount || 1));
    const noGoalProgress = partialProgressEvaluationReady && enoughEvaluatedWork && !progressed;
    const transientWait = workCount === 0
      && ['quota', 'credential', 'network'].includes(normalizedCheckpointStage);
    const countCheckpointStall = !checkpointProgressed && !transientWait;
    const stalls = noGoalProgress || countCheckpointStall
      ? Number(partialStalls || 0) + 1
      : checkpointProgressed ? 0 : Number(partialStalls || 0);
    const partialWaitAt = timestamp(partialNextAttemptAt) > timestamp(completedAt)
      ? partialNextAttemptAt
      : !quotaAvailable && timestamp(quotaResetAt) > timestamp(completedAt)
        ? quotaResetAt
        : ['quota', 'credential', 'network'].includes(String(checkpointStage || '').toLowerCase())
          ? new Date(timestamp(completedAt) + backoffBaseMs).toISOString()
          : null;
    if (noGoalProgress && stalls >= Math.max(1, maxPartialStalls)) {
      return {
        action: 'latch',
        reason: LATCH_REASON,
        fingerprint: fingerprintAfter,
        checkpointToken,
        consecutiveFailures: stalls,
        latchedAt: completedAt,
        nextAttemptAt: new Date(timestamp(completedAt) + Math.max(60_000, probeIntervalMs)).toISOString()
      };
    }
    if (!checkpointProgressed && stalls >= Math.max(1, maxPartialStalls)) {
      return {
        action: 'suspend',
        reason: PARTIAL_STALLED_REASON,
        fingerprint: failureFingerprintAfter,
        checkpointToken,
        consecutiveFailures: stalls,
        failureCode: 'SOURCE_PARTIAL_STALLED',
        adapter,
        failurePhase: failurePhase || 'materialize',
        failureSignature,
        nextAttemptAt: new Date(timestamp(completedAt) + Math.max(60_000, probeIntervalMs)).toISOString()
      };
    }
    return {
      action: 'checked',
      reason: checkpointProgressed ? PARTIAL_REASON : PARTIAL_STALLED_REASON,
      waitReason: ['quota', 'credential', 'network'].includes(normalizedCheckpointStage)
        ? normalizedCheckpointStage : null,
      fingerprint: fingerprintAfter,
      checkpointToken,
      consecutiveFailures: stalls,
      nextAttemptAt: partialWaitAt || (checkpointProgressed
        ? new Date(timestamp(completedAt) + 60_000).toISOString()
        : new Date(timestamp(completedAt) + Math.min(backoffCapMs, backoffBaseMs * 2 ** Math.max(0, stalls - 1))).toISOString())
    };
  }
  if (jobSucceeded && progressed) {
    // A run stopped only by its per-run growth step continues shortly instead of waiting a full interval.
    return {
      action: 'checked',
      reason: growthCapped ? GROWTH_REASON : CHECKED_REASON,
      fingerprint: fingerprintAfter,
      consecutiveFailures: 0,
      nextAttemptAt: new Date(timestamp(completedAt) + (growthCapped ? 60_000 : Math.max(60_000, probeIntervalMs))).toISOString()
    };
  }
  if (jobSucceeded || deterministicFailure) {
    return {
      action: 'latch',
      reason: LATCH_REASON,
      fingerprint: fingerprintAfter,
      latchedAt: completedAt,
      nextAttemptAt: new Date(timestamp(completedAt) + Math.max(60_000, probeIntervalMs)).toISOString()
    };
  }
  if (quotaBound && !quotaAvailable) {
    return { action: 'waiting_quota', nextAttemptAt: quotaResetAt, consecutiveFailures: 0 };
  }
  // Storage is a host resource, not a fault of the source: the shard waits without counting a failure.
  if (String(failureCode || '').toUpperCase() === 'ADDRESS_STORAGE_HARD_LIMIT') {
    return {
      action: 'backoff',
      reason: STORAGE_WAIT_REASON,
      fingerprint: failureFingerprintAfter,
      consecutiveFailures: Number(consecutiveFailures || 0),
      failureCode,
      checkpointToken: retainedCheckpointToken,
      adapter,
      failurePhase,
      failureSignature,
      nextAttemptAt: new Date(timestamp(completedAt) + 60 * 60_000).toISOString()
    };
  }
  if (String(failureCode || '').toUpperCase() === 'SYNC_JOB_INTERRUPTED') {
    return {
      action: 'backoff',
      fingerprint: failureFingerprintAfter,
      consecutiveFailures: Number(consecutiveFailures || 0),
      failureCode,
      checkpointToken: retainedCheckpointToken,
      adapter,
      failurePhase,
      failureSignature,
      nextAttemptAt: new Date(timestamp(completedAt) + Math.min(60_000, backoffBaseMs)).toISOString()
    };
  }
  const failures = consecutiveFailures + 1;
  const timeoutFailure = timeoutFailureCodes.has(String(failureCode || '').toUpperCase());
  if (failures >= Math.max(1, timeoutFailure ? maxTimeoutFailures : maxConsecutiveFailures)) {
    return {
      action: 'suspend',
      reason: SUSPENDED_REASON,
      fingerprint: failureFingerprintAfter,
      consecutiveFailures: failures,
      failureCode: failureCode || null,
      checkpointToken: retainedCheckpointToken,
      adapter,
      failurePhase,
      failureSignature,
      nextAttemptAt: new Date(timestamp(completedAt) + Math.max(60_000, probeIntervalMs)).toISOString()
    };
  }
  const delay = Math.min(backoffCapMs, backoffBaseMs * 2 ** (failures - 1));
  return {
    action: 'backoff',
    fingerprint: failureFingerprintAfter,
    consecutiveFailures: failures,
    failureCode: failureCode || null,
    checkpointToken: retainedCheckpointToken,
    adapter,
    failurePhase,
    failureSignature,
    nextAttemptAt: new Date(timestamp(completedAt) + delay).toISOString()
  };
};

export class QueueStateStore {
  constructor(file) {
    this.file = resolve(file);
  }

  async load() {
    let value;
    try {
      value = await readFile(this.file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return { schemaVersion: 1, countries: {} };
      throw queueStateError(`Unable to read queue state: ${this.file}`, error);
    }
    let state;
    try { state = JSON.parse(value); }
    catch (error) { throw queueStateError(`Queue state is not valid JSON: ${this.file}`, error); }
    if (state?.schemaVersion !== 1 || !isRecord(state.countries)) {
      throw queueStateError(`Queue state has an unsupported structure: ${this.file}`);
    }
    return state;
  }

  async save(state) {
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
    try {
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
      await rename(temporary, this.file);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  async apply(countryCode, evaluation, evaluatedAt, shardId = null) {
    const state = await this.load();
    let target;
    if (shardId) {
      const country = state.countries[countryCode] ||= { shards: {} };
      country.shards ||= {};
      target = country.shards;
    } else {
      target = state.countries;
    }
    const key = shardId || countryCode;
    if (evaluation.action === 'latch') {
      target[key] = {
        state: 'latched',
        latched: true,
        reason: evaluation.reason || LATCH_REASON,
        fingerprint: evaluation.fingerprint,
        latchedAt: evaluation.latchedAt || evaluatedAt,
        consecutiveFailures: Number(evaluation.consecutiveFailures || 0),
        checkpointToken: evaluation.checkpointToken || null,
        probeFailures: Number(evaluation.probeFailures || 0),
        probeVersion: evaluation.probeVersion || null,
        nextAttemptAt: evaluation.nextAttemptAt || null,
        updatedAt: evaluatedAt
      };
    } else if (evaluation.action === 'checked') {
      target[key] = {
        state: 'checked',
        latched: false,
        reason: evaluation.reason || CHECKED_REASON,
        fingerprint: evaluation.fingerprint,
        consecutiveFailures: Number(evaluation.consecutiveFailures || 0),
        checkpointToken: evaluation.checkpointToken || null,
        probeFailures: Number(evaluation.probeFailures || 0),
        probeVersion: evaluation.probeVersion || null,
        nextAttemptAt: evaluation.nextAttemptAt || null,
        updatedAt: evaluatedAt
      };
    } else if (evaluation.action === 'suspend') {
      target[key] = {
        state: 'suspended',
        latched: false,
        reason: evaluation.reason || SUSPENDED_REASON,
        fingerprint: evaluation.fingerprint,
        consecutiveFailures: evaluation.consecutiveFailures,
        checkpointToken: evaluation.checkpointToken || null,
        probeFailures: Number(evaluation.probeFailures || 0),
        probeVersion: evaluation.probeVersion || null,
        failureCode: evaluation.failureCode || null,
        adapter: evaluation.adapter || null,
        failurePhase: evaluation.failurePhase || null,
        failureSignature: evaluation.failureSignature || null,
        nextAttemptAt: evaluation.nextAttemptAt || null,
        updatedAt: evaluatedAt
      };
    } else if (evaluation.action === 'backoff') {
      target[key] = {
        state: 'backoff',
        latched: false,
        fingerprint: evaluation.fingerprint || null,
        consecutiveFailures: evaluation.consecutiveFailures,
        checkpointToken: evaluation.checkpointToken || null,
        probeFailures: Number(evaluation.probeFailures || 0),
        probeVersion: evaluation.probeVersion || null,
        failureCode: evaluation.failureCode || null,
        adapter: evaluation.adapter || null,
        failurePhase: evaluation.failurePhase || null,
        failureSignature: evaluation.failureSignature || null,
        nextAttemptAt: evaluation.nextAttemptAt,
        updatedAt: evaluatedAt
      };
    } else if (evaluation.action === 'waiting_quota') {
      delete target[key];
    } else {
      delete target[key];
    }
    if (shardId) {
      const country = state.countries[countryCode];
      country.updatedAt = evaluatedAt;
      if (!Object.keys(country.shards || {}).length) delete state.countries[countryCode];
    }
    await this.save(state);
    return state;
  }

  async clear(countryCodes) {
    const state = await this.load();
    if (countryCodes.some((countryCode) => String(countryCode).toLowerCase() === 'all')) state.countries = {};
    else for (const value of countryCodes) {
      const identifier = String(value);
      if (/^[a-z]{2}$/iu.test(identifier)) delete state.countries[identifier.toUpperCase()];
      else for (const [countryCode, country] of Object.entries(state.countries)) {
        delete country.shards?.[identifier];
        if (!Object.keys(country.shards || {}).length) delete state.countries[countryCode];
      }
    }
    await this.save(state);
    return state;
  }

  async migrateCountry(countryCode, shardId, entry, migratedAt) {
    const state = await this.load();
    state.countries[countryCode] = {
      shards: { [shardId]: entry },
      migratedAt,
      updatedAt: migratedAt
    };
    await this.save(state);
  }
}

export class PostgresQueueStateStore {
  constructor(database, legacyFile = null) {
    this.database = database;
    this.legacyFile = legacyFile ? resolve(legacyFile) : null;
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;
    if (!this.legacyFile) {
      this.initialized = true;
      return;
    }
    let legacy;
    try {
      legacy = JSON.parse(await readFile(this.legacyFile, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') { this.initialized = true; return; }
      throw queueStateError(`Legacy queue state is not valid JSON: ${this.legacyFile}`, error);
    }
    if ((!legacy?.schemaVersion && !Object.hasOwn(legacy || {}, 'countries'))
      || (legacy?.schemaVersion !== undefined && legacy.schemaVersion !== 1)
      || !isRecord(legacy.countries)) {
      throw queueStateError(`Legacy queue state has an unsupported structure: ${this.legacyFile}`);
    }
    for (const [countryCode, country] of Object.entries(legacy?.countries || {})) {
      const shards = country?.shards || { [countryCode]: country };
      for (const [sourceId, entry] of Object.entries(shards)) {
        if (!isRecord(entry)) throw queueStateError(`Legacy queue state contains an invalid entry: ${countryCode}/${sourceId}`);
        const existing = await this.database.prepare(`SELECT 1 AS present FROM sync_source_execution_state
          WHERE country_code=? AND source_id=?`).bind(countryCode, sourceId).first('present');
        if (existing) continue;
        await this.writeEntry(countryCode, sourceId, entry, entry.updatedAt || new Date().toISOString());
      }
    }
    await rm(this.legacyFile, { force: true });
    this.initialized = true;
  }

  async load() {
    await this.initialize();
      const rows = (await this.database.prepare(`SELECT country_code,source_id,state,reason,source_fingerprint,
        failure_fingerprint,consecutive_failures,failure_code,adapter,failure_phase,failure_signature,
        checkpoint_token,wait_reason,probe_failures,probe_version,next_attempt_at,exhausted_at,updated_at
      FROM sync_source_execution_state`).all()).results;
    const state = { schemaVersion: 1, countries: {} };
    for (const row of rows) {
      const country = state.countries[row.country_code] ||= { shards: {}, updatedAt: row.updated_at };
      const savedState = row.state === 'exhausted' ? 'latched' : row.state;
      country.shards[row.source_id] = {
        state: savedState,
        latched: savedState === 'latched',
        reason: row.reason || null,
        fingerprint: ['suspended', 'backoff'].includes(savedState) ? row.failure_fingerprint : row.source_fingerprint,
        latchedAt: row.exhausted_at || null,
        consecutiveFailures: Number(row.consecutive_failures || 0),
        failureCode: row.failure_code || null,
        adapter: row.adapter || null,
        failurePhase: row.failure_phase || inferredFailurePhase(row.failure_code),
        failureSignature: row.failure_signature || null,
        checkpointToken: row.checkpoint_token || null,
        waitReason: row.wait_reason || null,
        probeFailures: Number(row.probe_failures || 0),
        probeVersion: row.probe_version || null,
        nextAttemptAt: row.next_attempt_at || null,
        updatedAt: row.updated_at
      };
      if (timestamp(row.updated_at) > timestamp(country.updatedAt)) country.updatedAt = row.updated_at;
    }
    return state;
  }

  async writeEntry(countryCode, sourceId, entry, evaluatedAt) {
    const savedState = String(entry.state || (entry.latched ? 'latched' : ''));
    if (!['latched', 'checked', 'backoff', 'suspended'].includes(savedState)) return;
    const databaseState = savedState === 'latched' ? 'exhausted' : savedState;
    const failureState = ['backoff', 'suspended'].includes(savedState);
    await this.database.prepare(`INSERT INTO sync_source_execution_state(
      country_code,source_id,state,reason,source_fingerprint,failure_fingerprint,consecutive_failures,
      failure_code,adapter,failure_phase,failure_signature,checkpoint_token,wait_reason,probe_failures,probe_version,
      next_attempt_at,exhausted_at,last_attempt_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(country_code,source_id) DO UPDATE SET
      state=excluded.state,reason=excluded.reason,source_fingerprint=excluded.source_fingerprint,
      failure_fingerprint=excluded.failure_fingerprint,consecutive_failures=excluded.consecutive_failures,
      failure_code=excluded.failure_code,adapter=excluded.adapter,failure_phase=excluded.failure_phase,
      failure_signature=excluded.failure_signature,checkpoint_token=excluded.checkpoint_token,wait_reason=excluded.wait_reason,
      probe_failures=excluded.probe_failures,probe_version=excluded.probe_version,next_attempt_at=excluded.next_attempt_at,
      exhausted_at=excluded.exhausted_at,last_attempt_at=excluded.last_attempt_at,updated_at=excluded.updated_at`)
      .bind(
        countryCode, sourceId, databaseState, entry.reason || null,
        failureState ? null : entry.fingerprint || null,
        failureState ? entry.fingerprint || null : null,
        Number(entry.consecutiveFailures || 0), entry.failureCode || null, entry.adapter || null,
        entry.failurePhase || null, entry.failureSignature || null, entry.checkpointToken || null, entry.waitReason || null,
        Number(entry.probeFailures || 0), entry.probeVersion || null, entry.nextAttemptAt || null,
        savedState === 'latched' ? entry.latchedAt || evaluatedAt : null, evaluatedAt, evaluatedAt
      ).run();
  }

  async apply(countryCode, evaluation, evaluatedAt, shardId = null) {
    await this.initialize();
    const sourceId = shardId || countryCode;
    if (evaluation.action === 'waiting_quota' || !['latch', 'checked', 'suspend', 'backoff'].includes(evaluation.action)) {
      await this.database.prepare('DELETE FROM sync_source_execution_state WHERE country_code=? AND source_id=?')
        .bind(countryCode, sourceId).run();
      return this.load();
    }
    const state = evaluation.action === 'latch' ? 'latched'
      : evaluation.action === 'suspend' ? 'suspended' : evaluation.action;
    await this.writeEntry(countryCode, sourceId, {
      state,
      reason: evaluation.reason || (state === 'latched' ? LATCH_REASON
        : state === 'checked' ? CHECKED_REASON : state === 'backoff' ? BACKOFF_REASON : SUSPENDED_REASON),
      fingerprint: evaluation.fingerprint || null,
      latchedAt: evaluation.latchedAt || null,
      consecutiveFailures: evaluation.consecutiveFailures || 0,
      failureCode: evaluation.failureCode || null,
      adapter: evaluation.adapter || null,
      failurePhase: evaluation.failurePhase || null,
      failureSignature: evaluation.failureSignature || null,
      checkpointToken: evaluation.checkpointToken || null,
      waitReason: evaluation.waitReason || null,
      probeFailures: Number(evaluation.probeFailures || 0),
      probeVersion: evaluation.probeVersion || null,
      nextAttemptAt: evaluation.nextAttemptAt || null
    }, evaluatedAt);
    return this.load();
  }

  async clear(countryCodes) {
    await this.initialize();
    if (countryCodes.some((countryCode) => String(countryCode).toLowerCase() === 'all')) {
      await this.database.prepare('DELETE FROM sync_source_execution_state').run();
    } else {
      const countries = [...new Set(countryCodes.map(String).filter((value) => /^[a-z]{2}$/iu.test(value)).map((value) => value.toUpperCase()))];
      const sources = [...new Set(countryCodes.map(String).filter((value) => !/^[a-z]{2}$/iu.test(value)))];
      if (countries.length) await this.database.prepare(`DELETE FROM sync_source_execution_state
        WHERE country_code IN (${countries.map(() => '?').join(',')})`).bind(...countries).run();
      if (sources.length) await this.database.prepare(`DELETE FROM sync_source_execution_state
        WHERE source_id IN (${sources.map(() => '?').join(',')})`).bind(...sources).run();
    }
    return this.load();
  }

  async migrateCountry(countryCode, shardId, entry, migratedAt) {
    await this.initialize();
    await this.writeEntry(countryCode, shardId, entry, migratedAt);
  }
}

export const createQueueSources = ({
  addressDatabase,
  controlDatabase,
  environment = process.env
}) => {
  const withDatabase = async (database, fallback, reader) => {
    if (!database) return fallback;
    return reader(database);
  };

  const addressFacts = () => withDatabase(addressDatabase, {
    policies: {}, counts: {}, rules: {}, shards: {}, durationSamples: { countries: {}, sources: {} },
    nodeTargetsUpdatedAt: {}, catalogVersion: '',
    deficits: { belowTarget: new Set(), belowFloor: new Set() }
  }, async (database) => {
    const policies = {};
    for (const row of (await database.prepare(
      'SELECT country_code,enabled,target_count,updated_at FROM sync_country_policies'
    ).all()).results) {
      policies[String(row.country_code)] = {
        enabled: Boolean(row.enabled),
        targetCount: Number(row.target_count || 0),
        updatedAt: String(row.updated_at || '')
      };
    }
    const counts = {};
    const rules = {};
    const goals = await evaluateCountryGoals(database);
    for (const goal of goals.values()) {
      counts[goal.countryCode] = goal.current;
      rules[goal.countryCode] = goal.rules;
    }
    const shards = {};
    for (const row of (await database.prepare(
      'SELECT shard_id,country_code,status,source_version,failure_code,updated_at FROM sync_shard_state'
    ).all()).results) {
      (shards[String(row.country_code)] ||= []).push({
        shardId: String(row.shard_id),
        status: row.status ? String(row.status) : null,
        sourceVersion: row.source_version ? String(row.source_version) : '',
        failureCode: row.failure_code ? String(row.failure_code) : null,
        updatedAt: row.updated_at ? String(row.updated_at) : ''
      });
    }
    const nodeTargetsUpdatedAt = {};
    for (const row of (await database.prepare(`SELECT country_code,MAX(updated_at) AS updated_at
      FROM sync_node_overrides GROUP BY country_code`).all()).results) {
      nodeTargetsUpdatedAt[String(row.country_code)] = String(row.updated_at || '');
    }
    let catalogVersion = '';
    const catalogRows = (await database.prepare(`SELECT source,source_version,source_checksum
      FROM catalog_metadata ORDER BY source`).all()).results;
    catalogVersion = catalogRows.map((row) => [String(row.source), String(row.source_version || ''), String(row.source_checksum || '')])
      .map((row) => row.join(':')).join('|');
    const durationSamples = { countries: {}, sources: {} };
    const durationRows = (await database.prepare(`SELECT history.country_code,history.source_id,history.started_at,
        history.completed_at,run.target_json
      FROM sync_run_countries history JOIN sync_runs run ON run.id=history.run_id
      WHERE history.status='succeeded' AND run.status='succeeded' AND history.source_id<>''
        AND history.started_at IS NOT NULL AND history.completed_at IS NOT NULL
      ORDER BY history.completed_at DESC LIMIT 1000`).all()).results;
    for (const row of durationRows) {
      let target = {};
      try { target = JSON.parse(String(row.target_json || '{}')); } catch {}
      const shardIds = Array.isArray(target.shards) ? target.shards.map(String) : [];
      if (shardIds.length !== 1 || shardIds[0].toLowerCase() === 'all' || shardIds[0] !== String(row.source_id)) continue;
      const duration = timestamp(row.completed_at) - timestamp(row.started_at);
      if (duration <= 0) continue;
      (durationSamples.countries[String(row.country_code)] ||= []).push(duration);
      (durationSamples.sources[String(row.source_id)] ||= []).push(duration);
    }
    const deficits = { belowTarget: new Set(), belowFloor: new Set() };
    for (const goal of goals.values()) {
      if (goal.countryCode === 'CN' || !goal.enabled) continue;
      if (!goal.countMet) deficits.belowTarget.add(goal.countryCode);
      if (!goal.coverageMet || !goal.overrideMet) deficits.belowFloor.add(goal.countryCode);
    }
    return { policies, counts, rules, shards, nodeTargetsUpdatedAt, catalogVersion, durationSamples, deficits };
  });

  const environmentCredentials = (provider) => {
    const baseName = providerEnvironmentVariables[provider];
    if (!baseName) return [];
    return [baseName, ...Object.keys(environment)
      .filter((name) => name.startsWith(`${baseName}_`) && /^\d+$/u.test(name.slice(baseName.length + 1)))
      .sort((left, right) => Number(left.slice(baseName.length + 1)) - Number(right.slice(baseName.length + 1)))]
      .filter((name) => String(environment[name] || '').trim());
  };
  const unconfiguredProvider = (provider) => {
    const names = environmentCredentials(provider);
    return names.length ? {
      provider, known: false, available: false, nextResetAt: null, waitState: 'blocked',
      reason: `credential_import_pending:${provider}`,
      revision: sha256(JSON.stringify(names.map((name) => [name, environment[name]])))
    } : {
      provider, known: false, available: false, nextResetAt: null, waitState: 'blocked',
      reason: `missing_api_key:${provider}`, revision: 'unconfigured'
    };
  };

  // Availability mirrors ControlStore.acquireCredential. Environment keys are
  // accepted during the short startup window before the API imports them into
  // the encrypted credential store; an absent or unusable key never starts a
  // source that can only fail with SOURCE_CREDENTIAL_UNAVAILABLE.
  const localQuotaStatus = (provider, now = new Date()) => withDatabase(
    controlDatabase,
    unconfiguredProvider(provider),
    async (database) => {
    const rows = (await database.prepare(`SELECT id,status,cooldown_until,quota_period,quota_timezone_offset,
        provider_reported_reset_at,enabled,secret_ciphertext,weight,qps_limit,quota_service,quota_limit,quota_scope_id
      FROM provider_credentials WHERE provider=?`).bind(provider).all()).results;
    const stableCredentials = rows.map((row) => [
      row.id, row.enabled, row.secret_ciphertext, row.weight, row.qps_limit, row.quota_service,
      row.quota_period, row.quota_limit, row.quota_timezone_offset, row.quota_scope_id
    ]);
    const candidates = rows.filter((row) => Boolean(row.enabled) && String(row.status || '') !== 'disabled');
    if (!candidates.length) {
      const fallback = unconfiguredProvider(provider);
      if (fallback.available || !rows.length) return fallback;
      return {
        ...fallback,
        known: true,
        reason: `api_key_disabled:${provider}`,
        revision: sha256(JSON.stringify(stableCredentials))
      };
    }
    let available = false;
    let nextResetAt = 0;
    let waitState = null;
    const revisions = [];
    for (const row of candidates) {
      if (String(row.status || '') === 'needs_review') continue;
      const cooldownAt = timestamp(row.cooldown_until);
      const cooling = cooldownAt > now.getTime();
      const status = String(row.status || '');
      const windows = (await database.prepare(`SELECT quota_window.service,quota_window.scope_id,quota_window.period,
        quota_window.limit_count,quota_window.timezone_offset,quota_window.enabled,
        observation.used_count,observation.limit_count AS observed_limit,observation.reset_at,observation.observed_at
        FROM provider_quota_windows quota_window LEFT JOIN provider_quota_observations observation
          ON observation.credential_id=quota_window.credential_id AND observation.service=quota_window.service
            AND observation.period=quota_window.period
        WHERE quota_window.credential_id=? AND quota_window.enabled=1`).bind(row.id).all()).results;
      let quotaBlockedUntil = 0;
      for (const window of windows) {
        const period = String(window.period || 'day');
        const offset = Number(window.timezone_offset || 0);
        const localUsed = Number(await database.prepare(`SELECT COALESCE(SUM(usage.accepted_count+usage.rejected_count),0) AS total
          FROM provider_credentials credential JOIN provider_usage_periods usage ON usage.credential_id=credential.id
          WHERE credential.quota_scope_id=? AND credential.quota_service=? AND usage.period_start=?`)
          .bind(window.scope_id, window.service, quotaPeriodStart(period, offset, now)).first('total') || 0);
        const observed = window.observed_at && (!window.reset_at || timestamp(window.reset_at) > now.getTime());
        const used = Math.max(localUsed, observed ? Number(window.used_count || 0) : 0);
        const limit = observed && window.observed_limit !== null ? Number(window.observed_limit) : Number(window.limit_count);
        if (used >= limit) {
          const reset = observed && timestamp(window.reset_at) > now.getTime()
            ? timestamp(window.reset_at) : nextQuotaResetTime(period, offset, now).getTime();
          quotaBlockedUntil = Math.max(quotaBlockedUntil, reset);
        }
        revisions.push([row.id, window.service, window.scope_id, period, window.limit_count,
          window.timezone_offset, window.enabled]);
      }
      const blockedUntil = Math.max(cooling ? cooldownAt : 0, quotaBlockedUntil);
      if (!blockedUntil && (status === 'healthy' || ['cooldown', 'quota_exhausted'].includes(status))) {
        available = true;
        continue;
      }
      if (blockedUntil && (!nextResetAt || blockedUntil < nextResetAt)) {
        nextResetAt = blockedUntil;
        waitState = quotaBlockedUntil >= (cooling ? cooldownAt : 0) ? 'quota_wait' : 'cooldown_wait';
      }
    }
    return {
      provider,
      known: true,
      available,
      nextResetAt: nextResetAt ? new Date(nextResetAt).toISOString() : null,
      waitState: available ? null : waitState || 'blocked',
      reason: available || waitState ? null : `api_key_needs_review:${provider}`,
      revision: sha256(JSON.stringify([
        ...stableCredentials, ...revisions
      ].sort()))
    };
  });

  const brokerClientPromise = String(environment.CREDENTIAL_BROKER_URL || '').trim()
    ? createCredentialBrokerClient(environment) : null;
  const quotaStatus = async (provider, now = new Date()) => {
    if (brokerClientPromise && ['geoapify', 'mappls', 'onemap', 'google-geocoding'].includes(provider)) {
      try {
        const client = await brokerClientPromise;
        return (await client.availability([provider]))[provider];
      } catch (error) {
        return {
          provider, known: true, available: false, nextResetAt: error?.retryAt || null,
          waitState: error?.retryAt ? 'cooldown_wait' : 'blocked',
          reason: `credential_broker_unavailable:${provider}`,
          revision: createHash('sha256').update(String(error?.code || 'BROKER_UNAVAILABLE')).digest('hex')
        };
      }
    }
    return localQuotaStatus(provider, now);
  };

  const chinaPriority = (now = new Date()) => withDatabase(addressDatabase, {
    blocksQueue: false, executionState: null, nextAttemptAt: null
  }, async (database) => {
    const goal = (await evaluateCountryGoals(database)).get('CN');
    // Beyond its original volume goal China rotates with other countries instead of holding the queue.
    const priorityComplete = goal?.coverageMet && goal.overrideMet && goal.current >= CHINA_PRIORITY_TARGET;
    if (!goal?.enabled || goal.complete || priorityComplete) return { blocksQueue: false, executionState: 'ready', nextAttemptAt: null };
    const runtime = await database.prepare(`SELECT execution_state,next_attempt_at
      FROM sync_country_runtime WHERE country_code='CN'`).first();
    if (!runtime) return { blocksQueue: false, executionState: 'uninitialized', nextAttemptAt: null };
    const executionState = String(runtime.execution_state || '');
    const nextAttemptAt = runtime.next_attempt_at ? String(runtime.next_attempt_at) : null;
    const due = !nextAttemptAt || timestamp(nextAttemptAt) <= now.getTime();
    return {
      blocksQueue: executionState === 'running' || executionState === 'below_target'
        || (due && ['quota_wait', 'cooldown_wait'].includes(executionState)),
      executionState,
      nextAttemptAt
    };
  });

  // Active rows still waiting for translation or publication; permanently rejected rows do not count.
  const unpublishedBacklog = (countryCode) => withDatabase(addressDatabase, 0, async (database) => Number(
    await database.prepare(`SELECT COUNT(*) AS total FROM address_pool pool
      LEFT JOIN address_generation_index generation ON generation.address_id=pool.id AND generation.active=1
      LEFT JOIN translation_recovery recovery ON recovery.address_id=pool.id AND recovery.status IN ('failed','rejected')
      WHERE pool.country_code=? AND pool.active=1 AND generation.address_id IS NULL AND recovery.address_id IS NULL`).bind(countryCode).first('total')
  ) || 0);

  // Address storage counts the data directory and the database, as the import budget does.
  const storageStatus = async () => {
    const limits = storageLimits(environment);
    const dataRoot = environment.ADDRESS_DATA_ROOT || resolve('data');
    const [files, databaseBytes, freeBytes] = await Promise.all([
      measureStorageBytes([dataRoot]).catch(() => 0),
      withDatabase(addressDatabase, 0, async (database) => Number(await database
        .prepare('SELECT pg_database_size(current_database()) AS size').first('size')) || 0).catch(() => 0),
      statfs(dataRoot).then((stats) => Number(stats.bavail) * Number(stats.bsize)).catch(() => null)
    ]);
    const usedBytes = files + databaseBytes;
    return { ...limits, usedBytes, freeBytes, full: storageFull({ usedBytes, freeBytes, ...limits }) };
  };

  return { addressFacts, quotaStatus, chinaPriority, unpublishedBacklog, storageStatus };
};

const runningJobCountries = (job, shards) => {
  const countries = new Set();
  if (!job || !Array.isArray(job.shards)) return countries;
  const byShardId = new Map(shards.map((shard) => [shard.id.toLowerCase(), shard.countryCode]));
  for (const value of job.shards) {
    const requested = String(value).trim();
    if (!requested || requested.toLowerCase() === 'all') continue;
    if (/^[a-zA-Z]{2}$/u.test(requested)) countries.add(requested.toUpperCase());
    else if (byShardId.has(requested.toLowerCase())) countries.add(byShardId.get(requested.toLowerCase()));
  }
  return countries;
};

export const computeQueueSnapshot = async ({
  sources,
  catalogShards,
  queueState = { countries: {} },
  runningJob = null,
  importRevision = ADDRESS_IMPORT_REVISION,
  now = new Date(),
  enableSourceProbes = true
}) => {
  const facts = await sources.addressFacts();
  const providers = quotaProviderMap(catalogShards);
  const quotaByProvider = {};
  for (const provider of new Set(Object.values(providers))) {
    quotaByProvider[provider] = await sources.quotaStatus(provider, now);
  }
  const shardCountries = new Set((catalogShards || []).map((shard) => shard.countryCode));
  const running = runningJobCountries(runningJob, catalogShards || []);
  const entries = [];
  for (const countryCode of Object.keys(facts.policies).sort()) {
    const policy = facts.policies[countryCode];
    if (countryCode === 'CN' || !policy.enabled) continue;
    const current = facts.counts[countryCode] || 0;
    const target = policy.targetCount;
    const belowTarget = facts.deficits.belowTarget.has(countryCode);
    const belowFloor = facts.deficits.belowFloor.has(countryCode);
    const rules = facts.rules?.[countryCode] || {
      total: { current, target, met: !belowTarget },
      administrativeCoverage: { actual: belowFloor ? 0 : 1, target: 1, met: !belowFloor, covered: 0, total: 0 },
      regionalMinimums: {
        actual: belowFloor ? 0 : 1, target: 1, met: !belowFloor,
        lowest: null, level1: null, level2: null,
        overrides: { satisfied: 0, total: 0, met: true }
      }
    };
    const storedShards = facts.shards[countryCode] || [];
    const storedById = new Map(storedShards.map((shard) => [shard.shardId, shard]));
    const configuredShards = (catalogShards || []).filter((shard) => shard.countryCode === countryCode);
    const persisted = queueState.countries?.[countryCode] || {};
    const sourceEntries = configuredShards.map((shard) => {
      const stored = storedById.get(shard.id) || {};
      const sourceVersion = stored.sourceVersion || shard.source?.sourceVersion || '';
      const adapterRevision = sourceCapabilityRevision(shard);
      const provider = providers[shard.id] || null;
      const quota = provider ? quotaByProvider[provider] : null;
      const adapter = String(shard.source?.adapter || '');
      const configurationError = String(shard.source?.configurationError || '');
      const sourceFingerprint = countryFingerprint({
        adapterRevisions: [[shard.id, adapterRevision]],
        sourceVersions: [[shard.id, sourceVersion]]
      });
      const saved = persisted.shards?.[shard.id] || {};
      const savedState = String(saved.state || (saved.latched ? 'latched' : ''));
      const savedFailurePhase = saved.failurePhase || inferredFailurePhase(saved.failureCode);
      const failureFingerprint = executionFailureFingerprint(
        sourceFingerprint, quota?.revision || '', savedFailurePhase, adapter
      );
      const expectedFingerprint = ['suspended', 'backoff'].includes(savedState)
        ? failureFingerprint
        : sourceFingerprint;
      const matches = saved.fingerprint === expectedFingerprint;
      const nextAttempt = timestamp(saved.nextAttemptAt);
      const probeDue = enableSourceProbes && !configurationError && matches && ['latched', 'suspended'].includes(savedState)
        && (!nextAttempt || nextAttempt <= now.getTime());
      const resumableCheckpoint = savedState === 'checked'
        && [PARTIAL_REASON, PARTIAL_STALLED_REASON].includes(saved.reason);
      // Older checkpoint rows did not persist the credential wait reason. If
      // the provider is available again and the stored wake time is far beyond
      // the bounded retry window, treat that checkpoint as a stale quota wait.
      // Normal short backoffs remain untouched so transient failures do not
      // turn into a tight loop.
      const staleCredentialCheckpoint = resumableCheckpoint && Boolean(provider)
        && quota?.available === true && nextAttempt > now.getTime()
        && nextAttempt - now.getTime() >= STALE_CREDENTIAL_CHECKPOINT_MS;
      const credentialManagedWait = resumableCheckpoint
        && ['quota', 'credential'].includes(String(saved.waitReason || ''))
        && Boolean(provider)
        || staleCredentialCheckpoint;
      const growthStep = savedState === 'checked' && saved.reason === GROWTH_REASON;
      const paused = matches && ['latched', 'checked', 'suspended'].includes(savedState)
        && (['latched', 'suspended'].includes(savedState)
          ? !probeDue
          : !(resumableCheckpoint || growthStep) || (!credentialManagedWait && (!nextAttempt || nextAttempt > now.getTime())));
      return {
        shard,
        stored,
        saved,
        savedState,
        matches,
        probeDue,
        paused,
        credentialManagedWait,
        nextAttempt,
        provider,
        quota,
        adapter,
        configurationError,
        credentialRevision: quota?.revision || '',
        sourceFingerprint,
        failureFingerprint
      };
    });
    const sourceVersions = sourceEntries.map(({ shard, stored }) => [shard.id, stored.sourceVersion || shard.source?.sourceVersion || '']);
    const adapterRevisions = sourceEntries.map(({ shard }) => [shard.id, sourceCapabilityRevision(shard)]);
    const fingerprint = countryFingerprint({ adapterRevisions, sourceVersions });
    const legacyFingerprint = legacyCountryFingerprint({ importRevision, sourceVersions });
    const deprecatedFingerprint = deprecatedCountryFingerprint({
      importRevision,
      policyUpdatedAt: policy.updatedAt,
      nodeTargetsUpdatedAt: facts.nodeTargetsUpdatedAt?.[countryCode] || '',
      catalogVersion: facts.catalogVersion || '',
      adapterRevisions: storedShards.map((shard) => [
        shard.shardId,
        sourceCapabilityRevision(configuredShards.find((candidate) => candidate.id === shard.shardId) || {})
      ]),
      sourceVersions: storedShards.map((shard) => [shard.shardId, shard.sourceVersion])
    });
    const persistedState = String(persisted.state || (persisted.latched ? 'latched' : ''));
    const persistedNextAttempt = timestamp(persisted.nextAttemptAt);
    const legacyFingerprintMatches = !persisted.shards
      && [legacyFingerprint, deprecatedFingerprint].includes(persisted.fingerprint)
      && ['latched', 'checked', 'suspended'].includes(persistedState)
      && (!persistedNextAttempt || persistedNextAttempt > now.getTime());
    const migrationCandidates = sourceEntries.filter(({ shard, stored }) => {
      if (!stored.sourceVersion) return false;
      const adapter = shard.source?.adapter;
      const revision = sourceAdapterRevisions[adapter] || '';
      return !revisionEmbeddedAdapters.has(adapter) || !revision || stored.sourceVersion.includes(revision);
    });
    const migrationSource = legacyFingerprintMatches && migrationCandidates.length
      ? [...migrationCandidates].sort((left, right) => timestamp(right.stored.updatedAt) - timestamp(left.stored.updatedAt))[0]
      : null;
    const legacyPauseActive = Boolean(migrationSource);
    const runnableSources = sourceEntries.filter((source) => {
      const delayedPartial = source.paused && source.savedState === 'checked'
        && [PARTIAL_REASON, PARTIAL_STALLED_REASON].includes(source.saved.reason || '')
        && source.nextAttempt > now.getTime() && (!source.quota || source.quota.available);
      return (!source.paused || delayedPartial) && !source.probeDue && !source.configurationError;
    })
      .sort((left, right) => {
        const availabilityRank = (source) => !source.quota || source.quota.available
          ? source.matches && source.nextAttempt > now.getTime() ? 1 : 0
          : source.quota.waitState === 'blocked' ? 3 : 2;
        const quotaOrder = availabilityRank(left) - availabilityRank(right);
        if (quotaOrder) return quotaOrder;
        const meteredOrder = Number(!left.provider) - Number(!right.provider);
        if (meteredOrder) return meteredOrder;
        const leftAt = left.matches ? left.nextAttempt : 0;
        const rightAt = right.matches ? right.nextAttempt : 0;
        // Popular cities run first, then popular regions; unprioritised shards keep their catalogue order.
        const priority = (source) => source.shard.popularCities ? 0 : Number(source.shard.priority) || Number.MAX_SAFE_INTEGER;
        return (leftAt > now.getTime()) - (rightAt > now.getTime()) || leftAt - rightAt
          || priority(left) - priority(right);
      });
    const selectedSource = runnableSources[0] || null;
    const pausedQuotaSource = sourceEntries.find((source) => source.matches
      && source.savedState === 'checked'
      && [PARTIAL_REASON, PARTIAL_STALLED_REASON].includes(source.saved.reason || '')
      && source.provider && source.quota && !source.quota.available);
    const provider = selectedSource?.provider || null;
    const quota = selectedSource?.quota || null;
    const delayedUntil = selectedSource?.matches && selectedSource.nextAttempt > now.getTime()
      && !(selectedSource.credentialManagedWait && (!selectedSource.quota || selectedSource.quota.available))
      ? selectedSource.nextAttempt
      : 0;
    const pausedWakeAt = sourceEntries.map((source) => source.paused ? source.nextAttempt : 0)
      .filter((value) => value > now.getTime()).sort((left, right) => left - right)[0] || 0;
    const entry = {
      countryCode,
      deficit: Math.max(0, target - current),
      target,
      current,
      rules,
      unmetRules: [rules.total?.met ? null : 'total',
        rules.administrativeCoverage?.met ? null : 'administrative_coverage',
        rules.regionalMinimums?.met ? null : 'regional_minimums'].filter(Boolean),
      fingerprint,
      legacyMigration: migrationSource ? {
        shardId: migrationSource.shard.id,
        entry: {
          state: persistedState,
          latched: persistedState === 'latched',
          reason: persisted.reason || (persistedState === 'checked' ? CHECKED_REASON : LATCH_REASON),
          fingerprint: persistedState === 'suspended'
            ? migrationSource.failureFingerprint
            : migrationSource.sourceFingerprint,
          latchedAt: persisted.latchedAt || null,
          consecutiveFailures: Number(persisted.consecutiveFailures || 0),
          failureCode: persisted.failureCode || null,
          nextAttemptAt: persistedState === 'suspended' ? null : persisted.nextAttemptAt || null,
          updatedAt: persisted.updatedAt || now.toISOString()
        }
      } : null,
      runnableShardId: selectedSource?.shard.id || null,
      probeShardIds: sourceEntries.filter((source) => source.probeDue).map((source) => source.shard.id),
      sourceFingerprints: Object.fromEntries(sourceEntries.map((source) => [source.shard.id, source.sourceFingerprint])),
      failureFingerprints: Object.fromEntries(sourceEntries.map((source) => [source.shard.id, source.failureFingerprint])),
      failureContexts: Object.fromEntries(sourceEntries.map((source) => [source.shard.id, {
        adapter: source.adapter,
        sourceFingerprint: source.sourceFingerprint,
        credentialRevision: source.credentialRevision
      }])),
      sourceExecution: Object.fromEntries(sourceEntries.map((source) => [source.shard.id, {
        savedState: source.savedState,
        reason: source.saved.reason || null,
        fingerprint: source.saved.fingerprint || null,
        matches: source.matches,
        sourceVersion: source.stored.sourceVersion || source.shard.source?.sourceVersion || '',
        sourceFingerprint: source.sourceFingerprint,
        latchedAt: source.saved.latchedAt || null,
        consecutiveFailures: source.matches ? Number(source.saved.consecutiveFailures || 0) : 0,
        failureCode: source.matches ? source.saved.failureCode || null : null,
        adapter: source.adapter || null,
        adapterRevision: sourceCapabilityRevision(source.shard),
        failurePhase: source.matches ? source.saved.failurePhase || null : null,
        failureSignature: source.matches ? source.saved.failureSignature || null : null,
        checkpointToken: source.matches ? source.saved.checkpointToken || null : null,
        waitReason: source.matches ? source.saved.waitReason || null : null,
        probeFailures: source.matches ? Number(source.saved.probeFailures || 0) : 0,
        probeVersion: source.matches ? source.saved.probeVersion || null : null,
        intervalDays: Number(source.shard.intervalDays || 1),
        quotaBound: Boolean(source.provider),
        quotaAvailable: source.quota ? source.quota.available : true,
        quotaResetAt: source.quota?.nextResetAt || null
      }])),
      quotaBound: Boolean(provider),
      quotaProvider: provider,
      quotaAvailable: quota ? quota.available : true,
      quotaResetAt: quota?.nextResetAt || null,
      intervalDays: Number(selectedSource?.shard.intervalDays || 1),
      consecutiveFailures: selectedSource?.matches ? Number(selectedSource.saved.consecutiveFailures || 0) : 0,
      failureCode: selectedSource?.matches ? selectedSource.saved.failureCode || null : null,
      nextAttemptAt: null,
      reason: null,
      lastDispatchedAt: persisted.updatedAt || null,
      position: null
    };
    const sourceDurations = facts.durationSamples?.sources?.[selectedSource?.shard.id] || [];
    const countryDurations = facts.durationSamples?.countries?.[countryCode] || [];
    entry.eta = estimateDuration(sourceDurations) || estimateDuration(countryDurations);
    if (running.has(countryCode)) {
      entry.state = 'running';
      entry.jobId = runningJob?.id || null;
      entry.jobPhase = runningJob?.phase || null;
      entry.heartbeatAt = runningJob?.heartbeatAt || null;
      entry.deadlineAt = runningJob?.deadlineAt || null;
      if (entry.eta && runningJob?.startedAt) {
        const startedAt = timestamp(runningJob.startedAt);
        entry.eta = now.getTime() >= startedAt + entry.eta.p80Ms ? null : {
          ...entry.eta,
          estimatedCompletionAt: new Date(startedAt + entry.eta.p80Ms).toISOString(),
          remainingMedianMs: Math.max(0, startedAt + entry.eta.medianMs - now.getTime()),
          remainingP80Ms: startedAt + entry.eta.p80Ms - now.getTime()
        };
      }
    } else if (!belowTarget && !belowFloor) {
      entry.state = 'done';
    } else if (legacyPauseActive) {
      entry.state = persistedState === 'checked' ? 'scheduled_wait'
        : persistedState === 'suspended' ? 'suspended' : 'source_limited';
      entry.reason = persisted.reason || (persistedState === 'checked' ? CHECKED_REASON : LATCH_REASON);
      entry.latchedAt = persisted.latchedAt || null;
      entry.nextAttemptAt = persistedNextAttempt ? new Date(persistedNextAttempt).toISOString() : null;
    } else if (!configuredShards.length || !shardCountries.has(countryCode)) {
      entry.state = 'no_source';
      entry.reason = 'no_source_shard';
    } else if (pausedQuotaSource && (!selectedSource || pausedQuotaSource === selectedSource)) {
      entry.runnableShardId = pausedQuotaSource.shard.id;
      entry.quotaBound = true;
      entry.quotaProvider = pausedQuotaSource.provider;
      entry.quotaAvailable = false;
      entry.quotaResetAt = pausedQuotaSource.quota.nextResetAt || null;
      entry.nextAttemptAt = pausedQuotaSource.quota.nextResetAt || null;
      entry.state = pausedQuotaSource.quota.waitState === 'blocked' ? 'blocked' : 'quota_wait';
      entry.reason = pausedQuotaSource.quota.reason || pausedQuotaSource.provider;
    } else if (!selectedSource) {
      const blocked = sourceEntries.find((source) => source.configurationError);
      const suspended = sourceEntries.find((source) => source.savedState === 'suspended');
      const checked = sourceEntries.find((source) => source.savedState === 'checked');
      const exhausted = sourceEntries.find((source) => source.savedState === 'latched');
      entry.state = blocked ? 'blocked' : suspended ? 'suspended' : checked ? 'scheduled_wait' : 'source_limited';
      entry.reason = blocked?.configurationError || suspended?.saved.reason
        || checked?.saved.reason || exhausted?.saved.reason || LATCH_REASON;
      entry.nextAttemptAt = pausedWakeAt ? new Date(pausedWakeAt).toISOString() : null;
    } else if (provider && quota && !quota.available) {
      entry.state = quota.waitState === 'blocked' ? 'blocked'
        : quota.waitState === 'cooldown_wait' ? 'cooldown_wait' : 'quota_wait';
      entry.nextAttemptAt = quota.nextResetAt;
      entry.reason = quota.reason || provider;
    } else if (delayedUntil) {
      entry.state = 'retry_wait';
      entry.nextAttemptAt = new Date(delayedUntil).toISOString();
      entry.reason = BACKOFF_REASON;
    } else {
      entry.state = 'queued';
    }
    entries.push(entry);
  }
  const ready = orderRunnable(entries.filter((entry) => entry.state === 'queued'));
  ready.forEach((entry, index) => { entry.position = index + 1; });
  const stateRank = {
    running: 0, queued: 1, retry_wait: 2, cooldown_wait: 3, quota_wait: 4, blocked: 5, scheduled_wait: 6,
    source_limited: 7, suspended: 8, no_source: 9, done: 10
  };
  entries.sort((left, right) => (stateRank[left.state] - stateRank[right.state])
    || ((left.position ?? Number.MAX_SAFE_INTEGER) - (right.position ?? Number.MAX_SAFE_INTEGER))
    || left.countryCode.localeCompare(right.countryCode));
  return {
    generatedAt: now.toISOString(),
    job: runningJob ? {
      id: runningJob.id,
      phase: runningJob.phase,
      trigger: runningJob.trigger,
      shards: runningJob.shards,
      startedAt: runningJob.startedAt || null,
      heartbeatAt: runningJob.heartbeatAt || null,
      deadlineAt: runningJob.deadlineAt || null
    } : null,
    entries
  };
};

// Continuous queue engine. It keeps one runnable source shard in flight while
// preserving independent exhausted and retry states for every source.
export const createSyncQueue = ({
  environment = process.env,
  coordinator,
  stateDir,
  addressDatabase,
  controlDatabase,
  history = null,
  sources: providedSources,
  loadCatalog = loadSourceCatalog,
  probeSource = null,
  onIdle = null,
  now = () => new Date(),
  log = console,
  rescanMs = integer(environment.SYNC_QUEUE_RESCAN_MS, 5 * 60_000, 1_000, 24 * 60 * 60_000),
  cooldownMs = integer(environment.SYNC_QUEUE_COOLDOWN_MS, 10_000, 0, 60 * 60_000),
  backoffBaseMs = integer(environment.SYNC_QUEUE_BACKOFF_BASE_MS, 5 * 60_000, 1_000, 24 * 60 * 60_000),
  backoffCapMs = integer(environment.SYNC_QUEUE_BACKOFF_CAP_MS, 6 * 60 * 60_000, 60_000, 7 * 24 * 60 * 60_000),
  enableSourceProbes = environment.ADDRESS_SYNC_ENABLE_SOURCE_PROBES === 'true',
  maxUnpublishedBacklog = integer(environment.SYNC_QUEUE_MAX_UNPUBLISHED_BACKLOG, 20_000, 0, 100_000_000),
  backlogDeferMs = integer(environment.SYNC_QUEUE_BACKLOG_DEFER_MS, 30 * 60_000, 60_000, 24 * 60 * 60_000)
}) => {
  // A country whose imported rows still await publication is not imported again until they drain.
  const backlogDeferredUntil = new Map();
  const legacyStateFile = resolve(stateDir, 'queue-state.json');
  const store = addressDatabase
    ? new PostgresQueueStateStore(addressDatabase, legacyStateFile)
    : new QueueStateStore(legacyStateFile);
  const sources = providedSources || createQueueSources({
    addressDatabase, controlDatabase, environment
  });
  let catalogPromise;
  const catalogShards = () => {
    if (!catalogPromise) {
      catalogPromise = Promise.resolve()
        .then(() => loadCatalog())
        .then((catalog) => catalog.shards)
        .catch((error) => {
          catalogPromise = null;
          throw error;
        });
    }
    return catalogPromise;
  };

  const queueSnapshot = async () => {
    const configured = await catalogShards();
    const build = async () => computeQueueSnapshot({
      sources,
      catalogShards: configured,
      queueState: await store.load(),
      runningJob: coordinator?.currentJob || null,
      now: now(),
      enableSourceProbes
    });
    let result = await build();
    const migrations = result.entries.filter((entry) => entry.legacyMigration);
    for (const entry of migrations) {
      await store.migrateCountry(
        entry.countryCode,
        entry.legacyMigration.shardId,
        entry.legacyMigration.entry,
        now().toISOString()
      );
    }
    if (migrations.length) result = await build();
    return result;
  };
  const publicSnapshot = (result) => ({
    ...result,
    entries: result.entries.map(({
      sourceFingerprints, failureFingerprints, failureContexts, sourceExecution, probeShardIds, legacyMigration, ...entry
    }) => entry)
  });
  let cachedSnapshot = null;
  let published = { body: '', at: 0 };
  let chinaLogState = '';
  let storageCheck = null;
  let storageLogState = '';
  const remember = async (result) => {
    const value = publicSnapshot(result);
    cachedSnapshot = { value, at: now().getTime() };
    if (!history?.publishQueueSnapshot) return value;
    const { generatedAt, ...content } = value;
    const body = JSON.stringify(content);
    if (body === published.body && cachedSnapshot.at - published.at < 60_000) return value;
    try {
      await history.publishQueueSnapshot(JSON.stringify(value), generatedAt);
      published = { body, at: cachedSnapshot.at };
    } catch (error) {
      log.error?.('[sync-queue] snapshot publish failed', error);
    }
    return value;
  };
  const snapshot = async () => remember(await queueSnapshot());

  let stopped = true;
  let loop = null;
  let wake = null;
  const sleep = (milliseconds) => new Promise((resolveSleep) => {
    const timer = setTimeout(() => { wake = null; resolveSleep(); }, Math.max(1, milliseconds));
    timer.unref?.();
    wake = () => { clearTimeout(timer); wake = null; resolveSleep(); };
  });

  const countryEntry = async (countryCode) => {
    const snap = await queueSnapshot();
    return snap.entries.find((entry) => entry.countryCode === countryCode) || null;
  };

  const failureDetails = (entry, shardId, job) => {
    const context = entry?.failureContexts?.[shardId] || {
      adapter: '', sourceFingerprint: entry?.sourceFingerprints?.[shardId] || '', credentialRevision: ''
    };
    const reportedPhase = ['failed', 'cancelling'].includes(String(job?.phase || '').toLowerCase()) ? null : job?.phase;
    const phase = normalizeFailurePhase(job?.failurePhase || reportedPhase || inferredFailurePhase(job?.errorCode));
    return {
      ...context,
      phase,
      signature: systemicFailureSignature({
        failureCode: job?.errorCode,
        error: job?.error,
        failurePhase: phase
      }),
      fingerprint: executionFailureFingerprint(
        context.sourceFingerprint, context.credentialRevision, phase, context.adapter
      )
    };
  };

  const applySharedFailureCircuit = async (entry, evaluation, evaluatedAt) => {
    if (!evaluation.failureSignature || !evaluation.adapter) return false;
    const state = await store.load();
    const sourceStates = state.countries?.[entry.countryCode]?.shards || {};
    const matching = Object.entries(sourceStates).filter(([sourceId, saved]) => {
      const context = entry.failureContexts?.[sourceId];
      if (!context) return false;
      const expectedFingerprint = executionFailureFingerprint(
        context.sourceFingerprint, context.credentialRevision, saved.failurePhase, context.adapter
      );
      return ['backoff', 'suspended'].includes(saved.state)
        && saved.fingerprint === expectedFingerprint
        && saved.adapter === evaluation.adapter
        && normalizeFailurePhase(saved.failurePhase) === normalizeFailurePhase(evaluation.failurePhase)
        && saved.failureSignature === evaluation.failureSignature;
    });
    if (new Set(matching.map(([sourceId]) => sourceId)).size < 2) return false;
    for (const [sourceId, context] of Object.entries(entry.failureContexts || {})) {
      if (context.adapter !== evaluation.adapter) continue;
      const existing = sourceStates[sourceId];
      if (existing && ['latched', 'checked'].includes(existing.state)) continue;
      await store.apply(entry.countryCode, {
        action: 'suspend',
        reason: SHARED_FAILURE_REASON,
        fingerprint: executionFailureFingerprint(
          context.sourceFingerprint, context.credentialRevision, evaluation.failurePhase, context.adapter
        ),
        consecutiveFailures: Math.max(2, Number(existing?.consecutiveFailures || 0)),
        failureCode: evaluation.failureCode,
        adapter: evaluation.adapter,
        failurePhase: evaluation.failurePhase,
        failureSignature: evaluation.failureSignature,
        nextAttemptAt: null
      }, evaluatedAt, sourceId);
    }
    return true;
  };

  const applySourceEvaluation = async ({ entry, evaluation, evaluatedAt, sourceId, runId = null }) => {
    const apply = async () => {
      await store.apply(entry.countryCode, evaluation, evaluatedAt, sourceId);
      if (evaluation.action === 'waiting_quota') {
        await history?.pauseForQuota?.({ runId, countryCode: entry.countryCode, sourceId });
      }
      if (runId) {
        await history?.markSourceStateApplied?.({
          runId, countryCode: entry.countryCode, sourceId, appliedAt: evaluatedAt
        });
      }
    };
    if (runId && addressDatabase?.transaction && history?.markSourceStateApplied) {
      await addressDatabase.transaction(apply);
    } else await apply();
  };

  const applyRecoveredFailures = async () => {
    if (history?.pendingSourceStateApplications) {
      const pending = await history.pendingSourceStateApplications();
      for (const row of pending) {
        const countryCode = String(row.country_code || '').toUpperCase();
        const sourceId = String(row.source_id || '');
        const entry = await countryEntry(countryCode);
        if (!entry?.sourceExecution?.[sourceId]) {
          await history.markSourceStateApplied({
            runId: row.run_id, countryCode, sourceId, appliedAt: row.completed_at || now().toISOString()
          });
          continue;
        }
        const completedAt = row.completed_at || now().toISOString();
        const recoveredFingerprint = row.source_version_after && row.adapter_revision != null
          ? countryFingerprint({
              adapterRevisions: [[sourceId, row.adapter_revision]],
              sourceVersions: [[sourceId, row.source_version_after]]
            })
          : row.source_fingerprint;
        if (recoveredFingerprint && recoveredFingerprint !== entry.sourceFingerprints[sourceId]) {
          await history.markSourceStateApplied({
            runId: row.run_id, countryCode, sourceId, appliedAt: completedAt
          });
          continue;
        }
        const failure = failureDetails(entry, sourceId, {
          errorCode: row.error_code,
          error: row.error_message,
          failurePhase: row.failure_phase
        });
        const source = entry.sourceExecution[sourceId];
        const recoveredMetrics = parseJson(row.metrics_json);
        const evaluation = evaluateAttempt({
          jobSucceeded: row.status === 'succeeded',
          sourceComplete: Number(row.source_complete) !== 0,
          checkpointToken: row.checkpoint_token || null,
          previousCheckpointToken: source.checkpointToken || null,
          checkpointStage: recoveredMetrics.checkpointStage || null,
          partialNextAttemptAt: recoveredMetrics.nextAttemptAt || null,
          partialStalls: Number(source.consecutiveFailures || 0),
          partialWorkCount: Number(recoveredMetrics.runRequestCount || 0),
          partialMinimumWorkCount: Number(recoveredMetrics.progressEvaluationMinimum || 1),
          partialProgressEvaluationReady: recoveredMetrics.progressEvaluationReady === true,
          netGrowth: Number(row.net_growth || 0),
          goalDeficitBefore: goalDeficit(parseJson(row.before_goals_json)),
          goalDeficitAfter: goalDeficit(parseJson(row.after_goals_json)),
          fingerprintAfter: entry.sourceFingerprints[sourceId],
          failureFingerprintAfter: failure.fingerprint,
          deterministicFailure: deterministicFailureCodes.has(String(row.error_code || '')),
          quotaBound: Boolean(source.quotaBound),
          quotaAvailable: source.quotaAvailable ?? true,
          quotaResetAt: source.quotaResetAt ?? null,
          consecutiveFailures: Number(source.consecutiveFailures || 0),
          completedAt,
          backoffBaseMs,
          backoffCapMs,
          maxConsecutiveFailures: integer(environment.SYNC_QUEUE_MAX_FAILURES, 3, 1, 100),
          maxTimeoutFailures: integer(environment.SYNC_QUEUE_MAX_TIMEOUT_FAILURES, 2, 1, 10),
          maxPartialStalls: integer(environment.SYNC_QUEUE_MAX_PARTIAL_STALLS, 3, 1, 100),
          failureCode: row.error_code || null,
          adapter: failure.adapter,
          failurePhase: failure.phase,
          failureSignature: failure.signature,
          probeIntervalMs: Math.max(60_000, Number(source.intervalDays || 1) * 24 * 60 * 60_000)
        });
        await applySourceEvaluation({
          entry, evaluation, evaluatedAt: completedAt, sourceId, runId: row.run_id
        });
        await applySharedFailureCircuit(entry, evaluation, completedAt);
      }
      coordinator?.recoveredJobs?.splice(0);
      return;
    }
    const recovered = coordinator?.recoveredJobs?.splice(0) || [];
    const configured = await catalogShards();
    const byShard = new Map(configured.map((shard) => [shard.id.toLowerCase(), shard]));
    for (const job of recovered) {
      for (const value of job.shards || []) {
        const requested = String(value);
        const configuredShard = byShard.get(requested.toLowerCase());
        const countryCode = configuredShard?.countryCode || requested.toUpperCase();
        if (!/^[A-Z]{2}$/u.test(countryCode)) continue;
        const entry = await countryEntry(countryCode);
        if (!entry || ['done', 'source_limited', 'suspended', 'no_source'].includes(entry.state)) continue;
        const shardId = configuredShard?.id || entry.runnableShardId;
        if (!shardId) continue;
        const completedAt = job.completedAt || now().toISOString();
        const failure = failureDetails(entry, shardId, job);
        const evaluation = evaluateAttempt({
          jobSucceeded: false,
          netGrowth: 0,
          fingerprintAfter: entry.sourceFingerprints[shardId],
          failureFingerprintAfter: failure.fingerprint,
          failureCode: job.errorCode || 'SYNC_JOB_INTERRUPTED',
          adapter: failure.adapter,
          failurePhase: failure.phase,
          failureSignature: failure.signature,
          consecutiveFailures: Number(entry.sourceExecution?.[shardId]?.consecutiveFailures || 0),
          completedAt,
          backoffBaseMs,
          backoffCapMs,
          maxConsecutiveFailures: integer(environment.SYNC_QUEUE_MAX_FAILURES, 3, 1, 100),
          maxTimeoutFailures: integer(environment.SYNC_QUEUE_MAX_TIMEOUT_FAILURES, 2, 1, 10)
        });
         await applySourceEvaluation({ entry, evaluation, evaluatedAt: completedAt, sourceId: shardId });
        await applySharedFailureCircuit(entry, evaluation, completedAt);
      }
    }
  };
  const ensureRecoveredSourceStates = async () => {
    await applyRecoveredFailures();
  };

  // One pass: pick the next runnable country, run it to completion through the
  // coordinator, evaluate the outcome. Returns milliseconds to sleep before
  // the next pass (0 means continue immediately).
  const tick = async () => {
    await ensureRecoveredSourceStates();
    if (!coordinator.currentJob) await history?.repairInterruptedRuns?.();
    await history?.schedulerHeartbeat(coordinator.currentJob?.id || null);
    const refresh = async () => {
      const value = await queueSnapshot();
      await remember(value);
      await Promise.all(value.entries.filter((entry) => entry.state === 'quota_wait' && entry.runnableShardId)
        .map((entry) => history?.repairQuotaWait?.({
          countryCode: entry.countryCode,
          sourceId: entry.runnableShardId
        })));
      return value;
    };
    const chinaBlocked = async () => {
      const china = await sources.chinaPriority?.(now());
      if (!china?.blocksQueue) { chinaLogState = ''; return false; }
      if (chinaLogState !== china.executionState) log.log?.(`[sync-queue] CN priority state=${china.executionState}`);
      chinaLogState = china.executionState;
      return true;
    };
    const storageBlocked = async () => {
      if (!sources.storageStatus) return false;
      if (!storageCheck || now().getTime() - storageCheck.at >= 60_000) {
        storageCheck = { at: now().getTime(), status: await sources.storageStatus() };
        const state = storageCheck.status.full ? 'full' : 'ok';
        if (state !== storageLogState) {
          log.log?.(`[sync-queue] storage ${state} used=${storageCheck.status.usedBytes} free=${storageCheck.status.freeBytes} soft=${storageCheck.status.softLimitBytes}`);
          storageLogState = state;
        }
      }
      return storageCheck.status.full;
    };
    if (!coordinator.currentJob && await storageBlocked()) {
      if (!cachedSnapshot || now().getTime() - cachedSnapshot.at >= 60_000) await refresh();
      return Math.min(rescanMs, 60_000);
    }
    // Sources that stopped only because storage ran out start over once there is room again.
    if (sources.storageStatus && storageCheck && !storageCheck.status.full) {
      const state = await store.load();
      const released = [];
      for (const [countryCode, country] of Object.entries(state.countries || {})) {
        for (const [sourceId, saved] of Object.entries(country.shards || {})) {
          if (!['suspended', 'backoff'].includes(saved.state) || saved.failureCode !== 'ADDRESS_STORAGE_HARD_LIMIT') continue;
          await store.apply(countryCode, { action: 'waiting_quota' }, now().toISOString(), sourceId);
          released.push(sourceId);
        }
      }
      if (released.length) log.log?.(`[sync-queue] storage available; released ${released.length} sources`);
    }
    if (!coordinator.currentJob && await chinaBlocked()) {
      if (!cachedSnapshot || now().getTime() - cachedSnapshot.at >= 60_000) await refresh();
      return Math.min(rescanMs, 5_000);
    }
    const snap = await refresh();
    if (coordinator.currentJob) {
      await coordinator.waitForIdle();
      await onIdle?.();
      return 0;
    }
    const currentTime = now();
    if (await chinaBlocked()) return Math.min(rescanMs, 5_000);
    const backlogDeferred = (entry) => (backlogDeferredUntil.get(entry.countryCode) || 0) > currentTime.getTime();
    let pick;
    for (const entry of snap.entries) {
      if (entry.state !== 'queued' || backlogDeferred(entry)
        || (entry.nextAttemptAt && timestamp(entry.nextAttemptAt) > currentTime.getTime())) continue;
      if (maxUnpublishedBacklog && entry.countryCode !== 'CN' && sources.unpublishedBacklog) {
        const backlog = await sources.unpublishedBacklog(entry.countryCode);
        if (backlog > maxUnpublishedBacklog) {
          backlogDeferredUntil.set(entry.countryCode, currentTime.getTime() + backlogDeferMs);
          log.log?.(`[sync-queue] ${entry.countryCode} deferred unpublished=${backlog}`);
          continue;
        }
      }
      pick = entry;
      break;
    }
    const probePick = !pick && probeSource
      ? snap.entries.find((entry) => entry.state !== 'done' && entry.probeShardIds?.length)
      : null;
    if (!pick && !probePick) {
      await onIdle?.();
      const wakeAt = nextWakeAt(snap.entries, currentTime);
      const delay = wakeAt ? Math.max(1_000, wakeAt.getTime() - currentTime.getTime()) : rescanMs;
      return Math.min(rescanMs, delay);
    }
    const selected = pick || probePick;
    log.log?.(`[sync-queue] ${selected.countryCode} start deficit=${selected.deficit} current=${selected.current} target=${selected.target}`);
    const shardId = pick?.runnableShardId || probePick?.probeShardIds[0];
    if (!shardId) return rescanMs;
    const selectedSource = selected.sourceExecution?.[shardId] || {};
    if (probePick) {
      const configured = (await catalogShards()).find((shard) => shard.id === shardId);
      if (!configured) return rescanMs;
      const evaluatedAt = currentTime.toISOString();
      const probeIntervalMs = Math.max(60_000, Number(selectedSource.intervalDays || 1) * 24 * 60 * 60_000);
      const preserveProbeState = ({
        nextAttemptAt, probeFailures = 0, probeVersion = selectedSource.probeVersion || null
      }) => ({
        action: selectedSource.savedState === 'suspended' ? 'suspend' : 'latch',
        reason: selectedSource.reason || (selectedSource.savedState === 'suspended' ? SUSPENDED_REASON : LATCH_REASON),
        fingerprint: selectedSource.fingerprint || selectedSource.sourceFingerprint,
        latchedAt: selectedSource.latchedAt || evaluatedAt,
        consecutiveFailures: Number(selectedSource.consecutiveFailures || 0),
        failureCode: selectedSource.failureCode || null,
        adapter: selectedSource.adapter || null,
        failurePhase: selectedSource.failurePhase || null,
        failureSignature: selectedSource.failureSignature || null,
        checkpointToken: selectedSource.checkpointToken || null,
        probeFailures,
        probeVersion,
        nextAttemptAt
      });
      try {
        const discovery = await probeSource(configured);
        const discoveredVersion = String(discovery?.version || '');
        const baselineVersion = selectedSource.probeVersion || selectedSource.sourceVersion;
        const versionChanged = selectedSource.probeVersion
          ? discoveredVersion !== baselineVersion
          : initialProbeComparableVersion(discoveredVersion, selectedSource.adapter)
            !== initialProbeComparableVersion(baselineVersion, selectedSource.adapter);
        if (versionChanged) {
           await store.clear([shardId]);
           log.log?.(`[sync-queue] ${selected.countryCode} source update detected source=${shardId}`);
          return 0;
        }
        await store.apply(selected.countryCode, preserveProbeState({
          probeVersion: discoveredVersion,
          nextAttemptAt: new Date(currentTime.getTime() + probeIntervalMs).toISOString()
        }), evaluatedAt, shardId);
        return cooldownMs;
      } catch (error) {
        const probeFailures = Number(selectedSource.probeFailures || 0) + 1;
        const maxProbeFailures = integer(environment.SYNC_QUEUE_MAX_PROBE_FAILURES, 3, 1, 100);
        const retryDelay = probeFailures >= maxProbeFailures
          ? probeIntervalMs
          : Math.min(backoffCapMs, backoffBaseMs * 2 ** (probeFailures - 1));
        await store.apply(selected.countryCode, preserveProbeState({
          probeFailures,
          nextAttemptAt: new Date(currentTime.getTime() + retryDelay).toISOString()
        }), evaluatedAt, shardId);
        log.error?.(`[sync-queue] source metadata probe failed source=${shardId}`, error);
        return cooldownMs;
      }
    }
    const result = await coordinator.trigger('queue', {
      shards: [shardId],
      sourceFingerprints: { [shardId]: pick.sourceFingerprints[shardId] },
      sourceInputs: { [shardId]: {
        sourceVersion: selectedSource.sourceVersion || '',
        adapterRevision: selectedSource.adapterRevision || ''
      } }
    });
    if (!result.accepted) {
      await coordinator.waitForIdle();
      await onIdle?.();
      return 0;
    }
    await coordinator.waitForIdle();
    await onIdle?.();
    const job = await Promise.resolve(coordinator.getJob?.(result.job.id)).catch(() => null);
    const after = await countryEntry(pick.countryCode);
    const completedAt = now().toISOString();
    const failure = failureDetails(after || pick, shardId, job);
    const sourceOutcome = (job?.sourceOutcomes || []).find((outcome) =>
      String(outcome?.shardId || outcome?.shardKey || '') === shardId);
    const beforeSource = pick.sourceExecution?.[shardId] || {};
    const afterSource = after?.sourceExecution?.[shardId] || beforeSource;
    const ownGrowth = Number(sourceOutcome?.netGrowth || 0);
    const ownChanges = Number(sourceOutcome?.changedCount || 0) > 0;
    const evaluation = evaluateAttempt({
      jobSucceeded: job?.status === 'succeeded',
      sourceComplete: sourceOutcome?.sourceComplete !== false,
      checkpointToken: sourceOutcome?.checkpointToken || null,
      previousCheckpointToken: beforeSource.checkpointToken || null,
      checkpointStage: sourceOutcome?.checkpointStage || null,
      partialNextAttemptAt: sourceOutcome?.nextAttemptAt || sourceOutcome?.metrics?.nextAttemptAt || null,
      partialStalls: Number(beforeSource.consecutiveFailures || 0),
      partialWorkCount: Number(sourceOutcome?.metrics?.runRequestCount || 0),
      partialMinimumWorkCount: Number(sourceOutcome?.metrics?.progressEvaluationMinimum || 1),
      partialProgressEvaluationReady: sourceOutcome?.metrics?.progressEvaluationReady === true,
      growthCapped: sourceOutcome?.metrics?.growthCapped === true,
      // Only the source's own import counts as progress; totals also move while translations publish other rows.
      netGrowth: ownGrowth,
      goalDeficitBefore: ownChanges ? goalDeficit(pick.rules) : null,
      goalDeficitAfter: ownChanges ? goalDeficit(after?.rules) : null,
      fingerprintBefore: pick.sourceFingerprints[shardId],
      fingerprintAfter: after?.sourceFingerprints?.[shardId] ?? pick.sourceFingerprints[shardId],
      failureFingerprintAfter: failure.fingerprint,
      deterministicFailure: deterministicFailureCodes.has(String(job?.errorCode || '')),
      quotaBound: Boolean(beforeSource.quotaBound),
      quotaAvailable: afterSource.quotaAvailable ?? true,
      quotaResetAt: afterSource.quotaResetAt ?? null,
      consecutiveFailures: Number(beforeSource.consecutiveFailures || 0),
      completedAt,
      backoffBaseMs,
      backoffCapMs,
      maxConsecutiveFailures: integer(environment.SYNC_QUEUE_MAX_FAILURES, 3, 1, 100),
      maxTimeoutFailures: integer(environment.SYNC_QUEUE_MAX_TIMEOUT_FAILURES, 2, 1, 10),
      maxPartialStalls: integer(environment.SYNC_QUEUE_MAX_PARTIAL_STALLS, 3, 1, 100),
      failureCode: job?.errorCode || null,
      adapter: failure.adapter,
      failurePhase: failure.phase,
      failureSignature: failure.signature,
      probeIntervalMs: Math.max(60_000, Number(beforeSource.intervalDays || 1) * 24 * 60 * 60_000)
    });
    await applySourceEvaluation({
      entry: pick, evaluation, evaluatedAt: completedAt, sourceId: shardId, runId: result.job.id
    });
    await applySharedFailureCircuit(after || pick, evaluation, completedAt);
    log.log?.(`[sync-queue] ${pick.countryCode} ${evaluation.action} growth=${ownGrowth}`);
    return cooldownMs;
  };

  const run = async () => {
    while (!stopped) {
      let delay = rescanMs;
      try {
        delay = await tick();
      } catch (error) {
        log.error?.('[sync-queue] pass failed', error);
        delay = Math.min(rescanMs, 60_000);
      }
      if (stopped || delay <= 0) continue;
      await sleep(delay);
    }
  };

  const stop = async () => {
    stopped = true;
    wake?.();
    await loop;
    loop = null;
  };

  return {
    snapshot,
    tick,
    store,
    force: async (countryCodes) => {
      await store.clear(countryCodes);
      wake?.();
    },
    poke: () => wake?.(),
    start: () => {
      if (stopped) {
        stopped = false;
        loop = run();
      }
      return () => { void stop(); };
    },
    stop
  };
};
