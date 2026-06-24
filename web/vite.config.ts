import vue from "@vitejs/plugin-vue";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [vue()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(fileURLToPath(new URL(".", import.meta.url)), "index.html"),
        company: resolve(fileURLToPath(new URL(".", import.meta.url)), "company.html"),
      },
    },
  },
});
