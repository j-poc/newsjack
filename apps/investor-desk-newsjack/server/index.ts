import express from "express";
import {
  RefreshRequestSchema,
  ReviewUpdateSchema,
  WatchlistActionSchema,
  EventScopeSchema,
  nowIso,
} from "../src/domain";
import { EventPageChangedError, SignalDeskDatabase } from "./db";
import { searchSecIssuers } from "./issuer-directory";
import { fetchIssuerNews } from "../worker/issuer-news";
import { dataRoot, pruneRunDirectories, runInvestorScan } from "./newsjack";

const port = Number(process.env.PORT ?? 8789);
const db = new SignalDeskDatabase();
const app = express();
let refreshInFlight = false;

app.use(express.json({ limit: "100kb" }));

app.get("/api/health", (_request, response) => {
  response.json({ status: "ok", service: "newsjack-investor-desk", at: nowIso() });
});

app.get("/api/snapshot", (request, response) => {
  const scope = EventScopeSchema.safeParse(typeof request.query.scope === "string" ? request.query.scope : "all");
  if (!scope.success) { response.status(400).json({ error: "Choose a valid source scope before opening the desk." }); return; }
  response.json(db.getSnapshot(new Date(), scope.data));
});

app.get("/api/events", (request, response) => {
  const cursor = typeof request.query.cursor === "string" ? request.query.cursor : "";
  if (cursor.length === 0 || cursor.length > 2048) { response.status(400).json({ error: "A valid records cursor is required." }); return; }
  try {
    response.json(db.getEventPage(cursor));
  } catch (error) {
    if (error instanceof EventPageChangedError) { response.status(error.status).json({ error: error.message }); return; }
    response.status(500).json({ error: "The next event page could not be read." });
  }
});

app.get("/api/issuers/news", async (request, response) => {
  const ticker = typeof request.query.ticker === "string" ? request.query.ticker : "";
  response.json(await fetchIssuerNews(ticker, fetch));
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
  const scope = parsed.data.source === "company_news" ? "all" : parsed.data.source;
  const watchlist = db.getWatchlist();
  if (parsed.data.source === "watchlist" && watchlist.length === 0) {
    response.status(409).json({ error: "Your watchlist is empty. Choose all public issuers or add an issuer before refreshing the wire.", snapshot: db.getSnapshot(new Date(), scope) });
    return;
  }
  if (refreshInFlight) {
    response.status(409).json({ error: "A live wire refresh is already in progress. Its results will appear in the snapshot when it completes.", snapshot: db.getSnapshot(new Date(), scope) });
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
    const snapshot = db.getSnapshot(new Date(), scope);
    if (result.events.length === 0 && result.failures.length > 0) {
      const detail = result.failures.length > 0 ? ` ${result.failures.slice(0, 2).join(" ")}` : result.stderr;
      response.status(502).json({ error: `The wire returned no usable live records.${detail}`, snapshot });
      return;
    }
    response.json(snapshot);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Live source and TypeSafe AI refresh failed.";
    response.status(502).json({ error: message, snapshot: db.getSnapshot(new Date(), scope) });
  } finally {
    refreshInFlight = false;
    void pruneRunDirectories(dataRoot());
  }
});

app.post("/api/events/:eventId/review", (request, response) => {
  const scope = EventScopeSchema.safeParse(typeof request.query.scope === "string" ? request.query.scope : "all");
  if (!scope.success) { response.status(400).json({ error: "Choose a valid source scope before saving a review." }); return; }
  const parsed = ReviewUpdateSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "Expected a valid review status and note." });
    return;
  }
  const event = db.updateReview(request.params.eventId, parsed.data);
  if (event === null) {
    const current = db.getEventById(request.params.eventId);
    response.status(current === null ? 404 : 409).json({ error: "The filing is missing or its review changed elsewhere. Reload before saving again.", ...(current === null ? {} : { event: current }) });
    return;
  }
  response.json({ event, snapshot: db.getSnapshot(new Date(), scope.data) });
});

app.post("/api/watchlist", (request, response) => {
  const scope = EventScopeSchema.safeParse(typeof request.query.scope === "string" ? request.query.scope : "all");
  if (!scope.success) { response.status(400).json({ error: "Choose a valid source scope before updating the watchlist." }); return; }
  const parsed = WatchlistActionSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "Expected a valid watchlist action." });
    return;
  }
  if (parsed.data.action === "add") db.upsertWatchlist(parsed.data.issuer);
  else db.removeWatchlist(parsed.data.issuer);
  response.json(db.getSnapshot(new Date(), scope.data));
});

const server = app.listen(port, () => {
  process.stdout.write(`${JSON.stringify({ event: "server_started", url: `http://localhost:${port}` })}\n`);
});

function close(): void {
  server.close(() => db.close());
}

process.once("SIGINT", close);
process.once("SIGTERM", close);
