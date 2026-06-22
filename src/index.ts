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
  const dir = join(process.cwd(), ".serf");

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
  mkdirSync(join(dir, "events"), { recursive: true });

  writeFileSync(join(dir, "plan.md"), "# Plan\n\nThe mission and current direction. Edit this to guide the master serf.\n");

  writeFileSync(join(dir, "serfs", "master.md"), `# master

## Mission
Coordinate the project. Receive tasks, break them down, execute, critique, ensure quality.

## Persona
Decisive, fair, demanding. Expects quality but blames the task when serfs fail.

## Lever
- callLLM for planning and execution
- GAN critic for quality enforcement
- Board for task tracking

## Measurement
- GAN critic pass rate: >70%
- User acceptance rate: >70%

## Fate
Always running. If I fail 3 times, the task description is bad.

## Last State
- Last task: none
- Completed: no
- Context summary: none
- Next step: waiting for assignment
- Timestamp: ${new Date().toISOString()}
`);

  console.log("\n  ✓ .serf/ created in current project");
  console.log("    ├── board/         (backlog, in-progress, review, done)");
  console.log("    ├── serfs/         (master.md created)");
  console.log("    ├── knowledge/     (skills, patterns, failures)");
  console.log("    ├── events/        (audit trail)");
  console.log("    └── plan.md        (edit this with your mission)");
  console.log("\n  Next: serf task \"do something\"");
  console.log("  Then: tell your agent to read SERF.md\n");
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
  await startMaster({ budgetLimit, model });
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
  const serfDir = join(process.cwd(), ".serf");

  if (!existsSync(serfDir)) {
    console.log("\n  No .serf/ folder in this project. Run: serf init\n");
    return;
  }

  await handleBoard([]);
}

// ── HELP ──

function printHelp() {
  console.log(`
SERF — dark factory for coding agents

USAGE:
  serf init                          Create .serf/ in current project
  serf task "do something"           Add a task to the board
  serf board                         Show the kanban board
  serf start                         Master serf processes the board
  serf health [--gan] [--strict]     Run build + test + typecheck (+ GAN)
  serf board move <id> <column>      Move a card between columns

THE PROTOCOL:
  Tell your agent: "Read SERF.md and follow the protocol."
  The agent reads the board, picks up a task, executes, critiques, writes result.

WITH HERDR:
  Install: curl -fsSL https://herdr.dev/install.sh | sh
  Run: herdr
  The master serf spawns panes, checks state, and runs the GAN critic as a separate pane.

CONFIGURATION:
  ~/.serf/config.json — global config (model, backend, transport)
  .serf/plan.md — project mission and direction
  .serf/serfs/ — serf identities (mission/persona/lever/measurement/fate)
`);
}

main().catch(err => {
  console.error("Serf error:", err.message);
  process.exit(1);
});