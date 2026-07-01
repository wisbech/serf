#!/usr/bin/env bun
import { spawnSync } from "node:child_process";

const ARGS = process.argv.slice(2);

async function main() {
  const cmd = ARGS[0];
  const args = ARGS.slice(1);

  // `serf .` is a shortcut to init-and-start in the current directory.
  if (cmd === ".") {
    const { existsSync } = require("node:fs");
    const { getSerfDir } = require("./v2/paths");
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
    case "agents":   handleAgents(args); return;
    case "providers": await handleProviders(args); return;
    case "health":   await handleHealth(args); return;
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

async function handleInit() {
  const { existsSync, mkdirSync, writeFileSync } = require("node:fs");
  const { join } = require("node:path");
  const { execSync } = require("node:child_process");
  const { getSerfDir } = require("./v2/paths");
  const { detectCapabilities, defaultAgentFromCapabilities } = require("./v2/capabilities");
  const dir = getSerfDir();

  if (existsSync(dir)) {
    console.log("\n  .serf/ already exists. Use 'serf task' to add work.\n");
    return;
  }

  // Detect what's actually installed and configure the project for it.
  const caps = detectCapabilities(process.cwd());
  const agent = defaultAgentFromCapabilities(caps);
  const transport = caps.herdr ? "herdr" : "direct";

  let provider = "unknown";
  let model = "claude-sonnet-4-20250514";
  let backend = "anthropic";

  try {
    const { detectProviders, preferredProvider, defaultModelForProvider } = require("./v2/providers");
    const providers = await detectProviders();
    const best = preferredProvider(providers);
    if (best) {
      provider = best.name;
      model = defaultModelForProvider(best.name);
      if (best.models && best.models.length > 0) {
        model = best.preferredLocal ? `ollama/${best.models[0]}` : best.models[0];
      }
      backend = provider === "ollama" || provider === "vllm" ? "local" : provider;
    }
  } catch (err) {
    // provider detection is best-effort; fall back to agent-based defaults
  }

  mkdirSync(join(dir, "board", "backlog"), { recursive: true });
  mkdirSync(join(dir, "board", "in-progress"), { recursive: true });
  mkdirSync(join(dir, "board", "review"), { recursive: true });
  mkdirSync(join(dir, "board", "done"), { recursive: true });
  mkdirSync(join(dir, "serfs"), { recursive: true });
  mkdirSync(join(dir, "knowledge", "skills"), { recursive: true });
  mkdirSync(join(dir, "knowledge", "patterns"), { recursive: true });
  mkdirSync(join(dir, "knowledge", "failures"), { recursive: true });
  mkdirSync(join(dir, "knowledge", "references"), { recursive: true });
  mkdirSync(join(dir, "events"), { recursive: true });
  mkdirSync(join(dir, "worktrees"), { recursive: true });
  mkdirSync(join(dir, "workspaces", "actor", ".serf"), { recursive: true });
  mkdirSync(join(dir, "workspaces", "critic", ".serf", "verdicts"), { recursive: true });

  writeFileSync(join(dir, "plan.md"), "# Plan\n\nThe mission and current direction.\n");

  writeFileSync(join(dir, "config.json"), JSON.stringify({
    agent,
    model,
    backend,
    provider,
    terminal: "auto",
    transport,
  }, null, 2) + "\n");

  writeFileSync(join(dir, "serfs", "master.md"), `# master

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
`);

  writeFileSync(join(dir, "serfs", "actor.md"), `# actor

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
`);

  writeFileSync(join(dir, "serfs", "critic.md"), `# critic

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
`);

  console.log("\n  ✓ .serf/ created");
  console.log("    ├── board/         (backlog, in-progress, review, done)");
  console.log("    ├── serfs/          (actor, critic)");
  console.log("    ├── knowledge/      (skills, patterns, failures, references)");
  console.log("    ├── workspaces/     (per-agent private state)");
  console.log("    ├── worktrees/      (per-task isolated checkouts)");
  console.log("    ├── events/         (audit trail)");
  console.log("    └── plan.md         (edit this with your mission)");

  console.log("\n  Detected capabilities:");
  const { printCapabilities } = require("./v2/capabilities");
  printCapabilities(caps);

  try {
    const { detectProviders, providerInstructions } = require("./v2/providers");
    const providers = await detectProviders();
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
  } catch (err) {
    // provider detection is best-effort
  }

  console.log("\n  Next: serf .      (or: serf start)");
  console.log("  Or:   serf task \"do something\"  (add a task directly)\n");
}

// ── INTEGRATION CHECK ──

const HERDR_INTEGRATIONS: Record<string, string> = {
  claude: "claude",
  opencode: "opencode",
  codex: "codex",
  pi: "pi",
  aider: "omp",
  hermes: "hermes",
  cursor: "cursor",
};

function isInstalled(cmd: string): boolean {
  try {
    require("node:child_process").execSync(`which ${cmd} 2>/dev/null`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function checkIntegrations(): void {
  const { execSync } = require("node:child_process");

  const found: string[] = [];
  for (const agent of Object.keys(HERDR_INTEGRATIONS)) {
    if (isInstalled(agent)) found.push(agent);
  }

  if (found.length === 0) {
    console.log("\n  ⚠ No coding agents found on PATH.");
    console.log("    Install one: claude, opencode, aider, pi, hermes, or codex");
    return;
  }

  console.log(`\n  Coding agents found: ${found.join(", ")}`);

  const herdrInstalled = isInstalled("herdr");
  if (!herdrInstalled) {
    console.log("\n  herdr not found (optional — enables multi-pane agent management)");
    console.log("    Install: curl -fsSL https://herdr.dev/install.sh | sh");
    return;
  }

  // herdr is installed — check which integrations are already installed
  let installedIntegrations: string[] = [];
  try {
    const output = execSync("herdr integration status 2>/dev/null", { encoding: "utf-8", stdio: "pipe" });
    for (const agent of found) {
      if (output.includes(agent)) installedIntegrations.push(agent);
    }
  } catch {}

  const needsIntegration = found.filter(a => !installedIntegrations.includes(a));

  if (needsIntegration.length === 0) {
    console.log("  ✓ herdr integrations already installed for all detected agents");
    return;
  }

  console.log(`\n  herdr found. Missing integrations for: ${needsIntegration.join(", ")}`);
  console.log("  Installing...");

  for (const agent of needsIntegration) {
    const integration = HERDR_INTEGRATIONS[agent];
    try {
      execSync(`herdr integration install ${integration}`, { stdio: "inherit" });
      console.log(`    ✓ ${agent} integration installed`);
    } catch {
      console.log(`    ✗ ${agent} integration failed (run: herdr integration install ${integration})`);
    }
  }
}

// ── TASK ──

async function handleTask(args: string[]) {
  if (args.length === 0) {
    console.log("Usage: serf task \"do something\"");
    process.exit(1);
  }
  const { addTask, validateCard } = await import("./v2/board");
  const title = args.join(" ");

  // Generate deterministic Goal, Lever, Acceptance from the title.
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
    `Output file .serf/board/in-progress/<id>-output.md contains evidence of actual file edits and ends with SERF_TASK_DONE`,
  ];
  if (lower.includes("test") || lower.includes("tests")) {
    criteria.push("A new or updated test exists and passes");
  }
  if (lower.includes("fix") || lower.includes("bug")) {
    criteria.push("The bug is reproduced by a failing test before the fix and passes after");
  }
  if (lower.includes("add") || lower.includes("new")) {
    criteria.push("New functionality is reachable from the CLI or public API");
  }
  if (lower.includes("doc") || lower.includes("readme")) {
    criteria.push("Documentation file was edited and is readable");
  }
  return criteria;
}

// ── BOARD ──

async function handleBoard(args: string[]) {
  const { listCards } = await import("./v2/board");
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
      const cards = all.filter(c => c.column === col);
      const label = col.toUpperCase().padEnd(14);
      console.log(`  │  ${label} (${cards.length})${" ".repeat(Math.max(0, 43 - cards.length.toString().length))}│`);
      for (const card of cards) {
        const title = card.title.slice(0, 45).padEnd(45);
        const quality = card.quality ? ` [${(card.quality * 100).toFixed(0)}%]` : "";
        const feedback = card.feedback ? ` (${card.feedback})` : "";
        console.log(`  │    ${title}${quality}${feedback}`.padEnd(64) + "│");
      }
      if (cards.length === 0) {
        console.log(`  │    ${"(empty)".padEnd(50)}│`);
      }
    }

    console.log("  └─────────────────────────────────────────────────────────────┘\n");
    return;
  }

  if (sub === "move") {
    const { moveCard } = await import("./v2/board");
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

async function handleStart(args: string[]) {
  const { startMaster } = await import("./v2/master");
  const { loadConfig, saveConfig } = require("./state");
  const budgetFlag = args.indexOf("--budget");
  const budgetLimit = budgetFlag >= 0 ? parseInt(args[budgetFlag + 1], 10) : undefined;
  const modelFlag = args.indexOf("--model");
  const model = modelFlag >= 0 ? args[modelFlag + 1] : undefined;
  const agentFlag = args.indexOf("--agent");
  const agent = agentFlag >= 0 ? args[agentFlag + 1] : undefined;
  const onceFlag = args.includes("--once");

  if (agent) {
    const config = loadConfig();
    config.agent = agent;
    saveConfig(config);
  }

  await startMaster({ budgetLimit, model, once: onceFlag });
}

// ── PROCESS ──

async function handleProcess(args: string[]) {
  const { startMaster } = await import("./v2/master");
  const budgetFlag = args.indexOf("--budget");
  const budgetLimit = budgetFlag >= 0 ? parseInt(args[budgetFlag + 1], 10) : undefined;
  const modelFlag = args.indexOf("--model");
  const model = modelFlag >= 0 ? args[modelFlag + 1] : undefined;
  const onceFlag = args.includes("--once");
  await startMaster({ budgetLimit, model, once: onceFlag });
}

// ── HEALTH ──

async function handleHealth(args: string[]) {
  const updatePlan = args.includes("--update-plan");
  const jsonOnly = args.includes("--json");
  const strict = args.includes("--strict");
  const runGan = args.includes("--gan");

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

  if (strict && r.status !== 0) process.exit(1);
}

// ── DEFAULT ──

async function handleDefault() {
  const { existsSync } = require("node:fs");
  const { join } = require("node:path");
  const { getSerfDir } = require("./v2/paths");
  const serfDir = getSerfDir();

  if (!existsSync(serfDir)) {
    console.log("\n  No .serf/ folder in this project. Run: serf init\n");
    return;
  }

  await handleBoard([]);
}

// ── PROVIDERS ──

async function handleProviders(args: string[]) {
  const { detectProviders, providerInstructions } = require("./v2/providers");
  const providers = await detectProviders();

  console.log("\n  Available providers:");
  for (const p of providers) {
    const marker = p.reachability === "available" ? "✓" : p.reachability === "needs-auth" ? "⚠" : "✗";
    const detail = p.error ? ` — ${p.error}` : "";
    const models = p.models ? ` (${p.models.slice(0, 3).join(", ")}${p.models.length > 3 ? ", ..." : ""})` : "";
    console.log(`    ${marker} ${p.label}${models}${detail}`);
  }

  if (args[0] === "set" && args[1]) {
    const { loadConfig, saveConfig } = require("./state");
    const { defaultModelForProvider } = require("./v2/providers");
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
}

// ── CONFIG ──

function handleConfig(args: string[]) {
  const { loadConfig, saveConfig } = require("./state");

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
      console.log("Keys: agent, terminal, model, backend, transport, provider, endpoint, apiKey");
      process.exit(1);
    }
    const config = loadConfig();
    config[key] = value;
    saveConfig(config);
    console.log(`\n  ✓ ${key} = ${value}\n`);
    return;
  }

  console.log("Usage: serf config [show|set <key> <value>]");
}

// ── AGENTS ──

function handleAgents(args: string[]) {
  const { loadConfig, saveConfig } = require("./state");
  const { listAgents } = require("./v2/executor");
  const { execSync } = require("node:child_process");
  const agents = listAgents();

  if (args.length === 0 || args[0] === "list") {
    const config = loadConfig();
    const current = config?.agent ?? "claude";

    console.log("\n  Available agents:");
    for (const name of agents) {
      let installed = "✗";
      try {
        execSync(`which ${name}`, { stdio: "ignore" });
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

function printHelp() {
  console.log(`
SERF — dark factory for coding agents

USAGE:
  serf .                             Init (if needed) and start in current project
  serf .                             Init (if needed) and start in current project
  serf init                          Create .serf/ in current project
  serf task "do something"           Add a task to the board
  serf start                         Launch master agent — surveys project, talks with you, processes tasks
  serf process [--once] [--budget N] Run the board loop in headless mode
  serf board                         Show the kanban board
  serf agents [list|use <name>]      List or select coding agent
  serf providers [set <name>]        List or set LLM provider
  serf config [show|set <k> <v>]     Show or set config
  serf health [--gan] [--strict]     Run build + test + typecheck (+ GAN)
  serf board move <id> <column>      Move a card between columns

PROVIDERS:
  serf supports any LLM backend you can reach:
  - Ollama (local):      ollama pull <model>; ollama serve
  - vLLM / OpenAI-proxy: start server; serf config set endpoint http://localhost:8000/v1
  - Anthropic API:       ANTHROPIC_API_KEY=... serf config set provider anthropic
  - OpenAI:              OPENAI_API_KEY=... serf config set provider openai
  - Claude Code CLI:       claude /login; serf config set agent claude
  - Claude Desktop:      use an MCP server to expose it to serf

  The project config (.serf/config.json) holds provider, model, endpoint, apiKey.
  Serf picks the best available provider during init if none is configured.

INTERACTIVE MODE:
  serf .                             The default way to use serf. Initialize if needed, then launch
                                     your coding agent as the master serf. It surveys the project,
                                     shows you what's going on, discusses what to work on, writes the
                                     task to the board, and processes it. After each task it asks
                                     "what's next?"

  serf start                         Same as above, but only starts (does not init).

AGENTS:
  claude, opencode, aider, pi, hermes, codex (headless — run in terminal, capture output)
  cursor, code (interactive — open editor, user works)

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

main().catch(err => {
  console.error("Serf error:", err.message);
  process.exit(1);
});