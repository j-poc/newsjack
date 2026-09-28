import { createHash } from "node:crypto";
import { z } from "zod";
import {
  EventSchema,
  InstantSchema,
  type Instant,
  type Issuer,
  type SourceHealth,
  type WatchlistEntry,
  eventIdForSource,
  nowIso,
} from "../../src/domain";

const RecentFilingsSchema = z.object({
  accessionNumber: z.array(z.string()).default([]),
  filingDate: z.array(z.string()).default([]),
  reportDate: z.array(z.string().nullable()).default([]),
  acceptanceDateTime: z.array(z.string()).default([]),
  form: z.array(z.string()).default([]),
  primaryDocument: z.array(z.string()).default([]),
  primaryDocDescription: z.array(z.string()).default([]),
}).passthrough();

const SubmissionSchema = z.object({
  name: z.string(),
  filings: z.object({ recent: RecentFilingsSchema }).passthrough(),
}).passthrough();

const MAX_DOCUMENT_CHARS = 20_000;
const DOCUMENT_PARSE_VERSION = "sec-text-v1";

export const SourceDocumentSchema = z.object({
  provider: z.literal("sec"),
  nativeId: z.string().min(1),
  url: z.string().url(),
  text: z.string().min(1).max(MAX_DOCUMENT_CHARS),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  fetchedAt: InstantSchema,
  parseVersion: z.literal(DOCUMENT_PARSE_VERSION),
  complete: z.boolean(),
}).strict();
export type SourceDocument = z.infer<typeof SourceDocumentSchema>;

export interface SecDocumentCache {
  getSourceDocument(provider: string, nativeId: string): SourceDocument | null;
  upsertSourceDocument(document: SourceDocument): void;
}

const SecCandidateBaseSchema = EventSchema.omit({ screening: true, review: true }).extend({
  form: z.string().min(1),
}).strict();

export const SecCandidateSchema = SecCandidateBaseSchema.extend({
  document: SourceDocumentSchema,
}).strict();
export type SecCandidate = z.infer<typeof SecCandidateSchema>;
type SecCandidateBase = z.infer<typeof SecCandidateBaseSchema>;

type SecSubmission = z.infer<typeof SubmissionSchema>;

export type SecPullResult = {
  candidates: SecCandidate[];
  health: SourceHealth;
  failures: string[];
};

function digestFor(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("|"), "utf8").digest("hex");
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = { amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: '"' };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.toLowerCase().startsWith("#x")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return named[entity.toLowerCase()] ?? match;
  });
}

function normalizeDocumentText(raw: string): string {
  return decodeHtmlEntities(raw
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<(?:br|\/p|\/div|\/tr|\/li|\/h[1-6]|\/section|\/article|\/td|\/th)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n")
    .trim();
}

function selectDocumentText(text: string): { text: string; complete: boolean } {
  if (text.length <= MAX_DOCUMENT_CHARS) return { text, complete: true };
  const headings = [...text.matchAll(/\bItem\s+\d+[A-Z]?\.\d+/gi)].map((match) => match.index ?? 0);
  const windows = headings.slice(0, 8).map((start) => text.slice(Math.max(0, start - 500), start + 2_500));
  const selected = (windows.length > 0 ? windows.join("\n") : text.slice(0, MAX_DOCUMENT_CHARS)).slice(0, MAX_DOCUMENT_CHARS).trim();
  return { text: selected, complete: false };
}

async function fetchSourceDocument(candidate: SecCandidateBase, userAgent: string, cache?: SecDocumentCache): Promise<SourceDocument> {
  const cached = cache?.getSourceDocument(candidate.source.provider, candidate.source.nativeId);
  if (cached !== undefined && cached !== null && cached.url === candidate.source.url) return SourceDocumentSchema.parse(cached);
  const response = await fetch(candidate.source.url, {
    headers: { "User-Agent": userAgent, Accept: "text/html,text/plain,application/xhtml+xml" },
  });
  if (!response.ok) throw new Error(`SEC document returned HTTP ${response.status} for ${candidate.issuer.ticker.value}`);
  const normalized = normalizeDocumentText(await response.text());
  if (normalized.length === 0) throw new Error(`SEC document contained no readable text for ${candidate.issuer.ticker.value}`);
  const selected = selectDocumentText(normalized);
  const referencesUnfetchedExhibit = /\b(?:exhibit\s+\d+|incorporated\s+(?:by|herein)\s+reference)\b/i.test(normalized);
  const document = SourceDocumentSchema.parse({
    provider: "sec",
    nativeId: candidate.source.nativeId,
    url: candidate.source.url,
    text: selected.text,
    digest: digestFor(["sec-document", candidate.source.nativeId, selected.text]),
    fetchedAt: nowIso(),
    parseVersion: DOCUMENT_PARSE_VERSION,
    complete: selected.complete && !referencesUnfetchedExhibit,
  });
  cache?.upsertSourceDocument(document);
  return document;
}

function issuerArchiveId(issuer: Issuer): string {
  return issuer.cik.value.replace(/^0+/, "") || "0";
}

function parseTime(value: string | undefined, fallbackDate: string): { instant: Instant; precision: "second" | "day" } {
  if (value !== undefined) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.valueOf())) {
      return { instant: InstantSchema.parse(parsed.toISOString()), precision: "second" };
    }
  }
  return { instant: InstantSchema.parse(`${fallbackDate}T00:00:00.000Z`), precision: "day" };
}

function toCandidate(issuer: Issuer, payload: SecSubmission, index: number, observedAt: Instant): SecCandidateBase | null {
  const recent = payload.filings.recent;
  const form = recent.form[index];
  const accession = recent.accessionNumber[index];
  const filingDate = recent.filingDate[index];
  const primaryDocument = recent.primaryDocument[index];
  if (form === undefined || accession === undefined || filingDate === undefined || primaryDocument === undefined) return null;
  const nativeId = `${accession}:${primaryDocument}`;
  const sourceUrl = `https://www.sec.gov/Archives/edgar/data/${issuerArchiveId(issuer)}/${accession.replaceAll("-", "")}/${primaryDocument}`;
  const available = parseTime(recent.acceptanceDateTime[index], filingDate);
  const description = recent.primaryDocDescription[index] ?? `${form} filing`;
  const title = `${issuer.name} filed ${form}`;
  return SecCandidateBaseSchema.parse({
    id: eventIdForSource("sec", nativeId),
    issuer,
    kind: "filing",
    title,
    summary: `${description}. Filed ${filingDate}. This signal is a source reference. Open the filing before making a research judgment.`,
    publishedAt: InstantSchema.parse(`${filingDate}T00:00:00.000Z`),
    publishedPrecision: "day",
    availableAt: available.instant,
    availablePrecision: available.precision,
    source: {
      provider: "sec",
      nativeId,
      url: sourceUrl,
      observedAt,
      availabilityAt: available.instant,
      availabilityPrecision: available.precision,
      digest: digestFor(["sec", nativeId, form, filingDate, primaryDocument]),
    },
    evidence: [{
      label: `SEC ${form} filing`,
      url: sourceUrl,
      capture: "reference",
      sourceNativeId: nativeId,
      excerpt: `${issuer.name} submitted ${form} on ${filingDate}.`,
    }],
    form,
  });
}

async function enrichCandidate(candidate: SecCandidateBase, userAgent: string, cache?: SecDocumentCache): Promise<SecCandidate> {
  const document = await fetchSourceDocument(candidate, userAgent, cache);
  const excerpt = document.text.slice(0, 1_200);
  return SecCandidateSchema.parse({
    ...candidate,
    summary: `${candidate.summary} Evidence excerpt: ${excerpt}`,
    source: { ...candidate.source, digest: document.digest },
    evidence: [{ ...candidate.evidence[0], capture: "content", excerpt }],
    document,
  });
}

async function fetchSubmission(issuer: Issuer, userAgent: string): Promise<SecSubmission> {
  const response = await fetch(`https://data.sec.gov/submissions/CIK${issuer.cik.value}.json`, {
    headers: { "User-Agent": userAgent, Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`SEC returned HTTP ${response.status} for ${issuer.ticker.value}`);
  return SubmissionSchema.parse(await response.json());
}

export async function fetchSecCandidates(watchlist: readonly WatchlistEntry[], userAgent = process.env.SEC_USER_AGENT ?? "SignalDesk/0.1 local research client", cache?: SecDocumentCache): Promise<SecPullResult> {
  const observedAt = nowIso();
  const candidates: SecCandidate[] = [];
  const failures: string[] = [];
  for (const entry of watchlist) {
    try {
      const payload = await fetchSubmission(entry.issuer, userAgent);
      const limit = Math.min(6, payload.filings.recent.form.length);
      for (let index = 0; index < limit; index += 1) {
        const candidate = toCandidate(entry.issuer, payload, index, observedAt);
        if (candidate !== null) {
          try {
            candidates.push(await enrichCandidate(candidate, userAgent, cache));
          } catch (error) {
            failures.push(error instanceof Error ? `${candidate.issuer.ticker.value} ${candidate.source.nativeId}: ${error.message}` : `${candidate.issuer.ticker.value} ${candidate.source.nativeId}: SEC document fetch failed`);
          }
        }
      }
    } catch (error) {
      failures.push(error instanceof Error ? error.message : `SEC fetch failed for ${entry.issuer.ticker.value}`);
    }
  }
  const checkedAt = nowIso();
  const health: SourceHealth = {
    provider: "sec",
    status: failures.length === 0 ? "healthy" : candidates.length > 0 ? "degraded" : "offline",
    message: failures.length === 0 ? `Loaded ${candidates.length} document-backed filing records across ${watchlist.length} issuers.` : `${candidates.length} document-backed filing records loaded. ${failures.length} document/source failures. ${failures.join(" ")}`,
    checkedAt,
  };
  return { candidates, health, failures };
}
