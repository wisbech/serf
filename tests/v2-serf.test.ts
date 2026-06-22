import { test, expect, describe } from "bun:test";
import { createSerf, readSerf, listSerfs, morphSerf, deprecateSerf, MASTER_IDENTITY, type SerfIdentity } from "../src/v2/serf";

describe("Serf Identity", () => {
  test("createSerf + readSerf round-trip", () => {
    const identity: SerfIdentity = {
      name: `test-serf-${Date.now()}`,
      mission: "Test mission",
      persona: "Test persona",
      lever: ["tool1", "tool2"],
      measurement: ["metric1", "metric2"],
      fate: "Spawned for testing. Deprecated after test.",
    };
    createSerf(identity);

    const read = readSerf(identity.name);
    expect(read).not.toBeNull();
    expect(read!.name).toBe(identity.name);
    expect(read!.mission).toBe("Test mission");
    expect(read!.persona).toBe("Test persona");
    expect(read!.lever).toEqual(["tool1", "tool2"]);
    expect(read!.measurement).toEqual(["metric1", "metric2"]);
    expect(read!.fate).toContain("Spawned for testing");
  });

  test("readSerf returns null for unknown", () => {
    expect(readSerf("nonexistent-serf-xyz")).toBeNull();
  });

  test("listSerfs returns all serfs", () => {
    const name1 = `list-test-${Date.now()}-a`;
    const name2 = `list-test-${Date.now()}-b`;
    createSerf({ name: name1, mission: "a", persona: "a", lever: [], measurement: [], fate: "a" });
    createSerf({ name: name2, mission: "b", persona: "b", lever: [], measurement: [], fate: "b" });

    const all = listSerfs();
    expect(all.some(s => s.name === name1)).toBe(true);
    expect(all.some(s => s.name === name2)).toBe(true);
  });

  test("morphSerf updates identity", () => {
    const name = `morph-test-${Date.now()}`;
    createSerf({ name, mission: "original", persona: "original", lever: ["a"], measurement: ["x"], fate: "original" });

    const morphed = morphSerf(name, { persona: "changed", mission: "new mission" });
    expect(morphed).not.toBeNull();
    expect(morphed!.persona).toBe("changed");
    expect(morphed!.mission).toBe("new mission");
    expect(morphed!.lever).toEqual(["a"]); // unchanged
  });

  test("deprecateSerf moves to retired", () => {
    const name = `deprecate-test-${Date.now()}`;
    createSerf({ name, mission: "retiring", persona: "retiring", lever: [], measurement: [], fate: "done" });

    expect(deprecateSerf(name)).toBe(true);
    expect(readSerf(name)).toBeNull(); // no longer in active serfs
  });

  test("deprecateSerf returns false for unknown", () => {
    expect(deprecateSerf("nonexistent")).toBe(false);
  });

  test("MASTER_IDENTITY has all required fields", () => {
    expect(MASTER_IDENTITY.name).toBe("master");
    expect(MASTER_IDENTITY.mission.length).toBeGreaterThan(0);
    expect(MASTER_IDENTITY.persona.length).toBeGreaterThan(0);
    expect(MASTER_IDENTITY.lever.length).toBeGreaterThan(0);
    expect(MASTER_IDENTITY.measurement.length).toBeGreaterThan(0);
    expect(MASTER_IDENTITY.fate.length).toBeGreaterThan(0);
  });
});