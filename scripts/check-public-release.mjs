import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const candidates = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' })
  .split('\0').filter(Boolean);
const staged = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], { encoding: 'utf8' })
  .split('\0').filter(Boolean);
const historicalPaths = execFileSync('git', ['log', '--all', '--format=', '--name-only'], { encoding: 'utf8' })
  .split(/\r?\n/u).filter(Boolean);
const failures = [];
const report = (path, type) => failures.push({ path, type });

const forbidden = [
  /(^|\/)\.claude\//u,
  /(^|\/)\.codex\//u,
  /(^|\/)\.data-cache\//u,
  /(^|\/)(?:data|logs|runtime|backups|worker)\//u,
  /(^|\/)plan\.md$/u,
  /(^|\/)tmp-probe\.png$/u,
  /\.(?:db|sqlite|sqlite3|dump|backup|bak|pem|key|p12|pfx|jks|keystore|jsonl|parquet|pbf|osm)$/iu,
  /(?:^|\/)(?:id_rsa|id_ed25519|id_ecdsa)$/u,
  /(?:^|\/)(?:\.npmrc|\.pypirc|\.netrc)$/u,
  /(^|\/)\.env(?:\.|$)/u
];

for (const path of tracked) {
  if (path.endsWith('.env.example') || path === 'ops/deploy.env.example') continue;
  if (forbidden.some((pattern) => pattern.test(path))) report(path, 'forbidden-tracked-file');
}

for (const path of historicalPaths) {
  if (path.endsWith('.env.example') || path === 'ops/deploy.env.example') continue;
  if (forbidden.some((pattern) => pattern.test(path))) report(path, 'forbidden-history-file');
}

const secretShapes = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u],
  ['github-token', /(?:ghp_|github_pat_)[A-Za-z0-9_]{20,}/u],
  ['openai-compatible-key', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}\b/u],
  ['command-code-key', /\buser_[A-Za-z0-9]{60,}\b/u],
  ['aws-access-key', /AKIA[0-9A-Z]{16}/u],
  ['slack-token', /xox[baprs]-[A-Za-z0-9-]{20,}/u],
  ['jwt-token', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u],
  ['google-api-key', /\bAIza[A-Za-z0-9_-]{30,}\b/u],
  ['tencent-map-key', /\b(?:[A-Z0-9]{5}-){5}[A-Z0-9]{5}\b/u]
];

const scan = (path, content, prefix = '') => {
  for (const [type, pattern] of secretShapes) {
    if (pattern.test(content)) report(path, prefix ? `${prefix}-${type}` : type);
  }
};

for (const path of candidates) {
  let content;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    continue;
  }
  scan(path, content);
}

for (const path of staged) {
  try {
    scan(path, execFileSync('git', ['show', `:${path}`], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }), 'staged');
  } catch {
    report(path, 'unreadable-staged-file');
  }
}

const historyPatch = execFileSync('git', ['log', '--all', '--format=', '--no-ext-diff', '--no-textconv', '-p'], {
  encoding: 'utf8', maxBuffer: 128 * 1024 * 1024
});
scan('git-history', historyPatch, 'history');

for (const path of ['.env.example', 'server/sync/.env.example', 'ops/compose.env.example', 'ops/deploy.env.example']) {
  const content = readFileSync(path, 'utf8');
  for (const line of content.split(/\r?\n/u)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|COOKIE)[A-Z0-9_]*)\s*=\s*(.*?)\s*$/u);
    if (!match || !match[2]) continue;
    if (!/(?:REPLACE|YOUR_|VPS_|SSH_|GENERATE_|RANDOM)/iu.test(match[2])) report(path, `literal-${match[1].toLowerCase()}`);
  }
}

for (const path of ['LICENSE', 'README.md', 'README.zh-CN.md', 'README.zh-TW.md', 'README.ja.md', '.github/workflows/ci.yml', '.github/workflows/release.yml']) {
  if (!tracked.includes(path)) report(path, 'required-public-file-not-tracked');
}

if (failures.length) {
  for (const failure of failures.sort((left, right) => left.path.localeCompare(right.path) || left.type.localeCompare(right.type))) {
    console.error(`${failure.type}: ${failure.path}`);
  }
  process.exitCode = 1;
} else {
  console.log(`public-release audit passed (${tracked.length} tracked, ${candidates.length - tracked.length} untracked candidates)`);
}
