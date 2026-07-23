import regionData from './regions.json';
import type { CountryCode, LocationOption } from './types';

interface RegionRecord {
  countryCode: CountryCode;
  name: string;
  native: string;
  zh: string;
  code: string;
}

const records = regionData as RegionRecord[];
const commonAbbreviations = new Set<CountryCode>(['US', 'CA', 'AU', 'BR', 'IN', 'MX', 'NG']);
const usStateCodes = new Set('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC'.split(' '));

const normalize = (value: string): string => value.normalize('NFKD').toLocaleLowerCase().replace(/\s+/g, ' ').trim();

export const regionsForCountry = (countryCode: CountryCode, query = ''): LocationOption[] => {
  const needle = normalize(query);
  return records
    .filter((region) => region.countryCode === countryCode && (countryCode !== 'US' || usStateCodes.has(region.code)))
    .map((region) => {
      const value = countryCode === 'CN' ? region.native : region.name;
      const abbreviation = commonAbbreviations.has(countryCode) && region.code ? `（${region.code}）` : '';
      const label = countryCode === 'CN' ? region.zh : `${region.name}${abbreviation}${abbreviation ? '' : ' '}${region.zh}`;
      return { value, label };
    })
    .filter((option) => !needle || normalize(`${option.value} ${option.label}`).includes(needle))
    .sort((left, right) => left.label.localeCompare(right.label, countryCode === 'CN' ? 'zh-CN' : 'en'));
};

export const locationOptions = (values: string[]): LocationOption[] => [...new Set(values.filter(Boolean))]
  .sort((left, right) => left.localeCompare(right))
  .map((value) => ({ value, label: value }));
