import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The dashboard talks to a bunqueue server's HTTP API (default :6790).
// In dev, requests to `/api/*` are proxied there so there is no CORS setup and
// no need to enable AUTH for local use. In prod, set VITE_BUNQUEUE_URL to the
// server origin (see src/lib/api.ts) or serve the built assets behind the same
// origin as the server.
export default defineConfig({
  // Served from `/` in dev and Docker; GitHub Pages sets VITE_BASE to the
  // project sub-path (e.g. `/bunqueue-dashboard/`) so asset URLs resolve.
  base: process.env.VITE_BASE ?? '/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    rollupOptions: {
      output: {
        // Split the React runtime (react, react-dom, react-router[-dom]) into
        // its own chunk so app-only changes don't bust the vendor cache on
        // returning visitors. `react-router` must match too: in React Router 7
        // it holds the entire router implementation (react-router-dom is a
        // tiny re-export shim). Function form is required — Vite 8 / Rolldown
        // rejects the object form of manualChunks.
        manualChunks(id) {
          if (id.includes('node_modules') && /[\\/]react(-dom|-router(-dom)?)?[\\/]/.test(id)) {
            return 'react-vendor';
          }
        },
      },
    },
  },
  server: {
    port: 5273,
    // Fail fast when 5273 is taken (a leftover dev server) instead of silently
    // serving on 5274 while scripts/dev.ts announces :5273 — that banner would
    // point the user at the stale instance and edits would "have no effect".
    strictPort: true,
    // The control agent runs a bunqueue server whose SQLite database lives in
    // ./data (and its -wal/-shm sidecars are written on every DB operation).
    // Without this, each write trips Vite's file watcher and reloads the whole
    // page — continuously during any activity (and constantly under Benchmark
    // load). Ignoring ./data keeps the dev page stable; only source changes HMR.
    watch: {
      ignored: ['**/data/**'],
    },
    proxy: {
      '/api': {
        target: 'http://localhost:6790',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
});
