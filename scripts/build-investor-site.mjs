import { cp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const app = resolve(root, "apps/investor-desk-newsjack");
for (const config of ["vite.config.ts", "vite.worker.config.ts"]) {
  const result = spawnSync(process.execPath, [resolve(app, "node_modules/vite/bin/vite.js"), "build", "--config", config], {
    cwd: app,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
for (const directory of ["dist", "drizzle"]) {
  const destination = resolve(root, directory);
  await rm(destination, { recursive: true, force: true });
  await cp(resolve(app, directory), destination, { recursive: true });
}
console.log("Investor Worker, client assets, and migrations prepared for Sites.");
