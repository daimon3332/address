import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const failures = [];
const report = (path, type) => failures.push({ path, type });

const forbidden = [
  /(^|\/)\.claude\//u,
  /(^|\/)\.codex\//u,
  /(^|\/)\.data-cache\//u,
  /(^|\/)(?:data|logs|runtime|backups|worker)\//u,
  /(^|\/)plan\.md$/u,
  /(^|\/)tmp-probe\.png$/u,
  /\.(?:db|sqlite|sqlite3|pem|p12|pfx)$/iu,
  /(^|\/)\.env(?:\.|$)/u
];

for (const path of tracked) {
  if (path.endsWith('.env.example') || path === 'ops/deploy.env.example') continue;
  if (forbidden.some((pattern) => pattern.test(path))) report(path, 'forbidden-tracked-file');
}

const secretShapes = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u],
  ['github-token', /(?:ghp_|github_pat_)[A-Za-z0-9_]{20,}/u],
  ['aws-access-key', /AKIA[0-9A-Z]{16}/u],
  ['slack-token', /xox[baprs]-[A-Za-z0-9-]{20,}/u]
];

for (const path of tracked) {
  let content;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    continue;
  }
  for (const [type, pattern] of secretShapes) {
    if (pattern.test(content)) report(path, type);
  }
}

for (const path of ['.env.example', 'server/sync/.env.example', 'ops/address.env.example', 'ops/deploy.env.example']) {
  const content = readFileSync(path, 'utf8');
  for (const line of content.split(/\r?\n/u)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|COOKIE)[A-Z0-9_]*)\s*=\s*(.*?)\s*$/u);
    if (!match || !match[2]) continue;
    if (!/(?:REPLACE|YOUR_|VPS_|SSH_|GENERATE_|RANDOM)/iu.test(match[2])) report(path, `literal-${match[1].toLowerCase()}`);
  }
}

for (const path of ['LICENSE', 'README.md', 'README.zh-CN.md', 'README.zh-TW.md', '.github/workflows/ci.yml', '.github/workflows/release.yml']) {
  if (!tracked.includes(path)) report(path, 'required-public-file-not-tracked');
}

if (failures.length) {
  for (const failure of failures.sort((left, right) => left.path.localeCompare(right.path) || left.type.localeCompare(right.type))) {
    console.error(`${failure.type}: ${failure.path}`);
  }
  process.exitCode = 1;
} else {
  console.log(`public-release audit passed (${tracked.length} tracked files)`);
}
