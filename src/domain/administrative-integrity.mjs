const usSubdivisions = [
  ['AL', 'Alabama'], ['AK', 'Alaska'], ['AZ', 'Arizona'], ['AR', 'Arkansas'],
  ['CA', 'California'], ['CO', 'Colorado'], ['CT', 'Connecticut'], ['DE', 'Delaware'],
  ['FL', 'Florida'], ['GA', 'Georgia'], ['HI', 'Hawaii'], ['ID', 'Idaho'],
  ['IL', 'Illinois'], ['IN', 'Indiana'], ['IA', 'Iowa'], ['KS', 'Kansas'],
  ['KY', 'Kentucky'], ['LA', 'Louisiana'], ['ME', 'Maine'], ['MD', 'Maryland'],
  ['MA', 'Massachusetts'], ['MI', 'Michigan'], ['MN', 'Minnesota'], ['MS', 'Mississippi'],
  ['MO', 'Missouri'], ['MT', 'Montana'], ['NE', 'Nebraska'], ['NV', 'Nevada'],
  ['NH', 'New Hampshire'], ['NJ', 'New Jersey'], ['NM', 'New Mexico'], ['NY', 'New York'],
  ['NC', 'North Carolina'], ['ND', 'North Dakota'], ['OH', 'Ohio'], ['OK', 'Oklahoma'],
  ['OR', 'Oregon'], ['PA', 'Pennsylvania'], ['RI', 'Rhode Island'], ['SC', 'South Carolina'],
  ['SD', 'South Dakota'], ['TN', 'Tennessee'], ['TX', 'Texas'], ['UT', 'Utah'],
  ['VT', 'Vermont'], ['VA', 'Virginia'], ['WA', 'Washington'], ['WV', 'West Virginia'],
  ['WI', 'Wisconsin'], ['WY', 'Wyoming'], ['DC', 'District of Columbia'],
  ['AS', 'American Samoa'], ['GU', 'Guam'], ['MP', 'Northern Mariana Islands'],
  ['PR', 'Puerto Rico'], ['VI', 'U.S. Virgin Islands'], ['UM', 'United States Minor Outlying Islands']
];

const normalize = (value) => String(value || '')
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/gu, '')
  .toLocaleLowerCase('en')
  .replace(/^us[-\s]+/u, '')
  .replace(/[^a-z0-9]+/gu, '');

const subdivisionCodes = new Map();
for (const [code, name] of usSubdivisions) {
  subdivisionCodes.set(normalize(code), code);
  subdivisionCodes.set(normalize(name), code);
}
for (const alias of ['Washington DC', 'Washington D.C.', 'Washington, D.C.']) {
  subdivisionCodes.set(normalize(alias), 'DC');
}
for (const alias of ['US Virgin Islands', 'Virgin Islands']) subdivisionCodes.set(normalize(alias), 'VI');

const subdivisionCode = (value) => subdivisionCodes.get(normalize(value));

export const normalizeAddressComponents = (countryCode, components) => {
  if (String(countryCode || '').toUpperCase() !== 'US' || !/^112\d{2}$/u.test(String(components?.postcode || ''))) {
    return components;
  }
  const current = String(components.postalLocality || components.locality || '');
  const postalLocality = /[\p{Script=Han}]/u.test(current) ? '布鲁克林' : 'Brooklyn';
  return components.postalLocality === postalLocality ? components : { ...components, postalLocality };
};

export const validateAdministrativeHierarchy = ({ countryCode, admin1, admin1Code } = {}) => {
  if (String(countryCode || '').toUpperCase() !== 'US') return { valid: true };
  const nameCode = subdivisionCode(admin1);
  const explicitCode = subdivisionCode(admin1Code);
  if (admin1 && !nameCode) return { valid: false, reason: 'invalid-us-admin1' };
  if (admin1Code && !explicitCode) return { valid: false, reason: 'invalid-us-admin1-code' };
  if (nameCode && explicitCode && nameCode !== explicitCode) {
    return { valid: false, reason: 'mismatched-us-admin1' };
  }
  return { valid: true };
};
