import { describe, expect, it } from "vitest";
import { canAdvanceFinnhubSymbolOffset, eventFromItem, healthFromAudit, type InvestorAuditItem } from "./newsjack";
import type { CompanyCoverage } from "../src/domain";

const coverage: CompanyCoverage = {
  universeProvider: "finnhub_stock_symbols_us_nyse_nasdaq_common_stock",
  deliveryState: "network",
  eligibleSymbols: 4_755,
  symbolsScanned: 50,
  symbolOffsetBefore: 100,
  symbolOffsetNext: 150,
  articlesReceived: 20,
  articlesLinkedToUniverse: 8,
  symbolsLinked: 6,
  recordsScreened: 8,
  recordsExcludedAsUnrelated: 2,
  hasDeferredRecords: false,
  observedAt: "2026-09-23T09:00:00.000Z",
  directoryDigest: "a".repeat(64),
  newsDigest: "b".repeat(64),
};

describe("Finnhub broad-universe recovery", () => {
  it("continues rotation past an audited per-symbol request failure", () => {
    expect(canAdvanceFinnhubSymbolOffset({
      companyCoverage: coverage,
      nextSymbolOffset: 150,
      failures: [{ stage: "finnhub_news_index" }],
      mappingFailures: 0,
    })).toBe(true);
  });

  it("advances after the per-run item cap instead of retrying the same ticker forever", () => {
    expect(canAdvanceFinnhubSymbolOffset({
      companyCoverage: { ...coverage, hasDeferredRecords: true },
      nextSymbolOffset: 150,
      failures: [],
      mappingFailures: 0,
    })).toBe(true);
  });

  it("retries the same batch when screening, normalization, or UI mapping is incomplete", () => {
    for (const failure of [{ stage: "typesafe_screen" }, { stage: "finnhub_news_parse" }]) {
      expect(canAdvanceFinnhubSymbolOffset({ companyCoverage: coverage, nextSymbolOffset: 150, failures: [failure], mappingFailures: 0 })).toBe(false);
    }
    expect(canAdvanceFinnhubSymbolOffset({ companyCoverage: coverage, nextSymbolOffset: 150, failures: [], mappingFailures: 1 })).toBe(false);
    expect(canAdvanceFinnhubSymbolOffset({ companyCoverage: null, nextSymbolOffset: null, failures: [], mappingFailures: 0 })).toBe(false);
  });
});

describe("Finnhub event mapping", () => {
  it("preserves TypeSafe Noul company attribution in a public-company event", () => {
    const scoreAnswer = (score: number) => ({
      type: "score" as const,
      score,
      legend: { "0": "none", "4": "high" },
      probabilities: { "0": 0.1, "4": 0.9 },
      confidence: 0.9,
    });
    const item = {
      native_id: "FINNHUB:DASH:123",
      company: { symbol: "DASH", exchange: "US", name: "DoorDash" },
      subject_kind: "company",
      subject_code: "DASH",
      subject_name: "DoorDash",
      form: "NEWS",
      primary_description: "DoorDash reaches agreement with New York City",
      filed_at: { value: "2026-09-23T08:00:00.000Z", precision: "second" },
      available_at: { value: "2026-09-23T08:01:00.000Z", precision: "second" },
      title: "DoorDash reached a settlement with New York City over delivery-worker pay.",
      source: {
        provider: "finnhub_news",
        native_id: "FINNHUB:DASH:123",
        url: "https://finnhub.io/api/news?id=example",
        observed_at: "2026-09-23T08:01:00.000Z",
        document_digest: "a".repeat(64),
        normalized_digest: "b".repeat(64),
      },
      evidence: { excerpt: "DoorDash reached a settlement with New York City.", complete: false },
      screening: {
        engine: "typesafe_ai",
        model: "jev-test",
        model_confidence: 90,
        typed_answers: {
          materiality: scoreAnswer(3),
          novelty: scoreAnswer(3),
          market_sensitivity: scoreAnswer(3),
          thesis_link: scoreAnswer(2),
          category: { type: "choice" as const, choice: "governance_legal", probabilities: { governance_legal: 1 }, confidence: 0.99 },
          company_relevance: { type: "noul" as const, noul: 0.96 },
        },
        category: "governance_legal",
        materiality: 75,
        novelty: 75,
        market_sensitivity: 75,
        thesis_link: 50,
        source_reliability: 70,
        attention_score: 75,
        lane: "human_review",
        rationale: ["TypeSafe attributed this story to DoorDash."],
      },
    } satisfies InvestorAuditItem;

    const event = eventFromItem(item);
    expect(event.subject).toMatchObject({ kind: "public_company", symbol: "DASH", name: "DoorDash" });
    expect(event.title).toBe("DoorDash reached a settlement with New York City over delivery-worker pay.");
    expect(event.screening.typedAnswers.company_relevance).toEqual({ type: "noul", noul: 0.96 });
  });
});

describe("provider health scope", () => {
  it("discloses capped raw news that was not sent for TypeSafe screening", () => {
    const audit = {
      version: 1,
      generated_at: "2026-09-23T09:00:00.000Z",
      source: { scope: "company_news", finnhub_news: 3 },
      engine: { calls: 3 },
      items: [],
      failures: [],
    } satisfies Parameters<typeof healthFromAudit>[0];

    const health = healthFromAudit(audit, { ...coverage, hasDeferredRecords: true });
    expect(health.companyNews.kind).toBe("checked");
    if (health.companyNews.kind === "checked") {
      expect(health.companyNews.health.message).toContain("per-run TypeSafe item cap was reached");
      expect(health.companyNews.health.message).toContain("raw evidence");
      expect(health.companyNews.health.message).not.toContain("current ticker continues next refresh");
    }
  });

  it("does not overwrite other providers during a company-news-only refresh", () => {
    const audit = {
      version: 1,
      generated_at: "2026-09-23T09:00:00.000Z",
      source: { scope: "company_news", finnhub_news: 0 },
      engine: { calls: 3 },
      items: [],
      failures: [],
    } satisfies Parameters<typeof healthFromAudit>[0];

    const health = healthFromAudit(audit, null);
    expect(health.sec).toEqual({ kind: "not_queried" });
    expect(health.federal).toEqual({ kind: "not_queried" });
    expect(health.companyNews.kind).toBe("checked");
    expect(health.typesafe.kind).toBe("checked");
    if (health.companyNews.kind === "checked") expect(health.companyNews.health.provider).toBe("finnhub_news");
    if (health.typesafe.kind === "checked") expect(health.typesafe.health.provider).toBe("typesafe_ai");
  });

  it("marks a requested source with no usable records unavailable, not live", () => {
    const audit = {
      version: 1,
      generated_at: "2026-09-23T09:00:00.000Z",
      source: { scope: "all_public", sec_filings: 0 },
      engine: { calls: 0 },
      items: [],
      failures: [{ stage: "sec_discovery", error: "No eligible issuers." }],
    } satisfies Parameters<typeof healthFromAudit>[0];

    const health = healthFromAudit(audit, null);
    expect(health.sec.kind).toBe("checked");
    if (health.sec.kind === "checked") expect(health.sec.health).toMatchObject({ status: "offline", freshness: "unavailable" });
    expect(health.federal).toEqual({ kind: "not_queried" });
    expect(health.companyNews).toEqual({ kind: "not_queried" });
    expect(health.typesafe).toEqual({ kind: "not_queried" });
  });
});
