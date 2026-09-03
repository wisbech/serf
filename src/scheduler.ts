import { existsSync, readFileSync, writeFileSync, watch, type FSWatcher } from "node:fs";
import { join, resolve } from "node:path";
import { getSerfDir, ensureDir } from "./paths";
import { listRoutines } from "./routines";
import { appendEvent } from "./events";

interface SchedulerState {
  lastRun: Record<string, number>;
}

function statePath(): string {
  return join(getSerfDir(), "tmp", "scheduler-state.json");
}

function readState(): SchedulerState {
  try {
    return JSON.parse(readFileSync(statePath(), "utf-8")) as SchedulerState;
  } catch {
    return { lastRun: {} };
  }
}

function writeState(state: SchedulerState): void {
  ensureDir(join(getSerfDir(), "tmp"));
  writeFileSync(statePath(), JSON.stringify(state, null, 2));
}

function resolveWatchDir(dir: string): string {
  if (dir.startsWith("/")) return dir;
  return resolve(process.cwd(), dir);
}

export function startScheduler(intervalMs = 30_000): () => void {
  let running = true;
  const watchers: FSWatcher[] = [];

  for (const r of listRoutines()) {
    if (!r.watchDir) continue;
    const dir = resolveWatchDir(r.watchDir);
    if (!existsSync(dir)) continue;
    try {
      const w = watch(dir, (_eventType, filename) => {
        if (!running || !filename) return;
        appendEvent("routine.due", { routine: r.name, reason: "watch", file: filename });
      });
      w.on("error", () => {});
      watchers.push(w);
    } catch {}
  }

  const tick = () => {
    if (!running) return;
    const state = readState();
    const now = Date.now();
    let changed = false;
    for (const r of listRoutines()) {
      if (!r.intervalSecs || r.intervalSecs <= 0) continue;
      const last = state.lastRun[r.name] ?? 0;
      if (now - last >= r.intervalSecs * 1000) {
        state.lastRun[r.name] = now;
        changed = true;
        appendEvent("routine.due", { routine: r.name, reason: "interval" });
      }
    }
    if (changed) writeState(state);
  };

  tick();
  const id = setInterval(tick, intervalMs);

  return () => {
    running = false;
    clearInterval(id);
    for (const w of watchers) {
      try { w.close(); } catch {}
    }
  };
}
