import { fetchWithTimeout } from './fetch-timeout.ts';

const GOOGLE_TRANSLATE_URL = 'https://translate.googleapis.com/translate_a/single';
const BOUNDARY = '[[[ADDRESS_COMPONENT_BOUNDARY]]]';

export const translateGoogleBatch = async (
  values: string[],
  from: string,
  to: string,
  fetcher: typeof fetch = fetch
): Promise<string[] | undefined> => {
  if (!values.length || values.some((value) => !value.trim())) return undefined;
  const url = new URL(GOOGLE_TRANSLATE_URL);
  url.searchParams.set('client', 'gtx');
  url.searchParams.set('dt', 't');
  url.searchParams.set('sl', from);
  url.searchParams.set('tl', to);
  url.searchParams.set('q', values.join(`\n${BOUNDARY}\n`));
  const response = await fetchWithTimeout(fetcher, url, { headers: { Accept: 'application/json' } });
  if (!response.ok) return undefined;
  const payload = await response.json() as unknown;
  if (!Array.isArray(payload) || !Array.isArray(payload[0])) return undefined;
  const translated = payload[0]
    .map((segment: unknown) => Array.isArray(segment) && typeof segment[0] === 'string' ? segment[0] : '')
    .join('')
    .split(BOUNDARY)
    .map((value: string) => value.trim());
  return translated.length === values.length && translated.every(Boolean) ? translated : undefined;
};
