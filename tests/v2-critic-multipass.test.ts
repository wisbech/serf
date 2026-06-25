import { test, expect, describe } from "bun:test";
import { critiqueMultipass, classifyMultipass, EFFORT_PASSES, type MultiPassVerdict, type CritiqueFn } from "../src/v2/critic_multipass";
import type { CriticVerdict } from "../src/v2/critic";

function makeVerdict(verdict: "pass" | "fail", confidence: number, criterionAnswers?: { criterion: string; answer: "YES" | "NO" | "CANNOT_EVALUATE"; evidence: string }[]): CriticVerdict {
  return {
    verdict,
    confidence,
    issues: verdict === "fail" ? ["FAILED: test criterion"] : [],
    reasoning: verdict === "pass" ? "All pass" : "Failed",
    criterionAnswers,
  };
}

function mockCritique(verdicts: CriticVerdict[]): CritiqueFn {
  let idx = 0;
  return () => Promise.resolve({
    verdict: verdicts[Math.min(idx++, verdicts.length - 1)],
    result: { text: "", tokensUsed: 0, warnings: [], ok: true },
  });
}

describe("critic_multipass", () => {
  test("EFFORT_PASSES maps effort to pass counts", () => {
    expect(EFFORT_PASSES.quick).toBe(1);
    expect(EFFORT_PASSES.standard).toBe(3);
    expect(EFFORT_PASSES.thorough).toBe(5);
    expect(EFFORT_PASSES.maximum).toBe(10);
  });

  test("critiqueMultipass returns unanimous pass", async () => {
    const passVerdict = makeVerdict("pass", 1.0, [
      { criterion: "must be correct", answer: "YES", evidence: "correct" },
    ]);
    const fn = mockCritique([passVerdict]);
    const { verdict: mpv } = await critiqueMultipass("task", "output", ["must be correct"], "quick", fn);
    expect(mpv.finalVerdict).toBe("pass");
    expect(mpv.passCount).toBe(1);
    expect(mpv.failCount).toBe(0);
    expect(mpv.agreementRate).toBe(1.0);
    expect(mpv.curiosity).toBe(0);
  });

  test("critiqueMultipass computes disagreement for mixed verdicts", async () => {
    const answers = [
      makeVerdict("pass", 1.0, [{ criterion: "c1", answer: "YES", evidence: "ok" }]),
      makeVerdict("fail", 0.8, [{ criterion: "c1", answer: "NO", evidence: "bad" }]),
      makeVerdict("pass", 1.0, [{ criterion: "c1", answer: "YES", evidence: "ok" }]),
    ];
    const fn = mockCritique(answers);
    const { verdict: mpv } = await critiqueMultipass("task", "output", ["c1"], "standard", fn);
    expect(mpv.totalPasses).toBe(3);
    expect(mpv.passCount).toBe(2);
    expect(mpv.failCount).toBe(1);
    expect(mpv.agreementRate).toBeCloseTo(2 / 3, 1);
    expect(mpv.curiosity).toBeCloseTo(1 / 3, 1);
    expect(mpv.finalVerdict).toBe("pass");
  });

  test("classifyMultipass: pass on high agreement", () => {
    const mv: MultiPassVerdict = {
      finalVerdict: "pass", agreementRate: 1.0, curiosity: 0,
      passCount: 3, failCount: 0, totalPasses: 3, effort: "standard",
      verdicts: [], curiosityPoints: [], issues: [], reasoning: "",
    };
    expect(classifyMultipass(mv)).toBe("pass");
  });

  test("classifyMultipass: retry on high agreement fail", () => {
    const mv: MultiPassVerdict = {
      finalVerdict: "fail", agreementRate: 1.0, curiosity: 0,
      passCount: 0, failCount: 3, totalPasses: 3, effort: "standard",
      verdicts: [], curiosityPoints: [], issues: ["x"], reasoning: "",
    };
    expect(classifyMultipass(mv)).toBe("retry");
  });

  test("classifyMultipass: curiosity on low agreement", () => {
    const mv: MultiPassVerdict = {
      finalVerdict: "pass", agreementRate: 0.5, curiosity: 0.5,
      passCount: 2, failCount: 2, totalPasses: 4, effort: "standard",
      verdicts: [], curiosityPoints: [], issues: [], reasoning: "",
    };
    expect(classifyMultipass(mv)).toBe("curiosity");
  });

  test("classifyMultipass: curiosity threshold respected", () => {
    const mv: MultiPassVerdict = {
      finalVerdict: "fail", agreementRate: 0.66, curiosity: 0.34,
      passCount: 2, failCount: 3, totalPasses: 5, effort: "standard",
      verdicts: [], curiosityPoints: [], issues: [], reasoning: "",
    };
    expect(classifyMultipass(mv, 0.7)).toBe("curiosity");
    expect(classifyMultipass(mv, 0.5)).toBe("retry");
  });

  test("computeCuriosityPoints finds disagreements across passes", async () => {
    const answers = [
      makeVerdict("pass", 1.0, [
        { criterion: "must be accurate", answer: "YES", evidence: "correct" },
        { criterion: "must be concise", answer: "YES", evidence: "short" },
      ]),
      makeVerdict("fail", 0.8, [
        { criterion: "must be accurate", answer: "NO", evidence: "wrong" },
        { criterion: "must be concise", answer: "YES", evidence: "short" },
      ]),
      makeVerdict("pass", 1.0, [
        { criterion: "must be accurate", answer: "YES", evidence: "correct" },
        { criterion: "must be concise", answer: "YES", evidence: "short" },
      ]),
    ];
    const fn = mockCritique(answers);
    const { verdict: mpv } = await critiqueMultipass("task", "output", ["must be accurate", "must be concise"], "standard", fn);
    expect(mpv.curiosityPoints.length).toBe(2);
    const accuratePoint = mpv.curiosityPoints.find(p => p.criterion === "must be accurate");
    expect(accuratePoint).toBeDefined();
    expect(accuratePoint!.agreement).toBeCloseTo(2 / 3, 1);
    expect(accuratePoint!.answers).toEqual(["YES", "NO", "YES"]);

    const concisePoint = mpv.curiosityPoints.find(p => p.criterion === "must be concise");
    expect(concisePoint).toBeDefined();
    expect(concisePoint!.agreement).toBe(1.0);
  });
});