import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openTestDatabase, initializeTestDatabase, type PostgresDatabase } from './helpers/postgres-test-database.mjs';
import {
  AMAP_PERSONAL_MONTHLY_LIMIT, ControlStore, createServiceCredentialResolver, credentialsFromEnvironment,
  GOOGLE_GEOCODING_FREE_MONTHLY_LIMIT, GOOGLE_GEOCODING_SYNC_MONTHLY_BUDGET,
  credentialProviderDefaults, DEFAULT_MAP_DISPLAY_CONFIG, mapDisplayConfigFromEnvironment, parseYoudaoSecret
} from '../server/control/store';
import { decryptSecret, encryptSecret, hashPassword, masterKeyFrom, verifyPassword } from '../server/control/security';
import {
  authorizeWebRequest, createAccessApi, createAdminApi, createAmapProxyRateLimiter,
  proxyAmapServiceRequest, requestClientAddress, testOneMapCredential, testServiceCredential
} from '../server/control/admin-api';
import { refreshAddressCoverage } from '../server/control/coverage';

describe('control database security', () => {
  let database: PostgresDatabase;
  let store: ControlStore;
  const masterKey = Buffer.alloc(32, 7);

  beforeEach(async () => {
    database = openTestDatabase(':memory:', { migrate: false });
    await initializeTestDatabase(database, new URL('../server/control/schema.sql', import.meta.url));
    store = new ControlStore(database, masterKey);
    await store.initialize('correct horse battery staple');
  });
  afterEach(() => database.close());

  it.each(['deepl', 'amap'] as const)('responds to committed %s credential mutations without waiting for China sync', async (provider) => {
    const secret = provider === 'deepl' ? '00000000-0000-4000-8000-000000000001:fx' : 'map-fixture';
    const id = await store.addCredential({ provider, label: 'Mutation fixture', secret });
    const session = await store.createSession('admin');
    const headers = {
      Cookie: `address_admin_session=${session.token}; address_admin_csrf=${session.csrf}`,
      'X-CSRF-Token': session.csrf, 'Content-Type': 'application/json'
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const wake = vi.fn(() => gate);
    const admin = createAdminApi({ control: store, china: { wake } as never, addressDb: database });
    try {
      for (const method of ['PUT', 'DELETE']) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const response = await Promise.race([
          admin.request(`/admin/api/providers/${id}`, {
            method, headers, ...(method === 'PUT' ? { body: JSON.stringify({ label: 'Updated fixture' }) } : {})
          }),
          new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 500); })
        ]).finally(() => clearTimeout(timer));
        expect(response, `${method} must not wait for synchronization`).not.toBeNull();
        expect(response?.status).toBe(200);
      }
      expect(await store.listCredentials()).toEqual([]);
      if (provider === 'deepl') expect(wake).not.toHaveBeenCalled();
      else expect(wake).toHaveBeenCalled();
    } finally {
      release();
      await gate;
    }
  });

  it('hashes passwords and encrypts provider secrets', async () => {
    const password = await hashPassword('a sufficiently long password');
    expect(await verifyPassword('a sufficiently long password', password.hash, password.salt)).toBe(true);
    expect(await verifyPassword('different password', password.hash, password.salt)).toBe(false);
    const encrypted = encryptSecret('provider-secret-value', masterKey);
    expect(encrypted.ciphertext).not.toContain('provider-secret-value');
    expect(decryptSecret(encrypted, masterKey)).toBe('provider-secret-value');
    expect(masterKeyFrom(masterKey.toString('base64'))).toEqual(masterKey);
  });

  it('changes sync input revisions for credential configuration but not quota usage', async () => {
    const id = await store.addCredential({ provider: 'amap', label: 'revision', secret: 'revision-fixture' });
    const before = await store.credentialConfigurationRevision(['amap']);
    await store.reportCredential(id, 'success');
    expect(await store.credentialConfigurationRevision(['amap'])).toBe(before);
    await store.updateCredential(id, { secret: 'replacement-fixture' });
    expect(await store.credentialConfigurationRevision(['amap'])).not.toBe(before);
  });

  it('bootstraps the default administrator and optional frontend password only once', async () => {
    const freshDatabase = openTestDatabase(':memory:', { migrate: false });
    await initializeTestDatabase(freshDatabase, new URL('../server/control/schema.sql', import.meta.url));
    const freshStore = new ControlStore(freshDatabase, masterKey);
    try {
      await freshStore.initialize('admin', { FRONTEND_BOOTSTRAP_PASSWORD: '' });
      expect(await freshStore.verifyIdentity('admin', 'admin')).toBe(true);
      expect(await freshStore.status()).toMatchObject({
        initialized: true,
        frontendPasswordEnabled: false,
        passwordChangeRequired: true
      });
      await freshStore.initialize('replacement administrator password', {
        FRONTEND_BOOTSTRAP_PASSWORD: 'replacement frontend password'
      });
      expect(await freshStore.verifyIdentity('admin', 'admin')).toBe(true);
      expect(await freshStore.verifyIdentity('admin', 'replacement administrator password')).toBe(false);
      expect(await freshStore.verifyIdentity('frontend', 'replacement frontend password')).toBe(false);
      expect(await freshStore.status()).toMatchObject({ frontendPasswordEnabled: false });
      const session = await freshStore.createSession('admin');
      await freshStore.updateAccessSettings({
        adminPassword: 'new administrator password',
        adminPasswordConfirmation: 'new administrator password'
      }, session.token);
      expect(await freshStore.status()).toMatchObject({ passwordChangeRequired: false });
    } finally {
      await freshDatabase.close();
    }
  });

  it('requires the default administrator password to be changed before other admin operations', async () => {
    const freshDatabase = openTestDatabase(':memory:', { migrate: false });
    await initializeTestDatabase(freshDatabase, new URL('../server/control/schema.sql', import.meta.url));
    const freshStore = new ControlStore(freshDatabase, masterKey);
    try {
      await freshStore.initialize('admin');
      const admin = createAdminApi({ control: freshStore, china: {} as never, addressDb: freshDatabase });
      const login = await admin.request('/admin/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'admin' })
      });
      expect(login.status).toBe(200);
      expect(await login.json()).toEqual({ data: expect.objectContaining({ passwordChangeRequired: true }) });

      const session = await freshStore.createSession('admin');
      const cookie = `address_admin_session=${session.token}; address_admin_csrf=${session.csrf}`;
      const blocked = await admin.request('/admin/api/tokens', { headers: { Cookie: cookie } });
      expect(blocked.status).toBe(403);
      expect(await blocked.json()).toEqual({ error: 'ADMIN_PASSWORD_CHANGE_REQUIRED' });
      expect((await admin.request('/admin/api/settings/access', { headers: { Cookie: cookie } })).status).toBe(200);

      const changed = await admin.request('/admin/api/settings/access', {
        method: 'PUT',
        headers: { Cookie: cookie, 'X-CSRF-Token': session.csrf, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          adminPassword: 'new administrator password',
          adminPasswordConfirmation: 'new administrator password'
        })
      });
      expect(changed.status).toBe(200);
      expect(await changed.json()).toEqual({ data: expect.objectContaining({ passwordChangeRequired: false }) });
      expect((await admin.request('/admin/api/tokens', { headers: { Cookie: cookie } })).status).toBe(200);
    } finally {
      await freshDatabase.close();
    }
  });

  it('enables a configured frontend password during the first initialization', async () => {
    const freshDatabase = openTestDatabase(':memory:', { migrate: false });
    await initializeTestDatabase(freshDatabase, new URL('../server/control/schema.sql', import.meta.url));
    const freshStore = new ControlStore(freshDatabase, masterKey);
    try {
      await freshStore.initialize('custom administrator password', {
        FRONTEND_BOOTSTRAP_PASSWORD: 'custom frontend password'
      });
      expect(await freshStore.verifyIdentity('frontend', 'custom frontend password')).toBe(true);
      expect(await freshStore.status()).toMatchObject({
        frontendPasswordEnabled: true,
        passwordChangeRequired: false
      });
    } finally {
      await freshDatabase.close();
    }
  });

  it('tests OneMap with a bearer token without returning it', async () => {
    const token = 'fixture.onemap.token';
    const result = await testOneMapCredential(token, async (_input, init) => {
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${token}`);
      return Response.json({ found: 1, totalNumPages: 1, results: [{ POSTAL: '018989' }] });
    });
    expect(result).toEqual({ success: true, resultCount: 1, totalResults: 1, totalPages: 1 });
    expect(JSON.stringify(result)).not.toContain(token);
    await expect(testOneMapCredential(token, async () => {
      throw new Error(`failed with ${token}`);
    })).rejects.toMatchObject({ outcome: 'network', message: 'NETWORK_ERROR' });
  });

  it('creates protected sessions and encrypted API tokens', async () => {
    expect(await store.verifyIdentity('admin', 'correct horse battery staple')).toBe(true);
    const session = await store.createSession('admin');
    expect(await store.session(session.token, 'admin', session.csrf)).toBe(true);
    expect(await store.session(session.token, 'admin', 'wrong')).toBe(false);
    const created = await store.createApiToken({ name: 'integration', scopes: ['generate'], rateLimit: 3 });
    const stored = await database.prepare('SELECT token_hash,token_ciphertext,token_iv,token_tag FROM api_tokens WHERE id=?')
      .bind(created.id).first<Record<string, string>>();
    expect(JSON.stringify(stored)).not.toContain(created.token);
    expect(stored?.token_ciphertext).toBeTruthy();
    expect(await store.revealApiToken(created.id)).toEqual(created);
    expect(await store.authorizeApiToken(created.token, 'generate')).toMatchObject({ id: created.id });
    expect(await store.authorizeApiToken(created.token, 'read')).toBeNull();
    await store.revokeApiToken(created.id);
    expect(await store.authorizeApiToken(created.token, 'generate')).toBeNull();
    expect(await store.listApiTokens()).toEqual([]);
  });

  it('keeps an admin session for 30 days after its last use and renews it at most hourly', async () => {
    const day = 24 * 60 * 60 * 1000;
    const session = await store.createSession('admin');
    const frontend = await store.createSession('frontend');
    expect(Date.parse(session.expiresAt) - Date.now()).toBeGreaterThan(29.9 * day);
    expect(Date.parse(frontend.expiresAt) - Date.now()).toBeLessThan(1.01 * day);

    expect(await store.renewAdminSession(session.token)).toBeNull();
    const later = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const renewed = await store.renewAdminSession(session.token, later);
    expect(Date.parse(renewed || '')).toBe(later.getTime() + 30 * day);
    expect(await store.renewAdminSession(frontend.token, later)).toBeNull();
    // Past its expiry a session is gone for good.
    expect(await store.renewAdminSession(session.token, new Date(later.getTime() + 31 * day))).toBeNull();
  });

  it('sends 30-day admin cookies on login and renews them when an idle session is used again', async () => {
    const admin = createAdminApi({ control: store, china: {} as never, addressDb: database });
    const login = await admin.request('/admin/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'correct horse battery staple' })
    });
    expect(login.status).toBe(200);
    const cookies = login.headers.getSetCookie();
    expect(cookies.filter((cookie) => /^address_admin_(session|csrf)=/u.test(cookie) && cookie.includes('Max-Age=2592000'))).toHaveLength(2);
    const token = cookies.find((cookie) => cookie.startsWith('address_admin_session='))!.split(';')[0].split('=')[1];
    const csrf = cookies.find((cookie) => cookie.startsWith('address_admin_csrf='))!.split(';')[0].split('=')[1];
    const cookie = `address_admin_session=${token}; address_admin_csrf=${csrf}`;

    const fresh = await admin.request('/admin/api/tokens', { headers: { Cookie: cookie } });
    expect(fresh.status).toBe(200);
    expect(fresh.headers.getSetCookie()).toEqual([]);

    await database.prepare("UPDATE auth_sessions SET expires_at=? WHERE role='admin'")
      .bind(new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString()).run();
    const resumed = await admin.request('/admin/api/tokens', { headers: { Cookie: cookie } });
    expect(resumed.status).toBe(200);
    expect(resumed.headers.getSetCookie().filter((value) => value.includes('Max-Age=2592000'))).toHaveLength(2);
    const expiresAt = await database.prepare("SELECT expires_at FROM auth_sessions WHERE role='admin'").first<string>('expires_at');
    expect(Date.parse(expiresAt || '') - Date.now()).toBeGreaterThan(29.9 * 24 * 60 * 60 * 1000);
  });

  it('does not project a parent run error onto a child that has no source error', async () => {
    await database.prepare(`INSERT INTO sync_runs(
      id,kind,target_json,status,progress_json,error_code,error_message,created_at,completed_at,updated_at
    ) VALUES ('history-parent-error','address-pool','{}','failed','{}','PARENT_FAILED','parent failed',
      '2026-08-05T00:00:00Z','2026-08-05T01:00:00Z','2026-08-05T01:00:00Z')`).run();
    await database.prepare(`INSERT INTO sync_run_countries(
      run_id,country_code,source_id,trigger_name,status,error_code,error_message,created_at,completed_at,updated_at
    ) VALUES ('history-parent-error','US','oa-us','queue','cancelled',NULL,NULL,
      '2026-08-05T00:00:00Z','2026-08-05T01:00:00Z','2026-08-05T01:00:00Z')`).run();
    const history = await store.syncHistory();
    expect(history.items).toContainEqual(expect.objectContaining({
      id: 'history-parent-error', countryCode: 'US', sourceId: 'oa-us', errorCode: null, errorMessage: null
    }));
  });

  it('does not expose an unfinished goal snapshot as an empty completed snapshot', async () => {
    const beforeGoals = {
      total: { current: 19_533, target: 20_000, met: false },
      administrativeCoverage: { actual: 72, target: 90, met: false, covered: 146, total: 203 },
      regionalMinimums: {
        actual: 64, target: 100, met: false,
        lowest: { qualified: 64, total: 203, minimum: 5, met: false },
        level1: null, level2: null, overrides: { satisfied: 0, total: 0, met: true }
      }
    };
    await database.prepare(`INSERT INTO sync_runs(
      id,kind,target_json,status,progress_json,created_at,started_at,updated_at
    ) VALUES ('history-running-goals','address-pool','{}','running','{}',
      '2026-08-07T00:00:00Z','2026-08-07T00:00:00Z','2026-08-07T00:01:00Z')`).run();
    await database.prepare(`INSERT INTO sync_run_countries(
      run_id,country_code,source_id,trigger_name,status,before_goals_json,after_goals_json,
      created_at,started_at,updated_at
    ) VALUES ('history-running-goals','JP','japan-abr-residential','queue','running',?,'{}',
      '2026-08-07T00:00:00Z','2026-08-07T00:00:00Z','2026-08-07T00:01:00Z')`)
      .bind(JSON.stringify(beforeGoals)).run();

    const history = await store.syncHistory();
    expect(history.items).toContainEqual(expect.objectContaining({
      id: 'history-running-goals', countryCode: 'JP', beforeGoals, afterGoals: null
    }));
  });

  it('supports custom token values and editable scope, rate and expiry settings', async () => {
    const customToken = 'addr_custom_fixture_token_1234567890';
    const expiresAt = new Date(Date.now() + 86400000).toISOString();
    const created = await store.createApiToken({ name: 'custom', token: customToken, scopes: ['*'], rateLimit: 20, expiresAt });
    expect(created.token).toBe(customToken);
    expect(await store.listApiTokens()).toEqual([expect.objectContaining({
      id: created.id, name: 'custom', scopes: ['*'], rate_limit_per_minute: 20, expires_at: expiresAt, token_revealable: true
    })]);
    await store.updateApiToken(created.id, { scopes: ['read'], rateLimit: 7, expiresAt: null });
    expect(await store.listApiTokens()).toEqual([expect.objectContaining({
      id: created.id, scopes: ['read'], rate_limit_per_minute: 7, expires_at: null
    })]);
    expect((await store.authorizeApiTokenDetailed(customToken, 'read')).status).toBe('authorized');
    expect((await store.authorizeApiTokenDetailed(customToken, 'generate')).status).toBe('unauthorized');
    await expect(store.createApiToken({ name: 'duplicate', token: customToken, scopes: ['*'], rateLimit: 1 })).rejects.toThrow('TOKEN_ALREADY_EXISTS');
    await expect(store.createApiToken({ name: 'invalid', token: 'contains whitespace', scopes: ['*'], rateLimit: 1 })).rejects.toThrow('INVALID_TOKEN_VALUE');
  });

  it('keeps the current admin session when changing the password', async () => {
    const current = await store.createSession('admin');
    const other = await store.createSession('admin');
    await store.setPassword('admin', 'new administrator password', current.token);
    expect(await store.verifyIdentity('admin', 'new administrator password')).toBe(true);
    expect(await store.session(current.token, 'admin', current.csrf)).toBe(true);
    expect(await store.session(other.token, 'admin', other.csrf)).toBe(false);
  });

  it('refreshes CSRF state for an existing session', async () => {
    const session = await store.createSession('admin');
    const refreshed = await store.refreshSessionCsrf(session.token, 'admin');
    expect(refreshed).toBeTruthy();
    expect(await store.session(session.token, 'admin', session.csrf)).toBe(false);
    expect(await store.session(session.token, 'admin', refreshed || '')).toBe(true);
  });

  it('updates access settings atomically and retains only the current admin session', async () => {
    const current = await store.createSession('admin');
    const other = await store.createSession('admin');
    await store.updateAccessSettings({
      frontendPasswordEnabled: true,
      frontendPassword: 'new frontend password',
      frontendPasswordConfirmation: 'new frontend password',
      adminPassword: 'new administrator password',
      adminPasswordConfirmation: 'new administrator password'
    }, current.token);
    expect(await store.status()).toMatchObject({ frontendPasswordEnabled: true, apiAuthEnabled: true });
    expect(await store.verifyIdentity('frontend', 'new frontend password')).toBe(true);
    expect(await store.verifyIdentity('admin', 'new administrator password')).toBe(true);
    expect(await store.session(current.token, 'admin', current.csrf)).toBe(true);
    expect(await store.session(other.token, 'admin', other.csrf)).toBe(false);
  });

  it('persists four independent map display switches without restart overrides', async () => {
    expect(await store.mapDisplayConfig()).toEqual(DEFAULT_MAP_DISPLAY_CONFIG);
    const configured = {
      google: { china: false, international: true },
      amap: { china: true, international: false }
    };
    expect(await store.updateMapDisplayConfig(configured)).toEqual(configured);
    await expect(store.updateMapDisplayConfig({ google: { china: true } })).rejects.toThrow('INVALID_MAP_DISPLAY_CONFIG');
    await store.initialize(undefined, {
      MAP_GOOGLE_CHINA_ENABLED: 'true', MAP_GOOGLE_INTERNATIONAL_ENABLED: 'false',
      MAP_AMAP_CHINA_ENABLED: 'false', MAP_AMAP_INTERNATIONAL_ENABLED: 'true'
    });
    expect(await store.mapDisplayConfig()).toEqual(configured);
    expect(mapDisplayConfigFromEnvironment({
      MAP_GOOGLE_CHINA_ENABLED: 'off', MAP_GOOGLE_INTERNATIONAL_ENABLED: 'yes',
      MAP_AMAP_CHINA_ENABLED: '1', MAP_AMAP_INTERNATIONAL_ENABLED: '0'
    })).toEqual(configured);
  });

  it('encrypts the dedicated AMap browser credential and keeps it outside provider rotation', async () => {
    await store.createBrowserMapCredential({ label: 'Frontend map', apiKey: 'browser-js-key', securityCode: 'browser-security-code' });
    const row = await database.prepare(`SELECT api_key_ciphertext,security_code_ciphertext FROM browser_map_credentials WHERE provider='amap'`)
      .first<{ api_key_ciphertext: string; security_code_ciphertext: string }>();
    expect(JSON.stringify(row)).not.toContain('browser-js-key');
    expect(JSON.stringify(row)).not.toContain('browser-security-code');
    expect(JSON.stringify(await store.browserMapCredentialStatus())).not.toContain('browser-js-key');
    expect(await store.browserMapCredentialStatus()).toMatchObject({ configured: true, enabled: true, label: 'Frontend map', mask: '••••-key' });
    expect(await store.availableProviders()).toEqual([]);
    expect(await store.acquireBrowserMapCredential()).toEqual({ apiKey: 'browser-js-key', securityCode: 'browser-security-code' });
    await store.updateBrowserMapCredential({ apiKey: '', securityCode: '', enabled: false });
    expect(await store.acquireBrowserMapCredential()).toBeNull();
    expect(await store.browserMapCredentialStatus()).toMatchObject({ configured: true, enabled: false, status: 'disabled' });
    await store.updateBrowserMapCredential({ enabled: true, securityCode: 'replacement-security-code' });
    expect(await store.acquireBrowserMapCredential()).toEqual({ apiKey: 'browser-js-key', securityCode: 'replacement-security-code' });
    await store.deleteBrowserMapCredential();
    expect(await store.browserMapCredentialStatus()).toMatchObject({ configured: false, enabled: false });
  });

  it('requires matching password confirmations before changing access settings', async () => {
    const current = await store.createSession('admin');
    await expect(store.updateAccessSettings({
      frontendPassword: 'replacement frontend password',
      frontendPasswordConfirmation: 'different frontend password'
    }, current.token)).rejects.toThrow('PASSWORD_CONFIRM_MISMATCH');
    expect(await store.verifyIdentity('frontend', 'replacement frontend password')).toBe(false);
  });

  it('imports browser-map environment values only into an empty control database', async () => {
    const fresh = openTestDatabase(':memory:', { migrate: false });
    try {
      await initializeTestDatabase(fresh, new URL('../server/control/schema.sql', import.meta.url));
      const freshStore = new ControlStore(fresh, masterKey);
      await freshStore.initialize('fresh administrator password', {
        AMAP_JS_API_KEY: 'environment-js-key', AMAP_JS_SECURITY_CODE: 'environment-security-code',
        MAP_GOOGLE_CHINA_ENABLED: 'false', MAP_AMAP_INTERNATIONAL_ENABLED: 'true'
      });
      expect(await freshStore.mapDisplayConfig()).toEqual({
        google: { china: false, international: true }, amap: { china: false, international: true }
      });
      expect(await freshStore.acquireBrowserMapCredential()).toEqual({ apiKey: 'environment-js-key', securityCode: 'environment-security-code' });
      await freshStore.updateMapDisplayConfig({ google: { china: true, international: false }, amap: { china: true, international: false } });
      await freshStore.updateBrowserMapCredential({ apiKey: 'database-js-key', securityCode: 'database-security-code' });
      await freshStore.initialize(undefined, {
        AMAP_JS_API_KEY: 'replacement-env-key', AMAP_JS_SECURITY_CODE: 'replacement-env-code',
        MAP_GOOGLE_CHINA_ENABLED: 'false', MAP_AMAP_INTERNATIONAL_ENABLED: 'true'
      });
      expect(await freshStore.mapDisplayConfig()).toEqual({ google: { china: true, international: false }, amap: { china: true, international: false } });
      expect(await freshStore.acquireBrowserMapCredential()).toEqual({ apiKey: 'database-js-key', securityCode: 'database-security-code' });
    } finally { fresh.close(); }
  });

  it('returns country-scoped public map configuration without the security code', async () => {
    await store.updateMapDisplayConfig({ google: { china: false, international: true }, amap: { china: true, international: false } });
    await store.addCredential({ provider: 'amap', label: 'WebService', secret: 'server-webservice-key' });
    await store.createBrowserMapCredential({ apiKey: 'public-browser-key', securityCode: 'private-security-code' });
    const app = createAccessApi(store);
    const chinaResponse = await app.request('/web-api/v1/config/maps?country=CN');
    const chinaBody = await chinaResponse.json() as { data: Record<string, unknown> };
    expect(chinaBody.data).toEqual({
      countryCode: 'CN', googleEnabled: false, amapEnabled: true, amapConfigured: true,
      amapApiKey: 'public-browser-key', serviceHost: '/_AMapService'
    });
    expect(JSON.stringify(chinaBody)).not.toContain('private-security-code');
    expect(JSON.stringify(chinaBody)).not.toContain('server-webservice-key');
    const usBody = await (await app.request('/web-api/v1/config/maps?country=US')).json() as { data: Record<string, unknown> };
    expect(usBody.data).toEqual({ countryCode: 'US', googleEnabled: true, amapEnabled: false, amapConfigured: true });
    await store.updateBrowserMapCredential({ enabled: false });
    const disabled = await (await app.request('/web-api/v1/config/maps?country=CN')).json() as { data: Record<string, unknown> };
    expect(disabled.data).toEqual({ countryCode: 'CN', googleEnabled: false, amapEnabled: false, amapConfigured: true });
    expect((await app.request('/web-api/v1/config/maps')).status).toBe(400);
    await store.setPassword('frontend', 'frontend map password');
    await store.setSetting('frontend_password_enabled', true);
    expect((await app.request('/web-api/v1/config/maps?country=CN')).status).toBe(401);
    const session = await store.createSession('frontend');
    const protectedResponse = await app.request('/web-api/v1/config/maps?country=CN', {
      headers: { Cookie: `address_front_session=${session.token}` }
    });
    expect(protectedResponse.status).toBe(200);
    expect(JSON.stringify(await protectedResponse.json())).not.toContain('private-security-code');
  });

  it('serves, updates, audits, and resets country shortcut configuration', async () => {
    const access = createAccessApi(store);
    const defaults = await (await access.request('/web-api/v1/config/country-shortcuts')).json() as {
      data: Record<string, { popularCities: unknown[]; adminShortcuts: unknown[]; specialAreas: unknown[] }>;
    };
    expect(defaults.data.US.specialAreas).toHaveLength(5);
    expect(defaults.data.CN.popularCities.length).toBeGreaterThanOrEqual(10);

    const session = await store.createSession('admin');
    const admin = createAdminApi({ control: store, china: {} as never, addressDb: database });
    const headers = {
      Cookie: `address_admin_session=${session.token}; address_admin_csrf=${session.csrf}`,
      'X-CSRF-Token': session.csrf,
      'Content-Type': 'application/json'
    };
    expect((await admin.request('/admin/api/settings/country-shortcuts')).status).toBe(401);
    await database.batch([
      database.prepare(`INSERT INTO catalog_regions(id,country_code,code,name,native_name,zh_name,type,parent_id,path)
        VALUES (5001,'US','CA','California','California','加利福尼亚州','state',NULL,'/5001')`),
      database.prepare(`INSERT INTO catalog_cities(id,country_code,region_id,name,native_name,zh_name,type,population)
        VALUES (5002,'US',5001,'Los Angeles','Los Angeles','洛杉矶','city',3898747)`),
      database.prepare(`INSERT INTO residential_coverage(country_code,region_name,city_name,address_count,last_verified_at,region_id,city_id)
        VALUES ('US','California','Los Angeles',7,?,5001,5002)`).bind(new Date().toISOString())
    ]);
    for (let index = 0; index < 7; index += 1) {
      const id = `shortcut-fixture-${index}`;
      await database.prepare(`INSERT INTO address_pool(id,country_code,street,latitude,longitude,native_language,
        component_variants_json,address_variants_json,quality_score,generation,coverage,random_key,first_seen_at,last_seen_at)
        VALUES (?,'US','Fixture Road',34,-118,'en','{}','{}',.95,'fixture','fixture',1,'2026-01-01','2026-01-01')`).bind(id).run();
      await database.prepare(`INSERT INTO address_generation_index(address_id,country_code,admin1_key,
        admin1_code_key,locality_key,postal_locality_key,random_key,updated_at)
        VALUES (?,'US','california','ca','los angeles','los angeles',1,'2026-01-01')`).bind(id).run();
    }
    const optionResponse = await admin.request('/admin/api/settings/country-shortcuts/US/options?field=region', { headers });
    expect(optionResponse.status).toBe(200);
    expect(await optionResponse.json()).toEqual({ data: expect.objectContaining({
      total: 1,
      options: [expect.objectContaining({ value: 'California', regionCode: 'CA', availableCount: 7, disabled: false })]
    }) });
    expect((await admin.request('/admin/api/settings/country-shortcuts/ZZ/options?field=region', { headers })).status).toBe(400);
    expect((await admin.request('/admin/api/settings/country-shortcuts/US/options?field=district', { headers })).status).toBe(400);
    const original = (await store.countryShortcuts()).CN;
    const update = { ...original, popularCities: [{ label: { en: 'Beijing', 'zh-CN': '北京' }, value: '北京市', type: 'city' }] };
    expect((await admin.request('/admin/api/settings/country-shortcuts/CN', {
      method: 'PUT', headers, body: JSON.stringify(update)
    })).status).toBe(200);
    expect((await store.countryShortcuts()).CN.popularCities).toHaveLength(1);
    expect(JSON.stringify(await store.audits())).toContain('settings.country_shortcuts.update');

    const invalid = { ...original, popularCities: [{ label: { en: 'Beijing', 'zh-CN': '北京' }, value: '北京市', type: 'region' }] };
    expect((await admin.request('/admin/api/settings/country-shortcuts/CN', {
      method: 'PUT', headers, body: JSON.stringify(invalid)
    })).status).toBe(400);
    expect((await admin.request('/admin/api/settings/country-shortcuts/CN', { method: 'DELETE', headers })).status).toBe(200);
    expect((await store.countryShortcuts()).CN.popularCities.length).toBeGreaterThanOrEqual(10);
  });

  it('serves only public residential coverage fields behind the frontend access policy', async () => {
    const addressDb = openTestDatabase(':memory:');
    try {
      const now = new Date().toISOString();
      await addressDb.batch([
        addressDb.prepare(`INSERT INTO catalog_regions(id,country_code,code,name,native_name,zh_name,type,parent_id,path)
          VALUES (1,'US','NY','New York','New York','纽约州','state',NULL,'/1')`),
        addressDb.prepare(`INSERT INTO catalog_cities(id,country_code,region_id,name,native_name,zh_name,type,population)
          VALUES (11,'US',1,'New York City','New York City','纽约市','city',8000000)`),
        addressDb.prepare(`INSERT INTO residential_coverage(country_code,region_name,city_name,address_count,last_verified_at,region_id,city_id)
          VALUES ('US','New York','New York City',5,?,1,11)`).bind(now)
      ]);
      await refreshAddressCoverage(addressDb);
      const app = createAccessApi(store, { addressDb });
      const response = await app.request('/web-api/v1/public-monitor');
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('private, max-age=60');
      const payload = await response.json() as { data: Record<string, unknown> };
      expect(payload.data).toMatchObject({ metrics: expect.objectContaining({ addressTotal: 0, residentialTotal: 0, coverageRate: 1 }) });
      expect(JSON.stringify(payload)).not.toMatch(/database|credential|provider|quota|secret|token/iu);
      await store.setPassword('frontend', 'frontend monitor password');
      await store.setSetting('frontend_password_enabled', true);
      expect((await app.request('/web-api/v1/public-monitor')).status).toBe(401);
      const session = await store.createSession('frontend');
      expect((await app.request('/web-api/v1/public-monitor', {
        headers: { Cookie: `address_front_session=${session.token}` }
      })).status).toBe(200);
    } finally { addressDb.close(); }
  });

  it('supports Google-only, AMap-only, dual and disabled map configurations for China and overseas', async () => {
    await store.createBrowserMapCredential({ apiKey: 'browser-map-key', securityCode: 'server-only-code' });
    const app = createAccessApi(store);
    const scenarios = [
      { google: true, amap: false },
      { google: false, amap: true },
      { google: true, amap: true },
      { google: false, amap: false }
    ];
    for (const scenario of scenarios) {
      await store.updateMapDisplayConfig({
        google: { china: scenario.google, international: scenario.google },
        amap: { china: scenario.amap, international: scenario.amap }
      });
      for (const country of ['CN', 'US']) {
        const body = await (await app.request(`/web-api/v1/config/maps?country=${country}`)).json() as { data: Record<string, unknown> };
        expect(body.data).toMatchObject({ countryCode: country, googleEnabled: scenario.google, amapEnabled: scenario.amap });
        expect(Object.hasOwn(body.data, 'amapApiKey')).toBe(scenario.amap);
        expect(JSON.stringify(body)).not.toContain('server-only-code');
      }
    }
  });

  it('proxies only fixed AMap service paths with the server-side security code', async () => {
    await store.updateMapDisplayConfig({ google: { china: true, international: true }, amap: { china: true, international: false } });
    await store.createBrowserMapCredential({ apiKey: 'browser-js-key', securityCode: 'private-jscode' });
    let upstream = '';
    const response = await proxyAmapServiceRequest(store, new Request(
      'https://address.example/_AMapService/v3/place/text?key=browser-js-key&keywords=home&jscode=client-value',
      { headers: { Referer: 'https://address.example/' } }
    ), async (input) => {
      upstream = String(input);
      return Response.json({ status: '1', debug: 'private-jscode' }, {
        headers: { 'Cache-Control': 'max-age=60', ETag: 'upstream-tag', Expires: 'tomorrow' }
      });
    }, 'https://address.example');
    expect(response.status).toBe(200);
    const upstreamUrl = new URL(upstream);
    expect(upstreamUrl.origin).toBe('https://restapi.amap.com');
    expect(upstreamUrl.pathname).toBe('/v3/place/text');
    expect(upstreamUrl.searchParams.get('key')).toBe('browser-js-key');
    expect(upstreamUrl.searchParams.get('jscode')).toBe('private-jscode');
    expect(await response.text()).not.toContain('private-jscode');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('pragma')).toBe('no-cache');
    expect(response.headers.get('expires')).toBe('0');
    expect(response.headers.get('etag')).toBeNull();
    const style = await proxyAmapServiceRequest(store, new Request(
      'https://address.example/_AMapService/v4/map/styles?key=browser-js-key', { headers: { Origin: 'https://address.example' } }
    ), async (input) => {
      expect(new URL(String(input)).origin).toBe('https://webapi.amap.com');
      return Response.json({ ok: true });
    }, 'https://address.example');
    expect(style.status).toBe(200);
    const telemetry = await proxyAmapServiceRequest(store, new Request(
      'https://address.example/_AMapService/v3/log/init?eventId=resource.load&s=rsv3'
    ), async () => { throw new Error('telemetry must not reach AMap'); }, 'https://address.example');
    expect(telemetry.status).toBe(200);
    expect(telemetry.headers.get('content-type')).toContain('javascript');
    expect(await telemetry.text()).toBe('');
    const vectorBytes = new Uint8Array([0, 255, 1, 2]);
    const vector = await proxyAmapServiceRequest(store, new Request(
      'https://address.example/_AMapService/v3/vectormap?key=browser-js-key&z=4', { headers: { Origin: 'https://address.example' } }
    ), async (input) => {
      expect(new URL(String(input)).origin).toBe('https://fmap01.amap.com');
      expect(new URL(String(input)).pathname).toBe('/v3/vectormap');
      return new Response(vectorBytes, { headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'public,max-age=3600' } });
    }, 'https://address.example');
    expect([...new Uint8Array(await vector.arrayBuffer())]).toEqual([...vectorBytes]);
    expect(vector.headers.get('cache-control')).toBe('private, no-store');
    expect((await proxyAmapServiceRequest(store, new Request(
      'https://address.example/_AMapService/v3/vectormap/extra?key=browser-js-key', { headers: { Origin: 'https://address.example' } }
    ), async () => Response.json({ ok: true }), 'https://address.example')).status).toBe(404);
    expect((await proxyAmapServiceRequest(store, new Request(
      'https://attacker.example/_AMapService/v3/place/text?key=browser-js-key', { headers: { Origin: 'https://attacker.example' } }
    ), async () => Response.json({ ok: true }), 'https://address.example')).status).toBe(403);
    expect((await proxyAmapServiceRequest(store, new Request(
      'https://address.example/_AMapService/v3/place/text?key=browser-js-key', { headers: { Origin: 'http://address.example' } }
    ), async () => Response.json({ ok: true }), 'https://address.example')).status).toBe(403);
    expect((await proxyAmapServiceRequest(store, new Request(
      'https://address.example/_AMapService/v3/place/text?key=browser-js-key', { headers: { Origin: 'https://address.example' } }
    ), async () => new Response('<html>no</html>', { headers: { 'Content-Type': 'text/html' } }), 'https://address.example')).status).toBe(502);
    expect((await proxyAmapServiceRequest(store, new Request(
      'https://address.example/_AMapService/v3/place/text?key=wrong', { headers: { Referer: 'https://address.example/' } }
    ))).status).toBe(403);
    expect((await proxyAmapServiceRequest(store, new Request(
      'https://address.example/_AMapService/v3/place/text?key=browser-js-key', { headers: { Origin: 'https://other.example' } }
    ))).status).toBe(403);
    expect((await proxyAmapServiceRequest(store, new Request(
      'https://address2.example/_AMapService/v3/place/text?key=browser-js-key', { headers: { Origin: 'https://address2.example' } }
    ), async () => Response.json({ status: '1' }), 'https://address.example,https://address2.example')).status).toBe(200);
    expect((await proxyAmapServiceRequest(store, new Request(
      'https://address.example/_AMapService/v3/place/text?key=browser-js-key', { headers: { Origin: 'https://address2.example' } }
    ), async () => Response.json({ status: '1' }), 'https://address.example,https://address2.example')).status).toBe(403);
    expect((await proxyAmapServiceRequest(store, new Request(
      'https://address.example/_AMapService/private?key=browser-js-key', { headers: { Referer: 'https://address.example/' } }
    ))).status).toBe(404);
    await store.updateMapDisplayConfig({ google: { china: true, international: true }, amap: { china: false, international: false } });
    expect((await proxyAmapServiceRequest(store, new Request(
      'https://address.example/_AMapService/v3/place/text?key=browser-js-key', { headers: { Referer: 'https://address.example/' } }
    ))).status).toBe(404);
  });

  it('keeps map administrator responses masked and audit details secret-free', async () => {
    const session = await store.createSession('admin');
    const wake = vi.fn(async () => undefined);
    const admin = createAdminApi({
      control: store,
      china: { wake } as never,
      addressDb: database
    });
    const headers = {
      Cookie: `address_admin_session=${session.token}; address_admin_csrf=${session.csrf}`,
      'X-CSRF-Token': session.csrf,
      'Content-Type': 'application/json'
    };
    expect((await admin.request('/admin/api/settings/maps')).status).toBe(401);
    expect((await admin.request('/admin/api/settings/maps', {
      method: 'PUT', headers: { Cookie: headers.Cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ google: { china: true, international: false }, amap: { china: true, international: false } })
    })).status).toBe(401);
    const browserLabel = 'browser-label-secret-sentinel';
    const created = await admin.request('/admin/api/maps/amap-browser', {
      method: 'POST', headers, body: JSON.stringify({ label: browserLabel, apiKey: 'admin-browser-key', securityCode: 'admin-security-code' })
    });
    expect(created.status).toBe(201);
    expect(JSON.stringify(await created.json())).not.toContain('admin-browser-key');
    const updated = await admin.request('/admin/api/settings/maps', {
      method: 'PUT', headers, body: JSON.stringify({ google: { china: true, international: false }, amap: { china: true, international: false } })
    });
    expect(updated.status).toBe(200);
    const settings = await (await admin.request('/admin/api/settings/maps', { headers: { Cookie: headers.Cookie } })).json();
    expect(JSON.stringify(settings)).not.toContain('admin-browser-key');
    expect(JSON.stringify(settings)).not.toContain('admin-security-code');
    const providerLabel = 'provider-label-secret-sentinel';
    const providerSecret = 'provider-secret-sentinel';
    expect((await admin.request('/admin/api/providers', {
      method: 'POST', headers, body: JSON.stringify({ provider: 'amap', label: providerLabel, secret: providerSecret })
    })).status).toBe(201);
    expect(wake).toHaveBeenCalledOnce();
    const audits = JSON.stringify(await store.audits());
    for (const secret of ['admin-browser-key', 'admin-security-code', browserLabel, providerLabel, providerSecret]) {
      expect(audits).not.toContain(secret);
    }
  });

  it('reveals encrypted credentials only through the authenticated CSRF-protected admin routes', async () => {
    const session = await store.createSession('admin');
    const admin = createAdminApi({ control: store, china: {} as never, addressDb: database });
    const headers = {
      Cookie: `address_admin_session=${session.token}; address_admin_csrf=${session.csrf}`,
      'X-CSRF-Token': session.csrf,
      'Content-Type': 'application/json'
    };
    await store.createBrowserMapCredential({ apiKey: 'reveal-browser-key', securityCode: 'reveal-browser-code' });
    const providerId = await store.addCredential({ provider: 'amap', label: 'reveal-provider', secret: 'reveal-provider-secret' });
    const unauthenticated = await admin.request(`/admin/api/providers/${providerId}/reveal`, { method: 'POST' });
    expect(unauthenticated.status).toBe(401);
    const missingCsrf = await admin.request(`/admin/api/providers/${providerId}/reveal`, { method: 'POST', headers: { Cookie: headers.Cookie } });
    expect(missingCsrf.status).toBe(401);
    const providerResponse = await admin.request(`/admin/api/providers/${providerId}/reveal`, { method: 'POST', headers });
    expect(providerResponse.status).toBe(200);
    expect(await providerResponse.json()).toEqual({ data: { id: providerId, secret: 'reveal-provider-secret' } });
    expect(providerResponse.headers.get('cache-control')).toContain('no-store');
    const browserResponse = await admin.request('/admin/api/maps/amap-browser/reveal', { method: 'POST', headers });
    expect(browserResponse.status).toBe(200);
    expect(await browserResponse.json()).toEqual({ data: { apiKey: 'reveal-browser-key', securityCode: 'reveal-browser-code' } });
    expect(browserResponse.headers.get('cache-control')).toContain('no-store');
    const token = await store.createApiToken({ name: 'reveal-token', token: 'addr_reveal_fixture_token_123456', scopes: ['*'], rateLimit: 60 });
    expect((await admin.request(`/admin/api/tokens/${token.id}/reveal`, { method: 'POST' })).status).toBe(401);
    const tokenMissingCsrf = await admin.request(`/admin/api/tokens/${token.id}/reveal`, { method: 'POST', headers: { Cookie: headers.Cookie } });
    expect(tokenMissingCsrf.status).toBe(401);
    const tokenResponse = await admin.request(`/admin/api/tokens/${token.id}/reveal`, { method: 'POST', headers });
    expect(tokenResponse.status).toBe(200);
    expect(await tokenResponse.json()).toEqual({ data: token });
    expect(tokenResponse.headers.get('cache-control')).toContain('no-store');
    const updatedToken = await admin.request(`/admin/api/tokens/${token.id}`, {
      method: 'PUT', headers, body: JSON.stringify({ scopes: ['read'], rateLimit: 12, expiresAt: null })
    });
    expect(updatedToken.status).toBe(200);
    expect((await updatedToken.json()).data).toEqual([expect.objectContaining({ id: token.id, scopes: ['read'], rate_limit_per_minute: 12, expires_at: null })]);
  });

  it('uses trusted client addresses only when proxy trust is enabled and throttles bursts', () => {
    const request = new Request('https://address.example/', {
      headers: { 'X-Forwarded-For': '198.51.100.20, 10.0.0.1', 'X-Real-IP': '192.0.2.30' }
    });
    expect(requestClientAddress(request, '203.0.113.10', false)).toBe('203.0.113.10');
    expect(requestClientAddress(request, '203.0.113.10', true)).toBe('192.0.2.30');
    expect(requestClientAddress(new Request('https://address.example/', {
      headers: { 'X-Forwarded-For': '198.51.100.20, 10.0.0.1' }
    }), '203.0.113.10', true)).toBe('10.0.0.1');
    const limited = createAmapProxyRateLimiter(2, 1000);
    expect(limited('203.0.113.10', 100)).toBe(true);
    expect(limited('203.0.113.10', 200)).toBe(true);
    expect(limited('203.0.113.10', 300)).toBe(false);
    expect(limited('203.0.113.10', 1100)).toBe(true);
  });

  it('requires a frontend session for protected AMap proxy requests', async () => {
    await store.setPassword('frontend', 'frontend proxy password');
    await store.setSetting('frontend_password_enabled', true);
    const request = new Request('https://address.example/_AMapService/v3/place/text');
    expect(await authorizeWebRequest(store, request)).toBe(false);
    expect(await authorizeWebRequest(store, new Request(request, { headers: { Cookie: 'address_front_session=%invalid' } }))).toBe(false);
    const session = await store.createSession('frontend');
    expect(await authorizeWebRequest(store, new Request(request, {
      headers: { Cookie: `address_front_session=${encodeURIComponent(session.token)}` }
    }))).toBe(true);
  });

  it('does not partially update access settings when password validation fails', async () => {
    await store.setPassword('frontend', 'original frontend password');
    await expect(store.updateAccessSettings({
      frontendPasswordEnabled: true,
      frontendPassword: 'replacement frontend password',
      frontendPasswordConfirmation: 'replacement frontend password',
      adminPassword: 'short',
      adminPasswordConfirmation: 'short'
    }, '')).rejects.toThrow('PASSWORD_LENGTH');
    expect(await store.status()).toMatchObject({ frontendPasswordEnabled: false });
    expect(await store.verifyIdentity('frontend', 'original frontend password')).toBe(true);
    expect(await store.verifyIdentity('frontend', 'replacement frontend password')).toBe(false);
  });

  it('rotates credentials by quota and health without exposing secret values', async () => {
    const first = await store.addCredential({ provider: 'amap', label: 'A', secret: 'key-a', dailyLimit: 1 });
    const second = await store.addCredential({ provider: 'amap', label: 'B', secret: 'key-b', dailyLimit: 10 });
    const listing = await store.listCredentials();
    expect(JSON.stringify(listing)).not.toContain('key-a');
    expect(listing[0]).not.toHaveProperty('qpsLimit');
    expect(listing[0]).not.toHaveProperty('dailyLimit');
    expect(listing[0]).not.toHaveProperty('quotaScopeId');
    expect(await store.availableProviders()).toEqual(['amap']);
    const acquired = await store.acquireCredential('amap');
    expect(acquired?.id).toBe(first);
    await store.reportCredential(first, 'quota');
    expect((await store.acquireCredential('amap'))?.id).toBe(second);
    await store.reportCredential(second, 'auth');
    expect(await store.acquireCredential('amap')).toBeNull();
  });

  it('serializes direct credential reports without losing failure increments', async () => {
    const id = await store.addCredential({ provider: 'amap', label: 'Concurrent report', secret: 'report-key' });
    const query = database.query.bind(database);
    let reads = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const transaction = database.transaction.bind(database);
    let transactionTail = Promise.resolve();
    database.transaction = async (work) => {
      const previous = transactionTail;
      let unlock!: () => void;
      transactionTail = new Promise<void>((resolve) => { unlock = resolve; });
      await previous;
      try { return await transaction(work); }
      finally { unlock(); }
    };
    database.query = async (statement, bindings) => {
      const result = await query(statement, bindings);
      if (String(statement).startsWith('SELECT * FROM provider_credentials WHERE id=')
        && !String(statement).includes('FOR UPDATE')) {
        reads += 1;
        if (reads === 2) release();
        await barrier;
      }
      return result;
    };
    await Promise.all([store.reportCredential(id, 'network'), store.reportCredential(id, 'network')]);
    expect(await database.prepare('SELECT failure_count FROM provider_credentials WHERE id=?').bind(id).first('failure_count')).toBe(2);
    expect(await database.prepare('SELECT rejected_count FROM provider_usage_daily WHERE credential_id=?').bind(id).first('rejected_count')).toBe(2);
  });

  it('atomically leases one credential across concurrent direct acquisitions', async () => {
    const id = await store.addCredential({ provider: 'amap', label: 'Concurrent lease', secret: 'lease-key', qpsLimit: 1 });
    const query = database.query.bind(database);
    let reads = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const transaction = database.transaction.bind(database);
    let transactionTail = Promise.resolve();
    database.transaction = async (work) => {
      const previous = transactionTail;
      let unlock!: () => void;
      transactionTail = new Promise<void>((resolve) => { unlock = resolve; });
      await previous;
      try { return await transaction(work); }
      finally { unlock(); }
    };
    database.query = async (statement, bindings) => {
      const result = await query(statement, bindings);
      if (String(statement).startsWith('SELECT * FROM provider_credentials credential WHERE credential.provider=')
        && !String(statement).includes('FOR UPDATE')) {
        reads += 1;
        if (reads === 2) release();
        await barrier;
      }
      return result;
    };
    const acquired = await Promise.all([store.acquireCredential('amap'), store.acquireCredential('amap')]);
    expect(acquired.filter(Boolean)).toHaveLength(1);
    expect(acquired.find((value) => value)?.id).toBe(id);
  });

  it('excludes credentials already attempted in the current rotation for every provider type', async () => {
    const first = await store.addCredential({ provider: 'geoapify', label: 'A', secret: 'geo-key-a', qpsLimit: 100 });
    const second = await store.addCredential({ provider: 'geoapify', label: 'B', secret: 'geo-key-b', qpsLimit: 100 });
    expect((await store.acquireCredential('geoapify'))?.id).toBe(first);
    expect((await store.acquireCredential('geoapify', { excludeIds: [first] }))?.id).toBe(second);
    expect(await store.acquireCredential('geoapify', { excludeIds: new Set([first, second]) })).toBeNull();
  });

  it('uses provider-reported quota when the platform exposes it', async () => {
    const id = await store.addCredential({ provider: 'tencent', label: 'Reported', secret: 'reported-key' });
    await store.reportCredential(id, 'success', { used: 199, limit: 200 });
    expect(await store.listCredentials()).toMatchObject([{
      id, quotaUsed: 199, quotaLimit: 200, quotaRemaining: 1, quotaUsageSource: 'provider', quotaPeriod: 'day'
    }]);
    await store.reportCredential(id, 'success', { used: 200, limit: 200 });
    expect(await store.listCredentials()).toMatchObject([{ id, status: 'quota_exhausted', quotaRemaining: 0 }]);
    expect(await store.acquireCredentialById(id)).toBeNull();
  });

  it('blocks a key when any independent quota window is exhausted', async () => {
    const id = await store.addCredential({ provider: 'amap', label: 'Multi-window', secret: 'multi-window-key', quotaLimit: 10 });
    const row = await database.prepare('SELECT quota_scope_id,quota_service FROM provider_credentials WHERE id=?')
      .bind(id).first<{ quota_scope_id: string; quota_service: string }>();
    const now = new Date().toISOString();
    await database.prepare(`INSERT INTO provider_quota_windows(
      credential_id,service,scope_id,period,limit_count,timezone_offset,source,enabled,created_at,updated_at
    ) VALUES (?,?,?,?,?,480,'provider',1,?,?)`).bind(
      id, row!.quota_service, row!.quota_scope_id, 'day', 1, now, now
    ).run();
    await store.reportCredential(id, 'success');
    expect(await store.acquireCredentialById(id)).toBeNull();
    expect(await store.listCredentials()).toEqual([expect.objectContaining({
      status: 'quota_exhausted',
      quotaWindows: expect.arrayContaining([
        expect.objectContaining({ period: 'day', used: 1, limit: 1, exhausted: true }),
        expect.objectContaining({ period: 'month', used: 1, limit: 10, exhausted: false })
      ])
    })]);
  });

  it('creates and enforces a provider-reported daily window for a monthly AMap key', async () => {
    const id = await store.addCredential({ provider: 'amap', label: 'AMap daily error', secret: 'amap-daily-key' });
    const resetAt = new Date(Date.now() + 60_000).toISOString();
    await store.reportCredential(id, 'quota', { period: 'day', service: 'place-search-v5', retryAt: resetAt });
    expect(await store.acquireCredentialById(id)).toBeNull();
    expect(await store.listCredentials()).toEqual([expect.objectContaining({
      status: 'quota_exhausted',
      quotaWindows: expect.arrayContaining([
        expect.objectContaining({ period: 'day', exhausted: true, resetAt }),
        expect.objectContaining({ period: 'month', exhausted: false })
      ])
    })]);
  });

  it('projects legacy quota blocks into the primary quota window', async () => {
    const id = await store.addCredential({ provider: 'tencent', label: 'Legacy quota', secret: 'legacy-quota-key', quotaLimit: 10_000 });
    const resetAt = new Date(Date.now() + 60_000).toISOString();
    await database.prepare(`UPDATE provider_credentials SET status='quota_exhausted',cooldown_until=? WHERE id=?`)
      .bind(resetAt, id).run();
    expect(await store.listCredentials()).toEqual([expect.objectContaining({
      status: 'quota_exhausted', quotaUsed: 10_000, quotaRemaining: 0,
      quotaWindows: [expect.objectContaining({ used: 10_000, remaining: 0, exhausted: true })]
    })]);
  });

  it('prefers a provider-reported quota reset over the shorter QPS pacing interval', async () => {
    const id = await store.addCredential({ provider: 'tencent', label: 'Reported reset', secret: 'reported-reset-key', qpsLimit: 1 });
    const resetAt = new Date(Date.now() + 60_000).toISOString();
    await store.reportCredential(id, 'success', { used: 200, limit: 200, resetAt });
    expect(await store.credentialAvailability(['tencent'])).toMatchObject({
      eligible: false, configured: true, reason: 'quota', nextAvailableAt: resetAt
    });
  });

  it('edits credential metadata and securely replaces its secret and usage state', async () => {
    const id = await store.addCredential({ provider: 'amap', label: 'Old name', secret: 'old-secret', quotaLimit: 5 });
    await store.reportCredential(id, 'quota');
    expect(await store.listCredentials()).toMatchObject([{ status: 'quota_exhausted', quotaRemaining: 0 }]);
    await store.updateCredential(id, { label: 'New name', secret: 'new-secret', quotaLimit: 5_000, quotaPeriod: 'month', enabled: true });
    expect(await store.listCredentials()).toMatchObject([{
      id, label: 'New name', status: 'healthy', quotaLimit: 5_000, quotaUsed: 0, quotaRemaining: 5_000
    }]);
    expect((await store.acquireCredentialById(id))?.secret).toBe('new-secret');
  });

  it('imports the same environment credential only once per provider', async () => {
    const first = await store.ensureCredential({ provider: 'onemap', label: 'Environment', secret: 'fixture.onemap.token' });
    const second = await store.ensureCredential({ provider: 'onemap', label: 'Renamed', secret: 'fixture.onemap.token' });
    const otherProvider = await store.ensureCredential({ provider: 'amap', label: 'Amap', secret: 'fixture.onemap.token' });
    expect(first.created).toBe(true);
    expect(second).toEqual({ id: first.id, created: false });
    expect(otherProvider.created).toBe(true);
    expect(await store.listCredentials()).toHaveLength(2);
  });

  it('uses conservative free-tier defaults for every credential provider', async () => {
    for (const provider of ['amap', 'baidu', 'tencent', 'onemap', 'youdao', 'geoapify', 'google-geocoding', 'mappls'] as const) {
      const secret = provider === 'youdao' ? JSON.stringify({ appKey: 'fixture-key', appSecret: 'fixture-secret' }) : `${provider}-fixture`;
      const id = await store.addCredential({ provider, label: provider, secret });
      const row = await database.prepare(`SELECT qps_limit,quota_service,quota_period,quota_limit,quota_timezone_offset
        FROM provider_credentials WHERE id=?`).bind(id).first();
      expect(row).toEqual({
        qps_limit: credentialProviderDefaults[provider].qps,
        quota_service: credentialProviderDefaults[provider].service,
        quota_period: credentialProviderDefaults[provider].period,
        quota_limit: credentialProviderDefaults[provider].limit,
        quota_timezone_offset: credentialProviderDefaults[provider].timezoneOffset
      });
    }
    expect(credentialProviderDefaults.amap).toMatchObject({ period: 'month', limit: AMAP_PERSONAL_MONTHLY_LIMIT });
    expect(credentialProviderDefaults.baidu).toMatchObject({ period: 'day', limit: 100 });
    expect(credentialProviderDefaults.tencent).toMatchObject({ period: 'day', limit: 10_000 });
    expect(credentialProviderDefaults['google-geocoding']).toMatchObject({
      qps: 5, period: 'month', limit: GOOGLE_GEOCODING_SYNC_MONTHLY_BUDGET, timezoneOffset: -480
    });
    expect(GOOGLE_GEOCODING_FREE_MONTHLY_LIMIT).toBe(10_000);
    expect(GOOGLE_GEOCODING_SYNC_MONTHLY_BUDGET).toBe(GOOGLE_GEOCODING_FREE_MONTHLY_LIMIT);
  });

  it('adds pre-existing Google usage to shared local usage without granting extra quota per key', async () => {
    const first = await store.addCredential({
      provider: 'google-geocoding', label: 'Google A', secret: 'google-a', quotaLimit: 10, quotaUsedBaseline: 7
    });
    await store.addCredential({
      provider: 'google-geocoding', label: 'Google B', secret: 'google-b', quotaLimit: 10, quotaUsedBaseline: 7
    });
    await store.reportCredential(first, 'success');
    const listed = await store.listCredentials();
    expect(listed).toEqual(expect.arrayContaining([
      expect.objectContaining({ quotaBaseline: 7, quotaUsed: 8, quotaRemaining: 2, officialQuotaLimit: 10_000 })
    ]));
    await store.reportCredential(first, 'success');
    await store.reportCredential(first, 'success');
    expect(await store.acquireCredential('google-geocoding')).toBeNull();
  });

  it('extracts only non-empty provider credentials from environment variables', () => {
    const values = credentialsFromEnvironment({
      AMAP_API_KEY: ' amap-key ', AMAP_API_KEY_2: ' amap-key-2 ', AMAP_API_KEY_10: ' amap-key-10 ', AMAP_API_KEY_TEST: 'ignored', BAIDU_API_KEY: '', TENCENT_API_KEY: undefined, ONEMAP_ACCESS_TOKEN: ' onemap-token ',
      AMAP_JS_API_KEY: 'browser-map-key', AMAP_JS_SECURITY_CODE: 'browser-map-security-code'
    });
    expect(values).toEqual([
      { provider: 'amap', label: 'AMAP_API_KEY', secret: 'amap-key' },
      { provider: 'amap', label: 'AMAP_API_KEY_2', secret: 'amap-key-2' },
      { provider: 'amap', label: 'AMAP_API_KEY_10', secret: 'amap-key-10' },
      { provider: 'onemap', label: 'ONEMAP_ACCESS_TOKEN', secret: 'onemap-token' }
    ]);
  });

  it('restores credentials after a transient cooldown and preserves the provider retry time', async () => {
    const id = await store.addCredential({ provider: 'amap', label: 'cooldown', secret: 'cooldown-secret' });
    const retryAt = new Date(Date.now() + 60_000).toISOString();
    await store.reportCredential(id, 'qps', { retryAt });
    expect(await store.credentialAvailability(['amap'])).toMatchObject({
      eligible: false, configured: true, reason: 'cooldown', nextAvailableAt: retryAt
    });
    await database.prepare('UPDATE provider_credentials SET cooldown_until=? WHERE id=?')
      .bind(new Date(Date.now() - 1_000).toISOString(), id).run();
    expect(await store.credentialAvailability(['amap'])).toMatchObject({ eligible: true, reason: 'ready' });
    expect(await store.listCredentials()).toEqual([expect.objectContaining({ id, status: 'healthy' })]);
  });

  it('uses the earliest independent credential recovery time', async () => {
    const later = await store.addCredential({ provider: 'baidu', label: 'Later', secret: 'later-key' });
    const earlier = await store.addCredential({ provider: 'baidu', label: 'Earlier', secret: 'earlier-key' });
    const earlierAt = new Date(Date.now() + 20_000).toISOString();
    await store.reportCredential(later, 'qps', { retryAt: new Date(Date.now() + 60_000).toISOString() });
    await store.reportCredential(earlier, 'qps', { retryAt: earlierAt });
    expect(await store.credentialAvailability(['baidu'])).toMatchObject({
      eligible: false, configured: true, reason: 'cooldown', nextAvailableAt: earlierAt
    });
  });

  it('tracks OneMap JWT expiry without returning the token', async () => {
    const encode = (value: Record<string, unknown>) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const future = Math.floor(Date.now() / 1000) + 3600;
    const token = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ exp: future })}.signature`;
    const id = await store.addCredential({ provider: 'onemap', label: 'Singapore', secret: token });
    const listed = await store.listCredentials();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id, provider: 'onemap', status: 'healthy' });
    expect(listed[0].expiresAt).toBe(new Date(future * 1000).toISOString());
    expect(JSON.stringify(listed)).not.toContain(token);
    expect((await store.acquireCredential('onemap'))?.id).toBe(id);
  });

  it('selects the exact credential requested by the admin test action', async () => {
    const first = await store.addCredential({ provider: 'baidu', label: 'First', secret: 'baidu-first' });
    const second = await store.addCredential({ provider: 'baidu', label: 'Second', secret: 'baidu-second' });
    expect((await store.acquireCredentialById(second))?.id).toBe(second);
    expect((await store.acquireCredentialById(first))?.id).toBe(first);
    expect(await store.acquireCredentialById('missing')).toBeNull();
  });

  it('does not acquire expired or malformed OneMap credentials', async () => {
    const encode = (value: Record<string, unknown>) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const past = Math.floor(Date.now() / 1000) - 60;
    const expired = `${encode({ alg: 'none' })}.${encode({ exp: past })}.signature`;
    await store.addCredential({ provider: 'onemap', label: 'Expired', secret: expired });
    await store.addCredential({ provider: 'onemap', label: 'Malformed', secret: 'not-a-jwt' });
    const listed = await store.listCredentials();
    expect(listed.map((item) => item.status)).toEqual(['expired', 'needs_review']);
    expect(await store.acquireCredential('onemap')).toBeNull();
  });

  it('applies a shared quota scope across multiple keys', async () => {
    const first = await store.addCredential({ provider: 'tencent', label: 'A', secret: 'scope-a', dailyLimit: 1, quotaScopeId: 'shared-account' });
    await store.addCredential({ provider: 'tencent', label: 'B', secret: 'scope-b', dailyLimit: 1, quotaScopeId: 'shared-account' });
    expect((await store.acquireCredential('tencent'))?.id).toBe(first);
    await store.reportCredential(first, 'success');
    expect(await store.acquireCredential('tencent')).toBeNull();
  });

  it('gives keys independent quotas unless a shared scope is explicitly configured', async () => {
    const first = await store.addCredential({ provider: 'amap', label: 'A', secret: 'independent-a', dailyLimit: 1 });
    const second = await store.addCredential({ provider: 'amap', label: 'B', secret: 'independent-b', dailyLimit: 1 });
    expect((await store.acquireCredentialById(first))?.id).toBe(first);
    await store.reportCredential(first, 'success');
    expect(await store.acquireCredentialById(first)).toBeNull();
    expect((await store.acquireCredentialById(second))?.id).toBe(second);
    expect(await store.availableProviders()).toEqual(['amap']);
    await store.reportCredential(second, 'success');
    expect(await store.availableProviders()).toEqual([]);
  });

  it('distinguishes API rate limiting from invalid credentials', async () => {
    const created = await store.createApiToken({ name: 'limited', scopes: ['generate'], rateLimit: 1 });
    expect((await store.authorizeApiTokenDetailed(created.token, 'generate')).status).toBe('authorized');
    expect((await store.authorizeApiTokenDetailed(created.token, 'generate')).status).toBe('rate_limited');
    expect((await store.authorizeApiTokenDetailed('invalid', 'generate')).status).toBe('unauthorized');
  });

  it('enforces an API token rate limit atomically under concurrent authorization', async () => {
    const created = await store.createApiToken({ name: 'concurrent-limited', scopes: ['generate'], rateLimit: 1 });
    const results = await Promise.all(Array.from({ length: 40 }, () =>
      store.authorizeApiTokenDetailed(created.token, 'generate')));
    expect(results.filter((result) => result.status === 'authorized')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rate_limited')).toHaveLength(39);
  });

  it('imports translation and geocoding service credentials from the environment', () => {
    expect(credentialsFromEnvironment({
      GEOAPIFY_API_KEY: ' geo-key ', GOOGLE_GEOCODING_API_KEY: 'google-geo-key',
      YOUDAO_APP_KEY: ' youdao-key ', YOUDAO_APP_SECRET: ' youdao-secret '
    })).toEqual([
      { provider: 'geoapify', label: 'GEOAPIFY_API_KEY', secret: 'geo-key' },
      { provider: 'google-geocoding', label: 'GOOGLE_GEOCODING_API_KEY', secret: 'google-geo-key' },
      { provider: 'youdao', label: 'YOUDAO_APP_KEY', secret: JSON.stringify({ appKey: 'youdao-key', appSecret: 'youdao-secret' }) }
    ]);
    expect(credentialsFromEnvironment({ YOUDAO_APP_KEY: 'only-half-of-the-pair' })).toEqual([]);
  });

  it('stores the Youdao pair as a single validated JSON credential', async () => {
    await expect(store.addCredential({ provider: 'youdao', label: 'Bad', secret: 'not-json' })).rejects.toThrow('INVALID_PROVIDER_CREDENTIAL');
    const secret = JSON.stringify({ appKey: 'app-key', appSecret: 'app-secret' });
    const first = await store.ensureCredential({ provider: 'youdao', label: 'YOUDAO_APP_KEY', secret });
    const second = await store.ensureCredential({ provider: 'youdao', label: 'Renamed', secret });
    expect(first.created).toBe(true);
    expect(second).toEqual({ id: first.id, created: false });
    expect(parseYoudaoSecret((await store.acquireCredential('youdao'))?.secret)).toEqual({ appKey: 'app-key', appSecret: 'app-secret' });
    await expect(store.updateCredential(first.id, { secret: '{"appKey":"only"}' })).rejects.toThrow('INVALID_PROVIDER_CREDENTIAL');
  });

  it('serializes concurrent Youdao settings upserts without creating duplicate credentials', async () => {
    await Promise.all([
      store.upsertYoudaoCredential('first-app-key', 'first-app-secret'),
      store.upsertYoudaoCredential('second-app-key', 'second-app-secret')
    ]);
    const rows = (await database.prepare("SELECT id FROM provider_credentials WHERE provider='youdao'").all()).results;
    expect(rows).toHaveLength(1);
    expect(parseYoudaoSecret((await store.acquireCredential('youdao'))?.secret)).toEqual(
      expect.objectContaining({ appKey: expect.stringMatching(/^(first|second)-app-key$/u) })
    );
  });

  it('resolves service credentials from the store with caching and environment fallback', async () => {
    const environment = { GEOAPIFY_API_KEY: 'environment-geo-key' };
    const cached = createServiceCredentialResolver(store, environment);
    expect(await cached('geoapify')).toBe('environment-geo-key');
    await store.addCredential({ provider: 'geoapify', label: 'Stored', secret: 'stored-geo-key' });
    expect(await cached('geoapify')).toBe('environment-geo-key');
    const fresh = createServiceCredentialResolver(store, environment, 0);
    expect(await fresh('geoapify')).toBe('stored-geo-key');
    expect(await fresh('google-geocoding')).toBeUndefined();
    const youdao = createServiceCredentialResolver(store, { YOUDAO_APP_KEY: 'env-app-key', YOUDAO_APP_SECRET: 'env-app-secret' }, 0);
    expect(parseYoudaoSecret(await youdao('youdao'))).toEqual({ appKey: 'env-app-key', appSecret: 'env-app-secret' });
  });

  it('tests service credentials with tiny requests that never leak the secret', async () => {
    const youdao = await testServiceCredential('youdao', JSON.stringify({ appKey: 'app-key', appSecret: 'app-secret' }), (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body as URLSearchParams;
      expect(body.getAll('q')).toEqual(['地址']);
      expect(body.get('appKey')).toBe('app-key');
      return Response.json({ errorCode: '0', translateResults: [{ translation: 'address' }] });
    }) as typeof fetch);
    expect(youdao).toEqual({ success: true, resultCount: 1 });
    expect(JSON.stringify(youdao)).not.toContain('app-secret');
    const geoapify = await testServiceCredential('geoapify', 'geo-secret', (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.origin).toBe('https://api.geoapify.com');
      expect(url.searchParams.get('apiKey')).toBe('geo-secret');
      expect(url.searchParams.get('limit')).toBe('1');
      return Response.json({ results: [{}] });
    }) as typeof fetch);
    expect(geoapify).toEqual({ success: true, resultCount: 1 });
    await expect(testServiceCredential('youdao', 'not-json'))
      .rejects.toMatchObject({ outcome: 'invalid' });
    const google = await testServiceCredential('google-geocoding', 'google-secret', (async (input, init) => {
      const url = new URL(String(input));
      expect(url.origin).toBe('https://geocode.googleapis.com');
      expect(url.pathname).toBe('/v4/geocode/location');
      expect(url.searchParams.get('regionCode')).toBe('US');
      expect(url.searchParams.getAll('types')).toEqual(['street_address', 'premise', 'subpremise']);
      expect(new Headers(init?.headers).get('X-Goog-Api-Key')).toBe('google-secret');
      return Response.json({ results: [{ placeId: 'fixture' }] });
    }) as typeof fetch);
    expect(google).toEqual({ success: true, resultCount: 1 });
    await expect(testServiceCredential('google-geocoding', 'google-secret', (async () => new Response('{}', { status: 403 })) as typeof fetch))
      .rejects.toMatchObject({ outcome: 'auth' });
    await expect(testServiceCredential('geoapify', 'geo-secret', (async () => { throw new Error('offline geo-secret'); }) as unknown as typeof fetch))
      .rejects.toMatchObject({ outcome: 'network', message: 'NETWORK_ERROR' });
  });

  it('tests DeepL only through the broker without translating or exposing the key', async () => {
    const secret = '00000000-0000-0000-0000-000000000001:fx';
    const id = await store.addCredential({ provider: 'deepl', label: 'Fixture', secret });
    const session = await store.createSession('admin');
    const headers = { Cookie: `address_admin_session=${session.token}; address_admin_csrf=${session.csrf}`, 'X-CSRF-Token': session.csrf };
    const request = vi.fn(async () => ({ used: 4, limit: 100, remaining: 96, resetAt: null }));
    const admin = createAdminApi({ control: store, china: {} as never, addressDb: database, credentialBroker: { request } as never });
    const response = await admin.request(`/admin/api/providers/${id}/test`, { method: 'POST', headers });
    expect(response.status).toBe(200);
    expect(request).toHaveBeenCalledWith('deepl.usage', { credentialId: id }, { maxDispatches: 1 });
    expect(await response.text()).not.toContain(secret);
    const withoutBroker = createAdminApi({ control: store, china: {} as never, addressDb: database });
    expect((await withoutBroker.request(`/admin/api/providers/${id}/test`, { method: 'POST', headers })).status).toBe(503);
    await expect(testServiceCredential('deepl', secret)).rejects.toThrow('DEEPL_REQUIRES_BROKER');
  });

  it('manages service credentials and the translation toggle through the admin API', async () => {
    const session = await store.createSession('admin');
    const admin = createAdminApi({ control: store, china: {} as never, addressDb: database });
    const headers = {
      Cookie: `address_admin_session=${session.token}; address_admin_csrf=${session.csrf}`,
      'X-CSRF-Token': session.csrf,
      'Content-Type': 'application/json'
    };
    const created = await admin.request('/admin/api/providers', {
      method: 'POST', headers, body: JSON.stringify({ provider: 'geoapify', label: 'Geoapify', secret: 'geoapify-secret-sentinel' })
    });
    expect(created.status).toBe(201);
    const listing = await (await admin.request('/admin/api/providers', { headers: { Cookie: headers.Cookie } })).json() as { data: unknown[] };
    expect(listing.data).toEqual([expect.objectContaining({ provider: 'geoapify', quotaPeriod: 'day', quotaLimit: 3_000 })]);
    expect(JSON.stringify(listing)).not.toContain('geoapify-secret-sentinel');
    expect(await (await admin.request('/admin/api/settings/translation', { headers: { Cookie: headers.Cookie } })).json())
      .toMatchObject({ data: { googleTranslationEnabled: true, routes: expect.arrayContaining([
        expect.objectContaining({ id: 'google', provider: 'google', status: 'healthy', priority: 40 })
      ]) } });
    const updated = await admin.request('/admin/api/settings/translation', {
      method: 'PUT', headers, body: JSON.stringify({ googleTranslationEnabled: false })
    });
    expect(updated.status).toBe(200);
    expect(await store.setting('google_translation_enabled', true)).toBe(false);
    expect((await admin.request('/admin/api/settings/translation', {
      method: 'PUT', headers, body: JSON.stringify({ googleTranslationEnabled: 'yes' })
    })).status).toBe(400);
  });

  it('seeds the Google translation toggle from the environment only once', async () => {
    const fresh = openTestDatabase(':memory:', { migrate: false });
    try {
      await initializeTestDatabase(fresh, new URL('../server/control/schema.sql', import.meta.url));
      const freshStore = new ControlStore(fresh, masterKey);
      await freshStore.initialize('fresh administrator password', { GOOGLE_TRANSLATION_ENABLED: 'false' });
      expect(await freshStore.setting('google_translation_enabled', true)).toBe(false);
      await freshStore.setSetting('google_translation_enabled', true);
      await freshStore.initialize(undefined, { GOOGLE_TRANSLATION_ENABLED: 'false' });
      expect(await freshStore.setting('google_translation_enabled', false)).toBe(true);
    } finally { fresh.close(); }
  });

  it('manages the Youdao credential through the dedicated settings endpoints', async () => {
    const session = await store.createSession('admin');
    const admin = createAdminApi({ control: store, china: {} as never, addressDb: database });
    const headers = {
      Cookie: `address_admin_session=${session.token}; address_admin_csrf=${session.csrf}`,
      'X-CSRF-Token': session.csrf,
      'Content-Type': 'application/json'
    };
    expect(await (await admin.request('/admin/api/settings/youdao', { headers: { Cookie: headers.Cookie } })).json())
      .toEqual({ data: { configured: false, appKeyMask: '' } });
    expect((await admin.request('/admin/api/settings/youdao', {
      method: 'PUT', headers, body: JSON.stringify({ appKey: 'only-half-of-the-pair' })
    })).status).toBe(400);
    const saved = await admin.request('/admin/api/settings/youdao', {
      method: 'PUT', headers, body: JSON.stringify({ appKey: ' youdao-app-key ', appSecret: ' youdao-app-secret ' })
    });
    expect(await saved.json()).toEqual({ data: { configured: true, appKeyMask: 'youd****' } });
    expect(parseYoudaoSecret((await store.acquireCredential('youdao'))?.secret))
      .toEqual({ appKey: 'youdao-app-key', appSecret: 'youdao-app-secret' });
    const replaced = await admin.request('/admin/api/settings/youdao', {
      method: 'PUT', headers, body: JSON.stringify({ appKey: 'next-app-key', appSecret: 'next-app-secret' })
    });
    expect(await replaced.json()).toEqual({ data: { configured: true, appKeyMask: 'next****' } });
    expect((await store.listCredentials()).filter((credential) => credential.provider === 'youdao')).toHaveLength(1);
    expect((await store.translationRoutes()).find(({ provider }) => provider === 'youdao')).toMatchObject({ status: 'healthy', enabled: true });
    const status = await (await admin.request('/admin/api/settings/youdao', { headers: { Cookie: headers.Cookie } })).json();
    expect(JSON.stringify(status)).not.toContain('app-secret');
  });

  it('manages multiple Youdao credentials independently through provider endpoints', async () => {
    const session = await store.createSession('admin');
    const admin = createAdminApi({ control: store, china: {} as never, addressDb: database });
    const headers = {
      Cookie: `address_admin_session=${session.token}; address_admin_csrf=${session.csrf}`,
      'X-CSRF-Token': session.csrf,
      'Content-Type': 'application/json'
    };
    const create = async (label: string, appKey: string, appSecret: string) => {
      const response = await admin.request('/admin/api/providers', {
        method: 'POST', headers, body: JSON.stringify({
          provider: 'youdao', label, secret: JSON.stringify({ appKey, appSecret })
        })
      });
      expect(response.status).toBe(201);
      return (await response.json() as { data: { id: string } }).data.id;
    };
    const first = await create('Translation primary', 'first-app-key', 'first-app-secret');
    const second = await create('Translation backup', 'second-app-key', 'second-app-secret');
    const listed = await (await admin.request('/admin/api/providers', { headers: { Cookie: headers.Cookie } })).json() as {
      data: Array<{ id: string; provider: string; fieldMasks?: { appKey: string; appSecret: string } }>;
    };
    expect(listed.data.filter(({ provider }) => provider === 'youdao')).toHaveLength(2);
    expect(listed.data.find(({ id }) => id === first)?.fieldMasks).toEqual({ appKey: 'firs••••••••', appSecret: '••••••••cret' });
    expect(JSON.stringify(listed)).not.toContain('first-app-secret');
    expect(JSON.stringify(listed)).not.toContain('second-app-secret');

    const revealed = await (await admin.request(`/admin/api/providers/${second}/reveal-fields`, {
      method: 'POST', headers
    })).json();
    expect(revealed).toEqual({ data: { id: second, appKey: 'second-app-key', appSecret: 'second-app-secret' } });
    expect(JSON.stringify(revealed)).not.toContain('"secret":"{');
    expect(await (await admin.request(`/admin/api/providers/${second}/reveal`, { method: 'POST', headers })).json())
      .toEqual({ data: { id: second, secret: JSON.stringify({ appKey: 'second-app-key', appSecret: 'second-app-secret' }) } });

    expect((await admin.request(`/admin/api/providers/${first}`, {
      method: 'PUT', headers, body: JSON.stringify({ enabled: false })
    })).status).toBe(200);
    expect((await store.acquireCredential('youdao'))?.id).toBe(second);
    expect((await admin.request(`/admin/api/providers/${first}`, { method: 'DELETE', headers })).status).toBe(200);
    expect((await store.listCredentials()).filter(({ provider }) => provider === 'youdao').map(({ id }) => id)).toEqual([second]);
  });
});
