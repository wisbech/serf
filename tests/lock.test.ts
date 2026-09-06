import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { acquireLock, releaseLock, readLock, clearStaleLock } from "../src/lock";
import { writeFileSync, mkdtempSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "serf-lock-"));
  process.env.SERF_HOME = join(dir, ".serf");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.SERF_HOME;
});

describe("Lock", () => {
  test("acquire and release a lock by own pid", () => {
    const acquired = acquireLock();
    expect(acquired.ok).toBe(true);
    const lock = readLock();
    expect(lock).not.toBeNull();
    expect(lock!.held).toBe(true);

    releaseLock();
    expect(existsSync(join(dir, ".serf", "tmp", "serf.pid"))).toBe(false);
  });

  test("locks held by a dead pid are treated as stale", () => {
    // Write a pid that is guaranteed not to be running.
    mkdirSync(join(dir, ".serf", "tmp"), { recursive: true });
    writeFileSync(join(dir, ".serf", "tmp", "serf.pid"), String(999999));
    const lock = readLock();
    expect(lock!.held).toBe(false);

    // clearStaleLock removes it so acquireLock succeeds.
    clearStaleLock();
    const acquired = acquireLock();
    expect(acquired.ok).toBe(true);
  });
});
