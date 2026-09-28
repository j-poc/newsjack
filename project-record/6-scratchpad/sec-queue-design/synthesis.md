# SEC durable queue — architecture decision

## Decision

Use Candidate 2's owner-scoped accession queue and separate issuer retry state,
but keep the implementation inside the current `providers.ts` coordinator and
`InvestorRepository` unless extraction materially clarifies ownership. Do not
add generic queue facades, filing leases, scope masks, or a workflow engine.

The queue makes already-discovered filings durable beyond the application's
seven-day eligibility filter. It does not claim to discover issuers that the
rolling scan has not visited. Public refresh selects public-eligible work;
watchlist refresh selects work only for CIKs currently on that owner's list.
Shared accession identity avoids duplicate screenings.

## Astra cross-judge corrections

- Fence refresh writes with the current lock token in D1, not a JavaScript-only
  check. Renew only while the token still owns an unexpired lock; stale work
  must not advance cursors or commit screening/queue transitions. Renew before
  provider requests so an expired worker stops spending outbound budget.
- Preserve the existing revalidation cadence and exact screening identity:
  SEC metadata version, captured document digest, and TypeSafe contract digest.
  A hash identifies a version but does not prove which source version is newer;
  a stale queued generation must not overwrite a later committed one.
- Bound filings using the existing shared `RequestBudget`; reserve capacity
  before starting concurrent fetches. Retry issuers use slots within the issuer
  slice. Budget exhaustion is a deferral, never a provider failure/backoff.
- Persist each selected issuer's accession obligations before committing the
  cursor. Persist submission-capture metadata alongside the discovered rows.
  Chunk replay must be idempotent and preserve attempts, generations, and
  review notes.
- Commit each filing's event, screening, capture references, and completion or
  retry transition together, with expected-generation and lock-token guards.
- Public scan is directory-backed. Watchlist scan is limited to currently
  watched CIKs; removing an issuer retains evidence and queue metadata, while
  re-adding it restores eligibility. No terminal dead-letter state without a
  tested recovery path.
- Change the refresh error copy if partial durable queue progress makes a
  blanket “nothing committed” statement inaccurate.

## Bounded request plan

The 45-request cap counts explicit outbound fetches, not deployed runtime
subrequests such as redirects or storage. Current worst-case SEC plans are:

| Refresh | Discovery | Filing processing | SEC total |
|---|---:|---:|---:|
| Public | 1 directory + up to 8 submissions | up to 6 × (document + 2 TypeSafe attempts) | 27 |
| Watchlist | up to 8 submissions | up to 6 × (document + 2 TypeSafe attempts) | 26 |
| Combined | 1 directory + up to 3 submissions | up to 6 × (document + 2 TypeSafe attempts) | 22 |

Combined Federal work is currently capped at two documents, with at most five
index pages: 5 + 2 × 3 = 11 more requests, for a planned total of 33. The six-
filing cap leaves margin under the shared 45-fetch policy for variable retry
and non-SEC work; `RequestBudget.remaining` still governs every selection.

## Deliberately deferred

No production SEC-access claim, exhibit crawler, background scheduler, bulk
history, TypeSafe accuracy claim, or paid provider is added. SEC evidence stays
primary-document-only and human-reviewable. Live private Worker verification
and production release remain separately blocked by existing authorization,
binding, and source-access evidence.

## Local acceptance tests

The implemented six-filing cap produces the stated totals: public 1 + 8 + 6×3
= 27, watchlist 8 + 6×3 = 26, and combined SEC 1 + 3 + 6×3 = 22, before up to
11 combined Federal fetches. The local shared-budget guard remains authoritative.

The D1-backed Worker suite now covers eight-day queue survival, duplicate
discovery/replay with retry preservation, issuer retry fairness, filing
backoff, per-issuer cap, watchlist remove/re-add, owner isolation, partial chunk
failure with unchanged cursor, expired-lock refusal between chunks, stale-lock
fencing, same-document screening reuse, changed metadata/document/contract
re-screening, retained human notes, and request-budget deferral. These checks
prove local adapter behavior only; keep them separate from live SEC
verification.
