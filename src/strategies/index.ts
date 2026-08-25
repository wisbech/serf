export * from "./types";
export { baselineStrategy } from "./baseline";
export { retryWithFeedbackStrategy } from "./retry-with-feedback";
export { promptVariationStrategy } from "./prompt-variation";

import { baselineStrategy } from "./baseline";
import { retryWithFeedbackStrategy } from "./retry-with-feedback";
import { promptVariationStrategy } from "./prompt-variation";
import type { AutoimproveStrategy } from "./types";

export const STRATEGIES: Record<string, AutoimproveStrategy> = {
  baseline: baselineStrategy,
  "retry-with-feedback": retryWithFeedbackStrategy,
  "prompt-variation": promptVariationStrategy,
};

export function resolveStrategy(name?: string): AutoimproveStrategy {
  if (name && STRATEGIES[name]) return STRATEGIES[name];
  return baselineStrategy;
}
