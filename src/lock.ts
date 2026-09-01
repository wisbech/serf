import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getSerfDir, ensureDir } from "./paths";

function lockPath(): string {
  return join(getSerfDir(), "tmp", "serf.pid");
}

function pidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
}

export function readLock(): { pid: number; held: boolean } | null {
  const path = lockPath();
  if (!existsSync(path)) return null;
  try {
    const pid = parseInt(readFileSync(path, "utf-8").trim(), 10);
    if (Number.isNaN(pid)) return null;
    return { pid, held: pidAlive(pid) };
  } catch {
    return null;
  }
}

export function acquireLock(): { ok: boolean; pid?: number } {
  ensureDir(join(getSerfDir(), "tmp"));
  const existing = readLock();
  if (existing && existing.held && existing.pid !== process.pid) {
    return { ok: false, pid: existing.pid };
  }
  writeFileSync(lockPath(), String(process.pid));
  return { ok: true };
}

export function releaseLock(): void {
  const existing = readLock();
  if (existing && existing.pid === process.pid) {
    try { unlinkSync(lockPath()); } catch {}
  }
}

export function clearStaleLock(): void {
  const existing = readLock();
  if (existing && !existing.held) {
    try { unlinkSync(lockPath()); } catch {}
  }
}
