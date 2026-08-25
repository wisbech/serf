import type { Card } from "./board";
import type { CriticVerdict, MultiPassVerdict } from "./critic";
import { classifyMultipass } from "./critic_multipass";

export type ArbiterDecision = "pass" | "retry" | "deliberate" | "escalate" | "decompose";

export interface ArbiterResult {
  decision: ArbiterDecision;
  reason: string;
  quality?: number;
}

const AGREEMENT_THRESHOLD = 0.7;

export function arbitrate(
  card: Card,
  verdict: MultiPassVerdict | CriticVerdict,
  attempt: number,
  maxRetries: number,
): ArbiterResult {
  // Normalize to a common shape
  let finalVerdict: "pass" | "fail" | "uncertain";
  let confidence = 0;
  let quality = 0;
  let reasoning = "";

  if ("finalVerdict" in verdict) {
    finalVerdict = verdict.finalVerdict;
    confidence = verdict.agreementRate;
    quality = verdict.agreementRate;
    reasoning = verdict.reasoning;
  } else {
    finalVerdict = verdict.verdict;
    confidence = verdict.confidence;
    quality = verdict.confidence;
    reasoning = verdict.reasoning;
  }

  // High-confidence pass
  if (finalVerdict === "pass" && confidence >= AGREEMENT_THRESHOLD) {
    return { decision: "pass", reason: reasoning, quality };
  }

  // Uncertain or low-confidence results go to deliberation
  if (finalVerdict === "uncertain" || confidence < AGREEMENT_THRESHOLD) {
    return { decision: "deliberate", reason: reasoning };
  }

  // Confident fail
  if (attempt < maxRetries) {
    return { decision: "retry", reason: reasoning };
  }

  // Too large tasks should be decomposed
  if (card.acceptance.length > 5 || reasoning.toLowerCase().includes("too large")) {
    return { decision: "decompose", reason: reasoning };
  }

  return { decision: "escalate", reason: reasoning };
}
