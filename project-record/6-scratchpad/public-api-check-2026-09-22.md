# Public API check — 2026-09-22

The global discovery reference was read from
`/Users/jurgis/.codex/references/trading-investing-apis.md`. It is a list of
investigation leads, not approval to use a provider. SEC is the selected free
public source for individual-company records. The official issuer directory
(`company_tickers_exchange.json`) and SEC `data.sec.gov` submissions/archive
endpoints were tested with a descriptive contactable User-Agent and returned
live issuer/filing payloads. The product does not use EODHD or Bloomberg as a
source.

- Directory: https://www.sec.gov/files/company_tickers_exchange.json
- Submissions: https://data.sec.gov/submissions/
- Archive: https://www.sec.gov/Archives/edgar/data
- Integration state: live issuer search resolves name/ticker to CIK in the
  server; the Go scan captures raw submissions and primary documents, then
  sends the captured text to TypeSafe AI for typed screening.
- Access state: SEC requests require a descriptive, contactable User-Agent;
  missing or rejected access is disclosed and never replaced with fixture data.

Finnhub was checked as the non-EODHD company-news fallback listed in the global
API discovery reference. Its official documentation describes free APIs, and a
live authenticated request returned the public US symbol directory and company
news payloads. It is retained as a separately labeled secondary stream, not as
a replacement for SEC primary filings. Account limits and display rights remain
provider-controlled.

Financial Modeling Prep was not selected because the configured legacy endpoint
returned a provider error stating that the legacy endpoint is no longer
supported. No provider response is converted into placeholder company data.

When SEC returned HTTP 403 for issuer-directory requests, the UI identity
search was given a public, daily SEC-derived CIK mapping mirror as a bounded
fallback. It resolves only name/ticker/exchange to CIK for the watchlist picker;
SEC submissions, primary documents, and financial facts still require official
SEC endpoints. This avoids asking users for CIKs without weakening filing
provenance.
