import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getSerfDir, ensureDir } from "./paths";

export interface StateFile {
  verifiedFacts: string[];
  generalRules: string[];
  openFailures: string[];
  buildingBlocks: string[];
  harnessEdits: string[];
  lessonsLearned: string[];
  lastSession: string;
}

export function statePath(): string {
  return join(getSerfDir(), "STATE.md");
}

export function readState(): StateFile {
  const path = statePath();
  if (!existsSync(path)) {
    return { verifiedFacts: [], generalRules: [], openFailures: [], buildingBlocks: [], harnessEdits: [], lessonsLearned: [], lastSession: "" };
  }
  return parseStateFile(readFileSync(path, "utf-8"));
}

export function writeState(state: StateFile): void {
  ensureDir(getSerfDir());
  writeFileSync(statePath(), formatStateFile(state));
}

function parseStateFile(raw: string): StateFile {
  const section = (name: string): string[] => {
    const match = raw.match(new RegExp(`## ${name}\\n([\\s\\S]*?)(?=\\n## |$)`, "m"));
    if (!match) return [];
    return match[1].split("\n").map((l) => l.replace(/^-\s*/, "").trim()).filter((l) => l.length > 0 && l !== "(none)");
  };
  const lastMatch = raw.match(/## Last session\n([\s\S]*?)$/m);
  return {
    verifiedFacts: section("Verified facts"),
    generalRules: section("General rules"),
    openFailures: section("Open failures"),
    buildingBlocks: section("Building blocks"),
    harnessEdits: section("Harness edits"),
    lessonsLearned: section("Lessons learned"),
    lastSession: lastMatch?.[1]?.trim() ?? "",
  };
}

function formatStateFile(state: StateFile): string {
  const fmt = (items: string[]) => items.length > 0 ? items.map((i) => `- ${i}`).join("\n") : "(none)";
  return `# Serf State

## Verified facts
${fmt(state.verifiedFacts)}

## General rules
${fmt(state.generalRules)}

## Open failures
${fmt(state.openFailures)}

## Building blocks
${fmt(state.buildingBlocks)}

## Harness edits
${fmt(state.harnessEdits)}

## Lessons learned
${fmt(state.lessonsLearned)}

## Last session
${state.lastSession || "(none yet)"}
`;
}

export function addVerifiedFact(fact: string): void {
  const s = readState();
  if (!s.verifiedFacts.includes(fact)) { s.verifiedFacts.push(fact); writeState(s); }
}

export function addGeneralRule(rule: string): void {
  const s = readState();
  if (!s.generalRules.includes(rule)) { s.generalRules.push(rule); writeState(s); }
}

export function addOpenFailure(failure: string): void {
  const s = readState();
  s.openFailures.push(`${new Date().toISOString().slice(0, 10)}: ${failure}`);
  writeState(s);
}

export function resolveOpenFailure(fragment: string): void {
  const s = readState();
  s.openFailures = s.openFailures.filter((f) => !f.includes(fragment));
  writeState(s);
}

export function addLesson(lesson: string): void {
  const s = readState();
  if (!s.lessonsLearned.includes(lesson)) { s.lessonsLearned.push(lesson); writeState(s); }
}

export function addBuildingBlock(block: string): void {
  const s = readState();
  if (!s.buildingBlocks.includes(block)) { s.buildingBlocks.push(block); writeState(s); }
}

export function addHarnessEdit(edit: string): void {
  const s = readState();
  s.harnessEdits.push(`${new Date().toISOString().slice(0, 10)}: ${edit}`);
  writeState(s);
}

export function updateLastSession(summary: string): void {
  const s = readState();
  s.lastSession = `${new Date().toISOString()} · ${summary}`;
  writeState(s);
}

export function getStateSummary(): string {
  const s = readState();
  const lines: string[] = [];
  if (s.verifiedFacts.length > 0) { lines.push("Verified facts:"); for (const f of s.verifiedFacts.slice(0, 5)) lines.push(`- ${f}`); }
  if (s.generalRules.length > 0) { lines.push("General rules:"); for (const r of s.generalRules.slice(0, 5)) lines.push(`- ${r}`); }
  if (s.openFailures.length > 0) { lines.push("Open failures:"); for (const f of s.openFailures.slice(0, 3)) lines.push(`- ${f}`); }
  if (s.buildingBlocks.length > 0) { lines.push("Building blocks:"); for (const b of s.buildingBlocks.slice(0, 5)) lines.push(`- ${b}`); }
  if (s.harnessEdits.length > 0) { lines.push("Harness edits:"); for (const e of s.harnessEdits.slice(0, 5)) lines.push(`- ${e}`); }
  if (s.lessonsLearned.length > 0) { lines.push("Lessons learned:"); for (const l of s.lessonsLearned.slice(0, 5)) lines.push(`- ${l}`); }
  return lines.length > 0 ? lines.join("\n") : "(no state yet)";
}