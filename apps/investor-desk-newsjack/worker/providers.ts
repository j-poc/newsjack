import {
  AgencySchema,
  PublicIssuerCoverageSchema,
  EventSchema,
  CompanyCoverageSchema,
  IssuerSchema,
  IssuerSearchResultSchema,
  PublicCompanySchema,
  SourceHealthSchema,
  eventIdForSource,
  scoreAttention,
  type PublicIssuerCoverage,
  type Event,
  type CompanyCoverage,
  type Issuer,
  type IssuerSearchResult,
  type SourceHealth,
  type Subject,
} from "../src/domain";
import { z } from "zod";
import { CapturedProviderFailure, digestHex, fetchCaptured, readCaptured, type CapturedBody } from "./capture";
import {
  InvestorRepository,
  type ScreeningRunRecord,
  type SecFilingQueueInput,
  type SecFilingWork,
  type SecQueueIssuer,
  type SecQueueScope,
  type SecQueueTransition,
} from "./repository";
import { screeningContractDigest as getScreeningContractDigest, screenSource } from "./typesafe";
import { ProviderFailure, RequestBudget, type CaptureRecord, type WorkerEnv } from "./types";

const SEC_DIRECTORY_URL = "https://www.sec.gov/files/company_tickers_exchange.json";
const SEC_SUBMISSIONS_URL = "https://data.sec.gov/submissions/";
const SEC_ARCHIVES_URL = "https://www.sec.gov/Archives/edgar/data";
const FINNHUB_SYMBOLS_URL = "https://finnhub.io/api/v1/stock/symbol?exchange=US";
const FINNHUB_NEWS_URL = "https://finnhub.io/api/v1/company-news";
const FEDERAL_REGISTER_URL = "https://www.federalregister.gov/api/v1/documents.json";
const SEC_FORM_ALLOWLIST = new Set(["8-K", "8-K/A", "10-Q", "10-Q/A", "10-K", "10-K/A"]);
const NEWS_RELEVANCE_THRESHOLD = 0.8;
const MAX_FEDERAL_RECORDS = 3;
const MAX_FEDERAL_INDEX_RESULTS = 1_000;
const MAX_FEDERAL_INDEX_PAGES = 5;
const FEDERAL_INDEX_FIELDS = [
  "document_number",
  "title",
  "publication_date",
  "abstract",
  "type",
  "html_url",
  "raw_text_url",
  "agencies",
] as const;
const MAX_NEWS_TICKERS_PER_REFRESH = 18;
const MAX_ISSUERS_PER_PUBLIC_REFRESH = 8;
const MAX_SEC_ISSUERS_IN_COMBINED_REFRESH = 3;
const MAX_SEC_FILINGS_PER_REFRESH = 6;
const MAX_NEWS_TICKERS_IN_COMBINED_REFRESH = 8;
const MAX_WATCHLIST_ITEMS_PER_REFRESH = 8;
const MAX_SEC_TEXT_CHARS = 20_000;
const SOURCE_REVALIDATION_INTERVAL_MS = 20 * 60 * 1000;

const SecDirectoryPayloadSchema = z.object({
  fields: z.array(z.string()),
  data: z.array(z.array(z.unknown())),
}).passthrough();
const SecRecentFilingsSchema = z.object({
  form: z.array(z.string()),
  accessionNumber: z.array(z.string()),
  primaryDocument: z.array(z.string()),
  primaryDocDescription: z.array(z.string()),
  filingDate: z.array(z.string()),
  acceptanceDateTime: z.array(z.string()),
}).passthrough().superRefine((recent, context) => {
  const lengths = [recent.form.length, recent.accessionNumber.length, recent.primaryDocument.length,
    recent.primaryDocDescription.length, recent.filingDate.length, recent.acceptanceDateTime.length];
  if (new Set(lengths).size !== 1) {
    context.addIssue({ code: "custom", message: "SEC recent filing arrays have inconsistent lengths." });
    return;
  }
  for (let index = 0; index < recent.form.length; index += 1) {
    const accession = recent.accessionNumber[index] ?? "";
    const primary = recent.primaryDocument[index] ?? "";
    const filingDate = recent.filingDate[index] ?? "";
    const acceptance = recent.acceptanceDateTime[index] ?? "";
    if (recent.form[index]?.trim() === "") context.addIssue({ code: "custom", path: ["form", index], message: "SEC filing form is empty." });
    if (!/^\d{10}-\d{2}-\d{6}$/.test(accession)) context.addIssue({ code: "custom", path: ["accessionNumber", index], message: "SEC accession identity is malformed." });
    if (!/^[A-Za-z0-9._-]+$/.test(primary) || primary === "." || primary === "..") context.addIssue({ code: "custom", path: ["primaryDocument", index], message: "SEC primary document name is malformed." });
    if (dayInstant(filingDate) === null) context.addIssue({ code: "custom", path: ["filingDate", index], message: "SEC filing date is malformed." });
    if (acceptance !== "" && parseSecAcceptance(acceptance) === null) context.addIssue({ code: "custom", path: ["acceptanceDateTime", index], message: "SEC acceptance time is malformed." });
  }
});
const SecSubmissionPayloadSchema = z.object({
  filings: z.object({ recent: SecRecentFilingsSchema }).passthrough(),
}).passthrough();
const FederalIndexSchema = z.object({
  count: z.number().int().nonnegative(),
  total_pages: z.number().int().positive(),
  next_page_url: z.string().url().nullable(),
  results: z.array(z.unknown()),
}).passthrough();
const FederalAgencySchema = z.object({ name: z.string().optional(), slug: z.string().optional() }).passthrough();
const FederalDocumentPayloadSchema = z.object({
  document_number: z.string().trim().min(1),
  title: z.string().trim().min(1),
  publication_date: z.string().min(1),
  abstract: z.string().optional(),
  type: z.string().optional(),
  html_url: z.string().url(),
  raw_text_url: z.string().url().nullable().optional(),
  agencies: z.array(z.unknown()).optional(),
}).passthrough();
const FinnhubSymbolSchema = z.object({
  description: z.string().optional(),
  displaySymbol: z.string().optional(),
  exchange: z.string().optional(),
  mic: z.string().optional(),
  symbol: z.string().optional(),
  type: z.string().optional(),
}).passthrough();
const FinnhubArticleSchema = z.object({
  datetime: z.number().finite().nonnegative(),
  headline: z.string().trim().min(1),
  id: z.number().int().positive(),
  source: z.string().optional(),
  summary: z.string().optional(),
  url: z.string().url(),
}).passthrough();

type SecIssuer = IssuerSearchResult;
type Provider = "sec" | "federal_register" | "finnhub_news";
type RefreshScope = "watchlist" | "all_public" | "federal" | "all";

interface FederalDocument {
  documentNumber: string;
  title: string;
  publicationDate: string;
  abstract: string;
  type: string;
  htmlUrl: string;
  rawTextUrl: string;
  agencyName: string;
  agencyCode: string;
}

interface FinnhubSymbol {
  symbol: string;
  name: string;
}

export interface RefreshResult {
  events: Event[];
  captures: CaptureRecord[];
  screenings: ScreeningRunRecord[];
  health: SourceHealth[];
  meta: Array<{ key: string; value: string }>;
  failures: string[];
  refreshedAt: string;
  secQueueTransitions: SecQueueTransition[];
  secIssuerRetriesCleared: Array<{ scope: SecQueueScope; cik: string }>;
  secObservationTouches: Array<{ nativeId: string; sourceDigest: string; observedAt: string }>;
  secScreeningTouches: Array<{ nativeId: string; sourceDigest: string; sourceVersionDigest: string; contractDigest: string; validatedAt: string }>;
}

interface Pipeline {
  env: WorkerEnv;
  ownerId: string;
  lockToken: string;
  repository: InvestorRepository;
  budget: RequestBudget;
  screeningContractDigest: string;
  result: RefreshResult;
  screeningSucceeded: number;
  screeningFailed: number;
  screeningAttempts: number;
  lastFinnhubRequestAt: number | null;
  sourceErrors: Map<Provider, string[]>;
  sourceSuccesses: Map<Provider, number>;
}

let cachedSecDirectory: { expiresAt: number; entries: SecIssuer[] } | null = null;

export async function refreshLiveSources(
  env: WorkerEnv,
  ownerId: string,
  repository: InvestorRepository,
  scope: RefreshScope,
  lockToken: string,
): Promise<RefreshResult> {
  const refreshedAt = new Date().toISOString();
  const activeScreeningContract = await getScreeningContractDigest("sec");
  const pipeline: Pipeline = {
    env,
    ownerId,
    lockToken,
    repository,
    budget: new RequestBudget(45),
    screeningContractDigest: activeScreeningContract,
    result: {
      events: [], captures: [], screenings: [], health: [], meta: [], failures: [], refreshedAt,
      secQueueTransitions: [], secIssuerRetriesCleared: [], secObservationTouches: [], secScreeningTouches: [],
    },
    screeningSucceeded: 0,
    screeningFailed: 0,
    screeningAttempts: 0,
    lastFinnhubRequestAt: null,
    sourceErrors: new Map(),
    sourceSuccesses: new Map(),
  };

  if (scope === "all_public" || scope === "all") await collectPublicSec(pipeline, scope === "all" ? MAX_SEC_ISSUERS_IN_COMBINED_REFRESH : MAX_ISSUERS_PER_PUBLIC_REFRESH);
  if (scope === "watchlist") await collectWatchlistSec(pipeline);
  if (scope === "federal" || scope === "all") await collectFederalRegister(pipeline, scope === "all" ? 2 : MAX_FEDERAL_RECORDS);

  if (env.FINNHUB_PROCESSING_APPROVED !== "true") {
    pipeline.result.health.push(SourceHealthSchema.parse({
      provider: "finnhub_news",
      status: "offline",
      freshness: "unavailable",
      message: "Not requested: written approval for third-party TypeSafe processing has not been confirmed.",
      checkedAt: refreshedAt,
    }));
  }

  for (const provider of ["sec", "finnhub_news", "federal_register"] as const) {
    const errors = pipeline.sourceErrors.get(provider) ?? [];
    if (pipeline.sourceSuccesses.has(provider) || errors.length > 0) {
      const successes = pipeline.sourceSuccesses.get(provider) ?? 0;
      pipeline.result.health.push(healthFor(provider, successes, errors, pipeline.result.events.length, refreshedAt));
    }
  }
  if (pipeline.screeningSucceeded > 0 || pipeline.screeningFailed > 0) {
    pipeline.result.health.push(screeningHealth(pipeline, refreshedAt));
  }
  pipeline.result.failures = [...pipeline.sourceErrors.values()].flat();
  return pipeline.result;
}

export async function searchIssuers(
  env: WorkerEnv,
  ownerId: string,
  repository: InvestorRepository,
  query: string,
): Promise<IssuerSearchResult[]> {
  const normalized = query.trim().toLowerCase();
  if (normalized.length < 2 || normalized.length > 80) return [];
  const captures: CaptureRecord[] = [];
  const budget = new RequestBudget(8);
  let directory: SecIssuer[];
  try {
    if (cachedSecDirectory !== null && Date.now() < cachedSecDirectory.expiresAt) {
      directory = cachedSecDirectory.entries;
    } else {
      directory = await fetchSecDirectory(env, ownerId, budget, captures, false);
      cachedSecDirectory = { entries: directory, expiresAt: Date.now() + 15 * 60 * 1000 };
    }
  } catch (officialError) {
    try {
      directory = await fetchSecIdentityMirror(env, ownerId, budget, captures);
      if (directory.length === 0) throw new Error("The public identity mirror contained no usable companies.");
    } catch (mirrorError) {
      if (captures.length > 0) await repository.recordCaptures(captures);
      const first = errorMessage(officialError, "SEC's issuer directory is unavailable.");
      const second = errorMessage(mirrorError, "The identity-only fallback is unavailable.");
      throw new ProviderFailure("sec", "issuer_search", `${first} The identity-only fallback also failed: ${second}`);
    }
  }
  if (captures.length > 0) await repository.recordCaptures(captures);
  return directory
    .filter((issuer) => issuer.name.toLowerCase().includes(normalized) || issuer.ticker.toLowerCase().includes(normalized))
    .sort((left, right) => {
      const leftRank = exactRank(left, normalized);
      const rightRank = exactRank(right, normalized);
      return leftRank - rightRank || left.name.localeCompare(right.name);
    })
    .slice(0, 20);
}

async function collectPublicSec(pipeline: Pipeline, limit: number, filingLimit = MAX_SEC_FILINGS_PER_REFRESH): Promise<void> {
  const { env, ownerId, repository, result } = pipeline;
  const errors: string[] = [];
  let successful = 0;
  let directory: SecIssuer[] | null = null;
  let before = 0;
  let nextOffset = 0;
  let issuersScanned = 0;
  let recentFilingsFound = 0;
  try {
    directory = await fetchSecDirectory(env, ownerId, pipeline.budget, result.captures, false, () => assertRefreshLock(pipeline));
    successful += 1;
    before = await repository.getOffset("secPublicOffset");
    nextOffset = before;
    const retries = await repository.getDueSecIssuerRetries("public", new Date().toISOString(), Math.min(2, limit));
    const retryCiks = new Set(await repository.getSecIssuerRetryCiks("public"));
    const freshBatch = rotateExcluding(directory, before, Math.max(0, limit - retries.length), (item) => item.cik, retryCiks);
    const selected = [...retries.map((retry) => retry.issuer), ...freshBatch.items];
    issuersScanned = selected.length;
    const outcomes = await mapLimit(selected, 3, (issuer) => collectSecIssuer(pipeline, issuer, "public"));
    const durable = outcomes.every((outcome) => outcome.obligationDurable);
    for (const outcome of outcomes) {
      successful += outcome.successfulRequests;
      recentFilingsFound += outcome.recentFilingsFound;
      if (outcome.error !== undefined) errors.push(outcome.error);
    }
    if (durable) {
      nextOffset = freshBatch.nextOffset;
      result.meta.push({ key: "secPublicOffset", value: String(nextOffset) });
    } else {
      result.failures.push("The SEC issuer cursor was held because a discovered filing or retry could not be durably saved.");
      errors.push("SEC discovery progress was not fully persisted; the same issuer slice will replay safely.");
    }
  } catch (error) {
    errors.push(errorMessage(error, "SEC EDGAR could not complete this public-issuer slice."));
  }

  const processed = await processSecQueue(pipeline, "public", Math.min(filingLimit, Math.floor(pipeline.budget.remaining / 3)));
  successful += processed.successfulRequests;
  if (processed.error !== undefined) errors.push(processed.error);

  if (directory !== null) {
    const directoryCapture = result.captures.find((capture) => capture.provider === "sec" && capture.nativeId === "issuer-directory:company-tickers-exchange");
    if (directoryCapture !== undefined) {
      const coverage: PublicIssuerCoverage = PublicIssuerCoverageSchema.parse({
        universeProvider: "sec_company_tickers_exchange",
        deliveryState: "network",
        eligibleIssuers: directory.length,
        activeCoverageIssuers: directory.length,
        issuersScanned,
        offsetBefore: before,
        offsetAfter: nextOffset,
        recentFilingsFound,
        recordsScreened: processed.recordsScreened,
        recordsPlaced: processed.recordsPlaced,
        retrievedAt: directoryCapture.observedAt,
        directoryDigest: directoryCapture.sha256,
      });
      result.meta.push({ key: "publicIssuerCoverage", value: JSON.stringify(coverage) });
    }
  }
  if (errors.length > 0) setSourceErrors(pipeline, "sec", errors);
  if (successful > 0) setSourceSuccesses(pipeline, "sec", successful);
}

async function collectWatchlistSec(pipeline: Pipeline): Promise<void> {
  const watchlist = await pipeline.repository.getWatchlist();
  if (watchlist.length === 0) return;
  const errors: string[] = [];
  let successful = 0;
  const before = await pipeline.repository.getOffset("secWatchlistOffset");
  const retries = await pipeline.repository.getDueSecIssuerRetries("watchlist", new Date().toISOString(), Math.min(2, MAX_WATCHLIST_ITEMS_PER_REFRESH));
  const retryCiks = new Set(await pipeline.repository.getSecIssuerRetryCiks("watchlist"));
  const freshBatch = rotateExcluding(watchlist, before, Math.max(0, MAX_WATCHLIST_ITEMS_PER_REFRESH - retries.length), (entry) => entry.issuer.cik.value, retryCiks);
  const selected = [
    ...retries.map((retry) => retry.issuer),
    ...freshBatch.items.map((entry) => ({
      cik: entry.issuer.cik.value,
      ticker: entry.issuer.ticker.value,
      name: entry.issuer.name,
    })),
  ];
  const outcomes = await mapLimit(selected, 3, (issuer) => collectSecIssuer(pipeline, issuer, "watchlist"));
  const durable = outcomes.every((outcome) => outcome.obligationDurable);
  for (const outcome of outcomes) {
    successful += outcome.successfulRequests;
    if (outcome.error !== undefined) errors.push(outcome.error);
  }
  if (durable) pipeline.result.meta.push({ key: "secWatchlistOffset", value: String(freshBatch.nextOffset) });
  else {
    pipeline.result.failures.push("The watchlist SEC cursor was held because a filing or issuer retry could not be durably saved.");
    errors.push("SEC watchlist progress was not fully persisted; the same issuer slice will replay safely.");
  }
  const processed = await processSecQueue(pipeline, "watchlist", Math.floor(pipeline.budget.remaining / 3));
  successful += processed.successfulRequests;
  if (processed.error !== undefined) errors.push(processed.error);
  if (errors.length > 0) setSourceErrors(pipeline, "sec", errors);
  if (successful > 0) setSourceSuccesses(pipeline, "sec", successful);
}

interface SecIssuerOutcome {
  obligationDurable: boolean;
  successfulRequests: number;
  recentFilingsFound: number;
  error?: string;
}

async function collectSecIssuer(pipeline: Pipeline, issuer: SecQueueIssuer, scope: SecQueueScope): Promise<SecIssuerOutcome> {
  const { env, repository, result } = pipeline;
  const userAgent = env.NEWSJACK_SEC_USER_AGENT?.trim();
  if (!userAgent) {
    const error = new ProviderFailure("sec", "auth", "SEC contact User-Agent runtime secret is not configured.");
    rememberFailure(pipeline, error);
    return persistIssuerFailure(pipeline, scope, issuer, error);
  }

  let rawSubmission: CapturedBody;
  let filings: SecRecentFiling[];
  let submissionRequests = 0;
  try {
    const replay = await repository.getSecDiscoveryReplay(scope, issuer.cik);
    if (replay !== null) {
      rawSubmission = await readCaptured(env, pipeline.ownerId, replay.capture);
      issuer = replay.issuer;
    } else {
      rawSubmission = await liveFetch(pipeline, "sec", `submissions:${issuer.cik}`, `${SEC_SUBMISSIONS_URL}CIK${issuer.cik}.json`, {
        headers: { Accept: "application/json", "User-Agent": userAgent },
      });
      submissionRequests = 1;
      await repository.beginSecDiscoveryReplay(scope, issuer, rawSubmission.capture, pipeline.lockToken);
    }
  } catch (error) {
    rememberFailure(pipeline, error);
    return persistIssuerFailure(pipeline, scope, issuer, error);
  }
  try {
    const submissionPayload = SecSubmissionPayloadSchema.safeParse(parseJSON(rawSubmission, "sec"));
    if (!submissionPayload.success) throw new ProviderFailure("sec", "validation", "SEC submissions response did not match the declared schema.");
    filings = chooseRecentFilings(submissionPayload.data.filings.recent, new Date(rawSubmission.observedAt));
  } catch (error) {
    rememberFailure(pipeline, error);
    try {
      await repository.discardSecDiscoveryReplay(scope, issuer.cik, rawSubmission.capture.sha256, pipeline.lockToken);
    } catch (storageError) {
      return { obligationDurable: false, successfulRequests: 0, recentFilingsFound: 0,
        error: errorMessage(storageError, "Invalid SEC discovery could not be cleared for retry.") };
    }
    return persistIssuerFailure(pipeline, scope, issuer, error);
  }

  try {
    const selected: SecFilingQueueInput[] = [];
    let revalidationCandidate: SecFilingQueueInput | null = null;
    const validationCutoff = new Date(Date.now() - SOURCE_REVALIDATION_INTERVAL_MS).toISOString();
    for (const filing of filings) {
      const nativeId = `SEC:${issuer.cik}:${filing.accession}`;
      const sourceVersionDigest = await digestHex(new TextEncoder().encode(JSON.stringify(filing)));
      const currentVersionScreening = await repository.hasScreeningForVersion("sec", nativeId, sourceVersionDigest, pipeline.screeningContractDigest);
      const candidate: SecFilingQueueInput = {
        nativeId,
        cik: issuer.cik,
        accession: filing.accession,
        issuer,
        form: filing.form,
        primaryDocument: filing.primaryDocument,
        primaryDescription: filing.primaryDescription,
        filedAt: filing.filedAt,
        availableAt: filing.availableAt,
        availablePrecision: filing.availablePrecision,
        sourceVersionDigest,
        contractDigest: pipeline.screeningContractDigest,
      };
      if (!currentVersionScreening) {
        selected.push(candidate);
      } else if (revalidationCandidate === null && !(await repository.hasRecentFullTextScreeningForVersion(
        "sec", nativeId, sourceVersionDigest, pipeline.screeningContractDigest, validationCutoff,
      ))) {
        revalidationCandidate = candidate;
      }
    }
    if (selected.length === 0 && revalidationCandidate !== null) selected.push(revalidationCandidate);
    result.captures.push(rawSubmission.capture);
    await repository.queueSecFilings(scope, selected, rawSubmission.capture, pipeline.lockToken, new Date().toISOString(), issuer.cik);
    result.secIssuerRetriesCleared.push({ scope, cik: issuer.cik });
    return { obligationDurable: true, successfulRequests: submissionRequests, recentFilingsFound: filings.length };
  } catch (error) {
    rememberFailure(pipeline, error);
    return {
      obligationDurable: false,
      successfulRequests: submissionRequests,
      recentFilingsFound: filings.length,
      error: errorMessage(error, "SEC filing discovery could not be persisted."),
    };
  }
}

async function persistIssuerFailure(
  pipeline: Pipeline,
  scope: SecQueueScope,
    issuer: SecQueueIssuer,
  error: unknown,
): Promise<SecIssuerOutcome> {
  const failure = error instanceof ProviderFailure ? error : new ProviderFailure("sec", "network", "SEC issuer submissions could not be processed.");
  const message = errorMessage(failure, "SEC issuer submissions could not be processed.");
  if (failure.provider === "worker") {
    return { obligationDurable: false, successfulRequests: 0, recentFilingsFound: 0, error: message };
  }
  try {
    await pipeline.repository.recordSecIssuerFailure(scope, issuer, message, pipeline.lockToken, new Date().toISOString());
    return { obligationDurable: true, successfulRequests: 0, recentFilingsFound: 0, error: message };
  } catch (persistError) {
    return {
      obligationDurable: false,
      successfulRequests: 0,
      recentFilingsFound: 0,
      error: `${message} The issuer retry state could not be stored: ${errorMessage(persistError, "D1 write failed.")}`,
    };
  }
}

interface SecQueueProcessResult {
  successfulRequests: number;
  recordsScreened: number;
  recordsPlaced: number;
  error?: string;
}

async function processSecQueue(
  pipeline: Pipeline,
  scope: SecQueueScope,
  requestedLimit: number,
): Promise<SecQueueProcessResult> {
  const limit = Math.max(0, Math.min(MAX_SEC_FILINGS_PER_REFRESH, requestedLimit, Math.floor(pipeline.budget.remaining / 3)));
  if (limit === 0) return { successfulRequests: 0, recordsScreened: 0, recordsPlaced: 0 };
  let filings: SecFilingWork[];
  try {
    filings = await pipeline.repository.getDueSecFilings(
      scope,
      pipeline.screeningContractDigest,
      new Date().toISOString(),
      limit,
      2,
      pipeline.lockToken,
    );
  } catch (error) {
    const message = errorMessage(error, "SEC filing backlog could not be loaded.");
    rememberFailure(pipeline, error);
    return { successfulRequests: 0, recordsScreened: 0, recordsPlaced: 0, error: message };
  }
  const outcomes = await mapLimit(filings, 3, (filing) => processSecFiling(pipeline, filing));
  return outcomes.reduce<SecQueueProcessResult>((total, outcome) => ({
    successfulRequests: total.successfulRequests + outcome.successfulRequests,
    recordsScreened: total.recordsScreened + outcome.recordsScreened,
    recordsPlaced: total.recordsPlaced + outcome.recordsPlaced,
    ...(total.error !== undefined || outcome.error !== undefined
      ? { error: [total.error, outcome.error].filter((item): item is string => item !== undefined).slice(0, 2).join(" ") }
      : {}),
  }), { successfulRequests: 0, recordsScreened: 0, recordsPlaced: 0 });
}

async function processSecFiling(pipeline: Pipeline, filing: SecFilingWork): Promise<SecQueueProcessResult> {
  const userAgent = pipeline.env.NEWSJACK_SEC_USER_AGENT?.trim();
  if (!userAgent) {
    const error = new ProviderFailure("sec", "auth", "SEC contact User-Agent runtime secret is not configured.");
    rememberFailure(pipeline, error);
    return retryQueuedFiling(pipeline, filing, error, 0);
  }
  const cikPath = String(Number(filing.cik)).replace(/^0+/, "");
  const accessionPath = filing.accession.replaceAll("-", "");
  const documentUrl = `${SEC_ARCHIVES_URL}/${cikPath}/${accessionPath}/${encodeURIComponent(filing.primaryDocument)}`;
  let successfulRequests = 0;
  try {
    const rawDocument = await liveFetch(pipeline, "sec", `filing:${filing.cik}:${filing.accession}`, documentUrl, {
      headers: { Accept: "text/html,application/xhtml+xml,text/plain", "User-Agent": userAgent },
    });
    successfulRequests += 1;
    const text = htmlText(rawDocument.text);
    if (text.length < 20) throw new ProviderFailure("sec", "normalization", "SEC primary document contained too little readable filing text.");
    const digest = rawDocument.capture.sha256;
    const observedAt = rawDocument.observedAt;
    if (await pipeline.repository.hasScreening("sec", filing.nativeId, digest, filing.sourceVersionDigest, pipeline.screeningContractDigest)) {
      pipeline.result.secObservationTouches.push({ nativeId: filing.nativeId, sourceDigest: digest, observedAt });
      pipeline.result.secScreeningTouches.push({
        nativeId: filing.nativeId,
        sourceDigest: digest,
        sourceVersionDigest: filing.sourceVersionDigest,
        contractDigest: pipeline.screeningContractDigest,
        validatedAt: observedAt,
      });
      pipeline.result.secQueueTransitions.push({
        nativeId: filing.nativeId,
        sourceVersionDigest: filing.sourceVersionDigest,
        contractDigest: pipeline.screeningContractDigest,
        outcome: "complete",
      });
      return { successfulRequests, recordsScreened: 0, recordsPlaced: 0 };
    }

    const subject = IssuerSchema.parse({
      kind: "issuer",
      name: filing.issuer.name,
      ticker: { kind: "ticker", value: filing.issuer.ticker },
      cik: { kind: "cik", value: filing.cik },
    });
    const snippet = text.slice(0, MAX_SEC_TEXT_CHARS);
    const summary = summarySentence(snippet) ?? `${filing.issuer.ticker} filed a ${filing.form} containing new disclosure.`;
    let screeningFailure: unknown;
    const screened = await screenOne(pipeline, {
      provider: "sec",
      nativeId: filing.nativeId,
      sourceDigest: digest,
      subject,
      form: filing.form,
      sourceTitle: filing.primaryDescription,
      sourceText: snippet,
      sourceUrl: documentUrl,
      sourceObservedAt: observedAt,
      sourceAvailableAt: filing.availableAt,
      sourceAvailablePrecision: filing.availablePrecision,
      // Only the primary document is captured today; attached SEC exhibits remain unreviewed.
      evidenceComplete: false,
      sourceReliability: 95,
    }, (error) => { screeningFailure = error; });
    if (screened === null) {
      const error = screeningFailure ?? new ProviderFailure("typesafe_ai", "validation", "TypeSafe AI could not validate this SEC filing.");
      return retryQueuedFiling(pipeline, filing, error, successfulRequests, error instanceof ProviderFailure && error.provider === "worker");
    }

    screeningForEvent(pipeline, "sec", filing.nativeId, digest, filing.sourceVersionDigest, "full_text", screened, screened.relevant);
    if (screened.relevant) {
      pipeline.result.events.push(makeEvent({
        id: eventIdForSource("sec", filing.nativeId),
        subject,
        provider: "sec",
        nativeId: filing.nativeId,
        kind: "filing",
        form: filing.form,
        sourceTitle: filing.primaryDescription,
        title: summary,
        summary: truncate(snippet, 1200),
        publishedAt: filing.filedAt,
        publishedPrecision: "day",
        availableAt: filing.availableAt,
        availablePrecision: filing.availablePrecision,
        observedAt,
        sourceUrl: documentUrl,
        sourceDigest: digest,
        evidenceCapture: "content",
        evidenceExcerpt: truncate(snippet, 1200),
        screening: screened.screening,
      }));
    }
    pipeline.result.secQueueTransitions.push({
      nativeId: filing.nativeId,
      sourceVersionDigest: filing.sourceVersionDigest,
      contractDigest: pipeline.screeningContractDigest,
      outcome: "complete",
    });
    return { successfulRequests, recordsScreened: 1, recordsPlaced: screened.relevant ? 1 : 0 };
  } catch (error) {
    rememberFailure(pipeline, error);
    return retryQueuedFiling(pipeline, filing, error, successfulRequests,
      error instanceof ProviderFailure && error.provider === "worker");
  }
}

function retryQueuedFiling(
  pipeline: Pipeline,
  filing: SecFilingWork,
  error: unknown,
  successfulRequests: number,
  deferred = false,
): SecQueueProcessResult {
  if (deferred) {
    const message = `${errorMessage(error, "Refresh ownership could not be verified.")} SEC filing work remains queued without consuming a retry.`;
    pipeline.result.failures.push(message);
    return { successfulRequests, recordsScreened: 0, recordsPlaced: 0, error: message };
  }
  const now = new Date();
  const delay = [60_000, 5 * 60_000, 30 * 60_000, 6 * 60 * 60_000][Math.min(filing.attemptCount, 3)] ?? 6 * 60 * 60_000;
  const message = errorMessage(error, "SEC primary filing could not be processed.");
  pipeline.result.secQueueTransitions.push({
    nativeId: filing.nativeId,
    sourceVersionDigest: filing.sourceVersionDigest,
    contractDigest: pipeline.screeningContractDigest,
    outcome: "retry",
    nextAttemptAt: new Date(now.getTime() + delay).toISOString(),
    lastError: message,
  });
  pipeline.result.failures.push(`${message} The accession remains queued for a bounded retry.`);
  return { successfulRequests, recordsScreened: 0, recordsPlaced: 0, error: message };
}

async function collectFederalRegister(pipeline: Pipeline, limit: number): Promise<void> {
  const { repository, result } = pipeline;
  const errors: string[] = [];
  const pages: Array<{ raw: CapturedBody; payload: z.infer<typeof FederalIndexSchema> }> = [];
  let totalPages: number | null = null;
  let successful = 0;
  try {
    const now = new Date();
    const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const baseUrl = new URL(FEDERAL_REGISTER_URL);
    baseUrl.searchParams.set("per_page", String(MAX_FEDERAL_INDEX_RESULTS));
    baseUrl.searchParams.set("order", "newest");
    baseUrl.searchParams.set("conditions[publication_date][gte]", since);
    for (const field of FEDERAL_INDEX_FIELDS) baseUrl.searchParams.append("fields[]", field);

    let resultCount: number | null = null;
    for (let page = 1; page <= MAX_FEDERAL_INDEX_PAGES; page += 1) {
      const url = new URL(baseUrl);
      url.searchParams.set("page", String(page));
      let raw: CapturedBody;
      try {
        raw = await liveFetch(pipeline, "federal_register", `index:${since}:${page}`, url.toString(), {
          headers: { Accept: "application/json", "User-Agent": "Newsjack Investor Desk/1.0" },
        });
      } catch (error) {
        rememberFailure(pipeline, error);
        errors.push(errorMessage(error, `Federal Register page ${page} could not be retrieved.`));
        break;
      }
      const payload = FederalIndexSchema.safeParse(parseJSON(raw, "federal_register"));
      if (!payload.success || payload.data.count < payload.data.results.length) {
        throw new ProviderFailure("federal_register", "validation", "Federal Register response did not match the declared paginated schema.");
      }
      const pageUrl = payload.data.next_page_url === null ? null : new URL(payload.data.next_page_url);
      if (pageUrl !== null && (pageUrl.hostname !== "www.federalregister.gov" || pageUrl.pathname !== "/api/v1/documents.json")) {
        throw new ProviderFailure("federal_register", "validation", "Federal Register pagination metadata pointed outside its official index endpoint.");
      }
      if (totalPages === null) {
        totalPages = payload.data.total_pages;
        resultCount = payload.data.count;
      } else if (payload.data.total_pages !== totalPages || payload.data.count !== resultCount) {
        throw new ProviderFailure("federal_register", "validation", "Federal Register result count changed while reading pages; this batch was withheld to avoid implying complete coverage.");
      }
      if (page < payload.data.total_pages && payload.data.next_page_url === null) {
        throw new ProviderFailure("federal_register", "validation", "Federal Register pagination metadata omitted its next-page link; the batch was withheld.");
      }
      if (page === payload.data.total_pages && payload.data.next_page_url !== null) {
        errors.push("Federal Register returned a next-page link after its declared terminal page; this index slice is degraded.");
      }
      const expectedPages = Math.max(1, Math.ceil(payload.data.count / MAX_FEDERAL_INDEX_RESULTS));
      if (payload.data.total_pages !== expectedPages) {
        errors.push(`Federal Register declared ${payload.data.total_pages} pages for ${payload.data.count} results; expected ${expectedPages}.`);
      }
      pages.push({ raw, payload: payload.data });
      successful += 1;
      if (page >= totalPages) break;
    }
    const candidates: Array<{ document: FederalDocument; raw: CapturedBody; versionDigest: string }> = [];
    for (const page of pages) {
      for (const item of page.payload.results) {
        const document = parseFederalDocument(item);
        if (document === null) continue;
        candidates.push({
          document,
          raw: page.raw,
          versionDigest: await digestHex(new TextEncoder().encode(JSON.stringify(document))),
        });
      }
    }
    const malformedCount = pages.reduce((count, page) => count + page.payload.results.length, 0) - candidates.length;
    if (malformedCount > 0) errors.push(`${malformedCount.toLocaleString()} Federal Register index result(s) did not pass the required record schema and were withheld.`);
    const rawResultCount = pages.reduce((count, page) => count + page.payload.results.length, 0);
    const uniqueDocumentCount = new Set(candidates.map((candidate) => candidate.document.documentNumber)).size;
    if (pages.length === totalPages && resultCount !== null && rawResultCount !== resultCount) {
      errors.push(`Federal Register declared ${resultCount.toLocaleString()} records but delivered ${rawResultCount.toLocaleString()} across its complete page set.`);
    }
    if (uniqueDocumentCount !== candidates.length) errors.push("Federal Register repeated document numbers across pages; duplicate index records were withheld.");
    if (pages.length === totalPages && pages.length > 0 && pages[pages.length - 1]?.payload.next_page_url !== null) {
      errors.push("Federal Register's final page retained a next-page link; the index is not reconciled.");
    }
    const documents: Array<{ document: FederalDocument; raw: CapturedBody; versionDigest: string }> = [];
    const validationCutoff = new Date(Date.now() - SOURCE_REVALIDATION_INTERVAL_MS).toISOString();
    for (const candidate of candidates) {
      const nativeId = `FR:${candidate.document.documentNumber}`;
      const recentlyCaptured = await repository.hasRecentFullTextScreeningForVersion(
        "federal_register", nativeId, candidate.versionDigest, pipeline.screeningContractDigest, validationCutoff,
      );
      if (recentlyCaptured) continue;
      if (documents.some((item) => item.document.documentNumber === candidate.document.documentNumber)) continue;
      documents.push(candidate);
      if (documents.length >= Math.min(limit, MAX_FEDERAL_RECORDS)) break;
    }
    const outcomes = await mapLimit(documents, 3, async (candidate) => {
      return collectFederalDocument(pipeline, candidate.document, candidate.raw, candidate.versionDigest);
    });
    for (const outcome of outcomes) {
      successful += outcome.successfulRequests;
      if (outcome.error !== undefined) errors.push(outcome.error);
    }
    if (candidates.length === 0) result.failures.push("Federal Register returned no parseable documents in the seven-day recovery window.");
  } catch (error) {
    rememberFailure(pipeline, error);
    errors.push(errorMessage(error, "Federal Register could not complete this update."));
  }
  if (totalPages !== null && totalPages > pages.length) {
    const omittedPages = totalPages - pages.length;
    errors.push(`Federal Register's seven-day window contains ${totalPages.toLocaleString()} pages; ${pages.length.toLocaleString()} page(s) were read and ${omittedPages.toLocaleString()} remain. The source is incomplete for this refresh.`);
  }
  if (errors.length > 0) setSourceErrors(pipeline, "federal_register", errors);
  if (successful > 0) setSourceSuccesses(pipeline, "federal_register", successful);
}

async function collectFederalDocument(
  pipeline: Pipeline,
  document: FederalDocument,
  indexBody: CapturedBody,
  sourceVersionDigest: string,
): Promise<{ successfulRequests: number; error?: string }> {
  const { repository, result } = pipeline;
  const publication = dayInstant(document.publicationDate);
  if (publication === null) return { successfulRequests: 0, error: "Federal Register document has an invalid publication date." };
  const nativeId = `FR:${document.documentNumber}`;
  let bodyText = document.abstract;
  let digest = indexBody.capture.sha256;
  let observedAt = indexBody.observedAt;
  let complete = false;
  let documentUrl = document.htmlUrl;
  let requests = 0;

  const contentUrl = [document.rawTextUrl, document.htmlUrl].find(isFederalUrl);
  let captureKind: "abstract" | "full_text" = "abstract";
  if (contentUrl !== undefined) {
    try {
      const captured = await liveFetch(pipeline, "federal_register", `document:${document.documentNumber}`, contentUrl, {
        headers: { Accept: "text/html,text/plain,application/json", "User-Agent": "Newsjack Investor Desk/1.0 contact: owner" },
      });
      requests = 1;
      bodyText = htmlText(captured.text);
      digest = captured.capture.sha256;
      observedAt = captured.observedAt;
      documentUrl = document.htmlUrl || contentUrl;
      complete = bodyText.length > 100;
      if (complete) captureKind = "full_text";
    } catch (error) {
      rememberFailure(pipeline, error);
      const message = errorMessage(error, "Federal Register source document could not be captured.");
      setSourceErrors(pipeline, "federal_register", [message]);
    }
  }
  const text = bodyText.trim() || document.title;
  if (text.length < 20) return { successfulRequests: requests, error: "Federal Register document contained no readable summary." };
  const screeningIdentity = { provider: "federal_register", nativeId, sourceDigest: digest, sourceVersionDigest, contractDigest: pipeline.screeningContractDigest };
  if (await repository.hasScreening("federal_register", nativeId, digest, sourceVersionDigest, pipeline.screeningContractDigest)) {
    await repository.refreshEventObservation("federal_register", nativeId, digest, observedAt, pipeline.lockToken);
    await repository.touchScreening(screeningIdentity, observedAt, pipeline.lockToken);
    return { successfulRequests: requests };
  }

  const subject = AgencySchema.parse({ kind: "agency", name: document.agencyName, code: document.agencyCode });
  const summary = summarySentence(text) ?? `${document.agencyName} posted a ${document.type.toLowerCase()}; review the source notice.`;
  const screened = await screenOne(pipeline, {
    provider: "federal_register",
    nativeId,
    sourceDigest: digest,
    subject,
    form: document.type || "Federal Register",
    sourceTitle: document.title,
    sourceText: text,
    sourceUrl: documentUrl,
    sourceObservedAt: observedAt,
    sourceAvailableAt: publication.value,
    sourceAvailablePrecision: "day",
    evidenceComplete: complete,
    sourceReliability: 85,
  });
  if (screened === null) return { successfulRequests: requests, error: "TypeSafe AI could not validate a Federal Register notice; it will be retried." };

  screeningForEvent(pipeline, "federal_register", nativeId, digest, sourceVersionDigest, captureKind, screened, screened.relevant);
  if (screened.relevant) {
    pipeline.result.events.push(makeEvent({
      id: eventIdForSource("federal_register", nativeId),
      subject,
      provider: "federal_register",
      nativeId,
      kind: "regulatory",
      form: document.type || "Federal Register",
      sourceTitle: document.title,
      title: summary,
      summary: truncate(text, 1200),
      publishedAt: publication.value,
      publishedPrecision: "day",
      availableAt: publication.value,
      availablePrecision: "day",
      observedAt,
      sourceUrl: documentUrl,
      sourceDigest: digest,
      evidenceCapture: captureKind === "full_text" ? "content" : "reference",
      evidenceExcerpt: truncate(text, 1200),
      screening: screened.screening,
    }));
  }
  return { successfulRequests: requests };
}

async function collectCompanyNews(
  pipeline: Pipeline,
  limit: number,
  explicitWatchlist?: Awaited<ReturnType<InvestorRepository["getWatchlist"]>>,
): Promise<void> {
  const { env, ownerId, repository, result } = pipeline;
  if (env.FINNHUB_PROCESSING_APPROVED !== "true") {
    setSourceErrors(pipeline, "finnhub_news", ["Finnhub company news is disabled until written approval permits third-party TypeSafe processing."]);
    return;
  }
  const apiKey = env.FINNHUB_API_KEY?.trim();
  if (!apiKey) {
    setSourceErrors(pipeline, "finnhub_news", ["Finnhub API key runtime secret is not configured."]);
    return;
  }
  const errors: string[] = [];
  let successful = 0;
  let symbols: FinnhubSymbol[] = [];
  let directoryDigest = "";
  let start = 0;
  let nextOffset = 0;
  let publicUniverse = explicitWatchlist === undefined;
  let universeSize = 0;
  try {
    if (explicitWatchlist !== undefined) {
      symbols = explicitWatchlist.map((entry) => ({ symbol: entry.issuer.ticker.value, name: entry.issuer.name }));
      if (symbols.length === 0) return;
      start = await repository.getOffset("finnhubWatchlistOffset");
      const batch = rotate(symbols, start, limit, (item) => item.symbol);
      symbols = batch.items;
      nextOffset = batch.nextOffset;
      directoryDigest = await digestHex(new TextEncoder().encode(JSON.stringify(symbols)));
      publicUniverse = false;
    } else {
      const directory = await fetchFinnhubDirectory(pipeline, apiKey);
      successful += 1;
      symbols = directory.symbols;
      universeSize = directory.symbols.length;
      directoryDigest = directory.digest;
      start = await repository.getOffset("finnhubPublicOffset");
      const batch = rotate(symbols, start, limit, (item) => item.symbol);
      symbols = batch.items;
      nextOffset = batch.nextOffset;
    }
  } catch (error) {
    rememberFailure(pipeline, error);
    setSourceErrors(pipeline, "finnhub_news", [errorMessage(error, "Finnhub's public-company directory could not be loaded.")]);
    return;
  }

  const scanned = [] as Awaited<ReturnType<typeof collectFinnhubCompany>>[];
  for (const company of symbols) scanned.push(await collectFinnhubCompany(pipeline, company, apiKey));
  let batchValid = true;
  let scannedCount = 0;
  let received = 0;
  let relevantArticles = 0;
  let linkedSymbols = new Set<string>();
  let excluded = 0;
  let deferred = false;
  const newsDigests: string[] = [];
  for (const item of scanned) {
    scannedCount += 1;
    if (item.requestSucceeded) successful += 1;
    if (item.digest !== null) newsDigests.push(item.digest);
    received += item.articlesReceived;
    if (item.deferred) deferred = true;
    if (item.valid === "blocking") batchValid = false;
    if (item.error !== undefined) errors.push(item.error);
    if (item.linked) {
      relevantArticles += 1;
      linkedSymbols.add(item.symbol);
    }
    if (item.excluded) excluded += 1;
  }
  const newsDigest = await digestHex(new TextEncoder().encode(newsDigests.sort().join("\n")));
  const newsObservedAt = result.captures
    .filter((capture) => capture.provider === "finnhub_news")
    .map((capture) => capture.observedAt)
    .sort()
    .at(-1) ?? result.refreshedAt;
  if (publicUniverse) {
    const coverage: CompanyCoverage = CompanyCoverageSchema.parse({
      universeProvider: "finnhub_stock_symbols_us_nyse_nasdaq_common_stock",
      deliveryState: "network",
      eligibleSymbols: universeSize,
      symbolsScanned: scannedCount,
      symbolOffsetBefore: start,
      symbolOffsetNext: batchValid ? nextOffset : start,
      articlesReceived: received,
      articlesLinkedToUniverse: relevantArticles,
      symbolsLinked: linkedSymbols.size,
      recordsScreened: scanned.filter((item) => item.screened).length,
      recordsExcludedAsUnrelated: excluded,
      hasDeferredRecords: deferred,
      observedAt: newsObservedAt,
      directoryDigest,
      newsDigest,
    });
    result.meta.push({ key: "companyCoverage", value: JSON.stringify(coverage) });
    result.meta.push({ key: "finnhubUniverseSize", value: String(universeSize) });
  }
  if (batchValid) {
    result.meta.push({ key: publicUniverse ? "finnhubPublicOffset" : "finnhubWatchlistOffset", value: String(nextOffset) });
  } else {
    result.failures.push("Finnhub rotation held at its last committed position because a response or TypeSafe judgment did not validate.");
  }
  if (errors.length > 0) setSourceErrors(pipeline, "finnhub_news", errors);
  if (successful > 0) setSourceSuccesses(pipeline, "finnhub_news", successful);
}

async function collectFinnhubCompany(
  pipeline: Pipeline,
  company: FinnhubSymbol,
  apiKey: string,
): Promise<{ symbol: string; valid: "ok" | "network" | "blocking"; requestSucceeded: boolean; articlesReceived: number; digest: string | null; deferred: boolean; linked: boolean; excluded: boolean; screened: boolean; error?: string }> {
  const now = new Date();
  const from = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const to = now.toISOString().slice(0, 10);
  const url = new URL(FINNHUB_NEWS_URL);
  url.searchParams.set("symbol", company.symbol);
  url.searchParams.set("from", from);
  url.searchParams.set("to", to);
  url.searchParams.set("token", apiKey);
  let raw: CapturedBody;
  try {
    raw = await liveFetch(pipeline, "finnhub_news", `news:${company.symbol}:${from}:${to}`, url.toString(), {
      headers: { Accept: "application/json" },
    }, [apiKey]);
  } catch (error) {
    rememberFailure(pipeline, error);
    return {
      symbol: company.symbol,
      valid: "network",
      requestSucceeded: false,
      articlesReceived: 0,
      digest: error instanceof CapturedProviderFailure ? error.capture.sha256 : null,
      deferred: false,
      linked: false,
      excluded: false,
      screened: false,
      error: errorMessage(error, `Finnhub could not read ${company.symbol} news.`),
    };
  }
  const parsed = z.array(z.unknown()).safeParse(parseJSON(raw, "finnhub_news"));
  if (!parsed.success) return { symbol: company.symbol, valid: "blocking", requestSucceeded: true, articlesReceived: 0, digest: raw.capture.sha256, deferred: false, linked: false, excluded: false, screened: false, error: `Finnhub returned malformed news for ${company.symbol}.` };

  const validatedArticles = parsed.data.map((item) => FinnhubArticleSchema.safeParse(item));
  const malformedCount = validatedArticles.filter((item) => !item.success).length;
  const articles = validatedArticles.filter((item) => item.success).map((item) => item.data)
    .filter((article) => article.datetime >= Date.now() / 1000 - 24 * 60 * 60)
    .sort((left, right) => right.datetime - left.datetime);
  if (articles.length === 0) return {
    symbol: company.symbol,
    valid: malformedCount > 0 ? "blocking" : "ok",
    requestSucceeded: true,
    articlesReceived: parsed.data.length,
    digest: raw.capture.sha256,
    deferred: false,
    linked: false,
    excluded: false,
    screened: false,
    ...(malformedCount > 0 ? { error: `Finnhub returned ${malformedCount} malformed article record(s) for ${company.symbol}.` } : {}),
  };

  let errorMessageValue: string | undefined;
  let linked = false;
  let excluded = false;
  const deferred = articles.length > 1;
  const article = articles[0];
  const nativeId = `FINNHUB:${company.symbol}:${article.id}`;
  const sourceVersionDigest = raw.capture.sha256;
  const contractDigest = await getScreeningContractDigest("finnhub_news");
  const screeningIdentity = { provider: "finnhub_news", nativeId, sourceDigest: raw.capture.sha256, sourceVersionDigest, contractDigest };
  if (await pipeline.repository.hasScreening("finnhub_news", nativeId, raw.capture.sha256, sourceVersionDigest, contractDigest)) {
    await pipeline.repository.refreshEventObservation("finnhub_news", nativeId, raw.capture.sha256, raw.observedAt, pipeline.lockToken);
    await pipeline.repository.touchScreening(screeningIdentity, raw.observedAt, pipeline.lockToken);
    return { symbol: company.symbol, valid: "ok", requestSucceeded: true, articlesReceived: parsed.data.length, digest: raw.capture.sha256, deferred, linked: false, excluded: false, screened: false };
  }

  const subject = PublicCompanySchema.parse({ kind: "public_company", name: company.name, symbol: company.symbol, exchange: "US" });
  const newsText = article.summary?.trim() || article.headline;
  const publishedAt = new Date(article.datetime * 1000).toISOString();
  const title = summarySentence(newsText) ?? `New company update for ${company.name}; open the linked story for details.`;
  const summary = truncate(newsText, 1400);
  const result = await screenOne(pipeline, {
    provider: "finnhub_news",
    nativeId,
    sourceDigest: raw.capture.sha256,
    subject,
    form: article.source?.trim() || "Company news",
    sourceTitle: article.headline,
    sourceText: newsText,
    sourceUrl: article.url,
    sourceObservedAt: raw.observedAt,
    sourceAvailableAt: publishedAt,
    sourceAvailablePrecision: "second",
    evidenceComplete: Boolean(article.summary?.trim()),
    sourceReliability: 65,
  });
  if (result === null) {
    errorMessageValue = `TypeSafe AI could not validate the ${company.symbol} company-attribution and screening result.`;
    return { symbol: company.symbol, valid: "blocking", requestSucceeded: true, articlesReceived: parsed.data.length, digest: raw.capture.sha256, deferred, linked, excluded, screened: false, error: errorMessageValue };
  }
  const accepted = result.relevant && (result.screening.typedAnswers.company_relevance?.type === "noul") && result.screening.typedAnswers.company_relevance.noul >= NEWS_RELEVANCE_THRESHOLD;
  screeningForEvent(pipeline, "finnhub_news", nativeId, raw.capture.sha256, sourceVersionDigest, "abstract", result, accepted);
  if (!accepted) excluded = true;
  else {
    linked = true;
    pipeline.result.events.push(makeEvent({
      id: eventIdForSource("finnhub_news", nativeId),
      subject,
      provider: "finnhub_news",
      nativeId,
      kind: "news",
      form: article.source?.trim() || "Company news",
      sourceTitle: article.headline,
      title,
      summary,
      publishedAt,
      publishedPrecision: "second",
      availableAt: publishedAt,
      availablePrecision: "second",
      observedAt: raw.observedAt,
      sourceUrl: article.url,
      sourceDigest: raw.capture.sha256,
      evidenceCapture: "reference",
      evidenceExcerpt: summary,
      screening: result.screening,
    }));
  }
  return {
    symbol: company.symbol,
    valid: malformedCount > 0 ? "blocking" : "ok",
    requestSucceeded: true,
    articlesReceived: parsed.data.length,
    digest: raw.capture.sha256,
    deferred,
    linked,
    excluded,
    screened: true,
    ...(malformedCount > 0 ? { error: `Finnhub returned ${malformedCount} malformed article record(s) for ${company.symbol}.` } : errorMessageValue === undefined ? {} : { error: errorMessageValue }),
  };
}

async function fetchFinnhubDirectory(pipeline: Pipeline, apiKey: string): Promise<{ symbols: FinnhubSymbol[]; digest: string }> {
  const url = new URL(FINNHUB_SYMBOLS_URL);
  url.searchParams.set("token", apiKey);
  const body = await liveFetch(pipeline, "finnhub_news", "symbol-directory:US", url.toString(), {
    headers: { Accept: "application/json" },
  }, [apiKey]);
  const payload = z.array(z.unknown()).safeParse(parseJSON(body, "finnhub_news"));
  if (!payload.success) throw new ProviderFailure("finnhub_news", "validation", "Finnhub stock-symbol directory did not match the declared schema.");
  const unique = new Map<string, FinnhubSymbol>();
  for (const item of payload.data) {
    const parsed = FinnhubSymbolSchema.safeParse(item);
    if (!parsed.success || parsed.data.type?.toLowerCase() !== "common stock") continue;
    const exchange = `${parsed.data.exchange ?? ""} ${parsed.data.mic ?? ""}`.toUpperCase();
    if (!(exchange.includes("NASDAQ") || exchange.includes("NYSE") || exchange.includes("XNAS") || exchange.includes("XNYS"))) continue;
    const symbol = parsed.data.symbol?.trim().toUpperCase() ?? "";
    if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol) || unique.has(symbol)) continue;
    unique.set(symbol, { symbol, name: parsed.data.description?.trim() || symbol });
  }
  const symbols = [...unique.values()].sort((left, right) => stableHash(left.symbol) - stableHash(right.symbol) || left.symbol.localeCompare(right.symbol));
  if (symbols.length === 0) throw new ProviderFailure("finnhub_news", "validation", "Finnhub returned no eligible US common-stock listings.");
  return { symbols, digest: body.capture.sha256 };
}

async function fetchSecDirectory(
  env: WorkerEnv,
  ownerId: string,
  budget: RequestBudget,
  captures: CaptureRecord[],
  filterExchange: boolean,
  beforeRequest?: () => Promise<void>,
): Promise<SecIssuer[]> {
  const userAgent = env.NEWSJACK_SEC_USER_AGENT?.trim();
  if (!userAgent) throw new ProviderFailure("sec", "auth", "SEC contact User-Agent runtime secret is not configured.");
  let response: CapturedBody;
  try {
    response = await fetchCaptured(env, ownerId, "sec", "issuer-directory:company-tickers-exchange", SEC_DIRECTORY_URL, {
      headers: { Accept: "application/json", "User-Agent": userAgent },
    }, budget, [], beforeRequest);
    captures.push(response.capture);
  } catch (error) {
    if (error instanceof CapturedProviderFailure) captures.push(error.capture);
    throw error;
  }
  const payload = SecDirectoryPayloadSchema.safeParse(parseJSON(response, "sec"));
  if (!payload.success) throw new ProviderFailure("sec", "validation", "SEC company directory did not match the declared schema.");
  const fields = new Map(payload.data.fields.map((name, index) => [name, index]));
  const cikIndex = fields.get("cik");
  const nameIndex = fields.get("name");
  const tickerIndex = fields.get("ticker");
  const exchangeIndex = fields.get("exchange");
  if (cikIndex === undefined || nameIndex === undefined || tickerIndex === undefined || exchangeIndex === undefined) {
    throw new ProviderFailure("sec", "validation", "SEC company directory is missing an expected field.");
  }
  const issuers: SecIssuer[] = [];
  for (const row of payload.data.data) {
    const rawCik = row[cikIndex];
    const cikNumber = typeof rawCik === "number" ? rawCik : typeof rawCik === "string" ? Number(rawCik) : NaN;
    const ticker = typeof row[tickerIndex] === "string" ? row[tickerIndex].trim().toUpperCase() : "";
    const name = typeof row[nameIndex] === "string" ? row[nameIndex].trim() : "";
    const exchange = typeof row[exchangeIndex] === "string" ? row[exchangeIndex].trim() : "";
    if (!Number.isSafeInteger(cikNumber) || cikNumber <= 0 || name.length === 0 || exchange.length === 0) continue;
    if (filterExchange && !/(NASDAQ|NYSE|NEW YORK STOCK EXCHANGE)/i.test(exchange)) continue;
    const parsed = IssuerSearchResultSchema.safeParse({ cik: String(cikNumber).padStart(10, "0"), ticker, name, exchange });
    if (parsed.success) issuers.push(parsed.data);
  }
  const byCik = new Map(issuers.map((issuer) => [issuer.cik, issuer]));
  const unique = [...byCik.values()].sort((left, right) => stableHash(left.cik) - stableHash(right.cik) || left.cik.localeCompare(right.cik));
  if (unique.length === 0) throw new ProviderFailure("sec", "validation", "SEC company directory contained no eligible issuer identities.");
  return unique;
}

async function fetchSecIdentityMirror(
  env: WorkerEnv,
  ownerId: string,
  budget: RequestBudget,
  captures: CaptureRecord[],
): Promise<SecIssuer[]> {
  const base = "https://cdn.jsdelivr.net/gh/jadchaar/sec-cik-mapper@main/mappings/stocks";
  const files = ["ticker_to_cik.json", "ticker_to_company_name.json", "ticker_to_exchange.json"];
  const payloads: Array<Record<string, unknown>> = [];
  for (const file of files) {
    const body = await fetchCaptured(env, ownerId, "sec_identity_mirror", `mirror:${file}`, `${base}/${file}`, {
      headers: { Accept: "application/json" },
    }, budget);
    captures.push(body.capture);
    const parsed = z.record(z.string(), z.unknown()).safeParse(parseJSON(body, "sec"));
    if (!parsed.success) throw new ProviderFailure("sec", "validation", "The SEC identity-only fallback returned malformed data.");
    payloads.push(parsed.data);
  }
  const [ciks, names, exchanges] = payloads;
  const entries: SecIssuer[] = [];
  for (const [rawTicker, rawCik] of Object.entries(ciks ?? {})) {
    const ticker = rawTicker.trim().toUpperCase();
    const cik = typeof rawCik === "string" ? rawCik.padStart(10, "0") : typeof rawCik === "number" ? String(rawCik).padStart(10, "0") : "";
    const name = typeof names?.[rawTicker] === "string" ? String(names[rawTicker]).trim() : "";
    const exchange = typeof exchanges?.[rawTicker] === "string" ? String(exchanges[rawTicker]).trim() : "";
    const parsed = IssuerSearchResultSchema.safeParse({ cik, ticker, name, exchange });
    if (parsed.success) entries.push(parsed.data);
  }
  return entries;
}

async function screenOne(
  pipeline: Pipeline,
  input: Omit<Parameters<typeof screenSource>[1], "ownerId" | "beforeRequest">,
  onFailure?: (error: unknown) => void,
): Promise<Awaited<ReturnType<typeof screenSource>> | null> {
  pipeline.screeningAttempts += 1;
  try {
    const result = await screenSource(pipeline.env, {
      ...input,
      ownerId: pipeline.ownerId,
      beforeRequest: () => assertRefreshLock(pipeline),
    }, pipeline.budget, pipeline.result.captures);
    pipeline.screeningSucceeded += 1;
    return result;
  } catch (error) {
    onFailure?.(error);
    if (error instanceof ProviderFailure && error.provider === "worker") {
      if (error.stage === "subrequest_budget") pipeline.result.failures.push("TypeSafe screening was deferred to a later refresh slice without consuming a retry.");
      return null;
    }
    pipeline.screeningFailed += 1;
    rememberFailure(pipeline, error);
    return null;
  }
}

async function liveFetch(
  pipeline: Pipeline,
  provider: string,
  nativeId: string,
  url: string,
  init: RequestInit,
  redacted: readonly string[] = [],
): Promise<CapturedBody> {
  try {
    if (provider === "finnhub_news") await paceFinnhubRequest(pipeline);
    const body = await fetchCaptured(
      pipeline.env,
      pipeline.ownerId,
      provider,
      nativeId,
      url,
      init,
      pipeline.budget,
      redacted,
      () => assertRefreshLock(pipeline),
    );
    pipeline.result.captures.push(body.capture);
    return body;
  } catch (error) {
    if (error instanceof CapturedProviderFailure) pipeline.result.captures.push(error.capture);
    throw error;
  }
}

async function assertRefreshLock(pipeline: Pipeline): Promise<void> {
  if (!await pipeline.repository.renewRefreshLock(pipeline.lockToken, new Date().toISOString())) {
    throw new ProviderFailure("worker", "refresh_lock_lost", "This refresh lost ownership before its next provider request.");
  }
}

async function paceFinnhubRequest(pipeline: Pipeline): Promise<void> {
  const minimumIntervalMs = 4_000;
  const previous = pipeline.lastFinnhubRequestAt;
  if (previous !== null) {
    const remaining = minimumIntervalMs - (Date.now() - previous);
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
  }
  pipeline.lastFinnhubRequestAt = Date.now();
}

function parseJSON(body: CapturedBody, provider: string): unknown {
  try {
    return JSON.parse(body.text) as unknown;
  } catch {
    throw new ProviderFailure(provider, "parse", `${providerLabel(provider)} returned malformed JSON.`);
  }
}

type SecRecentFilings = z.infer<typeof SecRecentFilingsSchema>;

interface SecRecentFiling {
  form: string;
  accession: string;
  primaryDocument: string;
  primaryDescription: string;
  filedAt: string;
  availableAt: string;
  availablePrecision: "second" | "day";
  acceptanceOrder: number;
}

function chooseRecentFilings(recent: SecRecentFilings, now: Date): SecRecentFiling[] {
  const eligible: SecRecentFiling[] = [];
  const cutoff = now.getTime() - 7 * 24 * 60 * 60 * 1000;
  for (let index = 0; index < recent.form.length; index += 1) {
    const form = recent.form[index] ?? "";
    const accession = recent.accessionNumber[index] ?? "";
    const primary = recent.primaryDocument[index] ?? "";
    const description = recent.primaryDocDescription[index] ?? "";
    const filed = recent.filingDate[index] ?? "";
    const acceptance = recent.acceptanceDateTime[index] ?? "";
    const filedAt = dayInstant(filed);
    if (!SEC_FORM_ALLOWLIST.has(form) || accession === "" || primary === "" || filedAt === null || Date.parse(filedAt.value) < cutoff) continue;
    const acceptanceDate = parseSecAcceptance(acceptance);
    const acceptanceValid = acceptanceDate !== null && acceptanceDate.getTime() >= Date.parse(filedAt.value) && acceptanceDate.getTime() <= now.getTime() + 60_000;
    eligible.push({
      form,
      accession,
      primaryDocument: primary,
      primaryDescription: description.trim() || `${form} filing`,
      filedAt: filedAt.value,
      availableAt: acceptanceValid ? acceptanceDate.toISOString() : filedAt.value,
      availablePrecision: acceptanceValid ? "second" : "day",
      acceptanceOrder: acceptanceValid ? acceptanceDate.getTime() : Date.parse(filedAt.value),
    });
  }
  return eligible.sort((left, right) => right.acceptanceOrder - left.acceptanceOrder || right.filedAt.localeCompare(left.filedAt));
}

function parseSecAcceptance(value: string): Date | null {
  const compact = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(value);
  if (compact !== null) {
    const [, year, month, day, hour, minute, second] = compact;
    const timestamp = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
    const parsed = new Date(timestamp);
    if (parsed.toISOString().replace(/[-:TZ.]/g, "").slice(0, 14) === value) return parsed;
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp) : null;
}

function parseFederalDocument(value: unknown): FederalDocument | null {
  const parsed = FederalDocumentPayloadSchema.safeParse(value);
  if (!parsed.success || dayInstant(parsed.data.publication_date) === null || !isFederalUrl(parsed.data.html_url)) return null;
  const agencyValue = parsed.data.agencies?.find((item) => FederalAgencySchema.safeParse(item).success);
  const agency = FederalAgencySchema.safeParse(agencyValue);
  const agencyName = agency.success && agency.data.name?.trim() ? agency.data.name.trim() : "Federal Register";
  const slug = agency.success && agency.data.slug ? agency.data.slug : agencyName;
  const agencyCode = slug.toUpperCase().replace(/[^A-Z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "FEDERAL";
  return {
    documentNumber: parsed.data.document_number.trim(),
    title: parsed.data.title.trim(),
    publicationDate: parsed.data.publication_date,
    abstract: parsed.data.abstract?.trim() ?? "",
    type: parsed.data.type?.trim() || "Federal Register document",
    htmlUrl: parsed.data.html_url,
    rawTextUrl: parsed.data.raw_text_url ?? "",
    agencyName,
    agencyCode: agencyCode.length < 2 ? "FEDERAL" : agencyCode,
  };
}

function makeEvent(input: {
  id: string;
  subject: Subject;
  provider: Provider;
  nativeId: string;
  kind: Event["kind"];
  form: string;
  sourceTitle: string;
  title: string;
  summary: string;
  publishedAt: string;
  publishedPrecision: "second" | "day" | "unknown";
  availableAt: string;
  availablePrecision: "second" | "day" | "unknown";
  observedAt: string;
  sourceUrl: string;
  sourceDigest: string;
  evidenceCapture: Event["evidence"][number]["capture"];
  evidenceExcerpt: string;
  screening: Event["screening"];
}): Event {
  const label = input.provider === "sec" ? `SEC ${input.form} primary document only · exhibits not captured` : input.provider === "federal_register" ? `Federal Register ${input.form}` : `Finnhub company news · ${input.sourceTitle}`;
  return EventSchema.parse({
    id: input.id,
    subject: input.subject,
    kind: input.kind,
    form: input.form,
    title: truncate(input.title, 180),
    summary: truncate(input.summary || input.title, 1200),
    publishedAt: input.publishedAt,
    publishedPrecision: input.publishedPrecision,
    availableAt: input.availableAt,
    availablePrecision: input.availablePrecision,
    source: {
      provider: input.provider,
      nativeId: input.nativeId,
      url: input.sourceUrl,
      observedAt: input.observedAt,
      deliveryState: "network",
      availabilityAt: input.availableAt,
      availabilityPrecision: input.availablePrecision,
      freshness: "live",
      digest: input.sourceDigest,
    },
    evidence: [{
      label: input.sourceTitle ? `${label} · original description: ${truncate(input.sourceTitle, 180)}` : label,
      url: input.sourceUrl,
      capture: input.evidenceCapture,
      sourceNativeId: input.nativeId,
      excerpt: truncate(input.evidenceExcerpt || input.summary || input.title, 1200),
    }],
    screening: input.screening,
    review: { status: "unreviewed", note: "", updatedAt: null },
  });
}

function screeningRun(
  provider: Provider,
  nativeId: string,
  sourceDigest: string,
  sourceVersionDigest: string,
  captureKind: ScreeningRunRecord["captureKind"],
  result: NonNullable<Awaited<ReturnType<typeof screenOne>>>,
  accepted: boolean,
): ScreeningRunRecord {
  return {
    provider,
    nativeId,
    sourceDigest,
    sourceVersionDigest,
    contractDigest: result.contractDigest,
    evidenceComplete: result.screening.evidenceComplete,
    captureKind,
    status: accepted ? "accepted" : "excluded",
    resultDigest: result.resultDigest,
    promptDigest: result.promptDigest,
    model: result.model,
    screenedAt: result.screenedAt,
    lastValidatedAt: result.screenedAt,
  };
}

function healthFor(provider: Provider, successes: number, errors: readonly string[], eventCount: number, checkedAt: string): SourceHealth {
  const label = providerLabel(provider);
  const hasLiveObservation = successes > 0;
  const status = errors.length === 0 ? "healthy" : hasLiveObservation ? "degraded" : "offline";
  const freshness = hasLiveObservation ? "live" : "unavailable";
  const base = `${label} returned valid live data for this refresh slice; ${eventCount} categorized record${eventCount === 1 ? "" : "s"} were available.`;
  const message = errors.length === 0 ? base : `${label} is ${hasLiveObservation ? "partially degraded" : "unavailable"}. ${errors.slice(0, 2).join(" ")} Previous accepted records remain available with their original freshness.`;
  return SourceHealthSchema.parse({ provider, status, freshness, message, checkedAt });
}

function screeningHealth(pipeline: Pipeline, checkedAt: string): SourceHealth {
  const successes = pipeline.screeningSucceeded;
  const failures = pipeline.screeningFailed;
  const status = failures === 0 ? "healthy" : successes > 0 ? "degraded" : "offline";
  const freshness = successes > 0 ? "live" : "unavailable";
  const message = failures === 0
    ? `TypeSafe AI returned validated typed judgments for ${successes} new source record${successes === 1 ? "" : "s"}. Ranking and category placement are deterministic code; no trade decision is made.`
    : `${successes} TypeSafe judgment${successes === 1 ? "" : "s"} validated; ${failures} failed the provider or typed-output checks and were withheld for retry.`;
  return SourceHealthSchema.parse({ provider: "typesafe_ai", status, freshness, message, checkedAt });
}

function screeningForEvent(
  pipeline: Pipeline,
  provider: Provider,
  nativeId: string,
  digest: string,
  sourceVersionDigest: string,
  captureKind: ScreeningRunRecord["captureKind"],
  screened: NonNullable<Awaited<ReturnType<typeof screenOne>>>,
  accepted: boolean,
): void {
  pipeline.result.screenings.push(screeningRun(provider, nativeId, digest, sourceVersionDigest, captureKind, screened, accepted));
}

function dayInstant(value: string): { value: string } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const time = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(time)) return null;
  const iso = new Date(time).toISOString();
  if (iso.slice(0, 10) !== value) return null;
  return { value: iso };
}

function htmlText(value: string): string {
  return value
    .replace(/<!--([\s\S]*?)-->/g, " ")
    .replace(/<(script|style|svg|noscript|head)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|section|h[1-6]|tr|li|article|br|td)>/gi, ". ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, raw: string) => {
      const code = Number(raw);
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_match, raw: string) => {
      const code = Number.parseInt(raw, 16);
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
    })
    .replace(/\s+/g, " ")
    .trim();
}

function summarySentence(text: string): string | null {
  const clean = htmlText(text);
  const segments = clean.split(/(?<=[.!?])\s+/).map((item) => item.trim()).filter((item) => item.length >= 45 && item.length <= 1000);
  const candidate = segments.find((item) => {
    const words = item.split(/\s+/).length;
    const upper = item.replace(/[^A-Z]/g, "").length;
    return words >= 8 && upper / Math.max(item.length, 1) < 0.55 && !/^(UNITED STATES|SECURITIES AND EXCHANGE|TABLE OF CONTENTS|EXHIBIT \d)/i.test(item);
  });
  return candidate === undefined ? null : truncate(candidate, 180);
}

function isFederalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && ["www.federalregister.gov", "www.govinfo.gov"].includes(url.hostname);
  } catch {
    return false;
  }
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function rotate<T>(all: readonly T[], offset: number, count: number, key: (item: T) => string): { items: T[]; nextOffset: number } {
  if (all.length === 0) return { items: [], nextOffset: 0 };
  const start = offset % all.length;
  const size = Math.min(Math.max(count, 0), all.length);
  const items = Array.from({ length: size }, (_, index) => all[(start + index) % all.length]).filter((item): item is T => item !== undefined);
  const nextOffset = (start + items.length) % all.length;
  // Assert deterministic uniqueness before a cursor can be committed.
  if (new Set(items.map(key)).size !== items.length) throw new Error("Rotation batch contains duplicate identities.");
  return { items, nextOffset };
}

function rotateExcluding<T>(
  all: readonly T[],
  offset: number,
  count: number,
  key: (item: T) => string,
  excluded: ReadonlySet<string>,
): { items: T[]; nextOffset: number } {
  if (all.length === 0) return { items: [], nextOffset: 0 };
  const start = offset % all.length;
  const wanted = Math.min(Math.max(count, 0), Math.max(0, all.length - excluded.size));
  const items: T[] = [];
  let inspected = 0;
  while (inspected < all.length && items.length < wanted) {
    const item = all[(start + inspected) % all.length];
    inspected += 1;
    if (item !== undefined && !excluded.has(key(item))) items.push(item);
  }
  if (new Set(items.map(key)).size !== items.length) throw new Error("Rotation batch contains duplicate identities.");
  return { items, nextOffset: (start + inspected) % all.length };
}

async function mapLimit<T, R>(items: readonly T[], concurrency: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(Math.max(concurrency, 1), items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      const item = items[index];
      if (item !== undefined) output[index] = await worker(item, index);
    }
  });
  await Promise.all(runners);
  return output;
}

function truncate(value: string, max: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

function exactRank(issuer: IssuerSearchResult, normalized: string): number {
  if (issuer.ticker.toLowerCase() === normalized) return 0;
  if (issuer.name.toLowerCase() === normalized) return 1;
  if (issuer.ticker.toLowerCase().startsWith(normalized) || issuer.name.toLowerCase().startsWith(normalized)) return 2;
  return 3;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ProviderFailure ? error.message : error instanceof Error ? error.message.slice(0, 240) : fallback;
}

function rememberFailure(pipeline: Pipeline, error: unknown): void {
  if (!(error instanceof ProviderFailure)) return;
  if (error.provider === "sec" || error.provider === "federal_register" || error.provider === "finnhub_news") {
    const list = pipeline.sourceErrors.get(error.provider) ?? [];
    if (!list.includes(error.message)) list.push(error.message);
    pipeline.sourceErrors.set(error.provider, list);
  }
}

function setSourceErrors(pipeline: Pipeline, provider: Provider, errors: readonly string[]): void {
  const list = pipeline.sourceErrors.get(provider) ?? [];
  for (const error of errors) if (!list.includes(error)) list.push(error);
  pipeline.sourceErrors.set(provider, list);
}

function setSourceSuccesses(pipeline: Pipeline, provider: Provider, count: number): void {
  pipeline.sourceSuccesses.set(provider, (pipeline.sourceSuccesses.get(provider) ?? 0) + count);
}

function providerLabel(provider: string): string {
  switch (provider) {
    case "sec": return "SEC EDGAR";
    case "federal_register": return "Federal Register";
    case "finnhub_news": return "Finnhub company news";
    default: return "The provider";
  }
}
