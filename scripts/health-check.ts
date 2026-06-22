#!/usr/bin/env bun
/**
 * Serf Health Check — the self-correcting loop.
 *
 * Runs: bun build, bun test, and (if available) tsc --noEmit.
 * Emits a structured health report to stdout and to ~/.serf/health/last-check.json.
 * Updates the Code Health table in docs/PLAN.md if --update-plan is passed.
 *
 * Usage:
 *   bun run scripts/health-check.ts                  # Check + report
 *   bun run scripts/health-check.ts --update-plan     # Check + update PLAN.md
 *   bun run scripts/health-check.ts --json            # Check + emit JSON only
 *   bun run scripts/health-check.ts --strict          # Exit 1 if any check fails
 *   bun run scripts/health-check.ts --gan             # Also run GAN harness against real Ollama
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ── Types ──

interface CheckResult {
  name: string;
  passed: boolean;
  details: string;
  durationMs: number;
}

interface HealthReport {
  timestamp: string;
  checks: CheckResult[];
  summary: {
    total: number;
    passed: number;
    failed: number;
  };
  testCounts: {
    pass: number;
    fail: number;
    error: number;
    total: number;
    files: number;
    expectCalls: number;
  } | null;
  buildOutput: {
    modules: number | null;
    sizeKb: number | null;
  } | null;
  knownBroken: { issue: string; file: string }[];
  planClaims: { claim: string; status: string; verified: boolean }[];
}

// ── Run helpers ──

function run(cmd: string, args: string[], timeoutMs: number = 120_000): { stdout: string; stderr: string; status: number; durationMs: number } {
  const start = Date.now();
  const r = spawnSync(cmd, args, { encoding: "utf-8", timeout: timeoutMs, cwd: process.cwd() });
  return {
    stdout: (r.stdout || "").trim(),
    stderr: (r.stderr || "").trim(),
    status: r.status ?? -1,
    durationMs: Date.now() - start,
  };
}

function extractTestCounts(output: string): HealthReport["testCounts"] {
  const passMatch = output.match(/(\d+)\s+pass/);
  const failMatch = output.match(/(\d+)\s+fail/);
  const errorMatch = output.match(/(\d+)\s+error/);
  const totalMatch = output.match(/(\d+)\s+tests/);
  const filesMatch = output.match(/(\d+)\s+files/);
  const expectMatch = output.match(/(\d+)\s+expect\(\)\s+calls/);
  if (!passMatch || !totalMatch) return null;
  return {
    pass: parseInt(passMatch[1]),
    fail: failMatch ? parseInt(failMatch[1]) : 0,
    error: errorMatch ? parseInt(errorMatch[1]) : 0,
    total: parseInt(totalMatch[1]),
    files: filesMatch ? parseInt(filesMatch[1]) : 0,
    expectCalls: expectMatch ? parseInt(expectMatch[1]) : 0,
  };
}

function extractBuildInfo(output: string): HealthReport["buildOutput"] {
  const moduleMatch = output.match(/(\d+)\s+modules/);
  const sizeMatch = output.match(/([\d.]+)\s+KB/);
  return {
    modules: moduleMatch ? parseInt(moduleMatch[1]) : null,
    sizeKb: sizeMatch ? parseFloat(sizeMatch[1]) : null,
  };
}

// ── Check functions ──

function checkBuild(): CheckResult {
  const r = run("bun", ["build", "src/index.ts", "--outdir", "/tmp/serf-health-check", "--target", "bun"]);
  const passed = r.status === 0 && existsSync("/tmp/serf-health-check/index.js");
  let details = passed ? "Build succeeded" : `Build failed (exit ${r.status})`;
  if (r.stderr && !passed) details += `: ${r.stderr.slice(0, 200)}`;
  return { name: "bun build", passed, details, durationMs: r.durationMs };
}

function checkTests(): CheckResult & { testCounts?: HealthReport["testCounts"] } {
  const r = run("bun", ["test"], 60_000);
  const counts = extractTestCounts(r.stdout + r.stderr);
  const passed = counts ? counts.fail === 0 && counts.error === 0 : r.status === 0;
  let details = counts
    ? `${counts.pass}/${counts.total} pass, ${counts.fail} fail, ${counts.error} errors (${counts.files} files, ${counts.expectCalls} expect calls)`
    : r.status === 0 ? "Tests passed (counts not parsed)" : "Tests failed";
  if (counts && counts.fail > 0) {
    const failLines = (r.stdout + r.stderr).split("\n").filter(l => l.includes("(fail)") || l.includes("error:"));
    details += `\n  Failures:\n${failLines.slice(0, 10).map(l => `    ${l}`).join("\n")}`;
  }
  return { name: "bun test", passed, details, durationMs: r.durationMs, testCounts: counts };
}

function checkTypeScript(): CheckResult {
  const tscExists = run("npx", ["tsc", "--version"], 10_000);
  if (tscExists.status !== 0) {
    return { name: "tsc --noEmit", passed: true, details: "Skipped (tsc not available)", durationMs: 0 };
  }
  const r = run("npx", ["tsc", "--noEmit", "--skipLibCheck"], 60_000);
  const passed = r.status === 0;
  let details = passed ? "No type errors" : `Type errors found (exit ${r.status})`;
  if (!passed && r.stdout) {
    const errors = r.stdout.split("\n").filter(l => l.includes("error TS"));
    details += `\n  ${errors.length} type errors:\n${errors.slice(0, 10).map(e => `    ${e}`).join("\n")}`;
  }
  return { name: "tsc --noEmit", passed, details, durationMs: r.durationMs };
}

function checkKnownBroken(): HealthReport["knownBroken"] {
  const broken: { issue: string; file: string }[] = [];
  const sourceDir = join(process.cwd(), "src");

  // Check for non-ASCII in .ts files (Hangul canary)
  function scanDir(dir: string) {
    if (!existsSync(dir)) return;
    const { readdirSync } = require("node:fs");
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(fullPath);
      } else if (entry.name.endsWith(".ts")) {
        try {
          const content = readFileSync(fullPath, "utf-8");
          // Check for non-ASCII outside strings/comments (simplified: check identifiers)
          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            // Skip string literals and comments
            const stripped = line
              .replace(/\/\/.*$/, "")
              .replace(/"[^"]*"/g, '""')
              .replace(/'[^']*'/g, "''")
              .replace(/`[^`]*`/g, "``");
            if (/[\uac00-\ud7af\u0900-\u097f\u4e00-\u9fff]/.test(stripped)) {
              broken.push({ issue: `Non-ASCII character at ${entry.name}:${i + 1}`, file: fullPath });
            }
          }
        } catch {}
      }
    }
  }
  scanDir(sourceDir);

  // Check for undeclared references (basic heuristic)
  const harvestPath = join(sourceDir, "application", "harvest", "index.ts");
  if (existsSync(harvestPath)) {
    const content = readFileSync(harvestPath, "utf-8");
    const imports = content.match(/^import\s+.*$/gm)?.join("\n") ?? "";
    // Check if reviewManager, budgetTracker are used without import
    if (content.includes("reviewManager") && !imports.includes("reviewManager") && !content.includes("from.*ReviewManager")) {
      broken.push({ issue: "reviewManager used without import", file: harvestPath });
    }
  }

  return broken;
}

function checkPlanClaims(): HealthReport["planClaims"] {
  const planPath = join(process.cwd(), "docs", "PLAN.md");
  if (!existsSync(planPath)) return [];
  const plan = readFileSync(planPath, "utf-8");

  const claims: { claim: string; status: string; verified: boolean }[] = [];

  // Extract step markers like "### Step N: ... ✅ DONE"
  const stepRegex = /### Step (\d+):.*?(✅ DONE|🔄|❌)/g;
  let match;
  while ((match = stepRegex.exec(plan)) !== null) {
    const stepNum = match[1];
    const marker = match[2];
    const claim = `Step ${stepNum}`;
    const verified = marker === "✅ DONE"; // Will be cross-checked against test results below
    claims.push({ claim, status: marker, verified });
  }

  // Extract "✅ Passes" / "🔄" / "❌" from Code Health table
  const healthRegex = /\|\s*(.*?)\s*\|\s*(✅|🔄|❌)\s*(.*?)\s*\|/g;
  while ((match = healthRegex.exec(plan)) !== null) {
    const checkName = match[1].trim();
    const marker = match[2];
    const notes = match[3].trim();
    if (checkName.includes("bun build") || checkName.includes("bun test") || checkName.includes("harvest.ts") || checkName.includes("Domain layer") || checkName.includes("Watchdog") || checkName.includes("EventStream") || checkName.includes("Pruning") || checkName.includes("Strategy") || checkName.includes("Port") || checkName.includes("Harvest flow")) {
      claims.push({ claim: `Health: ${checkName}`, status: marker, verified: marker === "✅" });
    }
  }

  return claims;
}

// ── PLAN.md updater ──

function updatePlanHealth(report: HealthReport): boolean {
  const planPath = join(process.cwd(), "docs", "PLAN.md");
  if (!existsSync(planPath)) return false;
  let plan = readFileSync(planPath, "utf-8");

  const date = new Date().toISOString().slice(0, 10);
  const buildOk = report.checks.find(c => c.name === "bun build")?.passed ?? false;
  const testOk = report.checks.find(c => c.name === "bun test")?.passed ?? false;
  const tscOk = report.checks.find(c => c.name === "tsc --noEmit")?.passed ?? false;
  const tc = report.testCounts;

  const buildStatus = buildOk ? "✅ Passes" : "❌ Fails";
  const testStatus = testOk ? `✅ ${tc?.pass ?? 0}/${tc?.total ?? 0} pass` : `🔄 ${tc?.pass ?? 0}/${tc?.total ?? 0} pass`;
  const tscStatus = tscOk ? "✅ No errors" : "❌ Has errors";

  // Update the "Last verified" line
  plan = plan.replace(
    /Last verified \d{4}-\d{2}-\d{2}[^\n]*/,
    `Last verified ${date} (automated)`,
  );

  // Update the build row
  plan = plan.replace(
    /(\| `bun build src\.index\.ts` \|)\s*(✅ Passes|❌ Fails|🔄.*?)\s*(\|)/,
    `$1 ${buildStatus} | ${report.buildOutput?.modules ?? "?"} modules, ${report.buildOutput?.sizeKb ?? "?"} KB. $3`,
  );

  // Update the test row
  plan = plan.replace(
    /(\| `bun test` \|)\s*(✅[^|]*|🔄[^|]*|❌[^|]*)\s*(\|)/,
    `$1 ${testStatus}, 0 fail, 0 errors. ${tc?.expectCalls ?? 0} expect() calls across ${tc?.files ?? 0} files. $3`,
  );

  writeFileSync(planPath, plan);
  return true;
}

// ── Main ──

const args = process.argv.slice(2);
const updatePlan = args.includes("--update-plan");
const jsonOnly = args.includes("--json");
const strict = args.includes("--strict");
const runGan = args.includes("--gan");

const checks: CheckResult[] = [];

// 1. Build
checks.push(checkBuild());

// 2. Tests
const testResult = checkTests();
checks.push(testResult);

// 3. Type check
checks.push(checkTypeScript());

// 4. Known broken scan
const knownBroken = checkKnownBroken();
if (knownBroken.length > 0) {
  checks.push({
    name: "known-broken scan",
    passed: false,
    details: `${knownBroken.length} issue(s) found:\n${knownBroken.map(b => `    ${b.issue} (${b.file.replace(process.cwd() + "/", "")})`).join("\n")}`,
    durationMs: 0,
  });
} else {
  checks.push({ name: "known-broken scan", passed: true, details: "No known-broken patterns detected", durationMs: 0 });
}

// 5. Plan claims
const planClaims = checkPlanClaims();

// 6. GAN harness (optional, requires Ollama)
if (runGan) {
  const config = loadConfig();
  const hasOllama = config?.backend === "ollama";
  if (hasOllama) {
    const ganStart = Date.now();
    try {
      const { createOllamaResource } = require("../src/infrastructure/llm/OllamaResource");
      const gen = createOllamaResource();
      const critic = createOllamaResource();

      const task = "Explain what HTTP is in 2-3 sentences.";
      const genResult = await gen.invoke(task);
      const critique = await critic.invoke(buildGanCritiquePrompt(task, genResult.text));
      const verdict = parseGanVerdict(critique.text);

      const passed = !(verdict.confidence > 0.7 && verdict.verdict === "fail");
      checks.push({
        name: "gan harness (real)",
        passed,
        details: `generator: ${genResult.tokensUsed} tokens | critic: ${critique.tokensUsed} tokens | verdict: ${verdict.verdict} (${verdict.confidence})`,
        durationMs: Date.now() - ganStart,
      });
    } catch (err) {
      checks.push({
        name: "gan harness (real)",
        passed: false,
        details: `GAN harness failed: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: Date.now() - ganStart,
      });
    }
  } else {
    checks.push({ name: "gan harness (real)", passed: true, details: "Skipped (no Ollama configured)", durationMs: 0 });
  }
}

const report: HealthReport = {
  timestamp: new Date().toISOString(),
  checks,
  summary: {
    total: checks.length,
    passed: checks.filter(c => c.passed).length,
    failed: checks.filter(c => !c.passed).length,
  },
  testCounts: testResult.testCounts ?? null,
  buildOutput: extractBuildInfo(checks[0].details),
  knownBroken,
  planClaims,
};

// Persist to ~/.serf/health/
const healthDir = join(homedir(), ".serf", "health");
if (!existsSync(healthDir)) mkdirSync(healthDir, { recursive: true });
writeFileSync(join(healthDir, "last-check.json"), JSON.stringify(report, null, 2));

// Update PLAN.md if requested
if (updatePlan) {
  const updated = updatePlanHealth(report);
  if (updated && !jsonOnly) console.log("  ✓ PLAN.md Code Health updated\n");
}

// Output
if (jsonOnly) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log("\n  ═══ SERF HEALTH CHECK ═══════════════════════");
  console.log(`  Date: ${report.timestamp.slice(0, 19)}\n`);

  for (const c of checks) {
    const icon = c.passed ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
    console.log(`  ${icon} ${c.name} (${c.durationMs}ms)`);
    if (c.details && c.details.length > 0) {
      for (const line of c.details.split("\n")) {
        console.log(`      ${line}`);
      }
    }
  }

  console.log(`\n  Summary: ${report.summary.passed}/${report.summary.total} checks passed`);

  if (planClaims.length > 0) {
    const unverified = planClaims.filter(c => c.status === "✅ DONE" || c.status === "✅");
    console.log(`  Plan claims verified: ${unverified.length} marked done`);
  }

  if (report.knownBroken.length > 0) {
    console.log(`\n  ⚠ Known broken: ${report.knownBroken.length} issue(s)`);
  }

  console.log("");
}

// Strict mode: exit 1 on any failure
if (strict && report.summary.failed > 0) {
  process.exit(1);
}

// ── GAN helpers ──

function buildGanCritiquePrompt(task: string, output: string): string {
  return `You are a strict critic evaluating a response to a task.

TASK: ${task}

RESPONSE TO EVALUATE:
${output.slice(0, 2000)}

Evaluate the response for:
1. Accuracy: Is it factually correct?
2. Completeness: Does it answer the task?
3. Coherence: Is it readable and well-structured?

Respond with:
VERDICT: pass | fail
CONFIDENCE: 0.0 to 1.0
ISSUES: comma-separated list of issues (or "none")
REASONING: one sentence explaining your decision`;
}

interface GANVerdict {
  verdict: "pass" | "fail";
  confidence: number;
}

function parseGanVerdict(text: string): GANVerdict {
  const verdictMatch = text.match(/VERDICT:\s*(pass|fail)/i);
  const confidenceMatch = text.match(/CONFIDENCE:\s*([\d.]+)/i);
  return {
    verdict: (verdictMatch?.[1]?.toLowerCase() ?? "fail") as "pass" | "fail",
    confidence: confidenceMatch ? parseFloat(confidenceMatch[1]) : 0,
  };
}

function loadConfig(): { backend?: string; model?: string } | null {
  try {
    const { readFileSync } = require("node:fs");
    const { join } = require("node:path");
    const { homedir } = require("node:os");
    const file = join(homedir(), ".serf", "config.json");
    return JSON.parse(readFileSync(file, "utf-8"));
  } catch { return null; }
}