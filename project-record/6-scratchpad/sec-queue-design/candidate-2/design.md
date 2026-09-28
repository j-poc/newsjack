# Candidate 2: durable SEC accession queue

## Usage (caller's view)

The caller keeps one refresh operation. It does not know about SEC response
arrays, leases, backoff, queue rows, or D1 statement counts.

### 1. Refresh route

This replaces the current `refreshLiveSources(...)` plus
`repository.recordRefresh(...)` pair in
`apps/investor-desk-newsjack/worker/index.ts` (currently around lines
130–134):

```ts
const outcome = await runInvestorRefresh({
  env,
  ownerId: readOwnerId(request),
  source: parsed.data.source,
  now: nowIso(),
});

return json(outcome.snapshot);
```

The existing route still owns authentication, cooldown, owner lock, and the
existing `all`/`federal` behavior. `runInvestorRefresh` owns SEC discovery,
durable filing work, TypeSafe screening, and all commits. A failed provider or
failed D1 commit returns the prior snapshot plus a truthful degraded result;
the route never advances a cursor by itself.

### 2. Desk open and ten-minute refresh

The current `runRefresh` in `src/App.tsx` remains a one-line domain call:

```ts
const next = await refresh(nextScope); // src/api.ts -> POST /api/refresh
setSnapshot(next);
```

The open-page timer continues to be the only recurring trigger. There is no
new scheduler or closed-page refresh claim.

### 3. Watchlist add followed by a watchlist refresh

The current `addIssuer` call site remains unchanged:

```ts
const next = await updateWatchlist("add", parsed.data);
setSnapshot(next);
if (scope === "watchlist") void runRefresh("watchlist");
```

The refresh reads the current owner-scoped watchlist and creates discovery
obligations for those issuers. The caller does not enqueue an issuer or filing,
and cannot accidentally write into the public-universe cursor.

The stable internal result is:

```ts
interface RefreshOutcome {
  snapshot: AppSnapshot;
  failures: readonly RefreshFailure[];
  requestCount: number;
}

interface RefreshFailure {
  provider: "sec" | "typesafe_ai" | "federal_register";
  class: FailureClass;
  message: string;
}
```

`AppSnapshot` remains the browser contract. Queue diagnostics are represented
through the existing source-health and coverage fields; D1 row shapes and SEC
wire payloads do not leak to the browser.

## Problem

The current Worker reads SEC `filings.recent`, drops anything older than seven
days, selects at most two filings per issuer, and only persists a whole-batch
issuer cursor after processing. This makes the seven-day response window act
as an accidental queue: a discovered accession can disappear before its
primary document is processed, and one failing issuer holds back healthy
issuers. The design must preserve the existing SEC directory → submissions →
primary-document → TypeSafe path, owner-scoped D1/R2 state, the 45-request
budget, TypeSafe's existing one retry, and the 90-statement D1 limit. SEC live
access is currently unverified because smoke returned 403, so this is a
durability design, not evidence of production SEC access.

## Shape

### Domain types

These are worker-private types. They are validated at the SEC ingress and D1
boundaries; provider JSON, Drizzle rows, and `D1PreparedStatement` never cross
the public facade.

```ts
type SecScope = "public" | "watchlist";
type ScopeMask = 1 | 2 | 3; // public, watchlist, or both

type WorkState =
  | "queued"
  | "leased"
  | "complete"
  | "retryable"
  | "permanent"
  | "cancelled";

type FailureClass = "transient" | "permanent";

interface SecFilingKey {
  cik: string;                 // ten-digit normalized CIK
  accession: string;           // SEC accession, with hyphens
  nativeId: string;            // SEC:${cik}:${accession}
}

interface DiscoveredSecFiling extends SecFilingKey {
  issuer: Issuer;
  form: string;
  primaryDocument: string;
  primaryDescription: string;
  filedAt: Instant;
  availableAt: Instant;
  availablePrecision: "second" | "day";
  sourceVersionDigest: string; // digest of normalized SEC submission metadata
  discoveredAt: Instant;
  scopes: ScopeMask;
}

interface FilingWork extends DiscoveredSecFiling {
  state: WorkState;
  attempts: number;
  nextAttemptAt: Instant | null;
  leaseToken: string | null;
  leaseUntil: Instant | null;
  lastFailure: FailureInfo | null;
}

interface IssuerRetryState {
  scope: SecScope;
  issuer: IssuerSearchResult;
  state: "retryable" | "permanent";
  attempts: number;
  nextAttemptAt: Instant | null;
  lastFailure: FailureInfo;
}

interface FailureInfo {
  class: FailureClass;
  stage: "directory" | "submissions" | "primary_document" | "typesafe" | "validation";
  status: number | null;
  message: string;
  failedAt: Instant;
}

interface SecCursor {
  scope: SecScope;
  offset: number;
  directoryDigest: string | null;
  updatedAt: Instant;
}

interface SecDirectorySnapshot {
  issuers: readonly IssuerSearchResult[];
  digest: string;
  capture: CaptureRecord;
}

interface SecSubmissionSnapshot {
  filings: readonly DiscoveredSecFiling[];
  capture: CaptureRecord;
}

interface SecPrimaryDocument {
  text: string;
  sourceUrl: string;
  observedAt: Instant;
  digest: string;
  capture: CaptureRecord;
}

interface IssuerSelection {
  issuers: readonly IssuerSearchResult[];
  cursor: SecCursor | null;
}
```

`nativeId` is the durable filing identity. Repeated submission responses
upsert the same `(owner_id, native_id)` row and merge `scopes`; they do not
create another screen or event. A changed `sourceVersionDigest` requeues the
same accession without deleting its existing event or human review state.

### Public facade and typed source boundary

```ts
type RequestedSource = "watchlist" | "all_public" | "federal" | "all";

interface InvestorRefreshRequest {
  env: WorkerEnv;
  ownerId: string;
  source: RequestedSource;
  now: Instant;
}

export async function runInvestorRefresh(
  request: InvestorRefreshRequest,
): Promise<RefreshOutcome>;

interface SecSource {
  readDirectory(budget: RequestBudget): Promise<SecDirectorySnapshot>;
  readSubmissions(
    issuer: IssuerSearchResult,
    budget: RequestBudget,
  ): Promise<SecSubmissionSnapshot>;
  readPrimaryDocument(
    filing: DiscoveredSecFiling,
    budget: RequestBudget,
  ): Promise<SecPrimaryDocument>;
}

interface SecScreening {
  screen(
    filing: DiscoveredSecFiling,
    document: SecPrimaryDocument,
    budget: RequestBudget,
  ): Promise<ScreeningResult>;
}

interface SecQueueDependencies {
  source: SecSource;
  screening: SecScreening;
  store: SecQueueStore;
  clock: Clock;
}

interface Clock {
  now(): Instant;
}

interface SecRefreshRequest {
  ownerId: string;
  requestedSource: "watchlist" | "all_public" | "all";
  budget: RequestBudget;
  now: Instant;
}

interface SecRefreshResult {
  events: readonly Event[];
  health: readonly SourceHealth[];
  failures: readonly RefreshFailure[];
  requestCount: number;
}

export async function runSecRefresh(
  deps: SecQueueDependencies,
  request: SecRefreshRequest,
): Promise<SecRefreshResult>;
```

`SecSource` is typed after the existing `providers.ts` validation and capture
boundary. It does not expose SEC URLs or response arrays. `SecScreening` is
the existing `screenSource` behavior: at most two TypeSafe HTTP attempts for
one screen, retrying once only for the current retryable classes. The queue
does not add a second TypeSafe retry loop.

### Queue store signatures

`InvestorRepository` implements this private interface. The facade is the only
caller that coordinates these methods; route code does not become a shallow
sequence of repository calls.

```ts
interface SecQueueStore {
  loadIssuerSelection(input: {
    ownerId: string;
    scope: SecScope;
    now: Instant;
    maxIssuers: number;
    retryShare: number;
  }): Promise<IssuerSelection>;

  commitIssuerOutcome(input: {
    ownerId: string;
    scope: SecScope;
    issuer: IssuerSearchResult;
    filings: readonly DiscoveredSecFiling[];
    captures: readonly CaptureRecord[];
    failure: FailureInfo | null;
    nextCursor: SecCursor | null;
    committedAt: Instant;
  }): Promise<void>;

  claimDueFilings(input: {
    ownerId: string;
    now: Instant;
    leaseToken: string;
    leaseForMs: number;
    maxTotal: number;
    maxPerIssuer: number;
  }): Promise<readonly FilingWork[]>;

  commitFilingResult(input: {
    ownerId: string;
    lease: FilingWork;
    captures: readonly CaptureRecord[];
    event: Event | null;
    screening: ScreeningRunRecord;
    committedAt: Instant;
  }): Promise<void>;

  commitFilingFailure(input: {
    ownerId: string;
    lease: FilingWork;
    failure: FailureInfo;
    committedAt: Instant;
  }): Promise<void>;

  requeuePermanentFailures(input: {
    ownerId: string;
    sourceRevision: string;
    now: Instant;
  }): Promise<number>;
}
```

### Module map

- `apps/investor-desk-newsjack/worker/index.ts` keeps the existing boundary
  responsibilities: Site identity, same-origin writes, cooldown, owner lock,
  HTTP errors, and snapshot response. It calls the refresh facade and does not
  know queue transitions.
- `apps/investor-desk-newsjack/worker/sec-queue.ts` is the deep module and the
  only SEC queue orchestrator. It owns public/watchlist selection, fair issuer
  retry, accession enqueue, lease/retry policy, request planning, and the
  primary-only human-review rule. Its public surface is `runSecRefresh`.
- `apps/investor-desk-newsjack/worker/providers.ts` keeps the existing SEC
  integration boundary: SEC URLs, response schemas, raw capture, normalization,
  and typed `SecSource` functions. It does not own queue state or cursor
  policy. No new paid provider or transport is introduced.
- `apps/investor-desk-newsjack/worker/typesafe.ts` remains the TypeSafe
  boundary. Its current two-attempt behavior is reused; the queue does not
  duplicate it.
- `apps/investor-desk-newsjack/worker/repository.ts` implements `SecQueueStore`,
  existing owner-scoped snapshot/review operations, and statement-counted D1
  commits. It is the only module that knows SQL row shapes.
- `apps/investor-desk-newsjack/worker/schema.ts` and a new additive
  `drizzle/0002_sec_durable_queue.sql` define the two queue tables and indexes.
- `apps/investor-desk-newsjack/worker/capture.ts` remains the R2 capture
  boundary. R2 writes happen before D1 commit and are safe to replay.
- `apps/investor-desk-newsjack/worker-tests/investor-worker.test.ts` gains the
  behavioral tests listed below. `src/api.ts`, `src/App.tsx`, and the browser
  event contract do not need queue knowledge.

`commitIssuerOutcome` is idempotent. It writes every normalized eligible
accession, the source-capture metadata, and then the cursor or issuer retry
state. If there are more than 90 statements, it splits queue inserts into
sub-batches of at most 88 and writes the cursor only in the final sub-batch.
A crash between sub-batches leaves the cursor behind; replay repeats safe
unique inserts and cannot lose an accession.

`commitFilingResult` is one D1 batch for the result: source-capture metadata,
screening run, event upsert, and queue completion. It preserves the existing
event's review columns on a newer observation. It never marks a lease complete
before the event/screening write succeeds.

### Tables and indexes

Add one migration, mirrored in `worker/schema.ts`:

```text
sec_filing_queue
  owner_id, native_id PRIMARY KEY
  cik, accession, issuer_json, form, primary_document, primary_description
  filed_at, available_at, available_precision, source_version_digest
  scope_mask, state, attempts, next_attempt_at
  lease_token, lease_until
  last_failure_class, last_failure_stage, last_failure_status,
  last_failure_message, last_failed_at, discovered_at, updated_at

sec_issuer_retries
  owner_id, scope, cik PRIMARY KEY
  issuer_json, state, attempts, next_attempt_at
  last_failure_class, last_failure_stage, last_failure_status,
  last_failure_message, last_failed_at, updated_at
```

Indexes are `(owner_id, state, next_attempt_at, filed_at)` on filings and
`(owner_id, scope, state, next_attempt_at)` on issuer retries. Existing `meta`
keys remain the durable `secPublicOffset` and `secWatchlistOffset`; they are
not replaced by in-memory cursors.

### Flow and concrete behavior

1. `runSecRefresh` constructs one `RequestBudget(45)`, reads the current
   owner-scoped selection, and first attempts bounded issuer discovery. Public
   selection uses the existing SEC directory and rotating offset; watchlist
   selection uses the current watchlist and its separate offset. Due issuer
   retries are interleaved but limited to `retryShare = 2`, so a bad issuer
   cannot occupy the whole rotation.
2. A successful submission response normalizes *all* allowed-form filings in
   the SEC seven-day recent window. It does not select only two. Every
   accession is durably upserted before the issuer cursor advances.
3. An issuer submission failure writes a retry or permanent issuer row and
   still advances the rotation cursor in the same final D1 batch. A healthy
   issuer in the same refresh can proceed.
4. The runner claims due filing rows fairly, in `nextAttemptAt`/availability
   order with round-robin issuer selection and `maxPerIssuer = 2`. Leases last
   five minutes. Expired leases are claimable on the next open-page refresh.
5. A primary-document fetch uses the stored CIK, accession, and primary
   document. It does not need a fresh `filings.recent` response. TypeSafe
   screens the primary document through the existing `screenSource` boundary.
6. Successful and excluded screens both complete the queue row. A relevant SEC
   event remains `evidenceComplete: false`, has a human-review decision, and
   states that exhibits/attachments were not captured. No attachment or
   exhibit crawl is added until production SEC access is demonstrated.
7. Transient filing failures use deterministic backoff
   `min(5 minutes * 2^(attempt - 1), 6 hours)`. Permanent failures move to a
   visible dead-letter state and are not hammered on every refresh. A source
   revision or explicit operator recovery calls `requeuePermanentFailures`.

The budget planner is pessimistic about TypeSafe's one retry and never claims
more work than it can afford:

| refresh scope | discovery requests | max filing attempts | worst-case SEC requests |
| --- | ---: | ---: | ---: |
| `all_public` | 1 directory + 8 submissions = 9 | `floor((45 - 9) / 3) = 12` | 45 |
| `watchlist` | up to 8 submissions = 8 | `floor((45 - 8) / 3) = 12` | 44 |
| `all` | 1 directory + 3 submissions = 4 | 6, preserving existing combined cap | 22 SEC |

One filing costs at most three requests: one primary document plus two
TypeSafe attempts. In `all`, the existing Federal Register limits consume at
most 14 more requests (five index pages plus three documents with up to two
TypeSafe attempts each), leaving headroom under 45. If discovery is blocked,
the runner spends the remaining budget on already durable filing work; a 403
does not erase or hold the queue.

The final D1 result batch is also bounded. A worst-case filing contributes up
to three capture rows, one screening row, one event row, and one queue
transition: six statements. Twelve filings therefore use at most 72,
leaving room for health and refresh metadata. Discovery writes are chunked so
no individual D1 batch exceeds 90 statements. A batch builder rejects an
oversized plan before execution.

### Required edge and recovery cases

- **Recent filing, processed after eight days.** On day 0, a filing in the
  recent window becomes a `sec_filing_queue` row with its accession, primary
  document, and availability timestamps. On day 8, the seven-day submission
  filter no longer returns it, but the due queue row still claims it and reads
  the archive primary document. The filing is not lost to the window.
- **More than two eligible accessions.** Five accessions create five unique
  queue rows. The first refresh claims at most two for that issuer; the other
  three remain queued. The next refresh can claim two more, and another issuer
  gets a turn in every refresh.
- **Transient/permanent issuer failure.** A 503/network/429 becomes a retry
  row with a due time; malformed data, missing required identity, or a
  non-retryable 4xx becomes permanent. The public/watchlist cursor still
  advances because the obligation itself is durable. Healthy issuers continue.
- **Transient/permanent filing failure.** The leased accession is rescheduled
  or dead-lettered independently. Other accessions are still claimed; no
  whole-batch rollback is used for a provider failure.
- **Duplicate submission.** Repeated directory/submission payloads converge
  on `(owner_id, native_id)`. Same-version rows are no-ops; only a changed
  source-version digest reopens that accession. There is one screening key,
  one event identity, and no duplicate review record.
- **Worker restart.** A restart before discovery commit leaves the cursor
  behind, so discovery replays safely. A restart after discovery preserves
  the accession queue. A restart after a claim reclaims the expired lease.
  A restart after TypeSafe/R2 success but before D1 commit repeats the
  idempotent capture/event/screening write.
- **D1 write failure.** Cursor and issuer obligation are committed together;
  if that batch fails, the cursor is not advanced. Filing completion is
  atomic with the queue transition; if it fails, the lease expires and the
  filing is retried. R2 orphan captures are harmless because capture rows and
  screening/event upserts are idempotent.
- **Public universe versus watchlist.** Public and watchlist offsets and
  issuer retry keys are separate. A filing discovered by both scopes merges
  `scope_mask` and is screened once. Removing a watchlist issuer does not
  delete historical events; a watchlist-only queued row is cancelled when it
  is no longer active, while a public-discovered row remains eligible.

This guarantees zero loss only for filings already discovered and persisted.
An issuer that has never been visited before its recent response ages out can
still have an unknown filing. That is a separate coverage risk from queue
durability; the product must continue to expose a rotating, incomplete public
coverage state and must not imply that the queue discovers inactive issuers.

## Synthesis decision

This is candidate 2's recommended base: an accession-keyed filing queue plus a
small durable issuer-retry table, with the existing owner lock and refresh
entry point retained. The decisive choice is to advance the issuer cursor
after durable discovery/retry obligations, not after successful screening.
That separates discovery completeness from provider availability while
keeping the caller to one refresh operation. No cross-candidate synthesis is
claimed in this package.

The design deliberately keeps the current typed SEC adapter and TypeSafe
retry behavior, and grafts only the missing durability: per-accession state,
lease recovery, per-issuer fairness, and bounded commit planning.

The architect red flags are addressed directly: `runSecRefresh` is a deep
module rather than a pass-through repository facade; SEC wire and D1 shapes
stay private; discovery and screening are grouped by queue ownership rather
than exposed as caller-visible temporal stages; and route callers do not
coordinate internal policy.

## Tradeoffs accepted

- We accept a second D1 table and additive migration in exchange for proving
  zero loss after discovery; missing screening rows are no longer the queue.
- We accept replaying a discovery response after a partial D1 write in
  exchange for never advancing a cursor past an unrecorded obligation.
- We accept bounded per-issuer fairness rather than draining one issuer in one
  refresh in exchange for preventing a large issuer backlog from starving the
  public rotation.
- We accept durable permanent/dead-letter rows in exchange for not repeatedly
  spending SEC and TypeSafe budget on a known-invalid issuer or filing.
- We accept orphaned R2 captures after a D1 failure because R2 is outside the
  D1 transaction; idempotent capture metadata and queue replay make them
  recoverable without treating them as committed user-visible evidence.
- We accept that unknown filings from never-visited issuers remain a coverage
  limitation; solving that would require a different discovery cadence or
  provider capability, not a larger retry queue.

## Alternatives considered

### Keep missing-screening inference and move the cursor per issuer

This loses when a filing ages out of `filings.recent` before its issuer is
visited again, and it exposes temporal assumptions to provider code. It has a
smaller schema but a shallower interface and cannot prove the requested
already-discovered zero-loss property.

### One generic job table for issuers, filings, and TypeSafe attempts

This hides retry mechanics in a generic state machine but leaks job-kind,
lease, payload, and transition rules to every caller. It also makes the
90-statement commit plan and the distinction between discovery cursor and
filing identity harder to audit. Two domain-shaped tables are smaller at the
decision boundary and have deeper policy.

### A separate background worker or paid SEC/search provider

This could improve inactive-issuer coverage, but it violates the existing
open-page execution model and the explicit provider boundary. It also would
not repair D1 idempotency or filing retry semantics. It is out of scope.

## Open questions and risks

- Should the UI expose a small “queued / retrying / permanent failure” count in
  source health, or is the current degraded message and coverage readout
  sufficient for the first implementation?
- What source/configuration revision should be authoritative for requeueing a
  permanent SEC 403, given that production SEC access is not yet demonstrated?
- When a watchlist-only queued filing is removed from the watchlist, should it
  be cancelled immediately or retained for one final processing attempt for
  audit completeness?
- What retention period, if any, should be applied to completed queue rows
  after the event and screening provenance are durable?
- Does the existing public-universe product copy need to say explicitly that
  the rotation is incomplete and that the accession queue covers only issuers
  already visited?

## Exact verification plan

Add focused Worker tests with fake typed SEC responses and a D1 failure
wrapper. The assertions should be:

1. `persists every eligible accession before the cursor advances`: five
   recent filings yield five queue rows, while the cursor advances once.
2. `processes a discovered filing after the seven-day window`: advance the
   clock eight days, return no recent filing, and still produce one primary
   document event from the queued accession.
3. `claims at most two filings per issuer and rotates to healthy issuers`:
   one issuer has five queued rows and another has one; the first claim has
   three total rows with no more than two for the first issuer.
4. `deduplicates duplicate submissions and screens once`: submit the same
   accession twice and assert one queue row, one TypeSafe call, and one event.
5. `replays a changed source version without deleting review state`: change
   submission metadata, requeue the accession, and assert one event identity
   with the prior human note preserved after the newer screen.
6. `advances public work past a transient issuer failure`: return 503 for one
   issuer and valid submissions for the next; assert the next issuer is
   processed, the cursor advances, and the failed issuer has a due retry.
7. `dead-letters a permanent issuer or filing failure`: return a validation or
   non-retryable 4xx failure; assert no immediate retry and healthy work still
   commits.
8. `reclaims an expired issuer and filing lease after worker restart`: stop
   after claim, advance five minutes, and assert the same work is claimable
   with a new lease token.
9. `does not advance discovery on D1 failure`: fail the discovery commit,
   assert the cursor is unchanged, retry the same response, and assert no
   duplicate queue rows.
10. `does not acknowledge a filing on D1 failure`: fail the result commit,
    assert no completed queue state or event, expire the lease, and assert a
    later refresh can commit it.
11. `uses exactly the 45-request ceiling`: exercise eight public issuers and
    twelve worst-case filings, including one TypeSafe retry per filing, and
    assert request count 45 with no 46th fetch.
12. `keeps every D1 batch at or below 90 statements`: use worst-case capture,
    screening, event, and queue rows and inspect every batch size.
13. `keeps public and watchlist refreshes isolated`: run each cursor for the
    same owner, merge a shared accession once, and assert removing the
    watchlist does not remove its historical event.
14. `keeps primary-only SEC evidence human-reviewable`: assert
    `evidenceComplete === false`, the exhibit-not-captured rationale, and
    `decision === "review"`; assert no attachment URL was fetched.
15. `continues draining durable filings when the directory returns 403`:
    assert the source is degraded/unavailable, the queued filing is still
    attempted, and no current claim is made for undiscovered issuers.

## Next implementation step

Add the migration and worker-private queue types first, then implement
`runSecRefresh` against the existing typed SEC capture and TypeSafe adapters
before changing the browser contract.
