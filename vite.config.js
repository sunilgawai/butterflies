import { defineConfig } from 'vite';

/**
 * Optional. The project runs from any static file server without a build step —
 * index.html carries an import map that resolves three from a CDN.
 *
 * Use Vite if you would rather bundle a local copy: `npm install && npm run dev`
 * resolves `three/webgpu` and `three/tsl` from node_modules and the import map
 * is simply ignored.
 */
export default defineConfig({
  server: { open: true },
  build: {
    target: 'esnext',
    modulePreload: { polyfill: false },
  },
});
