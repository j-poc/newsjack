# Newsjack UI pivot

## Decision

Create a new `apps/investor-desk-newsjack` folder from the repository's own
`news-desk-dealer` visual vocabulary. Archive the previous dashboard rather than
continue modifying its generic SaaS shell.

## Why

The user valued Newsjack's composition, not only its data flow. Retrofitting the
old sidebar/card dashboard would preserve the wrong interaction model and make
the visual reference increasingly ambiguous. The new surface can use the same
React/Vite family while keeping the CLI as the single source of analytical truth.

## Verification plan

- TypeScript typecheck and production build.
- Go CLI package tests, including investor scan validation and failure paths.
- Server health/snapshot smoke test with an empty watchlist.
- Fail-closed refresh check with a watchlist but missing live prerequisites.
- Real source-scope checks for watchlist, bounded all-public SEC discovery,
  Federal Register, and the combined wire.
- Broad company-news checks prove the live symbol directory exceeds 500 eligible
  US common-stock listings, ticker-specific news retrieval, paced rotation,
  TypeSafe screening, resumable offsets, and no personal-watchlist mutation.
- Live SEC + TypeSafe AI scan when the SEC network path permits it; disclose any
  external-source block rather than substituting fixture data. The individual-
  company workflow must remain SEC-backed and discoverable by company name or
  ticker without manual CIK entry. Issuer identity search may use the bounded
  public CIK mapping mirror only when the official SEC directory is unavailable;
  primary filings never use the mirror.
