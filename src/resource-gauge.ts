import { execSync } from "node:child_process";

export interface ResourceSample {
  timestamp: number;
  totalRSSMB: number;
  processCount: number;
  topProcesses: { name: string; rssMB: number; pid: number }[];
}

export interface AttemptResources {
  attempt: number;
  startSample: ResourceSample | null;
  endSample: ResourceSample | null;
  peakRSSMB: number;
  deltaRSSMB: number;
  wallClockMs: number;
}

export interface TaskResourceSummary {
  attempts: AttemptResources[];
  peakRSSMB: number;
  totalWallClockMs: number;
  trend: "improving" | "stable" | "diverging";
}

export class ResourceGauge {
  private attempts: AttemptResources[] = [];
  private currentAttempt: AttemptResources | null = null;
  private startWallClock: number = 0;
  private peakRSS: number = 0;

  startTask(): void {
    this.attempts = [];
    this.peakRSS = 0;
    this.startWallClock = Date.now();
  }

  startAttempt(attempt: number): void {
    const startSample = sampleSystemMemory();
    this.currentAttempt = {
      attempt,
      startSample,
      endSample: null,
      peakRSSMB: startSample?.totalRSSMB ?? 0,
      deltaRSSMB: 0,
      wallClockMs: 0,
    };
  }

  endAttempt(): void {
    if (!this.currentAttempt) return;
    const endSample = sampleSystemMemory();
    const endRSS = endSample?.totalRSSMB ?? this.currentAttempt.startSample?.totalRSSMB ?? 0;
    const startRSS = this.currentAttempt.startSample?.totalRSSMB ?? 0;
    this.currentAttempt.endSample = endSample;
    this.currentAttempt.peakRSSMB = Math.max(this.currentAttempt.peakRSSMB, endRSS);
    this.currentAttempt.deltaRSSMB = endRSS - startRSS;
    this.currentAttempt.wallClockMs = Date.now() - (this.startWallClock || Date.now());
    this.peakRSS = Math.max(this.peakRSS, this.currentAttempt.peakRSSMB);
    this.attempts.push(this.currentAttempt);
    this.currentAttempt = null;
  }

  getSummary(): TaskResourceSummary {
    const peakRSSMB = this.peakRSS || Math.max(0, ...this.attempts.map(a => a.peakRSSMB));
    const totalWallClockMs = Date.now() - this.startWallClock;
    const trend = computeTrend(this.attempts);
    return { attempts: this.attempts, peakRSSMB, totalWallClockMs, trend };
  }

  formatSummary(): string {
    const summary = this.getSummary();
    if (summary.attempts.length === 0) return "(no resource data)";
    const lines = [
      `Resource strain:`,
      `  Peak RSS: ${summary.peakRSSMB} MB`,
      `  Wall clock: ${(summary.totalWallClockMs / 1000).toFixed(1)}s`,
      `  Trend: ${summary.trend}`,
    ];
    for (const a of summary.attempts) {
      lines.push(`  Attempt ${a.attempt}: peak ${a.peakRSSMB} MB, delta ${a.deltaRSSMB >= 0 ? "+" : ""}${a.deltaRSSMB} MB, ${(a.wallClockMs / 1000).toFixed(1)}s`);
    }
    return lines.join("\n");
  }
}

export function sampleSystemMemory(): ResourceSample | null {
  try {
    const output = execSync("ps aux --sort=-rss 2>/dev/null || ps aux -m 2>/dev/null", {
      encoding: "utf-8",
      timeout: 5000,
      stdio: "pipe",
    });

    const lines = output.trim().split("\n").slice(1);
    let totalRSS = 0;
    let processCount = 0;
    const topProcesses: { name: string; rssMB: number; pid: number }[] = [];

    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 6) continue;
      const pid = parseInt(parts[1]) || 0;
      const rssKB = parseInt(parts[5]) || 0;
      if (rssKB === 0) continue;
      const rssMB = Math.round(rssKB / 1024);
      totalRSS += rssMB;
      processCount++;
      const name = parts.slice(10).join(" ").slice(0, 40);
      if (topProcesses.length < 5) {
        topProcesses.push({ name, rssMB, pid });
      }
    }

    return {
      timestamp: Date.now(),
      totalRSSMB: totalRSS,
      processCount,
      topProcesses,
    };
  } catch {
    return null;
  }
}

function computeTrend(attempts: AttemptResources[]): "improving" | "stable" | "diverging" {
  if (attempts.length < 2) return "stable";
  const deltas = attempts.map(a => a.deltaRSSMB);
  const last = deltas[deltas.length - 1];
  const prev = deltas[deltas.length - 2];
  if (last > prev * 1.5) return "diverging";
  if (last < prev * 0.5) return "improving";
  return "stable";
}