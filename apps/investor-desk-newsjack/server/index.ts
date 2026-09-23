import express from "express";
import {
  RefreshRequestSchema,
  ReviewUpdateSchema,
  WatchlistActionSchema,
  nowIso,
} from "../src/domain";
import { SignalDeskDatabase } from "./db";
import { searchSecIssuers } from "./issuer-directory";
import { runInvestorScan } from "./newsjack";

const port = Number(process.env.PORT ?? 8789);
const db = new SignalDeskDatabase();
const app = express();
let refreshInFlight = false;

app.use(express.json({ limit: "100kb" }));

app.get("/api/health", (_request, response) => {
  response.json({ status: "ok", service: "newsjack-investor-desk", at: nowIso() });
});

app.get("/api/snapshot", (_request, response) => {
  response.json(db.getSnapshot());
});

app.get("/api/issuers/search", async (request, response) => {
  try {
    response.json(await searchSecIssuers(typeof request.query.q === "string" ? request.query.q : ""));
  } catch (error) {
    response.status(502).json({ error: error instanceof Error ? error.message : "The SEC issuer directory could not be read." });
  }
});

app.post("/api/refresh", async (request, response) => {
  const parsed = RefreshRequestSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "Expected a source scope: watchlist, all_public, company_news, federal, or all." });
    return;
  }
  const watchlist = db.getWatchlist();
  if (parsed.data.source === "watchlist" && watchlist.length === 0) {
    response.status(409).json({ error: "Your watchlist is empty. Choose all public issuers or add an issuer before refreshing the wire.", snapshot: db.getSnapshot() });
    return;
  }
  if (refreshInFlight) {
    response.status(409).json({ error: "A live wire refresh is already in progress. Its results will appear in the snapshot when it completes.", snapshot: db.getSnapshot() });
    return;
  }
  refreshInFlight = true;
  try {
    const result = await runInvestorScan(watchlist, parsed.data.source, db.getFinnhubSymbolOffset());
    if (result.events.length > 0) db.upsertEvents(result.events);
    if (result.companyCoverage !== null) db.setCompanyCoverage(result.companyCoverage);
    if (result.canAdvanceFinnhubSymbolOffset && result.nextFinnhubSymbolOffset !== null) db.setFinnhubSymbolOffset(result.nextFinnhubSymbolOffset);
    for (const update of [result.secHealth, result.federalHealth, result.companyNewsHealth, result.typesafeHealth]) {
      switch (update.kind) {
        case "checked":
          db.setSourceHealth(update.health);
          break;
        case "not_queried":
          break;
        default: {
          const exhaustive: never = update;
          throw new Error(`Unsupported provider health update: ${JSON.stringify(exhaustive)}`);
        }
      }
    }
    db.setLastRefreshAt(result.audit.generated_at);
    const snapshot = db.getSnapshot();
    if (result.events.length === 0 && result.failures.length > 0) {
      const detail = result.failures.length > 0 ? ` ${result.failures.slice(0, 2).join(" ")}` : result.stderr;
      response.status(502).json({ error: `The wire returned no usable live records.${detail}`, snapshot });
      return;
    }
    response.json(snapshot);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Live source and TypeSafe AI refresh failed.";
    response.status(502).json({ error: message, snapshot: db.getSnapshot() });
  } finally {
    refreshInFlight = false;
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
    response.status(404).json({ error: "Filing not found." });
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
  server.close(() => db.close());
}

process.once("SIGINT", close);
process.once("SIGTERM", close);
