import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  root: 'web',
  publicDir: false,
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../.runtime/web',
    emptyOutDir: true,
    sourcemap: false,
  },
});
