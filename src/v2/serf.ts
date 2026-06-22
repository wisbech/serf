import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const SERF_DIR = join(process.cwd(), ".serf");
const SERFS_DIR = join(SERF_DIR, "serfs");
const RETIRED_DIR = join(SERF_DIR, "knowledge", "retired");

export interface SerfIdentity {
  name: string;
  mission: string;
  persona: string;
  lever: string[];
  measurement: string[];
  fate: string;
  model?: string;
}

function ensureDirs(): void {
  if (!existsSync(SERFS_DIR)) mkdirSync(SERFS_DIR, { recursive: true });
  if (!existsSync(RETIRED_DIR)) mkdirSync(RETIRED_DIR, { recursive: true });
}

function serfPath(name: string): string {
  return join(SERFS_DIR, `${name}.md`);
}

function retiredPath(name: string): string {
  return join(RETIRED_DIR, `${name}.md`);
}

export function createSerf(identity: SerfIdentity): void {
  ensureDirs();
  writeFileSync(serfPath(identity.name), identityToMarkdown(identity));
}

export function readSerf(name: string): SerfIdentity | null {
  try {
    const raw = readFileSync(serfPath(name), "utf-8");
    return markdownToIdentity(raw, name);
  } catch { return null; }
}

export function listSerfs(): SerfIdentity[] {
  ensureDirs();
  return readdirSync(SERFS_DIR)
    .filter(f => f.endsWith(".md"))
    .map(f => readSerf(f.replace(/\.md$/, "")))
    .filter(Boolean) as SerfIdentity[];
}

export function morphSerf(name: string, changes: Partial<SerfIdentity>): SerfIdentity | null {
  const existing = readSerf(name);
  if (!existing) return null;
  const updated: SerfIdentity = { ...existing, ...changes, name: existing.name };
  writeFileSync(serfPath(name), identityToMarkdown(updated));
  return updated;
}

export function deprecateSerf(name: string): boolean {
  if (!existsSync(serfPath(name))) return false;
  ensureDirs();
  renameSync(serfPath(name), retiredPath(name));
  return true;
}

export const MASTER_IDENTITY: SerfIdentity = {
  name: "master",
  mission: "Coordinate the factory. Receive tasks from the user, break them down, delegate to serfs, review output, ensure quality. The buck stops here.",
  persona: "Decisive, fair, demanding. Expects quality but blames the task when serfs fail. Adapts plans when reality doesn't match expectations.",
  lever: [
    "callLLM for planning and synthesis",
    "GAN critic for quality enforcement",
    "Board for task tracking",
    "Serf identities for delegation",
  ],
  measurement: [
    "Task completion rate: >80%",
    "GAN critic pass rate: >70%",
    "User acceptance rate: >70%",
    "Serf death rate: <30% (if higher, my plans are bad)",
    "Budget adherence: never over limit",
  ],
  fate: "Always running. If I fail 3 times on a task, the task description is bad. If serfs keep dying, my strategy is bad. The user is my final critic.",
  model: undefined,
};

function identityToMarkdown(identity: SerfIdentity): string {
  return `# ${identity.name}

## Mission
${identity.mission}

## Persona
${identity.persona}

## Lever
${identity.lever.map(l => `- ${l}`).join("\n")}

## Measurement
${identity.measurement.map(m => `- ${m}`).join("\n")}

## Fate
${identity.fate}
${identity.model ? `\n## Model\n${identity.model}` : ""}
`;
}

function markdownToIdentity(raw: string, name: string): SerfIdentity {
  const missionMatch = raw.match(/## Mission\n([\s\S]*?)(?=\n## )/m);
  const personaMatch = raw.match(/## Persona\n([\s\S]*?)(?=\n## )/m);
  const leverMatch = raw.match(/## Lever\n([\s\S]*?)(?=\n## )/m);
  const measurementMatch = raw.match(/## Measurement\n([\s\S]*?)(?=\n## )/m);
  const fateMatch = raw.match(/## Fate\n([\s\S]*?)(?=\n## |$)/m);
  const modelMatch = raw.match(/## Model\n(.+)/m);

  return {
    name,
    mission: missionMatch?.[1]?.trim() ?? "",
    persona: personaMatch?.[1]?.trim() ?? "",
    lever: leverMatch ? leverMatch[1].split("\n").map(l => l.replace(/^-\s*/, "").trim()).filter(Boolean) : [],
    measurement: measurementMatch ? measurementMatch[1].split("\n").map(l => l.replace(/^-\s*/, "").trim()).filter(Boolean) : [],
    fate: fateMatch?.[1]?.trim() ?? "",
    model: modelMatch?.[1]?.trim() || undefined,
  };
}