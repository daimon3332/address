const base = process.env.API_BASE_URL || 'http://127.0.0.1:8787/api/v1';
const supportedCountries = [
  'US', 'CA', 'MX', 'GB', 'DE', 'FR', 'IT', 'ES', 'NL', 'RU',
  'CN', 'HK', 'TW', 'JP', 'KR', 'SG', 'VN', 'TH', 'PH', 'MY',
  'IN', 'AU', 'TR', 'SA', 'BR', 'NG', 'ZA'
];
const requestTimeoutMs = Number.parseInt(process.env.LIVE_REQUEST_TIMEOUT_MS || '15000', 10);
const maxOrdinaryMs = Number.parseInt(process.env.MAX_ORDINARY_GENERATION_MS || '5000', 10);
const maxResidentialMs = Number.parseInt(process.env.MAX_RESIDENTIAL_GENERATION_MS || '5000', 10);
const maxRttP95Ms = Number.parseInt(process.env.MAX_GENERATION_RTT_P95_MS || '5000', 10);
const maxServerP95Ms = Number.parseInt(process.env.MAX_GENERATION_SERVER_P95_MS || '100', 10);
const includeResidential = process.env.INCLUDE_RESIDENTIAL !== 'false';
const registryStarted = Date.now();
const registryResponse = await fetch(`${base}/countries`);
const registry = await registryResponse.json();
if (!registryResponse.ok) throw new Error(`/countries: ${registry.error?.code || registryResponse.status}`);
const registryLatencyMs = Date.now() - registryStarted;
const registryCountries = Array.isArray(registry.data) ? registry.data : [];
const registryByCode = new Map(registryCountries.map((country) => [country.code, country]));
const registryErrors = [];
if (registryCountries.length !== supportedCountries.length) registryErrors.push(`registry exposes ${registryCountries.length}/27 countries`);
for (const country of supportedCountries) {
  const entry = registryByCode.get(country);
  if (!entry) {
    registryErrors.push(`${country} is missing from the registry`);
    continue;
  }
  if (!(Number(entry.addressCount) > 0)) registryErrors.push(`${country} has no ordinary address data`);
  if (includeResidential && (!(Number(entry.residentialCount) > 0) || entry.residentialAvailable !== true)) registryErrors.push(`${country} has no residential address data`);
  if (entry.generationMode !== 'synchronized-pool') registryErrors.push(`${country} is not using the synchronized pool`);
}
const allCountries = supportedCountries;
const residentialCountries = supportedCountries;
const sampleCount = Math.max(1, Number.parseInt(process.env.SAMPLES_PER_COUNTRY || '3', 10) || 3);
const samples = Array.from({ length: sampleCount }, (_, index) => index + 1);
const jobs = [
  ...allCountries.flatMap((country) => samples.map((index) => ({ country, index, residential: false }))),
  ...(includeResidential ? residentialCountries.flatMap((country) => samples.map((index) => ({ country, index, residential: true }))) : [])
];
const results = [];
let cursor = 0;

const serverTimings = (header) => Object.fromEntries(
  String(header || '').split(',').map((entry) => {
    const match = entry.trim().match(/^([^;]+);dur=([0-9.]+)$/u);
    return match ? [match[1], Number(match[2])] : [];
  }).filter((entry) => entry.length === 2)
);

const assertBundle = (job, payload, timingHeader) => {
  const result = payload.data?.result;
  if (!result) throw new Error(payload.error?.code || 'missing result');
  const sourcesTried = payload.data?.sourcesTried;
  if (!Array.isArray(sourcesTried) || !sourcesTried.includes('address-pool-v2')) throw new Error('generation did not use address-pool-v2');
  if (sourcesTried.includes('osm-overpass')) throw new Error('pool generation entered the online provider path');
  const address = result.address;
  const expectedStatus = !job.residential && job.country === 'CN' ? ['verified', 'synthetic'] : ['verified'];
  if (address.countryCode !== job.country || !expectedStatus.includes(address.addressStatus)) throw new Error('country or status mismatch');
  if (!Number.isFinite(address.coordinates.latitude) || !Number.isFinite(address.coordinates.longitude)) throw new Error('invalid coordinates');
  if (!address.evidence.some((evidence) => evidence.type === 'address_existence') || !address.evidence.some((evidence) => evidence.type === 'coordinate')) throw new Error('missing evidence');
  if (job.residential && !address.evidence.some((evidence) => evidence.type === 'residential_use')) throw new Error('missing residential evidence');
  if (!address.addressVariants.native || !address.addressVariants.en || !address.addressVariants['zh-CN']) throw new Error('missing language variant');
  if (!result.addressFormats.native.singleLine || !result.addressFormats.en.singleLine || !result.addressFormats['zh-CN'].singleLine) throw new Error('missing country format');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result.profile.dateOfBirth)) throw new Error('invalid birth date');
  const birthDate = new Date(`${result.profile.dateOfBirth}T00:00:00.000Z`);
  if (!Number.isFinite(birthDate.getTime()) || result.extensions?.basic?.age < 18 || result.extensions?.basic?.age > 74) throw new Error('invalid age range');
  if (!['male', 'female'].includes(result.profile.gender)) throw new Error('invalid gender');
  if (!/^[a-z0-9]+@outlook\.com$/.test(result.profile.email)) throw new Error('invalid email');
  if (/\+\d+\s+0{3}/.test(result.profile.phone)) throw new Error('invalid phone');
  if (!result.card.number || !result.card.expiry || !result.card.cvc) throw new Error('invalid card');
  const coordinates = `${address.coordinates.latitude},${address.coordinates.longitude}`;
  const openMap = new URL(result.googleMaps.openUrl);
  const embedMap = new URL(result.googleMaps.embedUrl);
  if (openMap.searchParams.get('query') !== coordinates) throw new Error('Google Maps open coordinates do not match the address');
  if (embedMap.searchParams.get('q') !== coordinates) throw new Error('Google Maps embed coordinates do not match the address');
  const coordinateEvidence = address.evidence.find((evidence) => evidence.type === 'coordinate');
  if (coordinateEvidence?.value !== coordinates) throw new Error('source coordinate evidence does not match the address');
  if (job.country === 'CN' && !/[\u3400-\u9fff]/.test(address.addressVariants.native)) throw new Error('China Original is not Chinese');
  if (job.country === 'JP' && !/[\u3040-\u30ff\u3400-\u9fff]/.test(address.addressVariants.native)) throw new Error('Japan Original is not Japanese');
  if (job.country === 'KR' && !/[\uac00-\ud7af]/.test(address.addressVariants.native)) throw new Error('Korea Original is not Korean');
  const timing = serverTimings(timingHeader);
  if (!Number.isFinite(timing.total)) throw new Error('missing Server-Timing total duration');
  return {
    addressId: address.id,
    source: address.evidence[0]?.sourceName,
    area: address.components.admin1 || address.components.locality || `${address.coordinates.latitude.toFixed(1)},${address.coordinates.longitude.toFixed(1)}`,
    serverMs: timing.total,
    poolMs: timing.pool ?? null
  };
};

const execute = async (job) => {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
      try {
        const query = new URLSearchParams({ country: job.country, residential: String(job.residential), seed: `validation-${job.residential ? 'res' : 'normal'}-${job.country}-${job.index}-${attempt}` });
        const response = await fetch(`${base}/generate?${query}`, { signal: controller.signal });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error?.code || String(response.status));
        return assertBundle(job, payload, response.headers.get('Server-Timing'));
      } finally {
        clearTimeout(timer);
      }
    } catch (error) { lastError = error; }
  }
  throw lastError;
};

async function runner() {
  while (cursor < jobs.length) {
    const job = jobs[cursor++];
    const started = Date.now();
    try {
      const data = await execute(job);
      const ms = Date.now() - started;
      const maximum = job.residential ? maxResidentialMs : maxOrdinaryMs;
      results.push(ms <= maximum
        ? { ...job, ok: true, ms, ...data }
        : { ...job, ok: false, ms, ...data, error: `latency ${ms}ms exceeds ${maximum}ms` });
    } catch (error) {
      results.push({ ...job, ok: false, ms: Date.now() - started, error: error instanceof Error ? error.message : String(error) });
    }
  }
}

await Promise.all(Array.from({ length: 5 }, runner));
const failed = results.filter((result) => !result.ok);
const percentile = (values, ratio) => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)] : null;
};
const ordinaryP95Ms = percentile(results.filter((result) => result.ok && !result.residential).map((result) => result.ms), 0.95);
const residentialP95Ms = percentile(results.filter((result) => result.ok && result.residential).map((result) => result.ms), 0.95);
const ordinaryServerP95Ms = percentile(results.filter((result) => result.ok && !result.residential).map((result) => result.serverMs), 0.95);
const residentialServerP95Ms = percentile(results.filter((result) => result.ok && result.residential).map((result) => result.serverMs), 0.95);
const latencyErrors = [
  ...(ordinaryP95Ms !== null && ordinaryP95Ms > maxRttP95Ms ? [`ordinary RTT p95 ${ordinaryP95Ms}ms exceeds ${maxRttP95Ms}ms`] : []),
  ...(includeResidential && residentialP95Ms !== null && residentialP95Ms > maxRttP95Ms ? [`residential RTT p95 ${residentialP95Ms}ms exceeds ${maxRttP95Ms}ms`] : []),
  ...(ordinaryServerP95Ms !== null && ordinaryServerP95Ms > maxServerP95Ms ? [`ordinary server p95 ${ordinaryServerP95Ms}ms exceeds ${maxServerP95Ms}ms`] : []),
  ...(includeResidential && residentialServerP95Ms !== null && residentialServerP95Ms > maxServerP95Ms ? [`residential server p95 ${residentialServerP95Ms}ms exceeds ${maxServerP95Ms}ms`] : [])
];
const countryStats = (residential) => Object.fromEntries(
  [...new Set(results.filter((result) => result.residential === residential).map((result) => result.country))].sort().map((country) => {
    const samples = results.filter((result) => result.country === country && result.residential === residential && result.ok);
    const latencies = samples.map(({ ms }) => ms).sort((left, right) => left - right);
    const serverLatencies = samples.map(({ serverMs }) => serverMs).sort((left, right) => left - right);
    return [country, {
      passed: samples.length,
      distinctAreas: new Set(samples.map(({ area }) => area)).size,
      areas: [...new Set(samples.map(({ area }) => area))].sort(),
      latencyMs: {
        min: latencies[0] ?? null,
        median: latencies.length ? latencies[Math.floor(latencies.length / 2)] : null,
        max: latencies.at(-1) ?? null
      },
      serverTimingMs: {
        min: serverLatencies[0] ?? null,
        median: serverLatencies.length ? serverLatencies[Math.floor(serverLatencies.length / 2)] : null,
        max: serverLatencies.at(-1) ?? null
      }
    }];
  })
);
const summary = {
  registry: {
    countries: registryCountries.length,
    latencyMs: registryLatencyMs,
    totalAddresses: registryCountries.reduce((total, country) => total + Number(country.addressCount || 0), 0),
    totalResidential: registryCountries.reduce((total, country) => total + Number(country.residentialCount || 0), 0),
    errors: registryErrors
  },
  ordinary: {
    countries: allCountries.length,
    attempts: results.filter((result) => !result.residential).length,
    rttP95Ms: ordinaryP95Ms,
    serverP95Ms: ordinaryServerP95Ms,
    byCountry: countryStats(false)
  },
  residential: {
    countries: residentialCountries.length,
    attempts: results.filter((result) => result.residential).length,
    rttP95Ms: residentialP95Ms,
    serverP95Ms: residentialServerP95Ms,
    byCountry: countryStats(true)
  },
  passed: results.length - failed.length,
  latencyErrors,
  failed
};
console.log(JSON.stringify(summary, null, 2));
if (registryErrors.length || latencyErrors.length || failed.length) process.exitCode = 1;
