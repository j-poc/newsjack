# Investor edition epic

## User outcome

An investor opens a private Newsjack-style desk, gets a live first-read queue of
public-company SEC filings and federal records screened by TypeSafe AI, opens
the primary evidence, and leaves review notes without mistaking a model's
priority for an investment decision.

## Acceptance criteria

- The UI is built on the existing `elvisun/newsjack` fork and follows the
  user-supplied News Desk Dealer reference: editorial masthead, compact source
  telemetry, horizontal wire, a focused selected-record readout, and dense
  category desks. The screenshot is a binding composition/style reference, not
  a requirement to reproduce its fictional provider metrics or sample headlines.
- No fictional or seeded records appear in the product. Tests may use fixtures,
  but the consumer UI receives only real captured provider records.
- The app starts a bounded live refresh on open and repeats while the desk is
  open; successful slices preserve a durable checkpoint and resume on later
  refreshes. It makes no claim of updating while closed.
- The personal watchlist is searchable by company name or ticker, resolves SEC
  identity automatically, and remains separate from the broad SEC directory
  and its 1,000-issuer rolling filing scan.
- SEC filings, Federal Register records, and TypeSafe screening expose distinct
  availability, freshness, provenance, and failure states. Incomplete Federal
  Register pagination is visibly degraded; no partial slice is called complete.
- FederalRegister.gov records link to their source and disclose that legal
  reliance requires checking the official govinfo edition.
- TypeSafe judgments remain inspectable and separate from deterministic lanes,
  scoring, source facts, and human review. The investor makes every investment
  decision. TypeSafe selects each first-read headline from every eligible
  sentence in the bounded captured source, using exhaustive grouped selection
  when a direct choice would be too large; the app does not sample away
  candidates, generate unsupported prose, or relabel the filing document title
  as a summary. Known truncation discards the boundary sentence even when it
  appears to end in punctuation, and failed multi-stage selection is withheld
  for retry.
- Missing credentials, source failures, malformed model output, incomplete
  evidence, and empty watchlists produce actionable states, never fake success.
- Watchlist and review notes survive refresh and worker restart; authenticated
  owner boundaries isolate all durable records.
- Finnhub content remains off until provider rights and written permission
  permit third-party TypeSafe processing. Its API key is stored only as an
  encrypted app secret with processing explicitly disabled. No paid EODHD or
  Bloomberg feed is used.
