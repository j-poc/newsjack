# Discovery replay — grounded flow and constraints (2026-09-23)

## User outcome and failure to prevent

After a SEC issuer's `submissions` response has been captured and candidate
accessions selected, every selected obligation must survive worker interruption
or partial D1 chunk writes. Replays must not use a later wall-clock cutoff to
forget work that was eligible in the captured response. The public rotation must
not advance until each selected issuer's discovery obligations are durable.

## Current path

1. `worker/index.ts` validates the authenticated owner, acquires the owner
   refresh lock, calls `refreshLiveSources`, and commits its `RefreshResult` with
   a lock-token-fenced D1 batch.
2. `worker/providers.ts` selects due issuer retries, then a rotating bounded
   SEC-directory slice in `collectPublicSec` or current watchlist slice in
   `collectWatchlistSec`.
3. `collectSecIssuer` fetches one `data.sec.gov/submissions/CIK….json` response
   through `liveFetch`/`fetchCaptured`. The raw bytes are first retained in R2
   under a content-addressed owner-private key; a `CaptureRecord` carries that
   key and digest. Candidate accessions are parsed, seven-day-filtered by
   `chooseRecentFilings`, versioned, and checked against screening history.
4. `InvestorRepository.queueSecFilings` currently inserts the capture metadata
   with the first ≤88 filing rows. Each batch is fenced by renewal of the same
   five-minute owner lock. If a later chunk fails, prior queue rows remain and
   the caller holds the issuer cursor, but no durable pointer says how to
   reconstruct the not-yet-written rows.
5. A subsequent refresh fetches a new submissions response and applies a new
   seven-day cutoff. An eligible accession near the boundary can disappear
   before its queue row was persisted. This failure was demonstrated by Astra's
   code-path review; existing repository replay tests bypassed selection.
6. `processSecQueue` materializes due D1 rows into captured primary filing,
   TypeSafe screening, event, and queue-completion/retry writes. The current
   queue selects oldest filed rows first, so repeated stale revalidations can
   displace unscreened queue entries.

## Boundaries and invariants

- D1 is the durable owner/scope/CIK replay pointer and accession work queue;
  R2 is the private immutable raw SEC-response store. R2 bytes are verified by
  SHA-256 before parsing. No pointer may cross owner, provider, or CIK identity.
- SEC payload arrays are untrusted and must pass the existing submission schema
  before any obligations are derived.
- A replay uses the original capture's `observedAt` as its seven-day window and
  availability validation time. It is not silently treated as a fresh network
  observation or a later SEC publication.
- A replay pointer is removed only in the same D1 transaction as successful
  completion of the last accession chunk (or a validated empty reconciliation).
  Duplicate discovery preserves an accession's attempts and backoff when source
  and screening contract digests match.
- Outstanding issuer retry state, due or not yet due, excludes that CIK from
  fresh rotation; due retries take precedence and clear only after a complete
  submission parse and durable queue reconciliation.
- Currently watched CIK identity omits an absent exchange; it never invents an
  empty exchange value.
- Unscreened/version-changed/contract-changed accessions receive service ahead
  of repeat stale-screening validations, while the shared fetch budget and per-
  issuer cap remain authoritative.
- A failed D1 lock renewal is a Worker storage/ownership failure, never a
  TypeSafe network failure or a consumed filing retry.

## Candidate directions to compare

1. Keep the accession queue authoritative; add one owner/scope/CIK D1 replay
   pointer to the already-captured immutable R2 submissions response. Rehydrate
   and deterministically reconcile selected accessions on retry.
2. Replace queue materialization with an owner-scoped discovery manifest/staging
   model that makes a captured submission response plus its full accession set
   the authoritative work record, then have the consumer drain it directly.
   Evaluate additional state/indexes against removal of reconstruction logic.

Any design must also address the six non-replay findings above with minimal
surface area and targeted failure tests; no live source or release claim is
implied by local D1 verification.

## Selected implementation and comparison

Selected the existing D1/R2 capture-pointer approach. It adds no provider or
service: one owner/scope/CIK row retains the original captured response until
the final queue chunk commits. Replay verifies the retained bytes and uses the
pointer's original observation time. Malformed responses retain their capture
but release the pending pointer for a fresh bounded issuer retry.

Cloudflare's [D1 batch documentation](https://developers.cloudflare.com/d1/worker-api/d1-database/)
establishes transaction scope per batch, so multiple chunks need a durable
replay obligation. [R2's Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
supports the existing retained-object read path. The MIT-licensed
[sqliteq](https://github.com/minnzen/sqliteq) was inspected for SQLite queue
fencing/idempotency patterns; adopting a new queue dependency or Cloudflare
Queues is unnecessary for this narrow recovery gap. Source comparison does
not substitute for the application's own failure/replay tests.
