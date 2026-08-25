import type { AutoimproveContext, AutoimproveAttempt, AutoimproveStrategy } from "./types";

export const retryWithFeedbackStrategy: AutoimproveStrategy = {
  name: "retry-with-feedback",
  async nextAttempt(ctx: AutoimproveContext): Promise<AutoimproveAttempt> {
    const lastVerdict = ctx.previousVerdicts[ctx.previousVerdicts.length - 1];
    const feedback = lastVerdict
      ? `CRITIC FEEDBACK (previous attempt was ${lastVerdict.verdict}):\n${lastVerdict.issues.join("; ")}\n${lastVerdict.reasoning}`
      : "Complete the task.";
    return {
      prompt: feedback,
      strategyName: "retry-with-feedback",
      tokensUsed: Math.ceil(feedback.length / 4),
    };
  },
};
