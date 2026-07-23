import { describe, expect, it, vi } from 'vitest';
import { countryByCode } from '../src/domain/countries';
import { fetchHongKongAlsCandidates } from '../server/api/services/hong-kong-als';

const alsPayload = {
  SuggestedAddress: [{
    Address: {
      PremisesAddress: {
        GeoAddress: 'ALS-QA-001',
        EngPremisesAddress: {
          BuildingName: 'LUNG ON HOUSE',
          EngEstate: { EstateName: 'LUNG ON ESTATE' },
          EngStreet: {
            LocationName: 'SHAM SHUI PO', StreetName: 'CHING TAK STREET',
            BuildingNoFrom: '8', BuildingNoTo: '8'
          },
          EngDistrict: { DcDistrict: 'SHAM SHUI PO DISTRICT' },
          Region: 'KLN'
        },
        ChiPremisesAddress: {
          BuildingName: '龍安樓',
          ChiEstate: { EstateName: '龍安邨' },
          ChiStreet: {
            LocationName: '深水埗', StreetName: '正德街',
            BuildingNoFrom: '8', BuildingNoTo: '8'
          },
          ChiDistrict: { DcDistrict: '深水埗區' },
          Region: '九龍'
        },
        GeospatialInformation: [{ Latitude: '22.33123', Longitude: '114.16234' }]
      }
    },
    ValidationInformation: { Score: 100 }
  }]
};

describe('Hong Kong Address Lookup Service contract', () => {
  it('sends the ALS lookup contract and maps bilingual premises without machine translation', async () => {
    let request: Request | undefined;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      request = new Request(input, init);
      return new Response(JSON.stringify(alsPayload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const country = countryByCode.get('HK')!;
    const result = await fetchHongKongAlsCandidates(
      country, true, { q: '正德街 8號' }, fetcher as unknown as typeof fetch,
      new Date('2026-07-16T00:00:00Z'), undefined, 'https://als.test/lookup'
    );

    expect(fetcher).toHaveBeenCalledOnce();
    const url = new URL(request!.url);
    expect(url.origin + url.pathname).toBe('https://als.test/lookup');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ q: '正德街 8號', n: '20', t: '10', b: '1' });
    expect(request!.headers.get('Accept')).toBe('application/json');
    expect(request!.headers.get('Accept-Language')).toBe('en,zh-Hant');

    expect(result).toHaveLength(1);
    const address = result[0];
    expect(address.id).toBe('hk-als-ALS-QA-001');
    expect(address.coordinates).toEqual({ latitude: 22.33123, longitude: 114.16234 });
    expect(address.propertyType).toBe('residential');
    expect(address.components).toMatchObject({
      houseNumber: '8號', street: '正德街', buildingName: '龍安樓', locality: '深水埗',
      district: '深水埗區', admin1: '九龍', admin1Code: 'KLN', postcode: ''
    });
    expect(address.componentVariants.en).toMatchObject({
      houseNumber: '8', street: 'CHING TAK STREET', buildingName: 'LUNG ON HOUSE',
      locality: 'SHAM SHUI PO', admin1: 'KOWLOON', admin1Code: 'KLN', postcode: ''
    });
    expect(address.componentVariants['zh-CN'].street).toBe('正德街');
    expect(address.componentVariants['zh-CN'].buildingName).toBe('龙安楼');
    expect(address.addressVariants.native).toMatch(/[龍樓邨號]/u);
    expect(address.addressVariants.en).toMatch(/CHING TAK STREET/u);
    expect(address.addressVariants['zh-CN']).toMatch(/[龙楼邨号]/u);
    expect(address.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: 'hk-als', type: 'address_existence' }),
      expect.objectContaining({ sourceId: 'hk-als', type: 'coordinate', value: '22.33123,114.16234' }),
      expect.objectContaining({ sourceId: 'hk-als', type: 'residential_use' })
    ]));
  });

  it('strictly rejects a requested locality absent from the bilingual ALS result', async () => {
    const fetcher = async () => new Response(JSON.stringify(alsPayload), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
    const result = await fetchHongKongAlsCandidates(
      countryByCode.get('HK')!, false, { city: 'Central' }, fetcher as typeof fetch,
      new Date('2026-07-16T00:00:00Z'), undefined, 'https://als.test/lookup'
    );
    expect(result).toEqual([]);
  });

  it('does not call ALS for another country', async () => {
    const fetcher = vi.fn();
    await expect(fetchHongKongAlsCandidates(
      countryByCode.get('US')!, false, {}, fetcher as unknown as typeof fetch
    )).resolves.toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
