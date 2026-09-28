import { AppSnapshotSchema, EventPageSchema, EventSchema, EventScopeSchema, IssuerSearchResultSchema, type AppSnapshot, type Event, type EventPage, type EventScope, type Issuer, type IssuerSearchResult, type ReviewStatus } from "./domain";

export class ApiRequestError extends Error {
  public constructor(message: string, public readonly snapshot: AppSnapshot | null = null, public readonly status: number = 0, public readonly event: Event | null = null) {
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
    const eventCandidate = typeof body === "object" && body !== null && "event" in body ? body.event : null;
    const event = EventSchema.safeParse(eventCandidate);
    throw new ApiRequestError(error, snapshot.success ? snapshot.data : null, response.status, event.success ? event.data : null);
  }
  return parse(body);
}

export function getSnapshot(scope: EventScope): Promise<AppSnapshot> {
  return requestJson(`/api/snapshot?scope=${encodeURIComponent(EventScopeSchema.parse(scope))}`, { method: "GET" }, (body) => AppSnapshotSchema.parse(body));
}

export function getEventPage(cursor: string): Promise<EventPage> {
  return requestJson(`/api/events?cursor=${encodeURIComponent(cursor)}`, { method: "GET" }, (body) => EventPageSchema.parse(body));
}

export function searchIssuers(query: string): Promise<IssuerSearchResult[]> {
  return requestJson(`/api/issuers/search?q=${encodeURIComponent(query)}`, { method: "GET" }, (body) => {
    if (!Array.isArray(body)) throw new Error("Issuer search returned an invalid response.");
    return body.map((item) => IssuerSearchResultSchema.parse(item));
  });
}

export function refresh(source: EventScope): Promise<AppSnapshot> {
  return requestJson("/api/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source }) }, (body) => {
    const snapshot = typeof body === "object" && body !== null && "snapshot" in body ? body.snapshot : body;
    return AppSnapshotSchema.parse(snapshot);
  });
}

export function reviewEvent(eventId: Event["id"], status: ReviewStatus, note: string, expectedReview: Event["review"], scope: EventScope): Promise<{ event: Event; snapshot: AppSnapshot }> {
  return requestJson(`/api/events/${encodeURIComponent(eventId)}/review?scope=${encodeURIComponent(scope)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status, note, expectedReview }) }, (body) => {
    if (typeof body !== "object" || body === null || !("snapshot" in body) || !("event" in body)) throw new Error("Review response did not include the saved review and current page.");
    return { event: EventSchema.parse(body.event), snapshot: AppSnapshotSchema.parse(body.snapshot) };
  });
}

export function updateWatchlist(action: "add" | "remove", issuer: Issuer, scope: EventScope): Promise<AppSnapshot> {
  return requestJson(`/api/watchlist?scope=${encodeURIComponent(scope)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, issuer }) }, (body) => AppSnapshotSchema.parse(body));
}
