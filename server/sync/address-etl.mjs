import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Converter as createSimplifier } from 'opencc-js/t2cn';
import { pinyin } from 'pinyin-pro';
import { createSourceAdapters, loadSourceCatalog, sourceCapabilityRevision } from './source-adapters.mjs';
import { CatalogReverseGeocoder } from './catalog-reverse-geocoder.mjs';
import { createCredentialBrokerClient } from '../credential-broker/client.mjs';
import { OPENAI_COMPATIBLE_TIMEOUT_MS } from '../credential-broker/openai-compatible.mjs';
import { loadGoogleCoverageTargets } from './google-coverage-targets.mjs';
import { isCountryDue, planCountryShards } from './country-plan.mjs';
import { ADDRESS_IMPORT_REVISION, PostgresAddressImporter } from './postgres-address-importer.mjs';
import { refreshResidentialCoverage } from '../database/residential-coverage.mjs';
import { runPostcodeInference } from './postcode-inference.mjs';
import { retirePostcodeLessRows } from './postcode-requirement.mjs';
import { retireUnlatinizablePremises } from './english-premise.mjs';
import { PostgresCountryStateStore } from './postgres-country-state.mjs';
import {
  assertStorageBudget,
  DEFAULT_HARD_LIMIT_BYTES,
  DEFAULT_MIN_FREE_DISK_BYTES,
  DEFAULT_SOFT_LIMIT_BYTES,
  DEFAULT_STORAGE_BYTES_PER_RECORD,
  measureStorageBytes
} from './storage-budget.mjs';
import { findNonResidentialMatch } from '../../src/domain/non-residential.mjs';
import { matchesCustomBlacklist } from '../lib/custom-blacklist.mjs';
import { ADDRESS_POLICY_DEFAULTS, getRuntimePolicy, loadImportPolicy } from './address-policy.mjs';
import {
  addressCanonicalKey, englishOnlyComponents, englishOnlyCoreFields, houseNumberIssue, normalizeAddressFacts, streetAddressKey,
  trimStreetAdministration
} from '../../src/domain/address-quality.mjs';
import { staleCoverage } from './stale-coverage.mjs';
import { buildLocalityWeights } from './popular-places.mjs';

const syncRoot = resolve(fileURLToPath(new URL('.', import.meta.url)));
const defaultCacheDir = resolve(syncRoot, '../../.data-cache/address-sync');

const nativeLanguage = {
  US: 'en', CA: 'en', MX: 'es', GB: 'en', DE: 'de', FR: 'fr', IT: 'it', ES: 'es', NL: 'nl',
  RU: 'ru', CN: 'zh-CN', HK: 'zh-HK', TW: 'zh-TW', JP: 'ja', SG: 'en', KR: 'ko', VN: 'vi',
  TH: 'th', PH: 'fil', MY: 'ms', SA: 'ar', IN: 'en', AU: 'en', TR: 'tr', BR: 'pt-BR', NG: 'en', ZA: 'en'
};
const residentialBuildings = new Set(['apartments', 'bungalow', 'cabin', 'detached', 'dormitory', 'ger', 'house', 'residential', 'semidetached_house', 'terrace']);

const clean = (value) => String(value ?? '').replace(/\s+/gu, ' ').trim();
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const finiteCoordinate = (value, minimum, maximum) => Number.isFinite(Number(value)) && Number(value) >= minimum && Number(value) <= maximum;
const integer = (value, fallback, minimum = 1) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : fallback;
};
const boolean = (value, fallback = false) => value === undefined ? fallback : /^(1|true|yes)$/iu.test(String(value));
const sourceQualityFailureSignature = (shard, discovery, policy) => {
  const buildingAssets = Array.isArray(discovery.buildingAssets) ? discovery.buildingAssets.length : 0;
  const residentialBuildingAvailable = discovery.residentialBuildingAvailable
    ?? (discovery.adapter === 'geofabrik' || buildingAssets > 0);
  const policyInputs = {
    targetCount: policy.targetCount,
    levelLimits: policy.levelLimits,
    overrides: [...(policy.overrides || new Map())].sort(([left], [right]) => left.localeCompare(right)),
    floors: {
      level1Min: Number(policy.level1Min) || 0,
      level2Min: Number(policy.level2Min) || 0,
      minPerNode: Number(policy.minPerNode) || 0,
      nodes: [...(policy.nodeFloors || new Map())].sort(([left], [right]) => left.localeCompare(right))
    },
    qualityGate: shard.qualityGate || {}
  };
  return [
    shard.id,
    discovery.adapter,
    sourceCapabilityRevision(shard) || 'external',
    discovery.version,
    `residential-buildings=${Number(Boolean(residentialBuildingAvailable))}`,
    `building-assets=${buildingAssets}`,
    `import=${ADDRESS_IMPORT_REVISION}`,
    `policy=${JSON.stringify(policyInputs)}`
  ].join(':');
};

export const mapConcurrent = async (values, concurrency, worker) => {
  const output = new Array(values.length);
  let cursor = 0;
  const count = Math.min(values.length, Math.max(1, integer(concurrency, 1)));
  await Promise.all(Array.from({ length: count }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await worker(values[index], index);
    }
  }));
  return output;
};

export const formattedAddress = (components, countryCode) => [
  [components.houseNumber, components.street].filter(Boolean).join(' '),
  components.buildingName,
  components.unit,
  components.district,
  components.locality,
  components.admin1,
  components.postcode,
  countryCode
].filter(Boolean).join(', ');

const displayNames = {
  en: new Intl.DisplayNames(['en'], { type: 'region' }),
  zh: new Intl.DisplayNames(['zh-CN'], { type: 'region' })
};
export const localizedFields = ['admin1', 'locality', 'postalLocality', 'district', 'street', 'buildingName', 'unit'];
import { expandEnglishStreetType, normalizeAddressDigits, normalizeChineseStreetType, usableAddressTranslation as usableTranslation } from '../../src/domain/address-localization.mjs';
const letters = /\p{L}/u;
const toSimplified = createSimplifier({ from: 'hk', to: 'cn' });
export { usableTranslation };

const hongKongBilingualComponent = (value) => {
  const source = clean(value);
  if (!/[\p{Script=Han}]/u.test(source) || !/[A-Za-z]/u.test(source)) return null;
  const trimSeparator = (part) => clean(part).replace(/^(?:&\s*)+|(?:\s*&)+$/gu, '').trim();
  const native = trimSeparator(source.replace(/[A-Za-z][A-Za-z0-9 .,'’()\/-]*/gu, ' '));
  const en = trimSeparator(source.replace(/[\p{Script=Han}]+/gu, ' ').replace(/[，。；：、]/gu, ' '));
  return native && en ? { native, en } : null;
};

const spacedScript = /^(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])[\p{L}\p{N}]$/u;
export const localizedFormattedAddress = (components, countryCode, language) => {
  const values = language === 'zh-CN'
    ? [displayNames.zh.of(countryCode), components.admin1, components.locality, components.postalLocality,
      // A Japanese chōme street already starts with its town (町名), which is stored as the district.
      countryCode === 'JP' && components.district && components.street?.startsWith(components.district) ? '' : components.district,
      components.street, components.houseNumber, components.buildingName,
      components.unit,
      components.postcode]
    : [[components.houseNumber, components.street].filter(Boolean).join(' '), components.buildingName,
      components.unit,
      components.district, components.postalLocality || components.locality, components.admin1,
      components.postcode, displayNames.en.of(countryCode)];
  const parts = values.filter(Boolean).filter((value, index, all) => index === 0 || value !== all[index - 1]);
  // Chinese text joins without separators, but adjacent alphabetic or digit parts (an untranslated street,
  // house number, postcode) need a space so they do not run together.
  return language === 'zh-CN'
    ? parts.reduce((text, part) => text && spacedScript.test(text.at(-1)) && spacedScript.test(part[0]) ? `${text} ${part}` : `${text}${part}`, '')
    : parts.join(', ');
};

const withEnglishHints = (record, components) => ({ ...components, ...(record.englishComponentHints || {}) });
const withChineseHints = (record, components) => ({ ...components, ...(record.chineseComponentHints || {}) });

const chinaSuffixes = {
  admin1: [['自治区', 'Autonomous Region'], ['特别行政区', 'Special Administrative Region'], ['省', 'Province'], ['市', 'Municipality']],
  locality: [['自治州', 'Autonomous Prefecture'], ['地区', 'Prefecture'], ['市', 'City'], ['区', 'District'], ['县', 'County']],
  postalLocality: [['自治州', 'Autonomous Prefecture'], ['地区', 'Prefecture'], ['市', 'City'], ['区', 'District'], ['县', 'County']],
  district: [['自治县', 'Autonomous County'], ['新区', 'New Area'], ['区', 'District'], ['县', 'County'], ['镇', 'Town']],
  street: [['大道', 'Avenue'], ['大街', 'Street'], ['公路', 'Highway'], ['街', 'Street'], ['路', 'Road'], ['巷', 'Lane']]
};
const romanizeChineseName = (value) => pinyin(toSimplified(clean(value)), {
  toneType: 'none', type: 'array', nonZh: 'consecutive'
}).map((part) => part.trim()).filter(Boolean).join('')
  .replace(/^\p{Ll}/u, (initial) => initial.toLocaleUpperCase('en'));
const romanizeChinese = (field, value) => {
  const source = toSimplified(clean(value));
  const suffix = chinaSuffixes[field]?.find(([candidate]) => source.endsWith(candidate));
  return suffix ? [romanizeChineseName(source.slice(0, -suffix[0].length)), suffix[1]].filter(Boolean).join(' ') : romanizeChineseName(source);
};

const deferredLocalizations = (record) => {
  const native = { ...record.components };
  const english = withEnglishHints(record, ['CN', 'HK', 'TW'].includes(record.countryCode)
    ? Object.fromEntries(Object.entries(native).map(([field, value]) => [
      field,
      localizedFields.includes(field) && value ? romanizeChinese(field, value) : value
    ]))
    : native);
  const chinese = withChineseHints(record, ['CN', 'HK', 'TW'].includes(record.countryCode)
    ? Object.fromEntries(Object.entries(native).map(([field, value]) => [field, typeof value === 'string' ? toSimplified(value) : value]))
    : native);
  return {
    native: { components: native, formattedAddress: record.formattedAddress, source: 'source' },
    en: {
      components: english,
      formattedAddress: localizedFormattedAddress(english, record.countryCode, 'en'),
      source: record.nativeLanguage.toLowerCase().startsWith('en') ? 'source' : 'local-postal-fallback'
    },
    'zh-CN': {
      components: chinese,
      formattedAddress: localizedFormattedAddress(chinese, record.countryCode, 'zh-CN'),
      source: record.nativeLanguage === 'zh-CN' ? 'source' : 'local-postal-fallback'
    }
  };
};

export const googleTranslate = async (values, target, fetchImpl, signal) => {
  const boundary = '[[[ADDRESS_COMPONENT_BOUNDARY]]]';
  const url = new URL('https://translate.googleapis.com/translate_a/single');
  Object.entries({ client: 'gtx', dt: 't', sl: 'auto', tl: target, q: values.join(`\n${boundary}\n`) })
    .forEach(([key, value]) => url.searchParams.set(key, value));
  const response = await fetchImpl(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'address-sync/1.0' },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000)
  });
  if (!response.ok) throw Object.assign(new Error('GOOGLE_TRANSLATION_UNAVAILABLE'), {
    code: `GOOGLE_HTTP_${response.status}`,
    retryAt: response.status === 429 ? new Date(Date.now() + 60_000).toISOString() : null
  });
  const payload = await response.json();
  const translations = Array.isArray(payload?.[0])
    ? payload[0].map((segment) => Array.isArray(segment) ? segment[0] || '' : '').join('')
      .split(boundary).map((value) => value.trim())
    : [];
  return translations.length === values.length && translations.every(Boolean) ? translations : null;
};

const youdaoTranslate = async (values, target, environment, fetchImpl, signal) => {
  const appKey = environment.YOUDAO_APP_KEY?.trim();
  const appSecret = environment.YOUDAO_APP_SECRET?.trim();
  if (!appKey || !appSecret) return null;
  const salt = randomUUID();
  const curtime = String(Math.floor(Date.now() / 1000));
  const joined = Array.from(values.join(''));
  const input = joined.length <= 20 ? joined.join('') : `${joined.slice(0, 10).join('')}${joined.length}${joined.slice(-10).join('')}`;
  const sign = sha256(`${appKey}${input}${salt}${curtime}${appSecret}`);
  const body = new URLSearchParams({ appKey, salt, from: 'auto', to: target === 'zh-CN' ? 'zh-CHS' : target, sign, signType: 'v3', curtime });
  values.forEach((value) => body.append('q', value));
  const response = await fetchImpl('https://openapi.youdao.com/v2/api', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'address-sync/1.0' },
    body,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000)
  });
  if (!response.ok) return null;
  const payload = await response.json();
  const translations = payload?.errorCode === '0' && Array.isArray(payload.translateResults)
    ? payload.translateResults.map((item) => clean(item.translation))
    : [];
  return translations.length === values.length && translations.every(Boolean) ? translations : null;
};

export const translateValues = async (values, target, environment, fetchImpl, cache, signal, providers = {}, accepts = usableTranslation) => {
  signal?.throwIfAborted();
  const output = cache ? await cache.get(values, target, signal) : new Map();
  const missing = [...new Set(values)].filter((value) => !accepts(output.get(value), target, value));
  const routed = Array.isArray(providers.translationChain)
    ? providers.translationChain.map((route) => route.translate).filter(Boolean) : null;
  const broker = missing.length && !routed && (!providers.deepl || !providers['openai-compatible'])
    ? await createCredentialBrokerClient(environment, { fetchImpl }) : null;
  const deepl = providers.deepl || (broker ? async (texts) => {
    const result = await broker.request('deepl.translate', { values: texts, target }, { signal, maxDispatches: 2 });
    return result.translations.map((item) => item.text);
  } : null);
  const openAICompatible = providers['openai-compatible'] || (broker ? async (texts) => {
    const result = await broker.request('openai-compatible.translate', { values: texts, target }, { signal, maxDispatches: 2, timeoutMs: OPENAI_COMPATIBLE_TIMEOUT_MS + 5_000 });
    return result.translations;
  } : null);
  const chunks = [];
  for (let offset = 0; offset < missing.length;) {
    const chunk = [];
    let characters = 0;
    while (offset < missing.length && chunk.length < 30) {
      const value = missing[offset];
      if (chunk.length && characters + value.length > 1200) break;
      chunk.push(value);
      characters += value.length;
      offset += 1;
    }
    chunks.push(chunk);
  }
  const legacyChain = routed ? null : [deepl ? (texts) => deepl(texts, target, fetchImpl, signal) : null,
    openAICompatible ? (texts) => openAICompatible(texts, target, fetchImpl, signal) : null,
    (texts) => (providers.youdao || youdaoTranslate)(texts, target, environment, fetchImpl, signal),
    /^(0|false|no)$/iu.test(String(environment.GOOGLE_TRANSLATION_ENABLED ?? 'true')) ? null
      : (texts) => (providers.google || googleTranslate)(texts, target, fetchImpl, signal)];
  // Routed chains run chunks in parallel within each route's concurrency; equal-priority routes share the load and a
  // busy group is awaited rather than skipped, so lower-priority fallbacks are used only for values left untranslated.
  const routes = routed ? providers.translationChain.filter((route) => route.translate) : [];
  const groups = [];
  for (const route of routes) {
    const last = groups.at(-1);
    if (last && route.priority !== undefined && last[0].priority === route.priority) last.push(route);
    else groups.push([route]);
  }
  const limit = (route) => Math.max(1, Math.trunc(Number(route.maxConcurrency) || 1));
  const active = new Map();
  let notify = () => {};
  let released = new Promise((resolve) => { notify = resolve; });
  const acquire = async (candidates) => {
    for (;;) {
      signal?.throwIfAborted();
      const route = candidates.filter((item) => (active.get(item) || 0) < limit(item))
        .sort((left, right) => (active.get(left) || 0) / limit(left) - (active.get(right) || 0) / limit(right))[0];
      if (route) { active.set(route, (active.get(route) || 0) + 1); return route; }
      await released;
    }
  };
  const release = (route) => {
    active.set(route, active.get(route) - 1);
    const wake = notify;
    released = new Promise((resolve) => { notify = resolve; });
    wake();
  };
  const translateChunk = async (chunk) => {
    const translated = new Map(chunk.map((value) => [value, value]));
    const attempt = async (translate) => {
      const retry = chunk.filter((value) => !accepts(translated.get(value), target, value));
      if (!retry.length || !translate) return;
      try {
        // Chinese renderings read the street type written out and keep the address type (Carson DR → 卡森大道).
        const chinese = target === 'zh-CN';
        const results = await translate(chinese ? retry.map(expandEnglishStreetType) : retry, target, fetchImpl, signal);
        retry.forEach((value, index) => {
          const result = chinese ? normalizeChineseStreetType(value, results?.[index]) : results?.[index];
          if (accepts(result, target, value)) translated.set(value, result);
        });
      } catch {
        signal?.throwIfAborted();
      }
    };
    if (routed) {
      for (const group of groups) {
        const pending = [...group];
        while (pending.length && chunk.some((value) => !accepts(translated.get(value), target, value))) {
          const route = await acquire(pending);
          pending.splice(pending.indexOf(route), 1);
          try { await attempt(route.translate); } finally { release(route); }
        }
      }
    } else {
      for (const translate of legacyChain) {
        if (!chunk.some((value) => !accepts(translated.get(value), target, value))) break;
        await attempt(translate);
      }
    }
    for (const [value, translation] of translated) output.set(value, translation);
    const accepted = new Map([...translated].filter(([value, translation]) => accepts(translation, target, value)));
    if (accepted.size) await cache?.set(accepted, target, signal);
  };
  const workers = routed ? Math.min(50, chunks.length, Math.max(1, routes.reduce((total, route) => total + limit(route), 0))) : 1;
  let next = 0;
  await Promise.all(Array.from({ length: workers }, async () => {
    while (next < chunks.length) {
      signal?.throwIfAborted();
      await translateChunk(chunks[next++]);
    }
  }));
  return output;
};

export const translateNumberedValues = async (values, target, environment, fetchImpl, cache, signal, providers, accepts = usableTranslation) => {
  const numbered = values.filter((value) => /\p{Decimal_Number}/u.test(value));
  const parts = new Map(numbered.map((value) => [value, value.split(/([A-Za-z]*\p{Decimal_Number}+[A-Za-z\p{Decimal_Number}]*(?:[-/.][A-Za-z\p{Decimal_Number}]+)*)/gu)]));
  const text = [...new Set([...parts.values()].flatMap((parts) => parts.filter((_part, index) => index % 2 === 0)
    .map(clean).filter((part) => letters.test(part))))];
  const translated = await translateValues(text, target, environment, fetchImpl, cache, signal, providers);
  const output = new Map();
  for (const [value, tokens] of parts) {
    const candidate = tokens.map((part, index) => index % 2 ? normalizeAddressDigits(part)
      : translated.get(clean(part)) || clean(part)).filter(Boolean).join(' ');
    const localized = target === 'zh-CN' ? normalizeChineseStreetType(value, candidate) : candidate;
    if (accepts(localized, target, value)) output.set(value, localized);
  }
  if (output.size) await cache?.set(output, target, signal);
  return output;
};

export const localizeAddressRecords = async (records, {
  environment = process.env,
  fetchImpl = fetch,
  cache,
  signal,
  database,
  brokerClient
} = {}) => {
  signal?.throwIfAborted();
  const selectedOnlineCountries = new Set(String(environment.ADDRESS_SYNC_TRANSLATION_COUNTRIES || '')
    .split(',').map((value) => value.trim().toUpperCase()).filter(Boolean));
  const useOnlineTranslation = boolean(environment.ADDRESS_SYNC_TRANSLATION_ENABLED, false)
    || records.some((record) => selectedOnlineCountries.has(record.countryCode));
  if (!useOnlineTranslation) {
    return records.map((record) => ({ ...record, localizations: deferredLocalizations(record) }));
  }
  const providers = database ? await (await import('./translation-providers.mjs')).createImportTranslationProviders({
    database, environment, fetchImpl, signal, brokerClient
  }) : {};
  const values = [...new Set(records.flatMap((record) => localizedFields.map((field) => record.components[field]).filter(Boolean)))];
  const needsEnglish = records.some((record) => !record.nativeLanguage.toLowerCase().startsWith('en'));
  const needsChinese = records.some((record) => record.nativeLanguage !== 'zh-CN');
  const [english, chinese] = await Promise.all([
    needsEnglish ? translateValues(values, 'en', environment, fetchImpl, cache, signal, providers) : Promise.resolve(new Map(values.map((value) => [value, value]))),
    needsChinese ? translateValues(values, 'zh-CN', environment, fetchImpl, cache, signal, providers) : Promise.resolve(new Map(values.map((value) => [value, value])))
  ]);
  signal?.throwIfAborted();
  return records.map((record) => {
    const build = (translations) => Object.fromEntries(Object.entries(record.components).map(([field, value]) => [
      field,
      localizedFields.includes(field) && value ? translations.get(value) || value : value
    ]));
    const englishComponents = withEnglishHints(
      record,
      record.nativeLanguage.toLowerCase().startsWith('en') ? record.components : build(english)
    );
    const chineseComponents = record.nativeLanguage === 'zh-CN' ? { ...record.components } : withChineseHints(record, build(chinese));
    return {
      ...record,
      localizations: {
        native: { components: record.components, formattedAddress: record.formattedAddress, source: 'source' },
        en: { components: englishComponents, formattedAddress: localizedFormattedAddress(englishComponents, record.countryCode, 'en'), source: record.nativeLanguage.toLowerCase().startsWith('en') ? 'source' : 'provider-chain' },
        'zh-CN': { components: chineseComponents, formattedAddress: localizedFormattedAddress(chineseComponents, record.countryCode, 'zh-CN'), source: record.nativeLanguage === 'zh-CN' ? 'source' : 'provider-chain' }
      }
    };
  });
};

export class PostgresTranslationCache {
  constructor(database) {
    this.database = database;
  }

  async get(values, targetLanguage, signal) {
    const originals = new Map(values.map((value) => [sha256(value), value]));
    const output = new Map();
    const keys = [...originals.keys()];
    for (let offset = 0; offset < keys.length; offset += 500) {
      signal?.throwIfAborted();
      const chunk = keys.slice(offset, offset + 500);
      const rows = await this.database.prepare(`SELECT cache_key,value FROM translation_cache
        WHERE target_language=? AND cache_key IN (${chunk.map(() => '?').join(',')})`)
        .bind(targetLanguage, ...chunk).all();
      for (const row of rows.results) {
        const original = originals.get(row.cache_key);
        if (original) output.set(original, targetLanguage === 'zh-CN' ? normalizeChineseStreetType(original, row.value) : row.value);
      }
    }
    return output;
  }

  async set(translations, targetLanguage, signal) {
    const updatedAt = new Date().toISOString();
    signal?.throwIfAborted();
    await this.database.batch([...translations].map(([original, translated]) => this.database.prepare(`
      INSERT INTO translation_cache(cache_key,target_language,value,updated_at) VALUES (?,?,?,?)
      ON CONFLICT(cache_key,target_language) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at
    `).bind(sha256(original), targetLanguage, translated, updatedAt)));
  }
}

const centroid = (geometry) => {
  if (!geometry || !Array.isArray(geometry.coordinates)) return null;
  if (geometry.type === 'Point') return geometry.coordinates;
  let longitude = 0;
  let latitude = 0;
  let count = 0;
  const visit = (coordinates) => {
    if (Array.isArray(coordinates) && coordinates.length >= 2 && Number.isFinite(Number(coordinates[0])) && Number.isFinite(Number(coordinates[1]))) {
      longitude += Number(coordinates[0]);
      latitude += Number(coordinates[1]);
      count += 1;
      return;
    }
    if (Array.isArray(coordinates)) coordinates.forEach(visit);
  };
  visit(geometry.coordinates);
  return count ? [longitude / count, latitude / count] : null;
};

// Taiwan's official names write 臺 (臺北市, 臺東縣, 臺西鄉); sources also use the common variant 台.
export const taiwanOfficialName = (value) => clean(value).replace(/^台/u, '臺');
const normalizeTaiwanHierarchy = (...args) => {
  const hierarchy = taiwanHierarchy(...args);
  return { ...hierarchy, admin1: taiwanOfficialName(hierarchy.admin1), locality: taiwanOfficialName(hierarchy.locality) };
};
const taiwanHierarchy = (levels, postalCity, fallbackAdmin1, fallbackLocality, fallbackDistrict) => {
  const values = [...new Set(levels.map((value) => clean(value)).filter(Boolean))];
  const preferredAdmin1 = clean(postalCity);
  const adminIndex = preferredAdmin1 && /[縣市]$/u.test(preferredAdmin1)
    ? values.findIndex((value) => value === preferredAdmin1)
    : values.findIndex((value) => /[縣市]$/u.test(value));
  if (adminIndex < 0) return {
    admin1: fallbackAdmin1,
    locality: fallbackLocality,
    district: fallbackDistrict
  };
  const admin1 = values[adminIndex];
  const localityIndex = values.findIndex((value, index) => index > adminIndex && /[區鄉鎮市]$/u.test(value));
  if (localityIndex < 0) return { admin1, locality: '', district: '' };
  const locality = values[localityIndex];
  const district = values.find((value, index) => index > localityIndex && /[里村]$/u.test(value)) || '';
  return { admin1, locality, district };
};

export const normalizeSourceRecord = (value, shard, format) => {
  const declaredMatchLevel = clean(value.match_level || value.properties?.match_level);
  let sourceRecordId;
  let admin1;
  let locality;
  let postalLocality;
  let district;
  let postcode;
  let street;
  let houseNumber;
  let buildingName = '';
  let unit = '';
  let longitude;
  let latitude;
  let propertyType = 'unknown';
  let residentialSourceRecordId = '';
  let residentialSourceClass = '';
  let residentialSourceRecordUrl = '';
  let sourceDataset = shard.source.name;
  let sourceRecordUrl = '';
  if (format === 'overture-jsonl') {
    const addressLevels = (Array.isArray(value.address_levels) ? value.address_levels : [])
      .map((level) => clean(typeof level === 'object' && level !== null ? level.value : level))
      .filter(Boolean);
    const postalCity = clean(value.postal_city);
    sourceRecordId = clean(value.source_record_id || value.id);
    admin1 = clean(value.admin1) || addressLevels[0] || '';
    if (['JP', 'MX', 'TW'].includes(shard.countryCode)) {
      locality = postalCity || (addressLevels.length >= 3 ? addressLevels.at(-2) : addressLevels.at(-1)) || '';
      district = addressLevels.length >= 3 ? addressLevels.at(-1) : '';
    } else if (shard.countryCode === 'IT') {
      locality = postalCity || addressLevels.at(-1) || clean(value.locality);
      district = addressLevels.length >= 2 ? addressLevels.at(-2) : '';
    } else {
      locality = clean(value.locality) || postalCity || addressLevels.at(-1) || '';
      const candidateDistrict = clean(value.district) || (addressLevels.length >= 3 ? addressLevels.at(-1) : '');
      district = candidateDistrict !== locality && candidateDistrict !== admin1 ? candidateDistrict : '';
    }
    if (shard.countryCode === 'TW') {
      const hierarchy = normalizeTaiwanHierarchy(addressLevels, postalCity, admin1, locality, district);
      ({ admin1, locality, district } = hierarchy);
      postalLocality = locality;
    } else {
      postalLocality = postalCity;
    }
    postcode = clean(value.postcode);
    street = clean(value.street);
    houseNumber = clean(value.number).normalize('NFKC');
    buildingName = clean(value.building_name);
    unit = clean(value.unit);
    longitude = Number(value.longitude);
    latitude = Number(value.latitude);
    const overturePropertyType = clean(value.property_type).toLowerCase();
    if (overturePropertyType === 'residential' || overturePropertyType === 'apartment') {
      propertyType = overturePropertyType;
      residentialSourceRecordId = clean(value.residential_building_id);
      residentialSourceClass = clean(value.residential_building_class);
    }
    sourceDataset = clean(value.source_dataset) || sourceDataset;
    const provider = clean(value.source_record_provider);
    if (provider) {
      if (!Object.hasOwn(shard.source.recordSources || {}, provider)) return null;
      const provenance = shard.source.recordSources[provider];
      sourceDataset = provenance.name;
      sourceRecordUrl = provenance.url;
    }
    const residentialProvider = clean(value.residential_source_provider);
    if (residentialSourceRecordId && residentialProvider) {
      if (!Object.hasOwn(shard.source.recordSources || {}, residentialProvider)) return null;
      residentialSourceRecordUrl = shard.source.recordSources[residentialProvider].url;
    }
  } else if (format === 'geofabrik-geojsonseq') {
    const properties = value.properties || {};
    const declaredCountry = clean(properties['addr:country']).toUpperCase();
    if (/^[A-Z]{2}$/u.test(declaredCountry) && declaredCountry !== shard.countryCode) return null;
    const point = centroid(value.geometry);
    sourceRecordId = clean(properties['@id'] || value.id);
    admin1 = clean(properties['addr:state'] || properties['addr:province']);
    const sourceLocality = clean(properties['addr:city'] || properties['addr:town']
      || properties['addr:village'] || properties['addr:municipality']);
    locality = sourceLocality;
    district = clean(properties['addr:district'] || properties['addr:suburb'] || properties['addr:county']);
    if (shard.countryCode === 'TH') {
      locality = clean(properties['addr:district']) || sourceLocality;
      district = clean(properties['addr:subdistrict'] || properties['addr:suburb'] || properties['addr:county']);
    } else if (shard.countryCode === 'PH') {
      district = clean(properties['addr:barangay'] || properties['addr:district']
        || properties['addr:suburb'] || properties['addr:county']);
    } else if (shard.countryCode === 'VN') {
      locality = clean(properties['addr:ward'] || properties['addr:commune']
        || properties['addr:subdistrict']) || sourceLocality;
      district = '';
    }
    postalLocality = locality;
    if (shard.countryCode === 'TW') {
      const hierarchy = normalizeTaiwanHierarchy([admin1, locality, district], locality, admin1, locality, district);
      ({ admin1, locality, district } = hierarchy);
      postalLocality = locality;
    }
    postcode = clean(properties['addr:postcode']);
    street = clean(properties['addr:street'] || properties['addr:place']);
    houseNumber = clean(properties['addr:housenumber']).normalize('NFKC');
    unit = clean(properties['addr:unit'] || properties['addr:flats']);
    buildingName = clean(properties.name);
    longitude = Number(point?.[0]);
    latitude = Number(point?.[1]);
    const building = clean(properties.building).toLowerCase();
    const matchedBuildingId = clean(properties.residential_building_id);
    const matchedBuildingClass = clean(properties.residential_building_class).toLowerCase();
    if (matchedBuildingId && properties['@type'] === 'node') buildingName = '';
    if (matchedBuildingId && residentialBuildings.has(matchedBuildingClass)) {
      propertyType = matchedBuildingClass === 'apartments' ? 'apartment' : 'residential';
      residentialSourceRecordId = matchedBuildingId;
      residentialSourceClass = `building=${matchedBuildingClass}`;
    } else if (residentialBuildings.has(building)) {
      propertyType = building === 'apartments' ? 'apartment' : 'residential';
      residentialSourceRecordId = sourceRecordId;
      residentialSourceClass = `building=${building}`;
    }
  } else {
    throw new Error(`Unsupported normalized source format: ${format}`);
  }
  // A "no number" marker, a number without digits or a whole address in the number field only proves the street.
  const numberless = declaredMatchLevel !== 'street' && Boolean(houseNumberIssue(shard.countryCode, houseNumber));
  if (numberless) {
    houseNumber = '';
    buildingName = '';
    unit = '';
    propertyType = 'unknown';
    residentialSourceRecordId = '';
    residentialSourceClass = '';
    residentialSourceRecordUrl = '';
  }
  const matchLevel = numberless ? 'street' : declaredMatchLevel || (unit ? 'subpremise' : 'premise');
  const streetLevel = matchLevel === 'street' && shard.countryCode !== 'CN';
  if (!['street', 'premise', 'subpremise'].includes(matchLevel) || (matchLevel === 'street' && !streetLevel)) return null;
  if (streetLevel && (houseNumber || buildingName || unit || propertyType !== 'unknown' || residentialSourceRecordId)) return null;
  if (!sourceRecordId || !street || (!streetLevel && !houseNumber) || !finiteCoordinate(longitude, -180, 180) || !finiteCoordinate(latitude, -90, 90)) return null;
  let components = trimStreetAdministration(shard.countryCode, normalizeAddressFacts(shard.countryCode, {
    houseNumber, street, buildingName, unit, district, locality, postalLocality, admin1, postcode
  }));
  street = components.street;
  if (shard.countryCode === 'IN') {
    const english = englishOnlyComponents(components);
    if (english.emptied.some((field) => englishOnlyCoreFields.includes(field) || field === 'houseNumber' && !streetLevel)) return null;
    components = english.components;
    ({ admin1 = '', locality = '', postalLocality = '', district = '', street = '', buildingName = '', unit = '', houseNumber = '' } = components);
  }
  if (value.admin1_code) components.admin1Code = clean(value.admin1_code);
  const englishComponentHints = {};
  if (shard.countryCode === 'HK') {
    for (const field of localizedFields) {
      const split = hongKongBilingualComponent(components[field]);
      if (!split) continue;
      components[field] = split.native;
      englishComponentHints[field] = split.en;
    }
    ({ admin1, locality, postalLocality, district, street, buildingName, unit } = components);
  }
  const nonResidential = findNonResidentialMatch({
    countryCode: shard.countryCode,
    buildingNames: [buildingName],
    formattedAddresses: [formattedAddress(components, shard.countryCode)],
    streets: [street]
  }).excluded;
  if (nonResidential) {
    if (shard.countryCode === 'CN') return null;
    propertyType = 'unknown';
    residentialSourceRecordId = '';
    residentialSourceClass = '';
  }
  if (matchesCustomBlacklist([buildingName, formattedAddress(components, shard.countryCode), street])) return null;
  const canonicalKey = addressCanonicalKey(shard.countryCode, components, matchLevel);
  const canonicalHash = sha256(streetLevel ? streetAddressKey(shard.countryCode, components) : [
    shard.countryCode, admin1, locality, postcode, street, houseNumber, unit,
    longitude.toFixed(6), latitude.toFixed(6)
  ].map((part) => clean(part).toLocaleLowerCase('und')).join('\u001f'));
  return {
    id: `addr-${canonicalHash.slice(0, 40)}`,
    canonicalHash,
    canonicalKey,
    sourceRecordId,
    sourceDataset,
    sourceRecordUrl,
    countryCode: shard.countryCode,
    matchLevel,
    admin1,
    admin1Code: clean(value.admin1_code),
    locality,
    postalLocality,
    district,
    postcode,
    street,
    houseNumber,
    buildingName,
    unit,
    propertyType,
    residentialSourceRecordId,
    residentialSourceClass,
    residentialSourceRecordUrl,
    evidenceClass: streetLevel ? 'sourced-street' : clean(value.residential_evidence).startsWith('BU_USE=')
      ? 'official-residential-address-register'
      : clean(value.residential_evidence).startsWith('OSM_BUILDING_GOOGLE=')
        ? 'open-residential-building-geocoded'
      : format === 'overture-jsonl' ? 'official-address-point' : 'open-address-point',
    qualityScore: clean(value.residential_evidence).startsWith('BU_USE=') ? 0.94
      : clean(value.residential_evidence).startsWith('OSM_BUILDING_GOOGLE=') ? 0.9
      : format === 'overture-jsonl' ? 0.86 : 0.8,
    nativeLanguage: nativeLanguage[shard.countryCode] || 'und',
    longitude,
    latitude,
    formattedAddress: formattedAddress(components, shard.countryCode),
    components,
    englishComponentHints,
    ...(value.admin_boundary && typeof value.admin_boundary === 'object' ? { administrativeBoundary: value.admin_boundary } : {}),
    // Popular-city exports rank their rows; tier 1 is a popular metro area's share.
    ...(Number.isSafeInteger(value.sampling_rank) ? { samplingRank: value.sampling_rank, samplingTier: Number(value.sampling_tier) } : {}),
    ...(value.admin_region && typeof value.admin_region === 'object'
      ? { administrativeRegion: value.admin_region.outside ? { outside: true } : value.admin_region.region || null } : {})
  };
};

const loadState = async (file) => {
  let value;
  try {
    value = await readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { schemaVersion: 1, shards: {} };
    throw Object.assign(new Error(`Unable to read address sync state: ${file}`, { cause: error }), { code: 'SYNC_STATE_INVALID' });
  }
  let state;
  try { state = JSON.parse(value); }
  catch (error) { throw Object.assign(new Error(`Address sync state is not valid JSON: ${file}`, { cause: error }), { code: 'SYNC_STATE_INVALID' }); }
  if (!state || typeof state !== 'object' || Array.isArray(state) || state.schemaVersion !== 1
    || !state.shards || typeof state.shards !== 'object' || Array.isArray(state.shards)) {
    throw Object.assign(new Error(`Address sync state has an unsupported structure: ${file}`), { code: 'SYNC_STATE_INVALID' });
  }
  return state;
};

const saveState = async (file, state) => {
  await mkdir(resolve(file, '..'), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
};

const directorySize = async (directory) => {
  let total = 0;
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    total += entry.isDirectory() ? await directorySize(path) : (await stat(path)).size;
  }
  return total;
};

const pruneShardCache = async (cacheDir, shard, keepFile) => {
  const directory = resolve(cacheDir, 'normalized');
  const keepPaths = new Set([resolve(keepFile), `${resolve(keepFile)}.complete`]);
  let entries;
  try { entries = await readdir(directory); }
  catch (error) { if (error?.code === 'ENOENT') return; throw error; }
  await Promise.all(entries
    .filter((name) => name.startsWith(`${shard.id}-`) && !keepPaths.has(resolve(directory, name)))
    .map((name) => rm(resolve(directory, name), { force: true })));
};

const prioritizeCachedShards = async (shards, cacheDir) => {
  let entries;
  try { entries = await readdir(resolve(cacheDir, 'normalized')); }
  catch (error) { if (error?.code === 'ENOENT') return shards; throw error; }
  return shards.map((shard, index) => ({
    shard,
    index,
    cached: entries.some((name) => name.startsWith(`${shard.id}-`) && !name.includes('.tmp'))
  })).sort((left, right) => Number(right.cached) - Number(left.cached) || left.index - right.index)
    .map(({ shard }) => shard);
};

const selectShards = (catalog, requested) => {
  if (!requested?.length || requested.includes('all')) return catalog.shards;
  const normalized = new Set(requested.flatMap((value) => String(value).split(',')).map((value) => value.trim().toLowerCase()).filter(Boolean));
  const selected = catalog.shards.filter((shard) => normalized.has(shard.id.toLowerCase()) || normalized.has(shard.countryCode.toLowerCase()));
  const unresolved = [...normalized].filter((value) => !selected.some((shard) => shard.id.toLowerCase() === value || shard.countryCode.toLowerCase() === value));
  if (unresolved.length) throw new Error(`Unknown address source shard: ${unresolved.join(', ')}`);
  return selected;
};

export const runAddressEtl = async ({
  fetchImpl = fetch,
  database: providedDatabase,
  environment = process.env,
  cacheDir = process.env.ADDRESS_SYNC_CACHE_DIR || defaultCacheDir,
  dataRoot = process.env.ADDRESS_DATA_ROOT || resolve('data'),
  requestedShards = process.env.ADDRESS_SYNC_SHARDS ? [process.env.ADDRESS_SYNC_SHARDS] : ['all'],
  dryRun = boolean(process.env.ADDRESS_SYNC_DRY_RUN),
  estimate = false,
  force = boolean(process.env.ADDRESS_SYNC_FORCE) || process.env.ADDRESS_SYNC_TRIGGER === 'manual',
  syncMode = process.env.ADDRESS_SYNC_MODE || (process.env.ADDRESS_SYNC_TRIGGER === 'initial' ? 'initial' : force ? 'manual' : 'daily'),
  softLimitBytes = integer(process.env.ADDRESS_STORAGE_SOFT_LIMIT_BYTES, DEFAULT_SOFT_LIMIT_BYTES),
  hardLimitBytes = integer(process.env.ADDRESS_STORAGE_HARD_LIMIT_BYTES, DEFAULT_HARD_LIMIT_BYTES),
  minFreeDiskBytes = integer(process.env.ADDRESS_STORAGE_MIN_FREE_BYTES, DEFAULT_MIN_FREE_DISK_BYTES),
  bytesPerRecord = integer(process.env.ADDRESS_STORAGE_BYTES_PER_RECORD, DEFAULT_STORAGE_BYTES_PER_RECORD),
  maxRecords = integer(process.env.ADDRESS_SYNC_MAX_RECORDS_PER_SHARD, 200_000),
  maxGrowthPerRun = integer(process.env.ADDRESS_SYNC_MAX_GROWTH_PER_RUN, 50_000),
  maxCandidates = integer(process.env.ADDRESS_SYNC_MAX_CANDIDATES, 300_000),
  perLocality = integer(process.env.ADDRESS_SYNC_RECORDS_PER_LOCALITY, 64),
  maxShardsPerRun = integer(process.env.ADDRESS_SYNC_MAX_SHARDS_PER_RUN, !estimate && syncMode === 'daily' ? 1 : Number.MAX_SAFE_INTEGER),
  requireResidential = boolean(process.env.ADDRESS_SYNC_REQUIRE_RESIDENTIAL),
  retainRaw = boolean(process.env.ADDRESS_SYNC_RETAIN_RAW),
  prepareConcurrency = integer(process.env.ADDRESS_SYNC_PREPARE_CONCURRENCY, 1),
  cpuConcurrency = integer(process.env.ADDRESS_SYNC_CPU_CONCURRENCY, 1),
  maxPrepareConcurrency = integer(process.env.ADDRESS_SYNC_MAX_PREPARE_CONCURRENCY, 1),
  maxCpuConcurrency = integer(process.env.ADDRESS_SYNC_MAX_CPU_CONCURRENCY, 1),
  signal,
  onProgress = () => {},
  now = () => new Date(),
  catalog: providedCatalog,
  adapters: providedAdapters,
  credentialPool = null,
  credentialBrokerClient = null,
  importer: providedImporter,
  localizeRecords = localizeAddressRecords,
  stateStore: providedStateStore,
  measureStorage = measureStorageBytes,
  freeDiskBytes = (path) => statfs(path).then((stats) => Number(stats.bavail) * Number(stats.bsize))
} = {}) => {
  const checkpoint = () => signal?.throwIfAborted();
  const reportProgress = async (progress) => {
    try { await onProgress(progress); } catch (error) { console.error('[address-sync] progress reporting failed', error); }
  };
  checkpoint();
  const catalog = providedCatalog || await loadSourceCatalog(undefined, environment);
  const requested = selectShards(catalog, requestedShards);
  const stateFile = resolve(cacheDir, 'manifest.json');
  const activeRun = !dryRun && !estimate;
  const database = providedDatabase;
  if (activeRun && !providedImporter && !database) throw new Error('PostgreSQL database is required for address synchronization');
  // Storage covers cache files and the database; a low-disk host counts as full.
  const measureUsage = async () => {
    const [files, databaseBytes, free] = await Promise.all([
      measureStorage([dataRoot]),
      (async () => database
        ? Number(await database.prepare('SELECT pg_database_size(current_database()) AS size').first('size')) : 0)()
        .catch(() => 0),
      Promise.resolve().then(() => freeDiskBytes(dataRoot)).catch(() => null)
    ]);
    const used = files + (Number.isSafeInteger(databaseBytes) ? databaseBytes : 0);
    return Number.isFinite(free) && free < minFreeDiskBytes ? Math.max(used, hardLimitBytes) : used;
  };
  const localityWeightsByCountry = new Map();
  const countryLocalityWeights = (countryCode) => {
    if (!localityWeightsByCountry.has(countryCode)) {
      localityWeightsByCountry.set(countryCode, buildLocalityWeights(database, countryCode).catch((error) => {
        console.error(`[address-sync] ${countryCode} locality weights unavailable`, error?.message || error);
        return undefined;
      }));
    }
    return localityWeightsByCountry.get(countryCode);
  };
  const enabledCountries = database && activeRun
    ? Number(await database.prepare('SELECT COUNT(*) AS total FROM sync_country_policies WHERE enabled=1').first('total')
      .catch(() => 0)) || Object.keys(ADDRESS_POLICY_DEFAULTS).length
    : Object.keys(ADDRESS_POLICY_DEFAULTS).length;
  const runtimePolicy = database && activeRun
    ? await getRuntimePolicy(database)
    : { prepareConcurrency: Math.min(10, prepareConcurrency), cpuConcurrency: Math.min(4, cpuConcurrency) };
  runtimePolicy.prepareConcurrency = Math.min(runtimePolicy.prepareConcurrency, maxPrepareConcurrency);
  runtimePolicy.cpuConcurrency = Math.min(runtimePolicy.cpuConcurrency, maxCpuConcurrency);
  const loadSeedLocations = async (countryCode) => {
    if (!database) return [];
    return (await database.prepare(`SELECT latitude,longitude FROM catalog_postcodes
      WHERE country_code=? AND latitude IS NOT NULL AND longitude IS NOT NULL
      UNION SELECT latitude,longitude FROM catalog_cities
      WHERE country_code=? AND latitude IS NOT NULL AND longitude IS NOT NULL
      ORDER BY latitude,longitude`).bind(countryCode, countryCode).all()).results;
  };
  const loadCoverageTargets = async (countryCode) => database
    ? loadGoogleCoverageTargets(database, countryCode)
    : [];
  const adapters = providedAdapters || createSourceAdapters({
    processConcurrency: runtimePolicy.cpuConcurrency,
    signal,
    environment,
    credentialPool,
    credentialBrokerClient,
    loadSeedLocations,
    loadGoogleCoverageTargets: loadCoverageTargets
  });
  const importer = activeRun ? providedImporter || new PostgresAddressImporter({
    database,
    normalizeRecord: normalizeSourceRecord,
    localizeRecords: (records, options = {}) => localizeRecords(records, {
      database, environment, fetchImpl, brokerClient: credentialBrokerClient || undefined,
      cache: new PostgresTranslationCache(database),
      signal: options.signal
    }),
    hash: sha256,
    reverseGeocoder: (countryCode) => CatalogReverseGeocoder.load(database, countryCode),
    rebuildFormattedAddress: formattedAddress
  }) : null;
  const stateStore = providedStateStore || (database && activeRun ? new PostgresCountryStateStore({ database, shards: catalog.shards, now }) : {
    load: () => loadState(stateFile),
    save: (value) => saveState(stateFile, value)
  });
  const state = await stateStore.load();
  if (!state || typeof state !== 'object' || !state.shards || typeof state.shards !== 'object') {
    throw new Error('Address sync state store returned an invalid state');
  }
  const checkedAt = now();
  let selected = estimate
    ? requested.slice(0, maxShardsPerRun)
    : planCountryShards({ shards: requested, state, mode: syncMode, now: checkedAt, maxCountries: maxShardsPerRun });
  if (!estimate && syncMode === 'initial' && requireResidential) {
    const selectedIds = new Set(selected.map(({ id }) => id));
    for (const shard of requested) {
      if (Number(state.shards[shard.id]?.residentialCount || 0) < 1 && !selectedIds.has(shard.id)) {
        selected.push(shard);
      }
    }
  }
  if (syncMode === 'initial' && selected.length > 1) selected = await prioritizeCachedShards(selected, cacheDir);
  const cacheBytesBefore = await directorySize(cacheDir);
  let plannedCacheBytes = cacheBytesBefore;
  const storageBytesBefore = await measureUsage();
  let plannedStorageBytes = storageBytesBefore;
  let storageBudget = assertStorageBudget({ currentBytes: storageBytesBefore, softLimitBytes, hardLimitBytes });
  const selectedIds = new Set(selected.map((shard) => shard.id));
  await reportProgress({ phase: 'planned', selectedShards: [...selectedIds] });
  const reports = requested.filter((shard) => !selectedIds.has(shard.id)).map((shard) => {
    const previous = state.shards[shard.id];
    return {
      shardId: shard.id,
      shardKey: shard.id,
      sourceId: shard.source.id,
      countryCode: shard.countryCode,
      status: isCountryDue(previous, shard.intervalDays, checkedAt) ? 'deferred' : 'not-due',
      intervalDays: shard.intervalDays,
      lastChecked: previous?.lastChecked || null,
      sourceVersion: previous?.sourceVersion || null
    };
  });
  let changed = false;
  const changedCountries = new Set();
  const importedIds = new Map();
  const plannedRawArtifacts = new Set();
  const disabledCountries = new Set();
  const syncErrors = [];
  const failureReport = (task, error) => {
    const errorCode = error?.code || (estimate ? 'SOURCE_ESTIMATE_FAILED' : 'SYNC_FAILED');
    const qualityFailure = errorCode === 'SOURCE_QUALITY_FAILED' || errorCode === 'SNAPSHOT_QUALITY_FAILED';
    const partial = error?.sourceComplete === false;
    return {
      ...task.previous,
      shardId: task.shard.id,
      shardKey: task.shard.id,
      sourceId: task.shard.source.id,
      countryCode: task.shard.countryCode,
      intervalDays: task.shard.intervalDays,
      lastChecked: checkedAt.toISOString(),
      sourceVersion: task.discovery?.version || task.previous?.sourceVersion || null,
      sourceBytes: task.discovery?.sourceBytes ?? task.previous?.sourceBytes ?? null,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
      errorCode,
      failureSignature: qualityFailure
        ? error?.failureSignature || task.discovery?.failureSignature || null
        : null,
      rejectionReasons: qualityFailure
        ? error?.rejectionReasons || error?.metrics?.rejectionReasons || task.previous?.rejectionReasons || {}
        : null,
      metrics: qualityFailure || partial ? error?.metrics || task.previous?.metrics || null : null,
      checkpointStage: partial ? error?.checkpointStage || task.previous?.checkpointStage || null : null,
      nextAttemptAt: partial ? error?.nextAttemptAt || task.previous?.nextAttemptAt || null : null,
      errorUrl: error?.url || null,
      errorStatus: error?.status ?? null,
      sourceComplete: error?.sourceComplete !== false,
      checkpointToken: error?.checkpointToken || task.previous?.checkpointToken || null
    };
  };
  const recordFailure = async (task, error) => {
    checkpoint();
    console.error(`[address-sync] ${task.shard.countryCode} failed`, error);
    const report = failureReport(task, error);
    reports.push(report);
    if (!dryRun && !estimate) {
      state.shards[task.shard.id] = report;
      await stateStore.save({ ...state, updatedAt: checkedAt.toISOString() });
    }
    if (syncMode === 'initial' || syncMode === 'manual') syncErrors.push(error);
    else if (!estimate) {
      const failure = error && (typeof error === 'object' || typeof error === 'function')
        ? error : new Error(String(error));
      failure.selectedShards = selected.map((shard) => shard.id);
      failure.reports = reports;
      throw failure;
    }
  };
  try {
    const work = [];
    for (const shard of selected) {
      checkpoint();
      const previous = state.shards[shard.id];
      if (syncMode === 'daily' && !estimate && !isCountryDue(previous, shard.intervalDays, checkedAt)) {
        reports.push({ shardId: shard.id, shardKey: shard.id, sourceId: shard.source.id, countryCode: shard.countryCode, status: 'not-due', intervalDays: shard.intervalDays, lastChecked: previous.lastChecked, sourceVersion: previous.sourceVersion });
        continue;
      }
      const defaults = providedImporter || providedCatalog ? null : ADDRESS_POLICY_DEFAULTS[shard.countryCode];
      const policy = database && activeRun && !providedImporter
        ? await loadImportPolicy(database, shard.countryCode, maxRecords, perLocality)
        : { enabled: true, targetCount: defaults?.target || maxRecords,
          levelLimits: defaults?.limits || [maxRecords, perLocality, perLocality, perLocality],
          overrides: new Map(), nodeFloors: new Map(), level1Min: defaults?.level1Min || 0,
          level2Min: defaults?.level2Min || 0, minPerNode: defaults?.minPerNode || 0 };
      if (policy.enabled === false) {
        disabledCountries.add(shard.countryCode);
        reports.push({ shardId: shard.id, shardKey: shard.id, sourceId: shard.source.id, countryCode: shard.countryCode,
          status: 'disabled', intervalDays: shard.intervalDays, lastChecked: previous?.lastChecked || null,
          sourceVersion: previous?.sourceVersion || null });
        continue;
      }
      work.push({ shard, previous, policy });
    }

    const discovered = await mapConcurrent(work, runtimePolicy.prepareConcurrency, async (task) => {
      try {
        checkpoint();
        await reportProgress({ phase: 'discover', countryCode: task.shard.countryCode, sourceId: task.shard.id });
        console.log(`[address-sync] ${task.shard.countryCode} discover`);
        const discoveredSource = await adapters.discover(task.shard, { includeAssetSizes: estimate, syncMode, cacheDir, signal });
        checkpoint();
        const discovery = {
          ...discoveredSource,
          failureSignature: sourceQualityFailureSignature(task.shard, discoveredSource, task.policy)
        };
        return { ...task, discovery };
      } catch (error) { return { ...task, error }; }
    });
    const planned = [];
    for (const task of discovered) {
      checkpoint();
      if (task.error) { await recordFailure(task, task.error); continue; }
      if (['SOURCE_QUALITY_FAILED', 'SNAPSHOT_QUALITY_FAILED'].includes(task.previous?.errorCode)
        && task.previous.failureSignature === task.discovery.failureSignature) {
        reports.push({
          ...task.previous,
          shardId: task.shard.id,
          shardKey: task.shard.id,
          sourceId: task.shard.source.id,
          countryCode: task.shard.countryCode,
          sourceVersion: task.discovery.version,
          status: 'source-quality-failed',
          skipped: true
        });
        continue;
      }
      // One run grows by at most a bounded step and an equal per-country share of the remaining
      // headroom, and never shrinks below what the source already published.
      const previousCount = Math.max(0, Number(task.previous?.acceptedCount) || 0);
      const shareRecords = Math.floor(Math.max(0, softLimitBytes - plannedStorageBytes) / (bytesPerRecord * enabledCountries));
      // Popular-city exports and popular regions (shards with a priority) grow faster so their cities fill first.
      const growth = task.shard.priority || task.shard.popularCities ? maxGrowthPerRun * 3 : maxGrowthPerRun;
      const sourceTarget = Math.min(integer(task.shard.maxRecords, maxRecords), Math.max(1, previousCount + Math.min(shareRecords, growth)));
      const estimatedOutputBytes = sourceTarget * 2048;
      const estimatedDatabaseBytes = Math.max(0, sourceTarget - previousCount) * bytesPerRecord;
      const rawKey = `${task.discovery.dataUrl || ''}\u001f${task.discovery.rawVersion || task.discovery.version || ''}`;
      const downloadsGeofabrik = ['geofabrik', 'google-residential-enrichment'].includes(task.discovery.adapter);
      const temporarySourceBytes = downloadsGeofabrik && !plannedRawArtifacts.has(rawKey)
        ? task.discovery.sourceBytes || 0 : 0;
      if (downloadsGeofabrik) plannedRawArtifacts.add(rawKey);
      const projectedCacheBytes = plannedCacheBytes + estimatedOutputBytes + temporarySourceBytes;
      try {
        storageBudget = assertStorageBudget({
          currentBytes: plannedStorageBytes,
          additionalBytes: estimatedOutputBytes + estimatedDatabaseBytes + temporarySourceBytes,
          softLimitBytes,
          hardLimitBytes
        });
      } catch (error) { await recordFailure(task, error); continue; }
      const report = {
        shardId: task.shard.id, shardKey: task.shard.id, sourceId: task.shard.source.id,
        countryCode: task.shard.countryCode, adapter: task.discovery.adapter, intervalDays: task.shard.intervalDays,
        lastChecked: checkedAt.toISOString(), sourceVersion: task.discovery.version, sourceBytes: task.discovery.sourceBytes,
        estimatedPeakBytes: projectedCacheBytes, estimatedStoragePeakBytes: storageBudget.projectedBytes,
        estimatedDatabaseBytes, allowShadowExpansion: storageBudget.allowShadowExpansion,
        estimateMethod: task.discovery.estimateMethod, targetCount: sourceTarget,
        status: dryRun || estimate ? 'planned' : 'discovered'
      };
      plannedCacheBytes += estimatedOutputBytes;
      plannedStorageBytes += estimatedOutputBytes + estimatedDatabaseBytes;
      if (dryRun || estimate) reports.push(report);
      else planned.push({ ...task, report, estimatedOutputBytes, estimatedDatabaseBytes, storageBudget });
    }

    const importPreparedTask = async (task) => {
      checkpoint();
      if (task.error) { await recordFailure(task, task.error); return; }
      if (task.materialized?.sourceComplete === false && !task.materialized.file) {
        Object.assign(task.report, {
          status: 'partial', sourceComplete: false,
          checkpointToken: task.materialized.checkpointToken || null,
          checkpointStage: task.materialized.checkpointStage || null,
          nextAttemptAt: task.materialized.nextAttemptAt || null,
          cacheBytes: task.materialized.cacheBytes || 0,
          cacheHit: task.materialized.cacheHit === true,
          checksumSha256: null,
          sourceChecksumSha256: task.previous?.sourceChecksumSha256 || null,
          acceptedCount: 0,
          rejectedCount: null,
          rejectionReasons: {},
          metrics: {
            ...(task.materialized.metrics || {}),
            checkpointStage: task.materialized.checkpointStage || null,
            nextAttemptAt: task.materialized.nextAttemptAt || null
          },
          lastSuccessfulAt: task.previous?.lastSuccessfulAt || null
        });
        state.shards[task.shard.id] = task.report;
        await stateStore.save({ ...state, updatedAt: checkedAt.toISOString() });
        reports.push(task.report);
        console.log(`[address-sync] ${task.shard.countryCode} checkpoint stage=${task.report.checkpointStage || 'materialize'}`);
        return;
      }
      try {
        const materializedStorageBytes = await measureUsage();
        storageBudget = assertStorageBudget({ currentBytes: materializedStorageBytes, additionalBytes: task.estimatedDatabaseBytes, softLimitBytes, hardLimitBytes });
        await reportProgress({ phase: 'import', countryCode: task.shard.countryCode, sourceId: task.shard.id });
        console.log(`[address-sync] ${task.shard.countryCode} import`);
        const imported = await importer.importShard({
          shard: task.shard, discovery: task.discovery, materialized: task.materialized,
          maxRecords: task.policy.targetCount, sourceMaxRecords: task.report.targetCount, perLocality, policy: task.policy,
          storagePolicy: { allowShadowExpansion: storageBudget.allowShadowExpansion, softLimitBytes, hardLimitBytes },
          signal
        });
        checkpoint();
        const storageBytesAfterImport = await measureUsage();
        storageBudget = assertStorageBudget({ currentBytes: storageBytesAfterImport, softLimitBytes, hardLimitBytes });
        const sourceComplete = task.materialized.sourceComplete !== false;
        Object.assign(task.report, {
          status: sourceComplete ? (imported.skipped ? 'unchanged' : 'imported') : 'partial',
          checksumSha256: task.materialized.checksum,
          sourceChecksumSha256: task.materialized.sourceChecksum || task.previous?.sourceChecksumSha256 || null,
          cacheBytes: task.materialized.cacheBytes, cacheHit: task.materialized.cacheHit, datasetId: imported.datasetId,
          acceptedCount: imported.acceptedCount, rejectedCount: imported.rejectedCount,
          netGrowth: Number(imported.netGrowth || 0), changedCount: Number(imported.changedCount || 0),
          rejectionReasons: imported.rejectionReasons || {}, metrics: {
            ...(imported.metrics || {}),
            ...(task.materialized.metrics || {}),
            checkpointStage: task.materialized.checkpointStage || null,
            nextAttemptAt: task.materialized.nextAttemptAt || null,
            growthCapped: task.report.targetCount < integer(task.shard.maxRecords, maxRecords)
              && imported.acceptedCount >= task.report.targetCount
          },
          localityCount: imported.localityCount || null, residentialCount: imported.residentialCount || 0,
          sourceComplete,
          checkpointToken: task.materialized.checkpointToken || null,
          deficit: Math.max(0, task.report.targetCount - imported.acceptedCount), storageBytesAfterImport,
          allowShadowExpansion: storageBudget.allowShadowExpansion,
          lastSuccessfulAt: sourceComplete ? checkedAt.toISOString() : task.previous?.lastSuccessfulAt || null
        });
        state.shards[task.shard.id] = task.report;
        await stateStore.save({ ...state, updatedAt: checkedAt.toISOString() });
        if (sourceComplete) await pruneShardCache(cacheDir, task.shard, task.materialized.cacheFile || task.materialized.file);
        if (task.materialized.cacheFile) await rm(task.materialized.file, { force: true });
        plannedCacheBytes = await directorySize(cacheDir);
        plannedStorageBytes = await measureUsage();
        changed ||= !imported.skipped;
        if (!imported.skipped) {
          changedCountries.add(task.shard.countryCode);
          importedIds.set(task.shard.countryCode, [...importedIds.get(task.shard.countryCode) || [], ...imported.addressIds || []]);
        }
        reports.push(task.report);
        console.log(`[address-sync] ${task.shard.countryCode} ready addresses=${imported.acceptedCount} target=${task.report.targetCount} deficit=${task.report.deficit}`);
      } catch (error) { await recordFailure(task, error); }
    };

    for (let offset = 0; offset < planned.length; offset += runtimePolicy.prepareConcurrency) {
      checkpoint();
      const wave = planned.slice(offset, offset + runtimePolicy.prepareConcurrency);
      const waveRaw = new Map();
      for (const task of wave) {
        if (['geofabrik', 'google-residential-enrichment'].includes(task.discovery.adapter)) {
          waveRaw.set(`${task.discovery.dataUrl}\u001f${task.discovery.rawVersion || task.discovery.version}`,
            Number(task.discovery.sourceBytes || 0));
        }
      }
      const currentStorage = await measureUsage();
      try {
        assertStorageBudget({
          currentBytes: currentStorage,
          additionalBytes: [...waveRaw.values()].reduce((total, value) => total + value, 0)
            + wave.reduce((total, task) => total + task.estimatedOutputBytes + task.estimatedDatabaseBytes, 0),
          softLimitBytes,
          hardLimitBytes
        });
      } catch (error) {
        for (const task of wave) await recordFailure(task, error);
        continue;
      }
      const preparedWave = await mapConcurrent(wave, runtimePolicy.prepareConcurrency, async (task) => {
        try {
          checkpoint();
          await reportProgress({ phase: 'materialize', countryCode: task.shard.countryCode, sourceId: task.shard.id });
          console.log(`[address-sync] ${task.shard.countryCode} materialize`);
          const shardTarget = task.report.targetCount;
          const candidateLimit = Math.min(maxCandidates, Math.max(shardTarget + 1_000, shardTarget * 3));
          const candidatePerLocality = task.policy.levelLimits[1] === 0
            ? candidateLimit : Math.max(perLocality, ...task.policy.levelLimits);
          const localityWeights = database && activeRun && task.shard.source?.adapter === 'overture'
            ? await countryLocalityWeights(task.shard.countryCode) : undefined;
          const materialized = await adapters.materialize(task.shard, task.discovery, {
            cacheDir, maxBytes: Math.max(1, hardLimitBytes - currentStorage),
            maxRecords: candidateLimit, perLocality: candidatePerLocality, retainRaw, sharedRaw: wave.length > 1,
            localityWeights, signal
          });
          checkpoint();
          return { ...task, materialized };
        } catch (error) { return { ...task, error }; }
      });
      await adapters.cleanupSharedRaw?.();
      for (const task of preparedWave) await importPreparedTask(task);
    }
    if (database && activeRun && !providedImporter) {
      for (const countryCode of changedCountries) {
        checkpoint();
        await reportProgress({ phase: 'postcode', countryCode });
        const postcodes = await runPostcodeInference({ database, countryCode, cacheDir, pythonBin: environment.PYTHON_BIN, signal,
          addressIds: importedIds.get(countryCode) || [] })
          .catch((error) => { if (signal?.aborted) throw error; console.error(`[address-sync] ${countryCode} postcode inference failed`, error?.message || error); return null; });
        if (postcodes?.checked) console.log(JSON.stringify({ event: 'postcode_inference', ...postcodes }));
        // Every row the import wrote is judged against the region polygons and city gate, not only rows whose postcode
        // inference filled: an import can publish a point off the coastline or without its region.
        const judged = [...new Set([...importedIds.get(countryCode) || [], ...postcodes?.filledIds || []])];
        if (judged.length) {
          const { repairAdministrativeNames } = await import('./administrative-names-repair.mjs');
          const names = await repairAdministrativeNames({ database, countryCode, cacheDir, pythonBin: environment.PYTHON_BIN || 'python3',
            addressIds: judged, pauseMs: 0 })
            .catch((error) => { if (signal?.aborted) throw error; console.error(`[address-sync] ${countryCode} administrative names check failed`, error?.message || error); return null; });
          if (names?.changed || names?.retired || names?.duplicates) console.log(JSON.stringify({ event: 'administrative_names_repair', scoped: true, ...names }));
        }
        // Only this inference could still fill a missing postcode; rows it could not are retired unpublished.
        if (postcodes) {
          const retired = await retirePostcodeLessRows({ database, countryCode, addressIds: importedIds.get(countryCode) || [] });
          if (retired.retired) console.log(JSON.stringify({ event: 'postcode_required', ...retired }));
        }
        // A house number or unit the reader cannot write in Latin script is never shown, so it is not published.
        const premises = await retireUnlatinizablePremises({ database, countryCode, addressIds: importedIds.get(countryCode) || [] })
          .catch((error) => { if (signal?.aborted) throw error; console.error(`[address-sync] ${countryCode} English premise check failed`, error?.message || error); return null; });
        if (premises?.retired) console.log(JSON.stringify({ event: 'english_premise', ...premises }));
        await reportProgress({ phase: 'coverage', countryCode });
        // The import is committed by now; coverage is derived and refreshed again by the background coverage pass,
        // so a lock timeout here must not turn a successful import into a failed run.
        const coverage = await refreshResidentialCoverage(database, countryCode, checkedAt.toISOString(), signal,
          { useGenerationIndex: true })
          .catch((error) => {
            if (signal?.aborted) throw error;
            console.error(`[address-sync] ${countryCode} coverage refresh deferred`, error?.code || error?.message || error);
            staleCoverage.add(countryCode);
            return null;
          });
        if (coverage) console.log(`[address-sync] ${countryCode} coverage mapped=${coverage.matchedAddresses} unmatched=${coverage.unmatchedAddresses}`);
      }
    }
    if (syncErrors.length) {
      const error = new AggregateError(syncErrors, `Address sync failed for ${syncErrors.length} country shard(s)`);
      error.selectedShards = selected.map((shard) => shard.id);
      error.reports = reports;
      throw error;
    }
    if (syncMode === 'initial' && requireResidential) {
      const missingResidential = requested.filter((shard) => !disabledCountries.has(shard.countryCode)
        && Number(state.shards[shard.id]?.residentialCount || 0) < 1);
      if (missingResidential.length) {
        throw new Error(`Initial residential sync incomplete for: ${missingResidential.map(({ countryCode }) => countryCode).join(', ')}`);
      }
    }
  } finally {
    await adapters.cleanupSharedRaw?.().catch(() => {});
    if (!providedImporter) await importer?.close();
  }
  return {
    changed,
    dryRun: dryRun || estimate,
    syncMode,
    softLimitBytes,
    hardLimitBytes,
    cacheBytesBefore,
    storageBytesBefore,
    storageBudget,
    requiredCountries: [...new Set(catalog.shards.map((shard) => shard.countryCode))].sort(),
    selectedShards: selected.map((shard) => shard.id),
    releaseTargets: reports.filter((report) => report.status === 'imported').map((report) => ({
      shardKey: report.shardKey,
      sourceId: report.sourceId,
      countryCode: report.countryCode,
      datasetId: report.datasetId
    })),
    reports
  };
};

const parseArguments = (arguments_) => {
  const options = { requestedShards: [] };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--dry-run') options.dryRun = true;
    else if (argument === '--estimate') options.estimate = true;
    else if (argument === '--force') options.force = true;
    else if (argument === '--initial') options.syncMode = 'initial';
    else if (argument === '--daily') options.syncMode = 'daily';
    else if (argument === '--manual') options.syncMode = 'manual';
    else if (argument === '--all') options.requestedShards.push('all');
    else if (argument === '--shard') options.requestedShards.push(arguments_[index += 1]);
    else if (argument === '--cache-dir') options.cacheDir = resolve(arguments_[index += 1]);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.requestedShards.length) options.requestedShards.push('all');
  return options;
};

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const result = await runAddressEtl(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
