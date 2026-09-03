import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getSerfDir, ensureDir } from "./paths";

export interface Routine {
  name: string;
  description: string;
  trigger: string;
  steps: string[];
  verification: string;
  parallel: boolean;
  intervalSecs?: number;
  watchDir?: string;
  createdAt: string;
  updatedAt: string;
}

function routinesDir(): string {
  return join(getSerfDir(), "routines");
}

function routinePath(name: string): string {
  return join(routinesDir(), `${name}.md`);
}

function ensureRoutinesDir(): void {
  ensureDir(routinesDir());
}

export function createRoutine(routine: Routine): void {
  ensureRoutinesDir();
  writeFileSync(routinePath(routine.name), routineToMarkdown(routine));
}

export function readRoutine(name: string): Routine | null {
  try {
    const raw = readFileSync(routinePath(name), "utf-8");
    return markdownToRoutine(raw, name);
  } catch {
    return null;
  }
}

export function listRoutines(): Routine[] {
  ensureRoutinesDir();
  return readdirSync(routinesDir())
    .filter((f) => f.endsWith(".md"))
    .map((f) => readRoutine(f.replace(/\.md$/, "")))
    .filter(Boolean) as Routine[];
}

export function routineExists(name: string): boolean {
  return existsSync(routinePath(name));
}

export function matchRoutine(title: string): Routine | null {
  const routines = listRoutines();
  const lower = title.toLowerCase();
  for (const r of routines) {
    const triggerWords = r.trigger.toLowerCase().split(/[\s,|]+/).filter(Boolean);
    if (triggerWords.some((w) => lower.includes(w))) {
      return r;
    }
  }
  return null;
}

export function buildRoutinePrompt(routine: Routine, card: { task: string; goal: string; acceptance: string[] }): string {
  const steps = routine.steps.map((s, i) => `${i + 1}. ${s}`).join("\n");
  return `You are executing a known routine: ${routine.name}.

## Routine description
${routine.description}

## Steps (follow exactly)
${steps}

## Verification
${routine.verification}

## Task context
${card.task}

## Goal
${card.goal}

## Acceptance criteria
${card.acceptance.map((a) => `- ${a}`).join("\n")}

Execute the routine steps. When done, report:
VERIFICATION_COMMAND: <the command you ran>
VERIFICATION_EXIT_CODE: <0 or non-zero>
VERIFICATION_OUTPUT: <key output>
FILES_CHANGED:
- <file paths you changed>

Then end with SERF_TASK_DONE.`;
}

function routineToMarkdown(r: Routine): string {
  return `# ${r.name}

## Description
${r.description}

## Trigger
${r.trigger}

## Steps
${r.steps.map((s) => `- ${s}`).join("\n")}

## Verification
${r.verification}

## Parallel
${r.parallel ? "yes" : "no"}

## Interval
${r.intervalSecs ?? ""}

## Watch
${r.watchDir ?? ""}

## Meta
created: ${r.createdAt}
updated: ${r.updatedAt}
`;
}

function markdownToRoutine(raw: string, name: string): Routine {
  const section = (n: string): string => {
    const m = raw.match(new RegExp(`## ${n}\\n([\\s\\S]*?)(?=\\n## )`, "m"));
    return m ? m[1].trim() : "";
  };
  const steps = section("Steps").split("\n").map((l) => l.replace(/^-\s*/, "").trim()).filter(Boolean);
  const createdMatch = raw.match(/created: (.+)/m);
  const updatedMatch = raw.match(/updated: (.+)/m);
  const intervalStr = section("Interval").trim();
  const watchStr = section("Watch").trim();
  return {
    name,
    description: section("Description"),
    trigger: section("Trigger"),
    steps,
    verification: section("Verification"),
    parallel: section("Parallel").toLowerCase() === "yes",
    intervalSecs: intervalStr ? parseInt(intervalStr, 10) : undefined,
    watchDir: watchStr || undefined,
    createdAt: createdMatch?.[1]?.trim() ?? new Date().toISOString(),
    updatedAt: updatedMatch?.[1]?.trim() ?? new Date().toISOString(),
  };
}
