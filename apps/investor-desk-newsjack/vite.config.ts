import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { sites } from "./build/sites-vite-plugin.ts";

export default defineConfig({
  plugins: [react(), sites()],
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
  },
  server: {
    port: Number(process.env.VITE_PORT ?? 5180),
    proxy: { "/api": `http://localhost:${Number(process.env.VITE_API_PORT ?? 8789)}` },
  },
});
