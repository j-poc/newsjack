import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z, type ZodType } from "zod";
import { AppSnapshotSchema, EventPageSchema, EventSchema, IssuerSchema, sortEvents } from "../src/domain";
import { InvestorRepository } from "../worker/repository";
import { applyTursoMigrations } from "../worker/turso-migrations";
import { createTursoWorkerEnv } from "../worker/turso-storage";
import { createVercelRequestHandler, VERCEL_PRIVATE_OWNER_ID } from "../worker/vercel-handler";
import { RequestBudget, type SqlDatabase, type SqlInput, type SqlStatement, type WorkerEnv } from "../worker/types";
import { fetchCaptured } from "../worker/capture";

const clients: Array<ReturnType<typeof createClient>> = [];
const tempDirs: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
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
    const metadata = { contentType: "application/json", customMetadata: { provider: "sec", nativeHash: "a".repeat(64), sha256, adapterVersion: "newsjack-worker-1" } };

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

  it("keeps content-addressed evidence idempotent across distinct observation times", async () => {
    const { env } = await openDatabase();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-24T08:00:00.000Z"));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{\"fields\":[],\"data\":[]}", {
      headers: { "content-type": "application/json" },
    })));

    const first = await fetchCaptured(env, "owner-a", "sec", "directory", "https://www.sec.gov/test", {}, new RequestBudget(2));
    vi.setSystemTime(new Date("2026-09-24T08:00:01.000Z"));
    const second = await fetchCaptured(env, "owner-a", "sec", "directory", "https://www.sec.gov/test", {}, new RequestBudget(2));

    expect(first.capture.sha256).toBe(second.capture.sha256);
    expect(first.capture.objectKey).toBe(second.capture.objectKey);
    expect(first.capture.observedAt).not.toBe(second.capture.observedAt);
    const stored = await env.CAPTURES.get(first.capture.objectKey);
    expect(stored?.customMetadata).toEqual({
      provider: "sec",
      nativeHash: first.capture.objectKey.split("/")[3],
      sha256: first.capture.sha256,
      adapterVersion: "newsjack-worker-1",
    });
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
      body: JSON.stringify({ status: "reviewed", note: "Read primary filing evidence", expectedReview: sampleSecEvent(refreshedAt).review }),
    }));
    expect(reviewed.status).toBe(200);

    const staleReview = await handler(new Request("https://desk.example/api/events/sec%3Afiling-1/review", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://desk.example" },
      body: JSON.stringify({ status: "dismissed", note: "stale tab overwrite", expectedReview: sampleSecEvent(refreshedAt).review }),
    }));
    expect(staleReview.status).toBe(409);
    expect(await staleReview.json()).toMatchObject({ event: { review: { status: "reviewed", note: "Read primary filing evidence" } } });

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

  it("pages 1,500 ranked records through the real libSQL adapter without omissions or oversized snapshots", async () => {
    const { env } = await openDatabase();
    const ownerId = VERCEL_PRIVATE_OWNER_ID;
    const repository = new InvestorRepository(env, ownerId);
    const records = Array.from({ length: 1_500 }, (_, index) => paginationEvent(index));
    for (let offset = 0; offset < records.length; offset += 50) {
      const batch = records.slice(offset, offset + 50).map((event) => env.DB.prepare(`
        INSERT INTO events (owner_id, id, provider, native_id, event_json, observed_at, review_status, review_note, review_updated_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(ownerId, event.id, event.source.provider, event.source.nativeId, JSON.stringify(event), event.source.observedAt,
        event.review.status, event.review.note, event.review.updatedAt, event.source.observedAt, event.source.observedAt));
      await env.DB.batch(batch);
    }
    await env.DB.prepare("INSERT INTO meta (owner_id, key, value, version, updated_at) VALUES (?, 'eventCatalogRevision', '1', 1, ?)")
      .bind(ownerId, new Date().toISOString()).run();

    const handler = createVercelRequestHandler({ isProduction: () => true, loadEnvironment: async () => env });
    const firstResponse = await handler(new Request("https://desk.example/api/snapshot?scope=all_public"));
    expect(firstResponse.status).toBe(200);
    const first = AppSnapshotSchema.parse(await firstResponse.json());
    expect(first.events).toHaveLength(20);
    expect(first.eventsTotal).toBe(1_500);
    expect(first.events.map((event) => event.id)).toEqual(sortEvents(records).slice(0, 20).map((event) => event.id));
    expect(new TextEncoder().encode(JSON.stringify(first)).byteLength).toBeLessThan(2_000_000);

    const reviewTarget = await repository.getEvent("sec:pagination-0");
    if (reviewTarget === null) throw new Error("Expected persisted test event to review.");
    const reviewed = await repository.updateReview("sec:pagination-0", { status: "reviewed", note: "Reviewed outside page one.", expectedReview: reviewTarget.review }, new Date().toISOString());
    expect(reviewed).toBe(true);
    const reviewedEvent = await repository.getEvent("sec:pagination-0");
    expect(reviewedEvent?.review.note).toBe("Reviewed outside page one.");

    const traversed = [...first.events];
    let cursor = first.eventsCursor;
    while (cursor !== null) {
      const pageResponse = await handler(new Request(`https://desk.example/api/events?cursor=${encodeURIComponent(cursor)}`));
      expect(pageResponse.status).toBe(200);
      const page = EventPageSchema.parse(await pageResponse.json());
      expect(page.eventsRevision).toBe(first.eventsRevision);
      traversed.push(...page.events);
      cursor = page.eventsCursor;
    }
    expect(traversed).toHaveLength(records.length);
    expect(new Set(traversed.map((event) => event.id)).size).toBe(records.length);
    expect(traversed.map((event) => event.id)).toEqual(sortEvents(records).map((event) => event.id));
    expect(traversed.find((event) => event.id === "sec:pagination-0")?.review.note).toBe("Reviewed outside page one.");

    const staleCursor = first.eventsCursor;
    if (staleCursor === null) throw new Error("Expected a continuation cursor for the test dataset.");
    const refreshedAt = new Date().toISOString();
    const lockToken = crypto.randomUUID();
    expect(await repository.acquireRefreshLock(lockToken, refreshedAt)).toBe(true);
    try {
      await repository.recordRefresh({
        events: [paginationEvent(1_500)], captures: [], screenings: [], health: [], meta: [], refreshedAt,
      }, lockToken);
    } finally {
      await repository.releaseRefreshLock(lockToken);
    }
    const staleResponse = await handler(new Request(`https://desk.example/api/events?cursor=${encodeURIComponent(staleCursor)}`));
    expect(staleResponse.status).toBe(409);
  });

  it("rejects a snapshot if watchlist membership changes between its opening and page reads", async () => {
    const { client, env } = await openDatabase();
    const ownerId = "watchlist-snapshot-race";
    const at = new Date().toISOString();
    const record = sampleSecEvent(at);
    await env.DB.prepare(`
      INSERT INTO events (owner_id, id, provider, native_id, event_json, observed_at, review_status, review_note, review_updated_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(ownerId, record.id, "sec", record.source.nativeId, JSON.stringify(record), at,
      record.review.status, record.review.note, record.review.updatedAt, at, at).run();
    await env.DB.prepare("INSERT INTO meta (owner_id, key, value, version, updated_at) VALUES (?, 'eventCatalogRevision', '1', 1, ?)")
      .bind(ownerId, at).run();
    const repository = new InvestorRepository(env, ownerId);
    const issuer = record.subject;
    if (issuer.kind !== "issuer") throw new Error("Expected a SEC issuer fixture.");

    const originalDb = env.DB;
    let revisionReads = 0;
    let watchlistReadCompleted: () => void = () => undefined;
    const watchlistReadBarrier = new Promise<void>((resolve) => { watchlistReadCompleted = resolve; });
    let added = false;
    env.DB = instrumentDatabase(originalDb, {
      beforeRevisionRead: async () => {
        revisionReads += 1;
        if (revisionReads === 2) await watchlistReadBarrier;
      },
      afterWatchlistRead: async () => {
        if (added) return;
        added = true;
        await repository.addWatchlist(issuer, at);
        watchlistReadCompleted();
      },
    });

    await expect(repository.getSnapshot(new Date(at), "watchlist"))
      .rejects.toMatchObject({ status: 409 });
  });

  it("returns a small explicit error instead of parsing or partially returning an oversized legacy event", async () => {
    const { env } = await openDatabase();
    const ownerId = VERCEL_PRIVATE_OWNER_ID;
    const at = new Date().toISOString();
    const raw = JSON.stringify({ id: "sec:oversized-legacy", availableAt: at, screening: { attentionScore: 99 }, oversizedLegacyPayload: "x".repeat(5_000_000) });
    await env.DB.prepare(`
      INSERT INTO events (owner_id, id, provider, native_id, event_json, observed_at, review_status, review_note, review_updated_at, created_at, updated_at)
      VALUES (?, ?, 'sec', ?, ?, ?, 'unreviewed', '', NULL, ?, ?)
    `).bind(ownerId, "sec:oversized-legacy", "SEC:oversized", raw, at, at, at).run();
    await env.DB.prepare("INSERT INTO meta (owner_id, key, value, version, updated_at) VALUES (?, 'eventCatalogRevision', '1', 1, ?)")
      .bind(ownerId, at).run();
    const handler = createVercelRequestHandler({ isProduction: () => true, loadEnvironment: async () => env });

    const response = await handler(new Request("https://desk.example/api/snapshot?scope=all_public"));
    expect(response.status).toBe(422);
    const body = await response.json() as { error: string };
    expect(body.error).toContain("sec:oversized-legacy");
    expect(new TextEncoder().encode(JSON.stringify(body)).byteLength).toBeLessThan(1_000);
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

function instrumentDatabase(
  database: SqlDatabase,
  hooks: { beforeRevisionRead(): Promise<void>; afterWatchlistRead(): Promise<void> },
): SqlDatabase {
  const unwrapped = new WeakMap<SqlStatement, SqlStatement>();
  function wrap(statement: SqlStatement): SqlStatement {
    const wrapped: SqlStatement = {
      query: statement.query,
      bind(...values: SqlInput[]): SqlStatement {
        return wrap(statement.bind(...values));
      },
      async first<T>(schema: ZodType<T>): Promise<T | null> {
        if (statement.query.sql.includes("key = 'eventCatalogRevision'")) await hooks.beforeRevisionRead();
        return statement.first(schema);
      },
      async all<T>(schema: ZodType<T>): Promise<T[]> {
        const rows = await statement.all(schema);
        if (statement.query.sql.startsWith("SELECT issuer_json, added_at FROM watchlist")) await hooks.afterWatchlistRead();
        return rows;
      },
      run: () => statement.run(),
    };
    unwrapped.set(wrapped, statement);
    return wrapped;
  }
  return {
    prepare(sql: string): SqlStatement { return wrap(database.prepare(sql)); },
    batch: (statements) => database.batch(statements.map((statement) => unwrapped.get(statement) ?? statement)),
  };
}

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

function paginationEvent(index: number) {
  const availableAt = new Date(Date.UTC(2026, 8, 24, 8, index % 60, Math.floor(index / 60))).toISOString();
  const accession = String(index + 1).padStart(18, "0");
  const seed = sampleSecEvent(availableAt);
  return EventSchema.parse({
    ...seed,
    id: `sec:pagination-${index}`,
    title: `Company filing priority ${index}`,
    summary: `A source-grounded SEC filing summary for record ${index}.`,
    publishedAt: availableAt,
    availableAt,
    source: {
      ...seed.source,
      nativeId: `SEC:0000001234:${accession}`,
      url: `https://www.sec.gov/Archives/edgar/data/1234/${accession}/filing.htm`,
      observedAt: availableAt,
      availabilityAt: availableAt,
    },
    evidence: seed.evidence.map((item) => ({ ...item, sourceNativeId: `SEC:0000001234:${accession}`, url: `https://www.sec.gov/Archives/edgar/data/1234/${accession}/filing.htm` })),
    screening: { ...seed.screening, attentionScore: index % 101 },
  });
}
