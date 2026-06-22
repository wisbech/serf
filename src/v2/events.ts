import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const EVENTS_DIR = join(homedir(), ".serf", "events");

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

  if (!existsSync(EVENTS_DIR)) mkdirSync(EVENTS_DIR, { recursive: true });
  const date = event.ts.slice(0, 10);
  const file = join(EVENTS_DIR, `${date}.jsonl`);

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
  if (!existsSync(EVENTS_DIR)) return [];
  const out: SerfEvent[] = [];

  for (const f of readdirSync(EVENTS_DIR).filter(f => f.endsWith(".jsonl"))) {
    try {
      const raw = readFileSync(join(EVENTS_DIR, f), "utf-8");
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