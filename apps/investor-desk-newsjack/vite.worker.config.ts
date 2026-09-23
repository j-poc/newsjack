import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: false,
    lib: {
      entry: resolve(import.meta.dirname, "worker/index.ts"),
      formats: ["es"],
      fileName: () => "server/index.js",
    },
  },
});
