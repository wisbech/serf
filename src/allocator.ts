import type { Card } from "./board";
import { loadConfig } from "./state";

export type ModelTier = "small" | "medium" | "large";

export interface TaskEstimate {
  complexity: "trivial" | "simple" | "moderate" | "complex";
  suggestedTier: ModelTier;
  reasoning: string;
}

export function estimateTask(card: Card): TaskEstimate {
  const acceptanceCount = card.acceptance.length;
  const taskLength = card.task.length;
  const hasMultipleFiles = /add.*and.*update|create.*and.*modify|multiple files/i.test(card.task);
  const hasRefactor = /refactor|restructure|migrate|rewrite/i.test(card.task);
  const hasTests = /test|spec|verify/i.test(card.acceptance.join(" "));

  let score = 0;
  if (acceptanceCount <= 2) score += 0;
  else if (acceptanceCount <= 3) score += 1;
  else if (acceptanceCount <= 5) score += 2;
  else score += 3;
  if (taskLength > 200) score += 1;
  if (taskLength > 500) score += 2;
  if (hasMultipleFiles) score += 2;
  if (hasRefactor) score += 2;
  if (hasTests) score += 1;

  if (score <= 1) return { complexity: "trivial", suggestedTier: "small", reasoning: "Few criteria, short task, single-file." };
  if (score <= 3) return { complexity: "simple", suggestedTier: "small", reasoning: "Clear scope, manageable." };
  if (score <= 5) return { complexity: "moderate", suggestedTier: "medium", reasoning: "Multiple criteria or files." };
  return { complexity: "complex", suggestedTier: "large", reasoning: "Complex — many criteria, refactoring, multi-file." };
}

export function allocateModel(card: Card, attempt: number, previousFailureCount: number): string {
  const config = loadConfig();
  const tiers = config?.modelTiers as Record<ModelTier, string> | undefined;

  const small = tiers?.small ?? config?.actorModel ?? config?.model ?? "ollama/ornith:9b";
  const medium = tiers?.medium ?? config?.model ?? "ollama/qwen3:8b";
  const large = tiers?.large ?? config?.masterModel ?? config?.model ?? "ollama/kimi-k2.7-code:cloud";

  if (previousFailureCount >= 2 || attempt >= 3) return large;
  if (previousFailureCount >= 1) return medium;

  const estimate = estimateTask(card);
  if (estimate.suggestedTier === "large") return large;
  if (estimate.suggestedTier === "medium") return medium;
  return small;
}