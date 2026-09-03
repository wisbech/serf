import { test, expect, describe } from "bun:test";
import { parseVerification, isVerificationGreen, formatVerificationFeedback } from "../src/verification";

describe("Verification", () => {
  test("parses a green verification block", () => {
    const output = `VERIFICATION_COMMAND: bun test
VERIFICATION_EXIT_CODE: 0
VERIFICATION_OUTPUT: 90 pass, 0 fail
FILES_CHANGED:
- src/foo.ts
- tests/foo.test.ts
SERF_TASK_DONE`;
    const v = parseVerification(output);
    expect(v.present).toBe(true);
    expect(v.command).toBe("bun test");
    expect(v.exitCode).toBe(0);
    expect(v.output).toContain("90 pass");
    expect(v.filesChanged).toEqual(["src/foo.ts", "tests/foo.test.ts"]);
    expect(isVerificationGreen(v)).toBe(true);
  });

  test("parses a red verification block", () => {
    const output = `VERIFICATION_COMMAND: bun test
VERIFICATION_EXIT_CODE: 1
VERIFICATION_OUTPUT: 2 fail`;
    const v = parseVerification(output);
    expect(v.present).toBe(true);
    expect(v.exitCode).toBe(1);
    expect(isVerificationGreen(v)).toBe(false);
  });

  test("detects missing verification", () => {
    const v = parseVerification("I did the work but didn't run tests.");
    expect(v.present).toBe(false);
    expect(isVerificationGreen(v)).toBe(false);
  });

  test("formatVerificationFeedback reports missing verification", () => {
    const v = parseVerification("no verification here");
    expect(formatVerificationFeedback(v)).toContain("No verification was reported");
  });
});
