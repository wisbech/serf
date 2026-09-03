import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { createRoutine, readRoutine } from "../src/routines";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "serf-sched-"));
  process.env.SERF_HOME = join(dir, ".serf");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.SERF_HOME;
});

describe("Routine scheduling fields", () => {
  test("round-trips intervalSecs and watchDir", () => {
    createRoutine({
      name: "check-inbox",
      description: "Check inbox",
      trigger: "inbox email",
      steps: ["read", "reply"],
      verification: "done",
      parallel: true,
      intervalSecs: 900,
      watchDir: "/tmp/inbox",
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
    });
    const r = readRoutine("check-inbox");
    expect(r!.intervalSecs).toBe(900);
    expect(r!.watchDir).toBe("/tmp/inbox");
  });

  test("omits scheduling fields when not set", () => {
    createRoutine({
      name: "one-off",
      description: "one off",
      trigger: "oneoff",
      steps: ["x"],
      verification: "v",
      parallel: false,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
    });
    const r = readRoutine("one-off");
    expect(r!.intervalSecs).toBeUndefined();
    expect(r!.watchDir).toBeUndefined();
  });
});
