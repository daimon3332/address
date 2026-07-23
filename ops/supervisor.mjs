import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const app = '/root/address/app';
const runner = resolve(app, 'node_modules/tsx/dist/cli.mjs');
const definitions = [
  ['api', resolve(app, 'server/api/server.ts')],
  ['sync', resolve(app, 'server/sync/index.mjs')]
];
const children = new Map();
let stopping = false;

const signalTree = (child, signal) => {
  if (process.platform !== 'win32' && Number.isInteger(child.pid)) {
    try { process.kill(-child.pid, signal); } catch {}
  }
  try { child.kill(signal); } catch {}
};

const retireLegacyInitialQueue = async () => {
  const pidFile = '/root/address/runtime/pids/initial-queue.pid';
  try {
    const pid = Number.parseInt((await readFile(pidFile, 'utf8')).trim(), 10);
    if (Number.isSafeInteger(pid) && pid > 0) {
      const command = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).replaceAll('\0', ' ');
      if (command.includes('/root/address/app/ops/queue-initial-sync.sh')) process.kill(pid, 'SIGTERM');
    }
  } catch {}
  await rm(pidFile, { force: true });
};

const start = ([name, entry]) => {
  if (stopping) return;
  const child = spawn(process.execPath, [runner, entry], {
    cwd: app, env: process.env, stdio: 'inherit', detached: process.platform !== 'win32'
  });
  children.set(name, child);
  let settled = false;
  const restart = (detail) => {
    if (settled) return;
    settled = true;
    signalTree(child, 'SIGTERM');
    children.delete(name);
    if (stopping) return;
    console.error(`${name} stopped ${detail}; restarting`);
    setTimeout(() => start([name, entry]), 2_000).unref();
  };
  child.once('error', (error) => restart(`error=${error.message}`));
  child.once('exit', (code, signal) => restart(`code=${code ?? ''} signal=${signal ?? ''}`));
};

const stop = () => {
  if (stopping) return;
  stopping = true;
  for (const child of children.values()) signalTree(child, 'SIGTERM');
  const timer = setInterval(() => {
    if (children.size) return;
    clearInterval(timer);
    process.exit(0);
  }, 100);
  setTimeout(() => process.exit(1), 20_000).unref();
};

await retireLegacyInitialQueue();
definitions.forEach(start);
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
