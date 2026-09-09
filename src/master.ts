import { callLLM, BudgetTracker } from "./llm";
import { critique, parseVerdict, type CriticVerdict } from "./critic";
import { parseVerification, isVerificationGreen, formatVerificationFeedback } from "./verification";
import { matchRoutine, buildRoutinePrompt, readRoutine } from "./routines";
import { recordOutcome } from "./track-record";
import { allocateModel } from "./allocator";
import { p90TurnsForTask } from "./maturity";
import { startScheduler } from "./scheduler";
import { moveCard, writeCard, listCards, addTask, computeFrontier, unblockDependents, type Card } from "./board";
import { appendEvent } from "./events";
import { getSerfDir, ensureDir, getInstanceTmp } from "./paths";
import { loadConfig } from "./state";
import { createCardBudget, trackPhaseUsage, isPhaseOverBudget, formatBudget, getTotalUsage, type CardBudget } from "./budget";
import { createPrdStub, prdExists, syncDecisionsToCard, syncVerificationToCard } from "./prd";
import { buildMasterPrompt, buildPlanAgentPrompt, buildAgentPrompt } from "./prompts";
import { getStateSummary, updateLastSession, addOpenFailure, addLesson } from "./state-file";
import { appendFailureMode, writeTrace, createSkillFolder, getRelevantSkills } from "./skills";
import type { Transport } from "./transport";
import { HeadlessTransport, HerdrTransport, launchCouncil, launchInteractiveMasterConversation, launchCmd } from "./transport";
import { qualifyModel } from "./agent-command";
import { NoopVisibility, HerdrVisibility, type VisibilityLayer } from "./visibility";
import { isHerdrRunning, isHerdrResponding, createWorkspace, listWorkspaces, type PaneInfo } from "./herdr-client";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, symlinkSync, readdirSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";

const MAX_RETRIES = 3;
const IDLE_POLL_MS = 2000;
const EMPTY_BACKOFF_MS = 5000;

let stopping = false;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function requestStop(): void {
  stopping = true;
}

interface SpawnedSerf {
  paneId: string;
  purpose: string;
  agent: string;
  model?: string;
  startTime: number;
}

const spawnedSerfs = new Map<string, SpawnedSerf>();

export interface MasterOptions {
  budgetLimit?: number;
  model?: string;
  agent?: string;
  once?: boolean;
  skipMaster?: boolean;
  transport?: "herdr" | "headless";
  forceRelaunch?: boolean;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export async function startMaster(options: MasterOptions = {}): Promise<void> {
  ensureSeeded();

  const config = loadConfig();
  const budget = new BudgetTracker({
    maxTokensPerHarvest: options.budgetLimit ?? 100_000,
    maxSpendPerHarvest: config?.maxSpendPerHarvest ?? 5.0,
  });
  if (options.agent) config.agent = options.agent;
  if (options.model) config.model = options.model;
  const transportOverride = options.transport;
  let useHerdr = transportOverride
    ? transportOverride === "herdr"
    : isHerdrRunning();
  if (useHerdr) {
    const responding = await isHerdrResponding();
    if (!responding) {
      console.log("  ⚠ herdr socket file exists but server is not responding. Falling back to direct mode.");
      console.log("     Run `herdr` in another terminal to use pane mode.");
      useHerdr = false;
    }
  }

  let herdrWorkspaceId: string | undefined;
  let herdrRootPaneId: string | undefined;
  let serfTabId: string | undefined;
  if (useHerdr) {
    try {
      const existing = await listWorkspaces();
      const serfWs = existing.find((w: any) => w.label === "serf");
      if (serfWs) {
        herdrWorkspaceId = serfWs.workspace_id;
        herdrRootPaneId = serfWs.workspace_id + ":p1";
        console.log(`  → Reusing existing serf workspace ${herdrWorkspaceId}`);
        const tabs = await import("./herdr-client").then(h => h.send("tab.list", { workspace_id: herdrWorkspaceId }));
        const serfTab = tabs?.tabs?.find((t: any) => t.label === "serfs");
        if (serfTab) {
          serfTabId = serfTab.tab_id;
        } else {
          try {
            const newTab = await import("./herdr-client").then(h => h.createTab(herdrWorkspaceId!, "serfs", process.cwd()));
            serfTabId = newTab.tab_id;
          } catch {}
        }
        const { isAgentAlive, sendCommand, labelPane } = await import("./herdr-client");
        const { buildInteractiveInvocation: buildInv } = await import("./agent-command");
        const masterAlive = await isAgentAlive(herdrRootPaneId!);
        if (!masterAlive || options.forceRelaunch) {
          console.log(`  → ${masterAlive ? "Relaunching" : "Master pane is dead. Launching"} ${config?.masterAgent ?? config?.agent ?? "claude"}...`);
          const masterAgent = config?.masterAgent ?? config?.agent ?? "claude";
          const masterModel = config?.masterModel ?? config?.model;
          const inv = buildInv(masterAgent, masterModel);
          let argStr = inv.args.map((a: string) => JSON.stringify(a)).join(" ");
          if (masterAgent === "opencode" && masterModel) {
            const providerModel = qualifyModel(masterModel, config?.provider);
            const fixedInv = buildInv(masterAgent, providerModel);
            argStr = fixedInv.args.map((a: string) => JSON.stringify(a)).join(" ");
          }
          await labelPane(herdrRootPaneId!, "master");
          await sendCommand(herdrRootPaneId!, launchCmd(process.cwd(), inv.command, argStr));
          await new Promise((r) => setTimeout(r, 10_000));
          const masterPromptFile = join(getInstanceTmp(), "master-prompt.md");
          writeFileSync(masterPromptFile, buildMasterPrompt(getStateSummary()));
          await sendCommand(herdrRootPaneId!, `Read ${masterPromptFile} and follow those instructions.`);
          console.log(`  ✓ Master launched.`);
        } else {
          console.log(`  ✓ Master is already running.`);
        }
      } else {
        const ws = await createWorkspace("serf", process.cwd());
        herdrWorkspaceId = ws.workspace_id;
        herdrRootPaneId = ws.workspace_id + ":p1";
        await import("./herdr-client").then(h => h.labelPane(herdrRootPaneId!, "master"));
        try {
          const serfTab = await import("./herdr-client").then(h => h.createTab(herdrWorkspaceId!, "serfs", process.cwd()));
          serfTabId = serfTab.tab_id;
        } catch {}

        const { sendCommand, labelPane } = await import("./herdr-client");
        const { buildInteractiveInvocation: buildInv } = await import("./agent-command");
        const masterAgent = config?.masterAgent ?? config?.agent ?? "claude";
        const masterModel = config?.masterModel ?? config?.model;
        const inv = buildInv(masterAgent, masterModel);
        let argStr = inv.args.map((a: string) => JSON.stringify(a)).join(" ");
        if (masterAgent === "opencode" && masterModel) {
          const providerModel = qualifyModel(masterModel, config?.provider);
          const fixedInv = buildInv(masterAgent, providerModel);
          argStr = fixedInv.args.map((a: string) => JSON.stringify(a)).join(" ");
        }
        await labelPane(herdrRootPaneId!, "master");
        await sendCommand(herdrRootPaneId!, launchCmd(process.cwd(), inv.command, argStr));
        await new Promise((r) => setTimeout(r, 10_000));
        const masterPromptFile = join(getInstanceTmp(), "master-prompt.md");
        writeFileSync(masterPromptFile, buildMasterPrompt(getStateSummary()));
        await sendCommand(herdrRootPaneId!, `Read ${masterPromptFile} and follow those instructions.`);
        console.log(`  ✓ Master launched.`);
      }
    } catch (err) {
      console.log(`  ⚠ herdr workspace failed: ${err instanceof Error ? err.message : String(err)}`);
      console.log("    Falling back to direct mode.");
      useHerdr = false;
    }
  }

  const transport: Transport = useHerdr && herdrWorkspaceId
    ? new HerdrTransport(herdrWorkspaceId, serfTabId, config?.actorAgent ?? config?.agent, config?.actorModel ?? config?.model)
    : new HeadlessTransport(config?.terminal ?? "auto", config?.actorAgent ?? config?.agent, config?.actorModel ?? config?.model);

  const visibility: VisibilityLayer = useHerdr && herdrWorkspaceId ? new HerdrVisibility(serfTabId) : new NoopVisibility();

  console.log("\n  ═══ SERF DARK FACTORY ═══════════════════════");
  console.log(`  ${useHerdr ? "herdr mode" : "direct mode"} | agent: ${config?.agent ?? "claude"} | model: ${options.model ?? config?.model ?? "default"}`);
  console.log("  Loop running. Ctrl+C to stop.\n");

  const stopScheduler = startScheduler();
  const { subscribe } = await import("./events");
  const unsubRoutine = subscribe("routine.due", (e) => {
    const routineName = e.payload?.routine as string | undefined;
    if (!routineName) return;
    const routine = readRoutine(routineName);
    if (!routine) return;
    const title = `${routine.name}: ${routine.description || "recurrent action"}`;
    const existing = listCards().some((c) => c.title === title && c.column !== "done");
    if (existing) return;
    addTask(title, routine.description, `Complete routine: ${routine.name}`, routine.steps.join("; "), [routine.verification]);
    console.log(`  → Routine "${routine.name}" enqueued (${e.payload?.reason ?? "trigger"}).`);
  });

  while (!stopping) {
    const frontier = computeFrontier();
    const inProgress = listCards("in-progress");

    if (frontier.length === 0 && inProgress.length === 0) {
      if (options.once && options.skipMaster) {
        console.log("\n  Board empty. Done.\n");
        break;
      }

      console.log("\n  Board is empty. Launching master + sparring partners...\n");

      const stateSummary = getStateSummary();
      const masterPrompt = buildMasterPrompt(stateSummary);

      const result = await launchCouncil(masterPrompt, {
        cwd: process.cwd(),
        workspaceId: useHerdr ? herdrWorkspaceId : undefined,
        rootPaneId: useHerdr ? herdrRootPaneId : undefined,
        serfTabId: useHerdr ? serfTabId : undefined,
        model: options.model,
      });

      console.log(`  → ${result.output}`);

      const newCards = listCards("backlog");
      if (newCards.length === 0) {
        console.log("\n  No cards written. Exiting so you can add one with `serf task \"...\"`.\n");
        break;
      }

      if (options.once) break;
      await sleep(EMPTY_BACKOFF_MS);
      continue;
    }

    if (budget.isOverBudget()) {
      console.log("\n  ⚠ Budget exceeded. Stopping.\n");
      break;
    }

    for (const card of frontier) {
      if (budget.isOverBudget() || stopping) break;
      await processCard(card, budget, transport, visibility, options.model, herdrWorkspaceId, herdrRootPaneId, serfTabId);
    }

    if (options.once) {
      updateLastSession(`${listCards("done").length} done, ${listCards("review").length} in review.`);
      break;
    }

    await sleep(IDLE_POLL_MS);
  }

  unsubRoutine();
  stopScheduler();
}

async function processCard(
  card: Card,
  budget: BudgetTracker,
  transport: Transport,
  visibility: VisibilityLayer,
  model?: string,
  herdrWorkspaceId?: string,
  herdrRootPaneId?: string,
  serfTabId?: string,
): Promise<void> {
  console.log(`\n  ▶ ${card.title}`);

  const cbudget = createCardBudget(card.budgetLimit);
  console.log(`    → budget:\n${formatBudget(cbudget)}`);

  moveCard(card.id, "in-progress");
  appendEvent("task.started", { card: card.id, title: card.title });

  if (!prdExists(card.id)) {
    createPrdStub(card);
    console.log(`    → prd: .serf/prds/${card.id}.md`);
  }

  const worktreePath = createWorktree(card);
  if (worktreePath) {
    console.log(`    → worktree: ${worktreePath.split("/").slice(-2).join("/")}`);
  }

  const serfBase = worktreePath ? join(worktreePath, ".serf") : getSerfDir();

  let planResult: { ok: boolean; reason?: string } = { ok: false, reason: "no-plan-written" };
  try {
    planResult = await runPlanPhase(card, cbudget, serfBase, transport, worktreePath);
  } catch (err) {
    console.log(`  ⚠ plan phase failed: ${err instanceof Error ? err.message : String(err)}`);
    planResult = { ok: false, reason: "error" };
  }

  if (!planResult.ok) {
    const rejected = planResult.reason === "pass" || planResult.reason === "fail" || planResult.reason === "uncertain";
    card.context = rejected
      ? "Plan rejected by critic. Review plan and acceptance criteria."
      : `Plan phase failed (${planResult.reason ?? "unknown"}). No plan was produced.`;
    syncDecisionsToCard(card, [rejected ? "Plan rejected by critic" : `Plan not produced (${planResult.reason ?? "unknown"})`]);
    writeCard(card);
    moveCard(card.id, "review");
    appendEvent("task.failed", { card: card.id, reason: rejected ? "plan-rejected" : `plan-${planResult.reason ?? "failed"}` });
    if (worktreePath) removeWorktree(card, false);
    return;
  }

  syncDecisionsToCard(card, [`Plan approved for execution`]);
  writeCard(card);

  const handle = await visibility.onTaskStart(card, worktreePath || process.cwd(), herdrWorkspaceId, herdrRootPaneId);
  let result: "done" | "review" = "review";

  try {
    result = await executeWithCritique(card, cbudget, transport, serfBase);
  } catch (err) {
    console.log(`  ⚠ execution failed: ${err instanceof Error ? err.message : String(err)}`);
    moveCard(card.id, "review");
    appendEvent("task.failed", { card: card.id, reason: "execution-error" });
  }

  await visibility.onTaskEnd(handle, { output: "", tokensUsed: 0, ok: result === "done" });
  await cleanupSpawnedSerfsForCard(serfTabId);

  if (result === "review") {
    if (herdrWorkspaceId && herdrRootPaneId) {
      console.log(`    → Actor failed. Spawning a debugger serf to pick it up...`);
      const debugFixed = await runDebugSerf(card, transport, serfBase, herdrWorkspaceId, serfTabId, model);
      if (debugFixed) {
        result = "done";
        card.quality = 0.9;
        card.updatedAt = new Date().toISOString();
        writeCard(card);
        moveCard(card.id, "done");
        appendEvent("task.completed", { card: card.id, via: "debug-serf", quality: 0.9 });
      } else {
        console.log(`    → Debugger serf could not fix it. Filing an issue for a software/master serf...`);
        fileIssue(card);
      }
    } else {
      console.log(`    → No debug transport. Filing an issue for a software/master serf...`);
      fileIssue(card);
    }
  }

  if (worktreePath) {
    removeWorktree(card, result === "done");
    console.log(`    → worktree ${result === "done" ? "merged" : "discarded"}`);
  }
}

function fileIssue(card: Card): void {
  const issueTitle = `[issue] ${card.title}`;
  const existing = listCards().some((c) => c.title === issueTitle && c.column !== "done");
  if (existing) return;
  addTask(
    issueTitle,
    `This task failed review and needs a more skilled serf. Original: \n${card.title}\n\n${card.task}\n\nContext: ${card.context ?? "see history"}`,
    `Resolve the root cause of: ${card.title}`,
    `Investigate the failure, fix the underlying issue, and verify it passes the acceptance criteria`,
    card.acceptance,
    `Filed as an issue because the actor (and a debugger serf) could not resolve it. See events for the failure trace.`,
    "software",
  );
  appendEvent("issue.filed", { card: card.id, title: card.title });
  addOpenFailure(`${card.title}: filed as issue for software serf`);
  console.log(`    → Issue filed: ${issueTitle} (assigned @software)`);
}

async function runPlanPhase(
  card: Card,
  cbudget: CardBudget,
  serfBase: string,
  transport: Transport,
  worktreePath: string | null,
): Promise<{ ok: boolean; reason?: string }> {
  const planPath = join(serfBase, "board", "in-progress", `${card.id}-plan.md`);
  const actorIdentity = readSerfSafe("actor");
  const planPrompt = buildPlanAgentPrompt(card, actorIdentity);

  const execResult = await transport.run(planPrompt, {
    cwd: worktreePath || process.cwd(),
    timeoutMs: 120_000,
    outputFile: planPath,
    label: `plan | ${card.title.slice(0, 30)}`,
  });

  trackPhaseUsage(cbudget, "plan", estimateTokens(execResult.output));

  const planWritten = existsSync(planPath) && readFileSync(planPath, "utf-8").trim().length > 0;

  if (!execResult.ok || isPhaseOverBudget(cbudget, "plan")) {
    console.log(`    ⚠ plan phase failed or over budget`);
    return { ok: false, reason: execResult.ok ? "budget" : "no-plan-written" };
  }

  if (!planWritten) {
    console.log(`    ⚠ plan agent produced no plan file.`);
    return { ok: false, reason: "no-plan-written" };
  }

  const plan = readFileSync(planPath, "utf-8");
  const { verdict, tokensUsed } = await critiquePlanSimple(card, plan);
  trackPhaseUsage(cbudget, "plan", tokensUsed);
  console.log(`    → plan critique: ${verdict.verdict} (${verdict.reasoning})`);
  return { ok: verdict.verdict === "pass", reason: verdict.verdict };
}

async function critiquePlanSimple(card: Card, plan: string): Promise<{ verdict: CriticVerdict; tokensUsed: number }> {
  const { detectProjectType } = await import("./capabilities");
  const projectType = detectProjectType(process.cwd());

  const criteria = projectType === "docs"
    ? [
        "Addresses every acceptance criterion with a concrete step.",
        "Names the deliverable document(s) with version and date.",
        "Includes a verification step (file exists, content check, or git diff).",
        "Identifies risky or uncertain steps.",
        "Feasible for a single agent to execute.",
      ]
    : [
        "Addresses every acceptance criterion with a concrete step.",
        "Names files that will be created or modified.",
        "Includes a verification step (test, build, lint, typecheck).",
        "Identifies risky or uncertain steps.",
        "Feasible for a single coding agent to execute.",
      ];

  const prompt = `You are a plan critic. Decide whether the plan is good enough to execute.

A plan must satisfy ALL to pass:
${criteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}

TASK:
${card.task}

GOAL:
${card.goal}

ACCEPTANCE CRITERIA:
${card.acceptance.map((a, i) => `${i + 1}. ${a}`).join("\n")}

PLAN TO EVALUATE:
${plan.slice(0, 3000)}

Respond EXACTLY:
VERDICT: pass | fail | uncertain
CONFIDENCE: 0.0 to 1.0
REASONING: [specific problems or confirmation]`;

  const result = await callLLM(prompt, { maxTokens: 512, useCriticModel: true });
  const verdict = parseVerdict(result.text);
  return { verdict, tokensUsed: result.tokensUsed };
}

function readSerfSafe(name: string): any {
  try {
    const { readSerf } = require("./serf");
    return readSerf(name) ?? { name, mission: "", persona: "", lever: [], measurement: [], fate: "" };
  } catch {
    return { name, mission: "", persona: "", lever: [], measurement: [], fate: "" };
  }
}

async function executeWithCritique(
  card: Card,
  cbudget: CardBudget,
  transport: Transport,
  serfBase: string,
): Promise<"done" | "review"> {
  const actorIdentity = readSerfSafe("actor");
  const outputPath = join(serfBase, "board", "in-progress", `${card.id}-output.md`);

  const routine = matchRoutine(card.title);
  if (routine) {
    console.log(`    → Routine matched: ${routine.name} (${routine.parallel ? "parallel" : "sequential"})`);
    appendEvent("routine.matched", { card: card.id, routine: routine.name });
  }

  const basePrompt = routine
    ? buildRoutinePrompt(routine, card)
    : buildAgentPrompt(card, actorIdentity, "", 1);

  const config = loadConfig();
  const selfCorrectTurns = config?.selfCorrectTurns ?? 3;
  const maxStallTurns = config?.maxStallTurns ?? 6;
  const adaptiveStallTurns = p90TurnsForTask(card.title) ?? maxStallTurns;
  let previousFeedback = "";
  let lastFailedCriteria: string[] = [];
  let lastActorModel = config?.model ?? "unknown";
  let lastTurnsUsed: number | undefined;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    console.log(`    → Attempt ${attempt}: actor working...`);

    const actorModel = allocateModel(card, attempt, attempt - 1);
    lastActorModel = actorModel;
    const prompt = attempt === 1 ? basePrompt : `${basePrompt}\n\n${previousFeedback}`;
    let runResult = await transport.run(prompt, {
      cwd: process.cwd(),
      timeoutMs: 600_000,
      outputFile: outputPath,
      label: `actor: ${card.title.slice(0, 30)}`,
      model: actorModel,
      maxStallTurns: adaptiveStallTurns,
    });
    lastTurnsUsed = runResult.turnsUsed;
    trackPhaseUsage(cbudget, "execution", runResult.tokensUsed);

    if (!runResult.ok || isPhaseOverBudget(cbudget, "execution")) {
      console.log(`    ⚠ execution phase failed or over budget`);
      appendEvent("task.retry", { card: card.id, attempt, issues: ["execution failure or budget"] });
      continue;
    }

    console.log(`    → ${runResult.output.length} chars`);

    let verification = parseVerification(runResult.output);
    let green = isVerificationGreen(verification);

    if (green) {
      console.log(`    ✓ Verification green (exit ${verification.exitCode}): ${verification.command ?? "(unknown)"}`);
      appendEvent("verification.green", { card: card.id, attempt, command: verification.command, exitCode: verification.exitCode });
    } else {
      console.log(`    ⚠ Verification not green: ${verification.present ? `exit ${verification.exitCode}` : "no verification reported"}`);
      appendEvent("verification.red", { card: card.id, attempt, present: verification.present });
    }

    for (let turn = 1; !green && turn <= selfCorrectTurns; turn++) {
      if (isPhaseOverBudget(cbudget, "execution")) break;
      console.log(`      ↻ Self-correct turn ${turn}/${selfCorrectTurns}...`);
      const fixPrompt = `${prompt}\n\nYour previous attempt did not pass verification. Fix it and re-run the verification command.\n\n${formatVerificationFeedback(verification)}\n\nReport the new result with VERIFICATION_COMMAND, VERIFICATION_EXIT_CODE, VERIFICATION_OUTPUT, and FILES_CHANGED. End with SERF_TASK_DONE.`;
      runResult = await transport.run(fixPrompt, {
        cwd: process.cwd(),
        timeoutMs: 600_000,
        outputFile: outputPath,
        label: `actor: ${card.title.slice(0, 30)} (fix ${turn})`,
        model: actorModel,
        maxStallTurns: adaptiveStallTurns,
      });
      trackPhaseUsage(cbudget, "execution", runResult.tokensUsed);
      if (!runResult.ok) break;
      verification = parseVerification(runResult.output);
      green = isVerificationGreen(verification);
      appendEvent("verification.selfcorrect", { card: card.id, attempt, turn, green });
      if (green) {
        console.log(`      ✓ Self-corrected to green (exit ${verification.exitCode})`);
        appendEvent("verification.green", { card: card.id, attempt, command: verification.command, exitCode: verification.exitCode, selfCorrected: true });
      }
    }

    const { verdict, result } = await critique(card.task, runResult.output, card.acceptance);
    trackPhaseUsage(cbudget, "critic", result.tokensUsed);

    console.log(`    ┌── CRITIC ──────────────────────────`);
    console.log(`    │ Verdict: ${verdict.verdict.toUpperCase()}`);
    console.log(`    │ Confidence: ${(verdict.confidence * 100).toFixed(0)}%`);
    console.log(`    │ Reasoning: ${verdict.reasoning}`);
    console.log(`    └────────────────────────────────────\n`);

    appendEvent("critic.verdict", {
      card: card.id, attempt,
      verdict: verdict.verdict,
      confidence: verdict.confidence,
    });

    const criticPass = verdict.verdict === "pass" && verdict.confidence > 0.7;
    const pass = green && criticPass;

    if (pass) {
      finishCard(card, runResult.output, verdict.confidence, cbudget);
      syncVerificationToCard(card, [
        `Pass: attempt ${attempt}, confidence ${(verdict.confidence * 100).toFixed(0)}%`,
        `Verification: ${verification.command ?? "(unknown)"} exit ${verification.exitCode}`,
      ]);
      writeCard(card);
      appendEvent("task.completed", { card: card.id, quality: verdict.confidence, attempt });
      console.log(`    ✓ Completed (confidence ${(verdict.confidence * 100).toFixed(0)}%)\n`);
      addLesson(`"${card.title}" completed on attempt ${attempt}.`);
      recordOutcome({
        cardId: card.id,
        title: card.title,
        model: actorModel,
        agent: config?.agent ?? "unknown",
        outcome: "pass",
        attempts: attempt,
        failedCriteria: [],
        routine: routine?.name,
        turnsUsed: lastTurnsUsed,
        ts: new Date().toISOString(),
      });
      return "done";
    }

    const failedCriteria = verdict.issues.filter((i) => i.startsWith("FAILED:")).map((i) => i.replace(/^FAILED:\s*/, ""));
    lastFailedCriteria = failedCriteria;
    previousFeedback = `CRITIC FEEDBACK (attempt ${attempt} was ${verdict.verdict}):\nIssues: ${verdict.issues.join("; ")}\nReasoning: ${verdict.reasoning}\n\n${formatVerificationFeedback(verification)}\n\nAddress each issue with concrete evidence and file paths.`;
    appendEvent("task.retry", { card: card.id, attempt, issues: verdict.issues });

    if (verdict.confidence <= 0.7 && attempt >= 2) {
      console.log(`    ⚠ Low confidence after ${attempt} attempts. Escalating.`);
      break;
    }
  }

  console.log(`    ✗ Failed ${MAX_RETRIES}x. Moved to review.`);
  moveCard(card.id, "review");
  appendEvent("task.failed", { card: card.id, reason: "max-retries", attempts: MAX_RETRIES });
  addOpenFailure(`${card.title}: max retries exceeded`);
  syncVerificationToCard(card, [
    `Fail: max ${MAX_RETRIES} attempts`,
    `Issues: ${lastFailedCriteria.join("; ") || "see card for details"}`,
  ]);
  writeCard(card);
  recordOutcome({
    cardId: card.id,
    title: card.title,
    model: lastActorModel,
    agent: config?.agent ?? "unknown",
    outcome: "fail",
    attempts: MAX_RETRIES,
    failedCriteria: lastFailedCriteria,
    routine: routine?.name,
    turnsUsed: lastTurnsUsed,
    ts: new Date().toISOString(),
  });
  const skillName = card.title.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter((w) => w.length > 2).slice(0, 3).join("-");
  createSkillFolder(skillName, `Auto-created from failed task: ${card.title}`);
  writeTrace(skillName, `${card.id}-final`, `# Trace: ${card.title}\n\n## Task\n${card.task}\n\n## What went wrong\n${previousFeedback}\n`);
  appendFailureMode(skillName, previousFeedback);
  return "review";
}

function finishCard(card: Card, output: string, quality: number, cbudget: CardBudget): void {
  card.context = output.slice(0, 2000);
  card.quality = quality;
  card.budgetUsed = getTotalUsage(cbudget);
  card.feedback = null;
  card.updatedAt = new Date().toISOString();
  writeCard(card);
  moveCard(card.id, "done");
  const unblocked = unblockDependents(card.id);
  if (unblocked.length > 0) {
    console.log(`    → Unblocked ${unblocked.length} dependent card(s): ${unblocked.map(c => c.title).join(", ")}`);
  }
}

function ensureSeeded(): void {
  const serfDir = getSerfDir();
  ensureDir(serfDir);

  const planPath = join(serfDir, "plan.md");
  if (!existsSync(planPath)) {
    writeFileSync(planPath, "# Plan\n\nThe mission and current direction.\n\n## Fog of war\n<!-- Decisions coming but can't ticket yet. Graduates into cards as the frontier advances. -->\n");
  }

  for (const dir of [
    "board/backlog", "board/in-progress", "board/review", "board/done",
    "prds",
    "serfs", "knowledge/skills", "knowledge/patterns", "knowledge/failures", "knowledge/references",
    "events", "worktrees", "tmp", "trajectories",
    "workspaces/actor/.serf", "workspaces/critic/.serf", "workspaces/critic/.serf/verdicts",
    "routines", "knowledge/track-record",
    "data", "data/credentials",
  ]) {
    ensureDir(join(serfDir, dir));
  }

  cleanTmp();
}

function cleanTmp(): void {
  // Clean only this instance's scratch dir, not the shared tmp root (which
  // holds other instances' dirs and the scheduler state).
  const tmpDir = getInstanceTmp();
  if (!existsSync(tmpDir)) return;
  try {
    for (const f of readdirSync(tmpDir)) {
      try { unlinkSync(join(tmpDir, f)); } catch {}
    }
  } catch {}
}

function createWorktree(card: Card): string | null {
  const serfDir = getSerfDir();
  const worktreePath = join(serfDir, "worktrees", card.id);
  try {
    execSync(`git worktree add "${worktreePath}" HEAD 2>/dev/null`, { stdio: "pipe" });
    const serfLink = join(worktreePath, ".serf");
    if (!existsSync(serfLink)) {
      symlinkSync(serfDir, serfLink);
    }
    return worktreePath;
  } catch {
    return null;
  }
}

function removeWorktree(card: Card, merge: boolean): void {
  const serfDir = getSerfDir();
  const worktreePath = join(serfDir, "worktrees", card.id);
  if (!existsSync(worktreePath)) return;

  // Kill any process still running inside the worktree before removing it.
  // Otherwise the actor becomes orphaned (CWD points at a deleted dir) and
  // serf waits forever for output that can never arrive.
  try {
    const pids = execSync(`lsof -t +D "${worktreePath}" 2>/dev/null`, { encoding: "utf-8" }).trim().split("\n").filter(Boolean);
    for (const pid of pids) {
      try { process.kill(parseInt(pid, 10), "SIGKILL"); } catch {}
    }
  } catch {}

  if (merge) {
    try {
      execSync(`git add -A && git commit -m "serf: ${card.title}" --no-verify`, { cwd: worktreePath, stdio: "pipe" });
      execSync(`git merge --no-ff ${card.id} --no-edit 2>/dev/null`, { stdio: "pipe" });
    } catch {}
  }

  try { execSync(`git worktree remove --force "${worktreePath}"`, { stdio: "pipe" }); } catch {}
  try { execSync(`git branch -D ${card.id} 2>/dev/null`, { stdio: "pipe" }); } catch {}
}

async function runDebugSerf(
  card: Card,
  transport: Transport,
  serfBase: string,
  workspaceId: string,
  serfTabId?: string,
  model?: string,
): Promise<boolean> {
  const config = loadConfig();
  const agentName = config?.spawnAgent ?? config?.agent ?? "pi";
  const serfModel = model ?? config?.actorModel ?? config?.model;
  const relevant = getRelevantSkills(card);

  const debugPrompt = `You are a debugger serf. An actor serf could not complete this task. Debug it and get it passing.
Read the existing output at ${join(serfBase, "board", "in-progress", `${card.id}-output.md`)} to see what was tried.

TASK:
${card.task}

GOAL: ${card.goal}

ACCEPTANCE CRITERIA:
${card.acceptance.map((a) => `- ${a}`).join("\n")}

RELEVANT LESSONS & FAILURE MODES:
${relevant || "(none)"}

Debug the failure. Fix the underlying code so the acceptance criteria are met and the verification command passes. Write your result to ${join(serfBase, "board", "in-progress", `${card.id}-debug.md`)} and end with SERF_TASK_DONE.`;

  try {
    const result = await transport.run(debugPrompt, {
      cwd: process.cwd(),
      timeoutMs: 600_000,
      outputFile: join(serfBase, "board", "in-progress", `${card.id}-debug.md`),
      label: `debug: ${card.title.slice(0, 30)}`,
      model: serfModel,
    });

    const verification = parseVerification(result.output);
    const green = isVerificationGreen(verification);
    const passText = result.output.includes("VERDICT: pass") || result.output.includes("ACCEPTANCE: pass") || green;
    console.log(`    → Debugger serf: ${green ? `green (exit ${verification.exitCode})` : "not green"}`);
    return passText && result.ok;
  } catch (err) {
    console.log(`    ⚠ debug serf failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

async function escalateToMasterCritic(
  card: Card,
  workspaceId: string,
  rootPaneId: string,
  model?: string,
  serfTabId?: string,
): Promise<void> {
  const skillName = card.title.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter((w) => w.length > 2).slice(0, 3).join("-");
  createSkillFolder(skillName, `Failed task: ${card.title}`);

  const tracesDir = join(getSerfDir(), "knowledge", "skills", skillName, "traces");
  let traceSummary = "(no traces)";
  try {
    const traces = readdirSync(tracesDir).map((f) => readFileSync(join(tracesDir, f), "utf-8")).join("\n\n---\n\n");
    traceSummary = traces.slice(0, 3000);
  } catch {}

  const masterPrompt = `You are the master serf. A task has failed multiple times and escalated to you.

## Task that failed
${card.title}
${card.task}

## Acceptance criteria
${card.acceptance.map((a) => `- ${a}`).join("\n")}

## Failure traces
${traceSummary}

## Your job
1. Read the failure traces and understand WHY the task keeps failing.
2. Talk with the critic (in the pane next to you) about the best approach.
3. Write your proposed approach to .serf/tmp/proposed-approach.md.
4. The harness will spawn a serf to execute your approach.

## State from past sessions
${getStateSummary()}`;

  const criticPrompt = `You are the critic serf. A task has failed and escalated to master + critic.

## Task that failed
${card.title}

## Failure traces
${traceSummary}

## Your job
1. Read the traces and evaluate the master's proposed approach.
2. Push back if the approach is vague, won't work, or misses the root cause.
3. If the approach is good, say so. If not, propose a better one.`;

  const result = await launchInteractiveMasterConversation(masterPrompt, criticPrompt, {
    cwd: process.cwd(),
    workspaceId,
    rootPaneId,
    model,
  });

  console.log(`  → ${result.output}`);

  const approachPath = join(getSerfDir(), "tmp", "proposed-approach.md");
  if (!existsSync(approachPath)) {
    console.log(`  → No approach written. Task stays in review.`);
    return;
  }

  const approach = readFileSync(approachPath, "utf-8");
  console.log(`  → Approach written. Spawning skill-serf to execute...`);

  await runSkillSerf(skillName, approach, workspaceId, model, serfTabId);
}

async function runSkillSerf(
  skillName: string,
  approach: string,
  workspaceId: string,
  model?: string,
  serfTabId?: string,
): Promise<void> {
  const config = loadConfig();
  const agentName = config?.spawnAgent ?? config?.agent ?? "pi";
  const serfModel = model ?? config?.actorModel ?? config?.model;

  const { splitPane, splitPaneInTab, createTab, sendCommand, labelPane, waitForAgentExit, closePane } = await import("./herdr-client");
  let pane: PaneInfo;
  if (serfTabId) {
    pane = await splitPaneInTab(serfTabId, "right", `serf: ${skillName}`);
  } else {
    try {
      const tab = await createTab(workspaceId, `serfs`);
      pane = await splitPaneInTab(tab.tab_id, "right", `serf: ${skillName}`);
    } catch {
      pane = await splitPane(workspaceId, "down", `skill-serf: ${skillName}`);
    }
  }
  const paneId = pane.pane_id;
  spawnedSerfs.set(paneId, { paneId, purpose: `serf:${skillName}`, agent: agentName, model: serfModel, startTime: Date.now() });

  const approachFile = join(getSerfDir(), "tmp", "proposed-approach.md");
  writeFileSync(approachFile, approach);

  const { buildInteractiveInvocation } = await import("./agent-command");
  const invocation = buildInteractiveInvocation(agentName, serfModel);
  const argStr = invocation.args.map((a) => JSON.stringify(a)).join(" ");

  const { reportAgentState } = await import("./herdr-client");
  await reportAgentState(paneId, agentName, "working", `serf: ${skillName}`).catch(() => {});

  await sendCommand(paneId, launchCmd(process.cwd(), invocation.command, argStr));
  await new Promise((r) => setTimeout(r, 10_000));
  await sendCommand(paneId, `Read ${approachFile} and execute the proposed approach. Write code to .serf/knowledge/skills/${skillName}/src/ and tests alongside. Run bun test in that folder. If tests pass, write "BUILDING_BLOCK_READY" to .serf/tmp/skill-result.md. If you can't complete it, write a failure trace to .serf/tmp/skill-result.md with FAILURE_REASON. NEVER install globally.`);

  console.log(`  → Serf launched in serfs tab. Waiting for result...`);

  const resultPath = join(getSerfDir(), "tmp", "skill-result.md");
  const { watch } = await import("node:fs");
  const { dirname } = await import("node:path");

  await new Promise<void>((resolve) => {
    let done = false;

    function check(): boolean {
      if (existsSync(resultPath)) {
        done = true;
        resolve();
        return true;
      }
      return false;
    }

    if (check()) return;

    try {
      const watcher = watch(dirname(resultPath), (_eventType, filename) => {
        if (filename === "skill-result.md" && !done) {
          setTimeout(() => { if (check()) { /* resolved */ } }, 500);
        }
      });
      watcher.on("error", () => { if (!done) { done = true; resolve(); } });
    } catch {}
  });

  spawnedSerfs.delete(paneId);
  try { await closePane(paneId); } catch {}

  if (!existsSync(resultPath)) {
    console.log(`  → No result from serf.`);
    return;
  }

  const result = readFileSync(resultPath, "utf-8");
  if (result.includes("BUILDING_BLOCK_READY")) {
    console.log(`  → Building block ready. Running test gate...`);
    const skillSrcDir = join(getSerfDir(), "knowledge", "skills", skillName, "src");
    try {
      execSync("bun test", { cwd: skillSrcDir, encoding: "utf-8", stdio: "pipe", timeout: 60_000 });
      console.log(`  → Skill tests pass. Promoting building block.`);
      const { addBuildingBlock } = await import("./state-file");
      addBuildingBlock(`${skillName}/src/`);
      addLesson(`Building block promoted: ${skillName}`);
      const { resolveOpenFailure } = await import("./state-file");
      resolveOpenFailure(skillName);
    } catch {
      console.log(`  → Skill tests failed. Back to review.`);
      addOpenFailure(`${skillName}: skill-serf tests failed`);
    }
  } else {
    console.log(`  → Skill-serf could not complete. Back to review.`);
    addOpenFailure(`${skillName}: skill-serf failed — ${result.slice(0, 200)}`);
  }

  try { unlinkSync(resultPath); } catch {}
}

async function cleanupSpawnedSerfsForCard(serfTabId?: string): Promise<void> {
  if (!serfTabId) return;
  const { closePane } = await import("./herdr-client");
  for (const [paneId, serf] of spawnedSerfs.entries()) {
    if (serf.purpose.startsWith("serf:")) {
      spawnedSerfs.delete(paneId);
      try { await closePane(paneId); } catch {}
    }
  }
}