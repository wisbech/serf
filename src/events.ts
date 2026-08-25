import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, watch, statSync, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { getSerfDir, ensureDir } from "./paths";

function eventsDir(): string { return join(getSerfDir(), "events"); }
function blobsDir(): string { return join(eventsDir(), "blobs"); }
function trajectoryFile(): string { return join(getSerfDir(), "trajectory.jsonl"); }

const STDOUT_INLINE_LIMIT = 4096;

export interface SerfEvent {
  type: string;
  ts: string;
  source?: string;
  subject?: string;
  cluster?: string;
  payload: Record<string, unknown>;
}

export interface TrajectoryStep {
  step_id: string;
  ts: string;
  type: string;
  source?: string;
  parent_traj?: string;
  parent_step?: string;
  payload: Record<string, unknown>;
  stdout?: string;
  stdout_ref?: string;
  stdout_bytes?: number;
  stdout_truncated?: boolean;
}

export interface Subscription {
  types: string[];
  trigger_self: boolean;
  watchdog_secs?: number;
}

let _handlers: { pattern: string; handler: (e: SerfEvent) => void }[] = [];
let _fileWatchers: { pattern: string; handler: (e: SerfEvent) => void; watcher: FSWatcher }[] = [];

function makeStepId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}-${rand}`;
}

function spillBlob(stepId: string, content: string): { ref: string; bytes: number; truncated: string } {
  ensureDir(blobsDir());
  const ref = join(blobsDir(), `${stepId}.stdout`);
  writeFileSync(ref, content);
  return { ref, bytes: content.length, truncated: content.slice(0, STDOUT_INLINE_LIMIT) };
}

export function appendEvent(type: string, payload: Record<string, unknown>, subject?: string, source?: string): void {
  const event: SerfEvent = {
    type,
    ts: new Date().toISOString(),
    subject,
    source,
    payload,
  };

  const dir = eventsDir();
  ensureDir(dir);
  const date = event.ts.slice(0, 10);
  const file = join(dir, `${date}.jsonl`);

  try {
    writeFileSync(file, JSON.stringify(event) + "\n", { flag: "a" });
  } catch {}

  for (const h of _handlers) {
    if (h.pattern === "*" || h.pattern === type) {
      try { h.handler(event); } catch {}
    }
  }
}

export function appendTrajectory(type: string, payload: Record<string, unknown>, source?: string, stdout?: string): TrajectoryStep {
  const stepId = makeStepId();
  const ts = new Date().toISOString();
  const step: TrajectoryStep = { step_id: stepId, ts, type, source, payload };

  if (stdout && stdout.length > STDOUT_INLINE_LIMIT) {
    const blob = spillBlob(stepId, stdout);
    step.stdout = blob.truncated;
    step.stdout_ref = blob.ref;
    step.stdout_bytes = blob.bytes;
    step.stdout_truncated = true;
  } else if (stdout) {
    step.stdout = stdout;
  }

  ensureDir(getSerfDir());
  try {
    writeFileSync(trajectoryFile(), JSON.stringify(step) + "\n", { flag: "a" });
  } catch {}

  return step;
}

export function forkTrajectory(parentType: string, parentPayload: Record<string, unknown>, source: string): { childId: string; parentStep: TrajectoryStep } {
  const parentStep = appendTrajectory(parentType, parentPayload, source);

  const childId = makeStepId();
  const childStep: TrajectoryStep = {
    step_id: childId,
    ts: new Date().toISOString(),
    type: "trajectory",
    source,
    parent_traj: trajectoryFile(),
    parent_step: parentStep.step_id,
    payload: { fork: true },
  };

  const childFile = join(getSerfDir(), "trajectories", `${childId}.jsonl`);
  ensureDir(join(getSerfDir(), "trajectories"));
  writeFileSync(childFile, JSON.stringify(childStep) + "\n", { flag: "a" });

  return { childId, parentStep };
}

export function mergeTrajectory(childId: string, mergeType: string, mergePayload: Record<string, unknown>, source: string): TrajectoryStep {
  const childFile = join(getSerfDir(), "trajectories", `${childId}.jsonl`);
  let childLastStep: TrajectoryStep | null = null;
  if (existsSync(childFile)) {
    const lines = readFileSync(childFile, "utf-8").split("\n").filter(l => l.trim());
    if (lines.length > 0) {
      try { childLastStep = JSON.parse(lines[lines.length - 1]); } catch {}
    }
  }

  const step: TrajectoryStep = {
    step_id: makeStepId(),
    ts: new Date().toISOString(),
    type: mergeType,
    source,
    payload: {
      ...mergePayload,
      from_traj: childFile,
      from_step: childLastStep?.step_id,
    },
  };

  ensureDir(getSerfDir());
  writeFileSync(trajectoryFile(), JSON.stringify(step) + "\n", { flag: "a" });

  return step;
}

export function readTrajectory(file?: string, limit?: number): TrajectoryStep[] {
  const f = file ?? trajectoryFile();
  if (!existsSync(f)) return [];
  const out: TrajectoryStep[] = [];
  try {
    const raw = readFileSync(f, "utf-8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line) as TrajectoryStep); } catch {}
    }
  } catch {}
  return limit ? out.slice(-limit) : out;
}

export function readBlob(stdoutRef: string): string {
  try { return readFileSync(stdoutRef, "utf-8"); } catch { return ""; }
}

export function subscribe(pattern: string, handler: (e: SerfEvent) => void): () => void {
  _handlers.push({ pattern, handler });
  return () => {
    _handlers = _handlers.filter((h) => h.handler !== handler || h.pattern !== pattern);
  };
}

export function subscribeFromFile(pattern: string, handler: (e: SerfEvent) => void): () => void {
  const dir = eventsDir();
  ensureDir(dir);

  const todayFile = () => {
    const date = new Date().toISOString().slice(0, 10);
    return join(dir, `${date}.jsonl`);
  };

  let lastFile = "";
  let lastSize = 0;
  const readNew = () => {
    const file = todayFile();
    if (!existsSync(file)) return;
    if (file !== lastFile) { lastFile = file; lastSize = 0; }
    try {
      const stat = statSync(file);
      if (stat.size <= lastSize) return;
      const content = readFileSync(file, "utf-8");
      const lines = content.split("\n");
      for (let i = lastSize; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line) as SerfEvent;
          if (pattern === "*" || ev.type === pattern) {
            try { handler(ev); } catch {}
          }
        } catch {}
      }
      lastSize = lines.length;
    } catch {}
  };

  readNew();

  let watcher: FSWatcher;
  try {
    watcher = watch(dir, (eventType, filename) => {
      if (filename && filename.endsWith(".jsonl")) {
        setTimeout(readNew, 100);
      }
    });
    watcher.on("error", () => {});
  } catch {
    watcher = { close: () => {} } as any;
  }

  const interval = setInterval(readNew, 2000);

  const unsubscribe = () => {
    try { watcher.close(); } catch {}
    clearInterval(interval);
    _fileWatchers = _fileWatchers.filter((w) => w.handler !== handler || w.pattern !== pattern);
  };
  _fileWatchers.push({ pattern, handler, watcher });
  return unsubscribe;
}

export function subscribeToTrajectory(pattern: string, handler: (step: TrajectoryStep) => void): () => void {
  const file = trajectoryFile();
  let lastSize = 0;
  try { lastSize = existsSync(file) ? readFileSync(file, "utf-8").split("\n").length : 0; } catch {}

  const readNew = () => {
    if (!existsSync(file)) return;
    try {
      const content = readFileSync(file, "utf-8");
      const lines = content.split("\n");
      for (let i = lastSize; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) continue;
        try {
          const step = JSON.parse(line) as TrajectoryStep;
          if (pattern === "*" || step.type === pattern) {
            try { handler(step); } catch {}
          }
        } catch {}
      }
      lastSize = lines.length;
    } catch {}
  };

  readNew();

  let watcher: FSWatcher;
  try {
    watcher = watch(getSerfDir(), (eventType, filename) => {
      if (filename === "trajectory.jsonl") {
        setTimeout(readNew, 100);
      }
    });
    watcher.on("error", () => {});
  } catch {
    watcher = { close: () => {} } as any;
  }

  const interval = setInterval(readNew, 2000);

  return () => {
    try { watcher.close(); } catch {}
    clearInterval(interval);
  };
}

export function loadSubscriptions(serfName: string): Subscription[] {
  const subFile = join(getSerfDir(), "serfs", `${serfName}.subs.json`);
  if (!existsSync(subFile)) return [];
  try {
    const raw = readFileSync(subFile, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : (parsed.subscriptions ?? []);
  } catch { return []; }
}

export function queryEvents(type?: string, limit?: number): SerfEvent[] {
  const dir = eventsDir();
  if (!existsSync(dir)) return [];
  const out: SerfEvent[] = [];

  for (const f of readdirSync(dir).filter(f => f.endsWith(".jsonl"))) {
    try {
      const raw = readFileSync(join(dir, f), "utf-8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line) as SerfEvent;
          if (!type || ev.type === type) out.push(ev);
        } catch {}
      }
    } catch {}
  }

  out.sort((a, b) => a.ts.localeCompare(b.ts));
  return limit ? out.slice(-limit) : out;
}

export function getLastEvent(type: string): SerfEvent | null {
  const events = queryEvents(type, 1);
  return events.length > 0 ? events[events.length - 1] : null;
}