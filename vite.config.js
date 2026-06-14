import { defineConfig } from 'vite';

// Static marketing SPA. index.html lives at the repo root; build emits to /dist,
// which Vercel serves (see vercel.json). three/gsap are chunk-split so the 3D
// payload can be cached independently of app code.
export default defineConfig({
  build: {
    target: 'es2020',
    outDir: 'dist',
    assetsInlineLimit: 2048,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
          gsap: ['gsap'],
        },
      },
    },
  },
});
