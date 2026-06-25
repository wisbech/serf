import { critique as defaultCritique, type CriticVerdict, type CriterionAnswer } from "./critic";
import type { CallLLMResult } from "./llm";

export type CritiqueFn = (
  task: string,
  output: string,
  acceptance?: string[],
) => Promise<{ verdict: CriticVerdict; result: CallLLMResult }>;

export type Effort = "quick" | "standard" | "thorough" | "maximum";

export const EFFORT_PASSES: Record<Effort, number> = {
  quick: 1,
  standard: 3,
  thorough: 5,
  maximum: 10,
};

export interface CuriosityPoint {
  criterion: string;
  agreement: number;
  answers: ("YES" | "NO" | "CANNOT_EVALUATE")[];
}

export interface MultiPassVerdict {
  finalVerdict: "pass" | "fail" | "uncertain";
  agreementRate: number;
  curiosity: number;
  passCount: number;
  failCount: number;
  uncertainCount: number;
  totalPasses: number;
  effort: Effort;
  verdicts: CriticVerdict[];
  curiosityPoints: CuriosityPoint[];
  curiosityNotes: string[];
  issues: string[];
  reasoning: string;
  evidence?: string[];
}

export async function critiqueMultipass(
  task: string,
  output: string,
  acceptance: string[],
  effort: Effort = "standard",
  critiqueFn: CritiqueFn = defaultCritique,
): Promise<{ verdict: MultiPassVerdict; results: CallLLMResult[] }> {
  const n = EFFORT_PASSES[effort];
  const verdicts: CriticVerdict[] = [];
  const results: CallLLMResult[] = [];

  for (let i = 0; i < n; i++) {
    const { verdict, result } = await critiqueFn(task, output, acceptance);
    verdicts.push(verdict);
    results.push(result);
  }

  const passCount = verdicts.filter(v => v.verdict === "pass").length;
  const failCount = verdicts.filter(v => v.verdict === "fail").length;
  const uncertainCount = verdicts.filter(v => v.verdict === "uncertain").length;
  const agreementRate = n > 0 ? Math.max(passCount, failCount, uncertainCount) / n : 0;
  const curiosity = 1 - agreementRate;

  const curiosityPoints = computeCuriosityPoints(verdicts);
  const curiosityNotes = [...new Set(verdicts.flatMap(v => v.curiosity ?? []))];

  const allIssues = [...new Set(verdicts.flatMap(v => v.issues))];
  const allEvidence = verdicts.flatMap(v => v.evidence ?? []);
  const reasoning = verdicts.map(v => v.reasoning).filter(Boolean)[0] ?? "";

  let finalVerdict: "pass" | "fail" | "uncertain";
  if (uncertainCount > passCount && uncertainCount > failCount) {
    finalVerdict = "uncertain";
  } else {
    finalVerdict = passCount > failCount ? "pass" : "fail";
  }

  const mpv: MultiPassVerdict = {
    finalVerdict,
    agreementRate,
    curiosity,
    passCount,
    failCount,
    uncertainCount,
    totalPasses: n,
    effort,
    verdicts,
    curiosityPoints,
    curiosityNotes,
    issues: allIssues,
    reasoning,
    evidence: allEvidence.length > 0 ? allEvidence : undefined,
  };

  return { verdict: mpv, results };
}

function computeCuriosityPoints(verdicts: CriticVerdict[]): CuriosityPoint[] {
  const byCriterion = new Map<string, ("YES" | "NO" | "CANNOT_EVALUATE")[]>();

  for (const v of verdicts) {
    if (!v.criterionAnswers) continue;
    for (const ca of v.criterionAnswers) {
      const list = byCriterion.get(ca.criterion) ?? [];
      list.push(ca.answer);
      byCriterion.set(ca.criterion, list);
    }
  }

  const points: CuriosityPoint[] = [];
  for (const [criterion, answers] of byCriterion) {
    const yesCount = answers.filter(a => a === "YES").length;
    const majority = Math.max(yesCount, answers.length - yesCount);
    const agreement = answers.length > 0 ? majority / answers.length : 1;
    points.push({ criterion, agreement, answers });
  }

  return points.sort((a, b) => a.agreement - b.agreement);
}

export function classifyMultipass(
  mv: MultiPassVerdict,
  agreementThreshold = 0.7,
): "pass" | "retry" | "curiosity" {
  if (mv.finalVerdict === "uncertain") return "curiosity";
  if (mv.agreementRate >= agreementThreshold && mv.finalVerdict === "pass") return "pass";
  if (mv.agreementRate >= agreementThreshold && mv.finalVerdict === "fail") return "retry";
  return "curiosity";
}