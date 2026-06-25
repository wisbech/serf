import { test, expect, describe } from "bun:test";
import { buildCritiquePrompt, buildPlanCritiquePrompt, parseVerdict, isPass, isHighConfidenceFail, classifyVerdict } from "../src/v2/critic";

describe("Critic", () => {
  test("buildCritiquePrompt includes task and output", () => {
    const prompt = buildCritiquePrompt("Explain HTTP", "HTTP is a protocol");
    expect(prompt).toContain("Explain HTTP");
    expect(prompt).toContain("HTTP is a protocol");
    expect(prompt).toContain("VERDICT: pass | fail");
  });

  test("buildCritiquePrompt includes acceptance criteria as CRITERION blocks", () => {
    const prompt = buildCritiquePrompt("Task", "Output", ["must cite sources", "must be accurate"]);
    expect(prompt).toContain("CRITERION 1: must cite sources");
    expect(prompt).toContain("CRITERION 2: must be accurate");
    expect(prompt).toContain("ANSWER: YES | NO | CANNOT_EVALUATE");
  });

  test("buildCritiquePrompt defaults to single criterion when no acceptance given", () => {
    const prompt = buildCritiquePrompt("Task", "Output");
    expect(prompt).toContain("CRITERION 1:");
  });

  test("parseVerdict extracts per-criterion pass", () => {
    const raw = `CRITERION 1: must cite sources
ANSWER: YES
EVIDENCE: "according to RFC 7230"

CRITERION 2: must be accurate
ANSWER: YES
EVIDENCE: facts check out

VERDICT: pass
REASONING: All criteria satisfied.`;
    const v = parseVerdict(raw);
    expect(v.verdict).toBe("pass");
    expect(v.confidence).toBe(1.0);
    expect(v.issues).toEqual([]);
    expect(v.reasoning).toBe("All criteria satisfied.");
    expect(v.criterionAnswers?.length).toBe(2);
    expect(v.criterionAnswers?.[0].answer).toBe("YES");
  });

  test("parseVerdict extracts per-criterion fail", () => {
    const raw = `CRITERION 1: must cite sources
ANSWER: NO
EVIDENCE: no citations present

CRITERION 2: must be accurate
ANSWER: YES
EVIDENCE: facts correct

VERDICT: fail
REASONING: Failed 1 of 2 criteria: must cite sources`;
    const v = parseVerdict(raw);
    expect(v.verdict).toBe("fail");
    expect(v.confidence).toBeGreaterThanOrEqual(0.7);
    expect(v.issues.length).toBe(1);
    expect(v.issues[0]).toContain("must cite sources");
    expect(v.evidence?.length).toBe(1);
    expect(v.evidence?.[0]).toContain("no citations");
  });

  test("parseVerdict handles CANNOT_EVALUATE without counting as fail", () => {
    const raw = `CRITERION 1: must be formatted in markdown
ANSWER: CANNOT_EVALUATE
EVIDENCE: cannot assess formatting

CRITERION 2: must mention HTTP
ANSWER: YES
EVIDENCE: "HTTP is a protocol"

VERDICT: pass
REASONING: All evaluable criteria satisfied.`;
    const v = parseVerdict(raw);
    expect(v.verdict).toBe("pass");
    expect(v.confidence).toBe(1.0);
    expect(v.issues.some(i => i.includes("CANNOT_EVALUATE"))).toBe(true);
  });

  test("parseVerdict all CANNOT_EVALUATE yields low-confidence fail", () => {
    const raw = `CRITERION 1: must be correct
ANSWER: CANNOT_EVALUATE
EVIDENCE: cannot assess

VERDICT: fail
REASONING: Cannot evaluate.`;
    const v = parseVerdict(raw);
    expect(v.verdict).toBe("fail");
    expect(v.confidence).toBe(0.3);
  });

  test("parseVerdict fallback to legacy format", () => {
    const v = parseVerdict("VERDICT: pass\nCONFIDENCE: 0.9\nISSUES: none\nREASONING: accurate");
    expect(v.verdict).toBe("pass");
    expect(v.confidence).toBe(0.9);
    expect(v.issues).toEqual([]);
    expect(v.reasoning).toBe("accurate");
    expect(v.criterionAnswers).toBeUndefined();
  });

  test("parseVerdict handles missing fields", () => {
    const v = parseVerdict("some random text without verdict");
    expect(v.verdict).toBe("fail");
    expect(v.confidence).toBe(0);
  });

  test("parseVerdict fail confidence floored at 0.7", () => {
    const raw = `CRITERION 1: must be concise
ANSWER: NO
EVIDENCE: too verbose

CRITERION 2: must be accurate
ANSWER: YES
EVIDENCE: correct

CRITERION 3: must cite sources
ANSWER: YES
EVIDENCE: cited

VERDICT: fail
REASONING: Failed 1 of 3.`;
    const v = parseVerdict(raw);
    expect(v.verdict).toBe("fail");
    expect(v.confidence).toBeGreaterThanOrEqual(0.7);
  });

  test("isPass returns true only for high-confidence pass", () => {
    expect(isPass({ verdict: "pass", confidence: 0.9, issues: [], reasoning: "" })).toBe(true);
    expect(isPass({ verdict: "pass", confidence: 0.5, issues: [], reasoning: "" })).toBe(false);
    expect(isPass({ verdict: "fail", confidence: 0.3, issues: ["vague"], reasoning: "" })).toBe(false);
  });

  test("isHighConfidenceFail detects confident rejections", () => {
    expect(isHighConfidenceFail({ verdict: "fail", confidence: 0.8, issues: [], reasoning: "" })).toBe(true);
    expect(isHighConfidenceFail({ verdict: "fail", confidence: 0.5, issues: [], reasoning: "" })).toBe(false);
    expect(isHighConfidenceFail({ verdict: "pass", confidence: 0.9, issues: [], reasoning: "" })).toBe(false);
  });

  test("classifyVerdict: pass when pass + high confidence", () => {
    expect(classifyVerdict({ verdict: "pass", confidence: 0.9, issues: [], reasoning: "" })).toBe("pass");
  });

  test("classifyVerdict: retry when fail + high confidence", () => {
    expect(classifyVerdict({ verdict: "fail", confidence: 0.9, issues: ["wrong"], reasoning: "" })).toBe("retry");
  });

  test("classifyVerdict: review when low confidence", () => {
    expect(classifyVerdict({ verdict: "fail", confidence: 0.3, issues: ["vague"], reasoning: "" })).toBe("review");
    expect(classifyVerdict({ verdict: "pass", confidence: 0.5, issues: [], reasoning: "" })).toBe("review");
    expect(classifyVerdict({ verdict: "fail", confidence: 0.0, issues: [], reasoning: "" })).toBe("review");
  });

  test("buildPlanCritiquePrompt includes task and plan", () => {
    const prompt = buildPlanCritiquePrompt("Build a landing page", "Step 1: Research. Step 2: Write.");
    expect(prompt).toContain("Build a landing page");
    expect(prompt).toContain("Step 1: Research");
  });
});