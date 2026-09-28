# Current architecture

## Investor edition

### Hosting pivot — 2026-09-24 (implementation locally verified; production release verification pending)

The intended release host is now the existing owner-only Vercel Hobby project
`newsjack-investor-desk`, not ChatGPT Sites or Cloudflare. Vercel Authentication
is configured for all deployment URLs. Its team currently contains the single
owner account. The production runtime must use a fixed server-side owner key;
it must never trust an inbound `oai-authenticated-user-id` or another
caller-controlled identity header. Preview deployments must not have access to
production storage or provider credentials.

The app's existing TypeScript domain/Worker pipeline and Vite client remain the
starting point. The Vercel adapter is limited to Node Function entry points and
the storage boundary: same-origin API functions call the shared handler, and
the connected Turso Starter database stores durable desk state plus bounded,
owner-scoped content-addressed raw captures. The Turso resource and its
sensitive integration values are restricted to Production. No paid tier,
overage, paid source, or Cloudflare resource is part of this release.

TypeSafe supplies typed scoring/category judgments and selects a first-read
headline from the full set of eligible source-derived sentences within the
20,000-character screening bound. Up to 254 candidates are offered directly;
larger sets are exhaustively partitioned into contiguous groups of eight,
TypeSafe selects a group, then a second TypeSafe Choice selects the exact
sentence within it. Candidates are never sampled out; if the bounded group
count is exceeded, the headline is explicitly unavailable and human review is
required. When an upstream provider already clipped the source, that fact is
carried into screening and the final candidate sentence is discarded even if
it ends in punctuation, since a period can be part of a truncated amount. A
failed second-stage call withholds screening for retry. The full selected
sentence is stored; cards may visually clamp it. It is not generated prose or
the filing title. A valid abstention remains visible with an explicit
unavailable headline and human-review decision. The user authorized and completed production-only
sensitive configuration for the TypeSafe key; the hosted consumer path is still
unverified until the production workflow succeeds.
Finnhub company-news processing remains disabled pending provider-rights review
and approval for sending that content to TypeSafe. The product must show this
honestly rather than presenting federal records as company news.

The product has a local CLI path and a selected private hosted path:

1. `apps/cli/cmd/newsjack` owns live SEC and Federal Register retrieval, bounded
   issuer discovery, raw-response and primary-document capture, optional
   rights-gated Finnhub transport, TypeSafe AI transport/validation,
   deterministic categorization and attention scoring, source lineage, and
   local audit artifacts. Finnhub is not requested by default; local or hosted
   processing is allowed only after written permission specifically covers
   storage and sending its data to TypeSafe.
2. `apps/investor-desk-newsjack` is the active Newsjack-style React desk. Its
   local server invokes the CLI and maps validated audit items into the browser
   contract. It owns local review state and watchlist editing.
3. `worker/` is the private hosted API. Vercel Node Functions call its shared
   request handler. It calls public SEC EDGAR and FederalRegister.gov directly,
   calls TypeSafe AI only with those allowed public-source inputs, and writes
   owner-scoped state and source captures to Turso/libSQL. It cannot launch the
   Go CLI or use local SQLite.

`apps/investor-desk-legacy` is an archived intermediate dashboard and is not an
active product path.

The browser never receives provider credentials and is not the authority for
financial facts. Source observations, typed issuer/agency identity, TypeSafe
judgments, deterministic categories/lanes, delivery/freshness, and human review
state remain distinct. SEC search resolves company names/tickers to SEC
identifiers behind the scenes. The official SEC exchange directory supports
broad search, while a separate rolling scan covers at most 1,000 active issuers;
neither is the investor's curated watchlist.

The hosted desk has four scopes: personal watchlist, the rolling SEC public-
issuer scan, Federal Register, or the combined SEC/Federal wire. The official
SEC exchange directory provides broad searchable company coverage; it is not a
claim that every issuer was scanned in each pass. Refreshes are bounded; the
open page triggers another slice every ten minutes, while persisted cursors
resume after interruption. There is no scheduled refresh claim. The Worker
enforces its 45-subrequest budget and the SEC/Federal per-refresh caps. An
incomplete index read marks the source degraded and identifies missing pages.
Event history is paged 20 at a time with a version-bound keyset cursor;
catalog changes invalidate the cursor explicitly. Snapshot reads bracket
watchlist/page state with one catalog revision, and event JSON is bounded to
96 KiB before storage.

Finnhub content requests are explicitly disabled until provider rights and
written permission cover third-party TypeSafe processing. The user authorized
the Finnhub API key to be stored as an encrypted production-only runtime value;
`FINNHUB_PROCESSING_APPROVED=false` ensures that possession does not enable any
content request. No EODHD or Bloomberg data is used.
FederalRegister.gov XML is informational; verify the official edition on
govinfo before legal reliance. No source gap is silently replaced by a paid feed.

Vercel Authentication is configured to protect every deployment URL, and the
project owner is the only team member. The hosted server uses a fixed
application owner namespace and ignores caller-supplied identity headers. The
user authorized production-only encrypted TypeSafe, Finnhub, SEC contact, and
Turso runtime settings; Finnhub processing remains explicitly disabled. Source
reads, screening, reviews, and API responses are bounded and validated at
their boundaries. Idempotent writes reject older observations and preserve
review state. Review saves compare-and-set against the exact version shown to
the user; stale concurrent edits return the latest saved review rather than
overwriting it.

The production path remains the release gate. Exercise it in Codex's native
browser with real company filings and Federal Register records, TypeSafe
judgments, source links, persistent watchlist/review state, protected access,
and provider-failure behavior. Earlier local SEC HTTP 403 results do not
establish production behavior. Make no live-production claim until the deployed
consumer checks pass.
