import {
  DecisionSchema,
  ScreeningSchema,
  ScoreSchema,
  TypedScoreAnswerSchema,
  decisionForScore,
  scoreAttention,
  type Screening,
  type TypedScoreAnswer,
} from "../src/domain";

export const JEV_MODEL = process.env.JEV_MODEL ?? "jev-latest";

export const JEV_QUESTIONS = {
  materiality: {
    type: "score",
    instructions: "How material could this filing be to the issuer's operating, financing, governance, or legal thesis? Use only the filing metadata and summary supplied in STATE. Do not infer undisclosed facts.",
    criteria: [
      "routine disclosure with no apparent thesis consequence",
      "small update that may matter in context",
      "meaningful update to an operating, financing, governance, or legal thread",
      "likely material change that deserves prompt filing review",
      "exceptional event likely to change the thesis or risk assessment",
    ],
  },
  novelty: {
    type: "score",
    instructions: "How new is this source record relative to the issuer's recent filing stream? Use the filing type and date. Do not treat a new observation of an old filing as a new business fact.",
    criteria: [
      "routine or repeated source type",
      "expected periodic disclosure",
      "new filing with limited context",
      "unusual or newly appearing disclosure",
      "clear new development or amendment that changes the evidence set",
    ],
  },
  marketSensitivity: {
    type: "score",
    instructions: "How sensitive could the market's interpretation be to this filing? Judge the possible consequence of the source category, not the direction of a price move.",
    criteria: [
      "unlikely to change an investor's view",
      "useful background for an existing view",
      "could affect a narrow part of the thesis",
      "could affect valuation, risk, or expected operating performance",
      "could change the central thesis or a material risk assessment",
    ],
  },
  thesisMatch: {
    type: "score",
    instructions: "How directly does this filing connect to a public-equity research question for this issuer? Use issuer identity, filing type, and the supplied summary. Do not invent a company-specific thesis.",
    criteria: [
      "no clear research question beyond filing awareness",
      "general issuer monitoring value",
      "relevant to a plausible operating or capital-allocation question",
      "directly relevant to an active issuer research question",
      "directly tests a material thesis or risk question",
    ],
  },
} as const;

export type JevQuestionKey = keyof typeof JEV_QUESTIONS;

export type ScreeningInput = {
  answers: Record<JevQuestionKey, TypedScoreAnswer>;
  model: string;
  evidenceComplete: boolean;
  sourceReliability: number;
};

const LOW_CONFIDENCE_REVIEW_THRESHOLD = 50;

function scoreToPercent(value: number): number {
  return ScoreSchema.parse(Math.min(100, Math.max(0, Math.round((value / 4) * 100))));
}

function formatConfidence(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function screeningFromJev(input: ScreeningInput): Screening {
  const materiality = scoreToPercent(input.answers.materiality.score);
  const novelty = scoreToPercent(input.answers.novelty.score);
  const marketSensitivity = scoreToPercent(input.answers.marketSensitivity.score);
  const thesisMatch = scoreToPercent(input.answers.thesisMatch.score);
  const confidences = Object.values(input.answers).map((answer) => answer.confidence);
  const modelConfidence = ScoreSchema.parse(Math.round((confidences.reduce((sum, value) => sum + value, 0) / confidences.length) * 100));
  const sourceReliability = ScoreSchema.parse(input.sourceReliability);
  const attentionScore = scoreAttention({ materiality, novelty, marketSensitivity, thesisMatch, sourceReliability });
  const decision = modelConfidence < LOW_CONFIDENCE_REVIEW_THRESHOLD || !input.evidenceComplete ? "review" : decisionForScore(attentionScore);
  return ScreeningSchema.parse({
    engine: input.model,
    modelConfidence,
    typedAnswers: Object.fromEntries(Object.entries(input.answers).map(([key, answer]) => [key, TypedScoreAnswerSchema.parse(answer)])),
    evidenceComplete: input.evidenceComplete,
    materiality,
    novelty,
    marketSensitivity,
    thesisMatch,
    sourceReliability,
    attentionScore,
    decision: DecisionSchema.parse(decision),
    rationale: [
      `Jev typed scores: materiality ${input.answers.materiality.score.toFixed(1)}/4 (${formatConfidence(input.answers.materiality.confidence)} confidence), novelty ${input.answers.novelty.score.toFixed(1)}/4, market sensitivity ${input.answers.marketSensitivity.score.toFixed(1)}/4, thesis link ${input.answers.thesisMatch.score.toFixed(1)}/4.`,
      ...(modelConfidence < LOW_CONFIDENCE_REVIEW_THRESHOLD ? [`Low aggregate JEv confidence (${modelConfidence}/100), so this stays in the review lane.`] : []),
      ...(!input.evidenceComplete ? ["The SEC document was truncated during extraction, so this stays in the review lane."] : []),
      "The score is a screening priority. Open the primary SEC filing before interpreting the disclosure.",
    ],
  });
}
