import { critiqueMultipass, type MultiPassVerdict, type Effort } from "./critic_multipass";
import { critique, type CriticVerdict } from "./critic";
import type { Card } from "./board";
import type { TaskResourceSummary } from "./resource-gauge";

export interface WorkCriticOptions {
  effort?: Effort;
  useMultipass?: boolean;
  resourceSummary?: TaskResourceSummary;
}

export async function critiqueWork(
  card: Card,
  output: string,
  options: WorkCriticOptions = {},
): Promise<{ verdict: MultiPassVerdict | CriticVerdict; tokensUsed: number }> {
  if (options.useMultipass ?? true) {
    const { verdict, results } = await critiqueMultipass(
      card.task,
      output,
      card.acceptance,
      options.effort ?? "standard",
      undefined,
      options.resourceSummary,
    );
    const tokensUsed = results.reduce((sum, r) => sum + r.tokensUsed, 0);
    return { verdict, tokensUsed };
  }

  const { verdict, result } = await critique(card.task, output, card.acceptance, undefined, options.resourceSummary);
  return { verdict, tokensUsed: result.tokensUsed };
}
