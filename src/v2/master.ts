import { callLLM, BudgetTracker } from "./llm";
import { critique, classifyVerdict, parseVerdict, type CriticVerdict } from "./critic";
import { critiqueMultipass, classifyMultipass, type MultiPassVerdict, type Effort, type CuriosityPoint, EFFORT_PASSES, type CritiqueFn } from "./critic_multipass";
import { readCard, moveCard, writeCard, listCards, addTask, type Card } from "./board";
import { readSerf, listSerfs, createSerf, type SerfIdentity } from "./serf";
import { appendEvent } from "./events";
import * as herdr from "./herdr";
import { HerdrAgent } from "./herdr";
import { spawnAgent, buildAgentPrompt, buildCriticAgentPrompt, buildCriticFollowupPrompt, buildCriticResolvePrompt } from "./executor";
import { getSerfDir, ensureDir } from "./paths";
import { loadConfig } from "../state";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, watch, readdirSync, statSync, execSync, symlinkSync } from "node:fs";

const MAX_RETRIES = 3;
const AGREEMENT_THRESHOLD = 0.7;
const spawnedSerfs: HerdrAgent[] = [];

export interface MasterOptions {
  budgetLimit?: number;
  model?: string;
  useHerdr?: boolean;
  once?: boolean;
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

  console.log("\n  ═══ SERF DARK FACTORY ═══════════════════════");
  console.log(`  ${useHerdr ? "herdr mode" : "direct mode"} | agent: ${loadConfig()?.agent ?? "claude"} | model: ${options.model ?? loadConfig()?.model ?? "default"}`);
  console.log("  Loop running. Ctrl+C to stop.\n");

  let harness: HerdrHarness | null = null;
  if (useHerdr) {
    harness = await HerdrHarness.create(options.model);
  }

  // Continuous dialogue loop
  while (true) {
    const cards = [...listCards("in-progress"), ...listCards("backlog")];

    if (cards.length === 0) {
      if (options.once) {
        console.log("\n  Board empty. Done.\n");
        break;
      }

      // Survey the project + board, show the user what's going on, then ask
      await projectReview(options.model);
      const taskDescription = await askUser();
      if (taskDescription === null) {
        console.log("\n  Goodbye.\n");
        break;
      }
      if (taskDescription.trim().length > 0) {
        await interactiveIntake(taskDescription, options.model);
      }
      continue;
    }

    if (budget.isOverBudget()) {
      console.log("\n  ⚠ Budget exceeded. Stopping.\n");
      break;
    }

    // Process all ready cards
    for (const card of cards) {
      if (budget.isOverBudget()) break;
      await processCard(card, budget, options.model, useHerdr && herdrRunning, harness);
    }

    if (options.once) break;
    // Loop immediately — check for new cards (the actor may have written subtasks)
  }

  if (harness) await harness.close();
}

// Event-driven wait — watches the backlog directory for new .md files
async function processCard(card: Card, budget: BudgetTracker, model?: string, useHerdr = false, harness?: HerdrHarness | null): Promise<void> {
  console.log(`\n  ▶ ${card.title}`);

  moveCard(card.id, "in-progress");
  appendEvent("task.started", { card: card.id, title: card.title });

  const worktreePath = createWorktree(card);
  if (worktreePath) {
    console.log(`    → worktree: ${worktreePath.split("/").slice(-2).join("/")}`);
  }

  let result: "done" | "review" = "review";

  if (useHerdr && harness) {
    try {
      result = await processWithHerdr(card, budget, harness);
    } catch (err) {
      console.log(`  ⚠ herdr failed: ${err instanceof Error ? err.message : String(err)}`);
      moveCard(card.id, "review");
      appendEvent("task.failed", { card: card.id, reason: "herdr-error" });
    }
  } else {
    result = await processDirect(card, budget, model);
  }

  if (worktreePath) {
    removeWorktree(card, result === "done");
    console.log(`    → worktree ${result === "done" ? "merged" : "discarded"}`);
  }
}

// ── HERDR HARNESS ──

class HerdrHarness {
  workspaceId: string;
  actor: HerdrAgent;
  critic: HerdrAgent | null;

  private constructor(workspaceId: string, actor: HerdrAgent, critic: HerdrAgent | null) {
    this.workspaceId = workspaceId;
    this.actor = actor;
    this.critic = critic;
  }

  static async create(model?: string): Promise<HerdrHarness> {
    const config = loadConfig();
    const agentName = config?.agent ?? "claude";
    const agentModel = model || config?.model;
    const criticAgentName = config?.criticAgent ?? agentName;
    const criticModel = config?.criticModel ?? agentModel;

    const ws = await herdr.createWorkspace("serf-harness", process.cwd());
    console.log(`  → herdr workspace: ${ws.workspace_id}`);

    const rootPaneId = ws.workspace_id + ":p1";
    await herdr.sendCommand(rootPaneId, `echo "╔══ SERF ACTOR (${agentName}) ══╗"`);
    await herdr.sendCommand(rootPaneId, herdr.buildAgentCmd(agentName, agentModel));
    await new Promise(r => setTimeout(r, 5000));
    const actor = HerdrAgent.fromExisting(rootPaneId, "actor", agentName, agentModel);
    console.log(`    → Actor ready (${agentName})`);

    let critic: HerdrAgent | null = null;
    try {
      critic = await HerdrAgent.create(ws.workspace_id, "critic", criticAgentName, criticModel, "right");
      console.log(`    → Critic ready (${criticAgentName})`);
    } catch (err) {
      console.log(`    ⚠ Critic pane unavailable: ${err instanceof Error ? err.message : String(err)}. Using inline critic.`);
    }

    return new HerdrHarness(ws.workspace_id, actor, critic);
  }

  async close(): Promise<void> {
    if (this.critic) await this.critic.close();
  }
}

// ── HERDR MODE ──

async function processWithHerdr(card: Card, budget: BudgetTracker, harness: HerdrHarness): Promise<"done" | "review"> {
  const { actor, critic, workspaceId } = harness;

  let attempt = 0;
  let lastFeedback = "";

  while (attempt < MAX_RETRIES) {
    attempt++;

    const prompt = buildAgentPrompt(card, { name: "actor", mission: "", persona: "", lever: [], measurement: [], fate: "" }, lastFeedback, attempt);

    await actor.send(prompt);
    console.log(`    → Attempt ${attempt}: actor working...`);

    const output = await actor.waitForDone(600_000);
    console.log(`    → ${output.length} chars\n`);

    const { verdict: mpv } = await critiqueWithHerdr(card, output, critic, actor, attempt);
    printMultipassCritic(mpv);

    appendEvent("critic.verdict", {
      card: card.id, attempt,
      verdict: mpv.finalVerdict,
      agreementRate: mpv.agreementRate,
      curiosity: mpv.curiosity,
      passes: mpv.totalPasses,
      curiosityPoints: mpv.curiosityPoints.length,
      criticMode: critic ? "agent-pane" : "inline-llm",
    });

    const outcome = classifyMultipass(mpv, AGREEMENT_THRESHOLD);

    if (outcome === "pass") {
      finishCard(card, output, mpv.agreementRate, budget);
      appendEvent("task.completed", { card: card.id, quality: mpv.agreementRate, attempt });
      console.log(`    ✓ Completed (agreement ${(mpv.agreementRate * 100).toFixed(0)}%)\n`);
      return "done";
    }

    if (outcome === "curiosity") {
      logCuriosityPoints(card, mpv);
      lastFeedback = `Uncertain. Critic disagreement: ${(mpv.curiosity * 100).toFixed(0)}%. Issues: ${mpv.issues.join(", ")}. ${mpv.reasoning}`;
      appendEvent("task.curiosity", { card: card.id, attempt, curiosity: mpv.curiosity, points: mpv.curiosityPoints.map(p => p.criterion) });
      console.log(`    ~ Curiosity ${(mpv.curiosity * 100).toFixed(0)}%. Logged to knowledge. Retrying.\n`);
    } else {
      lastFeedback = `Rejected. Issues: ${mpv.issues.join(", ")}. ${mpv.reasoning}`;
      appendEvent("task.retry", { card: card.id, attempt, issues: mpv.issues });
    }

    if (attempt === 2) await maybeSpawnSerf(card, mpv, workspaceId);
  }

  console.log(`    ✗ Failed ${MAX_RETRIES}x. Moved to review.`);
  moveCard(card.id, "review");
  appendEvent("task.failed", { card: card.id, reason: "max-retries", attempts: attempt });
  return "review";
}

// ── HERDR CRITIC ──

const MAX_DIALOGUE_ROUNDS = 3;

async function critiqueWithHerdr(
  card: Card,
  output: string,
  critic: HerdrAgent | null,
  actor: HerdrAgent,
  attempt: number,
): Promise<{ verdict: MultiPassVerdict; results: any[] }> {
  if (!critic) {
    return critiqueMultipass(card.task, output, card.acceptance);
  }

  const criticPrompt = buildCriticAgentPrompt(card, output, attempt);
  await critic.send(criticPrompt);
  console.log(`    → Critic evaluating...`);

  let criticOutput = await critic.waitForDone(600_000);
  let criticVerdict = parseVerdict(criticOutput);

  appendEvent("critic.pane.verdict", {
    card: card.id, attempt, round: 0,
    verdict: criticVerdict.verdict,
    confidence: criticVerdict.confidence,
    issues: criticVerdict.issues,
  });

  let dialogueRound = 0;
  while (criticVerdict.verdict === "uncertain" && dialogueRound < MAX_DIALOGUE_ROUNDS) {
    dialogueRound++;
    const criticQuestion = extractCriticQuestion(criticOutput);

    if (!criticQuestion) {
      console.log(`    ~ Critic uncertain, no question asked. Bubbling to user.`);
      break;
    }

    console.log(`    → Critic asks actor (round ${dialogueRound}): ${criticQuestion.slice(0, 80)}...`);

    const followupPrompt = buildCriticFollowupPrompt(criticQuestion);
    const actorResponse = await actor.ask(followupPrompt, 300_000);
    console.log(`    → Actor responded (${actorResponse.length} chars)`);

    appendEvent("critic.dialogue", {
      card: card.id, attempt, round: dialogueRound,
      question: criticQuestion.slice(0, 200),
      responseLength: actorResponse.length,
    });

    const resolvePrompt = buildCriticResolvePrompt(actorResponse);
    criticOutput = await critic.ask(resolvePrompt, 300_000);
    criticVerdict = parseVerdict(criticOutput);

    appendEvent("critic.pane.verdict", {
      card: card.id, attempt, round: dialogueRound,
      verdict: criticVerdict.verdict,
      confidence: criticVerdict.confidence,
      issues: criticVerdict.issues,
    });

    console.log(`    → Critic resolved: ${criticVerdict.verdict} (${(criticVerdict.confidence * 100).toFixed(0)}%)`);
  }

  const curiosityNotes = criticVerdict.curiosity ?? [];
  const mpv: MultiPassVerdict = {
    finalVerdict: criticVerdict.verdict,
    agreementRate: criticVerdict.confidence > 0.7 ? criticVerdict.confidence : 0.5,
    curiosity: criticVerdict.verdict === "uncertain" ? 0.5 : 0,
    passCount: criticVerdict.verdict === "pass" ? 1 : 0,
    failCount: criticVerdict.verdict === "fail" ? 1 : 0,
    uncertainCount: criticVerdict.verdict === "uncertain" ? 1 : 0,
    totalPasses: 1,
    effort: "quick",
    verdicts: [criticVerdict],
    curiosityPoints: [],
    curiosityNotes,
    issues: criticVerdict.issues,
    reasoning: criticVerdict.reasoning,
    evidence: criticVerdict.evidence,
  };

  return { verdict: mpv, results: [] };
}

function extractCriticQuestion(criticOutput: string): string | null {
  // Try to find a question in the critic's output
  // Look for lines ending with ? or explicitly marked questions
  const lines = criticOutput.split("\n");
  const questions: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.endsWith("?") && trimmed.length > 10) {
      questions.push(trimmed);
    }
  }

  // Also look for "QUESTION:" prefix
  const questionMatch = criticOutput.match(/QUESTION:\s*(.+?)(?:\n|$)/i);
  if (questionMatch) {
    return questionMatch[1].trim();
  }

  // Return the first question found, or null
  return questions.length > 0 ? questions[0] : null;
}

function extractCuriosityFromVerdict(v: CriticVerdict): CuriosityPoint[] {
  if (!v.criterionAnswers) return [];
  return v.criterionAnswers
    .filter(a => a.answer === "CANNOT_EVALUATE")
    .map(a => ({
      criterion: a.criterion,
      agreement: 0,
      answers: [a.answer] as ("YES" | "NO" | "CANNOT_EVALUATE")[],
    }));
}

// ── DIRECT MODE ──

async function processDirect(card: Card, budget: BudgetTracker, model?: string): Promise<"done" | "review"> {
  const config = loadConfig();
  const agentName = config?.agent ?? "claude";
  console.log(`  → agent: ${agentName}`);

  let attempt = 0;
  let lastFeedback = "";

  while (attempt < MAX_RETRIES) {
    attempt++;

    const prompt = buildAgentPrompt(card, { name: "actor", mission: "", persona: "", lever: [], measurement: [], fate: "" }, lastFeedback, attempt);

    console.log(`    → Spawning ${agentName} (attempt ${attempt})...`);
    const execResult = await spawnAgent(prompt, {
      cwd: process.cwd(),
      timeoutMs: 600_000,
      agent: agentName,
      model: model || config?.model,
    });

    if (!execResult.ok) {
      console.log(`    ⚠ ${execResult.warnings.join(", ")}`);
      lastFeedback = "No output produced. Complete the task.";
      continue;
    }

    console.log(`    → ${execResult.output.length} chars\n`);

    const { verdict: mpv } = await critiqueMultipass(card.task, execResult.output, card.acceptance);
    printMultipassCritic(mpv);

    appendEvent("critic.verdict", {
      card: card.id, attempt,
      verdict: mpv.finalVerdict,
      agreementRate: mpv.agreementRate,
      curiosity: mpv.curiosity,
      passes: mpv.totalPasses,
      curiosityPoints: mpv.curiosityPoints.length,
    });

    const outcome = classifyMultipass(mpv, AGREEMENT_THRESHOLD);

    if (outcome === "pass") {
      finishCard(card, execResult.output, mpv.agreementRate, budget);
      appendEvent("task.completed", { card: card.id, quality: mpv.agreementRate, attempt, agent: execResult.agent });
      console.log(`    ✓ Completed (agreement ${(mpv.agreementRate * 100).toFixed(0)}%)\n`);
      return "done";
    }

    if (outcome === "curiosity") {
      logCuriosityPoints(card, mpv);
      lastFeedback = `Uncertain. Critic disagreement: ${(mpv.curiosity * 100).toFixed(0)}%. Issues: ${mpv.issues.join(", ")}. ${mpv.reasoning}`;
      appendEvent("task.curiosity", { card: card.id, attempt, curiosity: mpv.curiosity, points: mpv.curiosityPoints.map(p => p.criterion) });
      console.log(`    ~ Curiosity ${(mpv.curiosity * 100).toFixed(0)}%. Logged to knowledge. Retrying.\n`);
    } else {
      lastFeedback = `Rejected. Issues: ${mpv.issues.join(", ")}. ${mpv.reasoning}`;
      appendEvent("task.retry", { card: card.id, attempt, issues: mpv.issues });
    }

    if (attempt === 2) await maybeSpawnSerf(card, mpv);
  }

  console.log(`    ✗ Failed ${MAX_RETRIES}x. Moved to review.`);
  moveCard(card.id, "review");
  appendEvent("task.failed", { card: card.id, reason: "max-retries", attempts: attempt });
  return "review";
}

// ── SPAWN FROM FRICTION ──

async function maybeSpawnSerf(card: Card, mpv: MultiPassVerdict, workspaceId?: string): Promise<void> {
  if (mpv.finalVerdict !== "fail" || mpv.issues.length === 0) return;

  const result = await callLLM(`The actor failed twice. Critic issues: ${mpv.issues.join(", ")}.
Reasoning: ${mpv.reasoning}
Task: ${card.task}

What specialized serf should handle this? Respond with:
NAME: <one-word>
MISSION: <one sentence>
PERSONA: <one sentence>`);

  const nameMatch = result.text.match(/NAME:\s*(\S+)/i);
  const missionMatch = result.text.match(/MISSION:\s*(.+)/i);
  const personaMatch = result.text.match(/PERSONA:\s*(.+)/i);
  if (!nameMatch || !missionMatch) return;

  const name = nameMatch[1].toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!name || readSerf(name)) return;

  createSerf({
    name,
    mission: missionMatch[1].trim(),
    persona: personaMatch?.[1]?.trim() ?? "Spawned from friction.",
    lever: [".serf/ folder", "file system"],
    measurement: [`Pass rate on ${name} tasks: >70%`],
    fate: `Spawned because actor couldn't handle: ${mpv.issues.join(", ")}.`,
  });

  appendEvent("serf.spawned", { name, mission: missionMatch[1].trim(), reason: "friction" });
  console.log(`    ⚡ Spawned: ${name} — ${missionMatch[1].trim()}`);

  if (workspaceId) {
    try {
      const config = loadConfig();
      const spawned = await HerdrAgent.create(workspaceId, name, config?.agent ?? "claude", config?.model, "down");
      console.log(`    ⚡ Spawned serf pane ready: ${name}`);
      spawnedSerfs.push(spawned);
    } catch (err) {
      console.log(`    ⚡ Spawned ${name} (no pane — ${err instanceof Error ? err.message : String(err)})`);
    }
  }
}

// ── HELPERS ──

function printMultipassCritic(mpv: MultiPassVerdict): void {
  console.log(`    ┌── GAN CRITIC (${mpv.totalPasses} passes) ──────────────────────────`);
  console.log(`    │ Verdict:    ${mpv.finalVerdict.toUpperCase()}`);
  console.log(`    │ Agreement: ${(mpv.agreementRate * 100).toFixed(0)}% (${mpv.passCount} pass / ${mpv.failCount} fail${mpv.uncertainCount > 0 ? ` / ${mpv.uncertainCount} uncertain` : ""})`);
  console.log(`    │ Curiosity: ${(mpv.curiosity * 100).toFixed(0)}%`);
  if (mpv.issues.length > 0) {
    console.log(`    │ Issues:    ${mpv.issues.join(", ")}`);
  }
  if (mpv.curiosityNotes.length > 0) {
    console.log(`    │ Curious:   ${mpv.curiosityNotes.slice(0, 3).join("; ")}`);
  }
  if (mpv.curiosityPoints.length > 0) {
    console.log(`    │ Points:    ${mpv.curiosityPoints.slice(0, 3).map(p => `${p.criterion.slice(0, 30)} (${(p.agreement * 100).toFixed(0)}%)`).join(", ")}`);
  }
  console.log(`    │ Reasoning: ${mpv.reasoning}`);
  console.log(`    └───────────────────────────────────────────────────\n`);
}

function logCuriosityPoints(card: Card, mpv: MultiPassVerdict): void {
  if (mpv.curiosityPoints.length === 0 && mpv.curiosityNotes.length === 0) return;
  const serfDir = getSerfDir();
  const knowledgeDir = join(serfDir, "knowledge", "patterns");
  ensureDir(knowledgeDir);

  const ts = new Date().toISOString();
  const lines = [`# Curiosity: ${card.title}`, "", `## Date`, ts, "", `## Task`, card.task, "", `## Curiosity Signal`, `Agreement: ${(mpv.agreementRate * 100).toFixed(0)}%`, `Curiosity: ${(mpv.curiosity * 100).toFixed(0)}%`, "", `## Curiosity Notes`];
  for (const note of mpv.curiosityNotes) {
    lines.push(`- ${note}`);
  }
  if (mpv.curiosityPoints.length > 0) {
    lines.push("", `## Curiosity Points`);
    for (const p of mpv.curiosityPoints) {
      lines.push(`- ${p.criterion} — agreement ${(p.agreement * 100).toFixed(0)}% — answers: ${p.answers.join(", ")}`);
    }
  }
  lines.push("", "## Implication", "The critic is uncertain here. Human judgment is most valuable at this boundary. This pattern signals where the system's model is weak.");

  const filePath = join(knowledgeDir, `curiosity-${card.id}-${ts.replace(/[:.]/g, "-")}.md`);
  try { writeFileSync(filePath, lines.join("\n") + "\n"); } catch {}
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
  const serfDir = getSerfDir();
  ensureDir(serfDir);

  const planPath = join(serfDir, "plan.md");
  if (!existsSync(planPath)) {
    writeFileSync(planPath, "# Plan\n\nThe mission and current direction.\n");
  }

  for (const dir of [
    "board/backlog", "board/in-progress", "board/review", "board/done",
    "serfs", "knowledge/skills", "knowledge/patterns", "knowledge/failures", "knowledge/references",
    "events", "worktrees",
    "workspaces/actor/.serf", "workspaces/critic/.serf", "workspaces/critic/.serf/verdicts",
  ]) {
    ensureDir(join(serfDir, dir));
  }
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

  if (merge) {
    try {
      execSync(`git add -A && git commit -m "serf: ${card.title}" --no-verify`, { cwd: worktreePath, stdio: "pipe" });
      execSync(`git merge --no-ff ${card.id} --no-edit 2>/dev/null`, { stdio: "pipe" });
    } catch {}
  }

  try { execSync(`git worktree remove --force "${worktreePath}"`, { stdio: "pipe" }); } catch {}
  try { execSync(`git branch -D ${card.id} 2>/dev/null`, { stdio: "pipe" }); } catch {}
}

// ── INTERACTIVE INTAKE ──

async function askUser(): Promise<string | null> {
  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question("\n  What would you like to work on? (or 'exit' to quit) ", answer => {
      rl.close();
      const trimmed = answer.trim();
      if (trimmed === "exit" || trimmed === "quit" || trimmed === "q") {
        resolve(null);
      } else {
        resolve(trimmed);
      }
    });
  });
}

async function projectReview(model?: string): Promise<void> {
  const serfDir = getSerfDir();
  const cwd = process.cwd();

  const projectFiles = scanProjectForIntake(cwd);
  const planMd = existsSync(join(serfDir, "plan.md")) ? readFileSync(join(serfDir, "plan.md"), "utf-8").slice(0, 800) : "";
  const knowledgeSkills = listKnowledgeForIntake(serfDir, "skills");
  const knowledgeFailures = listKnowledgeForIntake(serfDir, "failures");
  const boardCards = listBoardCardsForIntake(serfDir);
  const allCards = listCards();

  const prompt = `You are the master serf for a project. Survey the project and give the user a brief, honest overview of what this project is, what's on the board, what's been learned, and what might be worth working on.

PROJECT STRUCTURE:
${projectFiles}

PLAN:
${planMd}

KNOWLEDGE (skills):
${knowledgeSkills}

PAST FAILURES:
${knowledgeFailures}

BOARD:
${boardCards}

Respond with EXACTLY this format:

PROJECT: <2-3 sentences: what this project is, language, what it does>
BOARD: <1-2 sentences: what's on the board right now, or "empty">
STATUS: <1 sentence: what's been done recently, what's in progress, what's stuck>
SUGGESTIONS: <2-4 bullet points of what might be worth working on, based on the project state and knowledge. Each starts with "- ">`;

  console.log(`  Reviewing project...`);
  const { text } = await callLLM(prompt, { model });

  const project = text.match(/PROJECT:\s*(.+?)(?=\n(?:BOARD|STATUS|SUGGESTIONS|$$))/s)?.[1]?.trim() ?? "";
  const board = text.match(/BOARD:\s*(.+?)(?=\n(?:STATUS|SUGGESTIONS|$$))/s)?.[1]?.trim() ?? "";
  const status = text.match(/STATUS:\s*(.+?)(?=\n(?:SUGGESTIONS|$$))/s)?.[1]?.trim() ?? "";
  const suggestions = text.match(/SUGGESTIONS:\s*(.+?)(?:\n$$|$)/s)?.[1]?.trim() ?? "";

  console.log(`\n  ╔══ MASTER SERF — PROJECT REVIEW ═════════════`);
  console.log(`  ║`);
  if (project) { console.log(`  ║ ${project}`); console.log(`  ║`); }
  if (board) { console.log(`  ║ Board: ${board}`); console.log(`  ║`); }
  if (status) { console.log(`  ║ Status: ${status}`); console.log(`  ║`); }
  if (suggestions && suggestions.toLowerCase() !== "none") {
    console.log(`  ║ Suggestions:`);
    for (const line of suggestions.split("\n").filter(l => l.trim())) {
      console.log(`  ║   ${line.replace(/^[-*]\s*/, "").trim()}`);
    }
    console.log(`  ║`);
  }
  console.log(`  ╚══════════════════════════════════════════════\n`);
}

async function interactiveIntake(description: string, model?: string): Promise<void> {
  const serfDir = getSerfDir();
  const cwd = process.cwd();

  const projectFiles = scanProjectForIntake(cwd);
  const planMd = existsSync(join(serfDir, "plan.md")) ? readFileSync(join(serfDir, "plan.md"), "utf-8").slice(0, 500) : "";
  const knowledgeSkills = listKnowledgeForIntake(serfDir, "skills");
  const knowledgeFailures = listKnowledgeForIntake(serfDir, "failures");
  const boardCards = listBoardCardsForIntake(serfDir);

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

  console.log(`  Master is surveying the project...`);
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
    for (const q of questions.split("\n").filter(l => l.trim())) {
      console.log(`  ║   ${q.trim()}`);
    }
  }
  console.log(`  ║`);
  console.log(`  ║ Proposed task:`);
  console.log(`  ║   Task: ${taskTitle}`);
  console.log(`  ║   Acceptance:`);
  for (const line of acceptanceBlock.split("\n").filter(l => l.trim())) {
    console.log(`  ║     ${line.replace(/^[-*]\s*/, "").trim()}`);
  }
  if (context && context.toLowerCase() !== "none") {
    console.log(`  ║   Context: ${context.slice(0, 200)}`);
  }
  console.log(`  ╚════════════════════════════════════════════\n`);

  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>(resolve => {
    rl.question("  Approve? (y/n) ", a => { rl.close(); resolve(a.trim().toLowerCase()); });
  });

  if (answer === "y" || answer === "yes") {
    const acceptance = acceptanceBlock
      .split("\n")
      .map(l => l.replace(/^[-*]\s*/, "").trim())
      .filter(l => l.length > 0);
    const card = addTask(taskTitle, taskTitle, acceptance.length > 0 ? acceptance : ["GAN critic passes"]);
    console.log(`\n  ✓ Task added to backlog: ${card.id}\n`);
  } else {
    console.log(`\n  Task not added.\n`);
  }
}

function scanProjectForIntake(cwd: string): string {
  const lines: string[] = [];
  try {
    const entries = readdirSync(cwd).filter(f => !f.startsWith(".") && f !== "node_modules" && f !== "dist" && f !== "target");
    for (const entry of entries.slice(0, 30)) {
      const full = join(cwd, entry);
      try {
        const stat = statSync(full);
        lines.push(stat.isDirectory() ? `  ${entry}/` : `  ${entry}`);
      } catch {}
    }
  } catch {}

  let pkgInfo = "";
  const pkgPath = join(cwd, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      pkgInfo = `\npackage.json: ${pkg.name ?? "?"} v${pkg.version ?? "?"} — ${pkg.description ?? ""}`.trim();
    } catch {}
  }

  return `Files:\n${lines.join("\n")}${pkgInfo ? "\n\n" + pkgInfo : ""}`;
}

function listKnowledgeForIntake(serfDir: string, subdir: string): string {
  const dir = join(serfDir, "knowledge", subdir);
  if (!existsSync(dir)) return "none";
  try {
    const files = readdirSync(dir).filter(f => f.endsWith(".md")).slice(-5);
    if (files.length === 0) return "none";
    return files.map(f => `- ${f.replace(/\.md$/, "")}`).join("\n");
  } catch { return "none"; }
}

function listBoardCardsForIntake(serfDir: string): string {
  const cols = ["backlog", "in-progress", "review", "done"];
  const lines: string[] = [];
  for (const col of cols) {
    const dir = join(serfDir, "board", col);
    if (!existsSync(dir)) continue;
    try {
      const files = readdirSync(dir).filter(f => f.endsWith(".md"));
      if (files.length > 0) {
        lines.push(`${col} (${files.length}): ${files.map(f => f.replace(/\.md$/, "")).join(", ")}`);
      }
    } catch {}
  }
  return lines.length > 0 ? lines.join("\n") : "empty";
}

export { readCard, moveCard, listCards, writeCard, type Card };
export { createSerf, readSerf, listSerfs, type SerfIdentity };
export { critique, classifyVerdict, type CriticVerdict };
export { critiqueMultipass, classifyMultipass, type MultiPassVerdict, type Effort, EFFORT_PASSES };
export { callLLM, BudgetTracker };
export { spawnAgent, buildAgentPrompt, buildCriticAgentPrompt, buildCriticFollowupPrompt, buildCriticResolvePrompt };
export { HerdrAgent };