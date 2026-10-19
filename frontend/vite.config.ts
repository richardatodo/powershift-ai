import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    proxy: { '/api': { target: process.env.POWERSHIFT_API_PROXY || 'http://127.0.0.1:8000', changeOrigin: false } },
  },
  test: { include: ['src/**/*.test.ts'] },
});
