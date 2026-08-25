import { test, expect, describe } from "bun:test";
import { FakeTransport, HeadlessTransport, HerdrTransport, makeProposalKicker, type Transport, type RunOpts } from "../src/transport";
import { buildInvocation, listAgents, isHeadless } from "../src/agent-command";
import { writeFileSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("Agent Command", () => {
  test("buildInvocation produces correct claude invocation", () => {
    const inv = buildInvocation("claude", "claude-sonnet-4");
    expect(inv.command).toBe("claude");
    expect(inv.args).toContain("--print");
    expect(inv.args).toContain("--model");
    expect(inv.args).toContain("claude-sonnet-4");
    expect(inv.promptViaStdin).toBe(false);
  });

  test("buildInvocation produces correct opencode invocation", () => {
    const inv = buildInvocation("opencode", "qwen3.5");
    expect(inv.command).toBe("opencode");
    expect(inv.args[0]).toBe("run");
    expect(inv.args).toContain("--model");
    expect(inv.promptViaStdin).toBe(true);
  });

  test("buildInvocation without model still works", () => {
    const inv = buildInvocation("claude");
    expect(inv.command).toBe("claude");
    expect(inv.args).toEqual(["--print"]);
  });

  test("buildInvocation throws for unknown agent", () => {
    expect(() => buildInvocation("unknown-agent")).toThrow();
  });

  test("listAgents returns all registered agents", () => {
    const agents = listAgents();
    expect(agents).toContain("claude");
    expect(agents).toContain("opencode");
    expect(agents).toContain("aider");
    expect(agents.length).toBeGreaterThanOrEqual(5);
  });

  test("isHeadless returns true for known agents", () => {
    expect(isHeadless("claude")).toBe(true);
    expect(isHeadless("opencode")).toBe(true);
    expect(isHeadless("unknown")).toBe(false);
  });
});

describe("Transport", () => {
  test("FakeTransport records calls and returns response", async () => {
    const transport: Transport = new FakeTransport();
    const opts: RunOpts = {
      cwd: "/tmp",
      timeoutMs: 1000,
      outputFile: "/tmp/test-output.md",
    };
    const result = await transport.run("do something", opts);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("Fake agent output");
    expect((transport as FakeTransport).calls.length).toBe(1);
    expect((transport as FakeTransport).calls[0].prompt).toBe("do something");
  });

  test("FakeTransport can be configured with custom response", async () => {
    const transport = new FakeTransport();
    transport.response = "Custom output\nSERF_DONE_EXIT_CODE=0";
    const result = await transport.run("test", {
      cwd: "/tmp",
      timeoutMs: 1000,
      outputFile: "/tmp/test.md",
    });
    expect(result.output).toContain("Custom output");
  });

  test("HeadlessTransport and HerdrTransport implement Transport", () => {
    const headless: Transport = new HeadlessTransport("auto");
    const herdr: Transport = new HerdrTransport("ws-1");
    expect(headless).toBeDefined();
    expect(herdr).toBeDefined();
  });
});

describe("makeProposalKicker", () => {
  test("returns false when proposal has not changed since construction", () => {
    const dir = mkdtempSync(join(tmpdir(), "serf-kicker-"));
    const file = join(dir, "master-proposal.md");
    writeFileSync(file, "v1");
    const kicker = makeProposalKicker(file);
    expect(kicker()).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("returns true once when proposal is updated, then false again", () => {
    const dir = mkdtempSync(join(tmpdir(), "serf-kicker-"));
    const file = join(dir, "master-proposal.md");
    writeFileSync(file, "v1");
    const kicker = makeProposalKicker(file);
    expect(kicker()).toBe(false);

    writeFileSync(file, "v2");
    utimesSync(file, new Date(Date.now() + 2000), new Date(Date.now() + 2000));
    expect(kicker()).toBe(true);
    expect(kicker()).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("returns true when proposal appears after construction", () => {
    const dir = mkdtempSync(join(tmpdir(), "serf-kicker-"));
    const file = join(dir, "master-proposal.md");
    const kicker = makeProposalKicker(file);
    expect(kicker()).toBe(false);

    writeFileSync(file, "v1");
    expect(kicker()).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});