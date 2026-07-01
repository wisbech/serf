import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { isHerdrRunning } from "./herdr";

export interface Capabilities {
  agents: string[];
  herdr: boolean;
  packageManagers: Record<string, boolean>;
  languages: Record<string, boolean>;
}

const AGENTS = ["claude", "opencode", "aider", "pi", "hermes", "codex", "cursor", "code"];
const RUNTIMES = ["bun", "node", "deno", "python3", "python", "uv", "cargo", "go", "ruby", "php"];

export function detectCapabilities(projectRoot: string = process.cwd()): Capabilities {
  return {
    agents: detectAgents(),
    herdr: isHerdrRunning(),
    packageManagers: detectPackageManagers(projectRoot),
    languages: detectRuntimes(),
  };
}

function isOnPath(cmd: string): boolean {
  try {
    execSync(`command -v ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function detectAgents(): string[] {
  return AGENTS.filter(isOnPath);
}

function detectRuntimes(): Record<string, boolean> {
  return Object.fromEntries(RUNTIMES.map(cmd => [cmd, isOnPath(cmd)]));
}

function detectPackageManagers(projectRoot: string): Record<string, boolean> {
  const present: Record<string, boolean> = {};
  const files = new Set(readdirSafe(projectRoot));

  const markers: Record<string, string[]> = {
    bun: ["bun.lockb", "bun.lock"],
    npm: ["package-lock.json", "package.json"],
    pnpm: ["pnpm-lock.yaml"],
    yarn: ["yarn.lock"],
    uv: ["uv.lock", "pyproject.toml"],
    poetry: ["poetry.lock"],
    pip: ["Pipfile", "requirements.txt"],
    cargo: ["Cargo.toml"],
  };

  for (const [pm, names] of Object.entries(markers)) {
    present[pm] = names.some(name => files.has(name));
  }

  return present;
}

export function defaultAgentFromCapabilities(caps: Capabilities): string {
  const preferred = ["opencode", "claude", "codex", "aider", "pi", "hermes"];
  for (const agent of preferred) {
    if (caps.agents.includes(agent)) return agent;
  }
  return caps.agents[0] ?? "claude";
}

export function printCapabilities(caps: Capabilities): void {
  const pms = Object.entries(caps.packageManagers)
    .filter(([, v]) => v)
    .map(([k]) => k);
  const runtimes = Object.entries(caps.languages)
    .filter(([, v]) => v)
    .map(([k]) => k);

  console.log(`  Agents found:      ${caps.agents.join(", ") || "none"}`);
  console.log(`  herdr:             ${caps.herdr ? "yes" : "no (run herdr for pane management)"}`);
  console.log(`  Package managers:  ${pms.join(", ") || "unknown"}`);
  console.log(`  Runtimes:          ${runtimes.join(", ") || "unknown"}`);
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
