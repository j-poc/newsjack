#!/usr/bin/env bash
# Bundle each Vercel API function into a self-contained file. Vercel's
# function tracing leaves cross-directory relative imports unresolved at
# runtime; a pre-bundled function has nothing left to resolve. @libsql/client
# stays external (its native binding is included via vercel.json).
set -euo pipefail
esbuild="$(command -v esbuild || echo ./node_modules/.bin/esbuild)"
targets=(
  "api/events.ts"
  "api/health.ts"
  "api/snapshot.ts"
  "api/refresh.ts"
  "api/watchlist.ts"
  "api/events/[id]/review.ts"
  "api/issuers/search.ts"
)
for target in "${targets[@]}"; do
  out="${target%.ts}.js"
  "$esbuild" "$target" --bundle --platform=node --format=cjs --target=node20 \
    --outfile="$out" --external:@libsql/client --external:libsql \
    --log-level=warning
  rm "$target"
done
