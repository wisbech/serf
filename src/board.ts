import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getSerfDir, ensureDir } from "./paths";

function serfDir(): string { return getSerfDir(); }
function boardDir(): string { return join(serfDir(), "board"); }

export type Column = "backlog" | "in-progress" | "review" | "done";

const COLUMNS: Column[] = ["backlog", "in-progress", "review", "done"];

export interface Card {
  id: string;
  title: string;
  column: Column;
  assigned?: string;
  task: string;
  goal: string;
  lever: string;
  acceptance: string[];
  context?: string;
  quality?: number;
  feedback?: "accept" | "refine" | null;
  budgetUsed?: number;
  budgetLimit?: number;
  createdAt: string;
  updatedAt: string;
  decisions?: string[];
  verification?: string[];
  prdPath?: string;
  blockedBy?: string[];
}

function ensureBoard(): void {
  ensureDir(serfDir());
  for (const col of COLUMNS) {
    const dir = join(boardDir(), col);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 50).replace(/^-|-$/g, "");
}

function cardPath(id: string, column: Column): string {
  return join(boardDir(), column, `${id}.md`);
}

function findCardColumn(id: string): Column | null {
  for (const col of COLUMNS) {
    if (existsSync(cardPath(id, col))) return col;
  }
  return null;
}

export function hasSimilarTask(title: string): Card | null {
  const slug = slugify(title);
  for (const col of COLUMNS) {
    const dir = join(boardDir(), col);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".md") || file.includes("-output") || file.includes("-plan") || file.includes("-verdict")) continue;
      const id = file.replace(/\.md$/, "");
      if (id.startsWith(slug)) {
        const card = readCard(id);
        if (card) return card;
      }
    }
  }
  return null;
}

export function addTask(title: string, task?: string, goal?: string, lever?: string, acceptance?: string[], context?: string): Card {
  ensureBoard();
  const existing = hasSimilarTask(title);
  if (existing) {
    existing.context = `Task re-requested: "${title}". Original already exists as ${existing.id} in ${existing.column}.`;
    existing.updatedAt = new Date().toISOString();
    writeCard(existing);
    return existing;
  }

  const id = `${slugify(title)}-${Date.now().toString(36)}`;
  const now = new Date().toISOString();
  const card: Card = {
    id,
    title,
    column: "backlog",
    task: task ?? title,
    goal: goal ?? `Achieve: ${title}`,
    lever: lever ?? `Implement the changes and verify them with tests or observable output`,
    acceptance: acceptance ?? ["Source files were edited to implement the change", "Tests pass or verification command succeeds"],
    context,
    createdAt: now,
    updatedAt: now,
  };
  writeCard(card);
  return card;
}

export function validateCard(card: Partial<Card>): string[] {
  const errors: string[] = [];
  if (!card.title || card.title.trim().length === 0) errors.push("missing title");
  if (!card.task || card.task.trim().length === 0) errors.push("missing task");
  if (!card.goal || card.goal.trim().length === 0) errors.push("missing goal: add a single done condition");
  if (!card.lever || card.lever.trim().length === 0) errors.push("missing lever: add the action/method to use");
  if (!card.acceptance || card.acceptance.length === 0) {
    errors.push("missing acceptance criteria");
  } else {
    const empty = card.acceptance.filter(a => !a || a.trim().length === 0).length;
    if (empty > 0) errors.push("acceptance criteria cannot be empty");
    const weak = card.acceptance.filter(a => {
      const lower = a.toLowerCase();
      return lower.includes("looks good") || lower.includes("seems fine") || lower.includes("works");
    }).length;
    if (weak > 0 && card.acceptance.length < 3) errors.push("acceptance criteria must be measurable (file paths, test names, output markers)");
    const nonEmpty = card.acceptance.filter(Boolean) as string[];
    const hasSourceEvidence = nonEmpty.some(a => /edit|create|add.*file|source file|git diff|implementation/i.test(a));
    const hasTestEvidence = nonEmpty.some(a => /test|verify|run|pass|command|output/i.test(a));
    if (!hasSourceEvidence) errors.push("acceptance criteria must include a source-file-change criterion");
    if (!hasTestEvidence) errors.push("acceptance criteria must include a verification/test criterion");
  }
  return errors;
}

export function writeCard(card: Card): void {
  ensureBoard();
  const path = cardPath(card.id, card.column);
  writeFileSync(path, cardToMarkdown(card));
}

export function readCard(id: string): Card | null {
  const col = findCardColumn(id);
  if (!col) return null;
  const path = cardPath(id, col);
  try {
    const raw = readFileSync(path, "utf-8");
    return markdownToCard(raw, id, col);
  } catch { return null; }
}

export function moveCard(id: string, toColumn: Column): Card | null {
  const fromCol = findCardColumn(id);
  if (!fromCol) return null;
  const card = readCard(id);
  if (!card) return null;

  const fromPath = cardPath(id, fromCol);
  const toPath = cardPath(id, toColumn);

  card.column = toColumn;
  card.updatedAt = new Date().toISOString();
  writeFileSync(toPath, cardToMarkdown(card));
  if (fromCol !== toColumn) unlinkSync(fromPath);

  return card;
}

export function listCards(column?: Column): Card[] {
  ensureBoard();
  const cols = column ? [column] : COLUMNS;
  const cards: Card[] = [];

  for (const col of cols) {
    const dir = join(boardDir(), col);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter(f => f.endsWith(".md") && !f.includes("-output") && !f.includes("-plan") && !f.includes("-verdict"))) {
      const id = file.replace(/\.md$/, "");
      const card = readCard(id);
      if (card) cards.push(card);
    }
  }

  return cards.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function deleteCard(id: string): boolean {
  const col = findCardColumn(id);
  if (!col) return false;
  unlinkSync(cardPath(id, col));
  return true;
}

export function computeFrontier(): Card[] {
  ensureBoard();
  const allCards = listCards();
  const doneIds = new Set(allCards.filter(c => c.column === "done").map(c => c.id));
  const inProgressIds = new Set(allCards.filter(c => c.column === "in-progress").map(c => c.id));

  const frontier: Card[] = [];
  for (const card of allCards) {
    if (card.column !== "backlog") continue;
    if (inProgressIds.has(card.id)) continue;
    if (!card.blockedBy || card.blockedBy.length === 0) {
      frontier.push(card);
      continue;
    }
    const allBlockersClosed = card.blockedBy.every(id => doneIds.has(id));
    if (allBlockersClosed) {
      frontier.push(card);
    }
  }

  return frontier.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function unblockDependents(closedCardId: string): Card[] {
  const allCards = listCards();
  const unblocked: Card[] = [];
  for (const card of allCards) {
    if (!card.blockedBy || !card.blockedBy.includes(closedCardId)) continue;
    const allBlockersClosed = card.blockedBy.every(id => allCards.find(c => c.id === id)?.column === "done");
    if (allBlockersClosed && card.column === "backlog") {
      card.blockedBy = card.blockedBy.filter(id => id !== closedCardId);
      if (card.blockedBy.length === 0) card.blockedBy = undefined;
      card.updatedAt = new Date().toISOString();
      writeCard(card);
      unblocked.push(card);
    }
  }
  return unblocked;
}

export function setFeedback(id: string, feedback: "accept" | "refine"): Card | null {
  const card = readCard(id);
  if (!card) return null;
  card.feedback = feedback;
  card.updatedAt = new Date().toISOString();
  writeCard(card);
  return card;
}

function cardToMarkdown(card: Card): string {
  return `# ${card.title}

## Status
${card.column}

## Assigned
${card.assigned ?? "unassigned"}

## Task
${card.task}

## Goal
${card.goal}

## Lever
${card.lever}

## Acceptance
${card.acceptance.map(a => `- ${a}`).join("\n")}

## Context
${card.context ?? ""}

## Blocked-by
${card.blockedBy?.map(b => `- ${b}`).join("\n") ?? ""}

## Decisions
${card.decisions?.map(d => `- ${d}`).join("\n") ?? ""}

## Verification
${card.verification?.map(v => `- ${v}`).join("\n") ?? ""}

## Quality
${card.quality ?? "not scored"}

## Feedback
${card.feedback ?? "none"}

## Budget
used: ${card.budgetUsed ?? 0} / limit: ${card.budgetLimit ?? "unlimited"}

## Meta
created: ${card.createdAt}
updated: ${card.updatedAt}
`;
}

function markdownToCard(raw: string, id: string, column: Column): Card {
  const titleMatch = raw.match(/^# (.+)$/m);
  const statusMatch = raw.match(/## Status\n(.+)/m);
  const assignedMatch = raw.match(/## Assigned\n(.+)/m);
  const taskMatch = raw.match(/## Task\n([\s\S]*?)(?=\n## )/m);
  const goalMatch = raw.match(/## Goal\n([\s\S]*?)(?=\n## )/m);
  const leverMatch = raw.match(/## Lever\n([\s\S]*?)(?=\n## )/m);
  const acceptanceMatch = raw.match(/## Acceptance\n([\s\S]*?)(?=\n## )/m);
  const contextMatch = raw.match(/## Context\n([\s\S]*?)(?=\n## )/m);
  const qualityMatch = raw.match(/## Quality\n(.+)/m);
  const feedbackMatch = raw.match(/## Feedback\n(.+)/m);
  const budgetMatch = raw.match(/## Budget\nused: (\d+)\s*\/\s*limit: (.+)/m);
  const createdMatch = raw.match(/created: (.+)/m);
  const updatedMatch = raw.match(/updated: (.+)/m);

  const blockedByMatch = raw.match(/## Blocked-by\n([\s\S]*?)(?=\n## )/m);
  const decisionsMatch = raw.match(/## Decisions\n([\s\S]*?)(?=\n## )/m);
  const verificationMatch = raw.match(/## Verification\n([\s\S]*?)(?=\n## )/m);

  return {
    id,
    title: titleMatch?.[1]?.trim() ?? id,
    column,
    assigned: assignedMatch?.[1]?.trim() === "unassigned" ? undefined : assignedMatch?.[1]?.trim(),
    task: taskMatch?.[1]?.trim() ?? "",
    goal: goalMatch?.[1]?.trim() ?? `Achieve: ${titleMatch?.[1]?.trim() ?? id}`,
    lever: leverMatch?.[1]?.trim() ?? "Implement the changes and verify them with tests or observable output",
    acceptance: acceptanceMatch
      ? acceptanceMatch[1].split("\n").map(l => l.replace(/^-\s*/, "").trim()).filter(Boolean)
      : ["Source files were edited to implement the change", "Tests pass or verification command succeeds"],
    context: contextMatch?.[1]?.trim() || undefined,
    blockedBy: blockedByMatch ? blockedByMatch[1].split("\n").map(l => l.replace(/^-\s*/, "").trim()).filter(Boolean) : undefined,
    decisions: decisionsMatch ? decisionsMatch[1].split("\n").map(l => l.replace(/^-\s*/, "").trim()).filter(Boolean) : undefined,
    verification: verificationMatch ? verificationMatch[1].split("\n").map(l => l.replace(/^-\s*/, "").trim()).filter(Boolean) : undefined,
    quality: qualityMatch?.[1]?.trim() === "not scored" ? undefined : parseFloat(qualityMatch?.[1] ?? "0") || undefined,
    feedback: feedbackMatch?.[1]?.trim() === "none" ? null : (feedbackMatch?.[1]?.trim() as "accept" | "refine" | null),
    budgetUsed: budgetMatch ? parseInt(budgetMatch[1]) : undefined,
    budgetLimit: budgetMatch?.[2] === "unlimited" ? undefined : parseInt(budgetMatch?.[2] ?? "0") || undefined,
    createdAt: createdMatch?.[1]?.trim() ?? new Date().toISOString(),
    updatedAt: updatedMatch?.[1]?.trim() ?? new Date().toISOString(),
  };
}