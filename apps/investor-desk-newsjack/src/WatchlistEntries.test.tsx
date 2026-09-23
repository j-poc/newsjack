// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WatchlistEntries } from "./WatchlistEntries";
import type { WatchlistEntry } from "./domain";

const apple: WatchlistEntry = {
  issuer: {
    kind: "issuer",
    name: "Apple Inc.",
    ticker: { kind: "ticker", value: "AAPL" },
    cik: { kind: "cik", value: "0000320193" },
  },
  addedAt: "2026-09-23T09:00:00.000Z",
};

describe("WatchlistEntries", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows saved company names and tickers and lets the user remove one", () => {
    const onRemove = vi.fn();
    act(() => root.render(<WatchlistEntries entries={[apple]} busy={false} onRemove={onRemove} />));

    expect(container.textContent).toContain("Apple Inc.");
    expect(container.textContent).toContain("AAPL");
    const removeButton = container.querySelector<HTMLButtonElement>('button[aria-label="Remove Apple Inc. from watchlist"]');
    expect(removeButton).not.toBeNull();

    act(() => removeButton?.click());
    expect(onRemove).toHaveBeenCalledWith(apple.issuer);
  });
});
