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

// The current serf instance id. Defaults to "main"; child serfs set
// SERF_INSTANCE to a unique name so their scratch and lock are isolated.
export function getInstanceId(): string {
  const id = process.env.SERF_INSTANCE;
  if (id && id.length > 0) return id;
  return "main";
}

// Per-instance scratch directory: .serf/tmp/<instance-id>/. Each serf instance
// (master, critic, actor, child serfs) owns its own slice, so concurrent
// instances never collide on prompt/proposal/critique files. The board is
// shared (it lives at .serf/board/), but scratch is isolated.
export function getInstanceTmp(): string {
  const dir = join(getSerfDir(), "tmp", getInstanceId());
  ensureDir(dir);
  return dir;
}

export function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}