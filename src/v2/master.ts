import { callLLM, BudgetTracker } from "./llm";
import { critique, isPass, isHighConfidenceFail, type CriticVerdict } from "./critic";
import { addTask, readCard, moveCard, writeCard, listCards, type Card } from "./board";
import { readSerf, listSerfs, createSerf, morphSerf, MASTER_IDENTITY, type SerfIdentity } from "./serf";
import { appendEvent } from "./events";
import * as herdr from "./herdr";

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

  const useHerdr = options.useHerdr ?? herdr.isHerdrRunning();

  if (useHerdr && !herdr.isHerdrRunning()) {
    console.log("\n  ⚠ herdr socket not found. Install herdr: curl -fsSL https://herdr.dev/install.sh | sh");
    console.log("  Falling back to direct LLM mode.\n");
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
    await processCard(card, budget, options.model, useHerdr && herdr.isHerdrRunning());
  }
}

async function processCard(card: Card, budget: BudgetTracker, model?: string, useHerdr = false): Promise<void> {
  console.log(`\n  ▶ ${card.title}`);

  moveCard(card.id, "in-progress");
  appendEvent("task.started", { card: card.id, title: card.title });

  if (useHerdr) {
    await processWithHerdr(card, budget, model);
  } else {
    await processWithLLM(card, budget, model);
  }
}

async function processWithHerdr(card: Card, budget: BudgetTracker, model?: string): Promise<void> {
  try {
    const ws = await herdr.createWorkspace(card.title.slice(0, 40), process.cwd());
    const executorPane = await herdr.splitPane(ws.workspace_id, "right");
    const criticPane = await herdr.splitPane(ws.workspace_id, "down");

    let attempt = 0;
    let lastFeedback = "";

    while (attempt < MAX_RETRIES) {
      attempt++;

      const executorPrompt = buildExecutionPrompt(card, lastFeedback, attempt);
      const executorSystem = buildMasterSystemPrompt();

      await herdr.sendKeys(executorPane.pane_id, [executorPrompt, "enter"]);
      const executorState = await herdr.waitForState(executorPane.pane_id, "done", 180_000);

      if (executorState === "blocked") {
        console.log(`    ⚠ Executor blocked on attempt ${attempt}`);
        lastFeedback = "The executor was blocked. Simplify the task.";
        continue;
      }

      const executorOutput = await herdr.readPane(executorPane.pane_id, 200);

      const result = await callLLM(executorOutput, { budgetTracker: budget, model });
      const { verdict } = await critique(card.task, result.text, card.acceptance);

      console.log(`    Critic: ${verdict.verdict} (${verdict.confidence.toFixed(2)})`);

      if (isPass(verdict)) {
        finishCard(card, result.text, verdict.verdict === "pass" ? verdict.confidence : 0.5, budget);
        appendEvent("task.completed", { card: card.id, quality: verdict.confidence, attempt });
        console.log(`    ✓ Completed (quality: ${(verdict.confidence * 100).toFixed(0)}%)\n`);
        await herdr.closeWorkspace(ws.workspace_id);
        return;
      }

      lastFeedback = `Previous attempt rejected. Issues: ${verdict.issues.join(", ")}. ${verdict.reasoning}`;
      appendEvent("task.retry", { card: card.id, attempt, issues: verdict.issues });
    }

    moveCard(card.id, "review");
    appendEvent("task.failed", { card: card.id, reason: "max-retries", attempts: attempt });
    console.log(`    ✗ Failed after ${MAX_RETRIES} attempts.\n`);
    await herdr.closeWorkspace(ws.workspace_id);
  } catch (err) {
    console.log(`    ⚠ herdr error: ${err instanceof Error ? err.message : String(err)}. Falling back to LLM mode.`);
    await processWithLLM(card, budget, model);
  }
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
- Code task → be precise, test assumptions, handle edge cases

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