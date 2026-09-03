import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getSerfDir, ensureDir } from "./paths";

export interface TrackRecord {
  cardId: string;
  title: string;
  model: string;
  agent: string;
  outcome: "pass" | "fail" | "review";
  attempts: number;
  failedCriteria: string[];
  routine?: string;
  ts: string;
}

function trackDir(): string {
  return join(getSerfDir(), "knowledge", "track-record");
}

function trackFile(): string {
  return join(trackDir(), "records.jsonl");
}

function ensureTrackDir(): void {
  ensureDir(trackDir());
}

export function recordOutcome(record: TrackRecord): void {
  ensureTrackDir();
  writeFileSync(trackFile(), JSON.stringify(record) + "\n", { flag: "a" });
}

export function readTrackRecords(): TrackRecord[] {
  if (!existsSync(trackFile())) return [];
  const out: TrackRecord[] = [];
  try {
    const raw = readFileSync(trackFile(), "utf-8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line) as TrackRecord); } catch {}
    }
  } catch {}
  return out;
}

export function modelPassRate(model: string): { pass: number; total: number; rate: number } {
  const records = readTrackRecords().filter((r) => r.model === model);
  const total = records.length;
  const pass = records.filter((r) => r.outcome === "pass").length;
  return { pass, total, rate: total > 0 ? pass / total : 0 };
}

export function bestModelForTask(title: string): string | null {
  const records = readTrackRecords();
  const words = title.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
  const scored = new Map<string, { pass: number; total: number }>();

  for (const r of records) {
    const rWords = r.title.toLowerCase().split(/\s+/);
    const overlap = words.filter((w) => rWords.some((rw) => rw.includes(w) || w.includes(rw)));
    if (overlap.length === 0) continue;
    const cur = scored.get(r.model) ?? { pass: 0, total: 0 };
    cur.total += 1;
    if (r.outcome === "pass") cur.pass += 1;
    scored.set(r.model, cur);
  }

  let best: string | null = null;
  let bestRate = -1;
  for (const [model, s] of scored.entries()) {
    if (s.total < 2) continue;
    const rate = s.pass / s.total;
    if (rate > bestRate) {
      bestRate = rate;
      best = model;
    }
  }
  return best;
}

export function commonFailureCriteria(): { criterion: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const r of readTrackRecords()) {
    for (const c of r.failedCriteria) {
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([criterion, count]) => ({ criterion, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
}
