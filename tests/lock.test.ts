import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { acquireLock, releaseLock, readLock, clearStaleLock } from "../src/lock";
import { writeFileSync, mkdtempSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "serf-lock-"));
  process.env.SERF_HOME = join(dir, ".serf");
  delete process.env.SERF_INSTANCE;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.SERF_HOME;
  delete process.env.SERF_INSTANCE;
});

describe("Lock", () => {
  test("acquire and release a lock by own pid", () => {
    const acquired = acquireLock();
    expect(acquired.ok).toBe(true);
    const lock = readLock();
    expect(lock).not.toBeNull();
    expect(lock!.held).toBe(true);

    releaseLock();
    expect(existsSync(join(dir, ".serf", "tmp", "main.pid"))).toBe(false);
  });

  test("locks held by a dead pid are treated as stale", () => {
    // Write a pid that is guaranteed not to be running.
    mkdirSync(join(dir, ".serf", "tmp"), { recursive: true });
    writeFileSync(join(dir, ".serf", "tmp", "main.pid"), String(999999));
    const lock = readLock();
    expect(lock!.held).toBe(false);

    // clearStaleLock removes it so acquireLock succeeds.
    clearStaleLock();
    const acquired = acquireLock();
    expect(acquired.ok).toBe(true);
  });

  test("different instances hold independent locks", () => {
    process.env.SERF_INSTANCE = "child-1";
    const a = acquireLock();
    expect(a.ok).toBe(true);

    process.env.SERF_INSTANCE = "child-2";
    const b = acquireLock();
    expect(b.ok).toBe(true);

    // Both locks coexist.
    expect(existsSync(join(dir, ".serf", "tmp", "child-1.pid"))).toBe(true);
    expect(existsSync(join(dir, ".serf", "tmp", "child-2.pid"))).toBe(true);
  });
});
