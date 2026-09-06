import { join, resolve } from "node:path";
import { existsSync, mkdirSync } from "node:fs";

export function getSerfDir(): string {
  const override = process.env.SERF_HOME;
  if (override && override.length > 0) return override;
  // Walk up from CWD to find the project's .serf/ directory. This handles the
  // case where serf is invoked from inside .serf/ (e.g. a respawned pane whose
  // CWD is /project/.serf), which would otherwise resolve to a doubled
  // /project/.serf/.serf path.
  let dir = resolve(process.cwd());
  while (true) {
    const candidate = join(dir, ".serf");
    if (existsSync(candidate)) return candidate;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return join(process.cwd(), ".serf");
}

export function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}