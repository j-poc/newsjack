import { describe, expect, it } from "vitest";
import { decisionForScore, scoreAttention } from "./domain";

describe("signal screening domain", () => {
  it("calculates a reproducible integer attention score", () => {
    expect(scoreAttention({ materiality: 80, novelty: 90, marketSensitivity: 70, thesisMatch: 60, sourceReliability: 100 })).toBe(78);
    expect(decisionForScore(77)).toBe("review");
    expect(decisionForScore(52)).toBe("watch");
    expect(decisionForScore(20)).toBe("ignore");
  });
});
