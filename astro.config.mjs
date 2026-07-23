import react from '@astrojs/react';
import { defineConfig } from 'astro/config';

export default defineConfig({
  output: 'static',
  integrations: [react()],
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
