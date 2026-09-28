# Public-company coverage and attribution — 2026-09-23

## Decision

The personal watchlist remains user-curated; it is not prefilled with 500
issuers. Broad public-company coverage is represented separately by the live
Finnhub US common-stock listing directory. The observed directory contained
4,755 eligible listings (not necessarily 4,755 distinct legal companies). A
refresh queries a paced rolling subset: the production default is 50 listings
per ten-minute refresh, so a full pass takes about 16 hours while the desk is
open. The coverage UI must show directory size, current-pass progress, and
personal-watchlist size as different measures.

## Changes and verification

- Tightened the TypeSafe Noul attribution instruction: roundups that mention a
  company only in passing should not become that company's story. Probabilities
  below 0.80 stay in the run audit, including source headline, summary excerpt,
  probability, and raw-source lineage.
- Company-news card titles now prefer an extractive sentence about the queried
  company, remove recognized wire-service datelines, and use the captured
  publisher headline if the provider summary is only a URL. Decimal amounts
  and common company abbreviations remain intact.
- Fixed the web audit mapper to preserve TypeSafe Noul answers in public-company
  events. Before the fix, valid Go audit items containing Noul answers were
  silently dropped during conversion to the browser contract, leaving live
  coverage counts but an empty event list.
- A real Finnhub + TypeSafe CLI pass queried 10 of 4,755 eligible listings,
  received 22 articles, screened 21, retained 11 across three tickers, withheld
  10 at attribution review, and reported zero provider or TypeSafe failures.
- A real `/api/refresh {"source":"company_news"}` through the current web
  server, capped at three tickers for the smoke, returned 10 valid public-company
  events from 17 screened records, with seven withheld and Finnhub/TypeSafe
  health both `live`/`healthy`. This verified that Noul answers now survive the
  CLI-to-browser boundary. A subsequent automatic combined refresh advanced the
  persisted rotation cursor and rendered 11 live events in the browser.
- Rendered UI at `http://127.0.0.1:5195/` visibly separated 4,755 eligible
  listings, tickers queried this pass, companies with relevant stories, and the
  empty personal watchlist. The smoke server uses a temporary data directory and
  three-symbol test limit; it is verification, not the production configuration.
- `go test ./...`: passed. Investor desk TypeScript typecheck: passed. Vitest:
  6 tests passed, including public-company event mapping with Noul attribution.
  Vite production build: passed. `git diff --check` and JSON parsing: passed.

## Limitations and handoff

- The in-app page already open at `http://127.0.0.1:5193/` served an older UI and
  old records, including the pre-fix mapping behavior. It was not replaced or
  mutated. The current checkout is verified on port 5195; restart the 5193
  development processes with this checkout before treating that page as current.
- The Finnhub source is secondary and rate-limited. Broad directory eligibility
  does not mean every listing has a current news stream; the current batch is
  visible and rotates. No EODHD or Bloomberg feed was used.
- SEC and Federal Register were `unavailable` on the local web smoke path; no
  company news was represented as an SEC filing. This verification does not
  establish production deployment or source-rights clearance for redistribution.
- The persisted `live-data-etl-evidence.json` predates this code and has not been
  regenerated; its previous status is `FAIL` because the SEC live smoke was
  blocked with HTTP 403. The ETL manifest now includes focused tests for roundup
  headline selection and Noul-to-browser-contract mapping, but the full manifest
  gate was not rerun as part of this coverage clarification.
