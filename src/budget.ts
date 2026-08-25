export type Phase = "triage" | "plan" | "execution" | "critic";

export interface PhaseBudget {
  phase: Phase;
  limit: number;
  used: number;
}

export interface CardBudget {
  totalLimit: number;
  phases: Record<Phase, PhaseBudget>;
}

const DEFAULT_TOTAL_LIMIT = 12_000;

const DEFAULT_PHASE_SPLIT: Record<Phase, number> = {
  triage: 0.05,
  plan: 0.15,
  execution: 0.60,
  critic: 0.20,
};

export function createCardBudget(totalLimit?: number): CardBudget {
  const limit = totalLimit ?? DEFAULT_TOTAL_LIMIT;
  return {
    totalLimit: limit,
    phases: {
      triage: { phase: "triage", limit: Math.floor(limit * DEFAULT_PHASE_SPLIT.triage), used: 0 },
      plan: { phase: "plan", limit: Math.floor(limit * DEFAULT_PHASE_SPLIT.plan), used: 0 },
      execution: { phase: "execution", limit: Math.floor(limit * DEFAULT_PHASE_SPLIT.execution), used: 0 },
      critic: { phase: "critic", limit: Math.floor(limit * DEFAULT_PHASE_SPLIT.critic), used: 0 },
    },
  };
}

export function trackPhaseUsage(budget: CardBudget, phase: Phase, tokens: number): void {
  budget.phases[phase].used += tokens;
}

export function isPhaseOverBudget(budget: CardBudget, phase: Phase): boolean {
  return budget.phases[phase].used > budget.phases[phase].limit;
}

export function getPhaseRemaining(budget: CardBudget, phase: Phase): number {
  return Math.max(0, budget.phases[phase].limit - budget.phases[phase].used);
}

export function getTotalUsage(budget: CardBudget): number {
  return Object.values(budget.phases).reduce((sum, p) => sum + p.used, 0);
}

export function getTotalRemaining(budget: CardBudget): number {
  return Math.max(0, budget.totalLimit - getTotalUsage(budget));
}

export function formatBudget(budget: CardBudget): string {
  const lines = Object.values(budget.phases).map(
    p => `    ${p.phase.padEnd(10)} ${String(p.used).padStart(6)} / ${String(p.limit).padStart(6)} tokens`,
  );
  lines.push(`    ${"total".padEnd(10)} ${String(getTotalUsage(budget)).padStart(6)} / ${String(budget.totalLimit).padStart(6)} tokens`);
  return lines.join("\n");
}

export function assertPhaseBudget(budget: CardBudget, phase: Phase, tokens: number): { ok: boolean; wouldUse: number } {
  const remaining = getPhaseRemaining(budget, phase);
  if (remaining <= 0) return { ok: false, wouldUse: 0 };
  return { ok: tokens <= remaining, wouldUse: Math.min(tokens, remaining) };
}
