import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { ensureGarden, readGardenState, checkGarden, markRefreshed, markMinted, renderGarden, dataDir } from "../src/garden";
import { mkdirSync, mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "serf-garden-"));
  process.env.SERF_HOME = join(root, ".serf");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.SERF_HOME;
});

describe("Garden", () => {
  test("ensures data/ and credentials/ exist", () => {
    ensureGarden();
    expect(existsSync(join(dataDir(), "credentials"))).toBe(true);
    expect(existsSync(join(dataDir(), "state.json"))).toBe(true);
  });

  test("fresh data is not stale", () => {
    ensureGarden();
    markRefreshed("pricing", 86400); // 24h
    expect(checkGarden().some((s) => s.name === "pricing")).toBe(false);
  });

  test("expired data is stale", () => {
    ensureGarden();
    markRefreshed("pricing", 60); // 60s max age
    const state = readGardenState();
    state.data["pricing"].lastRefreshed = new Date(Date.now() - 120_000).toISOString();
    const { writeGardenState } = require("../src/garden");
    writeGardenState(state);
    expect(checkGarden().some((s) => s.name === "pricing")).toBe(true);
  });

  test("expired credential is stale", () => {
    ensureGarden();
    markMinted("ollama-cloud", 3600); // 1h ttl
    const state = readGardenState();
    state.data["ollama-cloud"].lastMinted = new Date(Date.now() - 7200_000).toISOString();
    const { writeGardenState } = require("../src/garden");
    writeGardenState(state);
    expect(checkGarden().some((s) => s.name === "ollama-cloud" && s.kind === "credential")).toBe(true);
  });

  test("renderGarden shows garden status", () => {
    ensureGarden();
    markRefreshed("pricing", 86400);
    expect(renderGarden()).toContain("pricing");
  });
});
