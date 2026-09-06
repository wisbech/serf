import { readTrackRecords, type TrackRecord } from "./track-record";
import { createRoutine, listRoutines, routineExists } from "./routines";

export type MaturityStage = "novel" | "repetitive" | "routine" | "code";

export interface TaskCluster {
  key: string;
  label: string;
  count: number;
  passRate: number;
  stage: MaturityStage;
  hasRoutine: boolean;
}

const ROUTINE_THRESHOLD = 3;
const CODE_THRESHOLD = 8;
const PASS_RATE_FLOOR = 0.8;

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function clusterKey(title: string): string {
  const words = title.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
  return words.slice(0, 3).sort().join("-");
}

export function clusterTasks(records: TrackRecord[]): TaskCluster[] {
  const groups = new Map<string, { label: string; count: number; pass: number }>();

  for (const r of records) {
    const key = clusterKey(r.title);
    if (!key) continue;
    const cur = groups.get(key) ?? { label: r.title, count: 0, pass: 0 };
    cur.count += 1;
    if (r.outcome === "pass") cur.pass += 1;
    groups.set(key, cur);
  }

  const routineNames = new Set(listRoutines().map((r) => r.name));

  const clusters: TaskCluster[] = [];
  for (const [key, g] of groups.entries()) {
    const passRate = g.count > 0 ? g.pass / g.count : 0;
    const hasRoutine = [...routineNames].some((n) => slugify(n).includes(key) || key.includes(slugify(n)));
    let stage: MaturityStage = "novel";
    if (hasRoutine) stage = "routine";
    else if (g.count >= CODE_THRESHOLD && passRate >= PASS_RATE_FLOOR) stage = "code";
    else if (g.count >= ROUTINE_THRESHOLD && passRate >= PASS_RATE_FLOOR) stage = "repetitive";
    clusters.push({ key, label: g.label, count: g.count, passRate, stage, hasRoutine });
  }

  return clusters.sort((a, b) => b.count - a.count);
}

export function promotionSuggestions(): { label: string; from: MaturityStage; to: MaturityStage; reason: string }[] {
  const suggestions: { label: string; from: MaturityStage; to: MaturityStage; reason: string }[] = [];
  for (const c of clusterTasks(readTrackRecords())) {
    if (c.stage === "repetitive") {
      suggestions.push({
        label: c.label,
        from: "repetitive",
        to: "routine",
        reason: `${c.count} passes at ${(c.passRate * 100).toFixed(0)}% — stable enough to become a routine`,
      });
    } else if (c.stage === "code") {
      suggestions.push({
        label: c.label,
        from: "routine",
        to: "code",
        reason: `${c.count} passes at ${(c.passRate * 100).toFixed(0)}% — routine is trivial enough to become code`,
      });
    }
  }
  return suggestions;
}

export function promoteToRoutine(label: string): { routine?: string; reason?: string } {
  const clusters = clusterTasks(readTrackRecords());
  const cluster = clusters.find((c) => c.label === label);
  if (!cluster) return { reason: `no task cluster "${label}" found` };
  if (cluster.stage !== "repetitive") {
    return { reason: `"${label}" is [${cluster.stage}], not [repetitive] — nothing to promote` };
  }
  if (cluster.hasRoutine || routineExists(slugify(label))) {
    return { reason: `a routine for "${label}" already exists` };
  }
  const name = slugify(label);
  const trigger = label.toLowerCase().split(/\s+/).filter((w) => w.length > 3).join(" ");
  createRoutine({
    name,
    description: `Auto-promoted from repeated work: ${label}`,
    trigger,
    steps: ["Understand the task context", "Read any accumulated lessons for this work", "Execute the task", "Run the verification command", "Report the result"],
    verification: "bun test",
    parallel: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  return { routine: name };
}

export function renderMaturity(): string {
  const clusters = clusterTasks(readTrackRecords());
  const suggestions = promotionSuggestions();
  const lines: string[] = [];
  lines.push("═══ SERF MATURITY LADDER ═══════════════════════");
  lines.push("  novel → repetitive → routine → code");
  lines.push("");
  if (clusters.length === 0) {
    lines.push("  (no completed tasks yet — the ladder is empty)");
    return lines.join("\n");
  }
  for (const c of clusters) {
    const icon = c.stage === "code" ? "⚙" : c.stage === "routine" ? "↻" : c.stage === "repetitive" ? "◆" : "·";
    lines.push(`  ${icon} ${c.label.slice(0, 40)} — ${c.count}x @ ${(c.passRate * 100).toFixed(0)}% [${c.stage}]`);
  }
  if (suggestions.length > 0) {
    lines.push("");
    lines.push("  Promotions ready:");
    for (const s of suggestions) {
      lines.push(`    ↑ ${s.label.slice(0, 40)}: ${s.from} → ${s.to} (${s.reason})`);
    }
  }
  return lines.join("\n");
}
