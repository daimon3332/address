import { spawn } from 'node:child_process';
import { access, mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

const requestedUiUrl = new URL(process.env.UI_BASE_URL || 'http://127.0.0.1:4321/zh-CN/');
if (!requestedUiUrl.searchParams.has('country')) requestedUiUrl.searchParams.set('country', 'us');
if (!requestedUiUrl.searchParams.has('mode')) requestedUiUrl.searchParams.set('mode', 'address');
const uiUrl = requestedUiUrl.toString();
const maxLoadMs = Number.parseInt(process.env.MAX_UI_LOAD_MS || '15000', 10);
const maxGenerationMs = Number.parseInt(process.env.MAX_UI_GENERATION_MS || '5000', 10);
const maxIpGenerationMs = Number.parseInt(process.env.MAX_IP_GENERATION_MS || '30000', 10);
const workspace = resolve(process.cwd());
const profile = resolve(workspace, `.browser-validation-${process.pid}-${Date.now()}`);
if (!profile.startsWith(`${workspace}${sep}`)) throw new Error('Browser profile must stay inside the workspace.');

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
const exists = async (path) => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const browserExecutable = async () => {
  const candidates = [
    process.env.BROWSER_EXECUTABLE,
    process.platform === 'win32' ? join(process.env['ProgramFiles(x86)'] || '', 'Microsoft/Edge/Application/msedge.exe') : undefined,
    process.platform === 'win32' ? join(process.env.ProgramFiles || '', 'Microsoft/Edge/Application/msedge.exe') : undefined,
    process.platform === 'win32' ? join(process.env.LOCALAPPDATA || '', 'Microsoft/Edge/Application/msedge.exe') : undefined,
    '/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'
  ].filter(Boolean);
  for (const candidate of candidates) if (await exists(candidate)) return candidate;
  throw new Error('Set BROWSER_EXECUTABLE to an installed Edge or Chromium executable.');
};

class CdpClient {
  constructor(url) {
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.socket = new WebSocket(url);
    this.ready = new Promise((resolveReady, rejectReady) => {
      this.socket.addEventListener('open', resolveReady, { once: true });
      this.socket.addEventListener('error', () => rejectReady(new Error('CDP WebSocket connection failed.')), { once: true });
    });
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
        else pending.resolve(message.result);
        return;
      }
      for (const listener of this.listeners.get(message.method) || []) listener(message.params);
    });
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) || [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }

  async send(method, params = {}) {
    await this.ready;
    const id = ++this.nextId;
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new Error(`${method}: CDP command timed out`));
      }, 15000);
      this.pending.set(id, {
        method,
        resolve: (value) => { clearTimeout(timer); resolveRequest(value); },
        reject: (error) => { clearTimeout(timer); rejectRequest(error); }
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket.close();
  }
}

const waitForFile = async (path, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await exists(path)) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${path}`);
};

const stopBrowser = async (browser) => {
  if (!browser || browser.exitCode !== null) return;
  browser.kill();
  const exited = new Promise((resolveExit) => browser.once('exit', resolveExit));
  await Promise.race([exited, sleep(3000)]);
  if (browser.exitCode === null) browser.kill('SIGKILL');
};

await mkdir(profile, { recursive: false });
let browser;
let cdp;
try {
  const executable = await browserExecutable();
  browser = spawn(executable, [
    '--headless=new', '--disable-gpu', '--disable-extensions', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1440,1200', 'about:blank'
  ], { stdio: 'ignore', windowsHide: true });
  const activePortFile = join(profile, 'DevToolsActivePort');
  await waitForFile(activePortFile, 10000);
  const [port] = (await readFile(activePortFile, 'utf8')).trim().split(/\r?\n/u);
  const targetResponse = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(uiUrl)}`, { method: 'PUT' });
  if (!targetResponse.ok) throw new Error(`Creating the browser target returned HTTP ${targetResponse.status}.`);
  const target = await targetResponse.json();
  cdp = new CdpClient(target.webSocketDebuggerUrl);
  const pageErrors = [];
  cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => pageErrors.push(exceptionDetails?.text || 'Uncaught browser exception'));
  await Promise.all([cdp.send('Page.enable'), cdp.send('Runtime.enable')]);

  const evaluate = async (expression) => {
    const response = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || 'Browser evaluation failed.');
    return response.result?.value;
  };
  const waitFor = async (expression, timeoutMs, label) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return;
      await sleep(100);
    }
    throw new Error(`Timed out waiting for ${label}.`);
  };
  const click = async (selector, double = false) => {
    const point = await evaluate(`(() => {
      const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    for (const clickCount of double ? [1, 2] : [1]) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount });
    }
  };

  const loadStarted = Date.now();
  await waitFor(`document.readyState === 'complete' && document.querySelector('.address-table .result-row strong') && !document.querySelector('.generate-button').disabled`, maxLoadMs, 'the generator page and initial address');
  const loadMs = Date.now() - loadStarted;
  const before = await evaluate(`document.querySelector('.address-table').innerText`);
  const generationStarted = Date.now();
  await click('.generate-button');
  try {
    await waitFor(`(() => {
      const button = document.querySelector('.generate-button');
      const table = document.querySelector('.address-table');
      return button && !button.disabled && table && table.innerText !== ${JSON.stringify(before)};
    })()`, maxGenerationMs, 'a changed address after clicking Generate');
  } catch (error) {
    const state = await evaluate(`({
      loading: document.querySelector('.generate-button')?.disabled,
      error: document.querySelector('.compact-error')?.innerText || '',
      address: document.querySelector('.address-table')?.innerText || ''
    })`);
    throw new Error(`${error instanceof Error ? error.message : String(error)} State: ${JSON.stringify(state)}`);
  }
  const generationMs = Date.now() - generationStarted;
  const compactError = await evaluate(`document.querySelector('.compact-error')?.innerText || ''`);
  if (compactError) throw new Error(`Generator displayed an error: ${compactError}`);

  await click('.address-table .result-row strong', true);
  await waitFor(`Boolean(document.querySelector('.copy-toast.success[role="status"]'))`, 3000, 'the copy-success toast');
  const copyToast = await evaluate(`(() => {
    const toast = document.querySelector('.copy-toast.success[role="status"]');
    return { text: toast.innerText, live: toast.getAttribute('aria-live'), atomic: toast.getAttribute('aria-atomic') };
  })()`);
  if (!/复制成功|已复制到剪贴板|Copied/u.test(copyToast.text)) throw new Error(`Unexpected copy toast: ${copyToast.text}`);
  if (copyToast.live !== 'polite' || copyToast.atomic !== 'true') throw new Error('Copy toast accessibility attributes are incomplete.');

  await click('.ip-region-controls button:first-of-type');
  await waitFor(`(() => { const value = document.querySelector('input[name="ip"]')?.value || ''; return value.includes('.') || value.includes(':'); })()`, 10000, 'the current IP input value');
  const detectedIp = await evaluate(`document.querySelector('input[name="ip"]').value`);
  await evaluate(`(() => {
    const input = document.querySelector('input[name="ip"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, '162.141.137.231');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  const beforeIp = await evaluate(`document.querySelector('.address-table').innerText`);
  await click('.ip-region-controls button:last-of-type');
  await waitFor(`(() => {
    const table = document.querySelector('.address-table');
    return table && table.innerText !== ${JSON.stringify(beforeIp)} && document.querySelector('.ip-region-result')
      && /香港|Hong Kong/u.test(document.querySelector('.generator-heading h1')?.innerText || '');
  })()`, maxIpGenerationMs, 'Hong Kong IP-region generation');
  const ipError = await evaluate(`document.querySelector('.compact-error')?.innerText || ''`);
  if (ipError) throw new Error(`IP generator displayed an error: ${ipError}`);
  if (pageErrors.length) throw new Error(pageErrors.join('; '));

  console.log(JSON.stringify({
    url: uiUrl,
    secureContext: await evaluate('window.isSecureContext'),
    loadLatencyMs: loadMs,
    generationLatencyMs: generationMs,
    addressChanged: true,
    currentIpDetected: Boolean(detectedIp),
    hongKongIpGeneration: true,
    copyToast
  }, null, 2));
} finally {
  await cdp?.send('Browser.close').catch(() => undefined);
  cdp?.close();
  await stopBrowser(browser);
  await sleep(500);
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(async (error) => {
    await sleep(2000);
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(() => {
      console.error(`Browser profile cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  });
}
