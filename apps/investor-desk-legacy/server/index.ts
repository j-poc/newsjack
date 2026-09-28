import express from "express";
import {
  RefreshRequestSchema,
  ReviewUpdateSchema,
  WatchlistActionSchema,
  nowIso,
} from "../src/domain";
import { SignalDeskDatabase } from "./db";
import { jevHealthWithoutKey, screenSecCandidates } from "./jev";
import { fetchSecCandidates } from "./sources/sec";

const port = Number(process.env.PORT ?? 8789);
const db = new SignalDeskDatabase();
const app = express();

app.use(express.json({ limit: "100kb" }));

app.get("/api/health", (_request, response) => {
  response.json({ status: "ok", service: "signal-desk", at: nowIso() });
});

app.get("/api/snapshot", (_request, response) => {
  response.json(db.getSnapshot());
});

app.post("/api/refresh", async (request, response) => {
  const parsed = RefreshRequestSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "Expected { source: 'sec' }." });
    return;
  }
  try {
    const secResult = await fetchSecCandidates(db.getWatchlist(), undefined, db);
    db.setSourceHealth(secResult.health);
    if (secResult.candidates.length === 0) {
      if (secResult.health.status !== "healthy") {
        db.setLastRefreshAt(secResult.health.checkedAt);
        response.status(502).json({ error: secResult.health.message, snapshot: db.getSnapshot() });
        return;
      }
      const jevHealth = jevHealthWithoutKey();
      db.setSourceHealth(jevHealth);
      db.setLastRefreshAt(secResult.health.checkedAt);
      response.status(502).json({ error: jevHealth.message, snapshot: db.getSnapshot() });
      return;
    }
    const jevResult = await screenSecCandidates(secResult.candidates);
    if (jevResult.events.length > 0) db.upsertEvents(jevResult.events);
    db.setSourceHealth(jevResult.health);
    db.setLastRefreshAt(jevResult.health.checkedAt);
    const snapshot = db.getSnapshot();
    if (jevResult.events.length === 0) {
      response.status(502).json({ error: jevResult.health.message, snapshot });
      return;
    }
    response.json(snapshot);
  } catch (error) {
    const message = error instanceof Error ? error.message : "SEC or JEv refresh failed.";
    db.setSourceHealth({ provider: "jev", status: "offline", message, checkedAt: nowIso() });
    response.status(502).json({ error: message, snapshot: db.getSnapshot() });
  }
});

app.post("/api/events/:eventId/review", (request, response) => {
  const parsed = ReviewUpdateSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "Expected a valid review status and note." });
    return;
  }
  const event = db.updateReview(request.params.eventId, parsed.data);
  if (event === null) {
    response.status(404).json({ error: "Signal not found." });
    return;
  }
  response.json({ event, snapshot: db.getSnapshot() });
});

app.post("/api/watchlist", (request, response) => {
  const parsed = WatchlistActionSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "Expected a valid watchlist action." });
    return;
  }
  if (parsed.data.action === "add") db.upsertWatchlist(parsed.data.issuer);
  else db.removeWatchlist(parsed.data.issuer);
  response.json(db.getSnapshot());
});

const server = app.listen(port, () => {
  process.stdout.write(`${JSON.stringify({ event: "server_started", url: `http://localhost:${port}` })}\n`);
});

function close(): void {
  server.close(() => {
    db.close();
  });
}

process.once("SIGINT", close);
process.once("SIGTERM", close);
