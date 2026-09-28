# Grounding: current SEC refresh path

## Traced ownership

- `worker/index.ts` authenticates the Site owner, enforces refresh cooldown and owner lock, invokes `refreshLiveSources`, and calls `InvestorRepository.recordRefresh`.
- `worker/providers.ts` fetches the SEC directory, rotates a bounded issuer slice, reads submissions, filters allowed forms over a seven-day window, fetches primary documents, and screens them with TypeSafe.
- `worker/repository.ts` owns owner-scoped D1 state. `recordRefresh` writes events, captures, screening runs, health, cursors, and `lastRefreshAt` in one batch capped at 90 statements.
- `worker/capture.ts` stores source response bytes in R2 and returns digest/provenance for D1.
- `drizzle/0000_last_blink.sql` and `0001_screening_contract.sql` define current state. `worker/schema.ts` mirrors tables.

## Current constraints and gaps

- SEC submissions are reduced to a seven-day eligible window before screening. At most two new accessions per issuer are selected per refresh, with one slot potentially used for revalidation.
- The public cursor is issuer-only. If any selected issuer fails, the whole batch cursor stays fixed; there is no per-issuer retry/backoff state.
- Unscreened filings are inferred from missing `screening_runs_v2` rows. There is no durable, inspectable pending accession queue, so an unvisited issuer's older filing may fall outside the seven-day window before its next visit.
- SEC attachment/exhibit bodies are not captured. Current TypeSafe input and visible evidence must remain explicitly incomplete and route the record to human review.
- `RequestBudget` caps a refresh at 45 explicit outbound fetches; TypeSafe retries once for retryable failures. Final D1 refresh batch caps at 90 statements. D1 may hold up to 100 statements in one batch; use smaller chunks for separate queue writes.
- D1 lock is owner-scoped. R2 writes can survive a later D1 failure as orphaned captures; queue transitions must be retry-safe.
- Public SEC live smoke returned 403; no production SEC consumer-path evidence exists. Do not use fixtures as proof of SEC access.

## Candidate rubric

1. Discovered filing accessions persist beyond the live seven-day SEC response window.
2. Repeated submissions, worker retries, and restarts converge without duplicate events or loss of user review state.
3. A failing issuer/filing has bounded retry/backoff and cannot monopolize the whole public rotation.
4. Cursor advancement occurs only after new discovery or retry obligations are durably recorded.
5. Caller learns one stable workflow; provider transport and D1 row shapes remain private.
6. Worst-case subrequests, D1 statement counts, owner scope, and watchlist semantics are explicit and bounded.
