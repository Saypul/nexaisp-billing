import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiTarget = process.env.API_TARGET || 'http://localhost:8000';

export default defineConfig({
  plugins: [react()],
  // Dua halaman: admin (index.html) dan portal pelanggan (portal.html, dibungkus APK).
  build: { rollupOptions: { input: { main: resolve(import.meta.dirname, 'index.html'), portal: resolve(import.meta.dirname, 'portal.html') } } },
  server: { proxy: { '/api': apiTarget } },
  preview: { proxy: { '/api': apiTarget } },
});
