import { callLLM } from "./llm";
import type { Card } from "./board";

export type TriageAction = "ready" | "needs-clarification" | "out-of-scope" | "decompose";

export interface TriageResult {
  action: TriageAction;
  reason: string;
  subtasks?: string[];
  tokensUsed: number;
}

interface ProjectContext {
  mission?: string;
  recentFailures?: string[];
  existingTaskTitles?: string[];
}

const VAGUE_WORDS = [
  "improve", "enhance", "optimize", "better", "nicer", "cleaner", "refactor",
  "think about", "consider", "explore", "maybe", "possibly", "look into",
  "should", "could", "would be good", "might",
];

const OUT_OF_SCOPE_WORDS = [
  "deploy to mars", "rewrite in rust", "rewrite in go", "rewrite in python",
  "buy", "purchase", "hire", "fire", "legal", "lawsuit", "patent",
];

function isVague(card: Card): boolean {
  const text = `${card.title} ${card.task} ${card.goal}`.toLowerCase();
  return VAGUE_WORDS.some(w => text.includes(w));
}

function isOutOfScope(card: Card): boolean {
  const text = `${card.title} ${card.task}`.toLowerCase();
  return OUT_OF_SCOPE_WORDS.some(w => text.includes(w));
}

function isTooLarge(card: Card): boolean {
  // Heuristic: more than 5 acceptance criteria or task mentions multiple
  // unrelated verbs that imply separate deliverables.
  if (card.acceptance.length > 5) return true;
  const verbs = (card.task.toLowerCase().match(/\b(add|implement|rewrite|create|build|fix|remove|update|migrate|design|test|document)\b/g) ?? []);
  const uniqueVerbs = new Set(verbs);
  return uniqueVerbs.size >= 4;
}

function hasMinimumStructure(card: Card): boolean {
  return Boolean(card.title.trim())
    && Boolean(card.task.trim())
    && Boolean(card.goal.trim())
    && Boolean(card.lever.trim())
    && card.acceptance.length >= 2;
}

/**
 * Cheap rule-based triage. If the rules are borderline, optionally calls the
 * LLM for a second opinion, but only if the card has an explicit triage budget.
 */
export async function triageCard(
  card: Card,
  context: ProjectContext = {},
  useLLM = false,
): Promise<TriageResult> {
  let tokensUsed = 0;

  if (isOutOfScope(card)) {
    return { action: "out-of-scope", reason: "Task mentions an out-of-scope concern (business, legal, rewrite-in-language, etc.)", tokensUsed };
  }

  if (!hasMinimumStructure(card)) {
    return { action: "needs-clarification", reason: "Card is missing title, task, goal, lever, or at least 2 acceptance criteria.", tokensUsed };
  }

  if (isTooLarge(card)) {
    return {
      action: "decompose",
      reason: "Task is too large (>5 acceptance criteria or 4+ distinct verbs). Decompose into smaller cards.",
      tokensUsed,
    };
  }

  if (isVague(card)) {
    return { action: "needs-clarification", reason: "Task contains vague words (improve, explore, maybe, etc.) without measurable criteria.", tokensUsed };
  }

  if (useLLM) {
    const prompt = buildTriagePrompt(card, context);
    const result = await callLLM(prompt, { maxTokens: 256 });
    tokensUsed += result.tokensUsed;
    const parsed = parseTriageLLMOutput(result.text);
    return { ...parsed, tokensUsed };
  }

  return { action: "ready", reason: "Card has goal, lever, measurable acceptance criteria, and no obvious red flags.", tokensUsed };
}

export function buildTriagePrompt(card: Card, context: ProjectContext): string {
  const failures = context.recentFailures?.length
    ? `Recent failures to avoid:\n${context.recentFailures.map(f => `- ${f}`).join("\n")}`
    : "";
  const existing = context.existingTaskTitles?.length
    ? `Existing similar tasks:\n${context.existingTaskTitles.slice(0, 10).map(t => `- ${t}`).join("\n")}`
    : "";

  return `You are a strict project triage assistant. Classify the task into exactly one category.

Rules:
- ready: goal, lever, and acceptance criteria are clear and measurable; the task fits the project mission and is not too large.
- needs-clarification: vague, missing acceptance, unclear scope, or needs user input.
- out-of-scope: not a coding task, business/legal, or unrelated to the project.
- decompose: too large; should be split into 2-4 smaller, independently completable tasks.

Project mission: ${context.mission ?? "Build and maintain the serf coding-agent harness."}
${failures}
${existing}

Task: ${card.title}
Goal: ${card.goal}
Lever: ${card.lever}
Acceptance criteria:
${card.acceptance.map(a => `- ${a}`).join("\n")}

Respond with EXACTLY this format:

ACTION: ready | needs-clarification | out-of-scope | decompose
REASON: one sentence why
SUBTASKS: if decompose, list 2-4 titles separated by " | "
`;
}

export function parseTriageLLMOutput(text: string): Pick<TriageResult, "action" | "reason" | "subtasks"> {
  const actionMatch = text.match(/ACTION:\s*(ready|needs-clarification|out-of-scope|decompose)/i);
  const reasonMatch = text.match(/REASON:\s*(.+)/i);
  const subtasksMatch = text.match(/SUBTASKS:\s*(.+)/i);

  const action: TriageAction = (actionMatch?.[1] as TriageAction) ?? "needs-clarification";
  const reason = reasonMatch?.[1]?.trim() ?? "No reason provided by triage model.";
  const subtasks = subtasksMatch?.[1]
    ?.split(/\s*\|\s*/)
    .map(s => s.trim())
    .filter(Boolean);

  return { action, reason, subtasks };
}
