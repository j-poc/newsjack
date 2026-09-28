// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSnapshot, Event } from "./domain";

const api = vi.hoisted(() => ({
  getSnapshot: vi.fn(),
  getEventPage: vi.fn(),
  refresh: vi.fn(),
  reviewEvent: vi.fn(),
  searchIssuers: vi.fn(),
  updateWatchlist: vi.fn(),
}));

vi.mock("./api", () => {
  class ApiRequestError extends Error {
    public constructor(message: string, public readonly snapshot = null, public readonly status = 0, public readonly event = null) {
      super(message);
      this.name = "ApiRequestError";
    }
  }
  return { ...api, ApiRequestError };
});

import App from "./App";
import { ApiRequestError } from "./api";

describe("investor desk pagination", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    // jsdom 30 does not provide localStorage; App persists the scan scope there.
    const scopeStorage = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => scopeStorage.get(key) ?? null,
        setItem: (key: string, value: string) => { scopeStorage.set(key, String(value)); },
        removeItem: (key: string) => { scopeStorage.delete(key); },
        clear: () => scopeStorage.clear(),
      },
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    vi.clearAllMocks();
    const first = snapshot(Array.from({ length: 20 }, (_, index) => event(index)), 1, "cursor-page-1");
    api.getSnapshot.mockResolvedValue(first);
    api.refresh.mockResolvedValue(first);
    api.searchIssuers.mockResolvedValue([]);
    api.updateWatchlist.mockResolvedValue(first);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("loads older records through the visible control and updates honest loaded totals", async () => {
    const first = snapshot(Array.from({ length: 20 }, (_, index) => event(index)), 1, "cursor-page-1");
    const older = event(20);
    api.getSnapshot.mockResolvedValue(first);
    api.refresh.mockResolvedValue(first);
    api.getEventPage.mockResolvedValue({ events: [older], eventsTotal: 21, eventsRevision: 1, eventsCursor: null });

    await openDesk();
    expect(wireHeading()).toContain("20 loaded · 21 in scope");
    const loadButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Load older records"));
    expect(loadButton).toBeDefined();

    await act(async () => {
      loadButton?.click();
      await Promise.resolve();
    });

    expect(api.getEventPage).toHaveBeenCalledWith("cursor-page-1");
    expect(wireHeading()).toContain("21 loaded · 21 in scope");
    expect(container.textContent).toContain("Operations expanded in product segment 20");
    expect([...container.querySelectorAll("button")].some((button) => button.textContent?.includes("Load older records"))).toBe(false);
  });

  it("shows source truncation and incomplete-evidence cautions in the selected record", async () => {
    const current = event(0);
    const limited = {
      ...current,
      screening: {
        ...current.screening,
        evidenceComplete: false,
        rationale: [
          "The first-read headline is an exact source sentence selected by TypeSafe AI.",
          "The provided source text was known to be truncated; content beyond its captured screening boundary was not considered.",
          "Evidence is incomplete; treat unprovided material as unknown and require human review.",
        ],
      },
    };
    const first = snapshot([limited], 1, null, "all", 1);
    api.getSnapshot.mockResolvedValue(first);
    api.refresh.mockResolvedValue(first);

    await openDesk();
    const recordCard = container.querySelector<HTMLButtonElement>(".wire-card");
    await act(async () => { recordCard?.click(); });

    const limitations = container.querySelector('[aria-label="Screening limitations"]');
    expect(limitations?.textContent).toContain("The captured document text was cut short; the full filing contains more.");
  });

  it("recovers visibly when ranking changes during pagination", async () => {
    const first = snapshot(Array.from({ length: 20 }, (_, index) => event(index)), 1, "cursor-page-1");
    const refreshed = snapshot(Array.from({ length: 20 }, (_, index) => event(index)), 2, "cursor-page-2");
    api.getSnapshot.mockResolvedValueOnce(first).mockResolvedValueOnce(refreshed);
    api.refresh.mockResolvedValue(first);
    api.getEventPage.mockRejectedValue(new ApiRequestError("The wire changed while older records were loading. Reload the records list and continue from the updated ranking.", null, 409));

    await openDesk();
    const loadButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Load older records"));
    await act(async () => {
      loadButton?.click();
      await Promise.resolve();
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain("wire changed while older records were loading");
    const reloadButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Reload the records list"));
    expect(reloadButton).toBeDefined();
    await act(async () => {
      reloadButton?.click();
      await Promise.resolve();
    });
    expect(api.getSnapshot).toHaveBeenCalledTimes(2);
    expect(wireHeading()).toContain("20 loaded · 21 in scope");
    expect([...container.querySelectorAll("button")].some((button) => button.textContent?.includes("Load older records"))).toBe(true);
  });

  it("keeps an unsaved review draft when a new ranking snapshot reloads the cards", async () => {
    const firstEvents = Array.from({ length: 20 }, (_, index) => event(index));
    const first = snapshot(firstEvents, 1, "cursor-page-1");
    const updatedFirst = snapshot(firstEvents.map((item, index) => index === 0 ? { ...item, title: "Updated source-grounded summary" } : item), 2, "cursor-page-2");
    api.getSnapshot.mockResolvedValue(first);
    api.refresh.mockResolvedValueOnce(first).mockResolvedValueOnce(updatedFirst);

    await openDesk();
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Review note"]');
    expect(textarea).not.toBeNull();
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setValue?.call(textarea, "Check the segment-level disclosures.");
      textarea?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const refreshButton = [...container.querySelectorAll("button")].find((button) => button.textContent === "Read the wire");
    await act(async () => {
      refreshButton?.click();
      await Promise.resolve();
    });
    expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Review note"]')?.value).toBe("Check the segment-level disclosures.");
  });

  it("ignores a late response and stale error snapshot after the user switches scopes", async () => {
    const company = snapshot([event(0)], 2, null, "all_public", 1);
    const lateFederal = snapshot([], 2, null, "federal");
    const federalRequest = deferred<AppSnapshot>();
    const companyRequest = deferred<AppSnapshot>();
    await openDesk();
    api.refresh.mockImplementation((requestedScope: string) => requestedScope === "federal" ? federalRequest.promise : companyRequest.promise);

    await act(async () => {
      button("Federal filings")?.click();
      await Promise.resolve();
    });
    await act(async () => {
      button("All public issuers")?.click();
      await Promise.resolve();
    });
    await act(async () => {
      companyRequest.resolve(company);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(wireHeading()).toContain("1 loaded · 1 in scope");

    await act(async () => {
      federalRequest.reject(new ApiRequestError("A late federal failure", lateFederal, 502));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(wireHeading()).toContain("1 loaded · 1 in scope");
    expect(container.textContent).toContain("Operations expanded in product segment 0");
  });

  it("keeps the continuation cursor after a review returns a first-page snapshot", async () => {
    const all = Array.from({ length: 45 }, (_, index) => event(index));
    const first = snapshot(all.slice(0, 20), 1, "cursor-page-1", "all", 45);
    api.getSnapshot.mockResolvedValue(first);
    api.refresh.mockResolvedValue(first);
    api.getEventPage
      .mockResolvedValueOnce({ events: all.slice(20, 40), eventsTotal: 45, eventsRevision: 1, eventsCursor: "cursor-page-2" })
      .mockResolvedValueOnce({ events: all.slice(40), eventsTotal: 45, eventsRevision: 1, eventsCursor: null });
    const reviewed = { ...all[0]!, review: { status: "reviewed" as const, note: "Read the filing." , updatedAt: "2026-09-24T08:02:00.000Z" } };
    api.reviewEvent.mockResolvedValue({ event: reviewed, snapshot: first });

    await openDesk();
    await act(async () => {
      button("Load older records · 25 remain")?.click();
      await Promise.resolve();
    });
    expect(wireHeading()).toContain("40 loaded · 45 in scope");
    await act(async () => {
      button("Save review")?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      button("Load older records · 5 remain")?.click();
      await Promise.resolve();
    });

    expect(api.getEventPage).toHaveBeenNthCalledWith(2, "cursor-page-2");
    expect(wireHeading()).toContain("45 loaded · 45 in scope");
  });

  it("shows the latest saved note after refresh when the editor is not dirty", async () => {
    const older = { ...event(0), review: { status: "reviewed" as const, note: "Saved note A", updatedAt: "2026-09-24T08:01:00.000Z" } };
    const newer = { ...older, review: { status: "reviewed" as const, note: "Saved note B", updatedAt: "2026-09-24T08:02:00.000Z" } };
    const before = snapshot([older], 1, null);
    api.getSnapshot.mockResolvedValue(before);
    api.refresh.mockResolvedValue(snapshot([newer], 1, null));

    await openDesk();

    expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Review note"]')?.value).toBe("Saved note B");
  });

  it("preserves a user's note draft and exposes the conflicting saved version", async () => {
    const current = { ...event(0), review: { status: "reviewed" as const, note: "Saved note B", updatedAt: "2026-09-24T08:02:00.000Z" } };
    const initial = { ...event(0), review: { status: "reviewed" as const, note: "Saved note A", updatedAt: "2026-09-24T08:01:00.000Z" } };
    const first = snapshot([initial], 1, null);
    api.getSnapshot.mockResolvedValue(first);
    api.refresh.mockResolvedValue(first);
    api.reviewEvent.mockRejectedValue(new ApiRequestError("Review changed", null, 409, current));

    await openDesk();
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Review note"]');
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setValue?.call(textarea, "My unsaved analysis");
      textarea?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      button("Save review")?.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Review note"]')?.value).toBe("My unsaved analysis");
    expect(container.querySelector(".review-conflict")?.textContent).toContain("Saved note B");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("draft is preserved");
  });

  async function openDesk(): Promise<void> {
    await act(async () => {
      root.render(<App />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  function wireHeading(): string {
    return container.querySelector(".wire-section .section-heading h2")?.textContent ?? "";
  }

  function button(label: string): HTMLButtonElement | undefined {
    return [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label);
  }
});

function snapshot(events: Event[], revision: number, cursor: string | null, scope: AppSnapshot["eventsScope"] = "all", eventsTotal = 21): AppSnapshot {
  return {
    schemaVersion: 2,
    events,
    eventsTotal,
    eventsRevision: revision,
    eventsCursor: cursor,
    eventsScope: scope,
    watchlist: [],
    companyCoverage: null,
    publicIssuerCoverage: null,
    sourceHealth: [
      { provider: "sec", status: "healthy", freshness: "live", message: "Live SEC directory checked.", checkedAt: "2026-09-24T08:00:00.000Z" },
      { provider: "federal_register", status: "healthy", freshness: "live", message: "Live Federal Register checked.", checkedAt: "2026-09-24T08:00:00.000Z" },
      { provider: "typesafe_ai", status: "healthy", freshness: "live", message: "Typed screening completed.", checkedAt: "2026-09-24T08:00:00.000Z" },
    ],
    lastRefreshAt: "2026-09-24T08:00:00.000Z",
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(reason?: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function event(index: number): Event {
  const at = new Date(Date.UTC(2026, 8, 24, 8, index, 0)).toISOString();
  const accession = String(index + 1).padStart(18, "0");
  return {
    id: `sec:pagination-ui-${index}`,
    subject: { kind: "issuer", name: "Example Industries", ticker: { kind: "ticker", value: "EXMP" }, cik: { kind: "cik", value: "0000001234" } },
    kind: "filing",
    form: "8-K",
    title: `Operations expanded in product segment ${index}`,
    summary: `Source-grounded first-read summary for record ${index}.`,
    publishedAt: at,
    publishedPrecision: "second",
    availableAt: at,
    availablePrecision: "second",
    source: {
      provider: "sec",
      nativeId: `SEC:0000001234:${accession}`,
      url: `https://www.sec.gov/Archives/edgar/data/1234/${accession}/filing.htm`,
      observedAt: at,
      deliveryState: "network",
      availabilityAt: at,
      availabilityPrecision: "second",
      freshness: "live",
      digest: "a".repeat(64),
    },
    evidence: [{
      label: "SEC 8-K primary document",
      url: `https://www.sec.gov/Archives/edgar/data/1234/${accession}/filing.htm`,
      capture: "content",
      sourceNativeId: `SEC:0000001234:${accession}`,
      excerpt: `The company described operating changes in record ${index}.`,
    }],
    screening: {
      engine: "typesafe_ai",
      modelConfidence: 85,
      typedAnswers: { relevance: { type: "noul", noul: 0.82 } },
      category: "operations",
      evidenceComplete: true,
      materiality: 75,
      novelty: 60,
      marketSensitivity: 70,
      thesisMatch: 65,
      sourceReliability: 90,
      attentionScore: 80 - index,
      decision: "review",
      rationale: ["The filing describes a material operating change."],
    },
    review: { status: "unreviewed", note: "", updatedAt: null },
  };
}
