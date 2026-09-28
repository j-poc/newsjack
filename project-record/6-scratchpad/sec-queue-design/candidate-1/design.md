# Candidate 1: durable SEC discovery and screening queue

## Problem

The current Worker fetches an issuer submission response, filters the SEC recent
window to seven days, processes at most two accessions inline, and advances an
issuer rotation only through the final `recordRefresh` batch. That shape is
correct for a bounded live smoke but cannot prove that an accession already
seen by SEC survives an eight-day delay, a worker restart, a per-filing failure,
or a D1 write failure. The design must remain inside the existing
`worker/providers.ts` SEC transport, `worker/capture.ts` R2 capture,
`worker/typesafe.ts` screening, owner-scoped D1, and open-page refresh path.
SEC live access is currently 403, so this is a code-boundary design and test
plan, not evidence of live SEC availability. It intentionally does not add a
provider, scheduler, or exhibit crawler.

## Usage (caller's view)

The caller continues to ask for one bounded refresh. It does not know about
submissions, accessions, retry state, D1 rows, or TypeSafe attempts.

```ts
// worker/providers.ts: the existing source orchestrator becomes a thin adapter.
const sec = createSecQueue({ source: secEdgar, screening: typesafe, store: repository });
const result = await sec.refresh({ scope: "public", now: refreshedAt });
return mergeRefreshResult(result, federalResult);
```

```ts
// worker/index.ts: the existing POST /api/refresh route remains the boundary.
const result = await refreshLiveSources(env, readOwnerId(request), repository, parsed.data.source);
await repository.recordRefresh(result); // non-SEC sources remain on this path
return json(await repository.getSnapshot());
```

```ts
// src/App.tsx: the existing open-session and ten-minute refresh callers do not
// coordinate retries; the durable queue makes the same call resumable.
void runRefresh(scope); // initial open, scope change, and interval refresh
```

The watchlist form's existing `updateWatchlist("add", issuer)` followed by
`runRefresh("watchlist")` also uses the same interface. A public refresh and a
watchlist refresh select different issuer sets, but both drain the same
owner-scoped filing queue. A filing discovered by either scope is therefore
available to the other scope when its issuer matches the existing UI scope
filter; discovery coverage and presentation scope remain separate.

## Shape

### Public boundary

```ts
type SecRefreshScope =
  | { kind: "public" }
  | { kind: "watchlist" };

interface SecRefreshInput {
  scope: SecRefreshScope;
  now: string; // validated ISO instant supplied by the Worker boundary
}

interface SecRefreshResult {
  events: readonly Event[];
  captures: readonly CaptureRecord[];
  screenings: readonly ScreeningRunRecord[];
  health: SourceHealth;
  failures: readonly SecFailure[];
  queue: SecQueueTelemetry;
}

interface SecQueue {
  refresh(input: SecRefreshInput): Promise<SecRefreshResult>;
}

function createSecQueue(deps: SecQueueDeps): SecQueue;
```

`SecQueue` is the deep module. One method owns discovery, fair selection,
budget reservation, retry classification, queue transitions, and checkpoint
policy. The caller receives the current batch plus explicit queue health; it
does not assemble a sequence of `discover`, `fetch`, `screen`, and `save`
calls. The public surface is intentionally smaller than the existing internal
pipeline because it hides the retry and persistence protocol rather than
exposing its stages.

```ts
interface SecQueueDeps {
  source: SecSource;
  screening: SecScreening;
  store: SecQueueStore;
  config?: SecQueueConfig;
}

interface SecQueueConfig {
  maxIssuersPerRefresh: number;       // public: 8; combined caller may pass 3
  maxFilingsPerIssuer: number;        // 2; discovery is not capped by this
  maxSubrequests: 45;
  maxD1StatementsPerBatch: 90;
  typesafeAttemptsPerFiling: 2;       // initial call plus one retry
  retryScheduleMs: readonly number[]; // e.g. 1m, 5m, 30m, 6h, 24h
}
```

The configuration is constructed by the Worker, not supplied by the browser.
The only production values are the existing 45-request limit, a maximum of
two filings processed per issuer per refresh, and a maximum of 90 statements
per D1 batch. The combined SEC/Federal refresh allocates the existing smaller
issuer slice before construction; it does not permit the SEC queue to consume
Federal Register capacity.

### Domain types

```ts
type SecFailureClass = "transient" | "permanent" | "source_blocked" | "budget";
type SecWorkStatus = "pending" | "accepted" | "excluded" | "quarantined";
type SecIssuerStatus = "ready" | "backoff" | "quarantined";

interface SecIssuer {
  cik: string;        // canonical ten-digit SEC CIK
  ticker: string;
  name: string;
  exchange: string;
}

interface SecFilingIdentity {
  cik: string;
  accession: string;  // SEC accession, not a generated event id
}

interface SecFilingWorkKey extends SecFilingIdentity {
  sourceVersionDigest: string;
}

interface SecFilingDiscovered {
  key: SecFilingIdentity;
  issuer: SecIssuer;
  form: "8-K" | "8-K/A" | "10-Q" | "10-Q/A" | "10-K" | "10-K/A";
  primaryDocument: string;
  primaryDescription: string;
  filedAt: string;                  // day precision from SEC
  availableAt: string;              // SEC acceptance time when valid, else filedAt
  availablePrecision: "second" | "day";
  sourceVersionDigest: string;      // normalized submission-array version
  discoveredAt: string;              // application observation time
}

interface SecFilingWork extends SecFilingDiscovered {
  workKey: SecFilingWorkKey;
  status: SecWorkStatus;
  attemptCount: number;
  nextAttemptAt: string;
  lastAttemptAt: string | null;
  lastError: string | null;
  failureClass: SecFailureClass | null;
}

interface SecIssuerState {
  issuer: SecIssuer;
  status: SecIssuerStatus;
  attemptCount: number;
  nextAttemptAt: string;
  lastSuccessAt: string | null;
  lastError: string | null;
  failureClass: SecFailureClass | null;
}

interface SecScanCheckpoint {
  scope: "public" | "watchlist";
  directoryDigest: string | null;
  afterCik: string | null;
  updatedAt: string;
}

interface SecFailure {
  subject: "issuer" | "filing" | "source";
  key: SecFilingIdentity | { cik: string } | null;
  class: SecFailureClass;
  message: string;
  retryAt: string | null;
}

interface SecQueueTelemetry {
  discovered: number;
  processed: number;
  pending: number;
  retrying: number;
  quarantined: number;
  requestCount: number;
  d1BatchCount: number;
  coverageRisk: "none" | "undiscovered_inactive_issuers";
}
```

`SecFilingIdentity` is the stable provider identity and is never replaced by a
URL, primary document name, or observation timestamp. The queue work key adds
`sourceVersionDigest`: the same accession and same version are idempotent, while
a changed submission version is a new screening work row. The queue row stores
all metadata needed to process the accession after the SEC seven-day recent
window has expired. Event identity remains `SEC:cik:accession`; the repository
updates that event only for the newest accepted source version/observation and
preserves review state.

The queue is owner-scoped because current events, captures, review notes, and
watchlists are owner-scoped. Its logical D1 identity is
`(owner_id, cik, accession, source_version_digest)`, with a due-work index on
`(owner_id, status, next_attempt_at, available_at)` and a logical-accession
index for newest-version checks. Issuer retry state is keyed by
`(owner_id, cik)`. Scan checkpoints remain separate for `public` and
`watchlist`; neither cursor is allowed to advance the other.

### Ports and signatures

Provider wire shapes stay private to the SEC adapter. The queue sees normalized
domain values only.

```ts
interface SecSource {
  readPublicDirectory(input: SecDirectoryRequest): Promise<SecDirectoryResult>;
  readSubmissions(input: SecSubmissionRequest): Promise<SecSubmissionResult>;
  readPrimaryDocument(input: SecPrimaryDocumentRequest): Promise<SecPrimaryDocument>;
}

interface SecDirectoryRequest {
  now: string;
  budget: RequestBudget;
}

interface SecDirectoryResult {
  issuers: readonly SecIssuer[];
  capture: CaptureRecord;
  directoryDigest: string;
}

interface SecSubmissionRequest {
  issuer: SecIssuer;
  now: string;
  budget: RequestBudget;
}

interface SecSubmissionResult {
  eligible: readonly SecFilingDiscovered[]; // all eligible rows in the 7-day response
  capture: CaptureRecord;
}

interface SecPrimaryDocumentRequest {
  filing: SecFilingDiscovered;
  budget: RequestBudget;
}

interface SecPrimaryDocument {
  text: string;
  url: string;
  digest: string;
  capture: CaptureRecord;
  observedAt: string;
  evidenceComplete: false;
  evidenceScope: "primary_document_only";
}

interface SecScreening {
  screen(input: ScreeningInput, budget: RequestBudget): Promise<ScreeningResult>;
}

interface SecQueueStore {
  readWork(input: ReadSecWork): Promise<SecWorkSnapshot>;
  apply(change: SecQueueChangeSet): Promise<SecCommitReceipt>;
}
```

`SecScreening` is a narrow adapter over the existing `screenSource`. It keeps
the existing TypeSafe retry-once behavior and passes the same request budget;
it does not let the queue issue a third attempt. `SecSource` uses only the
existing SEC directory, `data.sec.gov/submissions`, and SEC archive primary
document requests through `fetchCaptured`; no paid feed or identity mirror is
used for filing evidence.

```ts
interface ReadSecWork {
  scope: SecRefreshScope;
  now: string;
  issuerLimit: number;
  filingsPerIssuer: number;
}

interface SecWorkSnapshot {
  checkpoint: SecScanCheckpoint;
  issuers: readonly SecIssuer[];       // fair, due issuer selection
  dueFilings: readonly SecFilingWork[]; // round-robin by issuer, max two each
  pendingCount: number;
}

interface SecQueueChangeSet {
  discovered: readonly SecFilingDiscovered[];
  issuerOutcomes: readonly SecIssuerTransition[];
  filingOutcomes: readonly SecFilingTransition[];
  checkpointAfter: SecScanCheckpoint | null;
  sourceHealth: SourceHealth;
  refreshedAt: string;
}

interface SecIssuerTransition {
  issuer: SecIssuer;
  outcome: "succeeded" | "transient_failure" | "permanent_failure";
  error?: SecFailure;
}

interface SecFilingTransition {
  filing: SecFilingWork;
  outcome: "accepted" | "excluded" | "transient_failure" | "permanent_failure";
  event?: Event;
  screening?: ScreeningRunRecord;
  captures: readonly CaptureRecord[];
  error?: SecFailure;
}

interface SecCommitReceipt {
  applied: boolean;
  statements: number;
  idempotentReplays: number;
}
```

`apply` validates the complete change set, splits it into D1 batches of at most
90 statements, and never includes `checkpointAfter` until every discovery
chunk for that checkpoint is durable. Each outcome batch atomically writes the
event/screening/capture references and the queue transition. Event updates
must preserve `review_status`, `review_note`, and `review_updated_at` on
conflict, matching the current repository invariant.

### Module map

- `apps/investor-desk-newsjack/worker/index.ts` remains the authenticated HTTP
  boundary. It keeps the owner identity, cooldown, and five-minute refresh lock;
  it does not learn queue policy.
- `apps/investor-desk-newsjack/worker/providers.ts` remains the multi-source
  composition module. Its SEC branch constructs `SecQueue` and translates the
  queue result into the existing `RefreshResult`; Federal Register behavior is
  unchanged.
- `apps/investor-desk-newsjack/worker/sec-queue.ts` owns `SecQueue`, normalized
  domain types, fair issuer/filing selection, retry classification, request
  reservation, and the durable transition protocol. This is the new deep
  module.
- `apps/investor-desk-newsjack/worker/sec-source.ts` owns SEC URL construction,
  User-Agent handling, `fetchCaptured`, wire-schema validation, seven-day
  eligibility, and primary-document normalization. No SEC JSON type escapes
  this module.
- `apps/investor-desk-newsjack/worker/sec-store.ts` extends the existing
  owner-scoped repository boundary with queue reads and idempotent change-set
  application. It owns D1 statement counting, chunking, conflict clauses, and
  the rule that checkpoints advance only after discovery rows are durable.
- `apps/investor-desk-newsjack/worker/typesafe.ts` remains the TypeSafe adapter;
  `SecScreening` is a small typed facade around its existing validated output
  and retry-once behavior. It continues to use the same R2 capture path.
- `apps/investor-desk-newsjack/worker/schema.ts` and a new additive Drizzle
  migration own `sec_filing_work` and `sec_issuer_state` constraints and
  indexes. Existing `events`, `screening_runs_v2`, `source_captures`,
  `watchlist`, `meta`, and `refresh_locks` remain authoritative for their
  current concerns.
- `apps/investor-desk-newsjack/src/api.ts` and `src/App.tsx` remain unchanged
  callers. They receive the existing snapshot and health contract; queue
  telemetry can be added to the snapshot only as an additive, explicitly
  degraded field.

### Processing algorithm

1. Read due queue work before trying new discovery. This means a 403, directory
   outage, or failing issuer cannot starve already-discovered filings or healthy
   issuers that are due.
2. For `public`, fetch the existing official directory once, sort by canonical
   CIK, and choose the next due issuers after the public checkpoint. For
   `watchlist`, read the owner watchlist, sort by CIK, and choose from that set;
   it does not fetch or advance the public directory checkpoint. Skip issuer
   rows whose `nextAttemptAt` is in the future or whose status is quarantined.
3. For each selected issuer, reserve one request for submissions. Parse all
   eligible allowlisted accessions in the returned seven-day window, dedupe by
   `(cik, accession)`, and durably upsert every candidate before relying on it
   for later processing. The per-refresh value of two is a processing fairness
   cap, not a discovery cap.
4. Process due filing rows in issuer round-robin order, with at most two rows
   per issuer in this refresh. A filing needs a worst-case reservation of three
   requests: primary document plus TypeSafe initial attempt and one retry. The
   planner stops before exceeding 45; unselected rows remain pending.
5. TypeSafe retry occurs only for retryable network/429/5xx failures and only
   once. A validation error or other non-retryable error is classified without
   burning a third TypeSafe attempt. The current SEC prompt continues to set
   `evidenceComplete: false`, says primary document only, and marks exhibits as
   not captured. A successful screening therefore remains a human-reviewable,
   provisional result.
6. Commit each filing outcome through `SecQueueStore.apply`. Success writes the
   event, screening run, captures, and `accepted`/`excluded` queue status in one
   idempotent D1 batch. Failure writes `nextAttemptAt`, count, class, and error
   without removing the work row. A permanent or repeatedly exhausted filing
   becomes `quarantined` and is surfaced for human review; it is not selected
   on every refresh.
7. Only after all selected issuer discovery results have been queued does the
   store commit the scope checkpoint. If processing later fails, the checkpoint
   may still advance because the accession work is durable; queue state, rather
   than the issuer cursor, is the loss-prevention mechanism. If discovery D1
   persistence fails, the checkpoint does not advance and the source response is
   not acknowledged as discovered.

### Required behavior examples

#### A filing processed after eight days

At day 0, SEC submissions returns accession `A`, and `SecQueueStore.apply`
commits a `pending` row with its original `filedAt`, `availableAt`, and
`discoveredAt`. At day 8, the submission response no longer contains `A`, but
`readWork` selects the due queue row because it is independent of the seven-day
discovery predicate. The adapter fetches the stored filing identity's primary
document, screens it, and atomically marks `A` complete. The event retains SEC
availability time and the later observation time; it does not relabel the
filing as newly filed on day 8.

#### More than two eligible accessions

If one submission response contains five eligible accessions, all five are
upserted under their accession keys. Only two are selected for this refresh.
The other three remain `pending` with their original metadata and are selected
in later round-robin refreshes. Re-reading the same submission response is a
no-op for the five keys; it cannot reset attempts, replace a newer source
version with an older one, or create duplicate events.

#### Transient and permanent failures without starvation

An issuer timeout increments only that issuer's backoff and advances the
selection cursor past it for the current pass. Healthy issuers continue. A
malformed issuer submission is quarantined until a changed directory/source
version or an explicit operator retry; it does not hold the public or
watchlist cursor. A filing timeout remains pending with a bounded retry time;
an invalid primary document or exhausted retry policy becomes quarantined.
HTTP 403/401 from SEC is treated as `source_blocked`, not as permanent failure
for every issuer: source health is unavailable, no scope cursor advances, and
existing queue rows remain visible for the next permitted refresh.

#### Duplicate submission and worker restart

The queue work primary key is `(owner_id, cik, accession, sourceVersionDigest)`,
and all event and screening writes retain their existing provider-native
uniqueness. A duplicate submission at the same version upserts only
non-destructive discovery metadata. A changed version creates new screening
work, while an older version cannot replace the current event. A restart before
the discovery commit leaves the checkpoint unchanged and causes a safe
re-read. A restart after discovery but before screening sees the pending row.
A restart after an ambiguous D1 response replays the same change set; conflict
handling preserves the existing review state and does not duplicate the event.
No `processing` state is required because the owner refresh lock already
serializes refreshes; pending rows are the recovery lease.

#### D1 write failure

A failed discovery batch does not advance its checkpoint. A failed outcome batch
does not mark the filing complete and does not replace the previous event or
review state. The next open-session refresh retries the same durable queue or
re-reads the unchanged issuer checkpoint. R2 captures may be orphaned, which is
safe because their deterministic keys and D1 upserts make later capture writes
idempotent. The API returns the last accepted snapshot with an explicit
degraded SEC/queue state, never an empty successful refresh.

#### Public universe and watchlist

`public` rotates through the official SEC exchange directory and records public
coverage separately from the personal list. `watchlist` uses only the
owner-curated CIKs and never mutates `secPublicCheckpoint`. A public scan can
discover a filing for a watched issuer, and a watchlist scan can discover one
without the public directory being available; the filing key is shared, while
UI scope filtering remains explicit. An empty watchlist is a caller-visible
validation state, not a provider failure.

#### Coverage limitation

The queue proves zero loss only after an accession is durably discovered. An
issuer never selected during a long inactive public rotation can have a filing
that was never observed and therefore never entered the queue. That is a
separate `undiscovered_inactive_issuers` coverage risk, shown in telemetry and
not conflated with `pending`, `retrying`, or `quarantined` work. With no
verified background scheduler, the product must continue to say that coverage
advances only while the desk is open.

## Synthesis decision

Candidate 1 recommends a single owner-scoped accession queue behind one deep
`SecQueue.refresh` method. The important choice is to separate discovery
durability from screening progress: a seven-day SEC response creates durable
work, while the issuer cursor only describes which source identities have been
visited. This directly fixes the current loss mode without making callers
understand retry stages. The design deliberately keeps the existing R2 capture,
TypeSafe adapter, refresh lock, and UI API; it adds only SEC queue state and
domain transitions.

The design was screened against the architect red flags:

- It avoids a shallow module by giving callers one operation that owns fairness,
  retry policy, budgets, and persistence rather than exposing six stage methods.
- It avoids information leakage by keeping SEC JSON, D1 row shapes, and
  TypeSafe wire responses behind `SecSource`, `SecQueueStore`, and
  `SecScreening`.
- It avoids temporal decomposition in the public API: the queue owns the
  domain decision even though discovery and screening happen at different
  times. The store's methods describe domain transitions, not transport stages.
- It avoids pass-through methods: `SecQueue.refresh` is the policy boundary;
  `refreshLiveSources` is retained only as the existing multi-source composition
  boundary.

## Tradeoffs accepted

- We accept several small D1 batches in one refresh in exchange for never
  exceeding the 90-statement atomic limit and for making large discovery
  responses durable without truncating accessions.
- We accept that a filing can be screened again after an ambiguous D1 response
  in exchange for no `processing` lease table and safe recovery under the
  existing owner refresh lock.
- We accept that permanent failures need an explicit retry or source-version
  change in exchange for preventing one poisoned issuer or filing from starving
  healthy work.
- We accept shared queue records across public and watchlist scopes in exchange
  for one authoritative accession identity and no duplicate TypeSafe spend.
- We accept that public coverage is still opportunistic while the desk is open;
  durable queueing cannot discover filings for issuers that were never visited.
- We accept primary-document-only evidence and mandatory human review in
  exchange for preserving the current SEC boundary until production access and
  attachment rights are demonstrated.

## Alternatives considered

### Keep the issuer cursor and retry missing screening rows

This loses once a filing falls out of SEC's seven-day recent array and makes the
caller infer work from absent `screening_runs_v2` rows. It exposes temporal
knowledge to the provider loop, cannot distinguish not-yet-discovered from
failed, and has no durable accession metadata. Rejected.

### One durable job per issuer, with filings re-read on every retry

This would persist issuer backoff but not accession identity. It exposes the
seven-day provider window to retry logic, re-spends submissions requests, and
still loses a filing when a worker is inactive for eight days. The accession
queue hides more complexity with a smaller caller surface. Rejected.

### Add a scheduler and a general-purpose workflow engine

This could drain the queue while the desk is closed, but no background scheduler
or new paid/runtime boundary is authorized or verified. It adds deployment,
identity, and operational failure modes without improving the requested
open-session proof. Rejected; the queue is driven by the existing refresh call.

### Queue captures in R2 and rebuild D1 state by listing objects

This could recover more aggressively from a total D1 outage, but it would make
R2 listing, manifest versioning, garbage collection, and object-to-owner
indexing part of the normal domain contract. The recommended commit point is a
durable D1 queue row; an uncommitted parse is explicitly not acknowledged as
discovered. R2 remains the evidence/capture recovery boundary rather than a
second work database.

## Open questions and risks

- Should an operator-facing retry action be added for quarantined issuers and
  filings, or is source-version change plus the next open refresh sufficient
  for the first release?
- What retention period is acceptable for pending and quarantined SEC queue
  metadata and R2 captures under the current private-source policy?
- Should a future production SEC smoke that proves attachment access change the
  `evidenceComplete` policy, or should exhibits remain a separately reviewed
  enrichment even then?
- Does the intended SEC scan cadence justify the proposed backoff schedule, or
  should the first verified production cadence use only provider-documented
  retry-after values?
- If D1 is unavailable beyond the SEC recent window, is an R2 discovery journal
  required for the release's operational SLO, or is the current explicit
  `source blocked / discovery not acknowledged` state sufficient?

## Exact tests

The following tests should be added at the queue and Worker boundaries. Fixtures
must use the existing SEC-shaped inputs and TypeSafe contract; no live SEC claim
is made while the current smoke remains 403.

1. **Seven-day expiry recovery:** commit accession `A` on day 0, run on day 8
   with a submissions response that omits `A`, and assert the primary document,
   screening run, event, original `availableAt`, and `accepted` queue status.
2. **More than two accessions:** return five eligible accessions for one issuer;
   assert five unique queue rows, two processed in pass one, three pending, and
   all five eventually converge across later passes.
3. **Discovery idempotency:** submit the same five accessions and source
   versions twice and assert no additional queue rows, events, captures, or
   TypeSafe screening runs.
4. **Amended/versioned submission:** replay an accession with a changed
   normalized source-version digest and assert a second work version is retained
   without replacing the newer event with an older observation.
5. **Fair issuer selection:** make issuer A fail repeatedly and issuers B and C
   healthy; assert B/C process and the checkpoint advances past A while A has
   a future `nextAttemptAt`.
6. **Permanent failure quarantine:** return malformed submission metadata for A;
   assert A is quarantined, visible in health/failure telemetry, and not retried
   on every refresh; B still processes.
7. **SEC 403 source block:** return 403 for directory or submissions; assert
   source health is unavailable/source-blocked, no issuer is permanently
   poisoned, no checkpoint advances, and existing pending filings remain.
8. **Request budget:** use eight issuers, two eligible filings each, and make
   every TypeSafe call require its retry; assert actual fetches never exceed 45,
   unselected filings remain pending, and the budget failure is explicit.
9. **TypeSafe retry contract:** return one retryable failure then valid output;
   assert exactly two TypeSafe requests. Return two retryable failures or one
   validation failure and assert no third request and a scheduled/quarantined
   queue transition.
10. **Worker restart points:** restart after discovery commit, before outcome
    commit, and after an ambiguous outcome commit; assert pending work is found,
    replay is idempotent, and review status/note survive.
11. **D1 discovery failure:** make the queue write fail; assert the checkpoint
    and prior queue remain unchanged, the API returns prior snapshot plus
    degraded state, and the next retry can commit the same source response.
12. **D1 outcome failure:** make the final outcome batch fail; assert the filing
    is still pending, no partial event/review mutation is visible, and a retry
    converges without duplicate rows.
13. **D1 statement ceiling:** construct the largest allowed discovery and outcome
    change sets and assert every `DB.batch` call has at most 90 statements;
    assert chunking never commits a checkpoint before all discovery chunks.
14. **Public/watchlist separation:** refresh public and assert only the public
    checkpoint changes; refresh watchlist and assert only owner-curated CIKs are
    selected and the public checkpoint is unchanged.
15. **Primary-only human review:** assert SEC screening input and event evidence
    say `primary_document_only`, `evidenceComplete === false`, exhibits are not
    captured, and the resulting decision is `review`.
16. **Coverage risk disclosure:** leave an issuer outside the public rotation,
    assert no false claim that all filings are covered, and assert telemetry
    reports `undiscovered_inactive_issuers` separately from pending retries.

## Next implementation step

Add the D1 migration and typed `SecQueueStore` change-set boundary first, then
implement the pure fair-selection and retry-classification functions against
these tests before moving the existing SEC provider loop behind `SecQueue`.
