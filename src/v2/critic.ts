import { callLLM, type CallLLMResult } from "./llm";

export interface CriterionAnswer {
  criterion: string;
  answer: "YES" | "NO" | "CANNOT_EVALUATE";
  evidence: string;
}

export interface CriticVerdict {
  verdict: "pass" | "fail" | "uncertain";
  confidence: number;
  issues: string[];
  reasoning: string;
  evidence?: string[];
  criterionAnswers?: CriterionAnswer[];
  curiosity?: string[];
}

// ── PROMPT ──

export function buildCritiquePrompt(task: string, output: string, acceptance?: string[]): string {
  const criteria = acceptance && acceptance.length > 0
    ? acceptance
    : ["Output meets the task requirement"];

  const criteriaBlock = criteria.map((c, i) => `CRITERION ${i + 1}: ${c}`).join("\n");

  return `You are a hostile adversary. Your job is to FIND REASONS TO FAIL this output. You are not fair. You are not balanced. You are searching for any divergence between what was requested and what was delivered.

You do NOT suggest improvements. You do NOT give partial credit. You ONLY identify failures.

TASK:
${task}

ACCEPTANCE CRITERIA (each must be individually satisfied):
${criteriaBlock}

RESPONSE TO EVALUATE:
${output.slice(0, 3000)}

For EACH acceptance criterion, answer YES (fully satisfied, with evidence) or NO (not satisfied, with evidence). If a criterion cannot be objectively evaluated from the output alone, answer CANNOT_EVALUATE.

Respond with EXACTLY this format — no other text:

CRITERION 1: ${criteria[0]}
ANSWER: YES | NO | CANNOT_EVALUATE
EVIDENCE: [specific quote or reference from the output]

${criteria.length > 1 ? criteria.slice(1).map((c, i) => `CRITERION ${i + 2}: ${c}\nANSWER: YES | NO | CANNOT_EVALUATE\nEVIDENCE: [specific quote or reference from the output]`).join("\n\n") : ""}

VERDICT: pass | fail
REASONING: [one sentence: which criteria failed and why]`;
}

export function buildPlanCritiquePrompt(task: string, plan: string): string {
  return `You are the critic evaluating an actor's plan before execution.

TASK:
${task}

PROPOSED PLAN:
${plan.slice(0, 3000)}

Evaluate the plan:
1. Completeness: Does it cover all parts of the task and every acceptance criterion?
2. Feasibility: Can each step be executed by a single LLM?
3. Order: Are the steps in the right sequence?
4. Risk: Does the plan identify uncertain or risky steps?

Explore the plan curiously. Note where you are uncertain about whether a step will work. If you need the actor to clarify something, say so.

VERDICT: pass | fail | uncertain
CONFIDENCE: 0.0 to 1.0
CURIOSITY: [areas of uncertainty]
REASONING: [your judgment in 1-2 sentences]`;
}

// ── PARSE ──

export function parseVerdict(text: string): CriticVerdict {
  const criterionAnswers = parseCriterionFormat(text);
  if (criterionAnswers.length > 0) {
    return criterionAnswersToVerdict(criterionAnswers, text);
  }
  return parseLegacyFormat(text);
}

function parseCriterionFormat(raw: string): CriterionAnswer[] {
  const answers: CriterionAnswer[] = [];
  const blocks = raw.split(/CRITERION\s+\d+:/i);

  for (const block of blocks.slice(1)) {
    const answerMatch = block.match(/ANSWER:\s*(YES|NO|CANNOT_EVALUATE)/i);
    if (!answerMatch) continue;

    const answer = answerMatch[1].toUpperCase() as "YES" | "NO" | "CANNOT_EVALUATE";
    const criterionText = block.split("\n")[0].trim();

    const evidenceMatch = block.match(/EVIDENCE:\s*(.+?)(?=\n(?:CRITERION|VERDICT)|$)/is);
    const evidence = evidenceMatch ? evidenceMatch[1].trim() : "";

    answers.push({ criterion: criterionText, answer, evidence });
  }

  return answers;
}

function criterionAnswersToVerdict(answers: CriterionAnswer[], raw: string): CriticVerdict {
  const total = answers.length;
  const yesCount = answers.filter(a => a.answer === "YES").length;
  const noCount = answers.filter(a => a.answer === "NO").length;
  const cannotEvalCount = answers.filter(a => a.answer === "CANNOT_EVALUATE").length;
  const evaluable = total - cannotEvalCount;

  const issues: string[] = [];
  const evidenceList: string[] = [];

  for (const a of answers) {
    if (a.answer === "NO") {
      issues.push(`FAILED: ${a.criterion}`);
      if (a.evidence) evidenceList.push(a.evidence);
    } else if (a.answer === "CANNOT_EVALUATE") {
      issues.push(`CANNOT_EVALUATE: ${a.criterion}`);
    }
  }

  let verdict: "pass" | "fail";
  let confidence: number;

  if (evaluable === 0) {
    verdict = "fail";
    confidence = 0.3;
  } else if (noCount === 0) {
    verdict = "pass";
    confidence = Math.round((yesCount / evaluable) * 100) / 100;
  } else {
    verdict = "fail";
    confidence = Math.round((noCount / total) * 100) / 100;
    if (confidence < 0.7) confidence = 0.7;
  }

  const reasoningMatch = raw.match(/VERDICT:\s*(?:pass|fail)\s*\n\s*REASONING:\s*(.+?)(?:\n|$)/is);
  let reasoning = reasoningMatch ? reasoningMatch[1].trim() : "";

  if (!reasoning) {
    if (verdict === "pass") {
      reasoning = `All ${total} criteria satisfied.`;
    } else {
      const failed = answers.filter(a => a.answer === "NO").map(a => a.criterion);
      reasoning = `Failed ${noCount} of ${total} criteria: ${failed.join("; ")}`;
    }
  }

  return {
    verdict,
    confidence,
    issues,
    reasoning,
    evidence: evidenceList.length > 0 ? evidenceList : undefined,
    criterionAnswers: answers,
  };
}

function parseLegacyFormat(raw: string): CriticVerdict {
  const verdictMatch = raw.match(/VERDICT:\s*(pass|fail|uncertain)/i);
  const confidenceMatch = raw.match(/CONFIDENCE:\s*([\d.]+)/i);
  const issuesMatch = raw.match(/ISSUES:\s*(.+)/i);
  const reasoningMatch = raw.match(/REASONING:\s*(.+)/i);
  const curiosityMatch = raw.match(/CURIOSITY:\s*(.+?)(?:\n[A-Z]+:|$)/is);

  let curiosity: string[] | undefined;
  if (curiosityMatch) {
    const curiosityStr = curiosityMatch[1].trim();
    if (curiosityStr.toLowerCase() !== "none" && curiosityStr !== "[]") {
      curiosity = curiosityStr.split(/[;\n]/).map(s => s.replace(/^[-*]\s*/, "").trim()).filter(s => s.length > 0);
      if (curiosity.length === 0) curiosity = undefined;
    }
  }

  return {
    verdict: (verdictMatch?.[1]?.toLowerCase() ?? "fail") as "pass" | "fail" | "uncertain",
    confidence: confidenceMatch ? parseFloat(confidenceMatch[1]) : 0,
    issues: issuesMatch
      ? issuesMatch[1].split(",").map(s => s.trim()).filter(s => s !== "none" && s.length > 0)
      : [],
    reasoning: reasoningMatch?.[1]?.trim() ?? "",
    curiosity,
  };
}

// ── CALL ──

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

// ── CLASSIFY ──

export function isHighConfidenceFail(verdict: CriticVerdict): boolean {
  return verdict.verdict === "fail" && verdict.confidence > 0.7;
}

export function isPass(verdict: CriticVerdict): boolean {
  return verdict.verdict === "pass" && verdict.confidence > 0.7;
}

export function isLowConfidence(verdict: CriticVerdict): boolean {
  return verdict.confidence <= 0.7 || verdict.verdict === "uncertain";
}

export type CriticOutcome = "pass" | "retry" | "review";

export function classifyVerdict(verdict: CriticVerdict): CriticOutcome {
  if (verdict.verdict === "uncertain") return "review";
  if (verdict.verdict === "pass" && verdict.confidence > 0.7) return "pass";
  if (verdict.verdict === "fail" && verdict.confidence > 0.7) return "retry";
  return "review";
}