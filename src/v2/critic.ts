import { callLLM, type CallLLMResult } from "./llm";

export interface CriticVerdict {
  verdict: "pass" | "fail";
  confidence: number;
  issues: string[];
  reasoning: string;
}

export function buildCritiquePrompt(task: string, output: string, acceptance?: string[]): string {
  const acceptanceLine = acceptance && acceptance.length > 0
    ? `\nACCEPTANCE CRITERIA:\n${acceptance.map(a => `- ${a}`).join("\n")}`
    : "";

  return `You are a strict critic evaluating a response to a task.

TASK:
${task}
${acceptanceLine}

RESPONSE TO EVALUATE:
${output.slice(0, 3000)}

Evaluate for:
1. Accuracy: Is it factually correct?
2. Completeness: Does it answer the task and meet acceptance criteria?
3. Coherence: Is it readable and well-structured?

Respond with exactly:
VERDICT: pass | fail
CONFIDENCE: 0.0 to 1.0
ISSUES: comma-separated list (or "none")
REASONING: one sentence`;
}

export function buildPlanCritiquePrompt(task: string, plan: string): string {
  return `You are a strict critic evaluating a task decomposition plan.

ORIGINAL TASK:
${task}

PROPOSED PLAN:
${plan.slice(0, 2000)}

Evaluate for:
1. Completeness: Does the plan cover all parts of the task?
2. Feasibility: Can each step be executed by a single LLM?
3. Order: Are the steps in the right sequence?

Respond with exactly:
VERDICT: pass | fail
CONFIDENCE: 0.0 to 1.0
ISSUES: comma-separated list (or "none")
REASONING: one sentence`;
}

export function parseVerdict(text: string): CriticVerdict {
  const verdictMatch = text.match(/VERDICT:\s*(pass|fail)/i);
  const confidenceMatch = text.match(/CONFIDENCE:\s*([\d.]+)/i);
  const issuesMatch = text.match(/ISSUES:\s*(.+)/i);
  const reasoningMatch = text.match(/REASONING:\s*(.+)/i);

  return {
    verdict: (verdictMatch?.[1]?.toLowerCase() ?? "fail") as "pass" | "fail",
    confidence: confidenceMatch ? parseFloat(confidenceMatch[1]) : 0,
    issues: issuesMatch
      ? issuesMatch[1].split(",").map(s => s.trim()).filter(s => s !== "none" && s.length > 0)
      : [],
    reasoning: reasoningMatch?.[1]?.trim() ?? "",
  };
}

export async function critique(
  task: string,
  output: string,
  acceptance?: string[],
): Promise<{ verdict: CriticVerdict; result: CallLLMResult }> {
  const prompt = buildCritiquePrompt(task, output, acceptance);
  const result = await callLLM(prompt);
  const verdict = parseVerdict(result.text);
  return { verdict, result };
}

export async function critiquePlan(
  task: string,
  plan: string,
): Promise<{ verdict: CriticVerdict; result: CallLLMResult }> {
  const prompt = buildPlanCritiquePrompt(task, plan);
  const result = await callLLM(prompt);
  const verdict = parseVerdict(result.text);
  return { verdict, result };
}

export function isHighConfidenceFail(verdict: CriticVerdict): boolean {
  return verdict.verdict === "fail" && verdict.confidence > 0.7;
}

export function isPass(verdict: CriticVerdict): boolean {
  return verdict.verdict === "pass" || verdict.confidence < 0.7;
}