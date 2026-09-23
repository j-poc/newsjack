import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";
import {
  AppSnapshotSchema,
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
  sortEvents,
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
    this.db.prepare(`
      INSERT INTO watchlist (cik, issuer_json, added_at)
      VALUES (@cik, @issuerJson, @addedAt)
      ON CONFLICT(cik) DO UPDATE SET issuer_json = excluded.issuer_json
    `).run({
      cik: issuer.cik.value,
      issuerJson: JSON.stringify(issuer),
      addedAt,
    });
  }

  public removeWatchlist(issuer: Issuer): void {
    this.db.prepare("DELETE FROM watchlist WHERE cik = ?").run(issuer.cik.value);
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
        statement.run({
          id: event.id,
          provider: event.source.provider,
          nativeId: event.source.nativeId,
          eventJson: JSON.stringify(event),
          reviewStatus: event.review.status,
          reviewNote: event.review.note,
          reviewUpdatedAt: event.review.updatedAt,
          now,
        });
      }
    });
    transaction(events);
  }

  public updateReview(eventId: string, update: ReviewUpdate): Event | null {
    const existing = this.getEvent(eventId);
    if (existing === null || (!this.finnhubProcessingApproved && existing.source.provider === "finnhub_news")) return null;
    const next = EventSchema.parse({
      ...existing,
      review: {
        status: update.status,
        note: update.note,
        updatedAt: nowIso(),
      },
    });
    this.db.prepare(`
      UPDATE events
      SET event_json = @eventJson,
          review_status = @reviewStatus,
          review_note = @reviewNote,
          review_updated_at = @reviewUpdatedAt,
          updated_at = @updatedAt
      WHERE id = @id
    `).run({
      id: eventId,
      eventJson: JSON.stringify(next),
      reviewStatus: next.review.status,
      reviewNote: next.review.note,
      reviewUpdatedAt: next.review.updatedAt,
      updatedAt: nowIso(),
    });
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

  public getSnapshot(now = new Date()): AppSnapshot {
    const eventRows = z.array(StoredEventRowSchema).parse(this.db.prepare("SELECT event_json, review_status, review_note, review_updated_at FROM events").all());
    const events = sortEvents(eventRows.map((row) => {
      const event = EventSchema.parse(JSON.parse(row.event_json));
      return eventAt(EventSchema.parse({
        ...event,
        review: {
          status: row.review_status,
          note: row.review_note,
          updatedAt: row.review_updated_at,
        },
      }), now);
    })).filter((event) => this.finnhubProcessingApproved || event.source.provider !== "finnhub_news");
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
      schemaVersion: 1,
      events,
      watchlist,
      companyCoverage,
      sourceHealth,
      lastRefreshAt: refreshRow?.value ?? null,
    });
  }

  private getEvent(eventId: string): Event | null {
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
