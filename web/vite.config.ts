import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API_PORT = process.env.HELM_API_PORT ?? '4000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // In dev the SPA and API run on separate ports; in production the API
    // serves the built assets itself, so no proxy is involved.
    proxy: {
      '/api': { target: `http://localhost:${API_PORT}`, changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: false },
});
