import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EventSchema, SourceRefSchema, TypedAnswerSchema, sortEvents, type Event } from "../src/domain";
import { EventPageChangedError, SignalDeskDatabase } from "./db";

describe("live public-company coverage state", () => {
  it("preserves the broad universe and Finnhub cursor across a clean server restart", () => {
    const dataDirectory = mkdtempSync(path.join(os.tmpdir(), "newsjack-coverage-test-"));
    const coverage = {
      universeProvider: "finnhub_stock_symbols_us_nyse_nasdaq_common_stock" as const,
      deliveryState: "network" as const,
      eligibleSymbols: 5_284,
      symbolsScanned: 50,
      symbolOffsetBefore: 150,
      symbolOffsetNext: 200,
      articlesReceived: 86,
      articlesLinkedToUniverse: 24,
      symbolsLinked: 31,
      recordsScreened: 31,
      recordsExcludedAsUnrelated: 4,
      hasDeferredRecords: true,
      observedAt: "2026-09-23T09:00:00.000Z",
      directoryDigest: "a".repeat(64),
      newsDigest: "b".repeat(64),
    };
    let database: SignalDeskDatabase | null = new SignalDeskDatabase(dataDirectory, true);
    try {
      database.setFinnhubSymbolOffset(200);
      database.setCompanyCoverage(coverage);
      database.close();

      database = new SignalDeskDatabase(dataDirectory, true);
      expect(database.getFinnhubSymbolOffset()).toBe(200);
      expect(database.getSnapshot().companyCoverage).toEqual(coverage);
    } finally {
      database?.close();
      rmSync(dataDirectory, { recursive: true, force: true });
    }
  });

  it("keeps previously stored live event provenance readable after adding delivery state", () => {
    const source = SourceRefSchema.parse({
      provider: "finnhub_news",
      nativeId: "FINNHUB:EXMPL:42",
      url: "https://example.test/story/42",
      observedAt: "2026-09-23T09:00:00.000Z",
      availabilityAt: "2026-09-23T08:59:00.000Z",
      availabilityPrecision: "second",
      freshness: "live",
      digest: "c".repeat(64),
    });
    expect(source.deliveryState).toBe("network");
  });

  it("preserves TypeSafe Noul probabilities as a first-class typed answer", () => {
    expect(TypedAnswerSchema.parse({ type: "noul", noul: 0.84 })).toEqual({ type: "noul", noul: 0.84 });
  });
});

describe("snapshot freshness", () => {
  it("ages observations and provider checks to stale without changing persisted review data", () => {
    const dataDirectory = mkdtempSync(path.join(os.tmpdir(), "newsjack-freshness-test-"));
    const database = new SignalDeskDatabase(dataDirectory, true);
    const event: Event = {
      id: "finnhub_news:EXMPL:42",
      subject: { kind: "public_company", name: "Example Corp.", symbol: "EXMPL", exchange: "NASDAQ" },
      kind: "news",
      form: "NEWS",
      title: "Example Corp. updates its outlook.",
      summary: "A live-source test story.",
      publishedAt: "2026-09-23T08:58:00.000Z",
      publishedPrecision: "second",
      availableAt: "2026-09-23T08:59:00.000Z",
      availablePrecision: "second",
      source: {
        provider: "finnhub_news",
        nativeId: "FINNHUB:EXMPL:42",
        url: "https://example.test/story/42",
        observedAt: "2026-09-23T09:00:00.000Z",
        deliveryState: "network",
        availabilityAt: "2026-09-23T08:59:00.000Z",
        availabilityPrecision: "second",
        freshness: "live",
        digest: "c".repeat(64),
      },
      evidence: [{
        label: "Finnhub company news",
        url: "https://example.test/story/42",
        capture: "reference",
        sourceNativeId: "FINNHUB:EXMPL:42",
        excerpt: "A live-source test story.",
      }],
      screening: {
        engine: "typesafe_ai",
        modelConfidence: 90,
        typedAnswers: { relevance: { type: "noul", noul: 0.91 } },
        category: "operations",
        evidenceComplete: false,
        materiality: 60,
        novelty: 50,
        marketSensitivity: 60,
        thesisMatch: 50,
        sourceReliability: 70,
        attentionScore: 58,
        decision: "watch",
        rationale: ["Test data is only stored in the temporary test database."],
      },
      review: { status: "reviewed", note: "Keep this note unchanged.", updatedAt: "2026-09-23T09:01:00.000Z" },
    };
    database.upsertEvents([event]);
    database.setSourceHealth({
      provider: "finnhub_news",
      status: "healthy",
      freshness: "live",
      message: "Finnhub was checked.",
      checkedAt: "2026-09-23T09:00:00.000Z",
    });
    try {
      const beforeStale = database.getSnapshot(new Date("2026-09-23T09:19:59.000Z"));
      expect(beforeStale.events[0]?.source.freshness).toBe("live");
      expect(beforeStale.sourceHealth[0]?.freshness).toBe("live");

      const afterStale = database.getSnapshot(new Date("2026-09-23T09:20:01.000Z"));
      expect(afterStale.events[0]?.source.freshness).toBe("stale");
      expect(afterStale.sourceHealth[0]?.freshness).toBe("stale");
      expect(afterStale.events[0]?.review).toEqual(event.review);

      const disabledDatabase = new SignalDeskDatabase(dataDirectory, false);
      try {
        const disabledSnapshot = disabledDatabase.getSnapshot(new Date("2026-09-23T09:20:01.000Z"));
        expect(disabledSnapshot.events).toHaveLength(0);
        expect(disabledSnapshot.companyCoverage).toBeNull();
        expect(disabledSnapshot.sourceHealth).toEqual(expect.arrayContaining([
          expect.objectContaining({ provider: "finnhub_news", status: "offline", freshness: "unavailable", message: expect.stringContaining("Not requested") }),
        ]));
        expect(disabledDatabase.updateReview(event.id, { status: "dismissed", note: "should not mutate hidden provider history", expectedReview: event.review })).toBeNull();
      } finally {
        disabledDatabase.close();
      }
    } finally {
      database.close();
      rmSync(dataDirectory, { recursive: true, force: true });
    }
  });
});

describe("bounded investor-record pagination", () => {
  it("traverses 1,500 priority-ranked records exactly once and rejects a cursor after ranking changes", () => {
    const dataDirectory = mkdtempSync(path.join(os.tmpdir(), "newsjack-pagination-test-"));
    const database = new SignalDeskDatabase(dataDirectory, false);
    const records = Array.from({ length: 1_500 }, (_, index) => pagingEvent(index));
    try {
      database.upsertEvents(records);
      const first = database.getSnapshot(new Date("2026-09-24T09:00:00.000Z"), "all_public");
      expect(first.events).toHaveLength(20);
      expect(first.eventsTotal).toBe(1_500);
      expect(first.eventsScope).toBe("all_public");
      expect(JSON.stringify(first).length).toBeLessThan(2_000_000);
      expect(first.events.map((event) => event.id)).toEqual(sortEvents(records).slice(0, 20).map((event) => event.id));

      const expectedOlder = sortEvents(records)[25];
      if (expectedOlder === undefined) throw new Error("Expected an event beyond the first page.");
      const reviewed = database.updateReview(expectedOlder.id, { status: "reviewed", note: "Read after page one.", expectedReview: expectedOlder.review });
      expect(reviewed?.review.note).toBe("Read after page one.");
      expect(Date.parse(reviewed?.review.updatedAt ?? "") ).toBeGreaterThan(Date.parse(expectedOlder.review.updatedAt ?? "1970-01-01T00:00:00.000Z"));
      expect(database.updateReview(expectedOlder.id, { status: "dismissed", note: "stale tab", expectedReview: expectedOlder.review })).toBeNull();

      const traversed = [...first.events];
      let cursor = first.eventsCursor;
      while (cursor !== null) {
        const page = database.getEventPage(cursor, new Date("2026-09-24T09:00:00.000Z"));
        expect(page.eventsRevision).toBe(first.eventsRevision);
        traversed.push(...page.events);
        cursor = page.eventsCursor;
      }
      expect(traversed).toHaveLength(records.length);
      expect(new Set(traversed.map((event) => event.id)).size).toBe(records.length);
      expect(traversed.map((event) => event.id)).toEqual(sortEvents(records).map((event) => event.id));
      expect(traversed.find((event) => event.id === expectedOlder.id)?.review.note).toBe("Read after page one.");

      const oldCursor = first.eventsCursor;
      if (oldCursor === null) throw new Error("Expected another page before the insert.");
      database.upsertEvents([pagingEvent(1_500)]);
      expect(() => database.getEventPage(oldCursor)).toThrowError(EventPageChangedError);
      try {
        database.getEventPage(oldCursor);
      } catch (error) {
        expect(error).toMatchObject({ status: 409 });
      }
    } finally {
      database.close();
      rmSync(dataDirectory, { recursive: true, force: true });
    }
  });
});

function pagingEvent(index: number): Event {
  const availableAt = new Date(Date.UTC(2026, 8, 24, 8, index % 60, Math.floor(index / 60))).toISOString();
  const accession = String(index + 1).padStart(18, "0");
  return EventSchema.parse({
    id: `sec:page-${index}`,
    subject: { kind: "issuer", name: "Example Public Company", ticker: { kind: "ticker", value: "EXMPL" }, cik: { kind: "cik", value: "0000001234" } },
    kind: "filing",
    form: "8-K",
    title: `Material company update ${index}`,
    summary: `The company reported operating information in filing ${index}.`,
    publishedAt: availableAt,
    publishedPrecision: "second",
    availableAt,
    availablePrecision: "second",
    source: {
      provider: "sec",
      nativeId: `SEC:0000001234:${accession}`,
      url: `https://www.sec.gov/Archives/edgar/data/1234/${accession}/filing.htm`,
      observedAt: availableAt,
      deliveryState: "network",
      availabilityAt: availableAt,
      availabilityPrecision: "second",
      freshness: "live",
      digest: "a".repeat(64),
    },
    evidence: [{
      label: "SEC 8-K primary document",
      url: `https://www.sec.gov/Archives/edgar/data/1234/${accession}/filing.htm`,
      capture: "content",
      sourceNativeId: `SEC:0000001234:${accession}`,
      excerpt: `Source-grounded filing evidence ${index}.`,
    }],
    screening: {
      engine: "typesafe_ai",
      modelConfidence: 85,
      typedAnswers: { relevance: { type: "noul", noul: 0.8 } },
      category: "operations",
      evidenceComplete: true,
      materiality: 75,
      novelty: 60,
      marketSensitivity: 70,
      thesisMatch: 65,
      sourceReliability: 90,
      attentionScore: index % 101,
      decision: "review",
      rationale: ["The screened record describes a company operating change."],
    },
    review: { status: "unreviewed", note: "", updatedAt: null },
  });
}
