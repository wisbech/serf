import { test, expect, describe } from "bun:test";
import { triageCard, buildTriagePrompt, parseTriageLLMOutput } from "../src/triage";
import type { Card } from "../src/board";

function makeCard(partial: Partial<Card>): Card {
  return {
    id: "test-card",
    title: partial.title ?? "Test",
    column: "backlog",
    task: partial.task ?? partial.title ?? "Test",
    goal: partial.goal ?? "Achieve test",
    lever: partial.lever ?? "Implement and verify",
    acceptance: partial.acceptance ?? ["Source files were edited", "Tests pass"],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe("Triage", () => {
  test("passes a well-formed card", async () => {
    const card = makeCard({
      title: "Add triage module",
      task: "Create src/triage.ts with classification logic",
      goal: "Filter bad tasks before expensive work",
      lever: "Write rule-based classifier",
      acceptance: ["src/triage.ts exists", "Tests pass", "README updated"],
    });
    const result = await triageCard(card);
    expect(result.action).toBe("ready");
    expect(result.tokensUsed).toBe(0);
  });

  test("rejects vague tasks", async () => {
    const card = makeCard({
      title: "Improve the system",
      task: "Make things better",
      acceptance: ["Looks good"],
    });
    const result = await triageCard(card);
    expect(result.action).toBe("needs-clarification");
  });

  test("rejects out-of-scope tasks", async () => {
    const card = makeCard({
      title: "Buy a server",
      task: "Purchase hardware for deployment",
      acceptance: ["Invoice received"],
    });
    const result = await triageCard(card);
    expect(result.action).toBe("out-of-scope");
  });

  test("decomposes large tasks", async () => {
    const card = makeCard({
      title: "Rebuild everything",
      task: "Add feature, fix bug, rewrite docs, migrate database, redesign UI",
      acceptance: ["a", "b", "c", "d", "e", "f"],
    });
    const result = await triageCard(card);
    expect(result.action).toBe("decompose");
  });

  test("rejects cards with too few acceptance criteria", async () => {
    const card = makeCard({ acceptance: ["one criterion"] });
    const result = await triageCard(card);
    expect(result.action).toBe("needs-clarification");
  });

  test("buildTriagePrompt includes card fields", () => {
    const card = makeCard({ title: "T", task: "T", goal: "G", lever: "L", acceptance: ["A", "B"] });
    const prompt = buildTriagePrompt(card, { mission: "Test mission" });
    expect(prompt).toContain("Test mission");
    expect(prompt).toContain("ACTION: ready");
    expect(prompt).toContain("A");
  });

  test("parseTriageLLMOutput extracts action and subtasks", () => {
    const text = `ACTION: decompose\nREASON: too large\nSUBTASKS: Fix A | Fix B | Fix C`;
    const parsed = parseTriageLLMOutput(text);
    expect(parsed.action).toBe("decompose");
    expect(parsed.subtasks).toEqual(["Fix A", "Fix B", "Fix C"]);
  });
});
