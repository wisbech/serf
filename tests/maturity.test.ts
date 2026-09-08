import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { clusterTasks, promotionSuggestions, promoteToRoutine, p90TurnsForTask } from "../src/maturity";
import { recordOutcome } from "../src/track-record";
import { routineExists } from "../src/routines";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "serf-maturity-"));
  process.env.SERF_HOME = join(dir, ".serf");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.SERF_HOME;
});

function rec(title: string, outcome: "pass" | "fail" | "review") {
  recordOutcome({ cardId: title, title, model: "m", agent: "a", outcome, attempts: 1, failedCriteria: [], ts: "1" });
}

describe("Maturity ladder", () => {
  test("clusters similar tasks by keyword", () => {
    rec("reconcile invoices", "pass");
    rec("reconcile invoices", "pass");
    rec("reconcile invoices", "pass");
    rec("fix auth bug", "pass");

    const clusters = clusterTasks(require("../src/track-record").readTrackRecords());
    const reconcile = clusters.find((c) => c.label === "reconcile invoices");
    expect(reconcile).toBeDefined();
    expect(reconcile!.count).toBe(3);
  });

  test("3 stable passes → repetitive stage", () => {
    rec("reconcile invoices", "pass");
    rec("reconcile invoices", "pass");
    rec("reconcile invoices", "pass");

    const clusters = clusterTasks(require("../src/track-record").readTrackRecords());
    const reconcile = clusters.find((c) => c.label === "reconcile invoices");
    expect(reconcile!.stage).toBe("repetitive");
  });

  test("8 stable passes → code stage", () => {
    for (let i = 0; i < 8; i++) rec("reconcile invoices", "pass");

    const clusters = clusterTasks(require("../src/track-record").readTrackRecords());
    const reconcile = clusters.find((c) => c.label === "reconcile invoices");
    expect(reconcile!.stage).toBe("code");
  });

  test("fails keep a task novel", () => {
    rec("reconcile invoices", "pass");
    rec("reconcile invoices", "fail");
    rec("reconcile invoices", "pass");

    const clusters = clusterTasks(require("../src/track-record").readTrackRecords());
    const reconcile = clusters.find((c) => c.label === "reconcile invoices");
    expect(reconcile!.stage).toBe("novel");
  });

  test("promotionSuggestions flags repetitive → routine", () => {
    rec("reconcile invoices", "pass");
    rec("reconcile invoices", "pass");
    rec("reconcile invoices", "pass");

    const suggestions = promotionSuggestions();
    expect(suggestions.some((s) => s.label === "reconcile invoices" && s.to === "routine")).toBe(true);
  });

  test("promoteToRoutine creates a routine from a repetitive task", () => {
    rec("reconcile invoices", "pass");
    rec("reconcile invoices", "pass");
    rec("reconcile invoices", "pass");

    const result = promoteToRoutine("reconcile invoices");
    expect(result.routine).toBe("reconcile-invoices");
    expect(routineExists("reconcile-invoices")).toBe(true);
  });

  test("promoteToRoutine refuses non-repetitive and already-routine tasks", () => {
    rec("fix auth bug", "pass"); // 1x, novel
    const novel = promoteToRoutine("fix auth bug");
    expect(novel.reason).toContain("not [repetitive]");
    expect(routineExists("fix-auth-bug")).toBe(false);
  });

  test("p90TurnsForTask returns undefined with no data", () => {
    expect(p90TurnsForTask("reconcile invoices")).toBeUndefined();
  });

  test("p90TurnsForTask returns p90 of similar successful runs", () => {
    recordOutcome({ cardId: "a", title: "reconcile invoices", model: "m", agent: "a", outcome: "pass", attempts: 1, failedCriteria: [], turnsUsed: 2, ts: "1" });
    recordOutcome({ cardId: "b", title: "reconcile invoices", model: "m", agent: "a", outcome: "pass", attempts: 1, failedCriteria: [], turnsUsed: 4, ts: "2" });
    recordOutcome({ cardId: "c", title: "reconcile invoices", model: "m", agent: "a", outcome: "pass", attempts: 1, failedCriteria: [], turnsUsed: 6, ts: "3" });
    recordOutcome({ cardId: "d", title: "reconcile invoices", model: "m", agent: "a", outcome: "pass", attempts: 1, failedCriteria: [], turnsUsed: 8, ts: "4" });
    recordOutcome({ cardId: "e", title: "reconcile invoices", model: "m", agent: "a", outcome: "pass", attempts: 1, failedCriteria: [], turnsUsed: 10, ts: "5" });
    // p90 of [2,4,6,8,10] = index 4 → 10
    expect(p90TurnsForTask("reconcile invoices")).toBe(10);
  });
});
