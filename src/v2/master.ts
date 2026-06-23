import { callLLM, BudgetTracker } from "./llm";
import { critique, isPass, isHighConfidenceFail, type CriticVerdict } from "./critic";
import { addTask, readCard, moveCard, writeCard, listCards, type Card } from "./board";
import { readSerf, listSerfs, createSerf, morphSerf, MASTER_IDENTITY, type SerfIdentity } from "./serf";
import { appendEvent } from "./events";
import * as herdr from "./herdr";
import { loadConfig } from "../state";

const MAX_RETRIES = 3;

export interface MasterOptions {
  budgetLimit?: number;
  model?: string;
  useHerdr?: boolean;
}

export async function startMaster(options: MasterOptions = {}): Promise<void> {
  ensureSeeded();

  const budget = new BudgetTracker({
    maxTokensPerHarvest: options.budgetLimit ?? 100_000,
    costPerToken: 0.00001,
    maxSpendPerHarvest: 5.0,
  });

  const herdrRunning = herdr.isHerdrRunning();
  const useHerdr = options.useHerdr ?? herdrRunning;

  if (useHerdr && !herdrRunning) {
    console.log("\n  ⚠ herdr socket not found. Falling back to direct LLM mode.\n");
  }

  if (useHerdr && herdrRunning) {
    console.log("  (herdr detected — will spawn panes for executor + critic)");
  } else {
    console.log("  (direct LLM mode — no herdr)");
  }

  const inProgress = listCards("in-progress");
  const backlog = listCards("backlog");

  if (inProgress.length === 0 && backlog.length === 0) {
    console.log("\n  No tasks on the board. Add one with: serf task \"do something\"\n");
    return;
  }

  const cards = [...inProgress, ...backlog];

  for (const card of cards) {
    if (budget.isOverBudget()) {
      console.log("\n  ⚠ Budget exceeded. Remaining tasks deferred.\n");
      break;
    }
    await processCard(card, budget, options.model, useHerdr && herdrRunning);
  }
}

async function processCard(card: Card, budget: BudgetTracker, model?: string, useHerdr = false): Promise<void> {
  console.log(`\n  ▶ ${card.title}`);

  moveCard(card.id, "in-progress");
  appendEvent("task.started", { card: card.id, title: card.title });

  let herdrMode = useHerdr;

  if (herdrMode) {
    try {
      await processWithHerdr(card, budget, model);
      return;
    } catch (err) {
      console.log(`  ⚠ herdr mode failed: ${err instanceof Error ? err.message : String(err)}`);
      console.log(`  Falling back to direct LLM mode.\n`);
      herdrMode = false;
    }
  }

  if (!herdrMode) {
    await processWithLLM(card, budget, model);
  }
}

async function processWithHerdr(card: Card, budget: BudgetTracker, model?: string): Promise<void> {
  const config = loadConfig();
  const agentModel = model || config?.model || "qwen3.5";
  const transport = config?.transport || "ollama";

  // Create a workspace for this task
  const ws = await herdr.createWorkspace(card.title.slice(0, 40), process.cwd());
  console.log(`  → herdr workspace: ${ws.workspace_id}`);

  // Determine which agent command to run in panes
  // For ollama: use `ollama run <model>` and pipe the prompt
  // For pi: use `pi --model <model>`
  // For claude: use `claude --model <model>`
  let agentCmd: string;
  let agentArgs: string[];
  if (transport === "ollama") {
    agentCmd = "ollama";
    agentArgs = ["run", agentModel];
  } else if (transport === "pi") {
    agentCmd = "pi";
    agentArgs = ["--model", agentModel, "--no-skills", "--no-extensions"];
  } else if (transport === "claude") {
    agentCmd = "claude";
    agentArgs = ["--model", agentModel];
  } else {
    agentCmd = transport;
    agentArgs = ["--model", agentModel];
  }

  // Start executor agent in a pane
  const executorPane = await herdr.startAgent("executor", agentCmd, agentArgs, {
    workspaceId: ws.workspace_id,
    cwd: process.cwd(),
    split: "right",
  });
  console.log(`  → executor pane: ${executorPane.pane_id} (${agentCmd} ${agentArgs.join(" ")})`);

  // Start critic agent in a pane — same model, different role
  const criticPane = await herdr.startAgent("critic", agentCmd, agentArgs, {
    workspaceId: ws.workspace_id,
    cwd: process.cwd(),
    split: "down",
  });
  console.log(`  → critic pane: ${criticPane.pane_id}`);

  let attempt = 0;
  let lastFeedback = "";

  while (attempt < MAX_RETRIES) {
    attempt++;

    const executorPrompt = buildExecutionPrompt(card, lastFeedback, attempt);

    // Send the task to the executor pane
    await herdr.reportAgentState(executorPane.pane_id, "executor", "working", `attempt ${attempt}`);
    await herdr.sendInput(executorPane.pane_id, executorPrompt);
    console.log(`    → Sent task to executor (attempt ${attempt})`);

    // Wait for the executor to finish (check herdr state)
    const executorState = await herdr.waitForState(executorPane.pane_id, "done", 300_000);
    console.log(`    → Executor state: ${executorState}`);

    // Read the executor's output from the pane
    const executorOutput = await herdr.readPane(executorPane.pane_id, 200);
    console.log(`    → Read ${executorOutput.length} chars from executor`);

    // Send the output to the critic pane for evaluation
    const criticPrompt = `Evaluate this response to a task.\n\nTASK: ${card.task}\n\nRESPONSE: ${executorOutput.slice(0, 3000)}\n\nRespond with:\nVERDICT: pass | fail\nCONFIDENCE: 0.0 to 1.0\nISSUES: comma-separated (or "none")\nREASONING: one sentence`;

    await herdr.reportAgentState(criticPane.pane_id, "critic", "working", "evaluating");
    await herdr.sendInput(criticPane.pane_id, criticPrompt);

    // Wait for critic to finish
    const criticState = await herdr.waitForState(criticPane.pane_id, "done", 120_000);
    const criticOutput = await herdr.readPane(criticPane.pane_id, 50);

    // Parse the critic's verdict from the pane output
    const verdict = parseVerdictFromPane(criticOutput);
    console.log(`    Critic: ${verdict.verdict} (${verdict.confidence.toFixed(2)}) ${verdict.issues.length > 0 ? verdict.issues.join(", ") : ""}`);

    await herdr.reportAgentState(criticPane.pane_id, "critic", "done", verdict.verdict);

    if (isPass(verdict)) {
      const quality = verdict.verdict === "pass" ? verdict.confidence : 0.5;
      finishCard(card, executorOutput, quality, budget);
      appendEvent("task.completed", { card: card.id, quality, attempt });
      console.log(`    ✓ Completed (quality: ${(quality * 100).toFixed(0)}%)\n`);
      console.log(`  → Output visible in herdr pane: ${executorPane.pane_id}`);
      console.log(`  → Critic verdict in herdr pane: ${criticPane.pane_id}`);
      return;
    }

    lastFeedback = `Previous attempt rejected. Issues: ${verdict.issues.join(", ")}. ${verdict.reasoning}`;
    appendEvent("task.retry", { card: card.id, attempt, issues: verdict.issues });
  }

  await herdr.reportAgentState(executorPane.pane_id, "executor", "done", "failed");
  moveCard(card.id, "review");
  appendEvent("task.failed", { card: card.id, reason: "max-retries", attempts: attempt });
  console.log(`    ✗ Failed after ${MAX_RETRIES} attempts. Card moved to review.\n`);
  console.log(`  → Review output in herdr panes: ${executorPane.pane_id}, ${criticPane.pane_id}`);
}

function parseVerdictFromPane(text: string): CriticVerdict {
  const verdictMatch = text.match(/VERDICT:\s*(pass|fail)/i);
  const confidenceMatch = text.match(/CONFIDENCE:\s*([\d.]+)/i);
  const issuesMatch = text.match(/ISSUES:\s*(.+)/i);
  const reasoningMatch = text.match(/REASONING:\s*(.+)/i);

  return {
    verdict: (verdictMatch?.[1]?.toLowerCase() ?? "fail") as "pass" | "fail",
    confidence: confidenceMatch ? parseFloat(confidenceMatch[1]) : 0.5,
    issues: issuesMatch ? issuesMatch[1].split(",").map(s => s.trim()).filter(s => s !== "none" && s.length > 0) : [],
    reasoning: reasoningMatch?.[1]?.trim() ?? "",
  };
}

async function processWithLLM(card: Card, budget: BudgetTracker, model?: string): Promise<void> {
  let attempt = 0;
  let lastVerdict: CriticVerdict | null = null;
  let lastFeedback = "";

  while (attempt < MAX_RETRIES) {
    attempt++;

    const prompt = buildExecutionPrompt(card, lastFeedback, attempt);
    const systemPrompt = buildMasterSystemPrompt();

    const result = await callLLM(prompt, { systemPrompt, budgetTracker: budget, model });

    if (!result.ok) {
      console.log(`    ⚠ LLM failed: ${result.warnings.join(", ")}`);
      if (result.warnings.includes("budget-exceeded")) break;
      continue;
    }

    if (result.warnings.includes("possible-gibberish")) {
      console.log(`    ⚠ Possible gibberish on attempt ${attempt}`);
      lastFeedback = "Previous output was gibberish. Produce clean output.";
      continue;
    }

    console.log(`    → Attempt ${attempt}: ${result.tokensUsed} tokens`);

    const { verdict } = await critique(card.task, result.text, card.acceptance);
    lastVerdict = verdict;

    console.log(`    Critic: ${verdict.verdict} (${verdict.confidence.toFixed(2)}) ${verdict.issues.length > 0 ? verdict.issues.join(", ") : ""}`);

    if (isPass(verdict)) {
      const quality = verdict.verdict === "pass" ? verdict.confidence : 0.5;
      finishCard(card, result.text, quality, budget);
      appendEvent("task.completed", { card: card.id, quality, attempt, tokens: result.tokensUsed });
      console.log(`    ✓ Completed (quality: ${(quality * 100).toFixed(0)}%)\n`);
      return;
    }

    lastFeedback = `Previous attempt rejected. Issues: ${verdict.issues.join(", ")}. ${verdict.reasoning}`;
    appendEvent("task.retry", { card: card.id, attempt, issues: verdict.issues });
  }

  if (lastVerdict && isHighConfidenceFail(lastVerdict)) {
    console.log(`    ✗ Failed after ${MAX_RETRIES} attempts. The task description may be bad.`);
  } else {
    console.log(`    ~ Low confidence. Moved to review.`);
  }
  moveCard(card.id, "review");
  appendEvent("task.failed", { card: card.id, reason: "max-retries", attempts: attempt });
}

function buildMasterSystemPrompt(): string {
  const serfs = listSerfs();
  const serfList = serfs.map(s => `- ${s.name}: ${s.mission}`).join("\n");

  return `You are the Master Serf. You coordinate a dark factory.

Your job: receive a task, execute it by morphing your persona, and produce quality output.

You can morph your approach based on the task:
- Research task → be skeptical, cite sources, verify claims
- Writing task → be clear, structured, concise
- Analysis task → be thorough, show reasoning, consider alternatives
- Design task → be concrete, propose mechanisms, show how it works

Available serfs for reference:
${serfList}

Rules:
- Respond directly with your work. No preamble.
- If you don't know something, say so. Don't hallucinate.
- Quality matters more than length. Be complete but not verbose.
- The GAN critic will review your output. If it fails, you retry with feedback.
- If you fail 3 times, the task description is bad, not you.`;
}

function buildExecutionPrompt(card: Card, feedback: string, attempt: number): string {
  let prompt = `TASK:\n${card.task}\n\nACCEPTANCE CRITERIA:\n${card.acceptance.map(a => `- ${a}`).join("\n")}`;

  if (card.context) {
    prompt += `\n\nCONTEXT (from previous work):\n${card.context}`;
  }

  if (feedback) {
    prompt += `\n\nFEEDBACK FROM PREVIOUS ATTEMPT:\n${feedback}`;
  }

  prompt += `\n\nProduce your best work. This is attempt ${attempt} of ${MAX_RETRIES}.`;

  return prompt;
}

function finishCard(card: Card, output: string, quality: number, budget: BudgetTracker): void {
  card.context = output.slice(0, 2000);
  card.quality = quality;
  card.budgetUsed = budget.getStats().tokensUsed;
  card.feedback = null;
  card.updatedAt = new Date().toISOString();
  writeCard(card);
  moveCard(card.id, "done");
}

function ensureSeeded(): void {
  const { existsSync, mkdirSync, writeFileSync } = require("node:fs");
  const { join } = require("node:path");
  const serfDir = join(process.cwd(), ".serf");

  if (!existsSync(serfDir)) mkdirSync(serfDir, { recursive: true });

  const planPath = join(serfDir, "plan.md");
  if (!existsSync(planPath)) {
    writeFileSync(planPath, "# Plan\n\nThe mission and current direction. Edit this to guide the master serf.\n");
  }

  for (const dir of ["board/backlog", "board/in-progress", "board/review", "board/done", "serfs", "knowledge", "events"]) {
    const p = join(serfDir, dir);
    if (!existsSync(p)) mkdirSync(p, { recursive: true });
  }

  if (!readSerf("master")) {
    createSerf(MASTER_IDENTITY);
  }
}

export { addTask, readCard, moveCard, listCards, writeCard, type Card };
export { createSerf, readSerf, listSerfs, morphSerf, type SerfIdentity };
export { critique, isPass, isHighConfidenceFail, type CriticVerdict };
export { callLLM, BudgetTracker };