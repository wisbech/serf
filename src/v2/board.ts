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
  acceptance: string[];
  context?: string;
  quality?: number;
  feedback?: "accept" | "refine" | null;
  budgetUsed?: number;
  budgetLimit?: number;
  createdAt: string;
  updatedAt: string;
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

export function addTask(title: string, task?: string, acceptance?: string[]): Card {
  ensureBoard();
  const id = `${slugify(title)}-${Date.now().toString(36)}`;
  const now = new Date().toISOString();
  const card: Card = {
    id,
    title,
    column: "backlog",
    task: task ?? title,
    acceptance: acceptance ?? ["GAN critic passes"],
    createdAt: now,
    updatedAt: now,
  };
  writeCard(card);
  return card;
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
    for (const file of readdirSync(dir).filter(f => f.endsWith(".md"))) {
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

## Acceptance
${card.acceptance.map(a => `- ${a}`).join("\n")}

## Context
${card.context ?? ""}

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
  const acceptanceMatch = raw.match(/## Acceptance\n([\s\S]*?)(?=\n## )/m);
  const contextMatch = raw.match(/## Context\n([\s\S]*?)(?=\n## )/m);
  const qualityMatch = raw.match(/## Quality\n(.+)/m);
  const feedbackMatch = raw.match(/## Feedback\n(.+)/m);
  const budgetMatch = raw.match(/## Budget\nused: (\d+)\s*\/\s*limit: (.+)/m);
  const createdMatch = raw.match(/created: (.+)/m);
  const updatedMatch = raw.match(/updated: (.+)/m);

  return {
    id,
    title: titleMatch?.[1]?.trim() ?? id,
    column,
    assigned: assignedMatch?.[1]?.trim() === "unassigned" ? undefined : assignedMatch?.[1]?.trim(),
    task: taskMatch?.[1]?.trim() ?? "",
    acceptance: acceptanceMatch
      ? acceptanceMatch[1].split("\n").map(l => l.replace(/^-\s*/, "").trim()).filter(Boolean)
      : ["GAN critic passes"],
    context: contextMatch?.[1]?.trim() || undefined,
    quality: qualityMatch?.[1]?.trim() === "not scored" ? undefined : parseFloat(qualityMatch?.[1] ?? "0") || undefined,
    feedback: feedbackMatch?.[1]?.trim() === "none" ? null : (feedbackMatch?.[1]?.trim() as "accept" | "refine" | null),
    budgetUsed: budgetMatch ? parseInt(budgetMatch[1]) : undefined,
    budgetLimit: budgetMatch?.[2] === "unlimited" ? undefined : parseInt(budgetMatch?.[2] ?? "0") || undefined,
    createdAt: createdMatch?.[1]?.trim() ?? new Date().toISOString(),
    updatedAt: updatedMatch?.[1]?.trim() ?? new Date().toISOString(),
  };
}