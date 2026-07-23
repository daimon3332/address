import { writeFile } from 'node:fs/promises';

const sourceUrl = 'https://raw.githubusercontent.com/dr5hn/countries-states-cities-database/master/json/states.json';
const countryCodes = new Set([
  'US', 'CA', 'MX', 'GB', 'DE', 'FR', 'IT', 'ES', 'NL', 'RU', 'JP', 'HK', 'SG', 'TW', 'KR', 'MY',
  'CN', 'TH', 'PH', 'VN', 'TR', 'SA', 'IN', 'AU', 'BR', 'NG', 'ZA'
]);

const response = await fetch(sourceUrl);
if (!response.ok) throw new Error(`Region source returned ${response.status}`);
const states = await response.json();
const regions = states
  .filter((state) => countryCodes.has(state.country_code) && state.parent_id == null)
  .map((state) => ({
    countryCode: state.country_code,
    name: state.name,
    native: state.native || state.name,
    zh: state.translations?.['zh-CN'] || state.name,
    code: state.iso2
  }))
  .sort((left, right) => left.countryCode.localeCompare(right.countryCode) || left.name.localeCompare(right.name));

await writeFile(new URL('../src/domain/regions.json', import.meta.url), `${JSON.stringify(regions, null, 2)}\n`);
await writeFile(new URL('../src/domain/regions.meta.json', import.meta.url), `${JSON.stringify({
  sourceUrl,
  license: 'ODbL-1.0',
  fetchedAt: new Date().toISOString(),
  records: regions.length
}, null, 2)}\n`);
console.log(`Updated ${regions.length} top-level regions.`);
