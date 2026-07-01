import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const DEFAULTS: Partial<Config> = {
  agent: "claude",
  terminal: "auto",
  backend: "anthropic",
  model: "claude-sonnet-4-20250514",
  transport: "herdr",
  provider: "unknown",
};

export interface Config {
  transport: string;
  model: string;
  backend: string;
  apiKey?: string;
  apiKeyEnv?: string;
  agent?: string;
  terminal?: string;
  provider?: string;
  endpoint?: string;
}

function findConfigPath(): string | null {
  let dir = process.cwd();
  while (true) {
    const candidate = join(dir, ".serf", "config.json");
    if (existsSync(candidate)) return candidate;
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function loadConfig(): Config {
  const configPath = findConfigPath();
  if (!configPath) {
    return { ...DEFAULTS } as Config;
  }
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    return { ...DEFAULTS, ...raw } as Config;
  } catch {
    return { ...DEFAULTS } as Config;
  }
}

export function saveConfig(config: Config, projectRoot: string = process.cwd()): void {
  const serfDir = join(projectRoot, ".serf");
  if (!existsSync(serfDir)) mkdirSync(serfDir, { recursive: true });
  writeFileSync(join(serfDir, "config.json"), JSON.stringify(config, null, 2));
}

export function farmDir(): string {
  const dir = join(process.cwd(), ".serf");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}
