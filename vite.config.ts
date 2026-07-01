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
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5273,
    proxy: {
      '/api': {
        target: 'http://localhost:6790',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
});
