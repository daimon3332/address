import { countryLanguages, nonResidentialRules } from './non-residential-rules.mjs';

const normalize = (value) => String(value || '')
  .normalize('NFKC')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/gu, '')
  .toLocaleLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, ' ')
  .trim()
  .replace(/\s+/gu, ' ');

const unique = (values) => [...new Set(values.flat().filter((value) => typeof value === 'string' && value.trim()))];
const compactScript = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u;
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const containsTerm = (value, term) => {
  const haystack = normalize(value);
  const needle = normalize(term);
  if (!haystack || !needle) return false;
  if (compactScript.test(needle)) return haystack.includes(needle);
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRegExp(needle)}(?=$|[^\\p{L}\\p{N}])`, 'u').test(haystack);
};

const valuesFrom = (input, singular, plural) => unique([input[singular], input[plural] || []]);

export const findNonResidentialMatch = (input = {}) => {
  const languages = unique(['en', countryLanguages[String(input.countryCode || '').toUpperCase()] || []]);
  const buildingNames = valuesFrom(input, 'buildingName', 'buildingNames');
  const formattedAddresses = valuesFrom(input, 'formattedAddress', 'formattedAddresses');
  const streets = valuesFrom(input, 'street', 'streets');
  const classifications = unique([input.propertyType, input.classifications || []]).map(normalize);

  for (const [category, rule] of Object.entries(nonResidentialRules)) {
    const classification = rule.classifications.find((value) => classifications.includes(normalize(value)));
    if (classification) return { excluded: true, category, term: classification, field: 'classification' };

    const terms = unique(languages.map((language) => rule.terms[language] || []));
    for (const term of terms) {
      if (buildingNames.some((value) => containsTerm(value, term))) {
        return { excluded: true, category, term, field: 'buildingName' };
      }
      if (formattedAddresses.some((value) => containsTerm(value, term)) && !streets.some((value) => containsTerm(value, term))) {
        return { excluded: true, category, term, field: 'formattedAddress' };
      }
    }
  }
  return { excluded: false };
};

export const isNonResidentialAddress = (input) => findNonResidentialMatch(input).excluded;

export const isVerifiedAddressNonResidential = (address) => {
  const variants = Object.values(address?.componentVariants || {}).filter(Boolean);
  return findNonResidentialMatch({
    countryCode: address?.countryCode,
    buildingNames: variants.map((item) => item.buildingName).filter(Boolean),
    formattedAddresses: unique([
      address?.nativeAddress,
      address?.formattedAddress,
      Object.values(address?.addressVariants || {})
    ]),
    streets: variants.map((item) => item.street).filter(Boolean),
    propertyType: address?.propertyType
  }).excluded;
};
