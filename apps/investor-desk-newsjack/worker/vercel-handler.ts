import { createClient } from "@libsql/client";
import { join } from "node:path";
import { handleApiRequest } from "./handler";
import { applyTursoMigrations } from "./turso-migrations";
import { createTursoWorkerEnv } from "./turso-storage";
import type { WorkerEnv } from "./types";

export const VERCEL_PRIVATE_OWNER_ID = "newsjack-private-investor-v1";

interface VercelRuntime {
  isProduction(): boolean;
  loadEnvironment(): Promise<WorkerEnv>;
}

export function createVercelRequestHandler(runtime: VercelRuntime): (request: Request) => Promise<Response> {
  return async (request) => {
    if (!runtime.isProduction()) return json({ error: "The private production data service is not enabled in this deployment." }, 503);
    try {
      return await handleApiRequest(request, await runtime.loadEnvironment(), VERCEL_PRIVATE_OWNER_ID, "private-vercel");
    } catch {
      return json({ error: "The private data service is unavailable. No successful save or refresh is being claimed." }, 503);
    }
  };
}

let environmentPromise: Promise<WorkerEnv> | null = null;

async function loadProductionEnvironment(): Promise<WorkerEnv> {
  if (process.env.VERCEL_ENV !== "production") throw new Error("Production Vercel environment required.");
  const url = process.env.NEWSJACK_TURSO_TURSO_DATABASE_URL?.trim();
  const authToken = process.env.NEWSJACK_TURSO_TURSO_AUTH_TOKEN?.trim();
  if (!url || !authToken) throw new Error("Production database credentials are not configured.");
  const client = createClient({ url, authToken, intMode: "number" });
  try {
    await applyTursoMigrations(client, join(process.cwd(), "drizzle"));
  } catch (error) {
    client.close();
    throw error;
  }
  return createTursoWorkerEnv({
    client,
    TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
    NEWSJACK_SEC_USER_AGENT: process.env.NEWSJACK_SEC_USER_AGENT,
    requestBudgetMs: 45_000,
  });
}

async function productionEnvironment(): Promise<WorkerEnv> {
  if (environmentPromise === null) {
    environmentPromise = loadProductionEnvironment().catch((error: unknown) => {
      environmentPromise = null;
      throw error;
    });
  }
  return environmentPromise;
}

export const handleVercelApiRequest = createVercelRequestHandler({
  isProduction: () => process.env.VERCEL_ENV === "production",
  loadEnvironment: productionEnvironment,
});

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
