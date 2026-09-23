import { resolve } from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest(async () => ({
    main: "./worker/index.ts",
    wrangler: { configPath: "./wrangler.test.jsonc" },
    miniflare: {
      bindings: {
        TEST_MIGRATIONS: await readD1Migrations(resolve(import.meta.dirname, "drizzle")),
      },
    },
  }))],
  test: {
    include: ["worker-tests/**/*.test.ts"],
    fileParallelism: false,
    maxWorkers: 1,
  },
});
