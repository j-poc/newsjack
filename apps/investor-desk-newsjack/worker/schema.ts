import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const events = sqliteTable("events", {
  ownerId: text("owner_id").notNull(),
  id: text("id").notNull(),
  provider: text("provider").notNull(),
  nativeId: text("native_id").notNull(),
  eventJson: text("event_json").notNull(),
  observedAt: text("observed_at").notNull(),
  reviewStatus: text("review_status").notNull().default("unreviewed"),
  reviewNote: text("review_note").notNull().default(""),
  reviewUpdatedAt: text("review_updated_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.ownerId, table.id] }),
  uniqueIndex("events_owner_provider_native_uq").on(table.ownerId, table.provider, table.nativeId),
  index("events_owner_available_idx").on(table.ownerId, table.observedAt),
]);

export const watchlist = sqliteTable("watchlist", {
  ownerId: text("owner_id").notNull(),
  cik: text("cik").notNull(),
  issuerJson: text("issuer_json").notNull(),
  addedAt: text("added_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.ownerId, table.cik] }),
  index("watchlist_owner_added_idx").on(table.ownerId, table.addedAt),
]);

export const sourceHealth = sqliteTable("source_health", {
  ownerId: text("owner_id").notNull(),
  provider: text("provider").notNull(),
  status: text("status").notNull(),
  freshness: text("freshness").notNull(),
  message: text("message").notNull(),
  checkedAt: text("checked_at").notNull(),
}, (table) => [primaryKey({ columns: [table.ownerId, table.provider] })]);

export const meta = sqliteTable("meta", {
  ownerId: text("owner_id").notNull(),
  key: text("key").notNull(),
  value: text("value").notNull(),
  version: integer("version").notNull().default(0),
  updatedAt: text("updated_at").notNull(),
}, (table) => [primaryKey({ columns: [table.ownerId, table.key] })]);

export const refreshLocks = sqliteTable("refresh_locks", {
  ownerId: text("owner_id").primaryKey(),
  token: text("token").notNull(),
  expiresAt: text("expires_at").notNull(),
});

export const sourceCaptures = sqliteTable("source_captures", {
  ownerId: text("owner_id").notNull(),
  provider: text("provider").notNull(),
  nativeId: text("native_id").notNull(),
  sha256: text("sha256").notNull(),
  objectKey: text("object_key").notNull(),
  sourceUrl: text("source_url").notNull(),
  contentType: text("content_type").notNull(),
  byteLength: integer("byte_length").notNull(),
  observedAt: text("observed_at").notNull(),
  adapterVersion: text("adapter_version").notNull(),
}, (table) => [
  primaryKey({ columns: [table.ownerId, table.provider, table.nativeId, table.sha256] }),
  index("captures_owner_observed_idx").on(table.ownerId, table.observedAt),
]);

export const screeningRuns = sqliteTable("screening_runs_v2", {
  ownerId: text("owner_id").notNull(),
  sourceProvider: text("source_provider").notNull(),
  nativeId: text("native_id").notNull(),
  sourceDigest: text("source_digest").notNull(),
  sourceVersionDigest: text("source_version_digest").notNull(),
  contractDigest: text("contract_digest").notNull(),
  evidenceComplete: integer("evidence_complete").notNull(),
  captureKind: text("capture_kind").notNull(),
  status: text("status").notNull(),
  resultDigest: text("result_digest").notNull(),
  promptDigest: text("prompt_digest").notNull(),
  model: text("model").notNull(),
  screenedAt: text("screened_at").notNull(),
  lastValidatedAt: text("last_validated_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.ownerId, table.sourceProvider, table.nativeId, table.sourceDigest, table.sourceVersionDigest, table.contractDigest] }),
  index("screening_owner_screened_idx").on(table.ownerId, table.screenedAt),
]);

export const secFilingQueue = sqliteTable("sec_filing_queue", {
  ownerId: text("owner_id").notNull(),
  nativeId: text("native_id").notNull(),
  cik: text("cik").notNull(),
  accession: text("accession").notNull(),
  issuerJson: text("issuer_json").notNull(),
  form: text("form").notNull(),
  primaryDocument: text("primary_document").notNull(),
  primaryDescription: text("primary_description").notNull(),
  filedAt: text("filed_at").notNull(),
  availableAt: text("available_at").notNull(),
  availablePrecision: text("available_precision").notNull(),
  sourceVersionDigest: text("source_version_digest").notNull(),
  contractDigest: text("contract_digest").notNull(),
  publicDiscovered: integer("public_discovered").notNull().default(0),
  attemptCount: integer("attempt_count").notNull().default(0),
  nextAttemptAt: text("next_attempt_at").notNull(),
  lastError: text("last_error"),
  discoveredAt: text("discovered_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.ownerId, table.nativeId] }),
  index("sec_queue_owner_public_due_idx").on(table.ownerId, table.publicDiscovered, table.nextAttemptAt, table.filedAt),
  index("sec_queue_owner_cik_due_idx").on(table.ownerId, table.cik, table.nextAttemptAt, table.filedAt),
]);

export const secIssuerRetries = sqliteTable("sec_issuer_retries", {
  ownerId: text("owner_id").notNull(),
  scope: text("scope").notNull(),
  cik: text("cik").notNull(),
  issuerJson: text("issuer_json").notNull(),
  attemptCount: integer("attempt_count").notNull().default(0),
  nextAttemptAt: text("next_attempt_at").notNull(),
  lastError: text("last_error").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.ownerId, table.scope, table.cik] }),
  index("sec_issuer_retry_due_idx").on(table.ownerId, table.scope, table.nextAttemptAt, table.cik),
]);

export const secDiscoveryReplays = sqliteTable("sec_discovery_replays", {
  ownerId: text("owner_id").notNull(),
  scope: text("scope").notNull(),
  cik: text("cik").notNull(),
  nativeId: text("native_id").notNull(),
  captureSha256: text("capture_sha256").notNull(),
  issuerJson: text("issuer_json").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.ownerId, table.scope, table.cik] }),
]);
