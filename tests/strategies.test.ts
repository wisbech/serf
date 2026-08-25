import { test, expect, describe } from "bun:test";
import { resolveStrategy, STRATEGIES, baselineStrategy, retryWithFeedbackStrategy, promptVariationStrategy } from "../src/strategies";
import type { AutoimproveContext } from "../src/strategies";
import type { Card } from "../src/board";
import { createCardBudget } from "../src/budget";

function makeCtx(partial: Partial<AutoimproveContext> = {}): AutoimproveContext {
  return {
    card: partial.card ?? {
      id: "c1",
      title: "T",
      column: "in-progress",
      task: "T",
      goal: "G",
      lever: "L",
      acceptance: ["A"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    attempt: partial.attempt ?? 1,
    maxAttempts: partial.maxAttempts ?? 3,
    previousOutputs: partial.previousOutputs ?? [],
    previousVerdicts: partial.previousVerdicts ?? [],
    phaseBudget: partial.phaseBudget ?? createCardBudget(10000),
  };
}

describe("Strategies", () => {
  test("resolveStrategy defaults to baseline", () => {
    expect(resolveStrategy().name).toBe("baseline");
    expect(resolveStrategy("unknown").name).toBe("baseline");
    expect(resolveStrategy("retry-with-feedback").name).toBe("retry-with-feedback");
  });

  test("baseline returns empty prompt", async () => {
    const ctx = makeCtx({ previousOutputs: ["output"] });
    const attempt = await baselineStrategy.nextAttempt(ctx);
    expect(attempt.prompt).toBe("output");
    expect(attempt.strategyName).toBe("baseline");
  });

  test("retry-with-feedback includes critic issues", async () => {
    const ctx = makeCtx({
      previousVerdicts: [{
        verdict: "fail",
        confidence: 0.9,
        issues: ["missing tests"],
        reasoning: "No tests found",
      }],
    });
    const attempt = await retryWithFeedbackStrategy.nextAttempt(ctx);
    expect(attempt.prompt).toContain("missing tests");
    expect(attempt.prompt).toContain("No tests found");
  });

  test("prompt-variation lists issues", async () => {
    const ctx = makeCtx({
      previousVerdicts: [{
        verdict: "fail",
        confidence: 0.8,
        issues: ["no file paths", "no test output"],
        reasoning: "Bad",
      }],
    });
    const attempt = await promptVariationStrategy.nextAttempt(ctx);
    expect(attempt.prompt).toContain("no file paths");
    expect(attempt.prompt).toContain("Cite every changed file path");
  });

  test("STRATEGIES contains all strategies", () => {
    expect(Object.keys(STRATEGIES).sort()).toEqual([
      "baseline",
      "prompt-variation",
      "retry-with-feedback",
    ]);
  });
});
