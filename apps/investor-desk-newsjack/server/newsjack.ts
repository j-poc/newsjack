import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import {
  EventSchema,
  MarketContextSchema,
  CompanyCoverageSchema,
  AgencySchema,
  IssuerSchema,
  PublicCompanySchema,
  ScoreSchema,
  SourceHealthSchema,
  SourceRefSchema,
  TypedAnswerSchema,
  TypedChoiceAnswerSchema,
  TypedNoulAnswerSchema,
  TypedScoreAnswerSchema,
  type Agency,
  type Event,
  type CompanyCoverage,
  type Issuer,
  type SourceHealth,
  eventIdForSource,
  nowIso,
} from "../src/domain";
import type { WatchlistEntry } from "../src/domain";

const execFileAsync = promisify(execFile);
const TimeSchema = z.object({ value: z.string().datetime({ offset: true }), precision: z.enum(["second", "day", "unknown"]) }).strict();
const AuditIssuerSchema = z.object({ cik: z.string(), ticker: z.string(), name: z.string() }).strict();
const AuditCompanySchema = z.object({ symbol: z.string(), exchange: z.string(), name: z.string() }).strict();
const RawAnswerSchema = z.object({
  type: z.string(),
}).passthrough().and(z.union([
  z.object({ type: z.literal("score"), score: z.number().finite().min(0).max(4), legend: z.record(z.string(), z.string()), probabilities: z.record(z.string(), z.number().finite().min(0).max(1)), confidence: z.number().finite().min(0).max(1) }).passthrough(),
  z.object({ type: z.literal("choice"), choice: z.string().min(1), probabilities: z.record(z.string(), z.number().finite().min(0).max(1)), confidence: z.number().finite().min(0).max(1) }).passthrough(),
  z.object({ type: z.literal("noul"), noul: z.number().finite().min(0).max(1) }).passthrough(),
]));
const AuditItemSchema = z.object({
  native_id: z.string().min(1),
  issuer: AuditIssuerSchema.optional(),
  company: AuditCompanySchema.optional(),
  subject_kind: z.enum(["issuer", "company", "agency"]).optional(),
  subject_code: z.string().optional(),
  subject_name: z.string().optional(),
  form: z.string().min(1),
  primary_description: z.string(),
  filed_at: TimeSchema,
  available_at: TimeSchema,
  title: z.string().min(1),
  source: z.object({
    provider: z.enum(["sec", "federal_register", "finnhub_news"]),
    url: z.string().url(),
    native_id: z.string().min(1),
    observed_at: z.string().datetime({ offset: true }),
    document_digest: z.string().regex(/^[a-f0-9]{64}$/),
    normalized_digest: z.string().regex(/^[a-f0-9]{64}$/),
  }).passthrough(),
  evidence: z.object({
    excerpt: z.string(),
    complete: z.boolean(),
  }).passthrough(),
  screening: z.object({
    engine: z.string().min(1),
    model: z.string().min(1),
    model_confidence: z.number().int().min(0).max(100),
    typed_answers: z.record(z.string(), RawAnswerSchema),
    category: z.enum(["operations", "capital_allocation", "governance_legal", "risk_disclosure", "routine_disclosure"]),
    materiality: z.number().int().min(0).max(100),
    novelty: z.number().int().min(0).max(100),
    market_sensitivity: z.number().int().min(0).max(100),
    thesis_link: z.number().int().min(0).max(100),
    source_reliability: z.number().int().min(0).max(100),
    attention_score: z.number().int().min(0).max(100),
    lane: z.enum(["read_now", "monitor", "human_review", "incomplete", "passed"]),
    rationale: z.array(z.string().min(1)).min(1),
  }).passthrough(),
}).passthrough().refine((item) => (item.issuer !== undefined) !== (item.company !== undefined), "Each audit item must identify either an SEC issuer or a public company.");
const AuditSchema = z.object({
  version: z.number().int(),
  generated_at: z.string().datetime({ offset: true }),
  source: z.record(z.string(), z.unknown()),
  engine: z.record(z.string(), z.unknown()),
  items: z.array(AuditItemSchema),
  failures: z.array(z.object({ stage: z.string(), issuer: z.string().optional(), identity: z.string().optional(), error: z.string(), raw_path: z.string().optional(), raw_digest: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict()),
}).passthrough();
const FinnhubCoverageAuditSchema = z.object({
  feed: z.literal("finnhub_company_news_by_symbol"),
  delivery_state: z.literal("network"),
  universe_provider: z.literal("finnhub_stock_symbols_us_nyse_nasdaq_common_stock"),
  eligible_symbols: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  symbols_scanned: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  symbol_offset_before: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  symbol_offset_next: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  articles_received: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  articles_linked_to_universe: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  symbols_linked: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  records_screened: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  records_excluded_as_unrelated: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  has_deferred_records: z.boolean(),
  directory_digest: z.string().regex(/^[a-f0-9]{64}$/),
  directory_raw_path: z.string().min(1),
  news_digest: z.string().regex(/^[a-f0-9]{64}$/),
  news_raw_captures: z.array(z.object({ symbol: z.string().min(1), digest: z.string().regex(/^[a-f0-9]{64}$/), raw_path: z.string().min(1), articles: z.number().int().nonnegative(), failure: z.string().optional() }).strict()),
  observed_at: z.string().datetime({ offset: true }),
}).strict();

type InvestorAudit = z.infer<typeof AuditSchema>;
export type InvestorAuditItem = z.infer<typeof AuditItemSchema>;

export type InvestorScanResult = {
  audit: InvestorAudit;
  events: Event[];
  failures: string[];
  secHealth: ProviderHealthUpdate;
  federalHealth: ProviderHealthUpdate;
  companyNewsHealth: ProviderHealthUpdate;
  typesafeHealth: ProviderHealthUpdate;
  companyCoverage: CompanyCoverage | null;
  nextFinnhubSymbolOffset: number | null;
  canAdvanceFinnhubSymbolOffset: boolean;
  exitCode: number;
  stderr: string;
  runDirectory: string;
};

export type ProviderHealthUpdate =
  | { kind: "not_queried" }
  | { kind: "checked"; health: SourceHealth };

export function canAdvanceFinnhubSymbolOffset(input: {
  companyCoverage: CompanyCoverage | null;
  nextSymbolOffset: number | null;
  failures: readonly { stage: string }[];
  mappingFailures: number;
}): boolean {
  const blockingFailure = input.failures.some((failure) =>
    (failure.stage.startsWith("finnhub_") && failure.stage !== "finnhub_news_index") || failure.stage.startsWith("typesafe_"),
  );
  return input.companyCoverage !== null && input.nextSymbolOffset !== null && !blockingFailure && input.mappingFailures === 0;
}

function repoRoot(): string {
  return process.env.NEWSJACK_REPO_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
}

function cliRoot(): string {
  const root = repoRoot();
  return path.basename(root) === "cli" ? root : path.join(root, "apps", "cli");
}


// Run archives hold raw captures and evidence per scan; retention keeps the
// newest ones for audit without letting a 3-minute poll schedule fill the disk.
export async function pruneRunDirectories(root: string, keep = 24): Promise<void> {
  const runsDir = path.join(root, "runs");
  let entries: string[];
  try {
    entries = await fs.readdir(runsDir);
  } catch {
    return;
  }
  const named = entries.filter((name) => /^\d{4}-\d{2}-\d{2}T/.test(name)).sort().reverse();
  for (const name of named.slice(keep)) {
    try {
      await fs.rm(path.join(runsDir, name), { recursive: true, force: true });
    } catch {
      // A busy directory simply survives to the next pass.
    }
  }
}

export function dataRoot(): string {
  return process.env.SIGNAL_DESK_DATA_DIR ?? path.resolve("data");
}

function readCommandField(error: unknown, field: "stdout" | "stderr"): string {
  if (typeof error !== "object" || error === null) return "";
  if (field === "stdout" && "stdout" in error && typeof error.stdout === "string") return error.stdout;
  if (field === "stderr" && "stderr" in error && typeof error.stderr === "string") return error.stderr;
  return "";
}

function readCommandCode(error: unknown): number {
  if (typeof error !== "object" || error === null || !("code" in error)) return 1;
  const value = error.code;
  return typeof value === "number" ? value : 1;
}

function truncate(value: string, max: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function watchlistDocument(entries: readonly WatchlistEntry[]): string {
  return JSON.stringify({
    schema_version: 1,
    issuers: entries.map(({ issuer }) => ({ cik: issuer.cik.value, ticker: issuer.ticker.value, name: issuer.name })),
    screen: {
      include_forms: ["8-K", "8-K/A", "10-Q", "10-Q/A", "10-K", "10-K/A"],
      research_focus: ["material operating, financing, governance, or legal changes"],
    },
  }, null, 2);
}

async function readAuditFile(runDirectory: string, stdout: string): Promise<InvestorAudit> {
  const raw = stdout.trim().length > 0 ? stdout : await fs.readFile(path.join(runDirectory, "audit.json"), "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Investor scan returned invalid JSON: ${error instanceof Error ? error.message : "parse failure"}`);
  }
  return AuditSchema.parse(parsed);
}

function makeIssuer(raw: NonNullable<InvestorAuditItem["issuer"]>): Issuer {
  return IssuerSchema.parse({
    kind: "issuer",
    name: raw.name || raw.ticker,
    ticker: { kind: "ticker", value: raw.ticker },
    cik: { kind: "cik", value: raw.cik },
  });
}

function makeSubject(item: InvestorAuditItem): Issuer | Agency | ReturnType<typeof PublicCompanySchema.parse> {
  if (item.subject_kind === "agency") {
    return AgencySchema.parse({
      kind: "agency",
      name: item.subject_name || item.issuer?.name || "Federal Register",
      code: item.subject_code || "FEDERAL",
    });
  }
  if (item.subject_kind === "company") {
    if (item.company === undefined) throw new Error("company subject is missing company identity");
    return PublicCompanySchema.parse({ kind: "public_company", name: item.company.name || item.company.symbol, symbol: item.company.symbol, exchange: item.company.exchange });
  }
  if (item.issuer === undefined) throw new Error("issuer subject is missing issuer identity");
  return makeIssuer(item.issuer);
}

function answerRecord(raw: InvestorAuditItem["screening"]["typed_answers"]): Record<string, z.infer<typeof TypedAnswerSchema>> {
  const parsed = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, value.type === "choice"
    ? TypedChoiceAnswerSchema.parse({ type: value.type, choice: value.choice, probabilities: value.probabilities, confidence: value.confidence })
    : value.type === "noul"
      ? TypedNoulAnswerSchema.parse({ type: value.type, noul: value.noul })
      : TypedScoreAnswerSchema.parse({ type: value.type, score: value.score, legend: value.legend, probabilities: value.probabilities, confidence: value.confidence })]));
  return z.record(z.string(), TypedAnswerSchema).parse(parsed);
}

function decisionForLane(lane: InvestorAuditItem["screening"]["lane"]): "review" | "watch" | "ignore" {
  switch (lane) {
    case "read_now":
    case "human_review":
    case "incomplete":
      return "review";
    case "monitor":
      return "watch";
    case "passed":
      return "ignore";
    default: {
      const exhaustive: never = lane;
      return exhaustive;
    }
  }
}

export function eventFromItem(item: InvestorAuditItem): Event {
  const subject = makeSubject(item);
  const provider = item.source.provider;
  const excerpt = truncate(item.evidence.excerpt, 720);
  const description = item.primary_description.trim();
  const isCompanyNews = provider === "finnhub_news";
  const summary = truncate([
    description.length > 0 ? `Source document: ${description}.` : `${item.form} filing.`,
    `${isCompanyNews ? "Published" : "Filed"} ${item.filed_at.value.slice(0, 10)}.`,
    excerpt,
  ].join(" "), 1000);
  const source = SourceRefSchema.parse({
    provider,
    nativeId: item.source.native_id,
    url: item.source.url,
    observedAt: item.source.observed_at,
    deliveryState: "network",
    availabilityAt: item.available_at.value,
    availabilityPrecision: item.available_at.precision,
    freshness: "live",
    digest: item.source.document_digest,
  });
  const screening = item.screening;
  return EventSchema.parse({
    id: eventIdForSource(provider, item.native_id),
    subject,
    kind: isCompanyNews ? "news" : "filing",
    form: item.form,
    title: item.title,
    summary,
    publishedAt: item.filed_at.value,
    publishedPrecision: item.filed_at.precision,
    availableAt: item.available_at.value,
    availablePrecision: item.available_at.precision,
    source,
    evidence: [{
      label: provider === "sec" ? `SEC ${item.form} filing` : provider === "finnhub_news" ? "Finnhub company news" : `Federal Register ${item.form}`,
      url: item.source.url,
            // The desk holds the captured excerpt whenever one exists; bounded text is
      // still content — completeness is tracked on the screening, matching the
      // private Worker runtime.
      capture: item.evidence.excerpt.trim().length > 0 ? "content" : "reference",
      sourceNativeId: item.source.native_id,
      excerpt: excerpt || "Primary filing text was not captured.",
    }],
    screening: {
      level: item.screening_level,
      engine: "typesafe_ai",
      modelConfidence: ScoreSchema.parse(screening.model_confidence),
      typedAnswers: answerRecord(screening.typed_answers),
      category: screening.category,
      evidenceComplete: item.evidence.complete,
      materiality: ScoreSchema.parse(screening.materiality),
      novelty: ScoreSchema.parse(screening.novelty),
      marketSensitivity: ScoreSchema.parse(screening.market_sensitivity),
      thesisMatch: ScoreSchema.parse(screening.thesis_link),
      sourceReliability: ScoreSchema.parse(screening.source_reliability),
      attentionScore: ScoreSchema.parse(screening.attention_score),
      decision: decisionForLane(screening.lane),
      rationale: screening.rationale,
    },
    review: { status: "unreviewed", note: "", updatedAt: null },
    ...(item.market_context === undefined ? {} : (() => {
      const raw = item.market_context as Record<string, unknown>;
      const parsed = MarketContextSchema.safeParse({
        ticker: raw.ticker,
        baselineDate: raw.baseline_date,
        baselineClose: raw.baseline_close,
        latestDate: raw.latest_date,
        latestClose: raw.latest_close,
        changePercent: raw.change_percent,
        source: raw.source,
        observedAt: raw.observed_at,
        ...(raw.series !== undefined && raw.filed_index !== undefined ? {
          series: raw.series,
          filedIndex: raw.filed_index,
        } : {}),
      });
      return parsed.success ? { marketContext: parsed.data } : {};
    })()),
  });
}

function health(provider: string, status: "healthy" | "degraded" | "offline", freshness: "live" | "cached" | "stale" | "unavailable", message: string): SourceHealth {
  return SourceHealthSchema.parse({ provider, status, freshness, message, checkedAt: nowIso() });
}

function countField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function finnHubCoverageFromAudit(audit: InvestorAudit): { coverage: CompanyCoverage | null; nextSymbolOffset: number | null } {
  const raw = audit.source.finnhub_coverage;
  if (raw === undefined) return { coverage: null, nextSymbolOffset: null };
  const parsed = FinnhubCoverageAuditSchema.parse(raw);
  return {
    coverage: CompanyCoverageSchema.parse({
      universeProvider: parsed.universe_provider,
      deliveryState: parsed.delivery_state,
      eligibleSymbols: parsed.eligible_symbols,
      symbolsScanned: parsed.symbols_scanned,
      symbolOffsetBefore: parsed.symbol_offset_before,
      symbolOffsetNext: parsed.symbol_offset_next,
      articlesReceived: parsed.articles_received,
      articlesLinkedToUniverse: parsed.articles_linked_to_universe,
      symbolsLinked: parsed.symbols_linked,
      recordsScreened: parsed.records_screened,
      recordsExcludedAsUnrelated: parsed.records_excluded_as_unrelated,
      hasDeferredRecords: parsed.has_deferred_records,
      observedAt: parsed.observed_at,
      directoryDigest: parsed.directory_digest,
      newsDigest: parsed.news_digest,
    }),
    nextSymbolOffset: parsed.symbol_offset_next,
  };
}

export function healthFromAudit(audit: InvestorAudit, companyCoverage: CompanyCoverage | null): { sec: ProviderHealthUpdate; federal: ProviderHealthUpdate; companyNews: ProviderHealthUpdate; typesafe: ProviderHealthUpdate } {
	const scope = typeof audit.source.scope === "string" ? audit.source.scope : "";
	const secRequested = scope === "watchlist" || scope === "all_public" || scope === "all";
	const federalRequested = scope === "federal" || scope === "all";
	const companyNewsRequested = scope === "company_news" || scope === "all";
  const finnhubProcessingDisabled = audit.source.finnhub_processing_state === "disabled_pending_written_approval";
  const secFailures = audit.failures.filter((failure) => failure.stage.startsWith("sec_")).length;
  const typesafeFailures = audit.failures.filter((failure) => failure.stage.startsWith("typesafe_")).length;
  const filings = "sec_filings" in audit.source ? countField(audit.source, "sec_filings") : countField(audit.source, "filings_considered");
  const secStreamConsidered = countField(audit.source, "sec_stream_considered");
  const secStreamSurfaced = countField(audit.source, "sec_stream_surfaced");
  const secStreamPassed = countField(audit.source, "sec_stream_passed");
  const calls = countField(audit.engine, "calls");
  const federalFilings = countField(audit.source, "federal_register_filings");
  const federalFailures = audit.failures.filter((failure) => failure.stage.startsWith("federal_register_")).length;
  const companyNews = countField(audit.source, "finnhub_news");
  const companyNewsFailures = audit.failures.filter((failure) => failure.stage.startsWith("finnhub_news") || failure.stage.startsWith("finnhub_symbols")).length;
  const tickerRequestFailures = audit.failures.filter((failure) => failure.stage === "finnhub_news_index").length;
  const secStatus = filings > 0 ? (secFailures === 0 ? "healthy" : "degraded") : "offline";
	const typesafeStatus = typesafeFailures === 0 ? "healthy" : "degraded";
  const federalStatus = federalFailures === 0 && federalFilings > 0 ? "healthy" : federalFilings > 0 ? "degraded" : "offline";
  const companyNewsStatus = finnhubProcessingDisabled ? "offline" : companyCoverage !== null ? (companyNewsFailures === 0 ? "healthy" : "degraded") : companyNews > 0 ? "degraded" : "offline";
  const companyNewsMessage = finnhubProcessingDisabled
    ? "Not requested: written approval for third-party TypeSafe processing has not been confirmed."
    : companyCoverage === null
    ? (companyNewsFailures === 0 ? `Finnhub returned ${companyNews} company-news records.` : `Finnhub returned ${companyNews} company-news records with ${companyNewsFailures} disclosed failures.`)
    : `Live company news checked ${companyCoverage.symbolsScanned} of ${companyCoverage.eligibleSymbols.toLocaleString()} supported US common-stock listings this pass; ${companyCoverage.articlesLinkedToUniverse} stories passed attribution across ${companyCoverage.symbolsLinked} tickers, ${companyNews} records retained, and ${companyCoverage.recordsExcludedAsUnrelated} withheld during ticker-attribution review${companyCoverage.hasDeferredRecords ? "; the per-run TypeSafe item cap was reached; remaining returned items are retained only as raw evidence and were not screened" : "; scanning rotates through the remaining directory"}${tickerRequestFailures > 0 ? `; ${tickerRequestFailures} failed ticker request(s) are retained for retry on the next rotation` : ""}.`;
  return {
    sec: secRequested ? { kind: "checked", health: health("sec", secStatus, filings > 0 ? "live" : "unavailable", secFailures === 0
        ? (secStreamConsidered > 0
          ? `SEC stream: ${secStreamConsidered.toLocaleString()} filings ingested · ${secStreamSurfaced.toLocaleString()} surfaced for review · ${secStreamPassed.toLocaleString()} passed as routine.`
          : `SEC captured ${filings} eligible filings.`)
        : `SEC captured ${filings} filings with ${secFailures} disclosed failures.`) } : { kind: "not_queried" },
    federal: federalRequested ? { kind: "checked", health: health("federal_register", federalStatus, federalFilings > 0 ? "live" : "unavailable", federalFailures === 0 ? `Federal Register captured ${federalFilings} documents.` : `Federal Register captured ${federalFilings} documents with ${federalFailures} disclosed failures.`) } : { kind: "not_queried" },
    companyNews: companyNewsRequested ? { kind: "checked", health: health("finnhub_news", companyNewsStatus, finnhubProcessingDisabled ? "unavailable" : companyCoverage !== null ? "live" : companyNews > 0 ? "live" : "unavailable", companyNewsMessage) } : { kind: "not_queried" },
    typesafe: calls > 0 ? { kind: "checked", health: health("typesafe_ai", typesafeStatus, "live", typesafeFailures === 0 ? `TypeSafe AI screened ${calls} records.` : `TypeSafe AI screened ${calls} records with ${typesafeFailures} disclosed failures.`) } : { kind: "not_queried" },
  };
}

export async function runInvestorScan(entries: readonly WatchlistEntry[], source: "watchlist" | "all_public" | "company_news" | "federal" | "all", finnhubSymbolOffset = 0): Promise<InvestorScanResult> {
  if (source === "watchlist" && entries.length === 0) throw new Error("Your watchlist is empty. Choose all public issuers or add an issuer before refreshing the wire.");
  const runDirectory = path.join(dataRoot(), "runs", `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`);
  await fs.mkdir(runDirectory, { recursive: true });
  const watchlistPath = path.join(runDirectory, "watchlist.json");
  if (source === "watchlist") await fs.writeFile(watchlistPath, watchlistDocument(entries), "utf8");
  // The stream re-discovers filings across this window; weekends need more
  // than 24 hours for a Monday desk to see Friday's filings.
  const sinceHours = Math.max(24, Number(process.env.NEWSJACK_STREAM_SINCE_HOURS ?? 24) || 24);
  const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000).toISOString();
  const maxIssuers = process.env.NEWSJACK_MAX_ISSUERS ?? "500";
  const maxFilings = process.env.NEWSJACK_MAX_FILINGS_PER_ISSUER ?? "12";
  const maxCompanyNewsItems = process.env.NEWSJACK_MAX_COMPANY_NEWS_ITEMS ?? "500";
  const maxCompanyNewsSymbols = process.env.NEWSJACK_MAX_COMPANY_NEWS_SYMBOLS ?? "50";
  const scanArgs = ["investor", "scan", "--source", source, "--since", since, "--run-dir", runDirectory, "--max-issuers", maxIssuers, "--max-filings-per-issuer", maxFilings, "--max-company-news-items", maxCompanyNewsItems, "--max-company-news-symbols", maxCompanyNewsSymbols];
  if (source === "company_news" || source === "all") scanArgs.push("--finnhub-symbol-offset", String(finnhubSymbolOffset));
  if (source === "watchlist") scanArgs.push("--watchlist", watchlistPath);
  scanArgs.push("--sec-cache-dir", path.join(dataRoot(), "sec-cache"));
  if (source === "all_public") scanArgs.push("--auto");
  const userAgent = process.env.NEWSJACK_SEC_USER_AGENT ?? process.env.SEC_USER_AGENT ?? "";
  if (userAgent.length > 0) scanArgs.push("--user-agent", userAgent);
  const configuredCli = process.env.NEWSJACK_CLI;
  const command = configuredCli ?? "go";
  const args = configuredCli === undefined ? ["run", "./cmd/newsjack", ...scanArgs] : scanArgs;
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  try {
    const result = await execFileAsync(command, args, {
      cwd: configuredCli === undefined ? cliRoot() : repoRoot(),
      env: {
        ...process.env,
        GOCACHE: process.env.GOCACHE ?? path.join(dataRoot(), "go-cache"),
        GOMODCACHE: process.env.GOMODCACHE ?? path.join(dataRoot(), "go-mod-cache"),
      },
      maxBuffer: 30 * 1024 * 1024,
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    stdout = readCommandField(error, "stdout");
    stderr = readCommandField(error, "stderr");
    exitCode = readCommandCode(error);
  }
  let audit: InvestorAudit;
  try {
    audit = await readAuditFile(runDirectory, stdout);
  } catch (error) {
    const detail = stderr.trim();
    if (detail.length > 0) throw new Error(`Investor scan failed: ${truncate(detail, 600)}`);
    throw new Error(error instanceof z.ZodError ? "Investor scan returned an invalid audit artifact." : "Investor scan did not produce an audit artifact.");
  }
  const mapped = audit.items.flatMap((item) => {
    try {
      return [eventFromItem(item)];
    } catch (error) {
      return [];
    }
  });
  const mappingFailures = audit.items.length - mapped.length;
  const { coverage: companyCoverage, nextSymbolOffset: nextFinnhubSymbolOffset } = finnHubCoverageFromAudit(audit);
  const healthPair = healthFromAudit(audit, companyCoverage);
  const failures = [
    ...audit.failures.map((failure) => `${failure.stage}: ${failure.error}`),
    ...(mappingFailures > 0 ? [`ui_mapping: ${mappingFailures} audit item(s) failed the browser contract`] : []),
  ];
  return {
    audit,
    events: mapped,
    failures,
    secHealth: healthPair.sec,
    federalHealth: healthPair.federal,
    companyNewsHealth: healthPair.companyNews,
    typesafeHealth: healthPair.typesafe,
    companyCoverage,
    nextFinnhubSymbolOffset,
    canAdvanceFinnhubSymbolOffset: canAdvanceFinnhubSymbolOffset({ companyCoverage, nextSymbolOffset: nextFinnhubSymbolOffset, failures: audit.failures, mappingFailures }),
    exitCode,
    stderr: truncate(stderr, 600),
    runDirectory,
  };
}
