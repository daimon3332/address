import { fetchWithTimeout } from './fetch-timeout.ts';

export interface YoudaoCredentials {
  appKey: string;
  appSecret: string;
}

interface YoudaoTranslation {
  query?: string;
  translation?: string;
  type?: string;
}

interface YoudaoResponse {
  errorCode?: string;
  translateResults?: YoudaoTranslation[];
}

const YOUDAO_BATCH_URL = 'https://openapi.youdao.com/v2/api';

export const truncateYoudaoInput = (values: string[]): string => {
  const characters = Array.from(values.join(''));
  if (characters.length <= 20) return characters.join('');
  return `${characters.slice(0, 10).join('')}${characters.length}${characters.slice(-10).join('')}`;
};

const sha256 = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

export const translateYoudaoBatch = async (
  values: string[],
  from: string,
  to: string,
  credentials: YoudaoCredentials,
  fetcher: typeof fetch = fetch,
  now = new Date(),
  salt: string = crypto.randomUUID()
): Promise<string[] | undefined> => {
  if (!values.length || values.some((value) => !value.trim())) return undefined;
  const curtime = String(Math.floor(now.getTime() / 1000));
  const input = truncateYoudaoInput(values);
  const sign = await sha256(`${credentials.appKey}${input}${salt}${curtime}${credentials.appSecret}`);
  const body = new URLSearchParams({
    appKey: credentials.appKey,
    salt,
    from,
    to,
    sign,
    signType: 'v3',
    curtime
  });
  values.forEach((value) => body.append('q', value));
  const response = await fetchWithTimeout(fetcher, YOUDAO_BATCH_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!response.ok) return undefined;
  const payload = await response.json() as YoudaoResponse;
  if (payload.errorCode !== '0' || payload.translateResults?.length !== values.length) return undefined;
  const translations = payload.translateResults.map((item) => item.translation?.trim() || '');
  return translations.every(Boolean) ? translations : undefined;
};
