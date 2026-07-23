import { describe, expect, it } from 'vitest';
import { CatalogReverseGeocoder } from '../server/sync/catalog-reverse-geocoder.mjs';

const regions = [
  { id: 1, code: 'GD', name: 'Guangdong', native_name: '广东省', zh_name: '广东省', type: 'province', latitude: 23.4, longitude: 113.5 },
  { id: 2, code: 'FJ', name: 'Fujian', native_name: '福建省', zh_name: '福建省', type: 'province', latitude: 26.1, longitude: 118.0 },
  { id: 3, code: 'SH', name: 'Shanghai', native_name: '上海市', zh_name: '上海市', type: 'municipality', latitude: 31.23, longitude: 121.47 }
];
const cities = [
  { name: 'Shenzhen', native_name: '深圳', zh_name: '深圳市', region_id: 1, type: 'prefecture', latitude: 22.54, longitude: 114.06 },
  { name: 'Xiamen', native_name: '厦门', zh_name: '厦门市', region_id: 2, type: 'prefecture', latitude: 24.48, longitude: 118.09 },
  { name: "Xiang'an", native_name: '翔安', zh_name: '翔安', region_id: 2, type: 'district', latitude: 24.67, longitude: 118.13 },
  { name: 'Huangpu', native_name: '黄埔', zh_name: '黄埔', region_id: 3, type: 'district', latitude: 31.23, longitude: 121.49 }
];

describe('catalog reverse geocoder', () => {
  it('fills the missing city and its region for a nearby point', () => {
    const geocoder = new CatalogReverseGeocoder('CN', regions, cities);
    const record = { latitude: 22.56, longitude: 113.9, components: { admin1: '', locality: '', postalLocality: '' } };
    const filled = geocoder.lookup(record);
    expect(filled.locality).toBe('深圳');
    expect(filled.localityEn).toBe('Shenzhen');
    expect(filled.localityZh).toBe('深圳市');
    expect(filled.admin1).toBe('广东省');
    expect(filled.admin1Code).toBe('GD');
  });

  it('fills only the region when the city already exists', () => {
    const geocoder = new CatalogReverseGeocoder('CN', regions, cities);
    const record = { latitude: 24.5, longitude: 118.1, components: { admin1: '', locality: '思明区', postalLocality: '' } };
    const filled = geocoder.lookup(record);
    expect(filled.locality).toBeUndefined();
    expect(filled.admin1).toBe('福建省');
  });

  it('returns nothing for points far outside the catalog radius', () => {
    const geocoder = new CatalogReverseGeocoder('CN', regions, cities);
    const filled = geocoder.lookup({ latitude: 48.8, longitude: 2.35, components: { admin1: '', locality: '' } });
    expect(filled).toEqual({});
  });

  it('replaces a Latin-script city with the Chinese name for Chinese countries', () => {
    const geocoder = new CatalogReverseGeocoder('CN', regions, cities);
    const record = { latitude: 22.56, longitude: 113.9, components: { admin1: 'Guangdong', locality: 'Shenzhen', postalLocality: '' } };
    const filled = geocoder.lookup(record);
    expect(filled.replaceCity).toBe(true);
    expect(filled.locality).toBe('深圳');
    expect(filled.replaceRegion).toBe(true);
    expect(filled.admin1).toBe('广东省');
  });

  it('keeps an existing Chinese city untouched', () => {
    const geocoder = new CatalogReverseGeocoder('CN', regions, cities);
    const record = { latitude: 22.56, longitude: 113.9, components: { admin1: '广东省', locality: '深圳', postalLocality: '' } };
    const filled = geocoder.lookup(record);
    expect(filled).toEqual({});
  });

  it('drops HK/Macau catalog regions for the CN geocoder', () => {
    const withHk = [
      ...regions,
      { id: 9, code: 'HK', name: 'Hong Kong', native_name: '香港', zh_name: '香港', latitude: 22.3, longitude: 114.17 }
    ];
    const hkCity = [{ name: 'Central', native_name: '中環', zh_name: '中环', region_id: 9, latitude: 22.28, longitude: 114.16 }];
    const geocoder = new CatalogReverseGeocoder('CN', withHk, [...cities, ...hkCity]);
    // A point near Hong Kong must still resolve to a mainland region, never Hong Kong.
    const filled = geocoder.lookup({ latitude: 22.3, longitude: 114.16, components: { admin1: '', locality: '' } });
    expect(filled.admin1 || '').not.toMatch(/香港|Hong Kong/);
  });

  it('is inert with an empty catalog', () => {
    const geocoder = new CatalogReverseGeocoder('CN', [], []);
    expect(geocoder.available).toBe(false);
    expect(geocoder.lookup({ latitude: 22.5, longitude: 114, components: {} })).toEqual({});
  });
});

describe('coordinate-anchored hierarchy', () => {
  it('anchors a district-level point to its prefecture city, not the district', () => {
    const geocoder = new CatalogReverseGeocoder('CN', regions, cities);
    // Point in Xiang'an district must resolve city=厦门 (prefecture), district=翔安.
    const anchored = geocoder.resolveHierarchy(24.67, 118.13, { sourceAdmin1: '福建省' });
    expect(anchored.admin1).toBe('福建省');
    expect(anchored.city).toBe('厦门');
    expect(anchored.district).toBe('翔安');
  });

  it('treats a municipality as its own city', () => {
    const geocoder = new CatalogReverseGeocoder('CN', regions, cities);
    const anchored = geocoder.resolveHierarchy(31.23, 121.48, { sourceAdmin1: '上海市' });
    expect(anchored.admin1).toBe('上海市');
    expect(anchored.city).toBe('上海市');
    expect(anchored.district).toBe('黄埔');
  });

  it('trusts a valid source province over a distant coordinate centroid', () => {
    const geocoder = new CatalogReverseGeocoder('CN', regions, cities);
    const anchored = geocoder.resolveHierarchy(24.48, 118.09, { sourceAdmin1: 'Fujian' });
    expect(anchored.admin1).toBe('福建省');
    expect(anchored.city).toBe('厦门');
  });

  it('drops a cross-border point with no city-tier anchor', () => {
    const geocoder = new CatalogReverseGeocoder('CN', regions, cities);
    expect(geocoder.resolveHierarchy(55.75, 37.61, { sourceAdmin1: '' })).toBeNull();
  });
});
