import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { getSerfDir, ensureDir } from "./paths";

// The garden is the contemporary, access-based layer of the environment.
// It holds data that expires (pricing, credentials) and tracks its freshness.
// Knowledge (durable, learned) lives in .serf/knowledge/; the garden is the
// "what do we have access to right now" layer.

export interface GardenState {
  data: Record<string, { lastRefreshed?: string; maxAgeSecs?: number; lastMinted?: string; ttlSecs?: number; lastPruned?: string }>;
}

export function dataDir(): string {
  return join(getSerfDir(), "data");
}

export function credentialsDir(): string {
  return join(dataDir(), "credentials");
}

export function statePath(): string {
  return join(dataDir(), "state.json");
}

export function ensureGarden(): void {
  ensureDir(dataDir());
  ensureDir(credentialsDir());
  if (!existsSync(statePath())) {
    writeFileSync(statePath(), JSON.stringify({ data: {} }, null, 2));
  }
}

export function readGardenState(): GardenState {
  ensureGarden();
  try {
    return JSON.parse(readFileSync(statePath(), "utf-8")) as GardenState;
  } catch {
    return { data: {} };
  }
}

export function writeGardenState(state: GardenState): void {
  ensureGarden();
  writeFileSync(statePath(), JSON.stringify(state, null, 2));
}

export function markRefreshed(name: string, maxAgeSecs: number): void {
  const state = readGardenState();
  state.data[name] = { ...state.data[name], lastRefreshed: new Date().toISOString(), maxAgeSecs };
  writeGardenState(state);
}

export function markMinted(name: string, ttlSecs: number): void {
  const state = readGardenState();
  state.data[name] = { ...state.data[name], lastMinted: new Date().toISOString(), ttlSecs };
  writeGardenState(state);
}

export function markPruned(): void {
  const state = readGardenState();
  state.data["state"] = { ...state.data["state"], lastPruned: new Date().toISOString() };
  writeGardenState(state);
}

export interface StaleItem {
  name: string;
  kind: "data" | "credential" | "state";
  reason: string;
}

// Pure staleness check: read the garden state, compare timestamps against
// thresholds, return what's stale. This never spawns anything — it's the
// observation surface the gardener (and any serf) reads.
export function checkGarden(): StaleItem[] {
  const state = readGardenState();
  const stale: StaleItem[] = [];
  const now = Date.now();

  for (const [name, info] of Object.entries(state.data)) {
    if (info.lastRefreshed && info.maxAgeSecs) {
      const ageMs = now - new Date(info.lastRefreshed).getTime();
      if (ageMs > info.maxAgeSecs * 1000) {
        stale.push({ name, kind: "data", reason: `data stale (${Math.round(ageMs / 1000)}s > ${info.maxAgeSecs}s)` });
      }
    }
    if (info.lastMinted && info.ttlSecs) {
      const ageMs = now - new Date(info.lastMinted).getTime();
      if (ageMs > info.ttlSecs * 1000) {
        stale.push({ name, kind: "credential", reason: `credential expired (${Math.round(ageMs / 1000)}s > ${info.ttlSecs}s)` });
      }
    }
  }

  // State pruning: if tmp/ or worktrees/ are bloated, flag it.
  const tmpDir = join(getSerfDir(), "tmp");
  if (existsSync(tmpDir)) {
    const count = readdirSync(tmpDir).length;
    if (count > 20) stale.push({ name: "tmp", kind: "state", reason: `${count} files in tmp/` });
  }
  const worktreesDir = join(getSerfDir(), "worktrees");
  if (existsSync(worktreesDir)) {
    const count = readdirSync(worktreesDir).length;
    if (count > 5) stale.push({ name: "worktrees", kind: "state", reason: `${count} worktrees` });
  }

  return stale;
}

export function renderGarden(): string {
  const state = readGardenState();
  const stale = checkGarden();
  const lines: string[] = [];
  lines.push("═══ SERF GARDEN (environment) ═══════════════════");
  lines.push("  data/  — contemporary, access-based (pricing, credentials)");
  lines.push("  knowledge/ — durable, learned (skills, patterns, failures)\n");

  const entries = Object.entries(state.data);
  if (entries.length === 0) {
    lines.push("  (garden is empty — nothing tracked yet)");
  }
  for (const [name, info] of entries) {
    const refreshed = info.lastRefreshed ? info.lastRefreshed.slice(0, 19).replace("T", " ") : "never";
    const minted = info.lastMinted ? info.lastMinted.slice(0, 19).replace("T", " ") : "never";
    lines.push(`  ${name}: refreshed ${refreshed}${info.lastMinted ? ` | minted ${minted}` : ""}`);
  }

  if (stale.length > 0) {
    lines.push("");
    lines.push("  Stale (needs the gardener):");
    for (const s of stale) {
      lines.push(`    ⚠ ${s.name} [${s.kind}] — ${s.reason}`);
    }
  } else {
    lines.push("");
    lines.push("  Garden is healthy — nothing to maintain.");
  }
  return lines.join("\n");
}
