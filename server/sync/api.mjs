import { createHash, timingSafeEqual } from 'node:crypto';

const digest = (value) => createHash('sha256').update(value).digest();
const authorized = (request, token) => {
  const header = request.headers.get('authorization') || '';
  const supplied = header.startsWith('Bearer ') ? header.slice(7) : '';
  return timingSafeEqual(digest(supplied), digest(token));
};
const internalAuthorized = (request, token) => timingSafeEqual(
  digest(request.headers.get('x-hot-pool-token') || ''),
  digest(token)
);

const responseHeaders = (origin, allowedOrigin) => ({
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json; charset=utf-8',
  ...(origin && origin === allowedOrigin ? {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    Vary: 'Origin'
  } : {})
});

const json = (data, status, origin, allowedOrigin, extraHeaders = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { ...responseHeaders(origin, allowedOrigin), ...extraHeaders }
});

export const createSyncApi = ({ coordinator, token, allowedOrigin = '', hotPool, hotPoolToken = '' }) => {
  if (!String(token || '').trim()) throw new Error('SYNC_ADMIN_TOKEN is required');

  return async (request) => {
    const url = new URL(request.url);
    const origin = request.headers.get('origin') || '';
    if (request.method === 'OPTIONS') {
      if (origin && origin !== allowedOrigin) return json({ error: 'ORIGIN_NOT_ALLOWED' }, 403, origin, allowedOrigin);
      return new Response(null, { status: 204, headers: responseHeaders(origin, allowedOrigin) });
    }
    if (url.pathname === '/healthz') return json({ status: 'ok' }, 200, origin, allowedOrigin);
    if (url.pathname === '/api/v1/hot-pool/health' && request.method === 'GET') {
      if (!hotPool || !hotPoolToken) return json({ error: 'HOT_POOL_UNAVAILABLE' }, 503, origin, allowedOrigin);
      if (!internalAuthorized(request, hotPoolToken)) return json({ error: 'UNAUTHORIZED' }, 401, origin, allowedOrigin);
      const countries = (url.searchParams.get('countries') || '').split(',').map((value) => value.trim()).filter(Boolean);
      const minimum = Number.parseInt(url.searchParams.get('minimum') || '1', 10);
      const result = await hotPool.health(countries, minimum);
      return json({ data: result }, 200, origin, allowedOrigin);
    }
    if (url.pathname === '/api/v1/hot-pool/pick' && request.method === 'POST') {
      if (!hotPool || !hotPoolToken) return json({ error: 'HOT_POOL_UNAVAILABLE' }, 503, origin, allowedOrigin);
      if (!internalAuthorized(request, hotPoolToken)) return json({ error: 'UNAUTHORIZED' }, 401, origin, allowedOrigin);
      let input;
      try {
        input = await request.json();
      } catch {
        return json({ error: 'INVALID_JSON' }, 400, origin, allowedOrigin);
      }
      const result = await hotPool.pick(input);
      return result?.address ? json({ data: result }, 200, origin, allowedOrigin) : json({ error: 'NO_POOL_COVERAGE' }, 404, origin, allowedOrigin);
    }
    if (!url.pathname.startsWith('/api/v1/sync/')) return json({ error: 'NOT_FOUND' }, 404, origin, allowedOrigin);
    if (!authorized(request, token)) return json({ error: 'UNAUTHORIZED' }, 401, origin, allowedOrigin);

    if (url.pathname === '/api/v1/sync/jobs' && request.method === 'POST') {
      let input = {};
      try {
        const body = await request.text();
        if (body) input = JSON.parse(body);
      } catch {
        return json({ error: 'INVALID_JSON' }, 400, origin, allowedOrigin);
      }
      const shards = Array.isArray(input.shards) ? [...new Set(input.shards.map((value) => String(value).trim()).filter(Boolean))] : ['all'];
      if (!shards.length || shards.length > 64 || shards.some((value) => !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(value))) {
        return json({ error: 'INVALID_SHARDS' }, 400, origin, allowedOrigin);
      }
      const mode = input.mode === undefined ? 'manual' : String(input.mode);
      if (!['initial', 'manual'].includes(mode)) return json({ error: 'INVALID_MODE' }, 400, origin, allowedOrigin);
      const result = await coordinator.trigger(mode, { shards });
      const status = result.accepted ? 202 : 409;
      return json({ accepted: result.accepted, job: result.job }, status, origin, allowedOrigin, result.job?.id
        ? { Location: `/api/v1/sync/jobs/${result.job.id}` }
        : {});
    }
    if (url.pathname === '/api/v1/sync/jobs/latest' && request.method === 'GET') {
      const job = await coordinator.latestJob();
      return job ? json({ job }, 200, origin, allowedOrigin) : json({ error: 'JOB_NOT_FOUND' }, 404, origin, allowedOrigin);
    }
    const match = url.pathname.match(/^\/api\/v1\/sync\/jobs\/(sync-[a-zA-Z0-9-]+)$/u);
    if (match && request.method === 'GET') {
      const job = await coordinator.getJob(match[1]);
      return job ? json({ job }, 200, origin, allowedOrigin) : json({ error: 'JOB_NOT_FOUND' }, 404, origin, allowedOrigin);
    }
    return json({ error: 'NOT_FOUND' }, 404, origin, allowedOrigin);
  };
};
