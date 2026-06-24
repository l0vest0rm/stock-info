import { resolve } from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  publicDir: false,
  build: {
    emptyOutDir: false,
    lib: {
      entry: resolve(__dirname, 'src/layout.ts'),
      formats: ['iife'],
      name: 'LicaiLayout',
      fileName: () => 'js/layout.js',
    },
    outDir: 'dist',
    sourcemap: true,
    target: 'es2017',
  },
})
