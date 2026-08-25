import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { getSerfDir, ensureDir } from "./paths";

function skillsDir(): string {
  return join(getSerfDir(), "knowledge", "skills");
}

function skillDir(name: string): string {
  return join(skillsDir(), name);
}

export function skillExists(name: string): boolean {
  return existsSync(skillDir(name));
}

export function createSkillFolder(name: string, context: string): void {
  const dir = skillDir(name);
  if (existsSync(dir)) return;
  ensureDir(dir);
  ensureDir(join(dir, "traces"));
  ensureDir(join(dir, "src"));
  writeFileSync(join(dir, "CONTEXT.md"), `# Skill: ${name}\n\n## When to consult\n${context}\n`);
  writeFileSync(join(dir, "lessons.md"), `# Lessons: ${name}\n\n(Accumulates over time)\n`);
  writeFileSync(join(dir, "failure-modes.md"), `# Failure modes: ${name}\n\n(Accumulates over time)\n`);
}

export function appendLesson(skillName: string, lesson: string): void {
  createSkillFolder(skillName, "auto-created");
  const path = join(skillDir(skillName), "lessons.md");
  const content = existsSync(path) ? readFileSync(path, "utf-8") : "";
  if (content.includes("Accumulates over time")) {
    writeFileSync(path, `# Lessons: ${skillName}\n\n- ${lesson}\n`);
  } else {
    appendFileSync(path, `- ${lesson}\n`);
  }
}

export function appendFailureMode(skillName: string, failure: string): void {
  createSkillFolder(skillName, "auto-created");
  const path = join(skillDir(skillName), "failure-modes.md");
  const content = existsSync(path) ? readFileSync(path, "utf-8") : "";
  if (content.includes("Accumulates over time")) {
    writeFileSync(path, `# Failure modes: ${skillName}\n\n- ${failure}\n`);
  } else {
    appendFileSync(path, `- ${failure}\n`);
  }
}

export function writeTrace(skillName: string, traceId: string, content: string): void {
  createSkillFolder(skillName, "auto-created");
  const path = join(skillDir(skillName), "traces", `${traceId}.md`);
  writeFileSync(path, content);
}

export function listSkills(): string[] {
  const dir = skillsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => existsSync(join(dir, f, "CONTEXT.md")));
}

export function readSkill(name: string): { context: string; lessons: string; failureModes: string } | null {
  const dir = skillDir(name);
  if (!existsSync(dir)) return null;
  const read = (f: string) => existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf-8") : "";
  return {
    context: read("CONTEXT.md"),
    lessons: read("lessons.md"),
    failureModes: read("failure-modes.md"),
  };
}

export function getRelevantSkills(card: Card): string {
  const all = listSkills();
  const relevant: string[] = [];
  for (const name of all) {
    const skill = readSkill(name);
    if (!skill) continue;
    const cardWords = card.title.toLowerCase().split(/\s+/);
    const skillWords = name.toLowerCase().split(/-/);
    const overlap = cardWords.filter((w) => skillWords.some((sw) => sw.includes(w) || w.includes(sw)));
    if (overlap.length > 0) {
      relevant.push(`### ${name}\n${skill.lessons.slice(0, 500)}\n${skill.failureModes.slice(0, 500)}`);
    }
  }
  return relevant.length > 0 ? relevant.join("\n\n") : "";
}

export function listBuildingBlocks(): string[] {
  const all = listSkills();
  const blocks: string[] = [];
  for (const name of all) {
    const srcDir = join(skillDir(name), "src");
    if (!existsSync(srcDir)) continue;
    for (const f of readdirSync(srcDir)) {
      if (f.endsWith(".ts") && !f.endsWith(".test.ts")) {
        blocks.push(`${name}/src/${f}`);
      }
    }
  }
  return blocks;
}

import type { Card } from "./board";