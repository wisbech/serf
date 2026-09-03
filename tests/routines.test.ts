import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { createRoutine, readRoutine, listRoutines, matchRoutine, buildRoutinePrompt, routineExists } from "../src/routines";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "serf-routines-"));
  process.env.SERF_HOME = join(dir, ".serf");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.SERF_HOME;
});

describe("Routines", () => {
  test("create and read a routine", () => {
    createRoutine({
      name: "respond-email",
      description: "Draft a standard reply",
      trigger: "email reply respond",
      steps: ["Read the email", "Draft a reply", "Save to outbox"],
      verification: "check the reply is saved",
      parallel: true,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
    });
    const r = readRoutine("respond-email");
    expect(r).not.toBeNull();
    expect(r!.name).toBe("respond-email");
    expect(r!.steps.length).toBe(3);
    expect(r!.parallel).toBe(true);
    expect(routineExists("respond-email")).toBe(true);
  });

  test("matchRoutine finds by trigger keyword", () => {
    createRoutine({
      name: "parse-order",
      description: "Parse an order request",
      trigger: "order invoice parse",
      steps: ["Parse the request"],
      verification: "log written",
      parallel: false,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
    });
    const m = matchRoutine("Parse this new order into the log");
    expect(m).not.toBeNull();
    expect(m!.name).toBe("parse-order");
  });

  test("matchRoutine returns null when no match", () => {
    expect(matchRoutine("Refactor the auth module")).toBeNull();
  });

  test("buildRoutinePrompt includes steps and verification", () => {
    const r = {
      name: "pay-customer",
      description: "Pay a customer",
      trigger: "pay payout",
      steps: ["Verify invoice", "Approve payment"],
      verification: "payment recorded",
      parallel: true,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
    };
    const p = buildRoutinePrompt(r, { task: "Pay customer 42", goal: "paid", acceptance: ["payment recorded"] });
    expect(p).toContain("pay-customer");
    expect(p).toContain("Verify invoice");
    expect(p).toContain("VERIFICATION_COMMAND");
    expect(p).toContain("SERF_TASK_DONE");
  });

  test("listRoutines returns all", () => {
    createRoutine({ name: "a", description: "", trigger: "a", steps: ["x"], verification: "v", parallel: false, createdAt: "1", updatedAt: "1" });
    createRoutine({ name: "b", description: "", trigger: "b", steps: ["y"], verification: "v", parallel: false, createdAt: "1", updatedAt: "1" });
    expect(listRoutines().length).toBe(2);
  });
});
