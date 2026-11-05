import { defineConfig } from 'vite';
export default defineConfig({
  base: './',
  build: { target: 'es2022', sourcemap: false },
  server: { port: 4173, strictPort: true },
  preview: { port: 4173, strictPort: true },
});
