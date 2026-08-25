import { test, expect, describe } from "bun:test";
import { loadConfig } from "../src/state";
import { buildInteractiveInvocation } from "../src/agent-command";

describe("Spawned serf defaults", () => {
  test("loadConfig returns pi as default spawnAgent", () => {
    const config = loadConfig();
    expect(config.spawnAgent).toBe("pi");
  });

  test("buildInteractiveInvocation for pi works without model", () => {
    const inv = buildInteractiveInvocation("pi");
    expect(inv.command).toBe("pi");
  });
});
