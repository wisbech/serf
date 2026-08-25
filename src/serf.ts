import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { getSerfDir, ensureDir } from "./paths";

function serfsDir(): string { return join(getSerfDir(), "serfs"); }
function retiredDir(): string { return join(getSerfDir(), "knowledge", "retired"); }

export interface SerfIdentity {
  name: string;
  mission: string;
  persona: string;
  lever: string[];
  measurement: string[];
  fate: string;
  model?: string;
  editor?: string;
  prefs?: Record<string, string>;
}

function ensureDirs(): void {
  ensureDir(serfsDir());
  ensureDir(retiredDir());
}

function serfPath(name: string): string {
  return join(serfsDir(), `${name}.md`);
}

function retiredPath(name: string): string {
  return join(retiredDir(), `${name}.md`);
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
  return readdirSync(serfsDir())
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
  editor: undefined,
  prefs: undefined,
};

function identityToMarkdown(identity: SerfIdentity): string {
  let md = `# ${identity.name}

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
`;
  if (identity.model) md += `\n## Model\n${identity.model}\n`;
  if (identity.editor) md += `\n## Editor\n${identity.editor}\n`;
  if (identity.prefs && Object.keys(identity.prefs).length > 0) {
    md += `\n## Prefs\n${Object.entries(identity.prefs).map(([k, v]) => `- ${k}: ${v}`).join("\n")}\n`;
  }
  return md;
}

function markdownToIdentity(raw: string, name: string): SerfIdentity {
  const missionMatch = raw.match(/## Mission\n([\s\S]*?)(?=\n## )/m);
  const personaMatch = raw.match(/## Persona\n([\s\S]*?)(?=\n## )/m);
  const leverMatch = raw.match(/## Lever\n([\s\S]*?)(?=\n## )/m);
  const measurementMatch = raw.match(/## Measurement\n([\s\S]*?)(?=\n## )/m);
  const fateMatch = raw.match(/## Fate\n([\s\S]*?)(?=\n## |$)/m);
  const modelMatch = raw.match(/## Model\n(.+)/m);
  const editorMatch = raw.match(/## Editor\n(.+)/m);
  const prefsMatch = raw.match(/## Prefs\n([\s\S]*)/);

  let prefs: Record<string, string> | undefined;
  if (prefsMatch) {
    prefs = {};
    for (const line of prefsMatch[1].split("\n")) {
      const m = line.match(/^-\s*(.+?):\s*(.+)/);
      if (m) prefs[m[1].trim()] = m[2].trim();
    }
    if (Object.keys(prefs).length === 0) prefs = undefined;
  }

  return {
    name,
    mission: missionMatch?.[1]?.trim() ?? "",
    persona: personaMatch?.[1]?.trim() ?? "",
    lever: leverMatch ? leverMatch[1].split("\n").map(l => l.replace(/^-\s*/, "").trim()).filter(Boolean) : [],
    measurement: measurementMatch ? measurementMatch[1].split("\n").map(l => l.replace(/^-\s*/, "").trim()).filter(Boolean) : [],
    fate: fateMatch?.[1]?.trim() ?? "",
    model: modelMatch?.[1]?.trim() || undefined,
    editor: editorMatch?.[1]?.trim() || undefined,
    prefs,
  };
}