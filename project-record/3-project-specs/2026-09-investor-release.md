# Newsjack investor release

## Original request and interpretation

Original user intent, with credentials omitted: build a real investor product
from the user's Newsjack GitHub fork; make the interface look like Newsjack and
like the attached rough News Desk Dealer reference; populate and categorize the
desk with real data using TypeSafe AI; cover a broad public-company universe as
well as federal/public filings; let people choose companies by name rather than
requiring CIK knowledge; avoid paid EODHD and Bloomberg data; use GitHub and
publish privately where useful; and inspect the finished UI in Codex's native
browser. The user explicitly said no demo data and authorized encrypted
app-only runtime transfer of the TypeSafe, Finnhub, and SEC contact values.

Binding visual characteristics in
[`newsjack-style-reference.png`](newsjack-style-reference.png): editorial
masthead; dense source/AI telemetry; a horizontal headline wire; a selected
record readout; and multi-column semantic desks with compact overlapping cards.
The example's fake metrics, provider names, and sample headlines are not product
requirements and must not appear as data. This is a composition/style reference,
not a demand for pixel-identical recreation.

The fork is `j-poc/newsjack` (`origin`) based on `elvisun/newsjack`
(`upstream`). Keep the existing CLI and useful behavior. After rejecting
ChatGPT Sites and declining paid Cloudflare, the user selected the existing
owner-private Vercel project with its production-only Turso database.

## Outcome and stopping predicate

One investor opens a private desk and gets a live, source-linked first-read
queue of public-company SEC filings and Federal Register records, automatically
screened by TypeSafe AI. They can search by company name/ticker, curate a
watchlist, inspect evidence and model judgments, and save review notes. No
fictional data, EODHD, or Bloomberg appears. Source failure, stale data,
malformed model output, and incomplete pagination never masquerade as current
success.

Release is complete only when the exact reviewed commit is pushed to the
existing fork, the owner-private Vercel production project is deployed without
expanding audience or spend, and the real consumer path passes source, persistence,
recovery, and UI checks in Codex's native browser. Local unit fixtures or a
localhost screenshot cannot prove production integration.

## Acceptance and evaluation

The root `engineering-contract.json` owns the executable acceptance-to-check
mapping. The evaluated workflow is:

1. On open, load existing server state and start a bounded live refresh; while
   open, repeat at the configured interval. Each successful slice commits real
   records and a durable checkpoint; later slices resume after interruption.
   No refresh-while-closed claim is made.
2. The visible broad universe comes from the official SEC exchange directory.
   Search coverage, the directory-wide rolling filing scan, and the personal
   watchlist have separate counts and semantics. A person adds/removes by name
   or ticker; the system resolves SEC identity. Persist every eligible SEC
   accession before advancing discovery; retry failed issuers and filings
   fairly, preserve screening/version/review state on replay, and fence refresh
   commits against expired lock owners. The durable queue covers only filings
   already observed; it does not prove complete coverage of unvisited issuers.
3. Real SEC primary documents and Federal Register records pass through
   TypeSafe's validated structured-answer contract. The complete eligible
   sentence set from the first 20,000 source characters is preserved. At most
   254 candidates use a direct Choice; larger sets use exhaustive contiguous
   groups of eight, a TypeSafe group Choice, then a second TypeSafe Choice over
   every exact sentence in the chosen group. A defensive group-count bound
   produces an explicit unavailable headline and human-review decision instead
   of sampling. SEC clipping is passed across the provider boundary; whenever
   the source is known truncated, the final candidate is discarded regardless
   of terminal punctuation. The exact selected option, both prompts, responses,
   captures, model, source digest, and contract version are bound into screening
   lineage. A valid model abstention or empty candidate set preserves the record
   with an explicit unavailable headline and human-review decision; a failed
   second stage withholds screening for retry. Full selected sentences are
   retained in the canonical event. Source facts, model judgments, deterministic
   categories/ranking, and human review remain distinguishable and
   source-linked. Unsupported choices are withheld for retry, never replaced
   with a generated claim.
4. Federal Register search uses a seven-day window, selected fields, page
   metadata validation, and at most five 1,000-record index pages per refresh.
   Any unread page or malformed record marks health degraded and is described
   to the user. FederalRegister.gov renditions are informational; legal reliance
   requires checking the official edition on govinfo.
5. Missing credentials, SEC/Federal outages, TypeSafe timeout or malformed
   output, stale observations, duplicate deliveries, invalid payloads,
   unauthorized callers, storage failures, and empty watchlists have visible,
   recoverable outcomes. Failed batches do not advance their cursor or erase
   the last accepted state.
6. Turso watchlist/review/cursor state survives function restart and is isolated
   by the owner-only Vercel perimeter plus a server-defined owner namespace.
   Turso stores source captures only within the applicable source-rights
   boundary.
7. The existing local CLI remains usable. No provider key enters GitHub, static
   assets, responses, or logs. The user authorized encrypted app-only storage
   for TypeSafe, Finnhub, and SEC contact values. Finnhub content requests and
   processing stay disabled until provider rights and explicit permission cover
   sending its content to TypeSafe.

TypeSafe evaluation distinguishes exact checks from model judgment:

- Exact: typed response schema, allowed categories, issuer/agency identity,
  evidence completeness, source/observation/availability time separation,
  prompt/model lineage, deterministic score/lane calculation, and abstention
  on incomplete evidence.
- Representative positive tasks: SEC 8-K, 10-Q, 10-K and Federal Register
  rule/notice, where the first-read summary is supported by captured source text.
- Adversarial/failure cases: roundup or URL-only text; wrong issuer/agency;
  future or retrieval-time substitution; upstream-clipped source ending in a
  decimal/amount period; a substantive sentence at an interior position of a
  >254-candidate document; incomplete/truncated source; failed group-resolution
  request; malformed or missing TypeSafe answer; timeout; duplicate delivery;
  unavailable provider;
  a Finnhub request without rights approval; incomplete pagination; interrupted
  refresh; cross-owner request; and saved review state under replay.
- Each hard failure is blocked or visibly sent to human review; a model score
  cannot waive a deterministic invariant. One live example per source is a
  smoke check only, not evidence of broad model accuracy or investment value.
- Measure real per-slice latency, item/subrequest counts, and failures in the
  private integration check; never send credentials or restricted data into
  test records.

## AI system capability checklist

| Area | Decision | Boundary |
| --- | --- | --- |
| Workflow/value | Build now | First-read triage; the investor retains every investment decision. |
| Bounded loop | Build now | Per-refresh issuer/record caps, 45 outbound subrequests, request timeout, and open-page refresh interval. |
| Tool/source permissions | Build now | Public SEC/Federal inputs and TypeSafe only; Finnhub held behind written-rights gate. No trading, order, or portfolio tool. |
| Durable memory | Build now | Turso owner-scoped watchlist, review notes, provider state, and scan cursor. |
| Audit trail | Build now | Raw response digests/captures, source identity, model/prompt digest, typed output, run time, and failures. |
| Structured output | Build now | Zod validation before admission; deterministic code owns score and lane. |
| Retry/recovery | Build now | Idempotent writes, owner-scoped lock, bounded calls, cursor held on invalid batches, and old state preserved. |
| Evaluation | Build now | Representative fixtures, adversarial failures, live source smoke, and source-grounding inspection. Broad category-accuracy claims are deferred. |
| Economics | Build now | Bounded API/TypeSafe work and observed latency/usage; no new billable host or resource. |
| Background updates | Defer | No verified scheduler; refresh runs only while the private desk is open. |
| Multiple agents/autonomous actions | Not needed | No measured need; consequential interpretation and actions remain human-owned. |

## Data, rights, and financial invariants

- Use public SEC EDGAR and FederalRegister.gov; source/provider-native identity,
  URL, retrieval time, observation/publication/availability precision, digest,
  adapter version, and network delivery state stay explicit.
- SEC filing date, SEC availability time, and app observation time are distinct.
  An absent SEC acceptance timestamp is not replaced with retrieval time.
- Federal Register publication date is day precision. Its API rendering is
  reference material, not the official legal edition.
- Raw capture occurs before normalization; Turso normalized writes are idempotent,
  versioned by native identity/observation, and reject older observations.
  Replays do not overwrite review status or note.
- Source status/freshness and AI status are independently visible. Network
  delivery does not itself mean a source observation is complete or decision-
  current. Incomplete pages remain degraded.
- Do not use EODHD or Bloomberg. Do not request, capture, or process Finnhub
  content until written rights allow both this hosting and TypeSafe as a
  processor. The encrypted API key alone does not turn on Finnhub requests.
- No new paid hosting tier, billable resource, or audience expansion is
  authorized. Keep production private and owner-only.

## Architecture and recovery

The existing local path is a Go CLI plus Express/SQLite review server; retain it.
The hosted Worker uses Vercel Node Functions because the serverless runtime
cannot launch Go or use local SQLite. React calls same-origin routes protected
by Vercel Authentication; the handler uses a fixed owner namespace and each
Turso query is owner-scoped. Turso holds durable review/watchlist/source-health/
checkpoint metadata and bounded private content-addressed captures. Provider
keys remain sensitive production-only runtime values.

Compared alternatives: (a) preserve CLI in a container, but no existing
authorized no-new-spend host was configured; (b) adapt the existing worker to
the already-configured private Vercel project and its connected free-supported
Turso resource; (c) serve a static page against localhost, which has no
production data path; or (d) add a GitHub Actions worker, which introduces an
unverified identity boundary and tempts credential storage in GitHub. Option
(b) is the simplest configured complete path. Production data and authorization
remain subject to live checks. No scheduled refresh is claimed.

On source/model/storage failure, return the last accepted snapshot with explicit
health and no cursor advancement for the failed batch. On replay, native identity
and event version prevent duplicates and older observation overwrite. A
five-minute compare-and-set lock bounds concurrent refreshes. Rollback uses a
prior saved Vercel deployment and forward-only additive migrations; it must not
delete user Turso records.

### SEC durable queue decision (2026-09-23)

The SEC seven-day boundary is an application filter, so an accession discovered
but not processed within that period needs owner-scoped durable work state. Use a
single accession-keyed queue plus separate issuer retry state within the
existing provider/repository modules. Chunk discovery writes idempotently, then
advance the cursor only after all selected issuer obligations are durable.
Commit a filing's event, screening, evidence references, and queue completion
or retry together. Keep public work separate from watchlist selection (which
uses only currently watched CIKs), preserve the existing 20-minute source
revalidation and TypeSafe contract behavior, and use the shared 45-fetch budget.
Refresh mutations are fenced by the stored refresh-lock token; no generic job engine,
per-filing lease, scheduler, paid source, or exhibit crawler is in this slice.
See [`sec-queue-design/synthesis.md`](../6-scratchpad/sec-queue-design/synthesis.md)
for the candidate comparison and Astra review. Local SQLite and libSQL adapter
tests now exercise queue replay, cursor fencing, and stale-owner rejection;
production persistence and real-source recovery remain unverified until the
deployed workflow is exercised.

### Hosting decision — Vercel + Turso (2026-09-24)

The user rejected ChatGPT Sites and declined paid Cloudflare. The current Vercel
project is on Hobby and its `ssoProtection=all` setting is read back as active;
the team's only member is the owner. Vercel's September 9, 2026 changelog says
Vercel Authentication can protect all deployment URLs, including production,
at no extra cost on every plan. Use that owner-only perimeter, and do not trust
the prior Sites identity header in Vercel functions. Pin all application data to
one server-defined owner namespace; never let request headers select an owner.
The connected Turso database is the current Starter/free resource. Its allowed
environment is Production only, and the integration supplies sensitive
production environment variables. No paid Vercel feature, Turso tier, or
overage is enabled.

The bounded comparison favored adapting the existing hosted Worker/domain
logic over routing Vercel through local Express/SQLite, which invokes the CLI
and uses local-file assumptions. Astra's architecture review recommended
Vercel Node Functions plus the existing Vite client and a narrow libSQL
adapter. The official Turso TypeScript reference documents transactional
`batch(..., "write")` semantics and marks `@libsql/client` production-ready;
official Vercel docs document Node functions in the app's `/api` directory and
a 4.5 MiB function request/response payload ceiling. Keep queue mutations in
short atomic write batches, keep provider/model I/O outside transactions, and
bound requests below the Hobby execution limit. Do not copy provider logic or
introduce another market-data vendor.

Private content-addressed Turso BLOB rows are the implemented capture store in
the already-connected resource. New events are rejected before persistence if
they exceed 96 KiB, and the API response guard is below Vercel's function
payload ceiling. Oversized historical rows fail closed with a bounded,
actionable error, never a partial-page success. Production must still prove
actual source captures fit these bounds and quota failures leave accepted state
intact.

The Vercel functions have not yet been deployed from this release revision.
Turso is Production-only. TypeSafe's production-only sensitive setting was
explicitly authorized and configured; live consumer behavior is unverified
until production acceptance. Finnhub processing remains disabled. The previous
ChatGPT-hosted page is not the release target. No prior durable records have
been asserted migrated or absent.

### Ranked history and concurrent edits (2026-09-24)

Keep the existing attention-ranked order and fetch older history through a
version-bound keyset cursor rather than adding a materialized membership table.
Each page contains at most 20 complete events; event JSON is capped at 96 KiB,
and the API refuses responses above 4 MB. Event refreshes and watchlist changes
advance the same catalog revision atomically. Reads bracket the event page and
watchlist with that revision; a mixed read returns HTTP 409 instead of a
contradictory snapshot. A changed ranking invalidates the cursor explicitly;
the client reloads, while same-revision review responses preserve the last
loaded cursor. Reviews compare the full expected saved status/note/time and
give conflicts back to the editor with the latest saved value; unsaved drafts
remain intact. Scope request generations prevent late results from replacing a
newer selection, and revision comparisons prevent rollback. This is smaller
than frozen membership and remains correct by refusing traversal across a
catalog change.

The local SQLite and real libSQL adapter tests cover 1,500-record traversal,
review persistence, stale-cursor rejection, late scope results, stale review
conflicts, watchlist/page races, and oversized legacy rows. These checks do not
prove the Vercel route exists in production or establish live source behavior;
the deployed consumer checks remain required.

## Baseline, current state, and blockers

- The active checkout is branch `codex/investor-release`, derived from
  `1240ea5`; it has pre-existing, uncommitted investor-edition work. `origin` is
  the user's fork and `upstream` is `elvisun/newsjack`. Do not discard existing
  edits.
- Local preview/browser checks and old CLI smoke tests were performed earlier,
  but do not establish the hosted Worker path. Prior local SEC requests returned
  HTTP 403. Earlier Finnhub + TypeSafe results are historical and do not grant
  rights or authorize use in the hosted path.
- Vercel Authentication is configured for every deployment URL and the team
  owner is the only member. Turso and production-only sensitive provider values
  are configured. `FINNHUB_PROCESSING_APPROVED=false` keeps Finnhub content use
  disabled. No scheduled refresh is claimed.
- The previous live-data ETL receipt is stale and failed the SEC live smoke; it
  is not current evidence. Re-run code-bound fixture/failure/replay checks and
  only claim a provider live after the deployed consumer path succeeds.
- The user authorized production-only transfer of the existing TypeSafe
  credential. No provider credential is included in this record or Git.
- Any required live data/source or deployment authorization that remains
  unresolved blocks release completion; it does not authorize substituting
  synthetic data, public access, or a paid provider.

## Work sequence and handoff

1. Complete the data contract and source-paginated Worker behavior; verify
   success, malformed response, omitted page, and recovery.
2. Verify UI health truthfulness, reference structure, real data flow, empty and
   degraded states, keyboard operation, and a narrow/mobile viewport.
3. Run app/Worker typechecks and tests, Go regression, builds, dependency and
   secret scans; inspect the complete diff and dependency audit.
4. Bind every acceptance criterion to native checks in `engineering-contract`
   and perform an independent original-request/reference alignment review.
5. Only after deployment blockers are resolved: push reviewed source to the
   existing fork, transfer only authorized encrypted secrets, deploy owner-
   private, and verify live source/TypeSafe/persistence through Codex's native
   browser.
6. Record tested commit, exact outputs, live freshness, limitation, rollback
   point, and any unresolved acceptance item in `project-record/4-log/`.
