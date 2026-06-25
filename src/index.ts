#!/usr/bin/env bun
import { spawnSync } from "node:child_process";

const ARGS = process.argv.slice(2);

async function main() {
  const cmd = ARGS[0];
  const args = ARGS.slice(1);

  switch (cmd) {
    case "init":     handleInit(); return;
    case "task":     await handleTask(args); return;
    case "board":    await handleBoard(args); return;
    case "start":    await handleStart(args); return;
    case "config":   handleConfig(args); return;
    case "agents":   handleAgents(args); return;
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

function handleInit() {
  const { existsSync, mkdirSync, writeFileSync } = require("node:fs");
  const { join } = require("node:path");
  const { getSerfDir } = require("./v2/paths");
  const dir = getSerfDir();

  if (existsSync(dir)) {
    console.log("\n  .serf/ already exists. Use 'serf task' to add work.\n");
    return;
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
  console.log("\n  Next: serf task \"do something\"");
  console.log("  Then: serf start  to process the board\n");
}

// ── TASK ──

async function handleTask(args: string[]) {
  if (args.length === 0) {
    console.log("Usage: serf task \"do something\"");
    process.exit(1);
  }
  const { addTask } = await import("./v2/board");
  const title = args.join(" ");
  const card = addTask(title);
  console.log(`\n  ✓ Task added to backlog: ${card.id}`);
  console.log(`    "${title}"\n`);
  console.log(`  Run: serf start  to begin processing\n`);
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
  const budgetFlag = args.indexOf("--budget");
  const budgetLimit = budgetFlag >= 0 ? parseInt(args[budgetFlag + 1], 10) : undefined;
  const modelFlag = args.indexOf("--model");
  const model = modelFlag >= 0 ? args[modelFlag + 1] : undefined;
  const agentFlag = args.indexOf("--agent");
  const agent = agentFlag >= 0 ? args[agentFlag + 1] : undefined;
  const onceFlag = args.includes("--once");

  if (agent) {
    const { loadConfig, saveConfig } = require("./state");
    const config = loadConfig() ?? { transport: "pi", model: "qwen3.5", backend: "ollama" };
    config.agent = agent;
    saveConfig(config);
  }

  const taskDescription = args.filter(a => !a.startsWith("--")).join(" ");

  if (taskDescription) {
    await interactiveIntake(taskDescription, model);
  }

  await startMaster({ budgetLimit, model, once: onceFlag });
}

// ── INTERACTIVE INTAKE ──

async function interactiveIntake(description: string, model?: string): Promise<void> {
  const { callLLM } = await import("./v2/llm");
  const { addTask } = await import("./v2/board");
  const { existsSync, readdirSync, readFileSync, statSync } = require("node:fs");
  const { join } = require("node:path");
  const { getSerfDir } = await import("./v2/paths");
  const readline = require("readline");

  const serfDir = getSerfDir();
  const cwd = process.cwd();

  const projectFiles = scanProject(cwd);
  const planMd = existsSync(join(serfDir, "plan.md")) ? readFileSync(join(serfDir, "plan.md"), "utf-8").slice(0, 500) : "";
  const knowledgeSkills = listKnowledge(serfDir, "skills");
  const knowledgeFailures = listKnowledge(serfDir, "failures");
  const boardCards = listBoardCards(serfDir);

  const prompt = `You are the master serf for a project. A user wants to add a task: "${description}".

Survey the project and propose a formal task card.

PROJECT STRUCTURE:
${projectFiles}

PLAN:
${planMd}

KNOWLEDGE (skills):
${knowledgeSkills}

PAST FAILURES:
${knowledgeFailures}

CURRENT BOARD:
${boardCards}

Respond with EXACTLY this format:

INTRO: <1-2 sentences: who you are, what the project is, what's going on>
QUESTIONS: <clarifying questions if the task is ambiguous, or "none" if clear>
TASK: <the formal task title — concise, actionable>
ACCEPTANCE: <bullet list, one per line, each starting with "- ", specific and falsifiable>
CONTEXT: <relevant context from the codebase, or "none">`;

  console.log(`\n  Master is surveying the project...`);
  const { text } = await callLLM(prompt, { model });

  const intro = text.match(/INTRO:\s*(.+?)(?=\n(?:QUESTIONS|TASK|ACCEPTANCE|CONTEXT|$$))/s)?.[1]?.trim() ?? "";
  const questions = text.match(/QUESTIONS:\s*(.+?)(?=\n(?:TASK|ACCEPTANCE|CONTEXT|$$))/s)?.[1]?.trim() ?? "";
  const taskTitle = text.match(/TASK:\s*(.+)/)?.[1]?.trim() ?? description;
  const acceptanceBlock = text.match(/ACCEPTANCE:\s*(.+?)(?=\n(?:CONTEXT|$$))/s)?.[1]?.trim() ?? "";
  const context = text.match(/CONTEXT:\s*(.+?)(?:\n$$|$)/s)?.[1]?.trim() ?? "";

  console.log(`\n  ╔══ MASTER SERF ══════════════════════════════`);
  console.log(`  ║ ${intro}`);
  if (questions && questions.toLowerCase() !== "none") {
    console.log(`  ║`);
    console.log(`  ║ Questions:`);
    for (const q of questions.split("\n").filter((l: string) => l.trim())) {
      console.log(`  ║   ${q.trim()}`);
    }
  }
  console.log(`  ║`);
  console.log(`  ║ Proposed task:`);
  console.log(`  ║   Task: ${taskTitle}`);
  console.log(`  ║   Acceptance:`);
  for (const line of acceptanceBlock.split("\n").filter((l: string) => l.trim())) {
    console.log(`  ║     ${line.replace(/^[-*]\s*/, "").trim()}`);
  }
  if (context && context.toLowerCase() !== "none") {
    console.log(`  ║   Context: ${context.slice(0, 200)}`);
  }
  console.log(`  ╚════════════════════════════════════════════\n`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>(resolve => {
    rl.question("  Approve? (y/n) ", a => { rl.close(); resolve(a.trim().toLowerCase()); });
  });

  if (answer === "y" || answer === "yes") {
    const acceptance = acceptanceBlock
      .split("\n")
      .map((l: string) => l.replace(/^[-*]\s*/, "").trim())
      .filter((l: string) => l.length > 0);
    const card = addTask(taskTitle, taskTitle, acceptance.length > 0 ? acceptance : ["GAN critic passes"]);
    console.log(`\n  ✓ Task added to backlog: ${card.id}\n`);
  } else {
    console.log(`\n  Task not added.\n`);
  }
}

function scanProject(cwd: string): string {
  const { readdirSync, statSync, existsSync } = require("node:fs");
  const { join } = require("node:path");

  const lines: string[] = [];
  try {
    const entries = readdirSync(cwd).filter((f: string) => !f.startsWith(".") && f !== "node_modules" && f !== "dist" && f !== "target");
    for (const entry of entries.slice(0, 30)) {
      const full = join(cwd, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        lines.push(`  ${entry}/`);
      } else {
        lines.push(`  ${entry}`);
      }
    }
  } catch {}

  let pkgInfo = "";
  if (existsSync(join(cwd, "package.json"))) {
    try {
      const pkg = JSON.parse(require("node:fs").readFileSync(join(cwd, "package.json"), "utf-8"));
      pkgInfo = `\npackage.json: ${pkg.name ?? "?"} v${pkg.version ?? "?"} — ${pkg.description ?? ""}`.trim();
    } catch {}
  }

  return `Files:\n${lines.join("\n")}${pkgInfo ? "\n\n" + pkgInfo : ""}`;
}

function listKnowledge(serfDir: string, subdir: string): string {
  const { existsSync, readdirSync, readFileSync } = require("node:fs");
  const { join } = require("node:path");
  const dir = join(serfDir, "knowledge", subdir);
  if (!existsSync(dir)) return "none";
  const files = readdirSync(dir).filter((f: string) => f.endsWith(".md")).slice(-5);
  if (files.length === 0) return "none";
  return files.map((f: string) => `- ${f.replace(/\.md$/, "")}`).join("\n");
}

function listBoardCards(serfDir: string): string {
  const { existsSync, readdirSync } = require("node:fs");
  const { join } = require("node:path");
  const cols = ["backlog", "in-progress", "review", "done"];
  const lines: string[] = [];
  for (const col of cols) {
    const dir = join(serfDir, "board", col);
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir).filter((f: string) => f.endsWith(".md"));
    if (files.length > 0) {
      lines.push(`${col} (${files.length}): ${files.map((f: string) => f.replace(/\.md$/, "")).join(", ")}`);
    }
  }
  return lines.length > 0 ? lines.join("\n") : "empty";
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

// ── CONFIG ──

function handleConfig(args: string[]) {
  const { loadConfig, saveConfig } = require("./state");

  if (args.length === 0 || args[0] === "show") {
    const config = loadConfig();
    if (!config) {
      console.log("\n  No config found. Run: serf config set agent claude\n");
      return;
    }
    console.log("\n  Serf Config (~/.serf/config.json):");
    console.log(JSON.stringify(config, null, 2));
    console.log("");
    return;
  }

  if (args[0] === "set") {
    const key = args[1];
    const value = args[2];
    if (!key || value === undefined) {
      console.log("Usage: serf config set <key> <value>");
      console.log("Keys: agent, terminal, model, backend, transport");
      process.exit(1);
    }
    const config = loadConfig() ?? { transport: "pi", model: "qwen3.5", backend: "ollama" };
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
    const config = loadConfig() ?? { transport: "pi", model: "qwen3.5", backend: "ollama" };
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
  serf init                          Create .serf/ in current project
  serf task "do something"           Add a task to the board
  serf start ["task description"]     Process board, or discuss task with master first
  serf board                         Show the kanban board
  serf agents [list|use <name>]      List or select coding agent
  serf config [show|set <k> <v>]     Show or set config
  serf health [--gan] [--strict]     Run build + test + typecheck (+ GAN)
  serf board move <id> <column>      Move a card between columns

INTERACTIVE MODE:
  serf start "add a login page"      Master surveys project, proposes task, you approve
  serf start                         Board empty → master asks "what to work on?"
                                     Task done → master asks "what's next?"
                                     This is the default way to use serf.

AGENTS:
  claude, opencode, aider, pi, hermes, codex (headless — run in terminal, capture output)
  cursor, code (interactive — open editor, user works)

THE PROTOCOL:
  Tell your agent: "Read SERF.md and follow the protocol."
  The agent reads the board, picks up a task, executes, critiques, writes result.

CONFIGURATION:
  ~/.serf/config.json — global config (agent, terminal, model, backend)
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