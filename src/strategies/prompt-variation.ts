import type { AutoimproveContext, AutoimproveAttempt, AutoimproveStrategy } from "./types";

export const promptVariationStrategy: AutoimproveStrategy = {
  name: "prompt-variation",
  async nextAttempt(ctx: AutoimproveContext): Promise<AutoimproveAttempt> {
    const lastVerdict = ctx.previousVerdicts[ctx.previousVerdicts.length - 1];
    const issues = lastVerdict?.issues ?? [];
    const prefix = issues.length
      ? `The critic found these issues. Address each one with concrete evidence and file paths:\n${issues.map((i, n) => `${n + 1}. ${i}`).join("\n")}\n\n`
      : "Re-execute with stricter evidence requirements. ";
    const prompt = `${prefix}You must:\n- Cite every changed file path.\n- Show the exact test or verification command output.\n- End the output file with SERF_TASK_DONE.`;
    return {
      prompt,
      strategyName: "prompt-variation",
      tokensUsed: Math.ceil(prompt.length / 4),
    };
  },
};
