import { describe, expect, it } from 'vitest';
import { translateYoudaoBatch, truncateYoudaoInput } from '../server/api/services/youdao-translator';

describe('Youdao batch translator', () => {
  it('uses the official v3 batch signature and keeps repeated q parameters', async () => {
    const credentials = { appKey: 'test-app', appSecret: 'test-secret' };
    const now = new Date('2026-07-16T00:00:00Z');
    const salt = 'fixed-salt';
    let request: Request | undefined;
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      request = new Request(input, init);
      return new Response(JSON.stringify({
        errorCode: '0',
        translateResults: [
          { query: '正德街', translation: 'Ching Tak Street', type: 'zh-CHS2en' },
          { query: '龍安樓', translation: 'Lung On House', type: 'zh-CHS2en' }
        ]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const result = await translateYoudaoBatch(
      ['正德街', '龍安樓'], 'zh-CHS', 'en', credentials, fetcher as typeof fetch, now, salt
    );

    expect(result).toEqual(['Ching Tak Street', 'Lung On House']);
    expect(request?.url).toBe('https://openapi.youdao.com/v2/api');
    const form = new URLSearchParams(await request!.text());
    expect(form.getAll('q')).toEqual(['正德街', '龍安樓']);
    expect(form.get('signType')).toBe('v3');
    expect(form.get('curtime')).toBe('1784160000');
    expect(form.get('sign')).toMatch(/^[a-f0-9]{64}$/);
  });

  it('truncates the concatenated batch by Unicode characters', () => {
    expect(truncateYoudaoInput(['1234567890', 'abcdefghij', '尾巴'])).toBe('123456789022cdefghij尾巴');
  });

  it('returns no translation for provider errors or incomplete batches', async () => {
    const fetcher = async () => new Response(JSON.stringify({
      errorCode: '0', translateResults: [{ translation: 'only one' }]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    await expect(translateYoudaoBatch(
      ['one', 'two'], 'en', 'zh-CHS', { appKey: 'a', appSecret: 'b' }, fetcher as typeof fetch
    )).resolves.toBeUndefined();
  });
});
