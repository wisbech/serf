import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
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