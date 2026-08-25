import { callLLM } from "./llm";
import type { Card } from "./board";
import type { CriticVerdict } from "./critic";
import type { CardBudget } from "./budget";

export interface DeliberationResult {
  resolved: boolean;
  resolution?: "retry" | "decompose" | "accept-partial" | "escalate";
  reason?: string;
  issueLetter?: string;
  tokensUsed: number;
}

export async function deliberate(
  card: Card,
  verdict: CriticVerdict,
  budget: CardBudget,
): Promise<DeliberationResult> {
  const prompt = buildDeliberationPrompt(card, verdict);
  const result = await callLLM(prompt, { maxTokens: 1024, useCriticModel: true });
  const parsed = parseDeliberationOutput(result.text);

  if (parsed.resolved) {
    return { resolved: true, resolution: parsed.resolution, reason: parsed.reason, tokensUsed: result.tokensUsed };
  }

  const issueLetter = buildIssueLetter(card, verdict, parsed);
  return {
    resolved: false,
    resolution: "escalate",
    reason: parsed.reason,
    issueLetter,
    tokensUsed: result.tokensUsed,
  };
}

export function buildDeliberationPrompt(card: Card, verdict: CriticVerdict): string {
  return `You are the Master in a dark factory. The Work Critic has evaluated a task and returned uncertain or failed. You must now deliberate with the Critic.

Your job is to propose 1-3 concrete resolutions. The Critic will evaluate each. If you can converge on a clear next step, return it. If you cannot, write an issue letter for the user.

TASK:
${card.task}

GOAL:
${card.goal}

LEVER:
${card.lever}

ACCEPTANCE CRITERIA:
${card.acceptance.map((a, i) => `${i + 1}. ${a}`).join("\n")}

CRITIC VERDICT: ${verdict.verdict}
CONFIDENCE: ${verdict.confidence}
ISSUES:
${verdict.issues.map(i => `- ${i}`).join("\n") || "none"}

REASONING:
${verdict.reasoning}

Respond with EXACTLY this format:

RESOLVED: yes | no
RESOLUTION: retry | decompose | accept-partial | escalate
REASON: one sentence explaining the resolution or the gridlock
MASTER_POSITION: what you propose
CRITIC_POSITION: restate the critic's concern in your own words
OPTIONS_FOR_USER: if unresolved, list 2-4 options separated by " | "
RECOMMENDED_OPTION: the option you lean toward
`;
}

interface ParsedDeliberation {
  resolved: boolean;
  resolution?: "retry" | "decompose" | "accept-partial" | "escalate";
  reason: string;
  masterPosition: string;
  criticPosition: string;
  optionsForUser: string[];
  recommendedOption: string;
}

export function parseDeliberationOutput(text: string): ParsedDeliberation {
  const resolvedMatch = text.match(/RESOLVED:\s*(yes|no)/i);
  const resolutionMatch = text.match(/RESOLUTION:\s*(retry|decompose|accept-partial|escalate)/i);
  const reasonMatch = text.match(/REASON:\s*(.+)/i);
  const masterMatch = text.match(/MASTER_POSITION:\s*(.+)/i);
  const criticMatch = text.match(/CRITIC_POSITION:\s*(.+)/i);
  const optionsMatch = text.match(/OPTIONS_FOR_USER:\s*(.+)/i);
  const recommendedMatch = text.match(/RECOMMENDED_OPTION:\s*(.+)/i);

  const resolved = resolvedMatch?.[1]?.toLowerCase() === "yes";
  const resolution = (resolutionMatch?.[1] as ParsedDeliberation["resolution"]) ?? "escalate";
  const reason = reasonMatch?.[1]?.trim() ?? "No reason provided.";
  const masterPosition = masterMatch?.[1]?.trim() ?? "No master position.";
  const criticPosition = criticMatch?.[1]?.trim() ?? "No critic position.";
  const optionsForUser = optionsMatch?.[1]?.split(/\s*\|\s*/).map(s => s.trim()).filter(Boolean) ?? [];
  const recommendedOption = recommendedMatch?.[1]?.trim() ?? optionsForUser[0] ?? "No recommendation.";

  return { resolved, resolution, reason, masterPosition, criticPosition, optionsForUser, recommendedOption };
}

function buildIssueLetter(card: Card, verdict: CriticVerdict, parsed: ParsedDeliberation): string {
  const budgetLines = Object.entries({ triage: 0, plan: 0, execution: 0, critic: 0 })
    .map(([phase]) => `- ${phase}: see card budget section`)
    .join("\n");

  return `# Issue: ${card.title}

## Date
${new Date().toISOString()}

## Task
${card.task}

## Goal
${card.goal}

## Lever
${card.lever}

## Acceptance Criteria
${card.acceptance.map((a, i) => `${i + 1}. ${a}`).join("\n")}

## Critic Position
${parsed.criticPosition}

## Master Position
${parsed.masterPosition}

## Gridlock Reason
${parsed.reason}

## Options for User
${parsed.optionsForUser.map((o, i) => `${i + 1}. ${o}`).join("\n")}

## Recommended Option
${parsed.recommendedOption}

## Budget Impact
${budgetLines}
`;
}
