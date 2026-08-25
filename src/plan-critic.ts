import { callLLM } from "./llm";
import { parseVerdict, type CriticVerdict } from "./critic";
import type { Card } from "./board";

export interface PlanCriticResult {
  verdict: CriticVerdict;
  tokensUsed: number;
}

export function buildPlanCritiquePrompt(card: Card, plan: string): string {
  return `You are a plan critic. Your job is to decide whether the proposed plan is good enough to execute.

A plan must satisfy ALL of these to pass:
1. It addresses every acceptance criterion with a concrete step.
2. It names the files that will be created or modified.
3. It includes a verification step (test, build, lint, typecheck).
4. It identifies risky or uncertain steps.
5. It is feasible for a single coding agent to execute.

Be adversarial. A vague plan is a failing plan.

TASK:
${card.task}

GOAL:
${card.goal}

LEVER:
${card.lever}

ACCEPTANCE CRITERIA:
${card.acceptance.map((a, i) => `${i + 1}. ${a}`).join("\n")}

PLAN TO EVALUATE:
${plan.slice(0, 3000)}

Respond with EXACTLY this format:

VERDICT: pass | fail | uncertain
CONFIDENCE: 0.0 to 1.0
CURIOSITY: [areas of uncertainty]
REASONING: [specific problems or confirmation]
`;
}

export async function critiquePlan(card: Card, plan: string): Promise<PlanCriticResult> {
  const prompt = buildPlanCritiquePrompt(card, plan);
  const result = await callLLM(prompt, { maxTokens: 512, useCriticModel: true });
  const verdict = parseVerdict(result.text);
  return { verdict, tokensUsed: result.tokensUsed };
}
