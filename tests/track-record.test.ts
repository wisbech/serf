import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { recordOutcome, readTrackRecords, modelPassRate, bestModelForTask, commonFailureCriteria } from "../src/track-record";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "serf-track-"));
  process.env.SERF_HOME = join(dir, ".serf");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.SERF_HOME;
});

describe("Track Record", () => {
  test("records and reads outcomes", () => {
    recordOutcome({ cardId: "c1", title: "Fix auth bug", model: "qwen3", agent: "opencode", outcome: "pass", attempts: 1, failedCriteria: [], ts: "2026-01-01" });
    recordOutcome({ cardId: "c2", title: "Fix auth bug", model: "qwen3", agent: "opencode", outcome: "fail", attempts: 3, failedCriteria: ["tests pass"], ts: "2026-01-02" });
    const records = readTrackRecords();
    expect(records.length).toBe(2);
  });

  test("modelPassRate computes rate", () => {
    recordOutcome({ cardId: "c1", title: "t", model: "m1", agent: "a", outcome: "pass", attempts: 1, failedCriteria: [], ts: "1" });
    recordOutcome({ cardId: "c2", title: "t", model: "m1", agent: "a", outcome: "fail", attempts: 1, failedCriteria: [], ts: "2" });
    recordOutcome({ cardId: "c3", title: "t", model: "m1", agent: "a", outcome: "pass", attempts: 1, failedCriteria: [], ts: "3" });
    const r = modelPassRate("m1");
    expect(r.total).toBe(3);
    expect(r.pass).toBe(2);
    expect(r.rate).toBeCloseTo(0.667, 2);
  });

  test("bestModelForTask picks model with best rate on similar tasks", () => {
    recordOutcome({ cardId: "c1", title: "Fix auth bug", model: "m1", agent: "a", outcome: "pass", attempts: 1, failedCriteria: [], ts: "1" });
    recordOutcome({ cardId: "c2", title: "Fix auth bug", model: "m1", agent: "a", outcome: "pass", attempts: 1, failedCriteria: [], ts: "2" });
    recordOutcome({ cardId: "c3", title: "Fix auth bug", model: "m2", agent: "a", outcome: "fail", attempts: 1, failedCriteria: [], ts: "3" });
    recordOutcome({ cardId: "c4", title: "Fix auth bug", model: "m2", agent: "a", outcome: "fail", attempts: 1, failedCriteria: [], ts: "4" });
    expect(bestModelForTask("Fix auth bug")).toBe("m1");
  });

  test("commonFailureCriteria aggregates", () => {
    recordOutcome({ cardId: "c1", title: "t", model: "m", agent: "a", outcome: "fail", attempts: 1, failedCriteria: ["tests pass"], ts: "1" });
    recordOutcome({ cardId: "c2", title: "t", model: "m", agent: "a", outcome: "fail", attempts: 1, failedCriteria: ["tests pass"], ts: "2" });
    recordOutcome({ cardId: "c3", title: "t", model: "m", agent: "a", outcome: "fail", attempts: 1, failedCriteria: ["source edited"], ts: "3" });
    const common = commonFailureCriteria();
    expect(common[0].criterion).toBe("tests pass");
    expect(common[0].count).toBe(2);
  });
});
