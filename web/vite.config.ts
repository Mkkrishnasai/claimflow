import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // ADR-21: same-origin /api; unknown paths fall back to index.html (vite default SPA mode)
  server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy: { '/api': { target: 'http://127.0.0.1:3001', xfwd: true } } },
});
