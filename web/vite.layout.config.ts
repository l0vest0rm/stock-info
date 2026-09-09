import { defineConfig } from 'vite'

// Kept for the dev:web command. Production/local artifacts share one graph in
// scripts/build-vue-pages.mjs, rather than an independently built layout bundle.
export default defineConfig(({ command }) => {
  if (command === 'build') {
    throw new Error('Use npm run build:web to build layout and page entries together')
  }
  return {
    define: { 'process.env.NODE_ENV': JSON.stringify('development') },
    publicDir: false,
  }
})
