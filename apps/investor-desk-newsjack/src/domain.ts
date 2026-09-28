import { z } from "zod";

export const TickerSchema = z.object({
  kind: z.literal("ticker"),
  value: z.string().regex(/^[A-Z][A-Z0-9.-]{0,9}$/),
}).strict();
export type Ticker = z.infer<typeof TickerSchema>;

export const CikSchema = z.object({
  kind: z.literal("cik"),
  value: z.string().regex(/^\d{10}$/),
}).strict();
export type Cik = z.infer<typeof CikSchema>;

export const IssuerSchema = z.object({
  kind: z.literal("issuer"),
  name: z.string().min(1),
  ticker: TickerSchema,
  cik: CikSchema,
}).strict();
export type Issuer = z.infer<typeof IssuerSchema>;

export const IssuerSearchResultSchema = z.object({
  cik: z.string().regex(/^\d{10}$/),
  ticker: z.string().regex(/^[A-Z][A-Z0-9.-]{0,9}$/),
  name: z.string().min(1),
  exchange: z.string().min(1),
}).strict();
export type IssuerSearchResult = z.infer<typeof IssuerSearchResultSchema>;

export const AgencySchema = z.object({
  kind: z.literal("agency"),
  name: z.string().min(1),
  code: z.string().regex(/^[A-Z0-9-]{2,24}$/),
}).strict();
export type Agency = z.infer<typeof AgencySchema>;

export const PublicCompanySchema = z.object({
  kind: z.literal("public_company"),
  name: z.string().min(1),
  symbol: z.string().regex(/^[A-Z0-9.-]{1,20}$/),
  exchange: z.string().regex(/^[A-Z0-9.-]{2,12}$/),
}).strict();
export type PublicCompany = z.infer<typeof PublicCompanySchema>;

export const SubjectSchema = z.discriminatedUnion("kind", [IssuerSchema, PublicCompanySchema, AgencySchema]);
export type Subject = z.infer<typeof SubjectSchema>;

export const TimePrecisionSchema = z.enum(["second", "day", "unknown"]);
export type TimePrecision = z.infer<typeof TimePrecisionSchema>;

export const FreshnessSchema = z.enum(["live", "cached", "stale", "unavailable"]);
export type Freshness = z.infer<typeof FreshnessSchema>;

export const InstantSchema = z.string().datetime({ offset: true });
export type Instant = z.infer<typeof InstantSchema>;

export const ScoreSchema = z.number().int().min(0).max(100);
export type Score = z.infer<typeof ScoreSchema>;

export const TypedScoreAnswerSchema = z.object({
  type: z.literal("score"),
  score: z.number().finite().min(0).max(4),
  legend: z.record(z.string(), z.string()),
  probabilities: z.record(z.string(), z.number().finite().min(0).max(1)),
  confidence: z.number().finite().min(0).max(1),
}).strict();
export type TypedScoreAnswer = z.infer<typeof TypedScoreAnswerSchema>;

export const TypedChoiceAnswerSchema = z.object({
  type: z.literal("choice"),
  choice: z.string().min(1),
  probabilities: z.record(z.string(), z.number().finite().min(0).max(1)),
  confidence: z.number().finite().min(0).max(1),
}).strict();
export type TypedChoiceAnswer = z.infer<typeof TypedChoiceAnswerSchema>;
export const TypedNoulAnswerSchema = z.object({
  type: z.literal("noul"),
  noul: z.number().finite().min(0).max(1),
}).strict();
export type TypedNoulAnswer = z.infer<typeof TypedNoulAnswerSchema>;
export const TypedAnswerSchema = z.discriminatedUnion("type", [TypedScoreAnswerSchema, TypedChoiceAnswerSchema, TypedNoulAnswerSchema]);
export type TypedAnswer = z.infer<typeof TypedAnswerSchema>;

export const FilingCategorySchema = z.enum(["operations", "capital_allocation", "governance_legal", "risk_disclosure", "routine_disclosure"]);
export type FilingCategory = z.infer<typeof FilingCategorySchema>;

export const EventKindSchema = z.enum([
  "filing",
  "earnings",
  "guidance",
  "regulatory",
  "corporate_action",
  "news",
]);
export type EventKind = z.infer<typeof EventKindSchema>;

export const DecisionSchema = z.enum(["review", "watch", "ignore"]);
export type Decision = z.infer<typeof DecisionSchema>;

export const ReviewStatusSchema = z.enum(["unreviewed", "reviewed", "snoozed", "dismissed"]);
export type ReviewStatus = z.infer<typeof ReviewStatusSchema>;

export const EvidenceCaptureSchema = z.enum(["reference", "content"]);
export type EvidenceCapture = z.infer<typeof EvidenceCaptureSchema>;

export const SourceRefSchema = z.object({
  provider: z.string().min(1),
  nativeId: z.string().min(1),
  url: z.string().url(),
  observedAt: InstantSchema,
  deliveryState: z.enum(["network", "cache"]).default("network"),
  availabilityAt: InstantSchema,
  availabilityPrecision: TimePrecisionSchema,
  freshness: FreshnessSchema,
  digest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type SourceRef = z.infer<typeof SourceRefSchema>;

export const EvidenceRefSchema = z.object({
  label: z.string().min(1),
  url: z.string().url(),
  capture: EvidenceCaptureSchema,
  sourceNativeId: z.string().min(1),
  excerpt: z.string().min(1),
}).strict();
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

export const ScreeningSchema = z.object({
  level: z.enum(["coarse", "deep"]).optional(),
  engine: z.string().min(1),
  modelConfidence: ScoreSchema,
  typedAnswers: z.record(z.string(), TypedAnswerSchema).refine((answers) => Object.keys(answers).length > 0, "At least one typed answer is required."),
  category: FilingCategorySchema,
  evidenceComplete: z.boolean(),
  materiality: ScoreSchema,
  novelty: ScoreSchema,
  marketSensitivity: ScoreSchema,
  thesisMatch: ScoreSchema,
  sourceReliability: ScoreSchema,
  attentionScore: ScoreSchema,
  decision: DecisionSchema,
  rationale: z.array(z.string().min(1)).min(1),
}).strict();
export type Screening = z.infer<typeof ScreeningSchema>;

export const ReviewSchema = z.object({
  status: ReviewStatusSchema,
  note: z.string().max(2000),
  updatedAt: InstantSchema.nullable(),
}).strict();
export type Review = z.infer<typeof ReviewSchema>;

export const MarketContextSchema = z.object({
  ticker: z.string().min(1),
  baselineDate: InstantSchema,
  baselineClose: z.number().finite().positive(),
  latestDate: InstantSchema,
  latestClose: z.number().finite().positive(),
  changePercent: z.number().finite(),
  source: z.literal("yahoo_finance"),
  observedAt: InstantSchema,
}).strict();
export type MarketContext = z.infer<typeof MarketContextSchema>;

export const EventSchema = z.object({
  id: z.string().min(1),
  subject: SubjectSchema,
  kind: EventKindSchema,
  form: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().min(1),
  publishedAt: InstantSchema,
  publishedPrecision: TimePrecisionSchema,
  availableAt: InstantSchema,
  availablePrecision: TimePrecisionSchema,
  source: SourceRefSchema,
  evidence: z.array(EvidenceRefSchema).min(1),
  screening: ScreeningSchema,
  review: ReviewSchema,
  marketContext: MarketContextSchema.optional(),
}).strict();
export type Event = z.infer<typeof EventSchema>;

export const WatchlistEntrySchema = z.object({
  issuer: IssuerSchema,
  addedAt: InstantSchema,
}).strict();
export type WatchlistEntry = z.infer<typeof WatchlistEntrySchema>;

export const SourceHealthSchema = z.object({
  provider: z.string().min(1),
  status: z.enum(["healthy", "degraded", "offline"]),
  freshness: FreshnessSchema,
  message: z.string().min(1),
  checkedAt: InstantSchema,
}).strict();
export type SourceHealth = z.infer<typeof SourceHealthSchema>;

export const PublicIssuerCoverageSchema = z.object({
  universeProvider: z.literal("sec_company_tickers_exchange"),
  deliveryState: z.literal("network"),
  eligibleIssuers: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  activeCoverageIssuers: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  issuersScanned: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  offsetBefore: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  offsetAfter: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  recentFilingsFound: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  recordsScreened: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  recordsPlaced: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  retrievedAt: InstantSchema,
  directoryDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type PublicIssuerCoverage = z.infer<typeof PublicIssuerCoverageSchema>;

export const CompanyCoverageSchema = z.object({
  universeProvider: z.literal("finnhub_stock_symbols_us_nyse_nasdaq_common_stock"),
  deliveryState: z.literal("network"),
  eligibleSymbols: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  symbolsScanned: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  symbolOffsetBefore: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  symbolOffsetNext: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  articlesReceived: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  articlesLinkedToUniverse: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  symbolsLinked: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  recordsScreened: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  recordsExcludedAsUnrelated: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  hasDeferredRecords: z.boolean(),
  observedAt: InstantSchema,
  directoryDigest: z.string().regex(/^[a-f0-9]{64}$/),
  newsDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type CompanyCoverage = z.infer<typeof CompanyCoverageSchema>;

export const EventScopeSchema = z.enum(["watchlist", "all_public", "federal", "all"]);
export type EventScope = z.infer<typeof EventScopeSchema>;
export const EVENTS_PAGE_SIZE = 20;

export const EventCursorSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  scope: EventScopeSchema,
  attentionScore: ScoreSchema,
  availableAt: InstantSchema,
  id: z.string().min(1).max(400),
}).strict();
export type EventCursor = z.infer<typeof EventCursorSchema>;

export const EventPageSchema = z.object({
  events: z.array(EventSchema),
  eventsTotal: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  eventsRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  eventsCursor: z.string().min(1).max(2048).nullable(),
}).strict();
export type EventPage = z.infer<typeof EventPageSchema>;

export const AppSnapshotSchema = z.object({
  schemaVersion: z.literal(2),
  events: z.array(EventSchema),
  eventsTotal: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  eventsRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  eventsCursor: z.string().min(1).max(2048).nullable(),
  eventsScope: EventScopeSchema,
  watchlist: z.array(WatchlistEntrySchema),
  companyCoverage: CompanyCoverageSchema.nullable(),
  publicIssuerCoverage: PublicIssuerCoverageSchema.nullable().default(null),
  sourceHealth: z.array(SourceHealthSchema),
  lastRefreshAt: InstantSchema.nullable(),
}).strict();
export type AppSnapshot = z.infer<typeof AppSnapshotSchema>;

export const ReviewUpdateSchema = z.object({
  status: ReviewStatusSchema,
  note: z.string().max(2000).default(""),
  expectedReview: ReviewSchema,
}).strict();
export type ReviewUpdate = z.infer<typeof ReviewUpdateSchema>;

export const RefreshRequestSchema = z.object({
  source: z.enum(["watchlist", "all_public", "company_news", "federal", "all"]),
}).strict();
export type RefreshRequest = z.infer<typeof RefreshRequestSchema>;

export const WatchlistActionSchema = z.object({
  action: z.enum(["add", "remove"]),
  issuer: IssuerSchema,
}).strict();
export type WatchlistAction = z.infer<typeof WatchlistActionSchema>;

export function nowIso(): Instant {
  return new Date().toISOString();
}

export function nextReviewUpdatedAt(now: Instant, previous: Review): Instant {
  const candidate = Date.parse(InstantSchema.parse(now));
  const previousAt = previous.updatedAt === null ? Number.NEGATIVE_INFINITY : Date.parse(previous.updatedAt);
  return new Date(Math.max(candidate, previousAt + 1)).toISOString();
}

export function scoreAttention(input: Pick<Screening, "materiality" | "novelty" | "marketSensitivity" | "thesisMatch" | "sourceReliability">): Score {
  const weighted =
    input.materiality * 30 +
    input.novelty * 18 +
    input.marketSensitivity * 22 +
    input.thesisMatch * 18 +
    input.sourceReliability * 12;
  return Math.min(100, Math.max(0, Math.trunc((weighted + 50) / 100)));
}

export function decisionForScore(score: Score): Decision {
  if (score >= 72) return "review";
  if (score >= 50) return "watch";
  return "ignore";
}

export function canonicalSourceId(provider: string, nativeId: string): string {
  return `${provider.toLowerCase()}:${nativeId.trim()}`;
}

export function eventIdForSource(provider: string, nativeId: string): string {
  return canonicalSourceId(provider, nativeId).replace(/[^a-z0-9:_-]/gi, "-");
}

export function formatIssuer(issuer: Issuer): string {
  return `${issuer.name} (${issuer.ticker.value})`;
}

export function isReviewable(event: Event): boolean {
  return event.screening.decision === "review" && event.review.status === "unreviewed";
}

export function sortEvents(events: readonly Event[]): Event[] {
  return [...events].sort((left, right) => {
    const scoreDelta = right.screening.attentionScore - left.screening.attentionScore;
    if (scoreDelta !== 0) return scoreDelta;
    const timeDelta = Date.parse(right.availableAt) - Date.parse(left.availableAt);
    if (timeDelta !== 0) return timeDelta;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

export function encodeEventCursor(cursor: EventCursor): string {
  return encodeURIComponent(JSON.stringify(EventCursorSchema.parse(cursor)));
}

export function decodeEventCursor(value: string): EventCursor | null {
  if (value.length > 2048) return null;
  try {
    return EventCursorSchema.parse(JSON.parse(decodeURIComponent(value)));
  } catch {
    return null;
  }
}
