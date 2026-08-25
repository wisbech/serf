import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createSandboxProfile, runSandboxed, isSandboxAvailable } from "../src/sandbox";
import { getSerfDir, ensureDir } from "../src/paths";

let TEST_DIR: string;

beforeEach(() => {
  const base = join(getSerfDir(), "sandboxes", "test-worktrees");
  ensureDir(base);
  TEST_DIR = mkdtempSync(join(base, "run-"));
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("Sandbox", () => {
  test("isSandboxAvailable true on darwin", () => {
    expect(isSandboxAvailable()).toBe(process.platform === "darwin");
  });

  test("createSandboxProfile writes profile and creates home/tmp dirs", () => {
    if (!isSandboxAvailable()) return;
    const profile = createSandboxProfile(TEST_DIR, "test-card");
    expect(existsSync(profile.profilePath)).toBe(true);
    expect(existsSync(profile.homeDir)).toBe(true);
    expect(existsSync(profile.tmpDir)).toBe(true);

    const content = readFileSync(profile.profilePath, "utf-8");
    expect(content).toContain("version 1");
    expect(content).toContain(TEST_DIR);
    expect(content).toContain("deny file-write*");
    expect(content).toContain("(allow default)");
  });

  test("runSandboxed blocks writes to user config dirs", () => {
    if (!isSandboxAvailable()) return;
    const profile = createSandboxProfile(TEST_DIR, "test-card");

    return new Promise((resolve, reject) => {
      const homeDir = process.env.HOME || "/Users/unknown";
      const blockedPath = `${homeDir}/.config/serf-sandbox-blocked.txt`;
      const child = runSandboxed(
        {
          command: `touch "${blockedPath}" 2>&1 && echo "allowed" || echo "blocked"`,
          cwd: TEST_DIR,
          timeoutMs: 5000,
        },
        profile,
      );

      let output = "";
      child.stdout?.on("data", (data) => (output += data.toString()));
      child.stderr?.on("data", (data) => (output += data.toString()));
      child.on("exit", () => {
        try {
          expect(output).toContain("blocked");
          resolve(undefined);
        } catch (e) {
          reject(e);
        }
      });
    });
  });

  test("runSandboxed allows writes inside worktree", () => {
    if (!isSandboxAvailable()) return;
    const profile = createSandboxProfile(TEST_DIR, "test-card");
    const testFile = join(TEST_DIR, "sandbox-allowed.txt");

    return new Promise((resolve, reject) => {
      const child = runSandboxed(
        {
          command: `touch "${testFile}" && echo "ok"`,
          cwd: TEST_DIR,
          timeoutMs: 5000,
        },
        profile,
      );

      let output = "";
      child.stdout?.on("data", (data) => (output += data.toString()));
      child.on("exit", () => {
        try {
          expect(output).toContain("ok");
          expect(existsSync(testFile)).toBe(true);
          resolve(undefined);
        } catch (e) {
          reject(e);
        }
      });
    });
  });

  test("runSandboxed uses sandbox home and tmp", () => {
    if (!isSandboxAvailable()) return;
    const profile = createSandboxProfile(TEST_DIR, "test-card");

    return new Promise((resolve, reject) => {
      const child = runSandboxed(
        {
          command: 'echo "HOME=$HOME TMPDIR=$TMPDIR"',
          cwd: TEST_DIR,
          timeoutMs: 5000,
        },
        profile,
      );

      let output = "";
      child.stdout?.on("data", (data) => (output += data.toString()));
      child.on("exit", () => {
        try {
          expect(output).toContain(`HOME=${profile.homeDir}`);
          expect(output).toContain(`TMPDIR=${profile.tmpDir}`);
          resolve(undefined);
        } catch (e) {
          reject(e);
        }
      });
    });
  });
});
