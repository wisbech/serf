import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { clusterTasks, promotionSuggestions } from "../src/maturity";
import { recordOutcome } from "../src/track-record";
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
});
