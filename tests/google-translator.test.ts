import { describe, expect, it } from 'vitest';
import { translateGoogleBatch } from '../server/api/services/google-translator';

describe('Google component translator', () => {
  it('keeps component boundaries in one request', async () => {
    const fetcher = async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.searchParams.get('sl')).toBe('auto');
      expect(url.searchParams.get('tl')).toBe('en');
      expect(url.searchParams.get('q')).toContain('[[[ADDRESS_COMPONENT_BOUNDARY]]]');
      return new Response(JSON.stringify([[['Kaset Wisai\n', '', null, null], ['[[[ADDRESS_COMPONENT_BOUNDARY]]]', '', null, null], ['\nBan Pa Yang', '', null, null]]]));
    };

    await expect(translateGoogleBatch(['เกษตรวิสัย', 'ยางรถยนต์'], 'auto', 'en', fetcher as typeof fetch))
      .resolves.toEqual(['Kaset Wisai', 'Ban Pa Yang']);
  });

  it('rejects malformed or incomplete batches', async () => {
    const fetcher = async () => new Response(JSON.stringify([[['only one', '', null, null]]]));
    await expect(translateGoogleBatch(['one', 'two'], 'auto', 'en', fetcher as typeof fetch)).resolves.toBeUndefined();
  });
});
