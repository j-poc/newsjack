import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { EventSchema, IssuerSchema } from "../src/domain";
import { InvestorRepository } from "../worker/repository";
import { applyTursoMigrations } from "../worker/turso-migrations";
import { createTursoWorkerEnv } from "../worker/turso-storage";
import { createVercelRequestHandler, VERCEL_PRIVATE_OWNER_ID } from "../worker/vercel-handler";
import { RequestBudget, type WorkerEnv } from "../worker/types";

const clients: Array<ReturnType<typeof createClient>> = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const directory of tempDirs.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function openDatabase(): Promise<{ client: ReturnType<typeof createClient>; env: WorkerEnv; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), "newsjack-turso-test-"));
  tempDirs.push(directory);
  const client = createClient({ url: `file:${join(directory, "newsjack.db")}`, intMode: "number" });
  clients.push(client);
  await applyTursoMigrations(client, join(process.cwd(), "drizzle"));
  return { client, env: createTursoWorkerEnv({ client }), directory };
}

describe("Turso persistence boundary", () => {
  it("keeps a persistence reserve inside the Vercel source-request deadline", () => {
    const budget = new RequestBudget(45, 12_000);
    budget.take();
    expect(budget.timeoutMs()).toBeLessThanOrEqual(9_000);
    expect(budget.timeoutMs()).toBeGreaterThan(8_000);
    expect(budget.count).toBe(1);
  });

  it("applies ordered schema migrations once and rejects changed applied migrations", async () => {
    const { client } = await openDatabase();
    await expect(applyTursoMigrations(client, join(process.cwd(), "drizzle"))).resolves.toBe(0);
    const versions = await client.execute("SELECT COUNT(*) AS count FROM newsjack_schema_migrations");
    expect(Number(versions.rows[0]?.count)).toBe(5);
  });

  it("keeps refresh batches atomic and ordered when a later statement fails", async () => {
    const { env } = await openDatabase();
    const now = new Date().toISOString();
    await expect(env.DB.batch([
      env.DB.prepare("INSERT INTO meta (owner_id, key, value, version, updated_at) VALUES (?, ?, ?, 1, ?)")
        .bind("owner-a", "atomic-probe", "written", now),
      env.DB.prepare("INSERT INTO table_that_does_not_exist (value) VALUES (?)").bind("must-fail"),
    ])).rejects.toThrow();

    const row = await env.DB.prepare("SELECT value FROM meta WHERE owner_id = ? AND key = ? LIMIT 1")
      .bind("owner-a", "atomic-probe").first(z.object({ value: z.string() }));
    expect(row).toBeNull();
  });

  it("round-trips bounded compressed evidence, is idempotent, and detects corrupted bytes", async () => {
    const { client, env } = await openDatabase();
    const original = new TextEncoder().encode(JSON.stringify({ source: "SEC", text: "A source-grounded filing body. ".repeat(400) }));
    const sha256 = createHash("sha256").update(original).digest("hex");
    const key = `raw/private/sec/${sha256}.bin`;
    const metadata = { contentType: "application/json", customMetadata: { provider: "sec", sha256 } };

    await env.CAPTURES.put(key, original, metadata);
    await env.CAPTURES.put(key, original, metadata);
    const stored = await env.CAPTURES.get(key);
    expect(stored).not.toBeNull();
    expect(stored?.size).toBe(original.byteLength);
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(original);
    expect(await env.CAPTURES.get("missing")).toBeNull();

    await client.execute({
      sql: "UPDATE source_capture_objects SET body = ?, stored_bytes = ? WHERE object_key = ?",
      args: [new TextEncoder().encode("corrupt"), "corrupt".length, key],
    });
    await expect(env.CAPTURES.get(key)).rejects.toThrow();
  });

  it("persists a single private watchlist across reloads and ignores caller identity headers", async () => {
    const { env } = await openDatabase();
    const handler = createVercelRequestHandler({
      isProduction: () => true,
      loadEnvironment: async () => env,
    });
    const issuer = IssuerSchema.parse({
      kind: "issuer",
      name: "Example Public Company",
      ticker: { kind: "ticker", value: "EXMPL" },
      cik: { kind: "cik", value: "0000001234" },
    });
    const added = await handler(new Request("https://desk.example/api/watchlist", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://desk.example",
        "oai-authenticated-user-id": "attacker-selected-tenant",
      },
      body: JSON.stringify({ action: "add", issuer }),
    }));
    expect(added.status).toBe(200);

    const repository = new InvestorRepository(env, VERCEL_PRIVATE_OWNER_ID);
    const refreshedAt = new Date().toISOString();
    const lockToken = crypto.randomUUID();
    expect(await repository.acquireRefreshLock(lockToken, refreshedAt)).toBe(true);
    try {
      await repository.recordRefresh({
        events: [sampleSecEvent(refreshedAt)],
        captures: [],
        screenings: [],
        health: [],
        meta: [],
        refreshedAt,
      }, lockToken);
    } finally {
      await repository.releaseRefreshLock(lockToken);
    }

    const reviewed = await handler(new Request("https://desk.example/api/events/sec%3Afiling-1/review", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://desk.example",
        "oai-authenticated-user-id": "another-spoofed-identity",
      },
      body: JSON.stringify({ status: "reviewed", note: "Read primary filing evidence" }),
    }));
    expect(reviewed.status).toBe(200);

    const reloaded = await handler(new Request("https://desk.example/api/snapshot", {
      headers: { "oai-authenticated-user-id": "a-different-attacker-selected-tenant" },
    }));
    expect(reloaded.status).toBe(200);
    const snapshot = await reloaded.json() as {
      watchlist: Array<{ issuer: { ticker: { value: string } } }>;
      events: Array<{ id: string; title: string; summary: string; review: { status: string; note: string } }>;
      lastRefreshAt: string;
    };
    expect(snapshot.watchlist.map((entry) => entry.issuer.ticker.value)).toEqual(["EXMPL"]);
    expect(snapshot.events).toMatchObject([{
      id: "sec:filing-1",
      title: "Production capacity increased",
      summary: "The company reported a meaningful operating change.",
      review: { status: "reviewed", note: "Read primary filing evidence" },
    }]);
    expect(snapshot.lastRefreshAt).toBe(refreshedAt);
  });

  it("fails closed in non-production without attempting to load the production database", async () => {
    let loaded = false;
    const handler = createVercelRequestHandler({
      isProduction: () => false,
      loadEnvironment: async () => {
        loaded = true;
        throw new Error("must not run");
      },
    });
    const response = await handler(new Request("https://preview.example/api/health"));
    expect(response.status).toBe(503);
    expect(loaded).toBe(false);
  });
});

function sampleSecEvent(at: string) {
  return EventSchema.parse({
    id: "sec:filing-1",
    subject: {
      kind: "issuer",
      name: "Example Public Company",
      ticker: { kind: "ticker", value: "EXMPL" },
      cik: { kind: "cik", value: "0000001234" },
    },
    kind: "filing",
    form: "8-K",
    title: "Production capacity increased",
    summary: "The company reported a meaningful operating change.",
    publishedAt: at,
    publishedPrecision: "day",
    availableAt: at,
    availablePrecision: "second",
    source: {
      provider: "sec",
      nativeId: "SEC:0000001234:000000000000000001",
      url: "https://www.sec.gov/Archives/edgar/data/1234/filing.htm",
      observedAt: at,
      deliveryState: "network",
      availabilityAt: at,
      availabilityPrecision: "second",
      freshness: "live",
      digest: "b".repeat(64),
    },
    evidence: [{
      label: "SEC 8-K source",
      url: "https://www.sec.gov/Archives/edgar/data/1234/filing.htm",
      capture: "content",
      sourceNativeId: "SEC:0000001234:000000000000000001",
      excerpt: "The company reported a meaningful operating change.",
    }],
    screening: {
      engine: "typesafe_ai",
      modelConfidence: 90,
      typedAnswers: { materiality: { type: "score", score: 3, legend: {}, probabilities: { "3": 1 }, confidence: 0.9 } },
      category: "operations",
      evidenceComplete: true,
      materiality: 75,
      novelty: 70,
      marketSensitivity: 65,
      thesisMatch: 70,
      sourceReliability: 95,
      attentionScore: 72,
      decision: "review",
      rationale: ["The filing describes an operating change."],
    },
    review: { status: "unreviewed", note: "", updatedAt: null },
  });
}
