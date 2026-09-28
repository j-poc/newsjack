import {
  AppSnapshotSchema,
  type AppSnapshot,
  type Issuer,
  type ReviewStatus,
} from "./domain";

async function readJson(response: Response): Promise<unknown> {
  const payload: unknown = await response.json();
  if (!response.ok) {
    const message = typeof payload === "object" && payload !== null && "error" in payload && typeof payload.error === "string"
      ? payload.error
      : `Request failed with HTTP ${response.status}.`;
    throw new Error(message);
  }
  return payload;
}

export async function getSnapshot(): Promise<AppSnapshot> {
  return AppSnapshotSchema.parse(await readJson(await fetch("/api/snapshot")));
}

export async function refresh(): Promise<AppSnapshot> {
  return AppSnapshotSchema.parse(await readJson(await fetch("/api/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source: "sec" }),
  })));
}

export async function reviewEvent(eventId: string, status: ReviewStatus, note: string): Promise<AppSnapshot> {
  const payload = await readJson(await fetch(`/api/events/${encodeURIComponent(eventId)}/review`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status, note }),
  }));
  if (typeof payload !== "object" || payload === null || !("snapshot" in payload)) throw new Error("Review response was incomplete.");
  return AppSnapshotSchema.parse(payload.snapshot);
}

export async function updateWatchlist(action: "add" | "remove", issuer: Issuer): Promise<AppSnapshot> {
  return AppSnapshotSchema.parse(await readJson(await fetch("/api/watchlist", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, issuer }),
  })));
}
