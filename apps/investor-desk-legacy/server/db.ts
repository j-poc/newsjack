import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";
import {
  AppSnapshotSchema,
  EventSchema,
  type AppSnapshot,
  type Event,
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
  message: z.string(),
  checked_at: z.string(),
}).strict();

type StoredHealthRow = z.infer<typeof StoredHealthRowSchema>;

const MetaRowSchema = z.object({ value: z.string() }).strict();

export class SignalDeskDatabase {
  private readonly db: Database.Database;

  public constructor(dataDirectory = process.env.SIGNAL_DESK_DATA_DIR ?? path.resolve("data")) {
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
    if (existing === null) return null;
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
      INSERT INTO source_health (provider, status, message, checked_at)
      VALUES (@provider, @status, @message, @checkedAt)
      ON CONFLICT(provider) DO UPDATE SET
        status = excluded.status,
        message = excluded.message,
        checked_at = excluded.checked_at
    `).run({
      provider: health.provider,
      status: health.status,
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

  public getSnapshot(): AppSnapshot {
    const eventRows = z.array(StoredEventRowSchema).parse(this.db.prepare("SELECT event_json, review_status, review_note, review_updated_at FROM events").all());
    const events = sortEvents(eventRows.map((row) => {
      const event = EventSchema.parse(JSON.parse(row.event_json));
      return EventSchema.parse({
        ...event,
        review: {
          status: row.review_status,
          note: row.review_note,
          updatedAt: row.review_updated_at,
        },
      });
    }));
    const watchlist = this.getWatchlist();
    const healthRows = z.array(StoredHealthRowSchema).parse(this.db.prepare("SELECT provider, status, message, checked_at FROM source_health ORDER BY provider").all());
    const sourceHealth = healthRows.map((row) => ({
      provider: row.provider,
      status: row.status,
      message: row.message,
      checkedAt: row.checked_at,
    }));
    const refreshRow = MetaRowSchema.nullish().parse(this.db.prepare("SELECT value FROM meta WHERE key = 'lastRefreshAt'").get());
    return AppSnapshotSchema.parse({
      schemaVersion: 1,
      events,
      watchlist,
      sourceHealth,
      lastRefreshAt: refreshRow?.value ?? null,
    });
  }

  private getEvent(eventId: string): Event | null {
    const row = StoredEventRowSchema.nullish().parse(this.db.prepare("SELECT event_json, review_status, review_note, review_updated_at FROM events WHERE id = ?").get(eventId));
    if (row === undefined || row === null) return null;
    const event = EventSchema.parse(JSON.parse(row.event_json));
    return EventSchema.parse({
      ...event,
      review: {
        status: row.review_status,
        note: row.review_note,
        updatedAt: row.review_updated_at,
      },
    });
  }

}
