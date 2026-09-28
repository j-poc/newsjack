# Signal Desk

Signal Desk is a local research queue for public-equity monitoring. It discovers recent SEC submissions, retrieves and caches bounded primary-document text, sends each evidence-backed candidate through the live JEv typed-decision API, deterministically ranks the returned scores, and lets you inspect the source, record a review, snooze a signal, or dismiss it.

The product answers one question: "What changed in the evidence for the companies I follow, and what deserves a closer read?"

## Start the app

Use Node.js 22.13 or newer.

```sh
pnpm install
pnpm dev
```

Open [http://localhost:5180](http://localhost:5180). Set a JEv key, then click **Refresh SEC** to load and screen public filings. The app starts with an empty event store and never seeds demo signals.

The API listens on port `8789`. Set `PORT` to change it. Vite proxies `/api` to that port during development.

## Store data in a known directory

Signal Desk stores its SQLite database in `./data` by default. Set `SIGNAL_DESK_DATA_DIR` to use another directory.

```sh
SIGNAL_DESK_DATA_DIR=/tmp/signal-desk pnpm start
```

The SEC requires a descriptive `User-Agent`. Set `SEC_USER_AGENT` when you run a shared or deployed instance.

```sh
SEC_USER_AGENT="Your Name research@example.com" pnpm start
```

JEv is a hosted API. The key is read only by the local server and is never sent to the browser. Configure it before refreshing:

```sh
TYPESAFE_API_KEY="your-typesafe-key" pnpm dev
```

JEV_API_KEY is also accepted for compatibility. The default model is jev-latest; JEV_MODEL can override it. If no key is configured, or JEv returns an invalid typed response, the refresh fails closed and no screened event is stored. See the [TypeSafe API reference](https://docs.typesafe.ai/api.md) and [model list](https://docs.typesafe.ai/models.md) for the current provider contract.

The SEC submissions API does not require an API key. It does require a compliant request rate and a descriptive `User-Agent`. Read the [SEC EDGAR API documentation](https://www.sec.gov/search-filings/edgar-application-programming-interfaces) before running frequent refreshes.

## Verify the build

```sh
pnpm typecheck
pnpm test
pnpm build
```

The tests cover screening rules, source normalization, idempotent SEC upserts, review persistence, the TypeSafe request/response contract, and fail-closed provider failure.

## Product boundaries

- SEC records include a bounded, cached primary-document text extraction for triage, but remain source references. If the document is truncated or points to an unfetched exhibit, the signal is marked incomplete and routed to review. Open the primary filing before making a research judgment.
- The attention score is a reproducible screening priority. It is not a price target, return forecast, recommendation, or trading signal.
- The first release does not ingest prices, estimates, portfolio positions, orders, or broker data.
- The first release does not send trades, messages, or alerts to third parties.
- The first release uses the live JEv API for typed triage. Code calculates the attention score from the returned typed scores. The product does not claim that JEv improves investment results.

See [`docs/finance-policy.md`](docs/finance-policy.md) for the financial correctness contract.

## Design reference

Signal Desk adapts the cheap, recall-first triage idea from [Newsjack](https://github.com/elvisun/newsjack) to public-equity source monitoring. The source project uses a coarse pass to decide what deserves an expensive pass. Signal Desk uses JEv for that typed first pass, then keeps the evidence trail and deterministic ranking beside it so the analyst can decide what to inspect.
