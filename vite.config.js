import { defineConfig } from 'vite';
const searchHeaders = { 'X-Robots-Tag': 'noindex, nofollow, noimageindex, nosnippet, noarchive, max-image-preview:none', 'Referrer-Policy': 'no-referrer' };
export default defineConfig({
  base: './',
  build: { target: 'es2022', sourcemap: false },
  server: { port: 4173, strictPort: true, headers: searchHeaders },
  preview: { port: 4173, strictPort: true, headers: searchHeaders },
});
