import { readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import react from '@astrojs/react';
import { defineConfig } from 'astro/config';

// Islands import their dependencies in chunks the browser only discovers after each file arrives. Listing an island's
// whole static import graph as modulepreload links lets them download together; `eager` adds the lazy chunks a page
// always needs (the map library on the monitor).
const modulePreload = ({ eager = {} } = {}) => ({
  name: 'island-modulepreload',
  hooks: {
    'astro:build:done': async ({ dir }) => {
      const root = fileURLToPath(dir);
      const imports = new Map();
      const read = async (url) => {
        if (!imports.has(url)) {
          const code = await readFile(`${root}${url}`, 'utf8').catch(() => '');
          const resolve = (specifier) => new URL(specifier, `http://local${url}`).pathname;
          imports.set(url, {
            fixed: [...code.matchAll(/\b(?:import\s*(?:[\w*${},\s]+from\s*)?|export\s*(?:\*|\{[^}]*\})\s*from\s*)["'](\.{1,2}\/[^"']+\.js)["']/gu)].map((match) => resolve(match[1])),
            lazy: [...code.matchAll(/\bimport\(\s*["'`](\.{1,2}\/[^"'`]+\.js)["'`]\s*\)/gu)].map((match) => resolve(match[1]))
          });
        }
        return imports.get(url);
      };
      const graph = async (entries) => {
        const seen = new Set();
        const pending = [...entries];
        while (pending.length) {
          const url = pending.pop();
          if (seen.has(url)) continue;
          seen.add(url);
          pending.push(...(await read(url)).fixed);
        }
        return seen;
      };
      for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.html')) continue;
        const file = `${entry.parentPath}/${entry.name}`;
        const html = await readFile(file, 'utf8');
        const islands = [...html.matchAll(/(?:component|renderer)-url="([^"]+\.js)"/gu)].map((match) => match[1]);
        if (!islands.length || html.includes('rel="modulepreload"')) continue;
        const urls = await graph(islands);
        for (const [island, prefixes] of Object.entries(eager)) {
          if (!islands.some((url) => url.includes(`/${island}.`))) continue;
          const lazy = (await Promise.all([...urls].map(async (url) => (await read(url)).lazy))).flat()
            .filter((url) => prefixes.some((prefix) => url.includes(`/${prefix}.`)));
          for (const url of await graph(lazy)) urls.add(url);
        }
        await writeFile(file, html.replace('</head>', `${[...urls].sort().map((url) => `<link rel="modulepreload" href="${url}">`).join('')}</head>`));
      }
    }
  }
});

export default defineConfig({
  output: 'static',
  integrations: [react(), modulePreload({ eager: { PublicMonitor: ['maplibre-gl'] } })],
  trailingSlash: 'always',
  vite: {
    server: {
      proxy: {
        '/api': 'http://localhost:8787',
        '/sync-control': {
          target: 'http://localhost:8791',
          rewrite: (path) => path.replace(/^\/sync-control/u, '') || '/'
        }
      }
    }
  }
});
