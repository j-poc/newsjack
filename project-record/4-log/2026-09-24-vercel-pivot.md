# Vercel hosting pivot — 2026-09-24

## User choice

The user explicitly rejected ChatGPT Sites as the product host, declined paid
Cloudflare, selected Vercel, and accepted the Turso integration's legal terms.
No new product capabilities or provider sources are in scope.

## External state verified

- Vercel project `newsjack-investor-desk` exists in the user's Hobby team; its
  Vercel Authentication setting protects all deployments. The 2026-09-09
  official changelog confirms this setting is available on every plan without
  additional cost: <https://vercel.com/changelog/protect-production-deployments-for-free-on-every-plan>.
- Team membership readback contains only the owner account. `gitForkProtection`
  is enabled. Production/preview/alias access still needs a negative deployed
  request check before claiming the product is private in operation.
- Turso marketplace terms were accepted by the user. A `starter` ($0/month)
  Turso database resource named `newsjack-investor-desk` was provisioned in
  `iad1`, then connected only to the Newsjack project's Production environment.
  Its integration variables are Vercel `sensitive`, target only `production`,
  and are not readable through Vercel's dashboard/CLI. No local env pull was
  done and no values were read. The resource's allowed-environment setting is
  also Production only. No paid plan, overage, Blob store, or paid Vercel
  feature was enabled.
- Source branch and published commit remain `codex/investor-release` at
  `a80fa09df45d4b250adf8b8425b971ad4d3a0b4a`; no Vercel app deployment has
  been built or published yet.

## Architecture decision — pending implementation

GPT-6 Astra recommended adapting the existing Worker/domain logic to Vercel
Node Functions, retaining Vite and using Turso/libSQL to preserve SQLite SQL and
short atomic write batches. GPT-6 Luna's code inventory independently found the
local Express/SQLite/Go-CLI path is not a safe serverless substitute. The
coordinator chose this narrow adapter over a rewrite. A fixed internal owner
namespace is acceptable only behind the verified owner-only Vercel perimeter;
incoming identity headers are untrusted. Previews must not receive production
secrets or mutate production data.

Private, content-addressed R2 captures are provisionally mapped to Turso BLOB
rows in the already provisioned resource, not to a new storage provider. This
choice is not production-verified: test actual remote transaction semantics,
representative payload size, digest-checked replay, and quota failure before
using it for live records. It must fail closed on size/storage errors. Add an
overall request deadline that preserves time for final checkpoint commits.

Official references consulted:

- Turso TypeScript API: <https://docs.turso.tech/sdk/ts/reference> (atomic
  write batches; `@libsql/client` production-ready; HTTP-compatible web entry).
- Turso Free plan: <https://turso.tech/pricing> (current published quotas are
  bounded; do not upgrade or enable overages).
- Vercel Function limits:
  <https://vercel.com/docs/functions/limitations> (4.5 MiB request and response
  bodies, Hobby duration ceilings).
- Vercel Node runtime:
  <https://vercel.com/docs/functions/runtimes/node-js>.

## Unresolved acceptance gates

- Runtime adapter, production routes, and idempotent Turso migrations are not
  implemented or built yet.
- TypeSafe secret has not been transferred to Vercel; TypeSafe is therefore
  not yet verified through the Vercel consumer path. Finnhub remains disabled
  pending source-rights clearance and explicit TypeSafe processing permission.
- No Vercel production deployment, public-company fetch, federal fetch,
  TypeSafe judgment, watchlist write/reload, permission-denial check, real UI
  review, or recovery test has passed in this pivot.
- Prior ChatGPT-hosted UI is not a deployment target. Its possible user state
  must not be declared migrated or absent without evidence.

This record distinguishes provider research and hosting setup from implemented
or verified product behavior.
