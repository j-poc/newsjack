# SEC durable-work design loop

## Phase A — Frame

- Artifact: one durable Worker/D1 design for SEC issuer-discovery retries and filing-screening backlog.
- Success: stable caller flow, owner-scoped/idempotent persistence, bounded request and D1 writes, fair retries, and recoverable seven-day-window backlog.
- Acceptance cases: normal multi-issuer scan; duplicate submissions; more filings than one screening slice; restart after discovery and after screening; a filing still processable after eight days; transient/permanent issuer failure without blocking healthy issuers; storage failure with no lost cursor; watchlist-only scope; exhausted request budget.
- Limits: no secrets, Finnhub content, paid market data, public deployment, background scheduler, or exhibit crawling before production SEC access is proven.

## Phase B — Fan out

- Candidate 1: caller-first design sketch, output `candidate-1/design.md`.
- Candidate 2: independently authored caller-first design sketch, output `candidate-2/design.md`.
- Existing Astra review is an independent advisory input, not a coding instruction.

## Phase C — Cross-judge

- Compare candidate designs against: no filing loss across the seven-day cutoff; one failing issuer cannot starve healthy issuers; idempotent replay/restart; 45-subrequest/90-statement budgets; simple boundaries; watchlist/public scope semantics.

## Phase D — Pick and synthesize

- Record the base, one or two grafts, and rejected complexity in `synthesis.md`.
- Proceed directly to implementation; no human checkpoint was requested.

## Phase E — Verify

- Worker tests: >1,000 issuer directory; Cboe/search universe; cursor rotation; accession backlog survives eight days; duplicate enqueue; failed filing backoff; failed issuer retry fairness; D1 rollback; watchlist scope isolation; request-budget exhaustion.
- Run Worker tests/typecheck/build and direct localhost/native-browser verification with real Federal Register + TypeSafe only; live SEC remains separately unverified if 403 persists.
