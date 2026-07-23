import { describe, expect, it } from 'vitest';
import { countryByCode } from '../src/domain/countries';
import { pickAddressPoolV2Address } from '../server/api/repositories/address-pool-v2';
import { fetchExternalCandidates } from '../server/api/services/external-providers';
import { fetchHongKongAlsCandidates } from '../server/api/services/hong-kong-als';
import { fetchOverpassCandidates } from '../server/api/services/overpass-provider';
import { filterProviderCandidates } from '../server/api/index';
import lungOnHouse from './fixtures/hk-als-lung-on-house.json';

const country = (code: 'US' | 'GB' | 'HK') => countryByCode.get(code)!;

describe('non-residential provider gates', () => {
  it('drops a Geoapify hospital and keeps a residential building in the same response', async () => {
    const fetcher = async () => new Response(JSON.stringify({ features: [
      { properties: {
        country_code: 'gb', name: 'Manchester Royal Hospital', housenumber: '1', street: 'Oxford Road', city: 'Manchester',
        postcode: 'M13 9WL', formatted: 'Manchester Royal Hospital, 1 Oxford Road, Manchester M13 9WL', lat: 53.462, lon: -2.228,
        categories: ['healthcare.hospital'], datasource: { raw: { building: 'hospital' } }
      } },
      { properties: {
        country_code: 'gb', name: 'Oak House', housenumber: '41', street: 'King Street', city: 'Manchester',
        postcode: 'M2 7AT', formatted: 'Oak House, 41 King Street, Manchester M2 7AT', lat: 53.481, lon: -2.247,
        categories: ['building.residential'], datasource: { raw: { building: 'apartments' } }
      } }
    ] }), { status: 200, headers: { 'content-type': 'application/json' } });

    const result = await fetchExternalCandidates(country('GB'), false, {}, { geoapify: 'test' }, fetcher as typeof fetch);

    expect(result.sources).toEqual(['geoapify']);
    expect(result.candidates.map((candidate) => candidate.components.buildingName)).toEqual(['Oak House']);
  });

  it('drops OSM institution tags and dormitories before candidate filtering', async () => {
    const mockResponse = JSON.stringify({ elements: [
      { type: 'way', id: 1, center: { lat: 39.95, lon: -75.16 }, tags: {
        'addr:housenumber': '1', 'addr:street': 'Market Street', 'addr:city': 'Philadelphia',
        building: 'hospital', amenity: 'hospital', name: 'Central Hospital'
      } },
      { type: 'way', id: 2, center: { lat: 39.951, lon: -75.161 }, tags: {
        'addr:housenumber': '2', 'addr:street': 'Market Street', 'addr:city': 'Philadelphia',
        building: 'dormitory', name: 'Student Dormitory'
      } },
      { type: 'way', id: 3, center: { lat: 39.952, lon: -75.162 }, tags: {
        'addr:housenumber': '10', 'addr:street': 'Bank Street', 'addr:city': 'Philadelphia', building: 'house'
      } },
      { type: 'way', id: 4, center: { lat: 39.953, lon: -75.163 }, tags: {
        'addr:housenumber': '20', 'addr:street': 'Market Street', 'addr:city': 'Philadelphia', building: 'yes', shop: 'supermarket'
      } }
    ] });

    const result = await fetchOverpassCandidates(country('US'), false, {}, undefined, undefined, mockResponse);

    expect(result).toHaveLength(1);
    expect(result[0].components).toMatchObject({ houseNumber: '10', street: 'Bank Street' });
  });

  it('drops an institutional Hong Kong ALS premises even when estate metadata resembles residential evidence', async () => {
    const payload = structuredClone(lungOnHouse);
    const premises = payload.SuggestedAddress[0].Address.PremisesAddress;
    premises.EngPremisesAddress.BuildingName = 'GRAND HOTEL';
    premises.ChiPremisesAddress.BuildingName = '大酒店';
    const fetcher = async () => new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });

    const result = await fetchHongKongAlsCandidates(country('HK'), true, { q: 'GRAND HOTEL' }, fetcher as typeof fetch);

    expect(result).toEqual([]);
  });

  it('drops a Hong Kong correctional premises and revalidates the same shape after cache serialization', async () => {
    const payload = structuredClone(lungOnHouse);
    const premises = payload.SuggestedAddress[0].Address.PremisesAddress;
    premises.EngPremisesAddress.BuildingName = 'VISIT REGISTRATION ROOM';
    premises.EngPremisesAddress.EngEstate.EstateName = 'LAI CHI KOK RECEPTION CENTRE';
    premises.ChiPremisesAddress.BuildingName = '探訪登記室';
    premises.ChiPremisesAddress.ChiEstate.EstateName = '荔枝角收押所';
    const fetcher = async () => new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });

    const result = await fetchHongKongAlsCandidates(country('HK'), false, {}, fetcher as typeof fetch);
    expect(result).toEqual([]);

    const residentialFetcher = async () =>
      new Response(JSON.stringify(lungOnHouse), { status: 200, headers: { 'content-type': 'application/json' } });
    const residential = await fetchHongKongAlsCandidates(
      country('HK'), true, { q: '龍安樓' }, residentialFetcher as typeof fetch
    );
    const cachedInstitution = {
      ...residential[0],
      nativeAddress: '九龍荔枝角收押所探訪登記室香港',
      formattedAddress: 'VISIT REGISTRATION ROOM, LAI CHI KOK RECEPTION CENTRE, HONG KONG',
      addressVariants: {
        native: '九龍荔枝角收押所探訪登記室香港',
        en: 'VISIT REGISTRATION ROOM, LAI CHI KOK RECEPTION CENTRE, HONG KONG',
        'zh-CN': '九龙荔枝角收押所探访登记室香港'
      }
    };
    expect(filterProviderCandidates([cachedInstitution])).toEqual([]);
  });
});

describe('non-residential v2 repository gate', () => {
  it('drops an institutional record already present in the runtime view', async () => {
    const row = {
      id: 'institution', country_code: 'US', admin1: 'Pennsylvania', admin1_code: 'PA', locality: 'Philadelphia',
      postal_locality: 'Philadelphia', district: '', postcode: '19103', street: 'Market Street', house_number: '1',
      building_name: 'Philadelphia City Hall', latitude: 39.9526, longitude: -75.1652, native_language: 'en',
      property_type: 'unknown', generation: 'fixture', quality_score: 0.95, first_seen_at: '2026-07-16T00:00:00Z', expires_at: null,
      component_variants_json: JSON.stringify({
        native: { houseNumber: '1', street: 'Market Street', buildingName: 'Philadelphia City Hall', locality: 'Philadelphia', postcode: '19103' },
        en: { houseNumber: '1', street: 'Market Street', buildingName: 'Philadelphia City Hall', locality: 'Philadelphia', postcode: '19103' },
        'zh-CN': { houseNumber: '1', street: '市场街', buildingName: '费城市政厅', locality: '费城', postcode: '19103' }
      }),
      address_variants_json: JSON.stringify({
        native: 'Philadelphia City Hall, 1 Market Street, Philadelphia, PA 19103',
        en: 'Philadelphia City Hall, 1 Market Street, Philadelphia, PA 19103',
        'zh-CN': '费城市政厅，市场街1号，费城'
      }),
      source_id: 'fixture', source_name: 'Fixture', source_url: 'https://example.test/source', source_license: 'CC0-1.0',
      record_url: 'https://example.test/source/1', evidence_type: 'address_existence', observed_at: '2026-07-16T00:00:00Z'
    };
    const eligible = {
      ...row,
      id: 'residence', building_name: 'Market Street Residence', house_number: '10',
      component_variants_json: JSON.stringify({
        native: { houseNumber: '10', street: 'Market Street', buildingName: 'Market Street Residence', locality: 'Philadelphia', postcode: '19103' },
        en: { houseNumber: '10', street: 'Market Street', buildingName: 'Market Street Residence', locality: 'Philadelphia', postcode: '19103' },
        'zh-CN': { houseNumber: '10', street: '市场街', buildingName: '市场街住宅', locality: '费城', postcode: '19103' }
      }),
      address_variants_json: JSON.stringify({
        native: 'Market Street Residence, 10 Market Street, Philadelphia, PA 19103',
        en: 'Market Street Residence, 10 Market Street, Philadelphia, PA 19103',
        'zh-CN': '市场街住宅，市场街10号，费城'
      })
    };
    const database = {
      prepare(sql: string) {
        const statement = {
          bind() { return statement; },
          async all() {
            if (sql.startsWith('SELECT id FROM address_pool')) {
              return { results: [{ id: row.id }, { id: eligible.id }] };
            }
            return { results: [row, eligible] };
          }
        };
        return statement;
      }
    };

    const result = await pickAddressPoolV2Address(
      database as unknown as Parameters<typeof pickAddressPoolV2Address>[0],
      'US', false, {}, undefined, 'fixture'
    );

    expect(result?.id).toBe('pool-v2-residence');
    expect(result?.components.buildingName).toBe('Market Street Residence');
  });
});
