import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';

export default defineConfig({
  base: '/cuttable3d/',
  plugins: [wasm(), topLevelAwait()],
  optimizeDeps: {
    exclude: ['manifold-3d', '@dimforge/rapier3d-compat'],
  },
});
