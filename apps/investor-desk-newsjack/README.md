# Newsjack investor desk

The Newsjack-native investor review surface follows the editorial masthead,
wire, selected-record readout, and category-desk composition in the supplied
reference. It never seeds fictional filings. The browser is a review surface;
the Go CLI is the local data authority and the private Worker is the hosted
provider boundary.

## Local run

From this directory:

```bash
pnpm install
NEWSJACK_SEC_USER_AGENT='NewsjackInvestor/0.1 (contact: your-real-contact@example.com)' pnpm dev
```

Configure `TYPESAFE_API_KEY` and a descriptive, contactable
`NEWSJACK_SEC_USER_AGENT` in the server environment. In local mode the server
invokes `newsjack investor scan`; `NEWSJACK_CLI` can point to a packaged binary,
otherwise development mode uses `go run` from the repository root. Set
`SIGNAL_DESK_DATA_DIR` to choose the local SQLite database and retained audit
runs. The default local all-public scan is bounded at 500 issuers and can be
changed deliberately with `NEWSJACK_MAX_ISSUERS`.

SEC requests are paced (default 300 ms spacing, tunable with
`--sec-request-spacing-ms`) inside the SEC's 10-requests-per-second fair-access
cap. Filing documents are immutable and cached across runs under
`data/sec-cache/`; submissions and daily-index responses carry a 5-minute TTL
(`NEWSJACK_SEC_CACHE_TTL_SUBMISSIONS_SECONDS`) and the issuer directory 24 hours
(`NEWSJACK_SEC_CACHE_TTL_DIRECTORY_SECONDS`). When SEC answers 429 — or a
rate-limit 403 — the pipeline stops asking immediately and records a 10-minute
cooldown matching the SEC's published resume window, persisted across runs in
`data/sec-cache/rate-limit-state.json`; the wire then reports the cooldown
honestly instead of hammering through the block. A 403 that names an undeclared
automated tool is reported as a configuration error, not a rate limit.

## Sources and safeguards

- SEC EDGAR is the company filings and issuer-directory source. The browser
  resolves search by company name/ticker; users do not need to enter a CIK.
- FederalRegister.gov is a public federal-record source. Hosted queries validate
  pagination and report unread pages as degraded. Its rendering is
  informational; check the official [govinfo edition](https://www.govinfo.gov/app/collection/fr)
  before legal reliance.
- The Worker scans bounded slices of the validated SEC directory and prioritizes
  the personal watchlist. Searchable issuers are not proof of fetched or screened
  filings; source health and scan progress report the actual coverage.
- TypeSafe AI validates structured judgments over permitted source text.
  Deterministic code assigns categories and priority; the investor decides.
- Finnhub company news is disabled. The user authorized its key to be stored as
  an encrypted app-only runtime secret, but `FINNHUB_PROCESSING_APPROVED` stays
  `false`; do not request or process Finnhub content until provider rights and
  written permission specifically allow third-party TypeSafe processing.
- No EODHD or Bloomberg data is used. Source errors, incomplete evidence, and
  stale observations are disclosed; no empty-success or demo records are made.

The open desk triggers bounded refreshes and repeats while it remains open.
There is no verified scheduled refresh while it is closed.

For this release, the owner explicitly authorized the existing Worker SEC
connector outside the shared local public-data module. The Worker's per-refresh
request limit and cooldown are separate from the local module's SEC quota;
they do not enforce a combined local/cloud daily budget. Retained R2 captures
support source provenance and interrupted-discovery replay, not redistribution.
