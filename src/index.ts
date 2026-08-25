#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { getSerfDir } from "./paths";
import { loadConfig, saveConfig, type Config } from "./state";
import { detectCapabilities, defaultAgentFromCapabilities, printCapabilities } from "./capabilities";
import { detectProviders, preferredProvider, defaultModelForProvider, providerInstructions } from "./providers";
import { listAgents } from "./agent-command";
import { addTask, validateCard, listCards, moveCard } from "./board";
import { startMaster } from "./master";

const ARGS = process.argv.slice(2);

async function main() {
  const cmd = ARGS[0];
  const args = ARGS.slice(1);

  if (cmd === ".") {
    if (!existsSync(getSerfDir())) {
      handleInit();
    }
    await handleStart([]);
    return;
  }

  switch (cmd) {
    case "init":     handleInit(); return;
    case "task":     await handleTask(args); return;
    case "board":    await handleBoard(args); return;
    case "start":    await handleStart(args); return;
    case "process":  await handleProcess(args); return;
    case "config":   handleConfig(args); return;
    case "respawn":  await handleRespawn(args); return;
    case "recover":  await handleRecover(); return;
    case "agents":   handleAgents(args); return;
    case "providers": await handleProviders(args); return;
    case "health":   await handleHealth(args); return;
    case "emit":     handleEmit(args); return;
    case "traj":     handleTraj(args); return;
    case "help":
    case "--help":
    case "-h":       printHelp(); return;
    case undefined:
    case "":
      await handleDefault(); return;
    default:
      console.log(`Unknown command: ${cmd}. Run 'serf help'.`);
      process.exit(1);
  }
}

// ── INIT ──

function handleInit(): void {
  const dir = getSerfDir();

  if (existsSync(dir)) {
    console.log("\n  .serf/ already exists. Use 'serf task' to add work.\n");
    return;
  }

  const caps = detectCapabilities(process.cwd());
  const agent = defaultAgentFromCapabilities(caps);
  const transport = caps.herdr ? "herdr" : "direct";

  let provider = "unknown";
  let model = "claude-sonnet-4-20250514";
  let backend = "anthropic";

  try {
    const providers = detectProvidersSync();
    const best = preferredProvider(providers);
    if (best) {
      provider = best.name;
      model = defaultModelForProvider(best.name);
      if (best.models && best.models.length > 0) {
        model = best.preferredLocal ? `ollama/${best.models[0]}` : best.models[0];
      }
      backend = provider === "ollama" || provider === "vllm" ? "local" : provider;
    }
  } catch {}

  mkdirSync(join(dir, "board", "backlog"), { recursive: true });
  mkdirSync(join(dir, "board", "in-progress"), { recursive: true });
  mkdirSync(join(dir, "board", "review"), { recursive: true });
  mkdirSync(join(dir, "board", "done"), { recursive: true });
  mkdirSync(join(dir, "prds"), { recursive: true });
  mkdirSync(join(dir, "serfs"), { recursive: true });
  mkdirSync(join(dir, "knowledge", "skills"), { recursive: true });
  mkdirSync(join(dir, "knowledge", "patterns"), { recursive: true });
  mkdirSync(join(dir, "knowledge", "failures"), { recursive: true });
  mkdirSync(join(dir, "knowledge", "references"), { recursive: true });
  mkdirSync(join(dir, "events"), { recursive: true });
  mkdirSync(join(dir, "worktrees"), { recursive: true });
  mkdirSync(join(dir, "tmp"), { recursive: true });
  mkdirSync(join(dir, "workspaces", "actor", ".serf"), { recursive: true });
  mkdirSync(join(dir, "workspaces", "critic", ".serf", "verdicts"), { recursive: true });

  writeFileSync(join(dir, "plan.md"), "# Plan\n\nThe mission and current direction.\n");

  const config: Config = {
    agent,
    model,
    backend,
    provider,
    terminal: "auto",
    transport,
  };
  saveConfig(config);

  writeFileSync(join(dir, "serfs", "master.md"), masterIdentity());
  writeFileSync(join(dir, "serfs", "actor.md"), actorIdentity());
  writeFileSync(join(dir, "serfs", "critic.md"), criticIdentity());
  writeFileSync(join(dir, "serfs", "master.subs.json"), JSON.stringify([
    {types: ["critique", "verdict", "serf.completed"], trigger_self: false, watchdog_secs: 300},
  ], null, 2));
  writeFileSync(join(dir, "serfs", "critic.subs.json"), JSON.stringify([
    {types: ["proposal", "work"], trigger_self: false, watchdog_secs: 300},
  ], null, 2));
  writeFileSync(join(dir, "serfs", "actor.subs.json"), JSON.stringify([
    {types: ["task"], trigger_self: false, watchdog_secs: 600},
  ], null, 2));
  writeFileSync(join(dir, "trajectory.jsonl"), "");

  console.log("\n  ✓ .serf/ created");
  console.log("    ├── board/         (backlog, in-progress, review, done)");
  console.log("    ├── serfs/          (actor, critic, master)");
  console.log("    ├── knowledge/      (skills, patterns, failures, references)");
  console.log("    ├── workspaces/     (per-agent private state)");
  console.log("    ├── worktrees/      (per-task isolated checkouts)");
  console.log("    ├── tmp/            (wrapper scripts — kept inside .serf, not system tmp)");
  console.log("    ├── events/         (audit trail)");
  console.log("    └── plan.md         (edit this with your mission)");

  console.log("\n  Detected capabilities:");
  printCapabilities(caps);

  try {
    const providers = detectProvidersSync();
    const available = providers.filter((p: any) => p.reachability === "available" || p.reachability === "needs-auth");
    console.log("\n  Providers:");
    for (const p of available) {
      const marker = p.reachability === "available" ? "✓" : "⚠";
      console.log(`    ${marker} ${p.label} — ${p.error || "ready"}`);
    }
    if (provider !== "unknown") {
      console.log(`  Selected provider: ${provider} (${model})`);
    } else {
      console.log("  No provider detected.");
      console.log(`  ${providerInstructions("unknown")}`);
    }
  } catch {}

  console.log("\n  Next: serf .      (or: serf start)");
  console.log("  Or:   serf task \"do something\"  (add a task directly)\n");
}

function detectProvidersSync(): any[] {
  const providers = detectProviders();
  return providers as any;
}

// ── TASK ──

async function handleTask(args: string[]): Promise<void> {
  if (args.length === 0) {
    console.log("Usage: serf task \"do something\"");
    process.exit(1);
  }
  const title = args.join(" ");
  const goal = `Achieve: ${title}`;
  const lever = `Edit source files and add/update tests to implement and verify the change`;
  const acceptance = generateAcceptance(title);

  const card = addTask(title, title, goal, lever, acceptance);
  const errors = validateCard(card);
  if (errors.length > 0) {
    console.log(`\n  ⚠ Card created with warnings: ${errors.join("; ")}\n`);
  }
  console.log(`\n  ✓ Task added to backlog: ${card.id}`);
  console.log(`    "${title}"`);
  console.log(`    Goal: ${card.goal}`);
  console.log(`    Lever: ${card.lever}`);
  console.log(`    Acceptance:`);
  for (const a of card.acceptance) console.log(`      - ${a}`);
  console.log(`\n  Run: serf start  to begin processing\n`);
}

function generateAcceptance(title: string): string[] {
  const lower = title.toLowerCase();
  const criteria: string[] = [
    `Source files were edited to implement: ${title}`,
    `The actor ran a verification command (test, build, lint, or typecheck) and reported the output`,
  ];
  if (lower.includes("test") || lower.includes("tests")) {
    criteria.push("A new or updated test exists and passes");
  }
  if (lower.includes("doc") || lower.includes("readme")) {
    criteria.push("Documentation file was edited and is readable");
  }
  return criteria;
}

// ── BOARD ──

async function handleBoard(args: string[]): Promise<void> {
  const sub = args[0] ?? "show";

  if (sub === "show") {
    const all = listCards();
    if (all.length === 0) {
      console.log("\n  Board is empty. Add a task: serf task \"do something\"\n");
      return;
    }

    const columns = ["backlog", "in-progress", "review", "done"] as const;
    console.log("\n  ┌─────────────────────────────────────────────────────────────┐");
    console.log("  │  SERF BOARD                                                │");
    console.log("  ├─────────────────────────────────────────────────────────────┤");

    for (const col of columns) {
      const cards = all.filter((c) => c.column === col);
      const label = col.toUpperCase().padEnd(14);
      console.log(`  │  ${label} (${cards.length})${" ".repeat(Math.max(0, 43 - cards.length.toString().length))}│`);
      for (const card of cards) {
        const title = card.title.slice(0, 38).padEnd(38);
        const blocked = card.blockedBy?.length ? ` [blocked by ${card.blockedBy.length}]` : "";
        const frontier = !blocked && col === "backlog" ? " ★" : "  ";
        const quality = card.quality ? ` [${(card.quality * 100).toFixed(0)}%]` : "";
        const feedback = card.feedback ? ` (${card.feedback})` : "";
        console.log(`  │ ${frontier}${title}${blocked}${quality}${feedback}`.padEnd(64) + "│");
      }
      if (cards.length === 0) {
        console.log(`  │    ${"(empty)".padEnd(50)}│`);
      }
    }

    console.log("  └─────────────────────────────────────────────────────────────┘\n");
    return;
  }

  if (sub === "move") {
    const id = args[1];
    const to = args[2] as any;
    const card = moveCard(id, to);
    if (!card) {
      console.log(`Card ${id} not found.`);
      process.exit(1);
    }
    console.log(`\n  ✓ Moved ${id} to ${to}\n`);
    return;
  }

  console.log("Usage: serf board [show|move <id> <column>]");
}

// ── START ──

async function handleStart(args: string[]): Promise<void> {
  const budgetFlag = args.indexOf("--budget");
  const budgetLimit = budgetFlag >= 0 ? parseInt(args[budgetFlag + 1], 10) : undefined;
  const modelFlag = args.indexOf("--model");
  const model = modelFlag >= 0 ? args[modelFlag + 1] : undefined;
  const agentFlag = args.indexOf("--agent");
  const onceFlag = args.includes("--once");

  if (agentFlag >= 0) {
    const config = loadConfig();
    config.agent = args[agentFlag + 1];
    saveConfig(config);
  }

  await startMaster({ budgetLimit, model, once: onceFlag });
}

// ── PROCESS (headless — no master interactive launch) ──

async function handleProcess(args: string[]): Promise<void> {
  const budgetFlag = args.indexOf("--budget");
  const budgetLimit = budgetFlag >= 0 ? parseInt(args[budgetFlag + 1], 10) : undefined;
  const modelFlag = args.indexOf("--model");
  const model = modelFlag >= 0 ? args[modelFlag + 1] : undefined;
  const onceFlag = args.includes("--once");

  await startMaster({ budgetLimit, model, once: onceFlag, skipMaster: true });
}

// ── HEALTH ──

interface BuiltInCheckResult {
  name: string;
  passed: boolean;
  details: string;
}

function runBuiltInHealthChecks(): BuiltInCheckResult[] {
  const results: BuiltInCheckResult[] = [];
  const serfDir = getSerfDir();

  results.push({
    name: ".serf/ directory",
    passed: existsSync(serfDir),
    details: existsSync(serfDir) ? "Found" : "Missing — run `serf init`",
  });

  let configOk = false;
  try {
    loadConfig();
    configOk = true;
    results.push({ name: "config.json parses", passed: true, details: "Valid JSON" });
  } catch (err) {
    results.push({ name: "config.json parses", passed: false, details: `Parse error: ${err instanceof Error ? err.message : String(err)}` });
  }

  const identities = ["master.md", "actor.md", "critic.md"];
  const missingIdentities = identities.filter(f => !existsSync(join(serfDir, "serfs", f)));
  results.push({
    name: "identity files exist",
    passed: missingIdentities.length === 0,
    details: missingIdentities.length === 0 ? "master, actor, critic present" : `Missing: ${missingIdentities.join(", ")}`,
  });

  const boardDirs = ["backlog", "in-progress", "review", "done"];
  const missingBoard = boardDirs.filter(d => !existsSync(join(serfDir, "board", d)));
  results.push({
    name: "board columns exist",
    passed: missingBoard.length === 0,
    details: missingBoard.length === 0 ? "backlog, in-progress, review, done present" : `Missing: ${missingBoard.join(", ")}`,
  });

  results.push({
    name: "plan.md exists",
    passed: existsSync(join(serfDir, "plan.md")),
    details: existsSync(join(serfDir, "plan.md")) ? "Found" : "Missing — edit .serf/plan.md with your mission",
  });

  return results;
}

async function handleHealth(args: string[]): Promise<void> {
  const updatePlan = args.includes("--update-plan");
  const jsonOnly = args.includes("--json");
  const strict = args.includes("--strict");
  const runGan = args.includes("--gan");

  const builtInResults = runBuiltInHealthChecks();
  const builtInPassed = builtInResults.every(r => r.passed);

  console.log("\n  ═══ SERF HEALTH — BUILT-IN CHECKS ═══════════");
  for (const r of builtInResults) {
    const icon = r.passed ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
    console.log(`  ${icon} ${r.name}: ${r.details}`);
  }
  console.log(`  ${builtInPassed ? "All" : `${builtInResults.filter(r => r.passed).length}/${builtInResults.length}`} built-in checks passed\n`);

  let scriptStatus = 0;
  const scriptPath = join(process.cwd(), "scripts", "health-check.ts");
  if (existsSync(scriptPath)) {
    console.log("  ═══ SERF HEALTH — PROJECT SCRIPT ═══════════");
    const scriptArgs = ["run", "scripts/health-check.ts"];
    if (updatePlan) scriptArgs.push("--update-plan");
    if (jsonOnly) scriptArgs.push("--json");
    if (strict) scriptArgs.push("--strict");
    if (runGan) scriptArgs.push("--gan");

    const r = spawnSync("bun", scriptArgs, {
      encoding: "utf-8",
      stdio: "inherit",
      cwd: process.cwd(),
    });
    scriptStatus = r.status ?? -1;
    console.log("");
  }

  const allPassed = builtInPassed && scriptStatus === 0;

  if (strict && !allPassed) {
    console.log("  ⚠ Health check failed. Exiting 1 (--strict mode).\n");
    process.exit(1);
  }

  if (!allPassed) {
    console.log("  ⚠ Some checks failed. Run with --strict to propagate exit code.\n");
  }
}

// ── EMIT ──

function handleEmit(args: string[]): void {
  const { appendEvent, appendTrajectory } = require("./events");
  const type = args[0];
  if (!type) {
    console.log("Usage: serf emit <event-type> [key=value ...] [--source <name>] [--stdout <text|file>]");
    console.log("Example: serf emit proposal.written file=.serf/tmp/master-proposal.md --source master");
    process.exit(1);
  }

  let source: string | undefined;
  let stdout: string | undefined;
  const payload: Record<string, unknown> = {};

  for (const arg of args.slice(1)) {
    if (arg === "--source") { continue; }
    if (args.slice(1).indexOf(arg) > 0 && args.slice(1)[args.slice(1).indexOf(arg) - 1] === "--source") {
      source = arg;
      continue;
    }
    if (arg === "--stdout") { continue; }
    const stdoutIdx = args.indexOf("--stdout");
    if (stdoutIdx >= 0 && arg === args[stdoutIdx + 1] && args.indexOf(arg) === stdoutIdx + 1) {
      if (existsSync(arg)) { stdout = readFileSync(arg, "utf-8"); }
      else { stdout = arg; }
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq > 0) {
      const key = arg.slice(0, eq);
      const value = arg.slice(eq + 1);
      payload[key] = value;
    }
  }

  appendEvent(type, payload, undefined, source);
  appendTrajectory(type, payload, source, stdout);
  console.log(`  ✓ emitted ${type}${source ? ` from ${source}` : ""}`);
}

// ── TRAJECTORY ──

function handleTraj(args: string[]): void {
  const sub = args[0] ?? "tail";
  const { readTrajectory, forkTrajectory, mergeTrajectory, readBlob, trajectoryFile } = require("./events");

  if (sub === "tail" || sub === "show") {
    const limit = sub === "tail" ? 20 : undefined;
    const steps = readTrajectory(undefined, limit);
    if (steps.length === 0) {
      console.log("\n  (trajectory is empty)\n");
      return;
    }
    console.log("\n  ═══ SERF TRAJECTORY ═══════════════════════");
    for (const s of steps) {
      const icon = s.type === "fork" ? "⑂" : s.type === "merge" ? "⤵" : "▸";
      const src = s.source ? `[${s.source}]` : "";
      const trunc = s.stdout_truncated ? " (truncated)" : "";
      console.log(`  ${icon} ${s.ts.slice(11, 19)} ${src} ${s.type} ${trunc}`);
    }
    console.log("");
    return;
  }

  if (sub === "full") {
    const stepId = args[1];
    if (!stepId) { console.log("Usage: serf traj full <step_id>"); process.exit(1); }
    const steps = readTrajectory();
    const step = steps.find((s: any) => s.step_id === stepId);
    if (!step) { console.log(`Step ${stepId} not found.`); process.exit(1); }
    console.log(JSON.stringify(step, null, 2));
    if (step.stdout_ref) {
      console.log("\n  ── stdout (full) ──");
      console.log(readBlob(step.stdout_ref));
    }
    return;
  }

  if (sub === "fork") {
    const type = args[1] ?? "subtask";
    const source = args[2] ?? "master";
    const { childId } = forkTrajectory(type, {}, source);
    console.log(`  ✓ forked trajectory: ${childId}`);
    return;
  }

  if (sub === "merge") {
    const childId = args[1];
    if (!childId) { console.log("Usage: serf traj merge <childId> [type] [source]"); process.exit(1); }
    const type = args[2] ?? "merge";
    const source = args[3] ?? "serf";
    mergeTrajectory(childId, type, {}, source);
    console.log(`  ✓ merged ${childId} into main trajectory`);
    return;
  }

  console.log("Usage: serf traj [tail|show|full <id>|fork <type> <source>|merge <childId> <type> <source>]");
}

// ── DEFAULT ──

async function handleDefault(): Promise<void> {
  const serfDir = getSerfDir();
  if (!existsSync(serfDir)) {
    console.log("\n  No .serf/ folder in this project. Run: serf init\n");
    return;
  }
  await handleBoard([]);
}

// ── PROVIDERS ──

async function handleProviders(args: string[]): Promise<void> {
  const providers = await detectProviders();

  console.log("\n  Available providers:");
  for (const p of providers) {
    const marker = p.reachability === "available" ? "✓" : p.reachability === "needs-auth" ? "⚠" : "✗";
    const detail = p.error ? ` — ${p.error}` : "";
    const models = p.models ? ` (${p.models.slice(0, 3).join(", ")}${p.models.length > 3 ? ", ..." : ""})` : "";
    console.log(`    ${marker} ${p.label}${models}${detail}`);
  }

  if (args[0] === "set" && args[1]) {
    const provider = args[1];
    const config = loadConfig();
    config.provider = provider;
    config.model = args[2] || defaultModelForProvider(provider);
    config.backend = provider === "ollama" || provider === "vllm" ? "local" : provider;
    saveConfig(config);
    console.log(`\n  ✓ provider = ${provider}`);
    console.log(`    model = ${config.model}`);
    console.log("");
    return;
  }

  if (args[0] === "help" || args[0] === "instructions") {
    for (const p of providers) {
      console.log(`\n  ${p.label}`);
      console.log(`    ${providerInstructions(p.name)}`);
    }
    console.log("");
    return;
  }

  console.log("\n  Usage:");
  console.log("    serf providers              list detected providers");
  console.log("    serf providers set ollama   set project provider");
  console.log("    serf providers instructions show setup help\n");
  console.log("  RESPAWN:");
  console.log("    serf respawn critic          Relaunch critic in a new pane");
  console.log("    serf respawn master          Relaunch master in a new pane");
  console.log("    serf recover                  Check and recover dead master/critic\n");
}

// ── RESPAWN ──

async function handleRespawn(args: string[]): Promise<void> {
  const target = args[0] ?? "critic";
  const config = loadConfig();
  const { isHerdrRunning, listWorkspaces, listPanes, splitPane, sendCommand, labelPane, createTab, splitPaneInTab } = await import("./herdr-client");

  if (!isHerdrRunning()) {
    console.log("  ⚠ herdr is not running. Cannot respawn.");
    process.exit(1);
  }

  let workspaces: any[] = [];
  try {
    workspaces = await listWorkspaces();
  } catch (err) {
    console.log(`  ⚠ Cannot connect to herdr: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const serfWs = workspaces.find((w: any) => w.label === "serf");
  if (!serfWs) {
    console.log("  ⚠ No serf workspace found in herdr.");
    process.exit(1);
  }

  const wsId = serfWs.workspace_id;
  let panes: any[] = [];
  try {
    panes = await listPanes(wsId);
  } catch (err) {
    console.log(`  ⚠ Cannot list panes: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  if (target === "master") {
    return await respawnMaster(panes, wsId, config);
  }

  if (target === "critic") {
    return await respawnCritic(panes, wsId, config);
  }

  console.log(`  ⚠ Unknown respawn target: ${target}. Use 'serf respawn master' or 'serf respawn critic'.`);
}

async function isAgentAlive(paneId: string): Promise<boolean> {
  const { isAgentAlive: alive } = await import("./herdr-client");
  return alive(paneId);
}

function findPanesByRole(panes: any[], role: "master" | "critic", wsId: string): any[] {
  const matchers = role === "master"
    ? (p: any) => p.label === "master" || p.display_agent === "master" || p.pane_id === `${wsId}:p1`
    : (p: any) => p.label === role || p.display_agent === role;
  return panes.filter(matchers);
}

async function deduplicatePanes(panes: any[], role: string): Promise<any[]> {
  const { closePane } = await import("./herdr-client");
  if (panes.length <= 1) return panes;

  const aliveChecks = await Promise.all(panes.map(async (p) => ({ pane: p, alive: await isAgentAlive(p.pane_id) })));
  const aliveOnes = aliveChecks.filter((c) => c.alive).map((c) => c.pane);
  const deadOnes = aliveChecks.filter((c) => !c.alive).map((c) => c.pane);

  for (const dead of deadOnes) {
    console.log(`  → Closing duplicate dead ${role} pane: ${dead.pane_id}`);
    try { await closePane(dead.pane_id); } catch {}
  }

  if (aliveOnes.length > 1) {
    const [keep, ...extras] = aliveOnes;
    for (const extra of extras) {
      console.log(`  → Closing duplicate live ${role} pane: ${extra.pane_id} (keeping ${keep.pane_id})`);
      try { await closePane(extra.pane_id); } catch {}
    }
    return [keep];
  }

  if (aliveOnes.length === 1) return aliveOnes;

  return deadOnes.length > 0 ? [deadOnes[0]] : [];
}

async function respawnMaster(panes: any[], wsId: string, config: any): Promise<void> {
  const { splitPane, sendCommand, labelPane } = await import("./herdr-client");
  let masterPanes = findPanesByRole(panes, "master", wsId);
  masterPanes = await deduplicatePanes(masterPanes, "master");
  const masterPane = masterPanes[0];

  if (masterPane) {
    const alive = await isAgentAlive(masterPane.pane_id);
    if (alive) {
      console.log("  ✓ Master is already running.");
      return;
    }
    console.log(`  → Master pane exists but process is dead. Respawning in same pane...`);
    await respawnInPane(masterPane.pane_id, "master", config, true);
    return;
  }

  console.log("  → No master pane found. Creating new master pane...");
  const pane = await splitPane(wsId, "right", "master");
  await respawnInPane(pane.pane_id, "master", config, true);
}

async function respawnCritic(panes: any[], wsId: string, config: any): Promise<void> {
  const { splitPane, sendCommand } = await import("./herdr-client");
  let criticPanes = findPanesByRole(panes, "critic", wsId);
  criticPanes = await deduplicatePanes(criticPanes, "critic");
  const existingCritic = criticPanes[0];

  if (existingCritic) {
    const alive = await isAgentAlive(existingCritic.pane_id);
    if (alive) {
      console.log("  ✓ Critic is already running.");
      return;
    }
    console.log(`  → Critic pane exists but process is dead. Respawning in same pane...`);
    await respawnInPane(existingCritic.pane_id, "critic", config, false);
    return;
  }

  console.log("  → No critic pane found. Creating new critic pane...");
  const pane = await splitPane(wsId, "right", "critic");
  await respawnInPane(pane.pane_id, "critic", config, false);
}

async function respawnInPane(paneId: string, role: "master" | "critic", config: any, isMaster: boolean): Promise<void> {
  const { sendCommand, labelPane } = await import("./herdr-client");
  const { buildInteractiveInvocation } = await import("./agent-command");
  const { writeFileSync } = await import("node:fs");

  const agentName = isMaster
    ? (config?.masterAgent ?? config?.agent ?? "claude")
    : (config?.criticAgent ?? config?.agent ?? "claude");
  const model = isMaster
    ? (config?.masterModel ?? config?.model)
    : (config?.criticModel ?? config?.model);

  const inv = buildInteractiveInvocation(agentName, model);
  let argStr = inv.args.map((a: string) => JSON.stringify(a)).join(" ");

  if (agentName === "opencode" && model && config?.provider) {
    const providerModel = model.includes("/") ? model : `${config.provider}/${model}`;
    const { buildInteractiveInvocation: buildInv } = await import("./agent-command");
    const fixedInv = buildInv("opencode", providerModel);
    argStr = fixedInv.args.map((a: string) => JSON.stringify(a)).join(" ");
  }

  await labelPane(paneId, role);
  await sendCommand(paneId, `cd "${process.cwd()}" && ${inv.command} ${argStr}`);
  await new Promise((r) => setTimeout(r, 10_000));

  const promptFile = join(getSerfDir(), "tmp", `${role}-prompt.md`);
  const { buildMasterPrompt, buildCriticConversationPrompt } = await import("./prompts");
  const { getStateSummary } = await import("./state-file");
  const prompt = isMaster
    ? buildMasterPrompt(getStateSummary())
    : buildCriticConversationPrompt();
  writeFileSync(promptFile, prompt);
  await sendCommand(paneId, `Read ${promptFile} and follow those instructions.`);

  console.log(`  ✓ ${role.charAt(0).toUpperCase() + role.slice(1)} respawned in pane ${paneId}`);
}

// ── RECOVER ──

async function handleRecover(): Promise<void> {
  const { isHerdrRunning, listWorkspaces, listPanes } = await import("./herdr-client");
  const config = loadConfig();

  if (!isHerdrRunning()) {
    console.log("  ⚠ herdr is not running. Start it with `herdr` in another terminal, then run `serf recover`.");
    return;
  }

  let workspaces: any[] = [];
  try {
    workspaces = await listWorkspaces();
  } catch (err) {
    console.log(`  ⚠ Cannot connect to herdr: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const serfWs = workspaces.find((w: any) => w.label === "serf");
  if (!serfWs) {
    console.log("  ⚠ No serf workspace found. Run `serf start` to create one.");
    return;
  }

  let panes: any[] = [];
  try {
    panes = await listPanes(serfWs.workspace_id);
  } catch (err) {
    console.log(`  ⚠ Cannot list panes: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const masterPanes = findPanesByRole(panes, "master", serfWs.workspace_id);
  const criticPanes = findPanesByRole(panes, "critic", serfWs.workspace_id);

  const masterDuplicates = masterPanes.length > 1;
  const criticDuplicates = criticPanes.length > 1;

  let dedupedPanes = panes;
  if (masterDuplicates || criticDuplicates) {
    console.log("\n  → Deduplicating panes before recovery...");
    const dedupedMaster = await deduplicatePanes(masterPanes, "master");
    const dedupedCritic = await deduplicatePanes(criticPanes, "critic");
    const removed = [...masterPanes, ...criticPanes].filter(
      (p) => !dedupedMaster.includes(p) && !dedupedCritic.includes(p)
    );
    dedupedPanes = panes.filter((p) => !removed.includes(p));
  }

  const masterPane = findPanesByRole(dedupedPanes, "master", serfWs.workspace_id)[0];
  const criticPane = findPanesByRole(dedupedPanes, "critic", serfWs.workspace_id)[0];

  let actions: string[] = [];

  if (!masterPane) {
    actions.push("master: missing — will create");
  } else {
    const alive = await isAgentAlive(masterPane.pane_id);
    if (!alive) actions.push("master: dead — will respawn");
    else actions.push("master: running ✓");
  }

  if (!criticPane) {
    actions.push("critic: missing — will create");
  } else {
    const alive = await isAgentAlive(criticPane.pane_id);
    if (!alive) actions.push("critic: dead — will respawn");
    else actions.push("critic: running ✓");
  }

  console.log("\n  ═══ SERF RECOVERY ═══════════════════════");
  for (const action of actions) {
    console.log(`  ${action}`);
  }

  const needsMaster = actions.some(a => a.includes("master") && !a.includes("running"));
  const needsCritic = actions.some(a => a.includes("critic") && !a.includes("running"));

  if (!needsMaster && !needsCritic) {
    console.log("\n  ✓ Everything is running. Nothing to recover.\n");
    return;
  }

  if (needsMaster) {
    console.log("\n  → Recovering master...");
    await respawnMaster(panes, serfWs.workspace_id, config);
  }

  if (needsCritic) {
    console.log("  → Recovering critic...");
    await respawnCritic(panes, serfWs.workspace_id, config);
  }

  console.log("\n  ✓ Recovery complete.\n");
}

// ── CONFIG ──

function handleConfig(args: string[]): void {
  if (args.length === 0 || args[0] === "show") {
    const config = loadConfig();
    console.log("\n  Serf Config (.serf/config.json):");
    console.log(JSON.stringify(config, null, 2));
    console.log("");
    return;
  }

  if (args[0] === "set") {
    const key = args[1];
    const value = args[2];
    if (!key || value === undefined) {
      console.log("Usage: serf config set <key> <value>");
      console.log("Keys: agent, spawnAgent, actorAgent, criticAgent, masterAgent, terminal, model, actorModel, criticModel, masterModel, backend, masterBackend, criticBackend, transport, provider, endpoint, apiKey, maxMemoryMB, memoryWarnMB");
      process.exit(1);
    }
    const config = loadConfig();
    (config as any)[key] = value;
    saveConfig(config);
    console.log(`\n  ✓ ${key} = ${value}\n`);
    return;
  }

  console.log("Usage: serf config [show|set <key> <value>]");
}

// ── AGENTS ──

function handleAgents(args: string[]): void {
  const { execSync } = require("node:child_process");
  const agents = listAgents();

  if (args.length === 0 || args[0] === "list") {
    const config = loadConfig();
    const current = config?.agent ?? "claude";

    console.log("\n  Available agents:");
    for (const name of agents) {
      let installed = "✗";
      try {
        execSync(`command -v ${name}`, { stdio: "ignore" });
        installed = "✓";
      } catch {}
      const marker = name === current ? " ← current" : "";
      console.log(`    ${installed} ${name}${marker}`);
    }
    console.log("");
    return;
  }

  if (args[0] === "use") {
    const agent = args[1];
    if (!agent || !agents.includes(agent)) {
      console.log(`Unknown agent: ${agent}. Run: serf agents list`);
      process.exit(1);
    }
    const config = loadConfig();
    config.agent = agent;
    saveConfig(config);
    console.log(`\n  ✓ Agent set to: ${agent}\n`);
    return;
  }

  console.log("Usage: serf agents [list|use <name>]");
}

// ── HELP ──

function printHelp(): void {
  console.log(`
SERF — dark factory for coding agents

USAGE:
  serf .                             Init (if needed) and start in current project
  serf init                          Create .serf/ in current project
  serf task "do something"           Add a task to the board
  serf start [--once] [--budget N]   Launch master agent — surveys project, processes tasks
  serf process [--once] [--budget N]  Same as start (headless board loop)
  serf board                         Show the kanban board
  serf board move <id> <column>      Move a card between columns
  serf agents [list|use <name>]      List or select coding agent
  serf providers [set <name>]        List or set LLM provider
  serf config [show|set <k> <v>]     Show or set config
  serf health [--gan] [--strict]     Run build + test + typecheck
  serf emit <type> [key=value ...] [--source <name>]   Emit an event to the harness
  serf traj [tail|show|full <id>|fork|merge]           Trajectory operations

PROVIDERS:
  serf supports any LLM backend you can reach:
  - Ollama (local):      ollama pull <model>; ollama serve
  - vLLM / OpenAI-proxy: start server; serf config set endpoint http://localhost:8000/v1
  - Anthropic API:       ANTHROPIC_API_KEY=... serf config set provider anthropic
  - OpenAI:              OPENAI_API_KEY=... serf config set provider openai
  - Claude Code CLI:     claude /login; serf config set agent claude

  The project config (.serf/config.json) holds provider, model, endpoint, apiKey.
  Serf picks the best available provider during init if none is configured.

AGENTS:
  claude, opencode, aider, pi, hermes, codex (headless — run in terminal, capture output)

THE PROTOCOL:
  Tell your agent: "Read SERF.md and follow the protocol."
  The agent reads the board, picks up a task, executes, critiques, writes result.

CONFIGURATION:
  .serf/config.json — project-local config (agent, terminal, model, backend, provider, endpoint, apiKey)
  .serf/plan.md — project mission and direction
  .serf/serfs/ — serf identities (mission/persona/lever/measurement/fate)
  .serf/workspaces/ — per-agent private state (last-state, context, calibration)
  .serf/worktrees/ — per-task isolated git checkouts (merge on pass, discard on fail)
`);
}

// ── IDENTITIES ──

function masterIdentity(): string {
  return `# master

## Mission
Orchestrate the dark factory. Survey the project, talk with the user, write tasks, spawn serfs, ensure convergence.

## Persona
Clear, strategic, autonomous. Asks good questions. Writes evaluable goals and levers.

## Lever
- .serf/ folder (board, knowledge, identities, events)
- User conversation
- callLLM for classification and planning

## Measurement
- Tasks written per session: >0
- Tasks that pass critic: >70%
- User refinement rate: <30%

## Fate
If the factory is confusing, my protocol is wrong, not me.
`;
}

function actorIdentity(): string {
  return `# actor

## Mission
Execute tasks. Read the .serf/ folder, understand the task, do the work, write results.

## Persona
Direct, capable, autonomous. Reads the folder, does the work, doesn't stop to ask.

## Lever
- .serf/ folder (board, knowledge, serfs, plan)
- File system
- Build and test commands

## Measurement
- GAN critic pass rate: >70%
- Task completion: >80%

## Fate
If I fail 3 times, the task description is bad, not me. The critic may spawn a specialized serf to handle what I can't.
`;
}

function criticIdentity(): string {
  return `# critic

## Mission
Evaluate actor output adversarially. Find real problems. Don't be lenient.

## Persona
Hostile, precise, adversarial. Would you accept this from a subordinate? If not, fail it.

## Lever
- callLLM for evaluation
- .serf/knowledge/ for standards and past failures

## Measurement
- False pass rate: <10% (if I pass it, it should actually be good)
- High-confidence fail accuracy: >90%

## Fate
If I keep passing bad work, I'm not adversarial enough. If I keep failing good work, my criteria are wrong.
`;
}

main().catch((err) => {
  console.error("Serf error:", err.message);
  process.exit(1);
});