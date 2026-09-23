import {
  DecisionSchema,
  FilingCategorySchema,
  ScoreSchema,
  TypedAnswerSchema,
  decisionForScore,
  scoreAttention,
  TypedChoiceAnswerSchema,
  TypedNoulAnswerSchema,
  TypedScoreAnswerSchema,
  type Decision,
  type FilingCategory,
  type Issuer,
  type PublicCompany,
  type Screening,
  type Subject,
  type TypedAnswer,
} from "../src/domain";
import investorQuestions from "../../cli/cmd/newsjack/investor_questions.json";
import { CapturedProviderFailure, digestHex, fetchCaptured, type CapturedBody } from "./capture";
import { ProviderFailure, RequestBudget, type CaptureRecord, type WorkerEnv } from "./types";
import { z } from "zod";

const MODEL = "jev-latest";
const SCREENING_CONTRACT_VERSION = 3;
const SYSTEM_ONE_URL = "https://api.typesafe.ai/v1/systemone";
const ProbabilityRecordSchema = z.record(z.string(), z.number().finite().min(0).max(1));
const TypeSafeResponseSchema = z.object({
  model: z.string().trim().min(1).optional(),
  answers: z.record(z.string(), z.unknown()),
}).passthrough();
const InvestorAnswersSchema = z.object({
  materiality: TypedScoreAnswerSchema,
  novelty: TypedScoreAnswerSchema,
  market_sensitivity: TypedScoreAnswerSchema,
  thesis_link: TypedScoreAnswerSchema,
  category: TypedChoiceAnswerSchema,
  company_relevance: TypedNoulAnswerSchema.optional(),
});

export interface ScreeningInput {
  ownerId: string;
  provider: "sec" | "federal_register" | "finnhub_news";
  nativeId: string;
  sourceDigest: string;
  subject: Subject;
  form: string;
  sourceTitle: string;
  sourceText: string;
  sourceUrl: string;
  sourceObservedAt: string;
  sourceAvailableAt: string;
  sourceAvailablePrecision: "second" | "day" | "unknown";
  evidenceComplete: boolean;
  sourceReliability: number;
  beforeRequest?: () => Promise<void>;
}

export interface ScreeningResult {
  model: string;
  screening: Screening;
  relevant: boolean;
  resultDigest: string;
  promptDigest: string;
  contractDigest: string;
  screenedAt: string;
  capture: CaptureRecord;
}

export async function screeningContractDigest(provider: ScreeningInput["provider"]): Promise<string> {
  return (await screeningContract(provider)).contractDigest;
}

export async function screenSource(
  env: WorkerEnv,
  input: ScreeningInput,
  budget: RequestBudget,
  captures: CaptureRecord[],
): Promise<ScreeningResult> {
  const apiKey = env.TYPESAFE_API_KEY?.trim();
  if (!apiKey) throw new ProviderFailure("typesafe_ai", "auth", "TypeSafe AI runtime secret is not configured.");

  const { questions, promptDigest, contractDigest } = await screeningContract(input.provider);
  const text = input.sourceText.slice(0, 20_000);
  const evidenceComplete = input.provider !== "sec" && input.evidenceComplete && input.sourceText.length <= 20_000;
  const state = {
    subject: {
      kind: input.subject.kind,
      code: input.subject.kind === "issuer" ? input.subject.ticker.value : input.subject.kind === "public_company" ? input.subject.symbol : input.subject.code,
      name: input.subject.name,
    },
    filing: {
      form: input.form,
      primary_description: input.sourceTitle,
      available_at: input.sourceAvailableAt,
      availability_precision: input.sourceAvailablePrecision,
      document_text: text,
      document_complete: evidenceComplete,
      document_scope: input.provider === "sec" ? "Primary SEC filing document only; linked exhibits were not captured." : "Captured source text; completeness is separately declared.",
      document_digest: input.sourceDigest,
    },
    source: {
      provider: input.provider,
      native_id: input.nativeId,
      url: input.sourceUrl,
      observed_at: input.sourceObservedAt,
    },
    research_focus: ["Material operating, financing, governance, legal, and risk developments"],
    thesis_context: "",
    exhibits_not_captured: input.provider === "sec",
  };

  let lastFailure: ProviderFailure | null = null;
  let body: CapturedBody | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      body = await fetchCaptured(
        env,
        input.ownerId,
        "typesafe_ai",
        `${input.provider}:${input.nativeId}:${input.sourceDigest}`,
        SYSTEM_ONE_URL,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ model: MODEL, state, questions }),
        },
        budget,
        [apiKey],
        input.beforeRequest,
      );
      captures.push(body.capture);
      break;
    } catch (error) {
      if (error instanceof CapturedProviderFailure) captures.push(error.capture);
      const failure = error instanceof ProviderFailure ? error : new ProviderFailure("typesafe_ai", "network", "TypeSafe AI screening failed.");
      lastFailure = failure;
      const retryable = failure.provider !== "worker" && failure.stage !== "subrequest_budget" && failure.stage !== "refresh_lock_lost"
        && (failure.status === undefined || failure.status === 429 || failure.status >= 500);
      if (!retryable || attempt === 1) throw failure;
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  if (body === null) throw lastFailure ?? new ProviderFailure("typesafe_ai", "network", "TypeSafe AI screening failed.");

  const parsedBody = TypeSafeResponseSchema.safeParse(parseResponse(body));
  if (!parsedBody.success || Object.keys(parsedBody.data.answers).length === 0) {
    throw new ProviderFailure("typesafe_ai", "validation", "TypeSafe AI returned an empty or malformed typed response.");
  }
  const parsedAnswers = parseAnswers(parsedBody.data.answers, input.provider === "finnhub_news");
  const scoreKeys = ["materiality", "novelty", "market_sensitivity", "thesis_link"] as const;
  const confidence = scoreKeys.reduce((sum, key) => sum + parsedAnswers[key].confidence, 0) / scoreKeys.length;
  const values = Object.fromEntries(scoreKeys.map((key) => [key, Math.round((parsedAnswers[key].score / 4) * 100)]));
  const category = parsedAnswers.category.choice;
  const categoryValue = FilingCategorySchema.parse(category);
  const relevanceAnswer = parsedAnswers.company_relevance;
  const relevance = input.provider === "finnhub_news"
    ? (relevanceAnswer?.type === "noul" && relevanceAnswer.noul >= 0.8)
    : true;
  const sourceReliability = ScoreSchema.parse(input.sourceReliability);
  const complete = evidenceComplete;
  let attentionScore = scoreAttention({
    materiality: ScoreSchema.parse(values.materiality),
    novelty: ScoreSchema.parse(values.novelty),
    marketSensitivity: ScoreSchema.parse(values.market_sensitivity),
    thesisMatch: ScoreSchema.parse(values.thesis_link),
    sourceReliability,
  });
  const decision = decisionFor(attentionScore, confidence, complete);
  const model = parsedBody.data.model ?? MODEL;
  const typedAnswers: Record<string, TypedAnswer> = {
    materiality: parsedAnswers.materiality,
    novelty: parsedAnswers.novelty,
    market_sensitivity: parsedAnswers.market_sensitivity,
    thesis_link: parsedAnswers.thesis_link,
    category: parsedAnswers.category,
    ...(relevanceAnswer === undefined ? {} : { company_relevance: relevanceAnswer }),
  };
  const screenedAt = new Date().toISOString();
  const resultDigest = await digestHex(new TextEncoder().encode(body.text));
  const rationale = [
    `TypeSafe AI placed this record in ${categoryValue.replaceAll("_", " ")}.`,
    `Typed evidence scores: materiality ${values.materiality}, novelty ${values.novelty}, sensitivity ${values.market_sensitivity}, thesis fit ${values.thesis_link}.`,
    `Deterministic attention score ${attentionScore}/100; model confidence ${Math.round(confidence * 100)}%.`,
    ...(!complete ? ["Evidence is incomplete; treat unprovided material as unknown and require human review."] : []),
  ];

  const screening: Screening = {
    engine: "typesafe_ai",
    modelConfidence: ScoreSchema.parse(Math.round(confidence * 100)),
    typedAnswers,
    category: categoryValue,
    evidenceComplete: complete,
    materiality: ScoreSchema.parse(values.materiality),
    novelty: ScoreSchema.parse(values.novelty),
    marketSensitivity: ScoreSchema.parse(values.market_sensitivity),
    thesisMatch: ScoreSchema.parse(values.thesis_link),
    sourceReliability,
    attentionScore,
    decision,
    rationale,
  };

  return {
    model,
    screening,
    relevant: relevance,
    resultDigest,
    promptDigest,
    contractDigest,
    screenedAt,
    capture: body.capture,
  };
}

function questionsForProvider(provider: ScreeningInput["provider"]): Record<string, unknown> {
  if (provider === "finnhub_news") return investorQuestions;
  return Object.fromEntries(Object.entries(investorQuestions).filter(([key]) => key !== "company_relevance"));
}

async function screeningContract(provider: ScreeningInput["provider"]): Promise<{
  questions: Record<string, unknown>;
  promptDigest: string;
  contractDigest: string;
}> {
  const questions = questionsForProvider(provider);
  const promptDigest = await digestHex(new TextEncoder().encode(JSON.stringify(questions)));
  const contractDigest = await digestHex(new TextEncoder().encode(JSON.stringify({
    version: SCREENING_CONTRACT_VERSION,
    requestedModel: MODEL,
    promptDigest,
    answerContract: "investor-typed-answers-v1",
  })));
  return { questions, promptDigest, contractDigest };
}

function parseResponse(body: CapturedBody): unknown {
  try {
    return JSON.parse(body.text) as unknown;
  } catch {
    throw new ProviderFailure("typesafe_ai", "parse", "TypeSafe AI returned malformed JSON.");
  }
}

function parseAnswers(raw: Record<string, unknown>, requiresRelevance: boolean): z.infer<typeof InvestorAnswersSchema> {
  const out: Record<string, TypedAnswer> = {};
  for (const [key, value] of Object.entries(raw)) {
    const parsed = TypedAnswerSchema.safeParse(value);
    if (!parsed.success) throw new ProviderFailure("typesafe_ai", "validation", `TypeSafe AI answer '${key}' did not match its declared typed-answer shape.`);
    if (parsed.data.type === "score") validateScoreAnswer(key, parsed.data);
    if (parsed.data.type === "choice") validateChoiceAnswer(key, parsed.data);
    out[key] = parsed.data;
  }

  const answers = InvestorAnswersSchema.safeParse(out);
  if (!answers.success) {
    throw new ProviderFailure("typesafe_ai", "validation", "TypeSafe AI response is missing one or more required typed judgments.");
  }
  if (!["operations", "capital_allocation", "governance_legal", "risk_disclosure", "routine_disclosure"].includes(answers.data.category.choice)) {
    throw new ProviderFailure("typesafe_ai", "validation", "TypeSafe AI response is missing a valid filing category.");
  }
  if (requiresRelevance && answers.data.company_relevance?.type !== "noul") {
    throw new ProviderFailure("typesafe_ai", "validation", "TypeSafe AI response is missing a company-attribution probability.");
  }
  return answers.data;
}

function validateScoreAnswer(key: string, answer: Extract<TypedAnswer, { type: "score" }>): void {
  const expected = ["0", "1", "2", "3", "4"];
  const probabilities = ProbabilityRecordSchema.safeParse(answer.probabilities);
  if (!probabilities.success || expected.some((level) => !(level in probabilities.data)) || Object.keys(probabilities.data).length !== 5) {
    throw new ProviderFailure("typesafe_ai", "validation", `TypeSafe AI ${key} probabilities must contain exactly five score levels.`);
  }
  const total = Object.values(probabilities.data).reduce((sum, value) => sum + value, 0);
  if (Math.abs(total - 1) > 0.02 || answer.confidence < 0 || answer.confidence > 1) {
    throw new ProviderFailure("typesafe_ai", "validation", `TypeSafe AI ${key} probabilities or confidence failed validation.`);
  }
}

function validateChoiceAnswer(key: string, answer: Extract<TypedAnswer, { type: "choice" }>): void {
  if (key !== "category") return;
  const expected = ["operations", "capital_allocation", "governance_legal", "risk_disclosure", "routine_disclosure"];
  const probabilities = ProbabilityRecordSchema.safeParse(answer.probabilities);
  if (!probabilities.success || expected.some((choice) => !(choice in probabilities.data)) || Object.keys(probabilities.data).length !== expected.length) {
    throw new ProviderFailure("typesafe_ai", "validation", "TypeSafe AI category probabilities must contain the five supported categories.");
  }
  const total = Object.values(probabilities.data).reduce((sum, value) => sum + value, 0);
  if (Math.abs(total - 1) > 0.02 || answer.confidence < 0 || answer.confidence > 1) {
    throw new ProviderFailure("typesafe_ai", "validation", "TypeSafe AI category probabilities or confidence failed validation.");
  }
}

function decisionFor(score: number, confidence: number, complete: boolean): Decision {
  if (!complete || confidence < 0.5) return DecisionSchema.parse("review");
  return decisionForScore(ScoreSchema.parse(score));
}
