import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { Converter as createTraditionalizer } from 'opencc-js/cn2t';
import { validateAddressContract } from '../src/domain/address-contracts.mjs';
import { validateAddressQuality, streetAddressKey } from '../src/domain/address-quality.mjs';
import { postcodePatterns } from '../src/domain/postcode-patterns.mjs';
import { parsePhoneNumberFromString } from 'libphonenumber-js/mobile';
import { englishNativeCountries } from '../server/database/catalog-native-names.mjs';

const base = process.env.API_BASE_URL || 'https://address.333186.xyz/api/v1';
const token = process.env.API_TOKEN || '';
const samples = Math.max(500, Number.parseInt(process.env.SAMPLES_PER_COUNTRY || '500', 10) || 500);
const concurrency = Math.max(1, Math.min(24, Number.parseInt(process.env.AUDIT_CONCURRENCY || '1', 10) || 1));
const headers = token ? { Authorization: `Bearer ${token}` } : {};
headers['Content-Type'] = 'application/json';
const codes = (process.env.AUDIT_COUNTRIES || 'US,CA,MX,GB,DE,FR,IT,ES,NL,RU,JP,HK,SG,TW,KR,MY,CN,TH,PH,VN,TR,SA,IN,AU,BR,NG,ZA').split(',').map((value) => value.trim().toUpperCase()).filter(Boolean);
const nativePatterns = { CN: /\p{Script=Han}/u, HK: /\p{Script=Han}/u, TW: /\p{Script=Han}/u, JP: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u, KR: /\p{Script=Hangul}/u, TH: /\p{Script=Thai}/u, SA: /\p{Script=Arabic}/u, RU: /\p{Script=Cyrillic}/u };
const latin = /\p{Script=Latin}/u;
const forbiddenNativeLatin = new Set(['HK', 'TW', 'JP', 'KR', 'TH', 'SA', 'RU', 'CN']);
const adminCodes = new Set(['US', 'CA', 'MX', 'IT', 'AU', 'BR']);
const minimumUniqueRatio = Math.max(0, Math.min(1, Number(process.env.MIN_UNIQUE_RATIO || '0.9')));
const hongKongTraditional = createTraditionalizer({ from: 'cn', to: 'hk' });
// 涌 (chung, stream) is the official Hong Kong place-name character, e.g. 葵涌 and 蠔涌; OpenCC rewrites it to 湧.
// Official Hong Kong names keep 涌 (e.g. 鰂魚涌) and 咸 (e.g. 般咸道, 雲咸街); OpenCC would rewrite them.
const hongKongOfficialCharacters = new Set(['涌', '咸']);
const keepHongKongChung = (value) => Array.from(hongKongTraditional(value))
  .map((character, index) => hongKongOfficialCharacters.has(Array.from(value)[index]) ? Array.from(value)[index] : character).join('');
const toTraditional = {
  HK: keepHongKongChung,
  TW: createTraditionalizer({ from: 'cn', to: 'tw' })
};
// Script checks apply to human-readable address text only; codes and numeric fields
// are validated separately and may legitimately use Latin characters.
const semanticFields = ['buildingName', 'street', 'locality', 'postalLocality', 'dependentLocality', 'district', 'admin1'];
const nativeCoreFields = ['street', 'locality', 'postalLocality', 'dependentLocality', 'district', 'admin1'];
const foreignEnglishScript = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Arabic}\p{Script=Cyrillic}]/u;
const foreignChineseScript = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Arabic}\p{Script=Cyrillic}]/u;
const semanticValues = (components = {}) => semanticFields.map((field) => components[field]).filter((value) => typeof value === 'string' && value.trim());
const nativeCoreValues = (components = {}) => nativeCoreFields.map((field) => components[field]).filter((value) => typeof value === 'string' && value.trim() && /\p{L}/u.test(value));
const hasNonIdentifierLatin = (value) => /\p{Script=Latin}/u.test(String(value)
  .replace(/[A-Za-z]+\d[A-Za-z\d/-]*/gu, '')
  .replace(/\d+[A-Za-z][A-Za-z\d/-]*/gu, '')
  .replace(/[A-Za-z]+(?=(?:区|座|栋|棟|幢|单元|室|号|號|楼|组团|期))/gu, ''));
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const registryResponse = await fetch(`${base}/countries`, { headers, signal: AbortSignal.timeout(30_000) });
const registryPayload = await registryResponse.json();
if (!registryResponse.ok) throw new Error(`/countries: ${registryPayload.error?.code || registryResponse.status}`);
const eligibleCounts = new Map((registryPayload.data || []).filter((country) => country.generationMode === 'synchronized-pool'
  && Number(country.addressCount) > 0)
  .map((country) => [country.code, Number(country.addressCount)]));
const fetchBatch = async (code, batch, count, region = '') => {
  let lastError;
  // A busy generator answers 429 while sync or a pool audit loads the database; the audit waits rather than failing.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const response = await fetch(`${base}/generate/batch`, {
        method: 'POST', headers, signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({ count, filters: { country: code, ...(region ? { region } : {}) },
          options: { unique: false, seed: `contract-audit-${code}-${region || 'all'}-${batch}` } })
      });
      const payload = await response.json();
      if (response.ok || (response.status < 500 && response.status !== 429)) return { response, payload };
      lastError = new Error(`http_${response.status}`);
      const retryAfter = Number.parseInt(response.headers.get('Retry-After') || '', 10);
      if (response.status === 429 && Number.isFinite(retryAfter)) {
        await wait(Math.min(60, Math.max(retryAfter, 2 ** Math.min(attempt, 5))) * 1000);
        continue;
      }
    } catch (error) {
      lastError = error;
    }
    await wait(Math.min(60_000, 500 * 2 ** attempt));
  }
  throw lastError;
};

// First-level regions with their catalog names, used to sample every region and to check region codes and names.
const fold = (value) => String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('und').replace(/[^\p{L}\p{N}]+/gu, '');
const regionCatalog = async (code) => {
  const regions = [];
  for (let cursor = ''; ;) {
    const query = new URLSearchParams({ country: code, childType: 'region', limit: '100', ...(cursor ? { cursor } : {}) });
    const response = await fetch(`${base}/locations/hierarchy?${query}`, { headers, signal: AbortSignal.timeout(60_000) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) return regions;
    regions.push(...(payload.data?.children || []));
    cursor = payload.data?.nextCursor || '';
    if (!cursor) return regions;
  }
};
const regionIndex = (regions) => {
  const byName = new Map();
  for (const region of regions) {
    for (const name of new Set([region.native, region.en, region.value, region.regionCode].map(fold).filter(Boolean))) {
      byName.set(name, byName.has(name) ? null : region);
    }
  }
  return (admin1) => byName.get(fold(admin1)) || null;
};
// Italian admin1Code is the province sigla below the named region; US territories are outside the state catalog.
const provinceCodeCountries = new Set(['IT']);
const usTerritoryCodes = new Set(['PR', 'VI', 'GU', 'AS', 'MP']);
const regionIssues = (code, address, regionFor) => {
  const issues = [];
  const native = address.componentVariants?.native || {};
  const zh = address.componentVariants?.['zh-CN'] || {};
  const admin1 = String(native.admin1 || '').trim();
  if (!admin1 || !regionFor) return issues;
  const region = regionFor(admin1);
  if (!region) {
    // The API lists first-level regions only; an Italian province is checked by its sigla here and against the full
    // catalog by the pool audit.
    const province = provinceCodeCountries.has(code) && /^[A-Z]{2}$/u.test(String(native.admin1Code || ''));
    if (adminCodes.has(code) && !province && !(code === 'US' && usTerritoryCodes.has(admin1.toUpperCase()))) issues.push('region_outside_catalog');
    return issues;
  }
  if (adminCodes.has(code) && !provinceCodeCountries.has(code) && region.regionCode
    && String(native.admin1Code || '').toUpperCase() !== String(region.regionCode).toUpperCase()) issues.push('region_code_conflict');
  if (/\p{Script=Han}/u.test(region.zhCN || '') && zh.admin1 !== region.zhCN) issues.push('zh_region_mismatch');
  return issues;
};
// English-first publication: untranslated Chinese names are reported but do not fail the audit while the translation
// queue catches up; foreign scripts in the Chinese variant still fail.
const warningIssues = new Set(['zh_place_untranslated', 'zh_missing_han']);
const placeWarnings = (address) => {
  const zh = address.componentVariants?.['zh-CN'] || {};
  return ['admin1', 'locality'].some((field) => zh[field] && /\p{L}/u.test(zh[field]) && !/\p{Script=Han}/u.test(zh[field]))
    ? ['zh_place_untranslated'] : [];
};

const issueFor = (code, address) => {
  const issues = [];
  const components = address.components || {};
  const nativeVariant = address.componentVariants?.native || {};
  const en = address.addressVariants?.en || '';
  const zh = address.addressVariants?.['zh-CN'] || '';
  const nativeComponents = nativeCoreValues(nativeVariant);
  const englishComponents = semanticValues(address.componentVariants?.en);
  // English-language countries write the same region and city in both variants; a difference is a bad catalog native.
  const englishVariant = address.componentVariants?.en || {};
  // Malaysian states keep their Malay official names (Pulau Pinang / Penang).
  if (englishNativeCountries.has(code) && (code === 'MY' ? ['locality'] : ['admin1', 'locality']).some((field) => nativeVariant[field]
    && englishVariant[field] && nativeVariant[field] !== englishVariant[field])) issues.push('native_english_mismatch');
  const chineseComponents = semanticValues(address.componentVariants?.['zh-CN']);
  const matchLevel = address.matchLevel;
  const streetLevel = matchLevel === 'street' && code !== 'CN';
  if (address.countryCode !== code) issues.push('country_mismatch');
  if (address.addressStatus !== 'verified') issues.push('not_verified');
  const chinaCommunity = code === 'CN' && String(components.buildingName || '').trim();
  if (!streetLevel && !String(components.houseNumber || '').trim() && !chinaCommunity) issues.push('missing_house_number');
  if (!String(components.street || '').trim() && !chinaCommunity) issues.push('missing_street');
  for (const reason of validateAddressContract(code, nativeVariant, { strict: true, matchLevel }).reasons) issues.push(`contract_${reason}`);
  for (const reason of validateAddressQuality({ countryCode: code, matchLevel, components: nativeVariant,
    latitude: address.coordinates?.latitude, longitude: address.coordinates?.longitude }).reasons) issues.push(`quality_${reason}`);
  const postcode = String(components.postcode || '').trim();
  if (postcodePatterns[code] && (code === 'CN' || postcode) && !postcodePatterns[code].test(postcode)) issues.push('invalid_postcode');
  const latitude = Number(address.coordinates?.latitude);
  const longitude = Number(address.coordinates?.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)
    || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) issues.push('invalid_coordinates');
  const evidenceTypes = new Set((address.evidence || []).map((entry) => entry.type));
  if (!evidenceTypes.has('address_existence')) issues.push('missing_address_evidence');
  if (!evidenceTypes.has('coordinate')) issues.push('missing_coordinate_evidence');
  if ((code === 'CN' || ['residential', 'apartment'].includes(address.propertyType))
    && !evidenceTypes.has('residential_use')) issues.push('missing_residential_evidence');
  if (streetLevel && (address.propertyType !== 'unknown' || evidenceTypes.has('residential_use'))) issues.push('street_residential_claim');
  if (!address.addressVariants?.native || !en || !zh) issues.push('missing_language_variant');
  if (nativePatterns[code] && (!nativeComponents.length || nativeComponents.some((value) => !nativePatterns[code].test(value)))) issues.push('native_script');
  if (forbiddenNativeLatin.has(code) && nativeComponents.some(hasNonIdentifierLatin)) issues.push('native_latin_mixed');
  // OpenCC turns 里 into 裏, but 里 is the official character of lane names (天樂里, Tin Lok Lane).
  const lane = (value) => value.replace(/裏/gu, '里');
  if (toTraditional[code] && nativeComponents.some((value) => lane(toTraditional[code](value)) !== lane(value))) issues.push('native_not_traditional');
  if (!latin.test(en)) issues.push('english_missing_latin');
  if (englishComponents.some((value) => foreignEnglishScript.test(value))) issues.push('english_source_script');
  // Every English field, house numbers and units included, and the rendered English lines must read in Latin script.
  const englishFields = Object.entries(address.componentVariants?.en || {}).filter(([, value]) => typeof value === 'string');
  if (englishFields.some(([field, value]) => !semanticFields.includes(field) && foreignEnglishScript.test(value))) issues.push('english_field_script');
  if (foreignEnglishScript.test(en)) issues.push('english_line_script');
  const zhFields = Object.values(address.componentVariants?.['zh-CN'] || {}).filter((value) => typeof value === 'string');
  if (zhFields.some((value) => foreignChineseScript.test(value)) && !chineseComponents.some((value) => foreignChineseScript.test(value))) issues.push('zh_field_script');
  if (!/\p{Script=Han}/u.test(zh) || !chineseComponents.some((value) => /\p{Script=Han}/u.test(value))) issues.push('zh_missing_han');
  if (chineseComponents.some((value) => foreignChineseScript.test(value))) issues.push('zh_source_script');
  if (adminCodes.has(code) && !components.admin1Code) issues.push('missing_admin_code');
  return issues;
};

const result = {};
for (const code of codes) {
  const eligibleCount = eligibleCounts.get(code);
  if (!eligibleCount) { result[code] = { skipped: true, reason: 'no published pool' }; continue; }
  const regions = (await regionCatalog(code)).filter((region) => Number(region.availableCount) > 0 && !region.disabled);
  const regionFor = regions.length ? regionIndex(regions) : null;
  // Every region is sampled first so small regions and territories are seen; the random part fills the rest.
  const perRegion = Math.max(2, Math.min(10, Math.floor(samples / 2 / Math.max(1, regions.length))));
  const tasks = [
    ...regions.map((region, index) => ({ batch: index, count: perRegion, region: region.value, stratified: true })),
    ...Array.from({ length: Math.ceil(samples / 50) }, (_, batch) => ({ batch, count: Math.min(50, samples - batch * 50), region: '', stratified: false }))
  ];
  const rows = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (cursor < tasks.length) {
      const task = tasks[cursor++];
      await wait(750);
      const { response, payload } = await fetchBatch(code, task.batch, task.count, task.region);
      const bundles = payload.data?.results || [];
      if (!response.ok || !bundles.length || (!task.stratified && bundles.length !== task.count)) {
        for (let index = 0; index < task.count; index += 1) rows.push({ stratified: task.stratified, issues: [payload.error?.code || `http_${response.status}`] });
        continue;
      }
      for (const bundle of bundles) {
        const { address, profile } = bundle;
        const issues = [...issueFor(code, address), ...regionIssues(code, address, regionFor), ...placeWarnings(address)];
        if (foreignEnglishScript.test(bundle.addressFormats?.en?.singleLine || '')) issues.push('english_presentation_script');
        // Japanese, Thai and Arabic recipient names have no reliable romanization and stay as generated.
        const englishLines = bundle.addressFormats?.en?.postalLines || [];
        if (englishLines.slice(['JP', 'TH', 'SA'].includes(code) ? 1 : 0).some((line) => foreignEnglishScript.test(line))) {
          issues.push('english_recipient_script');
        }
        const phone = parsePhoneNumberFromString(String(profile?.phone || ''));
        if (!phone?.isValid() || phone.country !== code) issues.push('invalid_mobile_number');
        if (code === 'GB' && /^7700900\d{3}$/u.test(phone?.nationalNumber || '')) issues.push('reserved_mobile_number');
        rows.push({
          stratified: task.stratified,
          id: createHash('sha256').update(address.matchLevel === 'street'
            ? streetAddressKey(code, address.components) : String(address.id)).digest('hex'),
          matchLevel: address.matchLevel, admin1: address.components?.admin1 || '', locality: address.components?.locality || '',
          phone: phone?.number, issues
        });
      }
    }
  });
  await Promise.all(workers);
  const issueCounts = {};
  const warningCounts = {};
  const issueExamples = {};
  for (const row of rows) for (const issue of row.issues) {
    const counts = warningIssues.has(issue) ? warningCounts : issueCounts;
    counts[issue] = (counts[issue] || 0) + 1;
    const examples = issueExamples[issue] ||= [];
    if (row.id && examples.length < 3) examples.push(row.id);
  }
  // Uniqueness is measured on the uniform random part only; stratified draws from small regions repeat by design.
  const random = rows.filter((row) => !row.stratified);
  const uniqueAddresses = new Set(random.map(({ id }) => id).filter(Boolean)).size;
  const expectedUniqueAddresses = eligibleCount * (1 - ((eligibleCount - 1) / eligibleCount) ** samples);
  const minimumUniqueAddresses = Math.max(1, Math.floor(expectedUniqueAddresses * minimumUniqueRatio));
  if (uniqueAddresses < minimumUniqueAddresses) issueCounts.low_unique_ratio = minimumUniqueAddresses - uniqueAddresses;
  const uniquePhones = new Set(rows.map(({ phone }) => phone).filter(Boolean)).size;
  if (uniquePhones < rows.length * 0.99) issueCounts.low_phone_unique_ratio = rows.length - uniquePhones;
  result[code] = {
    requested: samples,
    returned: rows.length,
    regionsSampled: regions.length,
    stratifiedSamples: rows.length - random.length,
    eligibleCount,
    uniqueAddresses,
    uniquePhones,
    matchLevels: Object.fromEntries(['street', 'premise', 'subpremise'].map((level) =>
      [level, rows.filter((row) => row.matchLevel === level).length])),
    samplingWithReplacement: eligibleCount < samples,
    expectedUniqueAddresses: Number(expectedUniqueAddresses.toFixed(1)),
    minimumUniqueAddresses,
    admin1Covered: new Set(rows.map(({ admin1 }) => admin1).filter(Boolean)).size,
    localitiesCovered: new Set(rows.map(({ locality }) => locality).filter(Boolean)).size,
    issueCounts,
    ...(Object.keys(warningCounts).length ? { warningCounts } : {}),
    ...(Object.keys(issueExamples).length ? { issueExamples } : {})
  };
  process.stdout.write(`${code} ${JSON.stringify(result[code])}\n`);
}
const output = { auditedAt: new Date().toISOString(), base, samplesPerCountry: samples, result };
const outputPath = process.env.AUDIT_OUTPUT || 'runtime/address-contract-audit.json';
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(output, null, 2));
if (Object.values(result).some((value) => value.issueCounts && Object.keys(value.issueCounts).length)) process.exitCode = 1;
