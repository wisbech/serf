import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";

export function getSerfDir(): string {
  const override = process.env.SERF_HOME;
  if (override && override.length > 0) return override;
  return join(process.cwd(), ".serf");
}

export function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}