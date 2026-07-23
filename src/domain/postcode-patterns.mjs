// Per-country postcode shapes shared by the read-layer scrubber and the quality
// gate. Patterns accept the official formats including tolerated spacing.
export const postcodePatterns = {
  US: /^\d{5}(?:-\d{4})?$/,
  CA: /^[A-Za-z]\d[A-Za-z]\s?\d[A-Za-z]\d$/,
  MX: /^\d{5}$/,
  DE: /^\d{5}$/,
  FR: /^\d{5}$/,
  IT: /^\d{5}$/,
  ES: /^\d{5}$/,
  NL: /^\d{4}\s?[A-Za-z]{2}$/,
  JP: /^\d{3}-?\d{4}$/,
  TW: /^\d{3,6}$/,
  AU: /^\d{4}$/,
  GB: /^[A-Za-z]{1,2}\d[A-Za-z\d]?(?:\s?\d[A-Za-z]{2})?$/,
  RU: /^\d{6}$/,
  CN: /^\d{6}$/,
  KR: /^\d{5}$/,
  MY: /^\d{5}$/,
  TH: /^\d{5}$/,
  PH: /^\d{4}$/,
  VN: /^\d{5,6}$/,
  TR: /^\d{5}$/,
  SA: /^\d{5}(?:\s*-\s*\d{4})?$/,
  IN: /^\d{3}\s?\d{3}$/,
  NG: /^\d{6}$/,
  ZA: /^\d{4}$/,
  BR: /^\d{5}-?\d{3}$/,
  SG: /^\d{6}$/
};

// True when the value is a plausible postcode for the country; countries without
// a pattern (HK) never validate positively.
export const isValidPostcode = (countryCode, value) => {
  const pattern = postcodePatterns[String(countryCode || '').toUpperCase()];
  if (!pattern) return false;
  return pattern.test(String(value || '').trim());
};
