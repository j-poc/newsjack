import { AppSnapshotSchema, EventSchema, IssuerSearchResultSchema, type AppSnapshot, type Event, type Issuer, type IssuerSearchResult, type ReviewStatus } from "./domain";

export class ApiRequestError extends Error {
  public constructor(message: string, public readonly snapshot: AppSnapshot | null = null) {
    super(message);
    this.name = "ApiRequestError";
  }
}

async function requestJson<T>(input: RequestInfo | URL, init: RequestInit, parse: (value: unknown) => T): Promise<T> {
  const response = await fetch(input, init);
  const body: unknown = await response.json();
  if (!response.ok) {
    const error = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string" ? body.error : `Request failed with HTTP ${response.status}.`;
    const candidate = typeof body === "object" && body !== null && "snapshot" in body ? body.snapshot : null;
    const snapshot = AppSnapshotSchema.safeParse(candidate);
    throw new ApiRequestError(error, snapshot.success ? snapshot.data : null);
  }
  return parse(body);
}

export function getSnapshot(): Promise<AppSnapshot> {
  return requestJson("/api/snapshot", { method: "GET" }, (body) => AppSnapshotSchema.parse(body));
}

export function searchIssuers(query: string): Promise<IssuerSearchResult[]> {
  return requestJson(`/api/issuers/search?q=${encodeURIComponent(query)}`, { method: "GET" }, (body) => {
    if (!Array.isArray(body)) throw new Error("Issuer search returned an invalid response.");
    return body.map((item) => IssuerSearchResultSchema.parse(item));
  });
}

export function refresh(source: "watchlist" | "all_public" | "federal" | "all"): Promise<AppSnapshot> {
  return requestJson("/api/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source }) }, (body) => {
    const snapshot = typeof body === "object" && body !== null && "snapshot" in body ? body.snapshot : body;
    return AppSnapshotSchema.parse(snapshot);
  });
}

export function reviewEvent(eventId: Event["id"], status: ReviewStatus, note: string): Promise<AppSnapshot> {
  return requestJson(`/api/events/${encodeURIComponent(eventId)}/review`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status, note }) }, (body) => {
    if (typeof body !== "object" || body === null || !("snapshot" in body)) throw new Error("Review response did not include a snapshot.");
    return AppSnapshotSchema.parse(body.snapshot);
  });
}

export function updateWatchlist(action: "add" | "remove", issuer: Issuer): Promise<AppSnapshot> {
  return requestJson("/api/watchlist", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, issuer }) }, (body) => AppSnapshotSchema.parse(body));
}
