import { test, expect, describe } from "bun:test";
import { buildCritiquePrompt, buildPlanCritiquePrompt, parseVerdict, isPass, isHighConfidenceFail } from "../src/v2/critic";

describe("Critic", () => {
  test("buildCritiquePrompt includes task and output", () => {
    const prompt = buildCritiquePrompt("Explain HTTP", "HTTP is a protocol");
    expect(prompt).toContain("Explain HTTP");
    expect(prompt).toContain("HTTP is a protocol");
    expect(prompt).toContain("VERDICT: pass | fail");
  });

  test("buildCritiquePrompt includes acceptance criteria", () => {
    const prompt = buildCritiquePrompt("Task", "Output", ["must cite sources", "must be accurate"]);
    expect(prompt).toContain("must cite sources");
    expect(prompt).toContain("must be accurate");
  });

  test("parseVerdict extracts pass", () => {
    const v = parseVerdict("VERDICT: pass\nCONFIDENCE: 0.9\nISSUES: none\nREASONING: accurate");
    expect(v.verdict).toBe("pass");
    expect(v.confidence).toBe(0.9);
    expect(v.issues).toEqual([]);
    expect(v.reasoning).toBe("accurate");
  });

  test("parseVerdict extracts fail with issues", () => {
    const v = parseVerdict("VERDICT: fail\nCONFIDENCE: 0.95\nISSUES: wrong, incomplete\nREASONING: factually incorrect");
    expect(v.verdict).toBe("fail");
    expect(v.confidence).toBe(0.95);
    expect(v.issues).toEqual(["wrong", "incomplete"]);
  });

  test("parseVerdict handles missing fields", () => {
    const v = parseVerdict("some random text without verdict");
    expect(v.verdict).toBe("fail");
    expect(v.confidence).toBe(0);
  });

  test("isPass returns true for pass verdict", () => {
    expect(isPass({ verdict: "pass", confidence: 0.9, issues: [], reasoning: "" })).toBe(true);
  });

  test("isPass returns true for low-confidence fail", () => {
    expect(isPass({ verdict: "fail", confidence: 0.3, issues: ["vague"], reasoning: "" })).toBe(true);
  });

  test("isPass returns false for high-confidence fail", () => {
    expect(isPass({ verdict: "fail", confidence: 0.9, issues: ["wrong"], reasoning: "" })).toBe(false);
  });

  test("isHighConfidenceFail detects confident rejections", () => {
    expect(isHighConfidenceFail({ verdict: "fail", confidence: 0.8, issues: [], reasoning: "" })).toBe(true);
    expect(isHighConfidenceFail({ verdict: "fail", confidence: 0.5, issues: [], reasoning: "" })).toBe(false);
    expect(isHighConfidenceFail({ verdict: "pass", confidence: 0.9, issues: [], reasoning: "" })).toBe(false);
  });

  test("buildPlanCritiquePrompt includes task and plan", () => {
    const prompt = buildPlanCritiquePrompt("Build a landing page", "Step 1: Research. Step 2: Write.");
    expect(prompt).toContain("Build a landing page");
    expect(prompt).toContain("Step 1: Research");
  });
});