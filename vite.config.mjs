import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite handles ONLY the renderer. The main process and the runner are plain
// CommonJS run directly by Electron/Node — no bundling, no transpilation.
export default defineConfig({
  root: 'src/renderer',
  plugins: [react()],
  base: './',
  server: { port: 5183, strictPort: true },
  build: {
    outDir: '../../out/renderer',
    emptyOutDir: true,
  },
});
