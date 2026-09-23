import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { fetchCaptured, readCaptured } from "../worker/capture";
import { InvestorRepository, type SecFilingQueueInput, type SecQueueIssuer } from "../worker/repository";
import { RequestBudget, type WorkerEnv } from "../worker/types";
import worker from "../worker/index";

interface TestEnv extends WorkerEnv {
  TEST_MIGRATIONS: Array<{ name: string; queries: string[] }>;
}

const testEnv = env as unknown as TestEnv;

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SEC recovery guards", () => {
  it("retains captured discovery replay after partial queue writes and rejects corrupted raw bytes", async () => {
    const ownerId = crypto.randomUUID();
    const cik = "0000001234";
    const issuer: SecQueueIssuer = {
      cik,
      ticker: "EXMP",
      name: "Example Industries",
      exchange: "NASDAQ",
    };
    const accessions = Array.from({ length: 100 }, (_, index) => `${cik}-26-${String(index + 1).padStart(6, "0")}`);
    const submissionText = JSON.stringify({ filings: { recent: {
      form: accessions.map(() => "8-K"),
      accessionNumber: accessions,
      primaryDocument: accessions.map((_, index) => `filing-${index + 1}.htm`),
      primaryDocDescription: accessions.map(() => "Current report"),
      filingDate: accessions.map(() => "2026-09-23"),
      acceptanceDateTime: accessions.map(() => "20260923120000"),
    } } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(submissionText, {
      headers: { "content-type": "application/json" },
    })));

    const captured = await fetchCaptured(
      testEnv,
      ownerId,
      "sec",
      `submissions:${cik}`,
      `https://data.sec.gov/submissions/CIK${cik}.json`,
      { headers: { "User-Agent": "Newsjack test contact: test@example.invalid" } },
      new RequestBudget(2),
    );
    const repository = new InvestorRepository(testEnv, ownerId);
    const lockToken = crypto.randomUUID();
    expect(await repository.acquireRefreshLock(lockToken, new Date().toISOString())).toBe(true);

    try {
      await repository.beginSecDiscoveryReplay("public", issuer, captured.capture, lockToken);
      const replayBeforeQueue = await repository.getSecDiscoveryReplay("public", cik);
      expect(replayBeforeQueue).toMatchObject({
        issuer,
        capture: { ownerId, nativeId: `submissions:${cik}`, sha256: captured.capture.sha256 },
      });

      const originalBatch = testEnv.DB.batch.bind(testEnv.DB);
      let batchCalls = 0;
      const failingDb = new Proxy(testEnv.DB, {
        get(target, property) {
          if (property === "batch") return async (statements: D1PreparedStatement[]) => {
            batchCalls += 1;
            if (batchCalls === 2) throw new Error("injected later queue chunk failure");
            return originalBatch(statements);
          };
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as D1Database;
      const failingRepository = new InvestorRepository({ ...testEnv, DB: failingDb }, ownerId);
      const discoveredAt = new Date().toISOString();
      await expect(failingRepository.queueSecFilings(
        "public",
        accessions.map((accession, index) => queueFiling(cik, accession, index + 1, issuer, discoveredAt)),
        captured.capture,
        lockToken,
        discoveredAt,
        cik,
      )).rejects.toThrow("injected later queue chunk failure");
      expect(batchCalls).toBe(2);

      const queued = await testEnv.DB.prepare(
        "SELECT COUNT(*) AS count FROM sec_filing_queue WHERE owner_id = ?",
      ).bind(ownerId).first<{ count: number }>();
      expect(queued?.count).toBe(88);
      expect(await repository.getSecDiscoveryReplay("public", cik)).toMatchObject({
        capture: { sha256: captured.capture.sha256, objectKey: captured.capture.objectKey },
      });

      const corruptedText = submissionText.replace('"8-K"', '"8-X"');
      expect(corruptedText).not.toBe(submissionText);
      await testEnv.BUCKET.put(captured.capture.objectKey, new TextEncoder().encode(corruptedText), {
        customMetadata: { provider: "sec", sha256: captured.capture.sha256 },
      });
      await expect(readCaptured(testEnv, ownerId, captured.capture)).rejects.toMatchObject({
        provider: "sec",
        stage: "replay_capture_digest",
      });
      expect(await repository.getSecDiscoveryReplay("public", cik)).toMatchObject({
        capture: { sha256: captured.capture.sha256, objectKey: captured.capture.objectKey },
      });
    } finally {
      await repository.releaseRefreshLock(lockToken);
    }
  });

  it("replays the original watchlist capture after its filing dates age past the seven-day window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const originalObservedAt = new Date("2026-09-23T12:00:00.000Z");
    vi.setSystemTime(originalObservedAt);

    const ownerId = crypto.randomUUID();
    const cik = "0000001234";
    const identity = {
      kind: "issuer",
      name: "Example Industries",
      ticker: { kind: "ticker", value: "EXMP" },
      cik: { kind: "cik", value: cik },
    };
    const accessions = Array.from({ length: 100 }, (_, index) => `${cik}-26-${String(index + 1).padStart(6, "0")}`);
    const submissionText = JSON.stringify({ filings: { recent: {
      form: accessions.map(() => "8-K"),
      accessionNumber: accessions,
      primaryDocument: accessions.map((_, index) => `filing-${index + 1}.htm`),
      primaryDocDescription: accessions.map(() => "Current report"),
      filingDate: accessions.map(() => "2026-09-23"),
      acceptanceDateTime: accessions.map(() => "20260923120000"),
    } } });
    let submissionsFetches = 0;
    let primaryDocumentFetches = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === "data.sec.gov" && url.pathname === `/submissions/CIK${cik}.json`) {
        submissionsFetches += 1;
        return new Response(submissionText, { headers: { "content-type": "application/json" } });
      }
      if (url.hostname === "www.sec.gov") {
        primaryDocumentFetches += 1;
        return new Response("primary document intentionally unavailable", { status: 503 });
      }
      return new Response("unexpected provider request", { status: 500 });
    }));

    try {
      const added = await worker.fetch(workerRequest("/api/watchlist", ownerId, { action: "add", issuer: identity }), testEnv);
      expect(added.status).toBe(200);

      const originalBatch = testEnv.DB.batch.bind(testEnv.DB);
      let firstQueueChunkWritten = false;
      let partialFailureInjected = false;
      const failingDb = new Proxy(testEnv.DB, {
        get(target, property) {
          if (property === "batch") return async (statements: D1PreparedStatement[]) => {
            if (!firstQueueChunkWritten && statements.length === 90) {
              const result = await originalBatch(statements);
              firstQueueChunkWritten = true;
              return result;
            }
            if (firstQueueChunkWritten && !partialFailureInjected && statements.length === 14) {
              partialFailureInjected = true;
              throw new Error("injected later queue chunk failure");
            }
            return originalBatch(statements);
          };
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as D1Database;
      const requestEnv = {
        ...testEnv,
        DB: failingDb,
        NEWSJACK_SEC_USER_AGENT: "Newsjack test contact: test@example.invalid",
      };
      const interrupted = await worker.fetch(
        workerRequest("/api/refresh", ownerId, { source: "watchlist" }),
        requestEnv,
      );
      expect(interrupted.status).toBe(502);
      expect(firstQueueChunkWritten).toBe(true);
      expect(partialFailureInjected).toBe(true);
      expect(submissionsFetches).toBe(1);

      const repository = new InvestorRepository(testEnv, ownerId);
      const replay = await repository.getSecDiscoveryReplay("watchlist", cik);
      expect(replay).not.toBeNull();
      expect(Date.parse(replay!.capture.observedAt)).toBe(originalObservedAt.getTime());
      const partialRows = await testEnv.DB.prepare(
        "SELECT COUNT(*) AS count FROM sec_filing_queue WHERE owner_id = ?",
      ).bind(ownerId).first<{ count: number }>();
      expect(partialRows?.count).toBe(88);
      expect(primaryDocumentFetches).toBeGreaterThan(0);

      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
      const filingTimestamp = Date.parse("2026-09-23T00:00:00.000Z");
      vi.setSystemTime(new Date(originalObservedAt.getTime() + 8 * 24 * 60 * 60 * 1000));
      expect(filingTimestamp).toBeGreaterThanOrEqual(originalObservedAt.getTime() - sevenDaysMs);
      expect(filingTimestamp).toBeLessThan(Date.now() - sevenDaysMs);

      const replayed = await worker.fetch(
        workerRequest("/api/refresh", ownerId, { source: "watchlist" }),
        { ...testEnv, NEWSJACK_SEC_USER_AGENT: "Newsjack test contact: test@example.invalid" },
      );
      expect(replayed.status).toBe(502);
      expect(submissionsFetches).toBe(1);
      expect(primaryDocumentFetches).toBeGreaterThan(1);

      const queued = await testEnv.DB.prepare(
        "SELECT native_id FROM sec_filing_queue WHERE owner_id = ? ORDER BY native_id",
      ).bind(ownerId).all<{ native_id: string }>();
      expect(queued.results.map((row) => row.native_id)).toEqual(
        accessions.map((accession) => `SEC:${cik}:${accession}`).sort(),
      );
      expect(await repository.getSecDiscoveryReplay("watchlist", cik)).toBeNull();
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("stops before provider fetch when the refresh storage guard throws", async () => {
    const providerFetch = vi.fn();
    vi.stubGlobal("fetch", providerFetch);
    const budget = new RequestBudget(1);

    await expect(fetchCaptured(
      testEnv,
      crypto.randomUUID(),
      "typesafe_ai",
      "screening:before-request-storage-error",
      "https://api.typesafe.ai/v1/systemone",
      { method: "POST" },
      budget,
      [],
      async () => {
        throw new Error("D1 refresh lock storage unavailable");
      },
    )).rejects.toMatchObject({
      provider: "worker",
      stage: "refresh_guard_unavailable",
    });

    expect(providerFetch).not.toHaveBeenCalled();
    expect(budget.count).toBe(0);
  });
});

function queueFiling(
  cik: string,
  accession: string,
  index: number,
  issuer: SecQueueIssuer,
  now: string,
): SecFilingQueueInput {
  return {
    nativeId: `SEC:${cik}:${accession}`,
    cik,
    accession,
    issuer,
    form: "8-K",
    primaryDocument: `filing-${index}.htm`,
    primaryDescription: "Current report",
    filedAt: now,
    availableAt: now,
    availablePrecision: "second",
    sourceVersionDigest: index.toString(16).padStart(64, "0"),
    contractDigest: "c".repeat(64),
  };
}

function workerRequest(path: string, ownerId: string, body: unknown): Request {
  return new Request(`https://desk.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://desk.test",
      "oai-authenticated-user-id": ownerId,
    },
    body: JSON.stringify(body),
  });
}
