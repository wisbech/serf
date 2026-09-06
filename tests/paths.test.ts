import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { getSerfDir } from "../src/paths";
import { mkdirSync, mkdtempSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "serf-paths-")));
  delete process.env.SERF_HOME;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("getSerfDir", () => {
  test("returns <cwd>/.serf when invoked from project root", () => {
    mkdirSync(join(root, ".serf"), { recursive: true });
    const prev = process.cwd();
    process.chdir(root);
    try {
      expect(getSerfDir()).toBe(join(root, ".serf"));
    } finally {
      process.chdir(prev);
    }
  });

  test("walks up to find .serf when invoked from inside .serf/", () => {
    mkdirSync(join(root, ".serf", "tmp"), { recursive: true });
    const prev = process.cwd();
    process.chdir(join(root, ".serf"));
    try {
      expect(getSerfDir()).toBe(join(root, ".serf"));
    } finally {
      process.chdir(prev);
    }
  });

  test("honors SERF_HOME override", () => {
    process.env.SERF_HOME = join(root, "custom");
    expect(getSerfDir()).toBe(join(root, "custom"));
  });
});
