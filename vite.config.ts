import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * AviationWeather.gov rejects browser requests that lack a self-identifying
 * User-Agent, and its endpoints send no CORS headers. Both dev and production
 * therefore reach it through a same-origin proxy: this dev proxy here, and the
 * Cloudflare Pages Function in ./functions for deployed builds.
 */
const AWC_UPSTREAM = 'https://aviationweather.gov/api/data';
const OPENSKY_UPSTREAM = 'https://opensky-network.org/api';
const AWC_USER_AGENT =
  'AetherSphere4D-Weather-Twin/1.0 (https://aethersphere.pages.dev)';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      // OpenSky is checked first: its paths live under the same /api/awc prefix
      // so the client needs only one proxy base, but it must not be rewritten
      // with the AWC data root.
      '/api/awc/opensky': {
        target: OPENSKY_UPSTREAM,
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/api\/awc\/opensky/, ''),
        headers: {
          'User-Agent': AWC_USER_AGENT,
          Accept: 'application/json',
        },
      },
      '/api/awc': {
        target: AWC_UPSTREAM,
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/api\/awc/, ''),
        headers: {
          'User-Agent': AWC_USER_AGENT,
          Accept: 'application/json',
        },
      },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    // The map engine alone is ~800 kB; splitting it out keeps the app shell
    // small enough to paint while MapLibre is still parsing.
    chunkSizeWarningLimit: 900,
    rolldownOptions: {
      output: {
        advancedChunks: {
          groups: [
            // MapLibre is the single largest dependency and changes rarely, so
            // it gets its own long-lived cache entry.
            { name: 'maplibre', test: /node_modules[\/]maplibre-gl/ },
            { name: 'react', test: /node_modules[\/](react|react-dom|scheduler)/ },
            { name: 'vendor', test: /node_modules[\/]/ },
          ],
        },
      },
    },
  },
  worker: {
    format: 'es',
  },
});
