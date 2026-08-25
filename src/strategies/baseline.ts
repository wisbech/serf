import type { AutoimproveContext, AutoimproveAttempt, AutoimproveStrategy } from "./types";

export const baselineStrategy: AutoimproveStrategy = {
  name: "baseline",
  async nextAttempt(ctx: AutoimproveContext): Promise<AutoimproveAttempt> {
    return {
      prompt: ctx.previousOutputs[ctx.previousOutputs.length - 1] ?? "",
      strategyName: "baseline",
      tokensUsed: 0,
    };
  },
};
