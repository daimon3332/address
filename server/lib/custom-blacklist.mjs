import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const RELOAD_INTERVAL_MS = 10_000;

const cache = { path: '', mtimeMs: -1, checkedAt: 0, keywords: [] };

const normalizeKeyword = (value) => value.normalize('NFKC').toLocaleLowerCase('und').trim();

const parseKeywords = (content) => content
  .split(/\r?\n/u)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'))
  .map(normalizeKeyword)
  .filter(Boolean);

export const customBlacklistPath = () =>
  resolve(process.env.ADDRESS_BLACKLIST_FILE || 'config/blacklist.txt');

export const customBlacklistKeywords = (now = Date.now()) => {
  const path = customBlacklistPath();
  if (cache.path === path && now - cache.checkedAt < RELOAD_INTERVAL_MS) return cache.keywords;
  cache.checkedAt = now;
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    cache.path = path;
    cache.mtimeMs = 0;
    cache.keywords = [];
    return cache.keywords;
  }
  if (cache.path === path && cache.mtimeMs === mtimeMs) return cache.keywords;
  try {
    cache.keywords = parseKeywords(readFileSync(path, 'utf8'));
  } catch {
    cache.keywords = [];
  }
  cache.path = path;
  cache.mtimeMs = mtimeMs;
  return cache.keywords;
};

export const matchesCustomBlacklist = (values) => {
  const keywords = customBlacklistKeywords();
  if (!keywords.length) return null;
  for (const value of values) {
    if (!value) continue;
    const haystack = normalizeKeyword(String(value));
    if (!haystack) continue;
    for (const keyword of keywords) {
      if (haystack.includes(keyword)) return keyword;
    }
  }
  return null;
};
