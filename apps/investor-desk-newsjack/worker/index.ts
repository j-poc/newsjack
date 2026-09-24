import {
  RefreshRequestSchema,
  ReviewUpdateSchema,
  WatchlistActionSchema,
  IssuerSchema,
  nowIso,
} from "../src/domain";
import { InvestorRepository } from "./repository";
import { refreshLiveSources, searchIssuers } from "./providers";
import { createCloudflareWorkerEnv, type CloudflareBindings } from "./cloudflare-storage";
import type { WorkerEnv } from "./types";
import { z } from "zod";

const MAX_REQUEST_BODY_BYTES = 16 * 1024;
const REFRESH_INTERVAL_MS = 60 * 1000;
const EventIdSchema = z.string().min(1).max(400).regex(/^[a-z0-9:_-]+$/i);

const worker = {
  async fetch(request: Request, bindings: CloudflareBindings): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return bindings.ASSETS.fetch(request);
    return handleApiRequest(request, createCloudflareWorkerEnv(bindings), readOwnerId(request), "private-worker");
  },
} satisfies ExportedHandler<CloudflareBindings>;

export async function handleApiRequest(
  request: Request,
  env: WorkerEnv,
  ownerId: string,
  runtime: "private-worker" | "private-vercel" = "private-worker",
): Promise<Response> {
    const url = new URL(request.url);
    if (!isValidOwnerId(ownerId)) return json({ error: "Sign in through the private Newsjack deployment to access this desk." }, 401);
    if (request.method !== "GET" && !isSameOriginWrite(request, url)) return json({ error: "This request did not come from the Newsjack Site." }, 403);

    const repository = new InvestorRepository(env, ownerId);
    try {
      if (request.method === "GET" && url.pathname === "/api/health") {
        return json({
          status: "ok",
          service: "newsjack-investor-desk",
          at: nowIso(),
          runtime,
          configured: {
            typesafe: Boolean(env.TYPESAFE_API_KEY?.trim()),
            finnhub: Boolean(env.FINNHUB_PROCESSING_APPROVED === "true" && env.FINNHUB_API_KEY?.trim()),
            secContact: Boolean(env.NEWSJACK_SEC_USER_AGENT?.trim()),
          },
        });
      }

      if (request.method === "GET" && url.pathname === "/api/snapshot") {
        return json(await repository.getSnapshot());
      }

      if (request.method === "GET" && url.pathname === "/api/issuers/search") {
        const query = url.searchParams.get("q") ?? "";
        try {
          return json(await searchIssuers(env, ownerId, repository, query));
        } catch {
          return json({ error: "The live SEC issuer directory and its identity-only fallback could not be read." }, 502);
        }
      }

      if (request.method === "POST" && url.pathname === "/api/refresh") {
        return await refresh(request, env, repository, ownerId);
      }

      if (request.method === "POST" && url.pathname === "/api/watchlist") {
        const body = await readJson(request);
        if (body instanceof Response) return body;
        const parsed = WatchlistActionSchema.safeParse(body);
        if (!parsed.success) return json({ error: "Expected a valid watchlist action and a company identity from issuer search." }, 400);
        const issuer = IssuerSchema.parse(parsed.data.issuer);
        if (parsed.data.action === "add") await repository.addWatchlist(issuer, nowIso());
        else await repository.removeWatchlist(issuer);
        return json(await repository.getSnapshot());
      }

      const reviewMatch = /^\/api\/events\/([^/]+)\/review$/.exec(url.pathname);
      if (request.method === "POST" && reviewMatch !== null) {
        let eventId: string;
        try {
          eventId = decodeURIComponent(reviewMatch[1] ?? "");
        } catch {
          return json({ error: "The event identity is invalid." }, 400);
        }
        if (!EventIdSchema.safeParse(eventId).success) return json({ error: "The event identity is invalid." }, 400);
        const body = await readJson(request);
        if (body instanceof Response) return body;
        const parsed = ReviewUpdateSchema.safeParse(body);
        if (!parsed.success) return json({ error: "Expected a valid review status and note." }, 400);
        const changed = await repository.updateReview(eventId, parsed.data, nowIso());
        if (!changed) return json({ error: "That record is not in your private desk." }, 404);
        const snapshot = await repository.getSnapshot();
        const event = snapshot.events.find((item) => item.id === eventId);
        if (event === undefined) return json({ error: "The record changed while its review was being saved." }, 409);
        return json({ event, snapshot });
      }

      return json({ error: "This Newsjack API route does not exist." }, 404);
    } catch {
      return json({ error: "The request could not finish. A save may already have completed. Reload the desk to confirm its saved state before retrying." }, 500);
    }
}

export default worker;

async function refresh(request: Request, env: WorkerEnv, repository: InvestorRepository, ownerId: string): Promise<Response> {
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const parsed = RefreshRequestSchema.safeParse(body);
  if (!parsed.success) return json({ error: "Expected a source scope: watchlist, all_public, company_news, federal, or all." }, 400);

  const initialSnapshot = await repository.getSnapshot();
  if (parsed.data.source === "company_news") {
    return json({
      error: "Finnhub company news is disabled until written approval permits third-party TypeSafe processing. No Finnhub request was made.",
      snapshot: initialSnapshot,
    }, 409);
  }
  if (parsed.data.source === "watchlist" && initialSnapshot.watchlist.length === 0) {
    return json({ error: "Your watchlist is empty. Add companies by name or ticker, or choose a broader source scope.", snapshot: initialSnapshot }, 409);
  }

  const now = nowIso();
  const previousAttempt = await repository.getMeta("lastRefreshAttemptAt");
  if (previousAttempt !== null) {
    const age = Date.parse(now) - Date.parse(previousAttempt);
    if (!Number.isFinite(age)) return json({ error: "Saved refresh-throttle state is invalid; source requests are paused to protect your provider limits.", snapshot: initialSnapshot }, 503);
    if (age >= 0 && age < REFRESH_INTERVAL_MS) {
      return json({ error: "A source refresh was just attempted. Wait briefly before requesting another TypeSafe and provider pass.", snapshot: initialSnapshot }, 429);
    }
  }

  const lockToken = crypto.randomUUID();
  if (!await repository.acquireRefreshLock(lockToken, now)) {
    return json({ error: "Another refresh is already running for your private desk. Its results will appear when the batch commits.", snapshot: initialSnapshot }, 409);
  }
  try {
    await repository.recordRefreshAttempt(now);
    const result = await refreshLiveSources(env, ownerId, repository, parsed.data.source, lockToken);
    await repository.recordRefresh(result, lockToken);
    const snapshot = await repository.getSnapshot();
    if (result.failures.length > 0 && result.events.length === 0) {
      return json({ error: `No new record passed the live source and TypeSafe checks. ${result.failures.slice(0, 2).join(" ")}`, snapshot }, 502);
    }
    return json(snapshot);
  } catch {
    return json({ error: "The live refresh stopped before completion. Some work may already be saved; the desk will resume pending work after the short cooldown." , snapshot: await repository.getSnapshot() }, 502);
  } finally {
    await repository.releaseRefreshLock(lockToken);
  }
}

function readOwnerId(request: Request): string {
  return request.headers.get("oai-authenticated-user-id")?.trim() ?? "";
}

function isValidOwnerId(ownerId: string): boolean {
  return ownerId.length >= 1 && ownerId.length <= 256 && !/[\u0000-\u001f\u007f]/.test(ownerId);
}

function isSameOriginWrite(request: Request, url: URL): boolean {
  if (request.headers.get("sec-fetch-site")?.toLowerCase() === "cross-site") return false;
  const origin = request.headers.get("origin");
  return origin === null || origin === url.origin;
}

async function readJson(request: Request): Promise<unknown | Response> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") return json({ error: "This endpoint accepts JSON requests only." }, 415);
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BODY_BYTES) return json({ error: "Request body exceeds the 16 KiB limit." }, 413);
  if (request.body === null) return json({ error: "Request body is required." }, 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > MAX_REQUEST_BODY_BYTES) {
        await reader.cancel();
        return json({ error: "Request body exceeds the 16 KiB limit." }, 413);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return json({ error: "Request body is not valid JSON." }, 400);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store, max-age=0",
      "Pragma": "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
    },
  });
}
