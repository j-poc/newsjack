# Investor edition architecture

Status: selected architecture for the `j-poc/newsjack` fork; production
deployment remains unverified.

## Outcome and workflow

The desk answers one repeatable question: **which new public-company filings
and federal records deserve a first read, within the scope I choose?** It opens
on a real bounded refresh, presents source-linked evidence in a Newsjack-style
editorial wire, and keeps company/ticker watchlist, model judgment, deterministic
ranking, and human review separate.

## Local and hosted paths

- The Go CLI remains the local authority for SEC and Federal Register reads,
  normalization, capture, TypeSafe transport, and reproducible audit output.
- `apps/investor-desk-newsjack` is the active React review surface. Locally its
  Express adapter invokes the CLI; hosted it calls same-origin Worker routes.
- The hosted Cloudflare Worker cannot launch Go or use local SQLite, so its
  adapters are separate and tested against the shared domain contract. D1
  stores owner-scoped watchlist, review, source health, and scan checkpoint;
  R2 stores private content-addressed source captures.
- Site identity is checked at the Worker boundary and every D1 query is scoped
  to that owner. Browser code never receives source credentials.

The private Site is the selected existing no-new-host path. A container would
preserve the local process but no authorized included-cost host is configured.
A static UI against localhost has no production data path. A scheduled Actions
job would add an unverified identity boundary and credential risk. The Site
choice is conditional on real gateway, included-limit, and recovery evidence.

## Source contract

- SEC EDGAR provides the official exchange-listed company directory, submissions,
  and primary documents. The user searches by name/ticker; SEC identity is
  resolved internally. The complete searchable directory, bounded rolling
  scan, and personal watchlist are distinct.
- FederalRegister.gov provides informational federal record renditions. The
  query covers seven days, requests only selected fields, validates result/page
  metadata, and reads at most five pages of 1,000 results per refresh. Missing
  pages or malformed records produce degraded health. Legal reliance requires
  checking the official edition in govinfo.
- TypeSafe AI receives only permitted SEC/Federal source text by default. Its
  typed judgments are validated and source-bound; application code owns scores
  and category lanes; the investor owns investment decisions.
- Finnhub content is disabled in the hosted path until provider rights and
  written permission expressly cover sending its content to TypeSafe. Its API
  key is stored as an encrypted app-only runtime secret, with processing set to
  false; the key alone does not enable requests.
  No EODHD or Bloomberg data is used.

Every provider observation preserves native identity, source URL, retrieval and
observation/publication/availability times with supported precision, digest,
adapter version, network delivery state, and validation/completeness. Retrieval
time never substitutes for the source's filing or publication time.

## Bounded operation and recovery

The Worker caps each invocation at 45 outbound subrequests and uses bounded
source slices: 8 SEC issuers in public-only scope, 3 SEC issuers in a combined
scope, and at most 3 Federal Register records. The open desk starts a refresh
on load and repeats every ten minutes while open. Durable cursors resume later
slices after interruption; no scheduled or while-closed refresh is claimed.

Raw responses are captured before normalization where retention permits.
Idempotent D1 writes use provider-native identity and observation order, keeping
review notes intact on replay. A five-minute owner-scoped compare-and-set lock
guards concurrent refreshes. Failed, malformed, or incomplete batches retain
the last accepted data and do not advance the associated cursor. The UI
distinguishes source health from TypeSafe health and indicates incomplete
pagination. Rollback uses a prior saved Site version and additive migrations;
it does not remove customer data.

## Financial and AI boundaries

Model outputs are research triage, not valuations, forecasts, trade
instructions, or performance claims. Missing evidence and low-confidence model
answers stay in human review. Source facts, model judgments, deterministic
calculations, and notes have distinct owners and lineage. No orders, positions,
or automated portfolio actions are in scope.

## Deferred

Price and portfolio data, targets, orders, backtests, issuer-history joins,
automatic alerts, and SEC exhibit crawling remain outside this release. No
scheduled refresh is claimed until an authorized runtime proves it.
