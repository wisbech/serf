import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { getSerfDir } from "./paths";
import { listCards, type Card } from "./board";
import { readTrackRecords } from "./track-record";
import { listRoutines } from "./routines";
import { isHerdrRunning, listPanes, type PaneInfo } from "./herdr-client";

function eventsDir(): string { return join(getSerfDir(), "events"); }
function trajectoryFile(): string { return join(getSerfDir(), "trajectory.jsonl"); }

function readRecentEvents(limit = 20): { type: string; ts: string; source?: string; payload: any }[] {
  const dir = eventsDir();
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
  const out: any[] = [];
  for (const f of files.slice(-3)) {
    try {
      const raw = readFileSync(join(dir, f), "utf-8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try { out.push(JSON.parse(line)); } catch {}
      }
    } catch {}
  }
  return out.slice(-limit).reverse();
}

function readRecentTrajectory(limit = 20): any[] {
  if (!existsSync(trajectoryFile())) return [];
  const out: any[] = [];
  try {
    const raw = readFileSync(trajectoryFile(), "utf-8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch {}
    }
  } catch {}
  return out.slice(-limit).reverse();
}

function color(code: string, text: string): string {
  return `\x1b[${code}m${text}\x1b[0m`;
}

function statusIcon(card: Card): string {
  switch (card.column) {
    case "backlog": return color("33", "★");
    case "in-progress": return color("36", "▶");
    case "review": return color("35", "?");
    case "done": return color("32", "✓");
    default: return " ";
  }
}

function renderBoard(): string {
  const cards = listCards();
  const cols = ["backlog", "in-progress", "review", "done"] as const;
  const lines: string[] = [];
  lines.push(color("1;37", "── BOARD ──────────────────────────────────────────"));
  for (const col of cols) {
    const inCol = cards.filter((c) => c.column === col);
    const label = col.toUpperCase().padEnd(12);
    lines.push(`  ${label} (${inCol.length})`);
    for (const c of inCol.slice(0, 5)) {
      const quality = c.quality ? ` [${(c.quality * 100).toFixed(0)}%]` : "";
      lines.push(`    ${statusIcon(c)} ${c.title.slice(0, 40)}${quality}`);
    }
    if (inCol.length > 5) lines.push(`    … +${inCol.length - 5} more`);
  }
  return lines.join("\n");
}

function renderEvents(events: any[]): string {
  const lines: string[] = [];
  lines.push(color("1;37", "── EVENTS ─────────────────────────────────────────"));
  for (const e of events) {
    const time = e.ts?.slice(11, 19) ?? "??:??:??";
    const src = e.source ? `[${e.source}]` : "";
    const card = e.payload?.card ? ` card=${e.payload.card}` : "";
    lines.push(`  ${time} ${src} ${e.type}${card}`);
  }
  return lines.join("\n");
}

function renderTrajectory(steps: any[]): string {
  const lines: string[] = [];
  lines.push(color("1;37", "── TRAJECTORY ─────────────────────────────────────"));
  for (const s of steps) {
    const time = s.ts?.slice(11, 19) ?? "??:??:??";
    const src = s.source ? `[${s.source}]` : "";
    lines.push(`  ${time} ${src} ${s.type}`);
  }
  return lines.join("\n");
}

function renderTrackRecord(): string {
  const records = readTrackRecords();
  const lines: string[] = [];
  lines.push(color("1;37", "── TRACK RECORD ───────────────────────────────────"));
  if (records.length === 0) {
    lines.push("  (no completed tasks yet)");
    return lines.join("\n");
  }
  const recent = records.slice(-8).reverse();
  for (const r of recent) {
    const icon = r.outcome === "pass" ? color("32", "✓") : r.outcome === "fail" ? color("31", "✗") : color("35", "?");
    const model = r.model.split("/").pop() ?? r.model;
    lines.push(`  ${icon} ${r.title.slice(0, 32)} [${model}] ${r.attempts} attempt(s)`);
  }
  return lines.join("\n");
}

function renderRoutines(): string {
  const routines = listRoutines();
  const lines: string[] = [];
  lines.push(color("1;37", "── ROUTINES ───────────────────────────────────────"));
  if (routines.length === 0) {
    lines.push("  (none defined — add with `serf routine add`)");
    return lines.join("\n");
  }
  for (const r of routines) {
    const par = r.parallel ? color("32", "∥") : color("33", "→");
    lines.push(`  ${par} ${r.name} — ${r.description.slice(0, 40)}`);
  }
  return lines.join("\n");
}

function agentStateIcon(state: string): string {
  switch (state) {
    case "working": return color("36", "●");
    case "blocked": return color("31", "●");
    case "done": return color("32", "●");
    case "idle": return color("33", "○");
    default: return color("90", "○");
  }
}

function renderAgents(panes: PaneInfo[]): string {
  const lines: string[] = [];
  lines.push(color("1;37", "── AGENTS (herdr) ─────────────────────────────────"));
  if (panes.length === 0) {
    lines.push("  (no herdr panes — start herdr to see live agents)");
    return lines.join("\n");
  }
  for (const p of panes) {
    const label = p.label || p.display_agent || p.pane_id;
    const agent = p.agent || p.display_agent || "—";
    const state = p.agent_status || "unknown";
    lines.push(`  ${agentStateIcon(state)} ${label.slice(0, 30)} [${agent}] ${state}`);
  }
  return lines.join("\n");
}

export async function renderDashboard(): Promise<string> {
  const events = readRecentEvents(15);
  const trajectory = readRecentTrajectory(15);
  let agents: PaneInfo[] = [];
  if (isHerdrRunning()) {
    try {
      agents = await listPanes();
    } catch {}
  }
  return [
    color("1;36", "╔══ SERF LIVE ═══════════════════════════════════════╗"),
    renderBoard(),
    "",
    renderAgents(agents),
    "",
    renderEvents(events),
    "",
    renderTrajectory(trajectory),
    "",
    renderTrackRecord(),
    "",
    renderRoutines(),
    color("1;36", "╚════════════════════════════════════════════════════╝"),
  ].join("\n");
}

export function watchDashboard(intervalMs = 2000): () => void {
  let running = true;
  const tick = async () => {
    if (!running) return;
    process.stdout.write("\x1b[2J\x1b[H");
    process.stdout.write((await renderDashboard()) + "\n");
    process.stdout.write(color("90", `\n  Refreshing every ${intervalMs / 1000}s. Ctrl+C to exit.`));
  };
  tick();
  const id = setInterval(tick, intervalMs);
  return () => {
    running = false;
    clearInterval(id);
  };
}
