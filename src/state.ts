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
}

export function loadConfig(): Config | null {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
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