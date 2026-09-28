import { z } from "zod";
import {
  EventSchema,
  TypedScoreAnswerSchema,
  type Event,
  type Instant,
  type SourceHealth,
  nowIso,
} from "../src/domain";
import {
  JEV_MODEL,
  JEV_QUESTIONS,
  screeningFromJev,
  type JevQuestionKey,
} from "./screening";
import type { SecCandidate } from "./sources/sec";

const JevAnswerSchema = z.object({
  type: z.literal("score"),
  score: z.number().finite(),
  legend: z.record(z.string(), z.string()),
  probabilities: z.record(z.string(), z.number().finite().min(0).max(1)),
  confidence: z.number().finite().min(0).max(1),
}).passthrough();

const JevResponseSchema = z.object({
  model: z.string().min(1),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  }).passthrough(),
  answers: z.record(z.string(), JevAnswerSchema),
}).passthrough();

type JevAnswer = z.infer<typeof JevAnswerSchema>;
const MAX_CONCURRENCY = 4;

type JevConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
};

export type JevScreenResult = {
  events: Event[];
  health: SourceHealth;
  failures: string[];
};

function configFromEnvironment(): JevConfig | null {
  const apiKey = [process.env.TYPESAFE_API_KEY, process.env.JEV_API_KEY]
    .map((value) => value?.trim() ?? "")
    .find((value) => value.length > 0) ?? "";
  if (apiKey.length === 0) return null;
  return {
    apiKey,
    baseUrl: (process.env.TYPESAFE_BASE_URL ?? process.env.NEWSJACK_TYPESAFE_BASE_URL ?? process.env.JEV_BASE_URL ?? "https://api.typesafe.ai").replace(/\/$/, ""),
    model: process.env.JEV_MODEL ?? JEV_MODEL,
    timeoutMs: 30_000,
  };
}

export function jevHealthWithoutKey(): SourceHealth {
  return {
    provider: "jev",
    status: "offline",
    message: "JEv is not configured. Set TYPESAFE_API_KEY or JEV_API_KEY before refreshing SEC.",
    checkedAt: nowIso(),
  };
}

function stateFor(candidate: SecCandidate): Record<string, unknown> {
  return {
    issuer: candidate.issuer,
    filing: {
      form: candidate.form,
      title: candidate.title,
      summary: candidate.summary,
      filed_at: candidate.publishedAt,
      available_at: candidate.availableAt,
      document_text: candidate.document.text,
      document_complete: candidate.document.complete,
      document_digest: candidate.document.digest,
      document_parse_version: candidate.document.parseVersion,
    },
    source: {
      provider: candidate.source.provider,
      native_id: candidate.source.nativeId,
      url: candidate.source.url,
    },
  };
}

function requiredAnswer(answers: Record<string, JevAnswer>, key: JevQuestionKey): JevAnswer {
  const answer = answers[key];
  if (answer === undefined) throw new Error(`JEv returned a missing answer for ${key}.`);
  return answer;
}

function scoreAnswer(answer: JevAnswer, key: JevQuestionKey): z.infer<typeof TypedScoreAnswerSchema> {
  const expectedLevels = JEV_QUESTIONS[key].criteria.map((_criterion, index) => String(index));
  const probabilityTotal = expectedLevels.reduce((sum, level) => sum + (answer.probabilities[level] ?? 0), 0);
  if (answer.score < 0 || answer.score > expectedLevels.length - 1) {
    throw new Error(`JEv returned an invalid score for ${key}.`);
  }
  if (expectedLevels.some((level) => answer.probabilities[level] === undefined || answer.legend[level] === undefined) || Math.abs(probabilityTotal - 1) > 0.01) {
    throw new Error(`JEv returned an invalid probability distribution for ${key}.`);
  }
  return TypedScoreAnswerSchema.parse(answer);
}

function retryAfterMs(value: string | null): number | null {
  if (value === null) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(30_000, Math.ceil(seconds * 1000));
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return null;
  return Math.min(30_000, Math.max(0, timestamp - Date.now()));
}

async function callJev(candidate: SecCandidate, config: JevConfig): Promise<Event> {
  const requestBody = {
    model: config.model,
    state: stateFor(candidate),
    questions: JEV_QUESTIONS,
  };
  let lastError: unknown;
  let nextDelayMs = 0;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (attempt > 0) await new Promise<void>((resolve) => setTimeout(resolve, nextDelayMs || 500 * (2 ** (attempt - 1))));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const response = await fetch(`${config.baseUrl}/v1/systemone`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
      const rawBody = await response.text();
      if (!response.ok) {
        lastError = new Error(`JEv returned HTTP ${response.status}: ${rawBody.slice(0, 240)}`);
        if (response.status !== 429 && response.status < 500) throw lastError;
        nextDelayMs = retryAfterMs(response.headers.get("retry-after")) ?? 0;
        continue;
      }
      const payload = JevResponseSchema.parse(JSON.parse(rawBody));
      const answers = payload.answers;
      const screening = screeningFromJev({
        model: payload.model,
        answers: {
          materiality: scoreAnswer(requiredAnswer(answers, "materiality"), "materiality"),
          novelty: scoreAnswer(requiredAnswer(answers, "novelty"), "novelty"),
          marketSensitivity: scoreAnswer(requiredAnswer(answers, "marketSensitivity"), "marketSensitivity"),
          thesisMatch: scoreAnswer(requiredAnswer(answers, "thesisMatch"), "thesisMatch"),
        },
        evidenceComplete: candidate.document.complete,
        sourceReliability: candidate.document.complete ? 100 : 70,
      });
      const { form: _form, document: _document, ...candidateEvent } = candidate;
      return EventSchema.parse({
        ...candidateEvent,
        screening,
        review: { status: "unreviewed", note: "", updatedAt: null },
      });
    } catch (error) {
      lastError = error;
      const malformedResponse = error instanceof SyntaxError
        || error instanceof z.ZodError
        || (error instanceof Error && (error.message.startsWith("JEv returned an invalid") || error.message.startsWith("JEv returned a missing")));
      if (malformedResponse && attempt === 3) throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("JEv request failed.");
}

export async function screenSecCandidates(candidates: readonly SecCandidate[]): Promise<JevScreenResult> {
  const config = configFromEnvironment();
  if (config === null) {
    const health = jevHealthWithoutKey();
    return { events: [], health, failures: [health.message] };
  }
  const readyConfig = config;
  const events: Event[] = [];
  const failures: string[] = [];
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      const candidate = candidates[index];
      if (candidate === undefined) return;
      try {
        events[index] = await callJev(candidate, readyConfig);
      } catch (error) {
        failures.push(`${candidate.issuer.ticker.value} ${candidate.source.nativeId}: ${error instanceof Error ? error.message : "JEv screening failed."}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENCY, Math.max(1, candidates.length)) }, () => worker()));
  const compactEvents = events.filter((event): event is Event => event !== undefined);
  const checkedAt: Instant = nowIso();
  const health: SourceHealth = {
    provider: "jev",
    status: failures.length === 0 ? "healthy" : compactEvents.length > 0 ? "degraded" : "offline",
    message: failures.length === 0 ? `JEv screened ${compactEvents.length} SEC records with ${readyConfig.model}.` : `JEv screened ${compactEvents.length} records. ${failures.length} calls failed.`,
    checkedAt,
  };
  return { events: compactEvents, health, failures };
}
