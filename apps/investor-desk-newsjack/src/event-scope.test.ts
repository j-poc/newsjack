import { describe, expect, it } from "vitest";
import { EventSchema, IssuerSchema, AgencySchema, type Event } from "./domain";
import { eventsForScope } from "./event-scope";

describe("event scope", () => {
  it("limits My watchlist to SEC records whose CIK is actually on the user's list", () => {
    const watched = makeEvent("sec", "0000000001");
    const unwatched = makeEvent("sec", "0000000002");
    const federal = makeFederalEvent();

    expect(eventsForScope([watched, unwatched, federal], "watchlist", new Set(["0000000001"])))
      .toEqual([watched]);
    expect(eventsForScope([watched, unwatched, federal], "all_public", new Set(["0000000001"])))
      .toEqual([watched, unwatched]);
  });
});

function makeEvent(provider: "sec", cik: string): Event {
  const observedAt = "2026-09-23T12:00:00.000Z";
  const subject = IssuerSchema.parse({
    kind: "issuer",
    name: `Issuer ${cik}`,
    ticker: { kind: "ticker", value: `T${cik.slice(-3)}` },
    cik: { kind: "cik", value: cik },
  });
  return EventSchema.parse({
    id: `${provider}:${cik}`,
    subject,
    kind: "filing",
    form: "8-K",
    title: "New operating disclosure",
    summary: "The issuer reported a material operating change.",
    publishedAt: observedAt,
    publishedPrecision: "day",
    availableAt: observedAt,
    availablePrecision: "second",
    source: {
      provider,
      nativeId: `SEC:${cik}:accession`,
      url: "https://www.sec.gov/Archives/edgar/data/1/1/report.htm",
      observedAt,
      deliveryState: "network",
      availabilityAt: observedAt,
      availabilityPrecision: "second",
      freshness: "live",
      digest: "a".repeat(64),
    },
    evidence: [{
      label: "SEC filing",
      url: "https://www.sec.gov/Archives/edgar/data/1/1/report.htm",
      capture: "content",
      sourceNativeId: `SEC:${cik}:accession`,
      excerpt: "The issuer reported a material operating change.",
    }],
    screening: {
      engine: "typesafe_ai",
      modelConfidence: 90,
      typedAnswers: { materiality: { type: "noul", noul: 0.9 } },
      category: "operations",
      evidenceComplete: true,
      materiality: 75,
      novelty: 70,
      marketSensitivity: 65,
      thesisMatch: 70,
      sourceReliability: 95,
      attentionScore: 72,
      decision: "review",
      rationale: ["A human should review the filing."],
    },
    review: { status: "unreviewed", note: "", updatedAt: null },
  });
}

function makeFederalEvent(): Event {
  const observedAt = "2026-09-23T12:00:00.000Z";
  return EventSchema.parse({
    ...makeEvent("sec", "0000000003"),
    id: "federal:record",
    subject: AgencySchema.parse({ kind: "agency", name: "Department of Energy", code: "DOE" }),
    kind: "regulatory",
    form: "Notice",
    publishedAt: "2026-09-23T00:00:00.000Z",
    publishedPrecision: "day",
    availableAt: "2026-09-23T00:00:00.000Z",
    availablePrecision: "day",
    source: {
      provider: "federal_register",
      nativeId: "FR:2026-12345",
      url: "https://www.federalregister.gov/documents/2026/09/23/2026-12345/example",
      observedAt,
      deliveryState: "network",
      availabilityAt: observedAt,
      availabilityPrecision: "day",
      freshness: "live",
      digest: "b".repeat(64),
    },
    evidence: [{
      label: "Federal Register Notice",
      url: "https://www.federalregister.gov/documents/2026/09/23/2026-12345/example",
      capture: "reference",
      sourceNativeId: "FR:2026-12345",
      excerpt: "The agency published an informational notice.",
    }],
  });
}
