import type { Card } from "../board";
import type { CardBudget } from "../budget";
import type { CriticVerdict } from "../critic";

export interface AutoimproveContext {
  card: Card;
  attempt: number;
  maxAttempts: number;
  previousOutputs: string[];
  previousVerdicts: CriticVerdict[];
  phaseBudget: CardBudget;
}

export interface AutoimproveAttempt {
  prompt: string;
  strategyName: string;
  tokensUsed: number;
}

export interface AutoimproveStrategy {
  name: string;
  nextAttempt(ctx: AutoimproveContext): Promise<AutoimproveAttempt>;
}

export interface StrategyResult {
  strategyName: string;
  attemptNumber: number;
  output: string;
  verdict: CriticVerdict;
  tokensUsed: number;
}
