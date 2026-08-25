import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { getSerfDir, ensureDir } from "./paths";

function eventsDir(): string { return join(getSerfDir(), "events"); }

export interface SerfEvent {
  type: string;
  ts: string;
  subject?: string;
  cluster?: string;
  payload: Record<string, unknown>;
}

let _handlers: { pattern: string; handler: (e: SerfEvent) => void }[] = [];
let _fileWatchers: { pattern: string; handler: (e: SerfEvent) => void; watcher: FSWatcher }[] = [];
let _lastEventPosition = new Map<string, number>();

export function appendEvent(type: string, payload: Record<string, unknown>, subject?: string): void {
  const event: SerfEvent = {
    type,
    ts: new Date().toISOString(),
    subject,
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
      const stat = require("node:fs").statSync(file);
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