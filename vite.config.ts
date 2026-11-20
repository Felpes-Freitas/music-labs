import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

const target = `http://127.0.0.1:${process.env.MUSICLABS_PORT ?? 7717}`;

export default defineConfig({
  plugins: [preact()],
  root: '.',
  build: { outDir: 'dist', target: 'es2022' },
  worker: { format: 'es' },
  server: {
    port: 5173,
    proxy: {
      '/api': { target, changeOrigin: false },
      '/ws': { target: target.replace('http', 'ws'), ws: true },
    },
  },
});
