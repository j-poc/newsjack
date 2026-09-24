import { beforeAll, describe, expect, it, vi, afterEach } from "vitest";
import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { EventSchema, IssuerSchema, nowIso, type Event } from "../src/domain";
import { ProviderFailure, type CaptureRecord, type WorkerEnv } from "../worker/types";
import { createCloudflareWorkerEnv, type CloudflareBindings } from "../worker/cloudflare-storage";
import { InvestorRepository, type SecFilingQueueInput } from "../worker/repository";
import { fetchCaptured } from "../worker/capture";
import { RequestBudget } from "../worker/types";
import { screenSource } from "../worker/typesafe";
import { screeningContractDigest } from "../worker/typesafe";
import worker from "../worker/index";

interface TestEnv extends CloudflareBindings {
  TEST_MIGRATIONS: Array<{ name: string; queries: string[] }>;
}

const testEnv = env as unknown as TestEnv;
const workerEnv = (bindings: CloudflareBindings = testEnv): WorkerEnv => createCloudflareWorkerEnv(bindings);

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("private investor Worker", () => {
  it("does not claim rollback when a saved watchlist write loses its response", async () => {
    const snapshot = vi.spyOn(InvestorRepository.prototype, "getSnapshot")
      .mockRejectedValueOnce(new Error("snapshot read unavailable"));
    try {
      const response = await worker.fetch(jsonRequest("/api/watchlist", "investor-lost-response", {
        action: "add", issuer: issuer(),
      }), testEnv);
      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body).toEqual({ error: "The request could not finish. A save may already have completed. Reload the desk to confirm its saved state before retrying." });
      const reloaded = await worker.fetch(ownerRequest("/api/snapshot", "investor-lost-response"), testEnv);
      const saved = await reloaded.json();
      expect(saved).toMatchObject({ watchlist: [{ issuer: { cik: issuer().cik } }] });
    } finally {
      snapshot.mockRestore();
    }
  });

  it("fails closed without Site identity and rejects cross-site writes", async () => {
    const missingIdentity = await worker.fetch(new Request("https://desk.test/api/snapshot"), testEnv);
    expect(missingIdentity.status).toBe(401);

    const crossSite = await worker.fetch(new Request("https://desk.test/api/watchlist", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://attacker.test",
        "oai-authenticated-user-id": "unauthorized-user",
      },
      body: JSON.stringify({ action: "add", issuer: issuer() }),
    }), testEnv);
    expect(crossSite.status).toBe(403);
  });

  it("keeps watchlists isolated by authenticated owner across requests", async () => {
    const added = await worker.fetch(jsonRequest("/api/watchlist", "investor-a", {
      action: "add",
      issuer: issuer(),
    }), testEnv);
    expect(added.status).toBe(200);

    const [owner, other] = await Promise.all([
      worker.fetch(ownerRequest("/api/snapshot", "investor-a"), testEnv),
      worker.fetch(ownerRequest("/api/snapshot", "investor-b"), testEnv),
    ]);
    const ownerBody = await owner.json() as { watchlist: unknown[] };
    const otherBody = await other.json() as { watchlist: unknown[] };
    expect(ownerBody.watchlist).toHaveLength(1);
    expect(otherBody.watchlist).toHaveLength(0);
  });

  it("rejects Finnhub processing without written approval before making any provider request", async () => {
    const providerFetch = vi.fn();
    vi.stubGlobal("fetch", providerFetch);
    const response = await worker.fetch(jsonRequest("/api/refresh", "investor-finnhub-unapproved", { source: "company_news" }), {
      ...testEnv,
      FINNHUB_API_KEY: "test-key-not-a-real-key",
      FINNHUB_PROCESSING_APPROVED: "false",
    });
    expect(response.status).toBe(409);
    expect(providerFetch).not.toHaveBeenCalled();
    const body = await response.json() as { error: string };
    expect(body.error).toContain("written approval");
  });

  it("hides retained Finnhub records and reports the source unavailable while processing is disabled", async () => {
    const ownerId = "investor-finnhub-history";
    const secEvent = sampleEvent();
    const historicalFinnhubEvent = EventSchema.parse({
      ...secEvent,
      id: "finnhub_news:EXMPL:42",
      kind: "news",
      form: "NEWS",
      source: { ...secEvent.source, provider: "finnhub_news", nativeId: "FINNHUB:EXMPL:42" },
      evidence: secEvent.evidence.map((evidence) => ({ ...evidence, label: "Finnhub company news", sourceNativeId: "FINNHUB:EXMPL:42" })),
    });
    const repository = new InvestorRepository(workerEnv({ ...testEnv, FINNHUB_PROCESSING_APPROVED: "false" }), ownerId);
    await commitRefresh(repository, {
      ...refreshWrite(historicalFinnhubEvent, nowIso()),
      health: [{
        provider: "finnhub_news",
        status: "healthy",
        freshness: "live",
        message: "Historical provider check.",
        checkedAt: nowIso(),
      }],
    });

    const disabledResponse = await worker.fetch(ownerRequest("/api/snapshot", ownerId), {
      ...testEnv,
      FINNHUB_PROCESSING_APPROVED: "false",
    });
    const disabledSnapshot = await disabledResponse.json() as { events: Event[]; sourceHealth: Array<{ provider: string; status: string; freshness: string; message: string }> };
    expect(disabledSnapshot.events).toHaveLength(0);
    expect(disabledSnapshot.sourceHealth).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "finnhub_news", status: "offline", freshness: "unavailable", message: expect.stringContaining("Not requested") }),
    ]));

    const enabledResponse = await worker.fetch(ownerRequest("/api/snapshot", ownerId), {
      ...testEnv,
      FINNHUB_PROCESSING_APPROVED: "true",
    });
    const enabledSnapshot = await enabledResponse.json() as { events: Event[] };
    expect(enabledSnapshot.events.map((event) => event.id)).toEqual([historicalFinnhubEvent.id]);
  });

  it("rejects review writes to quarantined Finnhub records before mutation", async () => {
    const ownerId = "investor-finnhub-review-quarantine";
    const secEvent = sampleEvent();
    const historicalFinnhubEvent = EventSchema.parse({
      ...secEvent,
      id: "finnhub_news:EXMPL:quarantined-review",
      kind: "news",
      form: "NEWS",
      source: { ...secEvent.source, provider: "finnhub_news", nativeId: "FINNHUB:EXMPL:quarantined-review" },
      evidence: secEvent.evidence.map((evidence) => ({ ...evidence, sourceNativeId: "FINNHUB:EXMPL:quarantined-review" })),
    });
    const repository = new InvestorRepository(workerEnv({ ...testEnv, FINNHUB_PROCESSING_APPROVED: "false" }), ownerId);
    await commitRefresh(repository, refreshWrite(historicalFinnhubEvent, nowIso()));

    const response = await worker.fetch(jsonRequest(`/api/events/${encodeURIComponent(historicalFinnhubEvent.id)}/review`, ownerId, {
      status: "reviewed",
      note: "This write must be blocked while the provider is quarantined.",
    }), { ...testEnv, FINNHUB_PROCESSING_APPROVED: "false" });
    expect(response.status).toBe(404);

    const stored = await testEnv.DB.prepare(
      "SELECT review_status, review_note, review_updated_at FROM events WHERE owner_id = ? AND id = ?",
    ).bind(ownerId, historicalFinnhubEvent.id).first<{ review_status: string; review_note: string; review_updated_at: string | null }>();
    expect(stored).toEqual({ review_status: "unreviewed", review_note: "", review_updated_at: null });
  });

  it("saves review state atomically and preserves it through duplicate and older source replays", async () => {
    const ownerId = "investor-review";
    const record = sampleEvent();
    const repository = new InvestorRepository(workerEnv(), ownerId);
    const firstRefresh = refreshWrite(record, nowIso());
    await commitRefresh(repository, firstRefresh);

    const saved = await worker.fetch(jsonRequest(`/api/events/${encodeURIComponent(record.id)}/review`, ownerId, {
      status: "reviewed",
      note: "Check the filing against the prior quarter.",
    }), testEnv);
    expect(saved.status).toBe(200);

    await commitRefresh(repository, firstRefresh);
    const older = EventSchema.parse({
      ...record,
      title: "Older observation must not replace this record",
      source: { ...record.source, observedAt: new Date(Date.parse(record.source.observedAt) - 60_000).toISOString() },
    });
    await commitRefresh(repository, refreshWrite(older, new Date(Date.parse(firstRefresh.refreshedAt) + 1_000).toISOString()));

    const loaded = await worker.fetch(ownerRequest("/api/snapshot", ownerId), testEnv);
    const body = await loaded.json() as { events: Event[] };
    expect(body.events).toHaveLength(1);
    expect(body.events[0]?.title).toBe(record.title);
    expect(body.events[0]?.review).toMatchObject({
      status: "reviewed",
      note: "Check the filing against the prior quarter.",
    });
  });

  it("serializes refresh ownership with an expiring compare-and-set lock", async () => {
    const repository = new InvestorRepository(workerEnv(), "investor-lock");
    const now = nowIso();
    expect(await repository.acquireRefreshLock("token-a", now)).toBe(true);
    expect(await repository.acquireRefreshLock("token-b", now)).toBe(false);
    await repository.releaseRefreshLock("token-b");
    expect(await repository.acquireRefreshLock("token-c", now)).toBe(false);
    const afterExpiry = new Date(Date.parse(now) + 5 * 60 * 1000 + 1).toISOString();
    expect(await repository.acquireRefreshLock("token-c", afterExpiry)).toBe(true);
    expect(await repository.renewRefreshLock("token-a", afterExpiry)).toBe(false);
    expect(await repository.renewRefreshLock("token-c", afterExpiry)).toBe(true);
    await repository.releaseRefreshLock("token-a");
    expect(await repository.acquireRefreshLock("token-d", afterExpiry)).toBe(false);
    await repository.releaseRefreshLock("token-c");
    expect(await repository.acquireRefreshLock("token-d", afterExpiry)).toBe(true);
  });

  it("fences stale refresh commits inside the D1 result batch", async () => {
    const ownerId = "investor-lock-fence";
    const repository = new InvestorRepository(workerEnv(), ownerId);
    const staleStartedAt = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    const now = nowIso();
    expect(await repository.acquireRefreshLock("stale-token", staleStartedAt)).toBe(true);
    expect(await repository.acquireRefreshLock("current-token", now)).toBe(true);

    await expect(repository.recordRefresh(refreshWrite(sampleEvent(), now), "stale-token"))
      .rejects.toThrow("Refresh ownership expired");
    const beforeCurrentCommit = await repository.getSnapshot();
    expect(beforeCurrentCommit.events).toHaveLength(0);

    await repository.recordRefresh(refreshWrite(sampleEvent(), now), "current-token");
    const afterCurrentCommit = await repository.getSnapshot();
    expect(afterCurrentCommit.events).toHaveLength(1);
    await repository.releaseRefreshLock("current-token");
  });

  it("redacts API credentials from captured URLs and response bodies", async () => {
    const secret = "test-token-not-a-real-key";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ echoed: secret }), {
      headers: { "content-type": "application/json" },
    })));
    const body = await fetchCaptured(
      workerEnv(),
      "investor-capture",
      "typesafe_ai",
      "capture-redaction-test",
      `https://api.example.test/data?token=${encodeURIComponent(secret)}`,
      { headers: { authorization: `Bearer ${secret}` } },
      new RequestBudget(3),
      [secret],
    );
    expect(body.text).not.toContain(secret);
    expect(body.capture.sourceUrl).not.toContain(secret);
    const stored = await testEnv.BUCKET.get(body.capture.objectKey);
    expect(stored).not.toBeNull();
    expect(await stored?.text()).not.toContain(secret);
  });

  it("defers budget exhaustion before network access and does not retry it as an API failure", async () => {
    const providerFetch = vi.fn();
    vi.stubGlobal("fetch", providerFetch);
    const budget = new RequestBudget(2);
    let beforeRequestCalls = 0;
    await expect(screenSource(workerEnv({ ...testEnv, TYPESAFE_API_KEY: "test-token-not-a-real-key" }), {
      ownerId: "investor-budget-deferral",
      provider: "sec",
      nativeId: "SEC:0000000001:0000000001-26-000001",
      sourceDigest: "a".repeat(64),
      subject: issuer(),
      form: "8-K",
      sourceTitle: "Current report",
      sourceText: "The company expanded production capacity during the quarter.",
      sourceUrl: "https://www.sec.gov/Archives/edgar/data/1/filing.htm",
      sourceObservedAt: nowIso(),
      sourceAvailableAt: nowIso(),
      sourceAvailablePrecision: "day",
      evidenceComplete: false,
      sourceReliability: 95,
      beforeRequest: async () => {
        beforeRequestCalls += 1;
        throw new ProviderFailure("worker", "subrequest_budget", "Safe budget exhausted.");
      },
    }, budget, [])).rejects.toMatchObject({ stage: "subrequest_budget" });
    expect(beforeRequestCalls).toBe(1);
    expect(budget.count).toBe(0);
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("keeps SEC TypeSafe judgments provisional while filing exhibits are not captured", async () => {
    const apiKey = "test-token-not-a-real-key";
    const submittedBodies: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      submittedBodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ model: "jev-latest", answers: validAnswers() }), {
        headers: { "content-type": "application/json" },
      });
    }));

    const captures: CaptureRecord[] = [];
    const result = await screenSource(workerEnv({ ...testEnv, TYPESAFE_API_KEY: apiKey }), {
      ownerId: "investor-typesafe",
      provider: "sec",
      nativeId: "SEC:0000000001:000000000000000001",
      sourceDigest: "a".repeat(64),
      subject: issuer(),
      form: "8-K",
      sourceTitle: "Current report",
      sourceText: "The company expanded production capacity during the quarter.",
      sourceUrl: "https://www.sec.gov/Archives/edgar/data/1/000000000000000001/report.htm",
      sourceObservedAt: nowIso(),
      sourceAvailableAt: nowIso(),
      sourceAvailablePrecision: "second",
      evidenceComplete: true,
      sourceReliability: 95,
    }, new RequestBudget(3), captures);

    expect(result.model).toBe("jev-latest");
    expect(result.screening.category).toBe("operations");
    expect(result.screening.evidenceComplete).toBe(false);
    expect(result.screening.decision).toBe("review");
    expect(result.screening.engine).toBe("typesafe_ai");
    expect(captures).toHaveLength(1);
    expect(submittedBodies[0]).toMatchObject({
      state: {
        filing: { document_complete: false, document_scope: "Primary SEC filing document only; linked exhibits were not captured." },
        exhibits_not_captured: true,
      },
    });
  });

  it("runs Federal Register capture through TypeSafe, normalization, and durable D1 state", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === "www.federalregister.gov" && url.pathname === "/api/v1/documents.json") {
        expect(url.searchParams.getAll("fields[]")).toEqual([
          "document_number",
          "title",
          "publication_date",
          "abstract",
          "type",
          "html_url",
          "raw_text_url",
          "agencies",
        ]);
        expect(url.searchParams.get("page")).toBe("1");
        return new Response(JSON.stringify({ count: 1, total_pages: 1, next_page_url: null, results: [{
          document_number: "2026-12345",
          title: "Federal Energy Notice",
          publication_date: "2026-09-23",
          abstract: "The Department describes an energy program update.",
          type: "Notice",
          html_url: "https://www.federalregister.gov/documents/2026/09/23/2026-12345/federal-energy-notice",
          raw_text_url: "https://www.federalregister.gov/documents/full_text/text/2026/09/23/2026-12345.txt",
          agencies: [{ name: "Department of Energy", slug: "department-of-energy" }],
        }] }), { headers: { "content-type": "application/json" } });
      }
      if (url.hostname === "www.federalregister.gov" && url.pathname.includes("full_text")) {
        return new Response("<html><body><p>The Department of Energy outlines a new grid-resilience program for regional utilities. The notice explains eligibility, timing, and a revised allocation of federal support that may affect regulated power companies.</p></body></html>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (url.hostname === "api.typesafe.ai") {
        return new Response(JSON.stringify({ model: "jev-latest", answers: validAnswers() }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("unexpected provider request", { status: 500 });
    }));

    const response = await worker.fetch(jsonRequest("/api/refresh", "investor-federal-live", { source: "federal" }), {
      ...testEnv,
      TYPESAFE_API_KEY: "test-token-not-a-real-key",
    });
    expect(response.status).toBe(200);
    const snapshot = await response.json() as { events: Event[]; sourceHealth: Array<{ provider: string; status: string }> };
    expect(snapshot.events).toHaveLength(1);
    expect(snapshot.events[0]?.title).toContain("The Department of Energy outlines");
    expect(snapshot.events[0]?.title).not.toBe("Federal Energy Notice");
    expect(snapshot.events[0]?.screening.category).toBe("operations");
    expect(snapshot.sourceHealth).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "federal_register", status: "healthy" }),
      expect.objectContaining({ provider: "typesafe_ai", status: "healthy" }),
    ]));
    const captureCount = await testEnv.DB.prepare("SELECT COUNT(*) AS count FROM source_captures WHERE owner_id = ?")
      .bind("investor-federal-live").first<{ count: number }>();
    expect(captureCount?.count).toBe(3);
  });

  it("keeps successfully captured Federal Register records but marks an incomplete paginated slice degraded", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === "www.federalregister.gov" && url.pathname === "/api/v1/documents.json") {
        if (url.searchParams.get("page") === "2") return new Response("temporarily unavailable", { status: 503 });
        return new Response(JSON.stringify({ count: 1001, total_pages: 2, next_page_url: "https://www.federalregister.gov/api/v1/documents.json?page=2", results: [{
          document_number: "2026-12346",
          title: "Federal Grid Notice",
          publication_date: "2026-09-23",
          abstract: "The Department describes a grid resilience program update.",
          type: "Notice",
          html_url: "https://www.federalregister.gov/documents/2026/09/23/2026-12346/federal-grid-notice",
          raw_text_url: "https://www.federalregister.gov/documents/full_text/text/2026/09/23/2026-12346.txt",
          agencies: [{ name: "Department of Energy", slug: "department-of-energy" }],
        }] }), { headers: { "content-type": "application/json" } });
      }
      if (url.hostname === "www.federalregister.gov" && url.pathname.includes("full_text")) {
        return new Response("<html><body><p>The Department of Energy sets out a new grid-resilience program for regional utilities. The notice explains eligibility, timing, and an allocation of federal support that may affect regulated power companies.</p></body></html>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (url.hostname === "api.typesafe.ai") {
        return new Response(JSON.stringify({ model: "jev-latest", answers: validAnswers() }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("unexpected provider request", { status: 500 });
    }));

    const response = await worker.fetch(jsonRequest("/api/refresh", "investor-federal-partial", { source: "federal" }), {
      ...testEnv,
      TYPESAFE_API_KEY: "test-token-not-a-real-key",
    });
    expect(response.status).toBe(200);
    const snapshot = await response.json() as { events: Event[]; sourceHealth: Array<{ provider: string; status: string; message: string }> };
    expect(snapshot.events).toHaveLength(1);
    expect(snapshot.sourceHealth).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "federal_register", status: "degraded", message: expect.stringContaining("page") }),
    ]));
  });

  it("surfaces provider failure with a recoverable prior snapshot instead of an empty success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("forbidden", { status: 403 })));
    const response = await worker.fetch(jsonRequest("/api/refresh", "investor-federal-failure", { source: "federal" }), testEnv);
    expect(response.status).toBe(502);
    const body = await response.json() as { error: string; snapshot: { events: Event[]; sourceHealth: Array<{ provider: string; status: string; freshness: string }> } };
    expect(body.error).toContain("No new record passed");
    expect(body.snapshot.events).toHaveLength(0);
    expect(body.snapshot.sourceHealth).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "federal_register", status: "offline", freshness: "unavailable" }),
    ]));
  });

  it("reads an SEC filing from the official directory through the primary document and TypeSafe", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.href === "https://www.sec.gov/files/company_tickers_exchange.json") {
        return new Response(JSON.stringify({
          fields: ["cik", "name", "ticker", "exchange"],
          data: [[1234, "Example Industries", "EXMP", "NASDAQ"]],
        }), { headers: { "content-type": "application/json" } });
      }
      if (url.href === "https://data.sec.gov/submissions/CIK0000001234.json") {
        return new Response(JSON.stringify({ filings: { recent: {
          form: ["8-K"],
          accessionNumber: ["0000001234-26-000001"],
          primaryDocument: ["notice.htm"],
          primaryDocDescription: ["Current report"],
          filingDate: ["2026-09-23"],
          acceptanceDateTime: [nowIso()],
        } } }), { headers: { "content-type": "application/json" } });
      }
      if (url.hostname === "www.sec.gov" && url.pathname.includes("/Archives/edgar/data/")) {
        return new Response("<html><body><p>Example Industries expanded production capacity by 22 percent after completing its second manufacturing line. The filing identifies new customer commitments and higher quarterly capital spending.</p></body></html>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (url.hostname === "api.typesafe.ai") {
        return new Response(JSON.stringify({ model: "jev-latest", answers: validAnswers() }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("unexpected provider request", { status: 500 });
    }));

    const response = await worker.fetch(jsonRequest("/api/refresh", "investor-sec-live", { source: "all_public" }), {
      ...testEnv,
      TYPESAFE_API_KEY: "test-token-not-a-real-key",
      NEWSJACK_SEC_USER_AGENT: "Newsjack test contact: test@example.invalid",
    });
    expect(response.status).toBe(200);
    const snapshot = await response.json() as { events: Event[]; sourceHealth: Array<{ provider: string; status: string }> };
    expect(snapshot.events).toHaveLength(1);
    expect(snapshot.events[0]?.subject).toMatchObject({ kind: "issuer", ticker: { value: "EXMP" } });
    expect(snapshot.events[0]?.title).toContain("Example Industries expanded production capacity");
    expect(snapshot.events[0]?.screening.evidenceComplete).toBe(false);
    expect(snapshot.events[0]?.screening.decision).toBe("review");
    expect(snapshot.events[0]?.evidence[0]?.label).toContain("exhibits not captured");
    expect(snapshot.sourceHealth).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "sec", status: "healthy" }),
      expect.objectContaining({ provider: "typesafe_ai", status: "healthy" }),
    ]));
    const storedSnapshot = await worker.fetch(ownerRequest("/api/snapshot", "investor-sec-live"), testEnv);
    const savedCoverage = await storedSnapshot.json() as {
      publicIssuerCoverage: {
        eligibleIssuers: number;
        activeCoverageIssuers: number;
        issuersScanned: number;
        recentFilingsFound: number;
        recordsScreened: number;
        recordsPlaced: number;
      };
      companyCoverage: unknown;
    };
    expect(savedCoverage.publicIssuerCoverage).toMatchObject({
      eligibleIssuers: 1,
      activeCoverageIssuers: 1,
      issuersScanned: 1,
      recentFilingsFound: 1,
      recordsScreened: 1,
      recordsPlaced: 1,
    });
    expect(savedCoverage.companyCoverage).toBeNull();
    const offset = await testEnv.DB.prepare("SELECT value FROM meta WHERE owner_id = ? AND key = 'secPublicOffset'")
      .bind("investor-sec-live").first<{ value: string }>();
    expect(offset?.value).toBe("0");
  });

  it("searches and rotates across the full SEC exchange directory without a 1,000-issuer cap", async () => {
    const issuerRows = Array.from({ length: 1_105 }, (_, index) => {
      const cik = index + 1;
      return [cik, `Other Exchange Issuer ${cik}`, `ISS${cik}`, "Cboe BZX Exchange"];
    });
    const scannedCiks: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.href === "https://www.sec.gov/files/company_tickers_exchange.json") {
        return new Response(JSON.stringify({ fields: ["cik", "name", "ticker", "exchange"], data: issuerRows }));
      }
      if (url.hostname === "data.sec.gov" && url.pathname.startsWith("/submissions/CIK")) {
        scannedCiks.push(url.pathname.slice("/submissions/CIK".length, -".json".length));
        return new Response(JSON.stringify({ filings: { recent: {
          form: [], accessionNumber: [], primaryDocument: [], primaryDocDescription: [], filingDate: [], acceptanceDateTime: [],
        } } }));
      }
      return new Response("unexpected provider request", { status: 500 });
    }));

    const ownerId = "investor-sec-full-universe";
    const requestEnv = { ...testEnv, NEWSJACK_SEC_USER_AGENT: "Newsjack test contact: test@example.invalid" };
    const search = await worker.fetch(ownerRequest("/api/issuers/search?q=Other%20Exchange%20Issuer%201105", ownerId), requestEnv);
    expect(search.status).toBe(200);
    const matches = await search.json() as Array<{ cik: string; ticker: string; exchange: string }>;
    expect(matches).toContainEqual(expect.objectContaining({ cik: "0000001105", ticker: "ISS1105", exchange: "Cboe BZX Exchange" }));

    const refresh = await worker.fetch(jsonRequest("/api/refresh", ownerId, { source: "all_public" }), requestEnv);
    expect(refresh.status).toBe(200);
    expect(scannedCiks).toHaveLength(8);
    const snapshot = await worker.fetch(ownerRequest("/api/snapshot", ownerId), testEnv);
    const body = await snapshot.json() as { publicIssuerCoverage: { eligibleIssuers: number; activeCoverageIssuers: number; issuersScanned: number } };
    expect(body.publicIssuerCoverage).toMatchObject({ eligibleIssuers: 1_105, activeCoverageIssuers: 1_105, issuersScanned: 8 });
  });

  it("drains multiple unscreened SEC accessions for one issuer across bounded refreshes", async () => {
    const filings = [
      { accession: "0000001234-26-000003", date: "2026-09-23", acceptance: "20260923160000", document: "current.htm" },
      { accession: "0000001234-26-000002", date: "2026-09-22", acceptance: "20260922160000", document: "prior.htm" },
      { accession: "0000001234-26-000001", date: "2026-09-21", acceptance: "20260921160000", document: "earlier.htm" },
    ];
    let typeSafeCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.href === "https://www.sec.gov/files/company_tickers_exchange.json") {
        return new Response(JSON.stringify({ fields: ["cik", "name", "ticker", "exchange"], data: [[1234, "Example Industries", "EXMP", "NASDAQ"]] }));
      }
      if (url.href === "https://data.sec.gov/submissions/CIK0000001234.json") {
        return new Response(JSON.stringify({ filings: { recent: {
          form: filings.map(() => "8-K"),
          accessionNumber: filings.map((filing) => filing.accession),
          primaryDocument: filings.map((filing) => filing.document),
          primaryDocDescription: filings.map((_, index) => `Current report ${index + 1}`),
          filingDate: filings.map((filing) => filing.date),
          acceptanceDateTime: filings.map((filing) => filing.acceptance),
        } } }));
      }
      if (url.hostname === "www.sec.gov" && url.pathname.includes("/Archives/edgar/data/")) {
        const story = url.pathname.endsWith("current.htm") ? "The company opened its third manufacturing line and raised annual output capacity by 22 percent." : url.pathname.endsWith("prior.htm") ? "The company signed a five-year supply agreement for advanced manufacturing equipment." : "The company expanded distribution into four new regional markets during the quarter.";
        return new Response(`<html><body><p>${story}</p></body></html>`);
      }
      if (url.hostname === "api.typesafe.ai") {
        typeSafeCalls += 1;
        return new Response(JSON.stringify({ model: "jev-latest", answers: validAnswers() }));
      }
      return new Response("unexpected provider request", { status: 500 });
    }));

    const ownerId = "investor-sec-queue";
    const requestEnv = { ...testEnv, TYPESAFE_API_KEY: "test-token-not-a-real-key", NEWSJACK_SEC_USER_AGENT: "Newsjack test contact: test@example.invalid" };
    const first = await worker.fetch(jsonRequest("/api/refresh", ownerId, { source: "all_public" }), requestEnv);
    expect(first.status).toBe(200);
    const firstBody = await first.json() as { events: Event[] };
    expect(firstBody.events).toHaveLength(2);
    expect(typeSafeCalls).toBe(2);
    await testEnv.DB.prepare("UPDATE meta SET value = ? WHERE owner_id = ? AND key = 'lastRefreshAttemptAt'")
      .bind(new Date(Date.now() - 120_000).toISOString(), ownerId).run();

    const second = await worker.fetch(jsonRequest("/api/refresh", ownerId, { source: "all_public" }), requestEnv);
    expect(second.status).toBe(200);
    const secondBody = await second.json() as { events: Event[] };
    expect(secondBody.events).toHaveLength(3);
    expect(typeSafeCalls).toBe(3);
    expect(secondBody.events.map((event) => event.source.nativeId)).toEqual(expect.arrayContaining(
      filings.map((filing) => `SEC:0000001234:${filing.accession}`),
    ));
  });

  it("processes a persisted SEC accession after it is absent from the seven-day filing window", async () => {
    let submissionCalls = 0;
    let documentCalls = 0;
    let typeSafeCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.href === "https://www.sec.gov/files/company_tickers_exchange.json") {
        return new Response(JSON.stringify({ fields: ["cik", "name", "ticker", "exchange"], data: [[1234, "Example Industries", "EXMP", "NASDAQ"]] }));
      }
      if (url.href === "https://data.sec.gov/submissions/CIK0000001234.json") {
        submissionCalls += 1;
        const recent = submissionCalls === 1 ? {
          form: ["8-K"], accessionNumber: ["0000001234-26-000008"], primaryDocument: ["durable.htm"],
          primaryDocDescription: ["Current report"], filingDate: ["2026-09-23"], acceptanceDateTime: ["20260923160000"],
        } : { form: [], accessionNumber: [], primaryDocument: [], primaryDocDescription: [], filingDate: [], acceptanceDateTime: [] };
        return new Response(JSON.stringify({ filings: { recent } }));
      }
      if (url.hostname === "www.sec.gov" && url.pathname.includes("/Archives/edgar/data/")) {
        documentCalls += 1;
        if (documentCalls === 1) return new Response("SEC temporary error", { status: 503 });
        return new Response("<html><body><p>The company opened its third manufacturing line and raised annual output capacity by 22 percent.</p></body></html>");
      }
      if (url.hostname === "api.typesafe.ai") {
        typeSafeCalls += 1;
        return new Response(JSON.stringify({ model: "jev-latest", answers: validAnswers() }));
      }
      return new Response("unexpected provider request", { status: 500 });
    }));

    const ownerId = "investor-sec-aged-queue";
    const requestEnv = { ...testEnv, TYPESAFE_API_KEY: "test-token-not-a-real-key", NEWSJACK_SEC_USER_AGENT: "Newsjack test contact: test@example.invalid" };
    const first = await worker.fetch(jsonRequest("/api/refresh", ownerId, { source: "all_public" }), requestEnv);
    expect(first.status).toBe(502);
    const pending = await testEnv.DB.prepare("SELECT native_id, attempt_count FROM sec_filing_queue WHERE owner_id = ?")
      .bind(ownerId).first<{ native_id: string; attempt_count: number }>();
    expect(pending).toEqual({ native_id: "SEC:0000001234:0000001234-26-000008", attempt_count: 1 });

    const eightDaysEarlier = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    await testEnv.DB.prepare("UPDATE sec_filing_queue SET filed_at = ?, next_attempt_at = '2000-01-01T00:00:00.000Z' WHERE owner_id = ?")
      .bind(eightDaysEarlier, ownerId).run();
    await testEnv.DB.prepare("UPDATE meta SET value = ? WHERE owner_id = ? AND key = 'lastRefreshAttemptAt'")
      .bind(new Date(Date.now() - 120_000).toISOString(), ownerId).run();

    const second = await worker.fetch(jsonRequest("/api/refresh", ownerId, { source: "all_public" }), requestEnv);
    expect(second.status).toBe(200);
    const body = await second.json() as { events: Event[] };
    expect(body.events).toHaveLength(1);
    expect(body.events[0]?.source.nativeId).toBe("SEC:0000001234:0000001234-26-000008");
    expect(submissionCalls).toBe(2);
    expect(documentCalls).toBe(2);
    expect(typeSafeCalls).toBe(1);
    const remaining = await testEnv.DB.prepare("SELECT native_id FROM sec_filing_queue WHERE owner_id = ?")
      .bind(ownerId).all();
    expect(remaining.results).toHaveLength(0);
  });

  it("replays partially committed SEC discovery chunks without advancing the cursor early", async () => {
    const ownerId = "investor-sec-queue-chunks";
    const repository = new InvestorRepository(workerEnv(), ownerId);
    const now = nowIso();
    const lockToken = crypto.randomUUID();
    expect(await repository.acquireRefreshLock(lockToken, now)).toBe(true);
    const filings = Array.from({ length: 100 }, (_, index) => secQueueFiling(index + 1, now));
    const capture = secSubmissionCapture(ownerId, now);
    let batchCalls = 0;
    const batchSizes: number[] = [];
    const originalBatch = testEnv.DB.batch.bind(testEnv.DB);
    const failingDb = new Proxy(testEnv.DB, {
      get(target, property) {
        if (property === "batch") return async (statements: D1PreparedStatement[]) => {
          batchCalls += 1;
          batchSizes.push(statements.length);
          if (batchCalls === 2) throw new Error("injected second-batch failure");
          return originalBatch(statements);
        };
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1Database;
    const failingRepository = new InvestorRepository(workerEnv({ ...testEnv, DB: failingDb }), ownerId);
    await expect(failingRepository.queueSecFilings("public", filings, capture, lockToken, now))
      .rejects.toThrow("injected second-batch failure");
    const partial = await testEnv.DB.prepare("SELECT COUNT(*) AS count FROM sec_filing_queue WHERE owner_id = ?")
      .bind(ownerId).first<{ count: number }>();
    expect(partial?.count).toBe(88);
    expect(await repository.getMeta("secPublicOffset")).toBeNull();

    const retryAt = new Date(Date.parse(now) + 60 * 60 * 1000).toISOString();
    await testEnv.DB.prepare(`
      UPDATE sec_filing_queue SET attempt_count = 2, next_attempt_at = ?, last_error = 'temporary document outage'
      WHERE owner_id = ? AND native_id = ?
    `).bind(retryAt, ownerId, filings[0]!.nativeId).run();

    await repository.queueSecFilings("public", filings, capture, lockToken, now);
    const replayed = await testEnv.DB.prepare(`
      SELECT attempt_count, next_attempt_at, last_error FROM sec_filing_queue
      WHERE owner_id = ? AND native_id = ?
    `).bind(ownerId, filings[0]!.nativeId).first<{ attempt_count: number; next_attempt_at: string; last_error: string }>();
    expect(replayed).toEqual({ attempt_count: 2, next_attempt_at: retryAt, last_error: "temporary document outage" });
    await repository.recordRefresh({
      events: [], captures: [], screenings: [], health: [],
      meta: [{ key: "secPublicOffset", value: "8" }], refreshedAt: now,
    }, lockToken);
    const complete = await testEnv.DB.prepare("SELECT COUNT(*) AS count FROM sec_filing_queue WHERE owner_id = ?")
      .bind(ownerId).first<{ count: number }>();
    expect(complete?.count).toBe(100);
    expect((await repository.getMeta("secPublicOffset"))).toBe("8");
    expect(Math.max(...batchSizes)).toBeLessThanOrEqual(90);
    await repository.releaseRefreshLock(lockToken);
  });

  it("does not let a later SEC discovery chunk renew a lock after the original lease expired", async () => {
    const ownerId = "investor-sec-queue-expired-chunk-lock";
    const repository = new InvestorRepository(workerEnv(), ownerId);
    const now = nowIso();
    const oldToken = crypto.randomUUID();
    expect(await repository.acquireRefreshLock(oldToken, now)).toBe(true);
    const filings = Array.from({ length: 100 }, (_, index) => secQueueFiling(index + 1, now));
    const capture = secSubmissionCapture(ownerId, now);
    const originalBatch = testEnv.DB.batch.bind(testEnv.DB);
    let batchCalls = 0;
    const clockAdvancingDb = new Proxy(testEnv.DB, {
      get(target, property) {
        if (property === "batch") return async (statements: D1PreparedStatement[]) => {
          const result = await originalBatch(statements);
          batchCalls += 1;
          if (batchCalls === 1) vi.setSystemTime(new Date(Date.now() + 6 * 60 * 1000));
          return result;
        };
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1Database;
    const clockAdvancingRepository = new InvestorRepository(workerEnv({ ...testEnv, DB: clockAdvancingDb }), ownerId);

    vi.useFakeTimers();
    try {
      await expect(clockAdvancingRepository.queueSecFilings("public", filings, capture, oldToken, now))
        .rejects.toThrow("Refresh ownership expired before SEC discovery was persisted.");
    } finally {
      vi.useRealTimers();
    }
    const persisted = await testEnv.DB.prepare("SELECT COUNT(*) AS count FROM sec_filing_queue WHERE owner_id = ?")
      .bind(ownerId).first<{ count: number }>();
    expect(persisted?.count).toBe(88);

    const newToken = crypto.randomUUID();
    const newNow = new Date(Date.parse(now) + 6 * 60 * 1000).toISOString();
    expect(await repository.acquireRefreshLock(newToken, newNow)).toBe(true);
    await repository.queueSecFilings("public", filings, capture, newToken, newNow);
    const complete = await testEnv.DB.prepare("SELECT COUNT(*) AS count FROM sec_filing_queue WHERE owner_id = ?")
      .bind(ownerId).first<{ count: number }>();
    expect(complete?.count).toBe(100);
    await repository.releaseRefreshLock(newToken);
  });

  it("screens a watched company without requiring an exchange and retains it across reload", async () => {
    const ownerId = "investor-watchlist-no-exchange";
    await worker.fetch(jsonRequest("/api/watchlist", ownerId, { action: "add", issuer: issuer() }), testEnv);
    const filingDate = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === "data.sec.gov") return Response.json({ filings: { recent: {
        form: ["8-K"], accessionNumber: ["0000000001-26-000001"], primaryDocument: ["current.htm"],
        primaryDocDescription: ["Current report"], filingDate: [filingDate], acceptanceDateTime: [""],
      } } });
      if (url.hostname === "www.sec.gov") return new Response("The company increased contracted manufacturing capacity by 18 percent following completion of its new production line.");
      if (url.hostname === "api.typesafe.ai") return Response.json({ model: "jev-latest", answers: validAnswers() });
      return new Response("unexpected request", { status: 500 });
    }));
    const refreshed = await worker.fetch(jsonRequest("/api/refresh", ownerId, { source: "watchlist" }), {
      ...testEnv, TYPESAFE_API_KEY: "test-token-not-a-real-key", NEWSJACK_SEC_USER_AGENT: "Newsjack test test@example.invalid",
    });
    expect(refreshed.status).toBe(200);
    const reloaded = await worker.fetch(ownerRequest("/api/snapshot", ownerId), testEnv);
    const snapshot = await reloaded.json() as { events: Event[]; watchlist: unknown[] };
    expect(snapshot.watchlist).toHaveLength(1);
    expect(snapshot.events).toHaveLength(1);
    expect(snapshot.events[0]?.title).toContain("manufacturing capacity");
    expect(snapshot.events[0]?.source.nativeId).toBe("SEC:0000000001:0000000001-26-000001");
    const pending = await testEnv.DB.prepare("SELECT COUNT(*) AS count FROM sec_filing_queue WHERE owner_id = ?").bind(ownerId).first<{ count: number }>();
    expect(pending?.count).toBe(0);
  });

  it("limits watchlist backlog to currently watched companies and restores it on re-add", async () => {
    const ownerId = "investor-sec-watchlist-queue";
    const repository = new InvestorRepository(workerEnv(), ownerId);
    const now = nowIso();
    const lockToken = crypto.randomUUID();
    expect(await repository.acquireRefreshLock(lockToken, now)).toBe(true);
    const watched = issuer();
    await repository.addWatchlist(watched, now);
    const filing = secQueueFiling(1, now, {
      cik: watched.cik.value,
      ticker: watched.ticker.value,
      name: watched.name,
      exchange: "NASDAQ",
    });
    await repository.queueSecFilings("watchlist", [filing], secSubmissionCapture(ownerId, now), lockToken, now);
    const contractDigest = "c".repeat(64);

    expect(await repository.getDueSecFilings("public", contractDigest, now, 4, 2, lockToken)).toHaveLength(0);
    expect(await repository.getDueSecFilings("watchlist", contractDigest, now, 4, 2, lockToken)).toHaveLength(1);
    await repository.removeWatchlist(watched);
    expect(await repository.getDueSecFilings("watchlist", contractDigest, now, 4, 2, lockToken)).toHaveLength(0);
    await repository.addWatchlist(watched, now);
    expect(await repository.getDueSecFilings("watchlist", contractDigest, now, 4, 2, lockToken)).toHaveLength(1);
    await repository.releaseRefreshLock(lockToken);
  });

  it("serves an unscreened accession before repeated older revalidations", async () => {
    const ownerId = "investor-sec-priority";
    const repository = new InvestorRepository(workerEnv(), ownerId);
    const now = nowIso();
    const token = crypto.randomUUID();
    expect(await repository.acquireRefreshLock(token, now)).toBe(true);
    const old = new Date(Date.parse(now) - 86_400_000).toISOString();
    const filings = Array.from({ length: 7 }, (_, index) => secQueueFiling(index + 1, index === 6 ? now : old));
    await repository.queueSecFilings("public", filings, secSubmissionCapture(ownerId, now), token, now);
    for (const filing of filings.slice(0, 6)) {
      await testEnv.DB.prepare(`INSERT INTO screening_runs_v2
        (owner_id, source_provider, native_id, source_digest, source_version_digest, contract_digest,
         evidence_complete, capture_kind, status, result_digest, prompt_digest, model, screened_at, last_validated_at)
        VALUES (?, 'sec', ?, ?, ?, ?, 0, 'full_text', 'accepted', ?, ?, 'test-model', ?, ?)`)
        .bind(ownerId, filing.nativeId, "a".repeat(64), filing.sourceVersionDigest, filing.contractDigest,
          "b".repeat(64), "d".repeat(64), old, old).run();
    }
    const selected = await repository.getDueSecFilings("public", "c".repeat(64), now, 6, 8, token);
    expect(selected[0]?.nativeId).toBe(filings[6]?.nativeId);
    await repository.releaseRefreshLock(token);
  });

  it("does not bypass issuer backoff through fresh public rotation", async () => {
    const ownerId = "investor-sec-backoff";
    const repository = new InvestorRepository(workerEnv(), ownerId);
    const now = nowIso();
    const token = crypto.randomUUID();
    expect(await repository.acquireRefreshLock(token, now)).toBe(true);
    await repository.recordSecIssuerFailure("public", { cik: "0000001234", ticker: "EXMP", name: "Example Industries" }, "temporary outage", token, now);
    await repository.releaseRefreshLock(token);
    const scanned: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("company_tickers_exchange.json")) return Response.json({ fields: ["cik", "name", "ticker", "exchange"], data: [[1234, "Example Industries", "EXMP", "NASDAQ"], [5678, "Other Industries", "OTHR", "NYSE"]] });
      if (url.hostname === "data.sec.gov") {
        scanned.push(url.pathname);
        return Response.json({ filings: { recent: { form: [], accessionNumber: [], primaryDocument: [], primaryDocDescription: [], filingDate: [], acceptanceDateTime: [] } } });
      }
      return new Response("unexpected request", { status: 500 });
    }));
    await worker.fetch(jsonRequest("/api/refresh", ownerId, { source: "all_public" }), { ...testEnv, NEWSJACK_SEC_USER_AGENT: "Newsjack test test@example.invalid" });
    expect(scanned).toEqual(["/submissions/CIK0000005678.json"]);
    const retry = await testEnv.DB.prepare("SELECT attempt_count FROM sec_issuer_retries WHERE owner_id = ? AND cik = '0000001234'").bind(ownerId).first<{ attempt_count: number }>();
    expect(retry?.attempt_count).toBe(1);
  });

  it("revalidates a previously screened SEC source and refreshes the saved observation time", async () => {
    let typeSafeCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.href === "https://www.sec.gov/files/company_tickers_exchange.json") {
        return new Response(JSON.stringify({ fields: ["cik", "name", "ticker", "exchange"], data: [[1234, "Example Industries", "EXMP", "NASDAQ"]] }));
      }
      if (url.href === "https://data.sec.gov/submissions/CIK0000001234.json") {
        return new Response(JSON.stringify({ filings: { recent: {
          form: ["8-K"], accessionNumber: ["0000001234-26-000009"], primaryDocument: ["stable.htm"],
          primaryDocDescription: ["Current report"], filingDate: ["2026-09-23"], acceptanceDateTime: ["20260923090000"],
        } } }));
      }
      if (url.hostname === "www.sec.gov" && url.pathname.endsWith("stable.htm")) {
        return new Response("The company opened its second manufacturing line and increased contracted production capacity by 18 percent.");
      }
      if (url.hostname === "api.typesafe.ai") {
        typeSafeCalls += 1;
        return new Response(JSON.stringify({ model: "jev-latest", answers: validAnswers() }));
      }
      return new Response("unexpected provider request", { status: 500 });
    }));

    const ownerId = "investor-sec-revalidation";
    const requestEnv = { ...testEnv, TYPESAFE_API_KEY: "test-token-not-a-real-key", NEWSJACK_SEC_USER_AGENT: "Newsjack test contact: test@example.invalid" };
    const first = await worker.fetch(jsonRequest("/api/refresh", ownerId, { source: "all_public" }), requestEnv);
    const firstSnapshot = await first.json() as { events: Event[] };
    expect(firstSnapshot.events).toHaveLength(1);
    const previousObservation = new Date(Date.now() - 25 * 60 * 1000).toISOString();
    const staleEvent = EventSchema.parse({
      ...firstSnapshot.events[0],
      source: { ...firstSnapshot.events[0]?.source, observedAt: previousObservation, freshness: "stale" },
    });
    await testEnv.DB.prepare("UPDATE events SET event_json = ?, observed_at = ? WHERE owner_id = ? AND provider = 'sec'")
      .bind(JSON.stringify(staleEvent), previousObservation, ownerId).run();
    await testEnv.DB.prepare("UPDATE screening_runs_v2 SET last_validated_at = ? WHERE owner_id = ? AND source_provider = 'sec'")
      .bind(previousObservation, ownerId).run();
    await testEnv.DB.prepare("UPDATE meta SET value = ? WHERE owner_id = ? AND key = 'lastRefreshAttemptAt'")
      .bind(previousObservation, ownerId).run();

    const second = await worker.fetch(jsonRequest("/api/refresh", ownerId, { source: "all_public" }), requestEnv);
    const refreshed = await second.json() as { events: Event[] };
    expect(refreshed.events[0]?.source.observedAt).not.toBe(previousObservation);
    expect(refreshed.events[0]?.source.freshness).toBe("live");
    expect(typeSafeCalls).toBe(1);
  });

  it("advances the SEC rotation past a malformed issuer only after its retry is durable", async () => {
    let malformedOnce = true;
    const scannedCiks: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.href === "https://www.sec.gov/files/company_tickers_exchange.json") {
        const issuers = Array.from({ length: 9 }, (_, index) => [5000 + index, `Example Industries ${index}`, `EX${index}`, "NASDAQ"]);
        return new Response(JSON.stringify({ fields: ["cik", "name", "ticker", "exchange"], data: issuers }));
      }
      if (url.hostname === "data.sec.gov" && url.pathname.startsWith("/submissions/CIK")) {
        scannedCiks.push(url.pathname.slice("/submissions/CIK".length, -".json".length));
        if (!malformedOnce) return new Response(JSON.stringify({ filings: { recent: {
          form: [], accessionNumber: [], primaryDocument: [], primaryDocDescription: [], filingDate: [], acceptanceDateTime: [],
        } } }));
        malformedOnce = false;
        return new Response(JSON.stringify({ filings: { recent: {
          form: ["8-K"], accessionNumber: ["0000001234-26-000001"], primaryDocument: ["notice.htm"],
          primaryDocDescription: ["Current report"], acceptanceDateTime: ["20260923160000"],
        } } }));
      }
      return new Response("unexpected provider request", { status: 500 });
    }));

    const ownerId = "investor-sec-malformed";
    const response = await worker.fetch(jsonRequest("/api/refresh", ownerId, { source: "all_public" }), {
      ...testEnv,
      NEWSJACK_SEC_USER_AGENT: "Newsjack test contact: test@example.invalid",
    });
    expect(response.status).toBe(502);
    const body = await response.json() as { snapshot?: { events: Event[]; sourceHealth: Array<{ provider: string; status: string; message: string }> }; events?: Event[]; sourceHealth?: Array<{ provider: string; status: string; message: string }> };
    const snapshot = body.snapshot ?? body;
    expect(snapshot.events).toHaveLength(0);
    expect(snapshot.sourceHealth).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "sec", status: "degraded", message: expect.stringContaining("schema") }),
    ]));
    const offset = await testEnv.DB.prepare("SELECT value FROM meta WHERE owner_id = ? AND key = 'secPublicOffset'")
      .bind(ownerId).first<{ value: string }>();
    expect(offset?.value).toBe("8");
    const retries = await testEnv.DB.prepare("SELECT attempt_count, last_error FROM sec_issuer_retries WHERE owner_id = ? AND scope = 'public'")
      .bind(ownerId).all<{ attempt_count: number; last_error: string }>();
    expect(retries.results).toHaveLength(1);
    expect(retries.results.every((retry) => retry.attempt_count === 1 && retry.last_error.includes("schema"))).toBe(true);

    await testEnv.DB.prepare("UPDATE sec_issuer_retries SET next_attempt_at = '2000-01-01T00:00:00.000Z' WHERE owner_id = ?")
      .bind(ownerId).run();
    await testEnv.DB.prepare("UPDATE meta SET value = ? WHERE owner_id = ? AND key = 'lastRefreshAttemptAt'")
      .bind(new Date(Date.now() - 120_000).toISOString(), ownerId).run();
    const retry = await worker.fetch(jsonRequest("/api/refresh", ownerId, { source: "all_public" }), {
      ...testEnv,
      NEWSJACK_SEC_USER_AGENT: "Newsjack test contact: test@example.invalid",
    });
    expect(retry.status).toBe(200);
    expect(scannedCiks).toHaveLength(16);
    const recovered = await worker.fetch(ownerRequest("/api/snapshot", ownerId), testEnv);
    const recoveredBody = await recovered.json() as { sourceHealth: Array<{ provider: string; status: string }> };
    expect(recoveredBody.sourceHealth).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "sec", status: "healthy" }),
    ]));
    const remainingRetries = await testEnv.DB.prepare("SELECT COUNT(*) AS count FROM sec_issuer_retries WHERE owner_id = ?")
      .bind(ownerId).first<{ count: number }>();
    expect(remainingRetries?.count).toBe(0);
  });

  it("retries an abstract-only Federal Register screen and upgrades it when full text recovers", async () => {
    let documentAttempts = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === "www.federalregister.gov" && url.pathname === "/api/v1/documents.json") {
        return new Response(JSON.stringify({ count: 1, total_pages: 1, next_page_url: null, results: [{
          document_number: "2026-12347",
          title: "Federal Grid Program Update",
          publication_date: "2026-09-23",
          abstract: "The Department describes updated eligibility for a regional grid resilience program.",
          type: "Notice",
          html_url: "https://www.federalregister.gov/documents/2026/09/23/2026-12347/federal-grid-program-update",
          raw_text_url: "https://www.federalregister.gov/documents/full_text/text/2026/09/23/2026-12347.txt",
          agencies: [{ name: "Department of Energy", slug: "department-of-energy" }],
        }] }));
      }
      if (url.hostname === "www.federalregister.gov" && url.pathname.includes("full_text")) {
        documentAttempts += 1;
        if (documentAttempts === 1) return new Response("temporarily unavailable", { status: 503 });
        return new Response("The Department of Energy revised eligibility for the regional grid resilience program. The final notice explains that utility projects must provide updated reliability metrics and submit funding requests before the new application deadline.");
      }
      if (url.hostname === "api.typesafe.ai") return new Response(JSON.stringify({ model: "jev-latest", answers: validAnswers() }));
      return new Response("unexpected provider request", { status: 500 });
    }));

    const ownerId = "investor-federal-recovery";
    const requestEnv = { ...testEnv, TYPESAFE_API_KEY: "test-token-not-a-real-key" };
    const provisional = await worker.fetch(jsonRequest("/api/refresh", ownerId, { source: "federal" }), requestEnv);
    const provisionalBody = await provisional.json() as { events: Event[]; sourceHealth: Array<{ provider: string; status: string }> };
    expect(provisionalBody.events).toHaveLength(1);
    expect(provisionalBody.events[0]?.screening.evidenceComplete).toBe(false);
    expect(provisionalBody.events[0]?.evidence[0]?.capture).toBe("reference");
    expect(provisionalBody.sourceHealth).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "federal_register", status: "degraded" }),
    ]));
    await testEnv.DB.prepare("UPDATE meta SET value = ? WHERE owner_id = ? AND key = 'lastRefreshAttemptAt'")
      .bind(new Date(Date.now() - 120_000).toISOString(), ownerId).run();

    const recovered = await worker.fetch(jsonRequest("/api/refresh", ownerId, { source: "federal" }), requestEnv);
    const recoveredJson = await recovered.json() as { snapshot?: { events: Event[] }; events?: Event[] };
    const recoveredBody = recoveredJson.snapshot ?? recoveredJson;
    expect(recoveredBody.events).toHaveLength(1);
    expect(recoveredBody.events[0]?.screening.evidenceComplete).toBe(true);
    expect(recoveredBody.events[0]?.evidence[0]?.capture).toBe("content");
    expect(recoveredBody.events[0]?.title).toContain("The Department of Energy revised eligibility");
    const runs = await testEnv.DB.prepare("SELECT COUNT(*) AS count FROM screening_runs_v2 WHERE owner_id = ?")
      .bind(ownerId).first<{ count: number }>();
    expect(runs?.count).toBe(2);
  });

  it("degrades Federal Register health when delivered record counts do not reconcile", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === "www.federalregister.gov" && url.pathname === "/api/v1/documents.json") {
        return new Response(JSON.stringify({ count: 10, total_pages: 1, next_page_url: null, results: [{
          document_number: "2026-12348",
          title: "Federal Energy Program Notice",
          publication_date: "2026-09-23",
          abstract: "The Department describes an energy program update for regional utilities.",
          type: "Notice",
          html_url: "https://www.federalregister.gov/documents/2026/09/23/2026-12348/federal-energy-program-notice",
          raw_text_url: "https://www.federalregister.gov/documents/full_text/text/2026/09/23/2026-12348.txt",
          agencies: [{ name: "Department of Energy", slug: "department-of-energy" }],
        }] }));
      }
      if (url.hostname === "www.federalregister.gov" && url.pathname.includes("full_text")) {
        return new Response("The Department of Energy outlines a new energy program for regional utilities. The notice explains eligibility, timing, and a revised allocation of federal support that may affect regulated power companies.");
      }
      if (url.hostname === "api.typesafe.ai") return new Response(JSON.stringify({ model: "jev-latest", answers: validAnswers() }));
      return new Response("unexpected provider request", { status: 500 });
    }));

    const response = await worker.fetch(jsonRequest("/api/refresh", "investor-federal-reconcile", { source: "federal" }), {
      ...testEnv,
      TYPESAFE_API_KEY: "test-token-not-a-real-key",
    });
    const body = await response.json() as { sourceHealth: Array<{ provider: string; status: string; message: string }> };
    expect(body.sourceHealth).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "federal_register", status: "degraded", message: expect.stringContaining("declared 10 records") }),
    ]));
  });

  it("stores independent screening runs for changed prompt/model contracts on identical source bytes", async () => {
    const ownerId = "investor-contract-version";
    const repository = new InvestorRepository(workerEnv(), ownerId);
    const firstContract = await screeningContractDigest("sec");
    const secondContract = `${firstContract.slice(0, -1)}${firstContract.endsWith("0") ? "1" : "0"}`;
    const shared = {
      provider: "sec",
      nativeId: "SEC:0000000001:000000000000000001",
      sourceDigest: "a".repeat(64),
      sourceVersionDigest: "b".repeat(64),
      evidenceComplete: true,
      captureKind: "full_text" as const,
      status: "accepted" as const,
      resultDigest: "c".repeat(64),
      promptDigest: "d".repeat(64),
      model: "jev-1.13.0",
      screenedAt: nowIso(),
      lastValidatedAt: nowIso(),
    };
    const refreshedAt = nowIso();
    await commitRefresh(repository, {
      events: [], captures: [],
      screenings: [{ ...shared, contractDigest: firstContract }, { ...shared, contractDigest: secondContract }],
      health: [], meta: [], refreshedAt,
    });

    expect(await repository.hasScreening("sec", shared.nativeId, shared.sourceDigest, shared.sourceVersionDigest, firstContract)).toBe(true);
    expect(await repository.hasScreening("sec", shared.nativeId, shared.sourceDigest, shared.sourceVersionDigest, secondContract)).toBe(true);
    const count = await testEnv.DB.prepare("SELECT COUNT(*) AS count FROM screening_runs_v2 WHERE owner_id = ?")
      .bind(ownerId).first<{ count: number }>();
    expect(count?.count).toBe(2);
  });

  it("holds the SEC universe cursor and preserves the snapshot when EDGAR denies a request", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("blocked", { status: 403 })));
    const response = await worker.fetch(jsonRequest("/api/refresh", "investor-sec-denied", { source: "all_public" }), {
      ...testEnv,
      NEWSJACK_SEC_USER_AGENT: "Newsjack test contact: test@example.invalid",
    });
    expect(response.status).toBe(502);
    const body = await response.json() as { snapshot: { events: Event[]; sourceHealth: Array<{ provider: string; status: string }> } };
    expect(body.snapshot.events).toHaveLength(0);
    expect(body.snapshot.sourceHealth).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "sec", status: "offline" }),
    ]));
    const offset = await testEnv.DB.prepare("SELECT value FROM meta WHERE owner_id = ? AND key = 'secPublicOffset'")
      .bind("investor-sec-denied").first<{ value: string }>();
    expect(offset).toBeNull();
  });
});

function issuer() {
  return IssuerSchema.parse({
    kind: "issuer",
    name: "Example Industries",
    ticker: { kind: "ticker", value: "EXMP" },
    cik: { kind: "cik", value: "0000000001" },
  });
}

async function commitRefresh(
  repository: InvestorRepository,
  write: Parameters<InvestorRepository["recordRefresh"]>[0],
): Promise<void> {
  const lockToken = crypto.randomUUID();
  const acquiredAt = nowIso();
  if (!await repository.acquireRefreshLock(lockToken, acquiredAt)) throw new Error("Test could not acquire its refresh lock.");
  try {
    await repository.recordRefresh(write, lockToken);
  } finally {
    await repository.releaseRefreshLock(lockToken);
  }
}

function secQueueFiling(
  index: number,
  now: string,
  issuerIdentity: { cik: string; ticker: string; name: string; exchange?: string } = {
    cik: "0000001234",
    ticker: "EXMP",
    name: "Example Industries",
    exchange: "NASDAQ",
  },
): SecFilingQueueInput {
  const accession = `${issuerIdentity.cik}-26-${String(index).padStart(6, "0")}`;
  return {
    nativeId: `SEC:${issuerIdentity.cik}:${accession}`,
    cik: issuerIdentity.cik,
    accession,
    issuer: issuerIdentity,
    form: "8-K",
    primaryDocument: `filing-${index}.htm`,
    primaryDescription: `Current report ${index}`,
    filedAt: now,
    availableAt: now,
    availablePrecision: "second",
    sourceVersionDigest: index.toString(16).padStart(64, "0"),
    contractDigest: "c".repeat(64),
  };
}

function secSubmissionCapture(ownerId: string, now: string): CaptureRecord {
  return {
    ownerId,
    provider: "sec",
    nativeId: "submissions:0000001234",
    sha256: "d".repeat(64),
    objectKey: "raw/test/sec/submissions.bin",
    sourceUrl: "https://data.sec.gov/submissions/CIK0000001234.json",
    contentType: "application/json",
    byteLength: 1,
    observedAt: now,
    adapterVersion: "test",
  };
}

function ownerRequest(path: string, ownerId: string): Request {
  return new Request(`https://desk.test${path}`, {
    headers: { "oai-authenticated-user-id": ownerId },
  });
}

function jsonRequest(path: string, ownerId: string, body: unknown): Request {
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

function sampleEvent(): Event {
  const observedAt = nowIso();
  return EventSchema.parse({
    id: "sec:record-1",
    subject: issuer(),
    kind: "filing",
    form: "8-K",
    title: "Production capacity increased",
    summary: "The company reported a meaningful operating change.",
    publishedAt: observedAt,
    publishedPrecision: "day",
    availableAt: observedAt,
    availablePrecision: "second",
    source: {
      provider: "sec",
      nativeId: "SEC:0000000001:000000000000000001",
      url: "https://www.sec.gov/Archives/edgar/data/1/000000000000000001/report.htm",
      observedAt,
      deliveryState: "network",
      availabilityAt: observedAt,
      availabilityPrecision: "second",
      freshness: "live",
      digest: "a".repeat(64),
    },
    evidence: [{
      label: "SEC 8-K primary source",
      url: "https://www.sec.gov/Archives/edgar/data/1/000000000000000001/report.htm",
      capture: "content",
      sourceNativeId: "SEC:0000000001:000000000000000001",
      excerpt: "The company reported a meaningful operating change.",
    }],
    screening: {
      engine: "typesafe_ai",
      modelConfidence: 90,
      typedAnswers: {
        materiality: { type: "score", score: 3, legend: {}, probabilities: { "0": 0, "1": 0, "2": 0, "3": 1, "4": 0 }, confidence: 0.9 },
      },
      category: "operations",
      evidenceComplete: true,
      materiality: 75,
      novelty: 70,
      marketSensitivity: 65,
      thesisMatch: 70,
      sourceReliability: 95,
      attentionScore: 72,
      decision: "review",
      rationale: ["TypeSafe AI placed this filing in operations."],
    },
    review: { status: "unreviewed", note: "", updatedAt: null },
  });
}

function refreshWrite(event: Event, refreshedAt: string) {
  return {
    events: [event],
    captures: [],
    screenings: [],
    health: [],
    meta: [],
    refreshedAt,
  };
}

function validAnswers() {
  const score = {
    type: "score",
    score: 3,
    legend: { "0": "None", "1": "Low", "2": "Moderate", "3": "High", "4": "Very high" },
    probabilities: { "0": 0, "1": 0, "2": 0, "3": 1, "4": 0 },
    confidence: 0.9,
  };
  return {
    materiality: score,
    novelty: score,
    market_sensitivity: score,
    thesis_link: score,
    category: {
      type: "choice",
      choice: "operations",
      probabilities: { operations: 0.8, capital_allocation: 0.05, governance_legal: 0.05, risk_disclosure: 0.05, routine_disclosure: 0.05 },
      confidence: 0.8,
    },
  };
}
