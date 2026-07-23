import { describe, expect, it } from 'vitest';
import { formatAddressPresentation } from '../src/domain/address-format';
import { normalizeAddressComponents } from '../src/domain/administrative-integrity.mjs';
import { countries } from '../src/domain/countries';
import { regionsForCountry } from '../src/domain/location-options';
import { bundleToCsv, bundleToJson } from '../src/domain/export';
import {
  acceptGoogleGeocode,
  type GoogleGeocodeResponse,
  type GoogleResolution
} from '../src/domain/google-geocoder';
import {
  generateBundle
} from '../src/domain/generator';
import { eligibleAddresses, isAddressEligible, selectCandidate } from './fixtures/catalog';
import { googleMapsEmbedUrl, googleMapsOpenUrl } from '../src/domain/maps';
import type { VerifiedAddress } from '../src/domain/types';
import { resolveGoogleAddress } from '../server/api/services/google-geocoder';

const current = new Date('2026-07-20T00:00:00Z');
const ageAt = (dateOfBirth: string, now: Date): number => {
  const birthDate = new Date(`${dateOfBirth}T00:00:00Z`);
  let age = now.getUTCFullYear() - birthDate.getUTCFullYear();
  if (now.getUTCMonth() < birthDate.getUTCMonth()
    || (now.getUTCMonth() === birthDate.getUTCMonth() && now.getUTCDate() < birthDate.getUTCDate())) age -= 1;
  return age;
};
const resolution: GoogleResolution = {
  status: 'resolved',
  placeId: 'ChIJ-test-place-id',
  resultType: 'premise',
  locationType: 'ROOFTOP'
};

const googleResponse = (address: VerifiedAddress, overrides = {}): GoogleGeocodeResponse => ({
  status: 'OK',
  results: [{
    place_id: 'ChIJ-test-place-id',
    types: ['premise'],
    address_components: [
      { long_name: address.components.houseNumber, short_name: address.components.houseNumber, types: ['street_number'] },
      { long_name: address.countryCode, short_name: address.countryCode, types: ['country'] }
    ],
    geometry: { location_type: 'ROOFTOP' },
    ...overrides
  }]
});

describe('localized region catalog', () => {
  it('shows full US names, common abbreviations and Chinese translations', () => {
    expect(regionsForCountry('US')).toContainEqual({ value: 'California', label: 'California（CA）加利福尼亚州' });
  });

  it('keeps Chinese regions in Chinese without duplicated translations', () => {
    expect(regionsForCountry('CN')).toContainEqual({ value: '广东省', label: '广东省' });
  });
});

describe('27-country source snapshots', () => {
  it('keeps the required order and exactly three current records per country', () => {
    expect(countries).toHaveLength(27);
    expect(countries.map((country) => country.code)).toEqual([
      'US', 'CA', 'MX', 'GB', 'DE', 'FR', 'IT', 'ES', 'NL', 'RU',
      'CN', 'HK', 'TW', 'JP', 'SG', 'KR', 'VN', 'TH', 'PH', 'MY',
      'IN', 'AU', 'TR', 'SA', 'BR', 'NG', 'ZA'
    ]);
    expect([...new Set(countries.map((country) => country.group))]).toEqual([
      'north-america', 'europe', 'east-asia', 'southeast-asia', 'south-asia',
      'oceania', 'middle-east', 'south-america', 'africa'
    ]);
    for (const country of countries) {
      const addresses = eligibleAddresses(country.code, false, current);
      expect(addresses, country.code).toHaveLength(3);
      expect(new Set(addresses.map((address) => address.id)).size, country.code).toBe(3);
      expect(addresses.every((address) => isAddressEligible(address, false, current)), country.code).toBe(true);
      expect(addresses.every((address) => address.evidence.some((item) => item.type === 'address_existence')), country.code).toBe(true);
    }
  });

  it('enables residential filtering only where the country data supports it', () => {
    for (const country of countries) {
      const residential = eligibleAddresses(country.code, true, current);
      expect(residential, country.code).toHaveLength(country.residentialCapability ? 3 : 0);
      expect(residential.every((address) => address.evidence.some((item) => item.type === 'residential_use'))).toBe(true);
    }
  });

  it('expires snapshot records instead of silently returning stale data', () => {
    expect(eligibleAddresses(undefined, false, new Date('2026-11-01T00:00:00Z'))).toHaveLength(0);
  });

  it('selects a deterministic candidate', () => {
    expect(selectCandidate('US', true, 'same', 0, current)).toEqual(
      selectCandidate('US', true, 'same', 0, current)
    );
  });
});

describe('country postal formats and language variants', () => {
  it('defines a complete, unique address schema for all 27 countries', () => {
    const hierarchy = ['street', 'district', 'locality', 'admin1', 'admin1Code', 'postcode', 'completeAddress'];
    for (const country of countries) {
      const schema = country.addressSchema;
      expect(schema.filters.length, country.code).toBeGreaterThan(0);
      expect(new Set(schema.filters).size, country.code).toBe(schema.filters.length);
      expect(schema.filters.every((field) => ['region', 'city', 'postcode'].includes(field)), country.code).toBe(true);
      expect(schema.resultFields[0].field, country.code).toBe('street');
      expect(schema.resultFields.at(-1)?.field, country.code).toBe('completeAddress');
      expect(new Set(schema.resultFields.map(({ field }) => field)).size, country.code).toBe(schema.resultFields.length);
      expect(schema.resultFields.map(({ field }) => hierarchy.indexOf(field)), country.code)
        .toEqual([...schema.resultFields.map(({ field }) => hierarchy.indexOf(field))].sort((left, right) => left - right));
      for (const { label } of schema.resultFields) {
        expect(label.en.trim(), country.code).toBeTruthy();
        expect(label['zh-CN'].trim(), country.code).toBeTruthy();
      }
    }
  });

  it('models the key US, Hong Kong, China, Japan and Singapore address rules', () => {
    const schemas = Object.fromEntries(countries.map((country) => [country.code, country.addressSchema]));
    expect(schemas.US.filters).toEqual(['region', 'city', 'postcode']);
    expect(schemas.US.postalAdmin1Style).toBe('code');
    expect(schemas.US.resultFields.map(({ field }) => field)).not.toContain('district');

    expect(schemas.HK.filters).not.toContain('postcode');
    expect(schemas.HK.resultFields.map(({ field }) => field)).not.toContain('postcode');

    expect(schemas.CN.filters).toEqual(['region', 'city']);
    expect(schemas.CN.resultFields.map(({ field }) => field)).toContain('district');
    expect(schemas.CN.resultFields.map(({ field }) => field)).toContain('postcode');

    expect(schemas.JP.filters).toEqual(['region', 'city', 'postcode']);
    expect(schemas.JP.resultFields.map(({ field }) => field)).toContain('district');

    expect(schemas.SG.filters).toEqual(['postcode']);
    expect(schemas.SG.resultFields.map(({ field }) => field)).toEqual([
      'street', 'postcode', 'completeAddress'
    ]);
  });

  it('uses the requested Hong Kong and Taiwan names', () => {
    expect(countries.find(({ code }) => code === 'HK')?.name['zh-CN']).toBe('香港');
    expect(countries.find(({ code }) => code === 'TW')?.name['zh-CN']).toBe('台湾');
  });

  it('formats the Brooklyn fixture with postal city and state abbreviation', () => {
    const source = eligibleAddresses('US', false, current).find(({ components }) =>
      components.street === 'Dean Street'
    )!;
    const componentVariants = Object.fromEntries(Object.entries(source.componentVariants).map(([language, components]) =>
      [language, normalizeAddressComponents('US', components)]
    )) as VerifiedAddress['componentVariants'];
    const address = { ...source, components: componentVariants.native, componentVariants };
    const formatted = formatAddressPresentation(address, 'en', '').singleLine;
    expect(formatted).toContain('Brooklyn, NY 11238');
    expect(formatted).not.toContain('New York, New York');
  });

  it('formats every address in native, English and Simplified Chinese', () => {
    for (const country of countries) {
      for (const address of eligibleAddresses(country.code, false, current)) {
        for (const language of ['native', 'en', 'zh-CN'] as const) {
          const formatted = formatAddressPresentation(address, language, 'Avery Chen');
          const expectedHouseNumber = country.code === 'CN' && language === 'en'
            ? address.componentVariants.en.houseNumber.replace(/(?:号|號|弄)$/u, '')
            : address.components.houseNumber.replace('号', '');
          expect(formatted.postalLines.length, `${country.code}:${language}`).toBeGreaterThanOrEqual(3);
          expect(formatted.postalLines[0], `${country.code}:${language}`).toBeTruthy();
          expect(formatted.singleLine, `${country.code}:${language}`).toContain(expectedHouseNumber);
          expect(formatted.singleLine, `${country.code}:${language}`).not.toContain('%');
        }
      }
    }
  });

  it('uses United Kingdom and Germany postal ordering rather than one global layout', () => {
    const uk = eligibleAddresses('GB', true, current)[0];
    const de = eligibleAddresses('DE', true, current)[0];
    const ukLines = formatAddressPresentation(uk, 'en', 'Avery Chen').postalLines;
    const deLines = formatAddressPresentation(de, 'en', 'Avery Chen').postalLines;
    expect(ukLines).toEqual([
      'Avery Chen',
      `${uk.components.houseNumber} ${uk.components.street}`,
      uk.components.locality,
      uk.components.postcode,
      'UNITED KINGDOM'
    ]);
    expect(deLines).toEqual([
      'Avery Chen',
      ...(de.components.buildingName ? [de.components.buildingName] : []),
      `${de.components.street} ${de.components.houseNumber}`,
      `${de.components.postcode} ${de.components.locality}`,
      'GERMANY'
    ]);
  });

  it('keeps a building name on its own organization line', () => {
    const address = eligibleAddresses('DE', true, current).find((item) => item.components.buildingName)!;
    const lines = formatAddressPresentation(address, 'en', 'Avery Chen').postalLines;
    const buildingIndex = lines.indexOf(address.components.buildingName!);
    expect(buildingIndex).toBeGreaterThan(0);
    expect(lines[buildingIndex + 1]).toBe(`${address.components.street} ${address.components.houseNumber}`);
  });
});

describe('Google exact-address gate', () => {
  it('accepts all 81 source records with exact premise, country, number and rooftop evidence', () => {
    for (const country of countries) {
      for (const address of eligibleAddresses(country.code, false, current)) {
        expect(acceptGoogleGeocode(googleResponse(address), address), address.id).toEqual(resolution);
      }
    }
  });

  it('rejects partial, interpolated, wrong-country and numberless results', () => {
    const address = eligibleAddresses('US', true, current)[0];
    expect(acceptGoogleGeocode(googleResponse(address, { partial_match: true }), address)).toBeUndefined();
    expect(acceptGoogleGeocode(googleResponse(address, { geometry: { location_type: 'RANGE_INTERPOLATED' } }), address)).toBeUndefined();
    expect(acceptGoogleGeocode(googleResponse(address, { address_components: [
      { long_name: address.components.houseNumber, short_name: address.components.houseNumber, types: ['street_number'] },
      { long_name: 'Canada', short_name: 'CA', types: ['country'] }
    ] }), address)).toBeUndefined();
    expect(acceptGoogleGeocode(googleResponse(address, { address_components: [
      { long_name: 'United States', short_name: 'US', types: ['country'] }
    ] }), address)).toBeUndefined();
  });

  it('does not submit synthetic address fields to Google Geocoding', async () => {
    const address = { ...eligibleAddresses('CN', false, current)[0], addressStatus: 'synthetic' as const };
    let requested = false;
    const fetcher = async () => {
      requested = true;
      throw new Error('unexpected request');
    };
    await expect(resolveGoogleAddress(address, 'test-key', undefined, fetcher as typeof fetch)).resolves.toBeUndefined();
    expect(requested).toBe(false);
  });
});

describe('generated profile, card and keyless maps', () => {
  const address = eligibleAddresses('US', true, current)[0];
  const bundle = generateBundle(address, true, 'export', resolution, current);

  it('contains only the requested fixture groups and all three address formats', () => {
    expect(bundle.residential).toBe(true);
    expect(bundle.googleMaps.placeId).toBe(resolution.placeId);
    expect(bundle.profile.email).toMatch(/^[a-z0-9]+@outlook\.com$/);
    expect(bundle.profile.phone).not.toContain('000 000');
    expect(['Visa', 'Mastercard']).toContain(bundle.card.network);
    expect(bundle.card.number).toMatch(/^[\d ]+$/);
    expect(bundle.card.expiry).toMatch(/^(0[1-9]|1[0-2])\/\d{4}$/);
    expect(bundle.card.cvc).toMatch(/^\d{3,4}$/);
    expect(bundle.card.testDataOnly).toBe(true);
    expect(Object.keys(bundle.addressFormats)).toEqual(['native', 'en', 'zh-CN']);
    expect(bundle).not.toHaveProperty('employment');
  });

  it('builds the no-key iframe and Place ID open URL', () => {
    const embed = googleMapsEmbedUrl(bundle);
    const open = googleMapsOpenUrl(bundle);
    expect(embed).toContain('https://www.google.com/maps?q=');
    expect(embed).toContain(`${address.coordinates.latitude},${address.coordinates.longitude}`);
    expect(embed).toContain('&output=embed');
    expect(embed).not.toContain('key=');
    expect(open).toContain('query_place_id=ChIJ-test-place-id');
    expect(new URL(open).searchParams.get('query')).toBe(`${address.coordinates.latitude},${address.coordinates.longitude}`);
  });

  it('uses source coordinates for Google Maps in every supported country', () => {
    for (const country of countries) {
      const source = eligibleAddresses(country.code, false, current)[0];
      const generated = generateBundle(source, false, `maps-${country.code}`, undefined, current);
      const expected = `${source.coordinates.latitude},${source.coordinates.longitude}`;
      expect(new URL(generated.googleMaps.openUrl).searchParams.get('query'), country.code).toBe(expected);
      expect(new URL(generated.googleMaps.embedUrl).searchParams.get('q'), country.code).toBe(expected);
    }
  });

  it('keeps generated units separate from the verified source address', () => {
    const apartment = eligibleAddresses('US', true, current).find((item) => item.propertyType === 'apartment')!;
    const generated = generateBundle(apartment, true, 'generated-unit', undefined, current);
    expect(generated.generatedUnit?.provenance).toBe('synthetic');
    expect(generated.generatedUnit?.variants.native).toBeTruthy();
    expect(generated.address).toEqual(apartment);
    expect(generated.address.components.unit).toBe(apartment.components.unit);
    expect(generated.address.addressVariants).toEqual(apartment.addressVariants);
  });

  it('builds a source-backed map-query fixture when the API route is offline', () => {
    const local = generateBundle(address, true, 'offline', undefined, current);
    expect(local.googleMaps.status).toBe('map_query');
    expect(local.googleMaps.placeId).toBeUndefined();
    expect(local.googleMaps.embedUrl).toContain('&output=embed');
    expect(local.addressFormats.native.postalLines.length).toBeGreaterThanOrEqual(3);
  });

  it('exports all requested data', () => {
    expect(JSON.parse(bundleToJson(bundle)).googleMaps.status).toBe('resolved');
    const csv = bundleToCsv(bundle);
    expect(csv).toContain('native_address');
    expect(csv).toContain('chinese_address');
    expect(csv).toContain('google_place_id');
  });

  it('randomizes localized identities with relative adult birth dates', () => {
    const names = new Set<string>();
    const genders = new Set<string>();
    for (let index = 0; index < 300; index += 1) {
      const generated = generateBundle(address, true, `identity-${index}`, undefined, current);
      names.add(generated.profile.fullName);
      genders.add(generated.profile.gender);
      expect(generated.extensions.basic.age).toBe(ageAt(generated.profile.dateOfBirth, current));
      expect(generated.extensions.basic.age).toBeGreaterThanOrEqual(18);
      expect(generated.extensions.basic.age).toBeLessThanOrEqual(74);
    }
    expect(names.size).toBeGreaterThan(100);
    expect([...genders].sort()).toEqual(['female', 'male']);
  });
});
