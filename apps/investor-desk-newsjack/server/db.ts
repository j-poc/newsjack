import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";
import {
  AppSnapshotSchema,
  decodeEventCursor,
  EventPageSchema,
  EventScopeSchema,
  EVENTS_PAGE_SIZE,
  CompanyCoverageSchema,
  EventSchema,
  type AppSnapshot,
  type Event,
  type Freshness,
  type CompanyCoverage,
  type Issuer,
  type ReviewUpdate,
  type SourceHealth,
  type WatchlistEntry,
  WatchlistEntrySchema,
  nowIso,
  nextReviewUpdatedAt,
  sortEvents,
  encodeEventCursor,
  type EventCursor,
  type EventPage,
  type EventScope,
} from "../src/domain";

const StoredEventRowSchema = z.object({
  event_json: z.string(),
  review_status: z.string(),
  review_note: z.string(),
  review_updated_at: z.string().nullable(),
}).strict();
type StoredEventRow = z.infer<typeof StoredEventRowSchema>;

const StoredWatchlistRowSchema = z.object({
  issuer_json: z.string(),
  added_at: z.string(),
}).strict();
type StoredWatchlistRow = z.infer<typeof StoredWatchlistRowSchema>;

const StoredHealthRowSchema = z.object({
  provider: z.string(),
  status: z.enum(["healthy", "degraded", "offline"]),
  freshness: z.enum(["live", "cached", "stale", "unavailable"]),
  message: z.string(),
  checked_at: z.string(),
}).strict();

type StoredHealthRow = z.infer<typeof StoredHealthRowSchema>;

const MetaRowSchema = z.object({ value: z.string() }).strict();
const SOURCE_FRESHNESS_STALE_AFTER_MS = 20 * 60 * 1000;
const MAX_EVENT_JSON_BYTES = 96 * 1024;

export class EventPageChangedError extends Error {
  public constructor(message: string, public readonly status: 400 | 409) {
    super(message);
    this.name = "EventPageChangedError";
  }
}

function freshnessAt(current: Freshness, observedAt: string, now: Date): Freshness {
  if (current === "unavailable") return current;
  const observedTime = Date.parse(observedAt);
  const age = now.getTime() - observedTime;
  if (!Number.isFinite(observedTime) || age < -60_000) return "unavailable";
  if (age > SOURCE_FRESHNESS_STALE_AFTER_MS || current === "stale") return "stale";
  return current;
}

function eventAt(event: Event, now: Date): Event {
  return EventSchema.parse({
    ...event,
    source: {
      ...event.source,
      freshness: freshnessAt(event.source.freshness, event.source.observedAt, now),
    },
  });
}

export class SignalDeskDatabase {
  private readonly db: Database.Database;

  public constructor(
    dataDirectory = process.env.SIGNAL_DESK_DATA_DIR ?? path.resolve("data"),
    private readonly finnhubProcessingApproved = process.env.NEWSJACK_FINNHUB_PROCESSING_APPROVED === "true",
  ) {
    fs.mkdirSync(dataDirectory, { recursive: true });
    this.db = new Database(path.join(dataDirectory, "signal-desk.sqlite"));
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        source_provider TEXT NOT NULL,
        source_native_id TEXT NOT NULL,
        event_json TEXT NOT NULL,
        review_status TEXT NOT NULL,
        review_note TEXT NOT NULL DEFAULT '',
        review_updated_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(source_provider, source_native_id)
      );
      CREATE TABLE IF NOT EXISTS watchlist (
        cik TEXT PRIMARY KEY,
        issuer_json TEXT NOT NULL,
        added_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS source_health (
        provider TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        freshness TEXT NOT NULL DEFAULT 'unavailable',
        message TEXT NOT NULL,
        checked_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS source_documents (
        provider TEXT NOT NULL,
        native_id TEXT NOT NULL,
        url TEXT NOT NULL,
        text TEXT NOT NULL,
        digest TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        parse_version TEXT NOT NULL,
        complete INTEGER NOT NULL,
        PRIMARY KEY (provider, native_id)
      );
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    try {
      this.db.exec("ALTER TABLE source_health ADD COLUMN freshness TEXT NOT NULL DEFAULT 'unavailable'");
    } catch {
      // Existing databases already have the column; SQLite has no IF NOT EXISTS for ADD COLUMN.
    }
  }

  public close(): void {
    this.db.close();
  }

  public getWatchlist(): WatchlistEntry[] {
    const rows = z.array(StoredWatchlistRowSchema).parse(this.db.prepare("SELECT issuer_json, added_at FROM watchlist ORDER BY added_at ASC").all());
    return rows.map((row) => WatchlistEntrySchema.parse({
      issuer: JSON.parse(row.issuer_json),
      addedAt: row.added_at,
    }));
  }

  public upsertWatchlist(issuer: Issuer): void {
    const addedAt = nowIso();
    const update = this.db.prepare(`
      INSERT INTO watchlist (cik, issuer_json, added_at)
      VALUES (@cik, @issuerJson, @addedAt)
      ON CONFLICT(cik) DO UPDATE SET issuer_json = excluded.issuer_json
    `);
    this.db.transaction(() => {
      update.run({ cik: issuer.cik.value, issuerJson: JSON.stringify(issuer), addedAt });
      this.bumpEventRevision();
    })();
  }

  public removeWatchlist(issuer: Issuer): void {
    const now = nowIso();
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM watchlist WHERE cik = ?").run(issuer.cik.value);
      this.bumpEventRevision();
    })();
  }

  public upsertEvents(events: readonly Event[]): void {
    const statement = this.db.prepare(`
      INSERT INTO events (
        id, source_provider, source_native_id, event_json, review_status,
        review_note, review_updated_at, created_at, updated_at
      ) VALUES (
        @id, @provider, @nativeId, @eventJson, @reviewStatus,
        @reviewNote, @reviewUpdatedAt, @now, @now
      )
      ON CONFLICT(source_provider, source_native_id) DO UPDATE SET
        id = excluded.id,
        event_json = excluded.event_json,
        updated_at = excluded.updated_at
    `);
    const transaction = this.db.transaction((items: readonly Event[]) => {
      const now = nowIso();
      for (const event of items) {
        const parsed = EventSchema.parse(event);
        const eventJson = JSON.stringify(parsed);
        if (Buffer.byteLength(eventJson, "utf8") > MAX_EVENT_JSON_BYTES) throw new Error("A screened event exceeded the 96 KiB storage contract; no events were committed.");
        statement.run({
          id: parsed.id,
          provider: parsed.source.provider,
          nativeId: parsed.source.nativeId,
          eventJson,
          reviewStatus: parsed.review.status,
          reviewNote: parsed.review.note,
          reviewUpdatedAt: parsed.review.updatedAt,
          now,
        });
      }
      if (items.length > 0) this.bumpEventRevision();
    });
    transaction(events);
  }

  public updateReview(eventId: string, update: ReviewUpdate): Event | null {
    const existing = this.getEventById(eventId);
    if (existing === null || (!this.finnhubProcessingApproved && existing.source.provider === "finnhub_news")) return null;
    if (existing.review.status !== update.expectedReview.status
      || existing.review.note !== update.expectedReview.note
      || existing.review.updatedAt !== update.expectedReview.updatedAt) return null;
    const reviewUpdatedAt = nextReviewUpdatedAt(nowIso(), update.expectedReview);
    const next = EventSchema.parse({
      ...existing,
      review: {
        status: update.status,
        note: update.note,
        updatedAt: reviewUpdatedAt,
      },
    });
    const result = this.db.prepare(`
      UPDATE events
      SET event_json = @eventJson,
          review_status = @reviewStatus,
          review_note = @reviewNote,
          review_updated_at = @reviewUpdatedAt,
          updated_at = @updatedAt
      WHERE id = @id
        AND review_status = @expectedStatus
        AND review_note = @expectedNote
        AND review_updated_at IS @expectedUpdatedAt
    `).run({
      id: eventId,
      eventJson: JSON.stringify(next),
      reviewStatus: next.review.status,
      reviewNote: next.review.note,
      reviewUpdatedAt,
      updatedAt: nowIso(),
      expectedStatus: update.expectedReview.status,
      expectedNote: update.expectedReview.note,
      expectedUpdatedAt: update.expectedReview.updatedAt,
    });
    if (result.changes !== 1) return null;
    return next;
  }

  public setSourceHealth(health: SourceHealth): void {
    this.db.prepare(`
      INSERT INTO source_health (provider, status, freshness, message, checked_at)
      VALUES (@provider, @status, @freshness, @message, @checkedAt)
      ON CONFLICT(provider) DO UPDATE SET
        status = excluded.status,
        freshness = excluded.freshness,
        message = excluded.message,
        checked_at = excluded.checked_at
    `).run({
      provider: health.provider,
      status: health.status,
      freshness: health.freshness,
      message: health.message,
      checkedAt: health.checkedAt,
    });
  }

  public setLastRefreshAt(value: string): void {
    this.db.prepare(`
      INSERT INTO meta (key, value) VALUES ('lastRefreshAt', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(value);
  }

  public getFinnhubSymbolOffset(): number {
    const row = MetaRowSchema.nullish().parse(this.db.prepare("SELECT value FROM meta WHERE key = 'finnhubSymbolOffset'").get());
    if (row === undefined || row === null) return 0;
    const value = Number(row.value);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Stored Finnhub symbol-rotation offset is invalid.");
    return value;
  }

  public setFinnhubSymbolOffset(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Finnhub symbol-rotation offset must be a non-negative safe integer.");
    this.setMeta("finnhubSymbolOffset", String(value));
  }

  public setCompanyCoverage(value: CompanyCoverage): void {
    const coverage = CompanyCoverageSchema.parse(value);
    this.setMeta("companyCoverage", JSON.stringify(coverage));
  }

  public getSnapshot(now = new Date(), scope: EventScope = "all"): AppSnapshot {
    const parsedScope = EventScopeSchema.parse(scope);
    const eventsRevision = this.getEventRevision();
    const scopedEvents = this.getScopedEvents(now, parsedScope);
    const page = this.makeEventPage(scopedEvents.slice(0, EVENTS_PAGE_SIZE), eventsRevision, parsedScope, scopedEvents.length, scopedEvents.length);
    const watchlist = this.getWatchlist();
    const healthRows = z.array(StoredHealthRowSchema).parse(this.db.prepare("SELECT provider, status, freshness, message, checked_at FROM source_health ORDER BY provider").all());
    const sourceHealth = healthRows
      .filter((row) => this.finnhubProcessingApproved || row.provider !== "finnhub_news")
      .map((row) => ({
      provider: row.provider,
      status: row.status,
      freshness: freshnessAt(row.freshness, row.checked_at, now),
      message: row.message,
      checkedAt: row.checked_at,
    }));
    if (!this.finnhubProcessingApproved) {
      sourceHealth.push({
        provider: "finnhub_news",
        status: "offline",
        freshness: "unavailable",
        message: "Not requested: written approval for third-party TypeSafe processing has not been confirmed.",
        checkedAt: now.toISOString(),
      });
    }
    const refreshRow = MetaRowSchema.nullish().parse(this.db.prepare("SELECT value FROM meta WHERE key = 'lastRefreshAt'").get());
    const coverageRow = MetaRowSchema.nullish().parse(this.db.prepare("SELECT value FROM meta WHERE key = 'companyCoverage'").get());
    const companyCoverage = !this.finnhubProcessingApproved || coverageRow === undefined || coverageRow === null
      ? null
      : CompanyCoverageSchema.parse(JSON.parse(coverageRow.value));
    return AppSnapshotSchema.parse({
      schemaVersion: 2,
      ...page,
      eventsScope: parsedScope,
      watchlist,
      companyCoverage,
      sourceHealth,
      lastRefreshAt: refreshRow?.value ?? null,
    });
  }

  public getEventPage(encodedCursor: string, now = new Date()): EventPage {
    const cursor = decodeEventCursor(encodedCursor);
    if (cursor === null) throw new EventPageChangedError("The records cursor is invalid. Reload the wire to start a new traversal.", 400);
    const revision = this.getEventRevision();
    if (cursor.revision !== revision) throw new EventPageChangedError("The wire changed while older records were loading. Reload the records list and continue from the updated ranking.", 409);
    const allEvents = this.getScopedEvents(now, cursor.scope);
    const remaining = allEvents.filter((event) => isAfterCursor(event, cursor));
    return this.makeEventPage(remaining.slice(0, EVENTS_PAGE_SIZE), revision, cursor.scope, allEvents.length, remaining.length);
  }

  private getScopedEvents(now: Date, scope: EventScope): Event[] {
    const eventRows = z.array(StoredEventRowSchema).parse(this.db.prepare("SELECT event_json, review_status, review_note, review_updated_at FROM events").all());
    const visible = eventRows.map((row) => {
      const event = EventSchema.parse(JSON.parse(row.event_json));
      return eventAt(EventSchema.parse({
        ...event,
        review: { status: row.review_status, note: row.review_note, updatedAt: row.review_updated_at },
      }), now);
    }).filter((event) => this.finnhubProcessingApproved || event.source.provider !== "finnhub_news");
    if (scope === "federal") return sortEvents(visible.filter((event) => event.source.provider === "federal_register"));
    if (scope === "all_public") return sortEvents(visible.filter((event) => event.source.provider === "sec"));
    if (scope === "watchlist") {
      const ciks = new Set(this.getWatchlist().map((entry) => entry.issuer.cik.value));
      return sortEvents(visible.filter((event) => event.source.provider === "sec" && event.subject.kind === "issuer" && ciks.has(event.subject.cik.value)));
    }
    return sortEvents(visible);
  }

  private makeEventPage(events: Event[], revision: number, scope: EventScope, total: number, remaining: number): EventPage {
    const hasMore = remaining > events.length;
    const pageEvents = events;
    const last = pageEvents.at(-1);
    const eventsCursor = hasMore && last !== undefined
      ? encodeEventCursor({ version: 1, revision, scope, attentionScore: last.screening.attentionScore, availableAt: last.availableAt, id: last.id })
      : null;
    return EventPageSchema.parse({ events: pageEvents, eventsTotal: total, eventsRevision: revision, eventsCursor });
  }

  private getEventRevision(): number {
    const row = MetaRowSchema.nullish().parse(this.db.prepare("SELECT value FROM meta WHERE key = 'eventCatalogRevision'").get());
    const revision = Number(row?.value ?? "0");
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("Stored event-catalog revision is invalid.");
    return revision;
  }

  private bumpEventRevision(): void {
    const revision = this.getEventRevision() + 1;
    this.db.prepare(`
      INSERT INTO meta (key, value) VALUES ('eventCatalogRevision', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(String(revision));
  }

  public getEventById(eventId: string): Event | null {
    const row = StoredEventRowSchema.nullish().parse(this.db.prepare("SELECT event_json, review_status, review_note, review_updated_at FROM events WHERE id = ?").get(eventId));
    if (row === undefined || row === null) return null;
    const event = EventSchema.parse(JSON.parse(row.event_json));
    return eventAt(EventSchema.parse({
      ...event,
      review: {
        status: row.review_status,
        note: row.review_note,
        updatedAt: row.review_updated_at,
      },
    }), new Date());
  }

  private setMeta(key: string, value: string): void {
    this.db.prepare(`
      INSERT INTO meta (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }

}

function isAfterCursor(event: Event, cursor: EventCursor): boolean {
  if (event.screening.attentionScore !== cursor.attentionScore) return event.screening.attentionScore < cursor.attentionScore;
  const eventTime = Date.parse(event.availableAt);
  const cursorTime = Date.parse(cursor.availableAt);
  if (eventTime !== cursorTime) return eventTime < cursorTime;
  return event.id > cursor.id;
}
