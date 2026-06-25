import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const FARM_DIR = join(homedir(), ".serf");
const CONFIG_FILE = join(FARM_DIR, "config.json");

export interface Config {
  transport: string;
  model: string;
  backend: string;
  apiKey?: string;
  agent?: string;
  terminal?: string;
}

const DEFAULTS: Partial<Config> = {
  agent: "claude",
  terminal: "ghostty",
  backend: "ollama",
  model: "qwen3.5",
  transport: "pi",
};

export function loadConfig(): Config | null {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
    return { ...DEFAULTS, ...raw } as Config;
  } catch { return null; }
}

export function saveConfig(config: Config): void {
  if (!existsSync(FARM_DIR)) mkdirSync(FARM_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

export function farmDir(): string {
  if (!existsSync(FARM_DIR)) mkdirSync(FARM_DIR, { recursive: true });
  return FARM_DIR;
}