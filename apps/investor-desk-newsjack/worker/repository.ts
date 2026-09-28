import {
  AppSnapshotSchema,
  EventCursorSchema,
  EVENTS_PAGE_SIZE,
  EventPageSchema,
  PublicIssuerCoverageSchema,
  EventSchema,
  SourceHealthSchema,
  WatchlistEntrySchema,
  encodeEventCursor,
  type AppSnapshot,
  type EventPage,
  type EventScope,
  type EventCursor,
  type Event,
  type Issuer,
  type ReviewUpdate,
  type SourceHealth,
  type WatchlistEntry,
  nextReviewUpdatedAt,
} from "../src/domain";
import type { CaptureRecord, SqlStatement, WorkerEnv } from "./types";
import { z } from "zod";

const STALE_AFTER_MS = 20 * 60 * 1000;
const InstantTextSchema = z.string().datetime({ offset: true });
const MetaRowSchema = z.object({ value: z.string() });
const FoundRowSchema = z.object({ found: z.number() });
const TokenRowSchema = z.object({ token: z.string() });
const AttemptRowSchema = z.object({ attempt_count: z.number().int().nonnegative() });
const WatchlistRowSchema = z.object({ issuer_json: z.string(), added_at: z.string() });
const CikRowSchema = z.object({ cik: z.string() });
const EventSnapshotRowSchema = z.object({
  event_json: z.string(),
  review_status: z.string(),
  review_note: z.string(),
  review_updated_at: z.string().nullable(),
});
const HealthRowSchema = z.object({
  provider: z.string(),
  status: z.string(),
  freshness: z.string(),
  message: z.string(),
  checked_at: z.string(),
});
const CountRowSchema = z.object({ count: z.number().int().nonnegative() }).strict();
const RevisionRowSchema = z.object({ revision: z.number().int().nonnegative() }).strict();
const MAX_EVENT_JSON_BYTES = 96 * 1024;

export class EventPageError extends Error {
  public constructor(public readonly status: 400 | 409 | 422, message: string) {
    super(message);
    this.name = "EventPageError";
  }
}

export interface ScreeningRunRecord {
  provider: string;
  nativeId: string;
  sourceDigest: string;
  sourceVersionDigest: string;
  contractDigest: string;
  evidenceComplete: boolean;
  captureKind: "abstract" | "full_text";
  status: "accepted" | "excluded";
  resultDigest: string;
  promptDigest: string;
  model: string;
  screenedAt: string;
  lastValidatedAt: string;
}

export interface MetaUpdate {
  key: string;
  value: string;
}

export interface RefreshWrite {
  events: readonly Event[];
  captures: readonly CaptureRecord[];
  screenings: readonly ScreeningRunRecord[];
  health: readonly SourceHealth[];
  meta: readonly MetaUpdate[];
  refreshedAt: string;
  secQueueTransitions?: readonly SecQueueTransition[];
  secIssuerRetriesCleared?: readonly Pick<SecIssuerRetry, "scope" | "cik">[];
  secObservationTouches?: readonly SecObservationTouch[];
  secScreeningTouches?: readonly SecScreeningTouch[];
}

export type SecQueueScope = "public" | "watchlist";

export interface SecQueueIssuer {
  cik: string;
  ticker: string;
  name: string;
  exchange?: string;
}

const SecQueueIssuerSchema = z.object({
  cik: z.string().regex(/^\d{10}$/),
  ticker: z.string().regex(/^[A-Z][A-Z0-9.-]{0,9}$/),
  name: z.string().min(1),
  exchange: z.string().min(1).optional(),
}).strict();

export interface SecFilingQueueInput {
  nativeId: string;
  cik: string;
  accession: string;
  issuer: SecQueueIssuer;
  form: string;
  primaryDocument: string;
  primaryDescription: string;
  filedAt: string;
  availableAt: string;
  availablePrecision: "second" | "day";
  sourceVersionDigest: string;
  contractDigest: string;
}

export interface SecFilingWork extends SecFilingQueueInput {
  attemptCount: number;
  nextAttemptAt: string;
}

export interface SecIssuerRetry {
  scope: SecQueueScope;
  cik: string;
  issuer: SecQueueIssuer;
  attemptCount: number;
  nextAttemptAt: string;
  lastError: string;
}

export interface SecDiscoveryReplay {
  issuer: SecQueueIssuer;
  capture: CaptureRecord;
}

export interface SecQueueTransition {
  nativeId: string;
  sourceVersionDigest: string;
  contractDigest: string;
  outcome: "complete" | "retry";
  nextAttemptAt?: string;
  lastError?: string;
}

export interface SecObservationTouch {
  nativeId: string;
  sourceDigest: string;
  observedAt: string;
}

export interface SecScreeningTouch {
  nativeId: string;
  sourceDigest: string;
  sourceVersionDigest: string;
  contractDigest: string;
  validatedAt: string;
}

export class InvestorRepository {
  public constructor(private readonly env: WorkerEnv, private readonly ownerId: string) {}

  public async getMeta(key: string): Promise<string | null> {
    const row = await this.env.DB.prepare("SELECT value FROM meta WHERE owner_id = ? AND key = ? LIMIT 1")
      .bind(this.ownerId, key).first(MetaRowSchema);
    return row?.value ?? null;
  }

  public async getOffset(key: string): Promise<number> {
    const raw = await this.getMeta(key);
    if (raw === null) return 0;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Stored ${key} cursor failed validation.`);
    return value;
  }

  public async getWatchlist(): Promise<WatchlistEntry[]> {
    const rows = await this.env.DB.prepare("SELECT issuer_json, added_at FROM watchlist WHERE owner_id = ? ORDER BY added_at, cik")
      .bind(this.ownerId).all(WatchlistRowSchema);
    return rows.map((row) => WatchlistEntrySchema.parse({ issuer: JSON.parse(row.issuer_json), addedAt: row.added_at }));
  }

  public async hasScreening(provider: string, nativeId: string, sourceDigest: string, sourceVersionDigest: string, contractDigest: string): Promise<boolean> {
    const row = await this.env.DB.prepare(
      "SELECT 1 AS found FROM screening_runs_v2 WHERE owner_id = ? AND source_provider = ? AND native_id = ? AND source_digest = ? AND source_version_digest = ? AND contract_digest = ? LIMIT 1",
    ).bind(this.ownerId, provider, nativeId, sourceDigest, sourceVersionDigest, contractDigest).first(FoundRowSchema);
    return row !== null;
  }

  public async hasScreeningForNative(provider: string, nativeId: string, contractDigest: string): Promise<boolean> {
    const row = await this.env.DB.prepare(
      "SELECT 1 AS found FROM screening_runs_v2 WHERE owner_id = ? AND source_provider = ? AND native_id = ? AND contract_digest = ? AND capture_kind = 'full_text' LIMIT 1",
    ).bind(this.ownerId, provider, nativeId, contractDigest).first(FoundRowSchema);
    return row !== null;
  }

  public async hasScreeningForVersion(provider: string, nativeId: string, sourceVersionDigest: string, contractDigest: string): Promise<boolean> {
    const row = await this.env.DB.prepare(`
      SELECT 1 AS found FROM screening_runs_v2
      WHERE owner_id = ? AND source_provider = ? AND native_id = ? AND source_version_digest = ?
        AND contract_digest = ? AND capture_kind = 'full_text' LIMIT 1
    `).bind(this.ownerId, provider, nativeId, sourceVersionDigest, contractDigest).first(FoundRowSchema);
    return row !== null;
  }

  public async hasRecentFullTextScreeningForNative(provider: string, nativeId: string, contractDigest: string, cutoff: string): Promise<boolean> {
    const row = await this.env.DB.prepare(
      "SELECT 1 AS found FROM screening_runs_v2 WHERE owner_id = ? AND source_provider = ? AND native_id = ? AND contract_digest = ? AND capture_kind = 'full_text' AND last_validated_at > ? LIMIT 1",
    ).bind(this.ownerId, provider, nativeId, contractDigest, cutoff).first(FoundRowSchema);
    return row !== null;
  }

  public async hasRecentFullTextScreeningForVersion(provider: string, nativeId: string, sourceVersionDigest: string, contractDigest: string, cutoff: string): Promise<boolean> {
    const row = await this.env.DB.prepare(
      "SELECT 1 AS found FROM screening_runs_v2 WHERE owner_id = ? AND source_provider = ? AND native_id = ? AND source_version_digest = ? AND contract_digest = ? AND capture_kind = 'full_text' AND last_validated_at > ? LIMIT 1",
    ).bind(this.ownerId, provider, nativeId, sourceVersionDigest, contractDigest, cutoff).first(FoundRowSchema);
    return row !== null;
  }

  public async refreshEventObservation(provider: string, nativeId: string, sourceDigest: string, observedAt: string, lockToken: string): Promise<void> {
    const row = await this.env.DB.prepare(
      "SELECT event_json FROM events WHERE owner_id = ? AND provider = ? AND native_id = ? LIMIT 1",
    ).bind(this.ownerId, provider, nativeId).first(z.object({ event_json: z.string() }));
    if (row === null) return;
    const event = EventSchema.parse(JSON.parse(row.event_json));
    if (event.source.digest !== sourceDigest) return;
    const refreshed = EventSchema.parse({
      ...event,
      source: { ...event.source, observedAt, deliveryState: "network", freshness: "live" },
    });
    const checkedAt = new Date().toISOString();
    const leaseExpiresAt = new Date(Date.parse(checkedAt) + 5 * 60 * 1000).toISOString();
    const results = await this.env.DB.batch([
      this.env.DB.prepare("UPDATE refresh_locks SET expires_at = ? WHERE owner_id = ? AND token = ? AND expires_at > ?")
        .bind(leaseExpiresAt, this.ownerId, lockToken, checkedAt),
      this.env.DB.prepare(`
        UPDATE events SET event_json = ?, observed_at = ?, updated_at = ?
        WHERE owner_id = ? AND provider = ? AND native_id = ?
          AND EXISTS (SELECT 1 FROM refresh_locks WHERE owner_id = ? AND token = ? AND expires_at = ?)
      `).bind(JSON.stringify(refreshed), observedAt, observedAt, this.ownerId, provider, nativeId, this.ownerId, lockToken, leaseExpiresAt),
    ]);
    if (results[0]?.rowsAffected !== 1) throw new Error("Refresh ownership expired before the event observation update.");
  }

  public async touchScreening(record: Pick<ScreeningRunRecord, "provider" | "nativeId" | "sourceDigest" | "sourceVersionDigest" | "contractDigest">, validatedAt: string, lockToken: string): Promise<void> {
    const checkedAt = new Date().toISOString();
    const leaseExpiresAt = new Date(Date.parse(checkedAt) + 5 * 60 * 1000).toISOString();
    const results = await this.env.DB.batch([
      this.env.DB.prepare("UPDATE refresh_locks SET expires_at = ? WHERE owner_id = ? AND token = ? AND expires_at > ?")
        .bind(leaseExpiresAt, this.ownerId, lockToken, checkedAt),
      this.env.DB.prepare(`
        UPDATE screening_runs_v2 SET last_validated_at = ?
        WHERE owner_id = ? AND source_provider = ? AND native_id = ? AND source_digest = ?
          AND source_version_digest = ? AND contract_digest = ?
          AND EXISTS (SELECT 1 FROM refresh_locks WHERE owner_id = ? AND token = ? AND expires_at = ?)
      `).bind(validatedAt, this.ownerId, record.provider, record.nativeId, record.sourceDigest, record.sourceVersionDigest,
        record.contractDigest, this.ownerId, lockToken, leaseExpiresAt),
    ]);
    if (results[0]?.rowsAffected !== 1) throw new Error("Refresh ownership expired before the screening validation update.");
  }

  public async recordCaptures(captures: readonly CaptureRecord[]): Promise<void> {
    const statements = captures.map((capture) => this.env.DB.prepare(`
      INSERT INTO source_captures (
        owner_id, provider, native_id, sha256, object_key, source_url, content_type,
        byte_length, observed_at, adapter_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(owner_id, provider, native_id, sha256) DO NOTHING
    `).bind(
      this.ownerId,
      capture.provider,
      capture.nativeId,
      capture.sha256,
      capture.objectKey,
      capture.sourceUrl,
      capture.contentType,
      capture.byteLength,
      capture.observedAt,
      capture.adapterVersion,
    ));
    for (let index = 0; index < statements.length; index += 90) {
      await this.env.DB.batch(statements.slice(index, index + 90));
    }
  }

  public async queueSecFilings(
    scope: SecQueueScope,
    filings: readonly SecFilingQueueInput[],
    submissionCapture: CaptureRecord,
    lockToken: string,
    now: string,
    discoveryCik?: string,
  ): Promise<void> {
    if (submissionCapture.ownerId !== this.ownerId || submissionCapture.provider !== "sec") {
      throw new Error("SEC discovery capture does not match its owner and provider.");
    }
    if (filings.length === 0) {
      if (discoveryCik !== undefined) await this.completeSecDiscoveryReplay(scope, discoveryCik, submissionCapture.sha256, lockToken);
      return;
    }
    const makeCapture = (leaseExpiresAt: string): SqlStatement => this.env.DB.prepare(`
      INSERT INTO source_captures (
        owner_id, provider, native_id, sha256, object_key, source_url, content_type,
        byte_length, observed_at, adapter_version
      ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM refresh_locks WHERE owner_id = ? AND token = ? AND expires_at = ?)
      ON CONFLICT(owner_id, provider, native_id, sha256) DO NOTHING
    `).bind(
      this.ownerId,
      submissionCapture.provider,
      submissionCapture.nativeId,
      submissionCapture.sha256,
      submissionCapture.objectKey,
      submissionCapture.sourceUrl,
      submissionCapture.contentType,
      submissionCapture.byteLength,
      submissionCapture.observedAt,
      submissionCapture.adapterVersion,
      this.ownerId,
      lockToken,
      leaseExpiresAt,
    );
    const makeReplayCompletion = (leaseExpiresAt: string): SqlStatement | null => discoveryCik === undefined
      ? null
      : this.env.DB.prepare(`
          DELETE FROM sec_discovery_replays
          WHERE owner_id = ? AND scope = ? AND cik = ? AND native_id = ? AND capture_sha256 = ?
            AND EXISTS (SELECT 1 FROM refresh_locks WHERE owner_id = ? AND token = ? AND expires_at = ?)
        `).bind(this.ownerId, scope, discoveryCik, submissionCapture.nativeId, submissionCapture.sha256,
          this.ownerId, lockToken, leaseExpiresAt);
    const filingStatements = filings.map((filing) => (leaseExpiresAt: string): SqlStatement => {
      const issuer = SecQueueIssuerSchema.parse(filing.issuer);
      if (issuer.cik !== filing.cik || !/^[0-9]{10}-[0-9]{2}-[0-9]{6}$/.test(filing.accession)
        || filing.nativeId !== `SEC:${filing.cik}:${filing.accession}`) {
        throw new Error("SEC queue filing identity failed validation.");
      }
      InstantTextSchema.parse(filing.filedAt);
      InstantTextSchema.parse(filing.availableAt);
      if (!/^[a-f0-9]{64}$/.test(filing.sourceVersionDigest) || !/^[a-f0-9]{64}$/.test(filing.contractDigest)) {
        throw new Error("SEC queue generation digest failed validation.");
      }
      return this.env.DB.prepare(`
        INSERT INTO sec_filing_queue (
          owner_id, native_id, cik, accession, issuer_json, form, primary_document,
          primary_description, filed_at, available_at, available_precision,
          source_version_digest, contract_digest, public_discovered, attempt_count,
          next_attempt_at, last_error, discovered_at, updated_at
        ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, ?, ?
        WHERE EXISTS (SELECT 1 FROM refresh_locks WHERE owner_id = ? AND token = ? AND expires_at = ?)
        ON CONFLICT(owner_id, native_id) DO UPDATE SET
          cik = excluded.cik,
          accession = excluded.accession,
          issuer_json = excluded.issuer_json,
          form = excluded.form,
          primary_document = excluded.primary_document,
          primary_description = excluded.primary_description,
          filed_at = excluded.filed_at,
          available_at = excluded.available_at,
          available_precision = excluded.available_precision,
          public_discovered = MAX(sec_filing_queue.public_discovered, excluded.public_discovered),
          attempt_count = CASE WHEN sec_filing_queue.source_version_digest <> excluded.source_version_digest
              OR sec_filing_queue.contract_digest <> excluded.contract_digest
            THEN 0 ELSE sec_filing_queue.attempt_count END,
          next_attempt_at = CASE WHEN sec_filing_queue.source_version_digest <> excluded.source_version_digest
              OR sec_filing_queue.contract_digest <> excluded.contract_digest
            THEN excluded.next_attempt_at ELSE sec_filing_queue.next_attempt_at END,
          last_error = CASE WHEN sec_filing_queue.source_version_digest <> excluded.source_version_digest
              OR sec_filing_queue.contract_digest <> excluded.contract_digest
            THEN NULL ELSE sec_filing_queue.last_error END,
          source_version_digest = excluded.source_version_digest,
          contract_digest = excluded.contract_digest,
          updated_at = excluded.updated_at
      `).bind(
        this.ownerId,
        filing.nativeId,
        filing.cik,
        filing.accession,
        JSON.stringify(issuer),
        filing.form,
        filing.primaryDocument,
        filing.primaryDescription,
        filing.filedAt,
        filing.availableAt,
        filing.availablePrecision,
        filing.sourceVersionDigest,
        filing.contractDigest,
        scope === "public" ? 1 : 0,
        now,
        now,
        now,
        this.ownerId,
        lockToken,
        leaseExpiresAt,
      );
    });

    for (let offset = 0; offset < filingStatements.length; offset += 88) {
      const checkedAt = new Date().toISOString();
      const leaseExpiresAt = new Date(Date.parse(checkedAt) + 5 * 60 * 1000).toISOString();
      const lease = this.env.DB.prepare(`
        UPDATE refresh_locks SET expires_at = ?
        WHERE owner_id = ? AND token = ? AND expires_at > ?
      `).bind(leaseExpiresAt, this.ownerId, lockToken, checkedAt);
      const chunk = filingStatements.slice(offset, offset + 88).map((makeStatement) => makeStatement(leaseExpiresAt));
      const finalChunk = offset + chunk.length === filingStatements.length;
      const completion = finalChunk ? makeReplayCompletion(leaseExpiresAt) : null;
      const statements = offset === 0
        ? [lease, makeCapture(leaseExpiresAt), ...chunk, ...(completion === null ? [] : [completion])]
        : [lease, ...chunk, ...(completion === null ? [] : [completion])];
      const results = await this.env.DB.batch(statements);
      if (results[0]?.rowsAffected !== 1) throw new Error("Refresh ownership expired before SEC discovery was persisted.");
      if (completion !== null && results.at(-1)?.rowsAffected !== 1) {
        throw new Error("SEC discovery queue was written, but its exact replay pointer could not be cleared.");
      }
    }
  }

  public async getSecDiscoveryReplay(scope: SecQueueScope, cik: string): Promise<SecDiscoveryReplay | null> {
    const row = await this.env.DB.prepare(`
      SELECT r.issuer_json, c.owner_id, c.provider, c.native_id, c.sha256, c.object_key,
        c.source_url, c.content_type, c.byte_length, r.created_at AS observed_at, c.adapter_version
      FROM sec_discovery_replays r
      LEFT JOIN source_captures c ON c.owner_id = r.owner_id AND c.provider = 'sec'
        AND c.native_id = r.native_id AND c.sha256 = r.capture_sha256
      WHERE r.owner_id = ? AND r.scope = ? AND r.cik = ?
      LIMIT 1
    `).bind(this.ownerId, scope, cik).first(SecDiscoveryReplayRowSchema);
    if (row === null) return null;
    if (row.object_key === null || row.owner_id === null || row.provider === null || row.native_id === null
      || row.sha256 === null || row.source_url === null || row.content_type === null
      || row.byte_length === null || row.observed_at === null || row.adapter_version === null) {
      throw new Error("SEC discovery replay points to missing capture metadata.");
    }
    const issuer = SecQueueIssuerSchema.parse(JSON.parse(row.issuer_json));
    if (issuer.cik !== cik || row.native_id !== `submissions:${cik}` || !/^[a-f0-9]{64}$/.test(row.sha256)) {
      throw new Error("SEC discovery replay identity does not match its issuer.");
    }
    return {
      issuer,
      capture: {
        ownerId: row.owner_id,
        provider: row.provider,
        nativeId: row.native_id,
        sha256: row.sha256,
        objectKey: row.object_key,
        sourceUrl: row.source_url,
        contentType: row.content_type,
        byteLength: row.byte_length,
        observedAt: InstantTextSchema.parse(row.observed_at),
        adapterVersion: row.adapter_version,
      },
    };
  }

  public async beginSecDiscoveryReplay(
    scope: SecQueueScope,
    issuerValue: SecQueueIssuer,
    capture: CaptureRecord,
    lockToken: string,
  ): Promise<void> {
    const issuer = SecQueueIssuerSchema.parse(issuerValue);
    if (capture.ownerId !== this.ownerId || capture.provider !== "sec" || capture.nativeId !== `submissions:${issuer.cik}`
      || !/^[a-f0-9]{64}$/.test(capture.sha256)) {
      throw new Error("SEC discovery replay capture failed owner, source, or issuer validation.");
    }
    const checkedAt = new Date().toISOString();
    const leaseExpiresAt = new Date(Date.parse(checkedAt) + 5 * 60 * 1000).toISOString();
    const results = await this.env.DB.batch([
      this.env.DB.prepare(`
        UPDATE refresh_locks SET expires_at = ?
        WHERE owner_id = ? AND token = ? AND expires_at > ?
      `).bind(leaseExpiresAt, this.ownerId, lockToken, checkedAt),
      this.env.DB.prepare(`
        INSERT INTO source_captures (
          owner_id, provider, native_id, sha256, object_key, source_url, content_type,
          byte_length, observed_at, adapter_version
        ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM refresh_locks WHERE owner_id = ? AND token = ? AND expires_at = ?)
        ON CONFLICT(owner_id, provider, native_id, sha256) DO NOTHING
      `).bind(this.ownerId, capture.provider, capture.nativeId, capture.sha256, capture.objectKey,
        capture.sourceUrl, capture.contentType, capture.byteLength, capture.observedAt, capture.adapterVersion,
        this.ownerId, lockToken, leaseExpiresAt),
      this.env.DB.prepare(`
        INSERT INTO sec_discovery_replays (owner_id, scope, cik, native_id, capture_sha256, issuer_json, created_at)
        SELECT ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM refresh_locks WHERE owner_id = ? AND token = ? AND expires_at = ?)
        ON CONFLICT(owner_id, scope, cik) DO NOTHING
      `).bind(this.ownerId, scope, issuer.cik, capture.nativeId, capture.sha256, JSON.stringify(issuer), capture.observedAt,
        this.ownerId, lockToken, leaseExpiresAt),
    ]);
    if (results[0]?.rowsAffected !== 1) throw new Error("Refresh ownership expired before SEC discovery replay was recorded.");
    if (results[2]?.rowsAffected !== 1) throw new Error("A prior SEC discovery replay already exists for this issuer; it was preserved.");
  }

  public async discardSecDiscoveryReplay(scope: SecQueueScope, cik: string, captureSha256: string, lockToken: string): Promise<void> {
    const checkedAt = new Date().toISOString();
    const leaseExpiresAt = new Date(Date.parse(checkedAt) + 5 * 60 * 1000).toISOString();
    const results = await this.env.DB.batch([
      this.env.DB.prepare(`
        UPDATE refresh_locks SET expires_at = ?
        WHERE owner_id = ? AND token = ? AND expires_at > ?
      `).bind(leaseExpiresAt, this.ownerId, lockToken, checkedAt),
      this.env.DB.prepare(`
        DELETE FROM sec_discovery_replays
        WHERE owner_id = ? AND scope = ? AND cik = ? AND capture_sha256 = ?
          AND EXISTS (SELECT 1 FROM refresh_locks WHERE owner_id = ? AND token = ? AND expires_at = ?)
      `).bind(this.ownerId, scope, cik, captureSha256, this.ownerId, lockToken, leaseExpiresAt),
    ]);
    if (results[0]?.rowsAffected !== 1) throw new Error("Refresh ownership expired before invalid SEC discovery replay was cleared.");
  }

  private async completeSecDiscoveryReplay(scope: SecQueueScope, cik: string, captureSha256: string, lockToken: string): Promise<void> {
    const checkedAt = new Date().toISOString();
    const leaseExpiresAt = new Date(Date.parse(checkedAt) + 5 * 60 * 1000).toISOString();
    const results = await this.env.DB.batch([
      this.env.DB.prepare(`
        UPDATE refresh_locks SET expires_at = ?
        WHERE owner_id = ? AND token = ? AND expires_at > ?
      `).bind(leaseExpiresAt, this.ownerId, lockToken, checkedAt),
      this.env.DB.prepare(`
        DELETE FROM sec_discovery_replays
        WHERE owner_id = ? AND scope = ? AND cik = ? AND capture_sha256 = ?
          AND EXISTS (SELECT 1 FROM refresh_locks WHERE owner_id = ? AND token = ? AND expires_at = ?)
      `).bind(this.ownerId, scope, cik, captureSha256, this.ownerId, lockToken, leaseExpiresAt),
    ]);
    if (results[0]?.rowsAffected !== 1) throw new Error("Refresh ownership expired before the empty SEC discovery replay was cleared.");
    if (results[1]?.rowsAffected !== 1) throw new Error("The exact empty SEC discovery replay could not be cleared.");
  }

  public async getDueSecIssuerRetries(scope: SecQueueScope, now: string, limit: number): Promise<SecIssuerRetry[]> {
    const result = scope === "watchlist"
      ? await this.env.DB.prepare(`
          SELECT r.cik, r.issuer_json, r.attempt_count, r.next_attempt_at, r.last_error
          FROM sec_issuer_retries r
          WHERE r.owner_id = ? AND r.scope = ? AND r.next_attempt_at <= ?
            AND EXISTS (SELECT 1 FROM watchlist w WHERE w.owner_id = r.owner_id AND w.cik = r.cik)
          ORDER BY r.next_attempt_at, r.cik LIMIT ?
        `).bind(this.ownerId, scope, now, limit).all(SecIssuerRetryRowSchema)
      : await this.env.DB.prepare(`
          SELECT cik, issuer_json, attempt_count, next_attempt_at, last_error
          FROM sec_issuer_retries
          WHERE owner_id = ? AND scope = ? AND next_attempt_at <= ?
          ORDER BY next_attempt_at, cik LIMIT ?
        `).bind(this.ownerId, scope, now, limit).all(SecIssuerRetryRowSchema);
    return result.map((row) => ({
      scope,
      cik: row.cik,
      issuer: SecQueueIssuerSchema.parse(JSON.parse(row.issuer_json)),
      attemptCount: row.attempt_count,
      nextAttemptAt: InstantTextSchema.parse(row.next_attempt_at),
      lastError: row.last_error,
    }));
  }

  public async getSecIssuerRetryCiks(scope: SecQueueScope): Promise<string[]> {
    const result = scope === "watchlist"
      ? await this.env.DB.prepare(`
          SELECT r.cik FROM sec_issuer_retries r
          WHERE r.owner_id = ? AND r.scope = ?
            AND EXISTS (SELECT 1 FROM watchlist w WHERE w.owner_id = r.owner_id AND w.cik = r.cik)
          ORDER BY r.next_attempt_at, r.cik
        `).bind(this.ownerId, scope).all(CikRowSchema)
      : await this.env.DB.prepare(`
          SELECT cik FROM sec_issuer_retries WHERE owner_id = ? AND scope = ?
          ORDER BY next_attempt_at, cik
        `).bind(this.ownerId, scope).all(CikRowSchema);
    return result.map((row) => row.cik);
  }

  public async recordSecIssuerFailure(
    scope: SecQueueScope,
    issuerValue: SecQueueIssuer,
    error: string,
    lockToken: string,
    now: string,
  ): Promise<void> {
    const issuer = SecQueueIssuerSchema.parse(issuerValue);
    const existing = await this.env.DB.prepare(`
      SELECT attempt_count FROM sec_issuer_retries WHERE owner_id = ? AND scope = ? AND cik = ? LIMIT 1
    `).bind(this.ownerId, scope, issuer.cik).first(AttemptRowSchema);
    const attempts = (existing?.attempt_count ?? 0) + 1;
    const delay = [60_000, 5 * 60_000, 30 * 60_000, 6 * 60 * 60_000][Math.min(attempts - 1, 3)] ?? 6 * 60 * 60_000;
    const nextAttemptAt = new Date(Date.parse(now) + delay).toISOString();
    const checkedAt = new Date().toISOString();
    const leaseExpiresAt = new Date(Date.parse(checkedAt) + 5 * 60 * 1000).toISOString();
    const results = await this.env.DB.batch([
      this.env.DB.prepare(`
        UPDATE refresh_locks SET expires_at = ?
        WHERE owner_id = ? AND token = ? AND expires_at > ?
      `).bind(leaseExpiresAt, this.ownerId, lockToken, checkedAt),
      this.env.DB.prepare(`
        INSERT INTO sec_issuer_retries (owner_id, scope, cik, issuer_json, attempt_count, next_attempt_at, last_error, updated_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM refresh_locks WHERE owner_id = ? AND token = ? AND expires_at = ?)
        ON CONFLICT(owner_id, scope, cik) DO UPDATE SET
          issuer_json = excluded.issuer_json,
          attempt_count = excluded.attempt_count,
          next_attempt_at = excluded.next_attempt_at,
          last_error = excluded.last_error,
          updated_at = excluded.updated_at
      `).bind(
        this.ownerId,
        scope,
        issuer.cik,
        JSON.stringify(issuer),
        attempts,
        nextAttemptAt,
        error.slice(0, 300),
        now,
        this.ownerId,
        lockToken,
        leaseExpiresAt,
      ),
    ]);
    if (results[0]?.rowsAffected !== 1) throw new Error("Refresh ownership expired before the SEC issuer retry was persisted.");
  }

  public async getDueSecFilings(
    scope: SecQueueScope,
    contractDigest: string,
    now: string,
    limit: number,
    perIssuerLimit: number,
    lockToken: string,
  ): Promise<SecFilingWork[]> {
    const checkedAt = new Date().toISOString();
    const leaseExpiresAt = new Date(Date.parse(checkedAt) + 5 * 60 * 1000).toISOString();
    const requeue = await this.env.DB.batch([
      this.env.DB.prepare(`
        UPDATE refresh_locks SET expires_at = ?
        WHERE owner_id = ? AND token = ? AND expires_at > ?
      `).bind(leaseExpiresAt, this.ownerId, lockToken, checkedAt),
      this.env.DB.prepare(`
        UPDATE sec_filing_queue SET contract_digest = ?, attempt_count = 0,
          next_attempt_at = ?, last_error = NULL, updated_at = ?
        WHERE owner_id = ? AND contract_digest <> ?
          AND EXISTS (SELECT 1 FROM refresh_locks WHERE owner_id = ? AND token = ? AND expires_at = ?)
      `).bind(contractDigest, now, now, this.ownerId, contractDigest, this.ownerId, lockToken, leaseExpiresAt),
    ]);
    if (requeue[0]?.rowsAffected !== 1) throw new Error("Refresh ownership expired before SEC backlog selection.");

    const scopePredicate = scope === "public" ? "q.public_discovered = 1" : "w.cik IS NOT NULL";
    const watchlistJoin = scope === "watchlist" ? "JOIN watchlist w ON w.owner_id = q.owner_id AND w.cik = q.cik" : "";
    const rows = await this.env.DB.prepare(`
      WITH due AS (
        SELECT q.*,
          CASE WHEN EXISTS (
            SELECT 1 FROM screening_runs_v2 s
            WHERE s.owner_id = q.owner_id AND s.source_provider = 'sec' AND s.native_id = q.native_id
              AND s.source_version_digest = q.source_version_digest AND s.contract_digest = q.contract_digest
              AND s.capture_kind = 'full_text'
          ) THEN 1 ELSE 0 END AS revalidation_rank,
          ROW_NUMBER() OVER (PARTITION BY q.cik ORDER BY
            CASE WHEN EXISTS (
              SELECT 1 FROM screening_runs_v2 s
              WHERE s.owner_id = q.owner_id AND s.source_provider = 'sec' AND s.native_id = q.native_id
                AND s.source_version_digest = q.source_version_digest AND s.contract_digest = q.contract_digest
                AND s.capture_kind = 'full_text'
            ) THEN 1 ELSE 0 END,
            q.filed_at, q.native_id) AS issuer_rank
        FROM sec_filing_queue q ${watchlistJoin}
        WHERE q.owner_id = ? AND q.next_attempt_at <= ? AND ${scopePredicate}
      )
      SELECT native_id, cik, accession, issuer_json, form, primary_document, primary_description,
        filed_at, available_at, available_precision, source_version_digest, contract_digest,
        attempt_count, next_attempt_at
      FROM due WHERE issuer_rank <= ?
      ORDER BY revalidation_rank, filed_at, cik, native_id LIMIT ?
    `).bind(this.ownerId, now, perIssuerLimit, limit).all(SecFilingQueueRowSchema);
    return rows.map((row) => parseSecFilingQueueRow(row));
  }

  public async acquireRefreshLock(token: string, now: string): Promise<boolean> {
    const expiresAt = new Date(Date.parse(now) + 5 * 60 * 1000).toISOString();
    const row = await this.env.DB.prepare(`
      INSERT INTO refresh_locks (owner_id, token, expires_at) VALUES (?, ?, ?)
      ON CONFLICT(owner_id) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at
      WHERE refresh_locks.expires_at <= ?
      RETURNING token
    `).bind(this.ownerId, token, expiresAt, now).first(TokenRowSchema);
    return row?.token === token;
  }

  public async releaseRefreshLock(token: string): Promise<void> {
    await this.env.DB.prepare("DELETE FROM refresh_locks WHERE owner_id = ? AND token = ?").bind(this.ownerId, token).run();
  }

  public async renewRefreshLock(token: string, now: string): Promise<boolean> {
    const expiresAt = new Date(Date.parse(now) + 5 * 60 * 1000).toISOString();
    const result = await this.env.DB.prepare(`
      UPDATE refresh_locks SET expires_at = ?
      WHERE owner_id = ? AND token = ? AND expires_at > ?
    `).bind(expiresAt, this.ownerId, token, now).run();
    return result.rowsAffected === 1;
  }

  public async recordRefreshAttempt(at: string): Promise<void> {
    await this.env.DB.prepare(`
      INSERT INTO meta (owner_id, key, value, version, updated_at) VALUES (?, 'lastRefreshAttemptAt', ?, 1, ?)
      ON CONFLICT(owner_id, key) DO UPDATE SET
        value = excluded.value, version = meta.version + 1, updated_at = excluded.updated_at
    `).bind(this.ownerId, at, at).run();
  }

  public async addWatchlist(issuer: Issuer, now: string): Promise<void> {
    await this.env.DB.batch([
      this.env.DB.prepare(`
      INSERT INTO watchlist (owner_id, cik, issuer_json, added_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(owner_id, cik) DO UPDATE SET issuer_json = excluded.issuer_json
      `).bind(this.ownerId, issuer.cik.value, JSON.stringify(issuer), now),
      this.env.DB.prepare(`
        INSERT INTO meta (owner_id, key, value, version, updated_at) VALUES (?, 'eventCatalogRevision', '1', 1, ?)
        ON CONFLICT(owner_id, key) DO UPDATE SET value = CAST(meta.version + 1 AS TEXT), version = meta.version + 1, updated_at = excluded.updated_at
      `).bind(this.ownerId, now),
    ]);
  }

  public async removeWatchlist(issuer: Issuer): Promise<void> {
    const now = new Date().toISOString();
    await this.env.DB.batch([
      this.env.DB.prepare("DELETE FROM watchlist WHERE owner_id = ? AND cik = ?").bind(this.ownerId, issuer.cik.value),
      this.env.DB.prepare(`
        INSERT INTO meta (owner_id, key, value, version, updated_at) VALUES (?, 'eventCatalogRevision', '1', 1, ?)
        ON CONFLICT(owner_id, key) DO UPDATE SET value = CAST(meta.version + 1 AS TEXT), version = meta.version + 1, updated_at = excluded.updated_at
      `).bind(this.ownerId, now),
    ]);
  }

  public async updateReview(eventId: string, update: ReviewUpdate, now: string): Promise<boolean> {
    const reviewUpdatedAt = nextReviewUpdatedAt(InstantTextSchema.parse(now), update.expectedReview);
    const result = await this.env.DB.prepare(`
      UPDATE events SET review_status = ?, review_note = ?, review_updated_at = ?, updated_at = ?
      WHERE owner_id = ? AND id = ?
        AND (? = 'true' OR provider <> 'finnhub_news')
        AND review_status = ? AND review_note = ? AND review_updated_at IS ?
    `).bind(
      update.status,
      update.note,
      reviewUpdatedAt,
      now,
      this.ownerId,
      eventId,
      this.env.FINNHUB_PROCESSING_APPROVED === "true" ? "true" : "false",
      update.expectedReview.status,
      update.expectedReview.note,
      update.expectedReview.updatedAt,
    ).run();
    return result.rowsAffected === 1;
  }

  public async getEvent(eventId: string, now = new Date()): Promise<Event | null> {
    const row = await this.env.DB.prepare(`
      SELECT event_json, review_status, review_note, review_updated_at FROM events
      WHERE owner_id = ? AND id = ? AND (? = 'true' OR provider <> 'finnhub_news')
    `).bind(this.ownerId, eventId, this.env.FINNHUB_PROCESSING_APPROVED === "true" ? "true" : "false")
      .first(EventSnapshotRowSchema);
    if (row === null) return null;
    const event = EventSchema.parse(JSON.parse(row.event_json));
    return EventSchema.parse({
      ...event,
      source: { ...event.source, freshness: freshnessAt(event.source.freshness, event.source.observedAt, now) },
      review: { status: row.review_status, note: row.review_note, updatedAt: row.review_updated_at },
    });
  }

  public async recordRefresh(write: RefreshWrite, lockToken: string): Promise<void> {
    const statements: SqlStatement[] = [];
    const checkedAt = new Date().toISOString();
    const leaseExpiresAt = new Date(Date.parse(checkedAt) + 5 * 60 * 1000).toISOString();
    statements.push(this.env.DB.prepare(`
      UPDATE refresh_locks SET expires_at = ?
      WHERE owner_id = ? AND token = ? AND expires_at > ?
    `).bind(leaseExpiresAt, this.ownerId, lockToken, checkedAt));

    for (const eventValue of write.events) {
      const event = EventSchema.parse(eventValue);
      if (new TextEncoder().encode(JSON.stringify(event)).byteLength > MAX_EVENT_JSON_BYTES) {
        throw new Error("A screened event exceeded the 96 KiB storage contract; the refresh batch was not committed.");
      }
      statements.push(this.env.DB.prepare(`
        INSERT INTO events (
          owner_id, id, provider, native_id, event_json, observed_at, review_status, review_note,
          review_updated_at, created_at, updated_at
        ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM refresh_locks WHERE owner_id = ? AND token = ? AND expires_at = ?)
        ON CONFLICT(owner_id, provider, native_id) DO UPDATE SET
          id = excluded.id, event_json = excluded.event_json, observed_at = excluded.observed_at,
          updated_at = excluded.updated_at
        WHERE excluded.observed_at > events.observed_at
      `).bind(
        this.ownerId,
        event.id,
        event.source.provider,
        event.source.nativeId,
        JSON.stringify(event),
        event.source.observedAt,
        event.review.status,
        event.review.note,
        event.review.updatedAt,
        write.refreshedAt,
        write.refreshedAt,
        this.ownerId,
        lockToken,
        leaseExpiresAt,
      ));
    }
    for (const capture of write.captures) {
      statements.push(this.env.DB.prepare(`
        INSERT INTO source_captures (
          owner_id, provider, native_id, sha256, object_key, source_url, content_type,
          byte_length, observed_at, adapter_version
        ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM refresh_locks WHERE owner_id = ? AND token = ? AND expires_at = ?)
        ON CONFLICT(owner_id, provider, native_id, sha256) DO NOTHING
      `).bind(
        this.ownerId,
        capture.provider,
        capture.nativeId,
        capture.sha256,
        capture.objectKey,
        capture.sourceUrl,
        capture.contentType,
        capture.byteLength,
        capture.observedAt,
        capture.adapterVersion,
        this.ownerId,
        lockToken,
        leaseExpiresAt,
      ));
    }
    for (const screening of write.screenings) {
      statements.push(this.env.DB.prepare(`
        INSERT INTO screening_runs_v2 (
          owner_id, source_provider, native_id, source_digest, source_version_digest,
          contract_digest, evidence_complete, capture_kind, status, result_digest,
          prompt_digest, model, screened_at, last_validated_at
        ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM refresh_locks WHERE owner_id = ? AND token = ? AND expires_at = ?)
        ON CONFLICT(owner_id, source_provider, native_id, source_digest, source_version_digest, contract_digest) DO UPDATE SET
          status = excluded.status, result_digest = excluded.result_digest,
          prompt_digest = excluded.prompt_digest, model = excluded.model,
          evidence_complete = excluded.evidence_complete, capture_kind = excluded.capture_kind,
          screened_at = excluded.screened_at, last_validated_at = excluded.last_validated_at
      `).bind(
        this.ownerId,
        screening.provider,
        screening.nativeId,
        screening.sourceDigest,
        screening.sourceVersionDigest,
        screening.contractDigest,
        screening.evidenceComplete ? 1 : 0,
        screening.captureKind,
        screening.status,
        screening.resultDigest,
        screening.promptDigest,
        screening.model,
        screening.screenedAt,
        screening.lastValidatedAt,
        this.ownerId,
        lockToken,
        leaseExpiresAt,
      ));
    }
    for (const touch of write.secObservationTouches ?? []) {
      statements.push(this.env.DB.prepare(`
        UPDATE events SET
          event_json = json_set(event_json, '$.source.observedAt', ?, '$.source.deliveryState', 'network', '$.source.freshness', 'live'),
          observed_at = ?, updated_at = ?
        WHERE owner_id = ? AND provider = 'sec' AND native_id = ? AND observed_at < ?
          AND json_extract(event_json, '$.source.digest') = ?
          AND EXISTS (SELECT 1 FROM refresh_locks WHERE owner_id = ? AND token = ? AND expires_at = ?)
      `).bind(touch.observedAt, touch.observedAt, touch.observedAt, this.ownerId, touch.nativeId,
        touch.observedAt, touch.sourceDigest, this.ownerId, lockToken, leaseExpiresAt));
    }
    if (write.events.length > 0 || (write.secObservationTouches?.length ?? 0) > 0) {
      statements.push(this.env.DB.prepare(`
        INSERT INTO meta (owner_id, key, value, version, updated_at)
        SELECT ?, 'eventCatalogRevision', '1', 1, ?
        WHERE EXISTS (SELECT 1 FROM refresh_locks WHERE owner_id = ? AND token = ? AND expires_at = ?)
        ON CONFLICT(owner_id, key) DO UPDATE SET
          value = CAST(meta.version + 1 AS TEXT), version = meta.version + 1, updated_at = excluded.updated_at
      `).bind(this.ownerId, write.refreshedAt, this.ownerId, lockToken, leaseExpiresAt));
    }
    for (const touch of write.secScreeningTouches ?? []) {
      statements.push(this.env.DB.prepare(`
        UPDATE screening_runs_v2 SET last_validated_at = ?
        WHERE owner_id = ? AND source_provider = 'sec' AND native_id = ? AND source_digest = ?
          AND source_version_digest = ? AND contract_digest = ?
          AND EXISTS (SELECT 1 FROM refresh_locks WHERE owner_id = ? AND token = ? AND expires_at = ?)
      `).bind(touch.validatedAt, this.ownerId, touch.nativeId, touch.sourceDigest, touch.sourceVersionDigest,
        touch.contractDigest, this.ownerId, lockToken, leaseExpiresAt));
    }
    for (const transition of write.secQueueTransitions ?? []) {
      if (transition.outcome === "complete") {
        statements.push(this.env.DB.prepare(`
          DELETE FROM sec_filing_queue
          WHERE owner_id = ? AND native_id = ? AND source_version_digest = ? AND contract_digest = ?
            AND EXISTS (SELECT 1 FROM refresh_locks WHERE owner_id = ? AND token = ? AND expires_at = ?)
        `).bind(this.ownerId, transition.nativeId, transition.sourceVersionDigest, transition.contractDigest,
          this.ownerId, lockToken, leaseExpiresAt));
      } else {
        const nextAttemptAt = InstantTextSchema.parse(transition.nextAttemptAt);
        const lastError = (transition.lastError ?? "SEC filing processing failed.").slice(0, 300);
        statements.push(this.env.DB.prepare(`
          UPDATE sec_filing_queue SET attempt_count = attempt_count + 1, next_attempt_at = ?,
            last_error = ?, updated_at = ?
          WHERE owner_id = ? AND native_id = ? AND source_version_digest = ? AND contract_digest = ?
            AND EXISTS (SELECT 1 FROM refresh_locks WHERE owner_id = ? AND token = ? AND expires_at = ?)
        `).bind(nextAttemptAt, lastError, write.refreshedAt, this.ownerId, transition.nativeId,
          transition.sourceVersionDigest, transition.contractDigest, this.ownerId, lockToken, leaseExpiresAt));
      }
    }
    for (const retry of write.secIssuerRetriesCleared ?? []) {
      statements.push(this.env.DB.prepare(`
        DELETE FROM sec_issuer_retries WHERE owner_id = ? AND scope = ? AND cik = ?
          AND EXISTS (SELECT 1 FROM refresh_locks WHERE owner_id = ? AND token = ? AND expires_at = ?)
      `).bind(this.ownerId, retry.scope, retry.cik, this.ownerId, lockToken, leaseExpiresAt));
    }
    for (const healthValue of write.health) {
      const health = SourceHealthSchema.parse(healthValue);
      statements.push(this.env.DB.prepare(`
        INSERT INTO source_health (owner_id, provider, status, freshness, message, checked_at)
        SELECT ?, ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM refresh_locks WHERE owner_id = ? AND token = ? AND expires_at = ?)
        ON CONFLICT(owner_id, provider) DO UPDATE SET
          status = excluded.status, freshness = excluded.freshness,
          message = excluded.message, checked_at = excluded.checked_at
      `).bind(this.ownerId, health.provider, health.status, health.freshness, health.message, health.checkedAt, this.ownerId, lockToken, leaseExpiresAt));
    }
    for (const item of write.meta) {
      statements.push(this.env.DB.prepare(`
        INSERT INTO meta (owner_id, key, value, version, updated_at)
        SELECT ?, ?, ?, 1, ?
        WHERE EXISTS (SELECT 1 FROM refresh_locks WHERE owner_id = ? AND token = ? AND expires_at = ?)
        ON CONFLICT(owner_id, key) DO UPDATE SET
          value = excluded.value, version = meta.version + 1, updated_at = excluded.updated_at
      `).bind(this.ownerId, item.key, item.value, write.refreshedAt, this.ownerId, lockToken, leaseExpiresAt));
    }
    statements.push(this.env.DB.prepare(`
      INSERT INTO meta (owner_id, key, value, version, updated_at)
      SELECT ?, 'lastRefreshAt', ?, 1, ?
      WHERE EXISTS (SELECT 1 FROM refresh_locks WHERE owner_id = ? AND token = ? AND expires_at = ?)
      ON CONFLICT(owner_id, key) DO UPDATE SET
        value = excluded.value, version = meta.version + 1, updated_at = excluded.updated_at
    `).bind(this.ownerId, write.refreshedAt, write.refreshedAt, this.ownerId, lockToken, leaseExpiresAt));

    if (statements.length > 90) throw new Error("Refresh result exceeded the bounded atomic write limit; no cursor was advanced.");
    const results = await this.env.DB.batch(statements);
    if (results[0]?.rowsAffected !== 1) throw new Error("Refresh ownership expired before the result commit; no refresh writes were accepted.");
  }

  public async getSnapshot(now = new Date(), scope: EventScope = "all"): Promise<AppSnapshot> {
    const openingRevision = await this.getEventRevision();
    const [page, watchRows, healthRows, coverageText, lastRefreshAt] = await Promise.all([
      this.readEventPage(scope, null, now),
      this.env.DB.prepare("SELECT issuer_json, added_at FROM watchlist WHERE owner_id = ? ORDER BY added_at, cik")
        .bind(this.ownerId).all(WatchlistRowSchema),
      this.env.DB.prepare("SELECT provider, status, freshness, message, checked_at FROM source_health WHERE owner_id = ? ORDER BY provider")
        .bind(this.ownerId).all(HealthRowSchema),
      this.getMeta("publicIssuerCoverage"),
      this.getMeta("lastRefreshAt"),
    ]);

    const watch = watchRows.map((row) => WatchlistEntrySchema.parse({ issuer: JSON.parse(row.issuer_json), addedAt: row.added_at }));
    const health = healthRows
      .filter((row) => this.env.FINNHUB_PROCESSING_APPROVED === "true" || row.provider !== "finnhub_news")
      .map((row) => SourceHealthSchema.parse({
      provider: row.provider,
      status: row.status,
      freshness: freshnessAt(row.freshness, row.checked_at, now),
      message: row.message,
      checkedAt: row.checked_at,
    }));
    if (this.env.FINNHUB_PROCESSING_APPROVED !== "true") {
      health.push(SourceHealthSchema.parse({
        provider: "finnhub_news",
        status: "offline",
        freshness: "unavailable",
        message: "Not requested: written approval for third-party TypeSafe processing has not been confirmed.",
        checkedAt: now.toISOString(),
      }));
    }

    const publicIssuerCoverage = coverageText === null ? null : PublicIssuerCoverageSchema.parse(JSON.parse(coverageText));
    if (openingRevision !== page.eventsRevision || await this.getEventRevision() !== openingRevision) {
      throw new EventPageError(409, "The wire changed while the desk was opening. Reload to view one consistent ranking.");
    }
    return AppSnapshotSchema.parse({
      schemaVersion: 2,
      ...page,
      eventsScope: scope,
      watchlist: watch,
      companyCoverage: null,
      publicIssuerCoverage,
      sourceHealth: health,
      lastRefreshAt: lastRefreshAt === null ? null : InstantTextSchema.parse(lastRefreshAt),
    });
  }

  public async getEventPage(encodedCursor: string, now = new Date()): Promise<EventPage> {
    let decoded: EventCursor;
    try {
      decoded = EventCursorSchema.parse(JSON.parse(decodeURIComponent(encodedCursor)));
    } catch {
      throw new EventPageError(400, "The records cursor is invalid. Reload the wire to start a new traversal.");
    }
    const revision = await this.getEventRevision();
    if (decoded.revision !== revision) {
      throw new EventPageError(409, "The wire changed while older records were loading. Reload the records list and continue from the updated ranking.");
    }
    return this.readEventPage(decoded.scope, decoded, now);
  }

  private async readEventPage(scope: EventScope, cursor: EventCursor | null, now: Date): Promise<EventPage> {
    const revision = await this.getEventRevision();
    if (cursor !== null && cursor.revision !== revision) {
      throw new EventPageError(409, "The wire changed while older records were loading. Reload the records list and continue from the updated ranking.");
    }
    const sourceScope = scope === "federal"
      ? "e.provider = 'federal_register'"
      : scope === "all_public"
        ? "e.provider = 'sec'"
        : scope === "watchlist"
          ? "e.provider = 'sec' AND EXISTS (SELECT 1 FROM watchlist w WHERE w.owner_id = e.owner_id AND w.cik = json_extract(e.event_json, '$.subject.cik.value'))"
          : "1 = 1";
    const providerScope = this.env.FINNHUB_PROCESSING_APPROVED === "true" ? "" : " AND e.provider <> 'finnhub_news'";
    const where = `e.owner_id = ? AND (${sourceScope})${providerScope}`;
    const score = "CAST(json_extract(e.event_json, '$.screening.attentionScore') AS INTEGER)";
    const available = "julianday(json_extract(e.event_json, '$.availableAt'))";
    const cursorWhere = cursor === null ? "" : ` AND (
      ${score} < ? OR (${score} = ? AND ${available} < julianday(?))
      OR (${score} = ? AND ${available} = julianday(?) AND e.id COLLATE BINARY > ? COLLATE BINARY)
    )`;
    const bindScope: Array<string | number> = [this.ownerId];
    const count = await this.env.DB.prepare(`SELECT COUNT(*) AS count FROM events e WHERE ${where}`)
      .bind(...bindScope).first(CountRowSchema);
    const bindRows: Array<string | number> = [...bindScope];
    if (cursor !== null) bindRows.push(cursor.attentionScore, cursor.attentionScore, cursor.availableAt, cursor.attentionScore, cursor.availableAt, cursor.id);
    bindRows.push(EVENTS_PAGE_SIZE + 1);
    const rows = await this.env.DB.prepare(`
      SELECT e.id, e.event_json, e.review_status, e.review_note, e.review_updated_at,
        ${score} AS attention_score, json_extract(e.event_json, '$.availableAt') AS available_at
      FROM events e WHERE ${where}${cursorWhere}
      ORDER BY ${score} DESC, ${available} DESC, e.id COLLATE BINARY ASC
      LIMIT ?
    `).bind(...bindRows).all(EventSnapshotRowSchema.extend({
      id: z.string(),
      attention_score: z.number().int().min(0).max(100),
      available_at: InstantTextSchema,
    }));
    const events = rows.slice(0, EVENTS_PAGE_SIZE).map((row) => {
      if (new TextEncoder().encode(row.event_json).byteLength > MAX_EVENT_JSON_BYTES) {
        throw new EventPageError(422, `Stored record ${row.id} exceeds the supported 96 KiB event limit and was withheld. No page was partially returned; this record needs operator repair before it can be reviewed.`);
      }
      const event = EventSchema.parse(JSON.parse(row.event_json));
      return EventSchema.parse({
        ...event,
        source: { ...event.source, freshness: freshnessAt(event.source.freshness, event.source.observedAt, now) },
        review: { status: row.review_status, note: row.review_note, updatedAt: row.review_updated_at },
      });
    });
    const hasMore = rows.length > EVENTS_PAGE_SIZE;
    const pageEvents = events;
    const lastEvent = pageEvents.at(-1);
    if (await this.getEventRevision() !== revision) {
      throw new EventPageError(409, "The wire changed while this page was loading. Reload the records list to avoid a gap.");
    }
    const eventsCursor = hasMore && lastEvent !== undefined
      ? encodeEventCursor({ version: 1, revision, scope, attentionScore: lastEvent.screening.attentionScore, availableAt: lastEvent.availableAt, id: lastEvent.id })
      : null;
    return EventPageSchema.parse({ events: pageEvents, eventsTotal: count?.count ?? 0, eventsRevision: revision, eventsCursor });
  }

  private async getEventRevision(): Promise<number> {
    const row = await this.env.DB.prepare("SELECT version AS revision FROM meta WHERE owner_id = ? AND key = 'eventCatalogRevision'")
      .bind(this.ownerId).first(RevisionRowSchema);
    return row?.revision ?? 0;
  }
}

const SecIssuerRetryRowSchema = z.object({
  cik: z.string(),
  issuer_json: z.string(),
  attempt_count: z.number().int().nonnegative(),
  next_attempt_at: z.string(),
  last_error: z.string(),
});
type SecIssuerRetryRow = z.infer<typeof SecIssuerRetryRowSchema>;

const SecDiscoveryReplayRowSchema = z.object({
  issuer_json: z.string(),
  owner_id: z.string().nullable(),
  provider: z.string().nullable(),
  native_id: z.string().nullable(),
  sha256: z.string().nullable(),
  object_key: z.string().nullable(),
  source_url: z.string().nullable(),
  content_type: z.string().nullable(),
  byte_length: z.number().int().nullable(),
  observed_at: z.string().nullable(),
  adapter_version: z.string().nullable(),
});
type SecDiscoveryReplayRow = z.infer<typeof SecDiscoveryReplayRowSchema>;

const SecFilingQueueRowSchema = z.object({
  native_id: z.string(),
  cik: z.string(),
  accession: z.string(),
  issuer_json: z.string(),
  form: z.string(),
  primary_document: z.string(),
  primary_description: z.string(),
  filed_at: z.string(),
  available_at: z.string(),
  available_precision: z.enum(["second", "day"]),
  source_version_digest: z.string(),
  contract_digest: z.string(),
  attempt_count: z.number().int().nonnegative(),
  next_attempt_at: z.string(),
});
type SecFilingQueueRow = z.infer<typeof SecFilingQueueRowSchema>;

function parseSecFilingQueueRow(row: SecFilingQueueRow): SecFilingWork {
  const issuer = SecQueueIssuerSchema.parse(JSON.parse(row.issuer_json));
  if (!/^[0-9]{10}$/.test(row.cik) || issuer.cik !== row.cik
    || !/^[0-9]{10}-[0-9]{2}-[0-9]{6}$/.test(row.accession)
    || row.native_id !== `SEC:${row.cik}:${row.accession}`
    || !/^[a-f0-9]{64}$/.test(row.source_version_digest)
    || !/^[a-f0-9]{64}$/.test(row.contract_digest)
    || !Number.isSafeInteger(row.attempt_count) || row.attempt_count < 0
    || !/^[A-Za-z0-9._-]+$/.test(row.primary_document)) {
    throw new Error("Stored SEC filing work failed domain validation.");
  }
  return {
    nativeId: row.native_id,
    cik: row.cik,
    accession: row.accession,
    issuer,
    form: row.form,
    primaryDocument: row.primary_document,
    primaryDescription: row.primary_description,
    filedAt: InstantTextSchema.parse(row.filed_at),
    availableAt: InstantTextSchema.parse(row.available_at),
    availablePrecision: row.available_precision,
    sourceVersionDigest: row.source_version_digest,
    contractDigest: row.contract_digest,
    attemptCount: row.attempt_count,
    nextAttemptAt: InstantTextSchema.parse(row.next_attempt_at),
  };
}

function freshnessAt(current: string, observedAt: string, now: Date): "live" | "cached" | "stale" | "unavailable" {
  if (current === "unavailable") return "unavailable";
  const observed = Date.parse(observedAt);
  const age = now.getTime() - observed;
  if (!Number.isFinite(observed) || age < -60_000) return "unavailable";
  if (age > STALE_AFTER_MS || current === "stale") return "stale";
  if (current === "cached") return "cached";
  return "live";
}

export async function upsertWatchlistAction(repository: InvestorRepository, issuer: Issuer, action: "add" | "remove", now: string): Promise<void> {
  if (action === "add") await repository.addWatchlist(issuer, now);
  else await repository.removeWatchlist(issuer);
}
