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

export const TimePrecisionSchema = z.enum(["second", "day", "unknown"]);
export type TimePrecision = z.infer<typeof TimePrecisionSchema>;

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
  availabilityAt: InstantSchema,
  availabilityPrecision: TimePrecisionSchema,
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
  engine: z.string().min(1),
  modelConfidence: ScoreSchema,
  typedAnswers: z.record(z.string(), TypedScoreAnswerSchema).refine((answers) => Object.keys(answers).length > 0, "At least one typed answer is required."),
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

export const EventSchema = z.object({
  id: z.string().min(1),
  issuer: IssuerSchema,
  kind: EventKindSchema,
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
  message: z.string().min(1),
  checkedAt: InstantSchema,
}).strict();
export type SourceHealth = z.infer<typeof SourceHealthSchema>;

export const AppSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  events: z.array(EventSchema),
  watchlist: z.array(WatchlistEntrySchema),
  sourceHealth: z.array(SourceHealthSchema),
  lastRefreshAt: InstantSchema.nullable(),
}).strict();
export type AppSnapshot = z.infer<typeof AppSnapshotSchema>;

export const ReviewUpdateSchema = z.object({
  status: ReviewStatusSchema,
  note: z.string().max(2000).default(""),
}).strict();
export type ReviewUpdate = z.infer<typeof ReviewUpdateSchema>;

export const RefreshRequestSchema = z.object({
  source: z.literal("sec"),
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
    return right.availableAt.localeCompare(left.availableAt);
  });
}
