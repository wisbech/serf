import { test, expect, describe } from "bun:test";
import { arbitrate } from "../src/arbiter";
import type { Card } from "../src/board";

function makeCard(acceptance: string[] = ["A", "B"]): Card {
  return {
    id: "c1",
    title: "T",
    column: "in-progress",
    task: "T",
    goal: "G",
    lever: "L",
    acceptance,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe("Arbiter", () => {
  test("passes high-confidence pass verdict", () => {
    const decision = arbitrate(makeCard(), { verdict: "pass", confidence: 0.95, issues: [], reasoning: "good" }, 1, 3);
    expect(decision.decision).toBe("pass");
  });

  test("deliberates uncertain verdict", () => {
    const decision = arbitrate(makeCard(), { verdict: "uncertain", confidence: 0.5, issues: ["can't tell"], reasoning: "vague" }, 1, 3);
    expect(decision.decision).toBe("deliberate");
  });

  test("retries confident fail when attempts remain", () => {
    const decision = arbitrate(makeCard(), { verdict: "fail", confidence: 0.9, issues: ["missing"], reasoning: "bad" }, 1, 3);
    expect(decision.decision).toBe("retry");
  });

  test("escalates after max retries", () => {
    const decision = arbitrate(makeCard(), { verdict: "fail", confidence: 0.9, issues: ["missing"], reasoning: "bad" }, 3, 3);
    expect(decision.decision).toBe("escalate");
  });

  test("decomposes large cards", () => {
    const card = makeCard(["a", "b", "c", "d", "e", "f"]);
    const decision = arbitrate(card, { verdict: "fail", confidence: 0.9, issues: [], reasoning: "too large" }, 3, 3);
    expect(decision.decision).toBe("decompose");
  });
});
