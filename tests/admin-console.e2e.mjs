import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '..');
const runtime = resolve(root, 'tmp', `admin-e2e-${process.pid}-${Date.now()}`);
if (!runtime.startsWith(`${root}\\`) && !runtime.startsWith(`${root}/`)) throw new Error('INVALID_TEST_RUNTIME');

const availablePort = async () => new Promise((resolvePort, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    server.close((error) => error ? reject(error) : resolvePort(port));
  });
});

const executablePath = () => [
  process.env.PLAYWRIGHT_EXECUTABLE_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/microsoft-edge', '/usr/bin/chromium', '/usr/bin/chromium-browser'
].filter(Boolean).find((candidate) => existsSync(candidate));

const waitForServer = async (baseUrl, server, errors) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`ADMIN_E2E_SERVER_EXITED:${errors.join('')}`);
    try { if ((await fetch(`${baseUrl}/api/v1/health`)).ok) return; } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`ADMIN_E2E_SERVER_TIMEOUT:${errors.join('')}`);
};

const panel = (page, value) => page.locator('.admin-panel > header h2').filter({ hasText: new RegExp(`^${value}$`) });
const selectLocale = async (page, label) => {
  await page.getByRole('button', { name: 'Language', exact: true }).click();
  await page.getByRole('option', { name: label, exact: true }).click();
};
const fillLogin = async (page, password) => {
  await page.waitForFunction(() => !document.querySelector('astro-island[ssr]'));
  await page.locator('input[type=password]').fill(password);
  const button = page.getByRole('button', { name: '登录', exact: true });
  await page.waitForFunction((element) => !element.disabled, await button.elementHandle());
  return button;
};
const login = async (page, password, failedResponses = []) => {
  const button = await fillLogin(page, password);
  await button.click();
  try { await page.locator('.admin-shell').waitFor(); }
  catch (error) {
    const detail = await page.locator('.admin-error').textContent().catch(() => '');
    throw new Error(`ADMIN_LOGIN_FAILED:${detail || page.url()}:${failedResponses.join(',')}`, { cause: error });
  }
};

await mkdir(resolve(runtime, 'imports'), { recursive: true });
await writeFile(resolve(runtime, 'imports', 'area.json'), JSON.stringify([{
  code: '110000', name: '北京市', level: 'province', children: [{
    code: '110100', name: '北京市', level: 'city', children: [
      { code: '110105', name: '朝阳区', level: 'district' }
    ]
  }]
}]), 'utf8');

const port = await availablePort();
let syncPort = await availablePort();
while (syncPort === port) syncPort = await availablePort();
const baseUrl = `http://127.0.0.1:${port}`;
const syncBaseUrl = `http://127.0.0.1:${syncPort}`;
const serverErrors = [];
const server = spawn(process.execPath, ['--import', 'tsx', 'server/api/server.ts'], {
  cwd: root,
  env: {
    ...process.env,
    NODE_ENV: 'test', ADDRESS_TEST_DATABASE: 'memory',
    API_HOST: '127.0.0.1', API_PORT: String(port),
    CONFIG_MASTER_KEY: '3333333333333333333333333333333333333333333333333333333333333333',
    ADMIN_BOOTSTRAP_PASSWORD: 'initial admin password', COOKIE_SECURE: 'false', STATIC_ROOT: resolve(root, 'dist'),
    ALLOWED_ORIGINS: 'https://address.daimonna.com,https://address.333186.xyz',
    ADDRESS_DATA_ROOT: runtime, ADDRESS_SYNC_CACHE_DIR: resolve(runtime, 'staging'), AMAP_API_KEY: '',
    SYNC_CONTROL_URL: syncBaseUrl, SYNC_ADMIN_TOKEN: 'e2e-sync-admin-token'
  },
  stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true
});
server.stderr.on('data', (value) => serverErrors.push(String(value)));

const syncErrors = [];
const syncControl = spawn(process.execPath, ['--import', 'tsx', 'server/sync/index.mjs'], {
  cwd: root,
  env: {
    ...process.env,
    NODE_ENV: 'test', ADDRESS_TEST_DATABASE: 'memory',
    SYNC_HOST: '127.0.0.1', SYNC_PORT: String(syncPort),
    SYNC_ADMIN_TOKEN: 'e2e-sync-admin-token',
    SYNC_STATE_DIR: resolve(runtime, 'sync-control'),
    SYNC_SCHEDULER_ENABLED: 'false', TRANSLATION_BACKFILL_ENABLED: 'false'
  },
  stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true
});
syncControl.stderr.on('data', (value) => syncErrors.push(String(value)));
const waitForSyncControl = async () => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (syncControl.exitCode !== null) throw new Error(`ADMIN_E2E_SYNC_CONTROL_EXITED:${syncErrors.join('')}`);
    try { if ((await fetch(`${syncBaseUrl}/healthz`)).ok) return; } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`ADMIN_E2E_SYNC_CONTROL_TIMEOUT:${syncErrors.join('')}`);
};

let browser;
try {
  await waitForServer(baseUrl, server, serverErrors);
  await waitForSyncControl();
  const preflight = await fetch(`${baseUrl}/api/v1/generate`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://address.daimonna.com',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,content-type'
    }
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://address.daimonna.com');
  const browserPath = executablePath();
  assert.ok(browserPath, 'Set PLAYWRIGHT_EXECUTABLE_PATH to a Chromium-compatible browser');
  browser = await chromium.launch({ headless: true, executablePath: browserPath });
  const context = await browser.newContext({ locale: 'zh-CN', permissions: ['clipboard-read', 'clipboard-write'] });
  const pageErrors = [];
  const failedResponses = [];
  context.on('response', (response) => { if (response.status() >= 500) failedResponses.push(response.url()); });
  context.on('page', (page) => page.on('pageerror', (error) => pageErrors.push(error.message)));

  const loginPage = await context.newPage();
  await loginPage.goto(`${baseUrl}/admin/`);
  await (await fillLogin(loginPage, 'wrong administrator password')).click();
  await loginPage.locator('.admin-error').filter({ hasText: '管理员密码错误' }).waitFor();
  await login(loginPage, 'initial admin password', failedResponses);

  const page = await context.newPage();
  const acceptConfirm = async () => { const dialog = page.getByRole('dialog', { name: '请确认', exact: true }); await dialog.waitFor(); await dialog.getByRole('button', { name: '确认', exact: true }).click(); await dialog.waitFor({ state: 'detached' }); };
  await page.goto(`${baseUrl}/admin/`);
  await page.locator('.dashboard-page').waitFor();
  assert.equal(await page.locator('.admin-content > header.admin-topbar').count(), 1);
  assert.equal(await page.locator('.admin-content > header.admin-topbar h1').count(), 1);
  assert.equal(await page.locator('.admin-sidebar .nav-icon').count(), 8);
  assert.equal(await page.locator('.dashboard-kpis .dashboard-kpi').count(), 4);
  assert.equal(await page.locator('.world-distribution-map').count(), 1);
  const mapCanvas = page.locator('.world-distribution-map .maplibregl-canvas').first();
  await mapCanvas.waitFor();
  assert.equal(await page.locator('.map-legend span').count(), 6);
  assert.equal(await page.locator('.map-zoom-controls button').count(), 3);
  assert.equal(await page.locator('.country-coverage-table').count(), 1);
  assert.equal(await page.locator('.country-data-table > .table-pagination').count(), 0);
  assert.equal(await page.getByRole('columnheader', { name: '更新数据', exact: true }).count(), 0);
  assert.equal(await page.getByRole('columnheader', { name: '操作', exact: true }).count(), 0);
  assert.equal(await page.getByText('全部数据', { exact: true }).count(), 0);
  assert.equal(await page.getByText('导出数据', { exact: true }).count(), 0);
  assert.equal(await page.getByText('当前数据库没有地址记录。导入或同步数据后，可继续下钻查看国家、省市和区县。', { exact: true }).count(), 0);
  assert.equal(await page.getByText('按真实住宅总量', { exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click({ clickCount: 2, delay: 250 });
  await page.waitForTimeout(800);
  const worldBox = await mapCanvas.boundingBox();
  assert.ok(worldBox);
  const worldBeforeDrag = await mapCanvas.screenshot();
  await page.mouse.move(worldBox.x + worldBox.width / 2, worldBox.y + worldBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(worldBox.x + worldBox.width / 2 + 45, worldBox.y + worldBox.height / 2 + 35);
  await page.mouse.up();
  await page.waitForTimeout(400);
  assert.equal(worldBeforeDrag.equals(await mapCanvas.screenshot()), false);
  await page.getByRole('button', { name: 'Reset map', exact: true }).click();
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await mapCanvas.dispatchEvent('wheel', { deltaY: -120, ctrlKey: true, clientX: 400, clientY: 180 });
  await page.waitForTimeout(250);
  assert.equal(await page.evaluate(() => window.scrollY), 0);
  await page.getByRole('button', { name: '展开地图', exact: true }).click();
  const mapDialog = page.getByRole('dialog', { name: '全球地址分布', exact: true });
  await mapDialog.waitFor();
  await mapDialog.locator('.world-distribution-map .maplibregl-canvas').waitFor();
  await mapDialog.getByRole('button', { name: '关闭', exact: true }).click();
  assert.equal(await mapDialog.count(), 0);
  assert.equal(await page.locator('.dashboard-ranking').count(), 0);
  assert.equal(await page.locator('.country-data-table').count(), 1);
  assert.equal(await page.locator('.admin-sidebar-status').count(), 1);
  assert.equal(await page.getByText('管理员', { exact: true }).count(), 0);
  assert.equal(await page.getByText('超级管理员', { exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Language', exact: true }).count(), 1);
  assert.equal(await page.getByText('数据与系统管理', { exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '审计日志', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '系统管理', exact: true }).count(), 0);
  await selectLocale(page, 'English');
  await page.getByRole('heading', { name: 'Address Data Overview', exact: true }).waitFor();
  await selectLocale(page, '简体中文');
  await page.getByRole('heading', { name: '地址数据总览', exact: true }).waitFor();

  const views = [
    ['仪表盘', null], ['地址黑名单', '地址黑名单'], ['访问与安全', '访问策略'], ['地图密钥', '地图密钥'],
    ['地址数据', 'address-data'], ['同步历史', 'sync-history'], ['快捷区域', 'shortcuts'], ['接口令牌', '接口令牌']
  ];
  for (let round = 0; round < 3; round += 1) {
    for (const [tab, title] of views) {
      await page.getByRole('button', { name: tab, exact: true }).click();
      if (title === 'address-data') await page.locator('.address-data-page').waitFor();
      else if (title === 'sync-history') await page.locator('.sync-history-panel').waitFor();
      else if (title === 'shortcuts') await page.locator('.shortcut-settings-page').waitFor();
      else if (title) await panel(page, title).waitFor();
      else await page.locator('.dashboard-page').waitFor();
    }
  }

  assert.equal(await page.getByRole('button', { name: '同步策略', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '任务中心', exact: true }).count(), 0);
  assert.equal(await page.getByRole('columnheader', { name: '普通地址', exact: true }).count(), 0);

  await page.getByRole('button', { name: '地址黑名单', exact: true }).click();
  await page.getByText('内置排除规则', { exact: true }).waitFor();
  await page.locator('.blacklist-settings textarea').fill('测试机构\n测试园区');
  await page.getByRole('button', { name: '保存黑名单', exact: true }).click();
  await page.locator('.admin-notice').filter({ hasText: '地址黑名单已保存' }).waitFor();

  await page.getByRole('button', { name: '访问与安全', exact: true }).click();
  await page.locator('input[name=frontendPasswordEnabled]').check();
  await page.getByRole('button', { name: '修改前端密码', exact: true }).click();
  const frontendPasswordDialog = page.getByRole('dialog', { name: '修改前端密码' });
  await frontendPasswordDialog.locator('input[name=password]').fill('new frontend password');
  await frontendPasswordDialog.locator('input[name=confirmation]').fill('mismatched frontend password');
  await frontendPasswordDialog.getByRole('button', { name: '保存密码', exact: true }).click();
  await page.locator('.field-error').filter({ hasText: '两次输入的密码不一致' }).waitFor();
  await frontendPasswordDialog.locator('input[name=confirmation]').fill('new frontend password');
  await frontendPasswordDialog.getByRole('button', { name: '显示', exact: true }).first().click();
  assert.equal(await frontendPasswordDialog.locator('input[name=password]').getAttribute('type'), 'text');
  await frontendPasswordDialog.getByRole('button', { name: '隐藏', exact: true }).first().click();
  await frontendPasswordDialog.getByRole('button', { name: '保存密码', exact: true }).click();
  await page.locator('.admin-notice').filter({ hasText: '访问设置已保存' }).waitFor();
  await page.getByRole('button', { name: '修改管理员密码', exact: true }).click();
  const adminPasswordDialog = page.getByRole('dialog', { name: '修改管理员密码' });
  await adminPasswordDialog.locator('input[name=password]').fill('new administrator password');
  await adminPasswordDialog.locator('input[name=confirmation]').fill('new administrator password');
  await adminPasswordDialog.getByRole('button', { name: '保存密码', exact: true }).click();
  await page.locator('.admin-notice').filter({ hasText: '访问设置已保存' }).waitFor();
  assert.equal(await page.locator('input[name=frontendPasswordEnabled]').isChecked(), true);

  await page.getByRole('button', { name: '地图密钥', exact: true }).click();
  const providerSection = (name) => page.locator('.provider-group').filter({ has: page.getByRole('heading', { name, exact: true }) });
  assert.equal(await page.locator('.provider-group').count(), 7);
  for (const provider of ['高德地图', '百度地图', '腾讯地图', 'OneMap', 'Geoapify', 'Google Geocoding', 'Mappls']) {
    await providerSection(provider).waitFor();
  }
  await providerSection('Google Geocoding').getByText('0 个密钥', { exact: true }).waitFor();
  assert.equal(await page.locator('input[name=googleChina]').isChecked(), true);
  assert.equal(await page.locator('input[name=googleInternational]').isChecked(), true);
  assert.equal(await page.locator('input[name=amapChina]').isChecked(), false);
  assert.equal(await page.locator('input[name=amapInternational]').isChecked(), false);
  assert.equal(await page.locator('input[name=amapChina]').isDisabled(), true);
  await page.locator('.map-prerequisite').getByRole('button', { name: '配置凭据', exact: true }).click();
  const browserMapDialog = page.getByRole('dialog', { name: '配置高德前端地图凭据' });
  await browserMapDialog.locator('input[name=label]').fill('e2e-browser-map');
  await browserMapDialog.locator('input[name=apiKey]').fill('e2e-public-browser-key');
  await browserMapDialog.locator('input[name=securityCode]').fill('e2e-private-security-code');
  await browserMapDialog.getByRole('button', { name: '保存', exact: true }).click();
  await page.locator('.admin-notice').filter({ hasText: '高德前端地图凭据已保存' }).waitFor();
  assert.equal((await page.locator('body').textContent()).includes('e2e-public-browser-key'), false);
  assert.equal((await page.locator('body').textContent()).includes('e2e-private-security-code'), false);
  const browserPanel = page.locator('.admin-panel').filter({ has: page.getByRole('heading', { name: '高德前端地图凭据', exact: true }) });
  const browserRow = browserPanel.locator('.amap-browser-row');
  await browserRow.waitFor();
  assert.equal(await providerSection('高德地图').locator('.amap-browser-row').count(), 0);
  const browserKeyCell = browserRow.locator('.amap-browser-secrets > div').filter({ hasText: 'JS API Key' });
  await browserKeyCell.getByRole('button', { name: '显示', exact: true }).click();
  await browserKeyCell.getByText('e2e-public-browser-key', { exact: true }).waitFor();
  await browserKeyCell.getByRole('button', { name: '复制', exact: true }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'e2e-public-browser-key');
  await browserKeyCell.getByRole('button', { name: '隐藏', exact: true }).click();
  assert.equal(await browserKeyCell.getByText('e2e-public-browser-key', { exact: true }).count(), 0);
  const browserCodeCell = browserRow.locator('.amap-browser-secrets > div').filter({ hasText: '安全密钥' });
  await browserCodeCell.getByRole('button', { name: '显示', exact: true }).click();
  await browserCodeCell.getByText('e2e-private-security-code', { exact: true }).waitFor();
  await browserCodeCell.getByRole('button', { name: '隐藏', exact: true }).click();
  await page.locator('label.switch-field:has(input[name=googleChina]) span').click();
  await page.locator('label.switch-field:has(input[name=amapChina]) span').click();
  assert.equal(await page.locator('input[name=googleChina]').isChecked(), false);
  assert.equal(await page.locator('input[name=amapChina]').isChecked(), true);
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.locator('.admin-notice').filter({ hasText: '地图显示设置已保存' }).waitFor();
  const frontendMapLogin = await page.evaluate(async () => {
    const response = await fetch('/web-api/v1/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'new frontend password' })
    });
    return response.status;
  });
  assert.equal(frontendMapLogin, 200);
  const mapConfiguration = await page.evaluate(async () => (await (await fetch('/web-api/v1/config/maps?country=CN')).json()).data);
  assert.deepEqual(mapConfiguration, {
    countryCode: 'CN', googleEnabled: false, amapEnabled: true, amapConfigured: true,
    amapApiKey: 'e2e-public-browser-key', serviceHost: '/_AMapService'
  });
  assert.equal(JSON.stringify(mapConfiguration).includes('e2e-private-security-code'), false);
  await providerSection('高德地图').getByRole('button', { name: '添加密钥', exact: true }).click();
  const keyDialog = page.getByRole('dialog', { name: '添加地图密钥' });
  await keyDialog.waitFor();
  assert.equal(await keyDialog.getByRole('option', { name: '高德地图', exact: true }).count(), 1);
  assert.equal(await keyDialog.getByRole('option', { name: '百度地图', exact: true }).count(), 1);
  assert.equal(await keyDialog.getByRole('option', { name: '腾讯地图', exact: true }).count(), 1);
  assert.equal(await keyDialog.getByRole('option', { name: 'OneMap', exact: true }).count(), 1);
  assert.equal(await keyDialog.getByRole('option', { name: 'Geoapify', exact: true }).count(), 1);
  assert.equal(await keyDialog.getByRole('option', { name: '有道翻译', exact: true }).count(), 0);
  assert.equal(await keyDialog.getByRole('option', { name: 'Google Geocoding', exact: true }).count(), 1);
  assert.equal(await keyDialog.getByRole('option', { name: 'Mappls', exact: true }).count(), 1);
  assert.equal(await keyDialog.getByText('QPS', { exact: true }).count(), 0);
  assert.equal(await keyDialog.getByText('每日额度', { exact: true }).count(), 0);
  assert.equal(await keyDialog.getByText('共享配额组', { exact: true }).count(), 0);
  await keyDialog.locator('input[name=label]').fill('e2e-amap');
  await keyDialog.locator('input[name=secret]').fill('fake-key-for-e2e');
  await keyDialog.getByRole('button', { name: '保存', exact: true }).click();
  await page.locator('.admin-notice').filter({ hasText: '地图密钥已保存' }).waitFor();
  const providerRow = () => providerSection('高德地图').locator('.provider-key-row').filter({ hasText: 'e2e-amap' });
  await providerRow().waitFor();
  await providerRow().getByText('0/5,000 每月', { exact: true }).waitFor();
  assert.equal((await providerRow().textContent()).includes('本地统计'), false);
  assert.equal((await providerRow().textContent()).includes('fake-key-for-e2e'), false);
  const providerSecretCell = providerRow().locator('.secret-cell');
  await providerSecretCell.getByRole('button', { name: '显示', exact: true }).click();
  await providerSecretCell.getByText('fake-key-for-e2e', { exact: true }).waitFor();
  await page.getByRole('button', { name: '仪表盘', exact: true }).click();
  await page.getByRole('button', { name: '地图密钥', exact: true }).click();
  await providerRow().waitFor();
  assert.equal((await providerRow().textContent()).includes('fake-key-for-e2e'), false);
  await providerRow().getByRole('button', { name: '停用', exact: true }).click();
  await providerRow().getByRole('button', { name: '启用', exact: true }).waitFor();
  await providerRow().getByRole('button', { name: '启用', exact: true }).click();
  await providerRow().getByRole('button', { name: '停用', exact: true }).waitFor();

  const translationPanel = page.locator('.admin-panel').filter({ has: page.getByRole('heading', { name: '在线翻译', exact: true }) });
  await translationPanel.getByText(/有道按量收费.*项目限额不代表供应商免费额度/u).waitFor();
  await translationPanel.getByText(/在线服务按下方配置的优先级执行.*可能限流或不可用/u).waitFor();
  assert.equal(await translationPanel.getByRole('switch', { name: '启用谷歌翻译', exact: true }).count(), 1);
  assert.equal(await translationPanel.locator('input[name=googleTranslationEnabled]').count(), 0);
  await translationPanel.getByText('未配置', { exact: true }).first().waitFor();
  assert.equal(await translationPanel.locator('.translation-provider:not(.index-translate-provider)').getByRole('button', { name: '测试', exact: true }).count(), 0);
  const indexTranslate = translationPanel.locator('.index-translate-provider');
  assert.equal(await indexTranslate.getByRole('switch', { name: '启用 Index-Translate', exact: true }).getAttribute('aria-checked'), 'false');
  assert.equal(await indexTranslate.locator('input[name=indexTranslateBaseUrl]').inputValue(), 'https://index-translate.bilibili.com/v1');
  assert.equal(await indexTranslate.getByRole('button', { name: '测试', exact: true }).count(), 1);
  const originalViewport = page.viewportSize();
  const translationConsoleErrors = [];
  const onTranslationConsole = (message) => { if (message.type() === 'error') translationConsoleErrors.push(message.text()); };
  page.on('console', onTranslationConsole);
  for (const [, label, fee] of [
    ['zh-CN', '简体中文', /有道按量收费.*项目限额不代表供应商免费额度/u],
    ['en', 'English', /Youdao is usage-based.*not free-credit guarantees/u],
    ['zh-TW', '繁體中文', /有道按量收費.*專案限額不代表供應商免費額度/u]
  ]) {
    await selectLocale(page, label);
    for (const viewport of [{ width: 1440, height: 960 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      const settings = page.locator('.translation-settings');
      await settings.getByText(fee).waitFor();
      await settings.getByText(/Cloud Translation/u).waitFor();
      const addButton = settings.locator('.translation-provider:not(.deepl-provider):not(.openai-provider):not(.index-translate-provider) .translation-provider-header button');
      await addButton.click();
      const dialog = page.getByRole('dialog');
      await dialog.getByText(fee).waitFor();
      assert.equal(await dialog.locator('input[name=youdaoAppKey]').inputValue(), '');
      assert.equal(await dialog.locator('input[name=youdaoAppSecret]').getAttribute('type'), 'password');
      const layout = await dialog.evaluate((element) => ({
        overflowBeyondLayoutFloor: document.documentElement.scrollWidth > Math.max(window.innerWidth,
          parseFloat(getComputedStyle(document.body).minWidth) || 0),
        dialogOverflow: element.scrollWidth > element.clientWidth,
        dialogOutsideViewport: element.getBoundingClientRect().left < 0 || element.getBoundingClientRect().right > window.innerWidth,
        noteFontSize: parseFloat(getComputedStyle(element.querySelector('.translation-notice')).fontSize)
      }));
      assert.equal(layout.overflowBeyondLayoutFloor, false, JSON.stringify({ viewport, layout }));
      assert.equal(layout.dialogOverflow, false);
      assert.equal(layout.dialogOutsideViewport, false);
      assert.ok(layout.noteFontSize >= 12);
      await dialog.getByRole('button').last().focus();
      await page.keyboard.press('Tab');
      assert.equal(await dialog.getByRole('button').first().evaluate((element) => element === document.activeElement), true);
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'detached' });
      assert.equal(await addButton.evaluate((element) => element === document.activeElement), true);
      const addDeepL = settings.locator('.deepl-provider .translation-provider-header button');
      await addDeepL.click();
      const deeplDialog = page.getByRole('dialog');
      await deeplDialog.getByText(/DeepL API Free/u).waitFor();
      assert.equal(await deeplDialog.locator('input[name=secret]').inputValue(), '');
      assert.equal(await deeplDialog.locator('input[name=secret]').getAttribute('type'), 'password');
      assert.equal(await deeplDialog.locator('input[name=quotaLimit]').inputValue(), '500000');
      await deeplDialog.locator('input[name=quotaLimit]').fill('1000000');
      assert.equal(await deeplDialog.locator('select[name=quotaPeriod]').count(), 0);
      assert.equal(await deeplDialog.evaluate((element) => element.scrollWidth > element.clientWidth), false);
      await page.keyboard.press('Escape');
      await deeplDialog.waitFor({ state: 'detached' });
      assert.equal(await addDeepL.evaluate((element) => element === document.activeElement), true);
      const addOpenAI = settings.locator('.openai-provider .translation-provider-header button');
      await addOpenAI.click();
      const openAIDialog = page.getByRole('dialog');
      await openAIDialog.getByText(/OpenAI.*Chat Completions/u).first().waitFor();
      assert.equal(await openAIDialog.locator('input[name=apiKey]').getAttribute('type'), 'password');
      assert.equal(await openAIDialog.locator('input[name=baseUrl]').inputValue(), '');
      assert.equal(await openAIDialog.locator('input[name=model]').inputValue(), '');
      assert.equal(await openAIDialog.locator('input[name=reasoningEffort]').inputValue(), 'low');
      assert.equal(await openAIDialog.locator('input[name=maxTokens]').inputValue(), '8192');
      assert.equal(await openAIDialog.locator('input[name=translationPriority]').inputValue(), '10');
      assert.equal(await openAIDialog.locator('textarea[name=translationPrompt]').count(), 1);
      const openAILayout = await openAIDialog.evaluate((element) => ({
        dialogOverflow: element.scrollWidth > element.clientWidth,
        dialogOutsideViewport: element.getBoundingClientRect().left < 0 || element.getBoundingClientRect().right > window.innerWidth
      }));
      assert.equal(openAILayout.dialogOverflow, false);
      assert.equal(openAILayout.dialogOutsideViewport, false);
      await page.keyboard.press('Escape');
      await openAIDialog.waitFor({ state: 'detached' });
      assert.equal(await addOpenAI.evaluate((element) => element === document.activeElement), true);
    }
  }
  page.off('console', onTranslationConsole);
  assert.deepEqual(translationConsoleErrors, []);
  console.log('translation cost warnings passed: 3 locales, desktop and mobile dialogs, keyboard, console and existing layout floor');
  await page.setViewportSize(originalViewport);
  await selectLocale(page, '简体中文');
  const createYoudao = async (label, appKey, appSecret) => {
    await translationPanel.getByRole('button', { name: '添加密钥', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '添加密钥', exact: true });
    await dialog.getByText(/若不接受费用，请勿添加或启用凭据/u).waitFor();
    await dialog.locator('input[name=label]').fill(label);
    await dialog.locator('input[name=youdaoAppKey]').fill(appKey);
    await dialog.locator('input[name=youdaoAppSecret]').fill(appSecret);
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await page.locator('.admin-notice').filter({ hasText: '有道翻译密钥已保存' }).waitFor();
  };
  await createYoudao('e2e-youdao-primary', 'e2e-youdao-app-key', 'e2e-youdao-app-secret');
  await createYoudao('e2e-youdao-backup', 'e2e-youdao-backup-key', 'e2e-youdao-backup-secret');
  await page.locator('.admin-notice').filter({ hasText: '有道翻译密钥已保存' }).waitFor();
  await translationPanel.getByText('2 个密钥', { exact: true }).waitFor();
  assert.equal(await translationPanel.locator('.provider-key-row').count(), 2);
  assert.equal(await translationPanel.locator('.provider-key-row').getByRole('button', { name: '测试', exact: true }).count(), 2);
  assert.equal((await page.locator('body').textContent()).includes('e2e-youdao-app-secret'), false);
  const youdaoPrimary = translationPanel.locator('.provider-key-row').filter({ hasText: 'e2e-youdao-primary' });
  const youdaoAppKey = youdaoPrimary.locator('.provider-key-secret').filter({ hasText: '应用 ID（AppKey）' });
  const youdaoAppSecret = youdaoPrimary.locator('.provider-key-secret').filter({ hasText: '应用密钥（AppSecret）' });
  await youdaoAppKey.getByRole('button', { name: '显示', exact: true }).click();
  await youdaoAppKey.getByText('e2e-youdao-app-key', { exact: true }).waitFor();
  await youdaoAppSecret.getByRole('button', { name: '显示', exact: true }).click();
  await youdaoAppSecret.getByText('e2e-youdao-app-secret', { exact: true }).waitFor();

  await page.getByRole('button', { name: '接口令牌', exact: true }).click();
  await selectLocale(page, 'English');
  await page.getByRole('button', { name: 'API Tokens', exact: true }).click();
  await panel(page, 'API tokens').waitFor();
  await selectLocale(page, '简体中文');
  await page.getByRole('button', { name: '接口令牌', exact: true }).click();
  await panel(page, '接口令牌').waitFor();
  assert.equal(await page.getByRole('columnheader', { name: '前缀', exact: true }).count(), 0);
  assert.equal(await page.getByRole('columnheader', { name: '最近使用', exact: true }).count(), 0);
  assert.equal(await page.getByRole('columnheader', { name: '状态', exact: true }).count(), 0);
  await page.getByRole('button', { name: '+ 添加令牌', exact: true }).click();
  const tokenDialog = page.getByRole('dialog', { name: '添加接口令牌' });
  await tokenDialog.locator('input[name=name]').fill('e2e-token');
  await tokenDialog.locator('input[name=rateLimit]').fill('1');
  assert.equal(await tokenDialog.getByRole('checkbox', { name: '全部', exact: true }).isChecked(), true);
  await tokenDialog.getByRole('button', { name: '生成令牌', exact: true }).click();
  const token = await tokenDialog.locator('input[name=token]').inputValue();
  assert.match(token, /^addr_[A-Za-z0-9_-]+$/u);
  await tokenDialog.getByRole('button', { name: '创建', exact: true }).click();
  const createdTokenDialog = page.getByRole('dialog', { name: '令牌已创建' });
  await createdTokenDialog.getByText(token, { exact: true }).waitFor();
  await createdTokenDialog.getByRole('button', { name: '复制', exact: true }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), token);
  await createdTokenDialog.getByRole('button', { name: '关闭', exact: true }).last().click();
  const tokenRow = page.locator('tbody tr').filter({ hasText: 'e2e-token' });
  await tokenRow.waitFor();
  assert.equal((await tokenRow.textContent()).includes(token), false);
  await tokenRow.getByRole('button', { name: '显示', exact: true }).click();
  await tokenRow.getByText(token, { exact: true }).waitFor();
  await tokenRow.getByRole('button', { name: '隐藏', exact: true }).click();
  assert.equal(await page.evaluate(async () => (await fetch('/api/v1/countries')).status), 401);
  assert.equal(await page.evaluate(async (value) => (await fetch('/api/v1/countries', { headers: { Authorization: `Bearer ${value}` } })).status, token), 200);
  assert.equal(await page.evaluate(async (value) => (await fetch('/api/v1/countries', { headers: { Authorization: `Bearer ${value}` } })).status, token), 429);
  await tokenRow.getByRole('button', { name: '编辑', exact: true }).click();
  const editTokenDialog = page.getByRole('dialog', { name: '修改接口令牌' });
  await editTokenDialog.getByRole('checkbox', { name: '生成', exact: true }).uncheck();
  await editTokenDialog.locator('input[name=rateLimit]').fill('5');
  await editTokenDialog.locator('input[name=expiresAt]').fill('2099-12-31T23:59');
  await editTokenDialog.getByRole('button', { name: '保存修改', exact: true }).click();
  await page.locator('.admin-notice').filter({ hasText: '令牌设置已更新' }).waitFor();
  await tokenRow.filter({ hasText: '读取' }).waitFor();
  assert.equal(await page.evaluate(async (value) => (await fetch('/api/v1/generate', { headers: { Authorization: `Bearer ${value}` } })).status, token), 401);
  assert.equal(await page.evaluate(async (value) => (await fetch('/api/v1/countries', { headers: { Authorization: `Bearer ${value}` } })).status, token), 200);
  await tokenRow.getByRole('button', { name: '撤销', exact: true }).click();
  await acceptConfirm();
  assert.equal(await page.evaluate(async (value) => (await fetch('/api/v1/countries', { headers: { Authorization: `Bearer ${value}` } })).status, token), 401);

  const importStatus = await page.evaluate(async () => {
    const csrf = document.cookie.split('; ').find((value) => value.startsWith('address_admin_csrf='))?.split('=')[1] || '';
    return (await fetch('/admin/api/china/areacity', { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ source: 'imports/area.json', version: 'e2e-fixture-v1' }) })).status;
  });
  assert.equal(importStatus, 200);

  await page.getByRole('button', { name: '仪表盘', exact: true }).click();
  const drill = (name) => page.locator('button.drill-button, button.country-name-button').filter({ hasText: new RegExp(`${name}$`) });
  await drill('中国').click();
  await drill('北京市').click();
  await drill('北京市').click();
  await page.getByText('朝阳区', { exact: true }).waitFor();
  await page.getByRole('button', { name: '全部国家', exact: true }).click();
  await page.locator('.country-coverage-table tbody tr').first().waitFor();
  assert.equal(await page.locator('.country-coverage-table tbody tr').count(), 27);
  assert.equal(await page.locator('.country-data-table > .table-pagination').count(), 0);
  assert.equal(await page.locator('.world-distribution-map .maplibregl-canvas').count(), 1);
  assert.equal(await page.locator('.world-distribution-map img').count(), 0);
  await page.locator('.country-coverage-table img.country-flag').first().waitFor();
  const flagSource = await page.locator('.country-coverage-table img.country-flag').first().getAttribute('src');
  assert.match(flagSource, /^\/flags\/[a-z]{2}\.svg$/u);
  assert.equal(await page.evaluate(async (src) => (await fetch(src)).status, flagSource), 200);
  await page.locator('.country-table-tools input').fill('美国');
  await drill('美国').waitFor();
  assert.equal(await page.locator('.country-coverage-table tbody tr').count(), 1);
  await page.locator('.country-table-tools input').fill('');
  await page.getByLabel('大洲筛选').selectOption('asia');
  assert.ok(await page.locator('.country-coverage-table tbody tr').count() > 1);
  await page.getByLabel('排序方式').selectOption('residential-asc');
  const ascendingCounts = await page.locator('.country-coverage-table tbody tr .numeric-cell').allTextContents();
  const numericCounts = ascendingCounts.map((value) => Number(value.replaceAll(',', '')));
  assert.deepEqual(numericCounts, [...numericCounts].sort((left, right) => left - right));
  await page.getByLabel('大洲筛选').selectOption('all');
  await page.getByLabel('排序方式').selectOption('residential-desc');

  let areaRequests = 0;
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/admin/api/china/areas') areaRequests += 1;
  });
  await page.getByRole('button', { name: '地址数据', exact: true }).click();
  await page.locator('.address-data-page').waitFor();
  assert.equal(await page.locator('.sync-queue-panel').count(), 0);
  try { await page.locator('.address-data-table tr.queue-row[data-country="CN"]').waitFor({ timeout: 20_000 }); }
  catch (error) {
    throw new Error(`ADMIN_ADDRESS_DATA_FAILED:${await page.locator('.address-data-page').textContent()}:${failedResponses.join(',')}`, { cause: error });
  }
  assert.equal(await page.locator('.address-data-table tr.queue-row').first().getAttribute('data-country'), 'CN');
  assert.equal(await page.locator('.queue-unavailable').count(), 0);
  assert.ok(await page.locator('.address-data-table .badge.target-state').count() > 0);
  assert.ok(await page.locator('.address-data-table .coverage-cell').count() > 0);
  assert.equal(await page.locator('.segmented-filter button').count(), 6);
  await page.locator('.workspace-toolbar input').fill('CN');
  assert.equal(await page.locator('.address-data-table tbody tr').count(), 1);
  await page.locator('.workspace-toolbar input').fill('');
  const chinaRow = page.locator('.address-data-table tbody tr[data-country="CN"]');
  await chinaRow.getByRole('button', { name: '详情', exact: true }).click();
  const detail = page.locator('.country-detail');
  await detail.getByRole('heading', { name: '中国', exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('country'), 'CN');
  assert.equal(await detail.getByRole('tab').count(), 6);
  await detail.getByRole('tab', { name: '区县覆盖', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: '开始/继续同步', exact: true }).count(), 0);
  await detail.locator('.coverage-filters select').nth(0).selectOption('110000');
  await detail.locator('.coverage-filters select').nth(1).selectOption('110100');
  await detail.locator('.coverage-filters select').nth(2).selectOption('110105');
  await detail.locator('tbody tr').filter({ hasText: '朝阳区' }).waitFor();
  await detail.getByText('第 1 / 1 页，共 1 条', { exact: true }).waitFor();
  const settledAreaRequests = areaRequests;
  await page.waitForTimeout(3200);
  assert.equal(areaRequests, settledAreaRequests);
  assert.equal(await page.evaluate(async () => (await fetch('/admin/api/china/areas?provinceAdcode=invalid')).status), 400);

  await detail.getByRole('tab', { name: '节点目标', exact: true }).click();
  await detail.getByRole('button', { name: '加载节点目标', exact: true }).click();
  const nodeTable = detail.locator('.node-target-table');
  const beijingNodeRow = nodeTable.locator('tbody tr').filter({ hasText: '北京市' }).first();
  await beijingNodeRow.waitFor();
  await beijingNodeRow.getByRole('button', { name: '编辑', exact: true }).click();
  await beijingNodeRow.locator('input').fill('8');
  await beijingNodeRow.getByRole('button', { name: '保存', exact: true }).click();
  await detail.locator('.node-panel-notice').filter({ hasText: '节点目标已保存' }).waitFor();
  await beijingNodeRow.locator('.target-source-tag.override').waitFor();
  await beijingNodeRow.getByText('8', { exact: true }).waitFor();
  await beijingNodeRow.getByRole('button', { name: '恢复默认', exact: true }).click();
  await detail.locator('.node-panel-notice').filter({ hasText: '已恢复默认目标' }).waitFor();
  await beijingNodeRow.locator('.target-source-tag.default').waitFor();
  await beijingNodeRow.getByText('800', { exact: true }).waitFor();

  await detail.getByRole('tab', { name: '目标设置', exact: true }).click();
  await detail.locator('input[name=minPerNode]').fill('6');
  await detail.locator('input[name=coveragePercent]').fill('90');
  await detail.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.locator('.admin-notice').filter({ hasText: '国家数据设置已保存' }).waitFor();
  await detail.getByRole('tab', { name: '同步历史', exact: true }).click();
  await detail.locator('.sync-history-panel').waitFor();
  assert.equal(await detail.locator('.sync-history-toolbar').count(), 0);
  await detail.getByRole('button', { name: '返回列表', exact: true }).click();
  await page.locator('.address-data-table').waitFor();
  assert.equal(new URL(page.url()).searchParams.get('country'), null);
  await chinaRow.getByRole('button', { name: '详情', exact: true }).click();
  await detail.getByRole('tab', { name: '目标设置', exact: true }).click();
  await detail.locator('input[name=minPerNode]').waitFor();
  assert.equal(await detail.locator('input[name=minPerNode]').inputValue(), '6');
  assert.equal(await detail.locator('input[name=coveragePercent]').inputValue(), '90');
  await page.goBack();
  await page.locator('.address-data-table').waitFor();

  await page.getByRole('button', { name: '地图密钥', exact: true }).click();
  await providerRow().getByRole('button', { name: '删除', exact: true }).click();
  await acceptConfirm();
  await providerRow().waitFor({ state: 'detached' });
  await browserRow.getByRole('button', { name: '删除', exact: true }).click();
  await acceptConfirm();
  await page.getByText('尚未配置高德前端地图凭据', { exact: true }).waitFor();

  await page.getByRole('button', { name: '访问与安全', exact: true }).click();
  assert.equal(await page.locator('input[name=apiAuthEnabled]').count(), 0);
  assert.equal(await page.evaluate(async () => (await fetch('/api/v1/countries')).status), 401);
  await page.locator('input[name=frontendPasswordEnabled]').uncheck();
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.locator('.admin-notice').filter({ hasText: '访问设置已保存' }).waitFor();
  const openContext = await browser.newContext({ locale: 'zh-CN' });
  const openPage = await openContext.newPage();
  await openPage.goto(`${baseUrl}/`);
  assert.notEqual(new URL(openPage.url()).pathname, '/zh-CN/access/');
  await openContext.close();
  await page.locator('input[name=frontendPasswordEnabled]').check();
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.locator('.admin-notice').filter({ hasText: '访问设置已保存' }).waitFor();

  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await page.getByRole('heading', { name: '管理员登录', exact: true }).waitFor();
  await login(page, 'new administrator password');

  const frontendContext = await browser.newContext({ locale: 'zh-CN' });
  const frontend = await frontendContext.newPage();
  frontend.on('pageerror', (error) => pageErrors.push(error.message));
  await frontend.goto(`${baseUrl}/`);
  assert.equal(new URL(frontend.url()).pathname, '/zh-CN/access/');
  await frontend.locator('#password').fill('wrong frontend password');
  await frontend.getByRole('button', { name: '进入', exact: true }).click();
  await frontend.locator('#error').filter({ hasText: '密码不正确' }).waitFor();
  await frontend.locator('#password').fill('new frontend password');
  await frontend.getByRole('button', { name: '进入', exact: true }).click();
  await frontend.locator('.site-shell').waitFor();
  await frontendContext.close();

  assert.deepEqual(pageErrors, []);
  console.log('admin console e2e passed');
} finally {
  if (browser) await browser.close();
  if (syncControl.exitCode === null) {
    const exited = new Promise((resolveExit) => syncControl.once('exit', resolveExit));
    syncControl.kill('SIGTERM');
    await Promise.race([exited, new Promise((resolveWait) => setTimeout(resolveWait, 5_000))]);
    if (syncControl.exitCode === null) syncControl.kill('SIGKILL');
  }
  if (server.exitCode === null) {
    const exited = new Promise((resolveExit) => server.once('exit', resolveExit));
    server.kill('SIGTERM');
    await Promise.race([exited, new Promise((resolveWait) => setTimeout(resolveWait, 5_000))]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try { await rm(runtime, { recursive: true, force: true }); break; }
    catch (error) {
      if (attempt === 19) throw error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
  }
}
