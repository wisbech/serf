import { test, expect, describe } from "bun:test";
import { FakeTransport, HeadlessTransport, HerdrTransport, waitForOutputFile, matchesType, launchCmd, type Transport, type RunOpts } from "../src/transport";
import { buildInvocation, listAgents, isHeadless, qualifyModel } from "../src/agent-command";
import { writeFileSync, mkdtempSync, rmSync, utimesSync, statSync, existsSync } from "node:fs";
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

  test("qualifyModel does not prefix when provider is unknown", () => {
    expect(qualifyModel("claude-sonnet-4-20250514", "unknown")).toBe("claude-sonnet-4-20250514");
    expect(qualifyModel("claude-sonnet-4-20250514", undefined)).toBe("claude-sonnet-4-20250514");
  });

  test("qualifyModel prefixes a real provider", () => {
    expect(qualifyModel("qwen3:8b", "ollama")).toBe("ollama/qwen3:8b");
  });

  test("qualifyModel leaves already-qualified models alone", () => {
    expect(qualifyModel("ollama/qwen3:8b", "ollama")).toBe("ollama/qwen3:8b");
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

describe("proposal mtime polling", () => {
  test("detects when proposal is updated", () => {
    const dir = mkdtempSync(join(tmpdir(), "serf-kicker-"));
    const file = join(dir, "master-proposal.md");
    writeFileSync(file, "v1");
    const mtime1 = existsSync(file) ? statSync(file).mtimeMs : 0;

    writeFileSync(file, "v2");
    utimesSync(file, new Date(Date.now() + 2000), new Date(Date.now() + 2000));
    const mtime2 = statSync(file).mtimeMs;

    expect(mtime2).toBeGreaterThan(mtime1);

    rmSync(dir, { recursive: true, force: true });
  });

  test("detects when proposal appears after construction", () => {
    const dir = mkdtempSync(join(tmpdir(), "serf-kicker-"));
    const file = join(dir, "master-proposal.md");

    const mtime1 = existsSync(file) ? statSync(file).mtimeMs : 0;
    expect(mtime1).toBe(0);

    writeFileSync(file, "v1");
    const mtime2 = statSync(file).mtimeMs;
    expect(mtime2).toBeGreaterThan(0);

    rmSync(dir, { recursive: true, force: true });
  });
});

describe("waitForOutputFile", () => {
  test("resolves immediately when output file already contains a completion marker (no TDZ crash)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "serf-wait-"));
    const file = join(dir, "output.md");
    writeFileSync(file, "some output\nSERF_DONE_EXIT_CODE=0\n");

    const result = await waitForOutputFile(file, 1000);
    expect(result).toContain("SERF_DONE_EXIT_CODE=0");

    rmSync(dir, { recursive: true, force: true });
  });

  test("resolves when the marker appears after construction", async () => {
    const dir = mkdtempSync(join(tmpdir(), "serf-wait-"));
    const file = join(dir, "output.md");

    const pending = waitForOutputFile(file, 5000);
    setTimeout(() => {
      writeFileSync(file, "work done\nSERF_TASK_DONE\n");
    }, 50);

    const result = await pending;
    expect(result).toContain("SERF_TASK_DONE");

    rmSync(dir, { recursive: true, force: true });
  });

  test("times out when the output directory is removed (orphaned actor)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "serf-wait-"));
    const file = join(dir, "output.md");

    const pending = waitForOutputFile(file, 200);
    // Simulate the worktree being removed while the actor is still running.
    setTimeout(() => {
      rmSync(dir, { recursive: true, force: true });
    }, 50);

    const result = await pending;
    expect(result).toBe("");

    rmSync(dir, { recursive: true, force: true });
  });

  test("times out after the hard cap when no marker ever arrives", async () => {
    const dir = mkdtempSync(join(tmpdir(), "serf-wait-"));
    const file = join(dir, "output.md");
    writeFileSync(file, "partial output, no marker");

    const start = Date.now();
    const result = await waitForOutputFile(file, 200);
    expect(Date.now() - start).toBeGreaterThanOrEqual(150);
    expect(result).toContain("partial output");

    rmSync(dir, { recursive: true, force: true });
  });
});

describe("matchesType", () => {
  test("exact match", () => {
    expect(matchesType("proposal", "proposal")).toBe(true);
  });

  test("prefix match: proposal.written matches proposal subscription", () => {
    expect(matchesType("proposal.written", "proposal")).toBe(true);
  });

  test("prefix match: critique.written matches critique subscription", () => {
    expect(matchesType("critique.written", "critique")).toBe(true);
  });

  test("no match for unrelated types", () => {
    expect(matchesType("verdict", "proposal")).toBe(false);
    expect(matchesType("proposal", "critique")).toBe(false);
  });

  test("does not match partial word prefixes", () => {
    expect(matchesType("proposals", "proposal")).toBe(false);
  });
});

describe("launchCmd", () => {
  test("redirects TMPDIR to the project .serf/tmp", () => {
    const cmd = launchCmd("/proj", "opencode", "--model ollama/x");
    expect(cmd).toContain('cd "/proj"');
    expect(cmd).toContain('export TMPDIR="');
    expect(cmd).toContain("/.serf/tmp");
    expect(cmd).toContain("opencode --model ollama/x");
  });
});