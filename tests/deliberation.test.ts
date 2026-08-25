import { test, expect, describe } from "bun:test";
import { buildDeliberationPrompt, parseDeliberationOutput } from "../src/deliberation";
import type { Card } from "../src/board";

function makeCard(): Card {
  return {
    id: "c1",
    title: "T",
    column: "in-progress",
    task: "T",
    goal: "G",
    lever: "L",
    acceptance: ["A", "B"],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe("Deliberation", () => {
  test("buildDeliberationPrompt includes task and verdict", () => {
    const prompt = buildDeliberationPrompt(makeCard(), { verdict: "uncertain", confidence: 0.5, issues: ["x"], reasoning: "y" });
    expect(prompt).toContain("RESOLVED: yes | no");
    expect(prompt).toContain("x");
  });

  test("parseDeliberationOutput extracts gridlock", () => {
    const text = `RESOLVED: no
RESOLUTION: escalate
REASON: cannot agree on scope
MASTER_POSITION: split the task
CRITIC_POSITION: task is atomic
OPTIONS_FOR_USER: option A | option B
RECOMMENDED_OPTION: option A`;
    const parsed = parseDeliberationOutput(text);
    expect(parsed.resolved).toBe(false);
    expect(parsed.resolution).toBe("escalate");
    expect(parsed.optionsForUser).toEqual(["option A", "option B"]);
    expect(parsed.recommendedOption).toBe("option A");
  });
});
