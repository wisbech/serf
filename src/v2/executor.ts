import { spawn, type ChildProcess, execSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../state";
import type { SerfIdentity } from "./serf";
import type { Card } from "./board";

export interface ExecResult {
  output: string;
  ok: boolean;
  warnings: string[];
  agent: string;
}

export interface AgentSpec {
  name: string;
  command: string;
  args: (promptFile: string, cwd: string) => string[];
  headless: boolean;
}

const AGENTS: Record<string, AgentSpec> = {
  claude: {
    name: "claude",
    command: "claude",
    args: (promptFile, _cwd) => ["--print", "$(cat '" + promptFile + "')"],
    headless: true,
  },
  opencode: {
    name: "opencode",
    command: "opencode",
    args: (promptFile, _cwd) => ["run", "$(cat '" + promptFile + "')"],
    headless: true,
  },
  aider: {
    name: "aider",
    command: "aider",
    args: (promptFile, _cwd) => ["--message", "$(cat '" + promptFile + "')", "--yes-always"],
    headless: true,
  },
  pi: {
    name: "pi",
    command: "pi",
    args: (promptFile, _cwd) => ["--print", "$(cat '" + promptFile + "')"],
    headless: true,
  },
  hermes: {
    name: "hermes",
    command: "hermes",
    args: (promptFile, _cwd) => ["chat", "-q", "$(cat '" + promptFile + "')", "-Q"],
    headless: true,
  },
  codex: {
    name: "codex",
    command: "codex",
    args: (promptFile, _cwd) => ["--print", "$(cat '" + promptFile + "')"],
    headless: true,
  },
  cursor: {
    name: "cursor",
    command: "cursor",
    args: (_promptFile, cwd) => [cwd],
    headless: false,
  },
  code: {
    name: "code",
    command: "code",
    args: (_promptFile, cwd) => [cwd],
    headless: false,
  },
};

export function listAgents(): string[] {
  return Object.keys(AGENTS);
}

export function isHeadless(agent: string): boolean {
  return AGENTS[agent]?.headless ?? false;
}

export function buildAgentPrompt(card: Card, serf: SerfIdentity, feedback: string, attempt: number): string {
  const name = serf.name || "actor";
  let prompt = `You are ${name} in a dark factory.

## Your Role
Execute the task. Read the .serf/ folder to understand context. Do the work. Write results.

## Before You Execute — Write a Plan
Write a step-by-step plan to .serf/board/in-progress/${card.id}-plan.md. Reference the acceptance criteria. If a step is risky or uncertain, say so. The critic will read this plan. If you've already written one (check for the file), skip this and execute.

## The Folder
You are in a project with a .serf/ folder — this IS the factory state:
- .serf/plan.md — project mission and direction
- .serf/serfs/${name}.md — your identity
- .serf/serfs/critic.md — who will evaluate your work (be adversarial, don't be lenient)
- .serf/knowledge/skills/ — what works (read before starting)
- .serf/knowledge/patterns/ — recurring solutions
- .serf/knowledge/failures/ — what didn't work (avoid repeating)
- .serf/knowledge/references/ — research findings from past curiosities
- .serf/board/ — the kanban (your card is in-progress)

## Your Workspace
Your private state is at .serf/workspaces/${name}/.serf/. Write your working state there:
- last-state.md — what you did, what's next
- context.md — your working context, decisions made, why
The critic can read your workspace for transparency — this helps it understand your reasoning, not to police you.

## Installation Rules
- Install dependencies only via the project's package manager (bun/npm/pip/cargo).
- Never run \`curl | bash\` or \`wget | sh\`.
- Never write to ~/.ssh, ~/.config, ~/.local, /usr/, or /opt/.
- Never install global packages. Use devDependencies or local installs only.
- If a package is missing, add it to the project manifest and install locally.

## After Completing
1. Write what you learned to .serf/knowledge/skills/ (if it worked) or .serf/knowledge/failures/ (if it didn't)
2. Update your workspace .serf/workspaces/${name}/.serf/last-state.md with what you did
3. Append to .serf/events/ as JSON: {"type":"task.completed","card":"${card.id}","ts":"<ISO>"}

---

TASK:
${card.task}

ACCEPTANCE CRITERIA:
${card.acceptance.map(a => `- ${a}`).join("\n")}`;

  if (card.context) {
    prompt += `\n\nCONTEXT (from previous work):\n${card.context}`;
  }

  if (feedback) {
    prompt += `\n\nCRITIC FEEDBACK (previous attempt was rejected):\n${feedback}`;
  }

  prompt += `\n\nThis is attempt ${attempt} of 3. Do the work autonomously.`;

  return prompt;
}

export function buildCriticAgentPrompt(card: Card, output: string, _attempt: number): string {
  return `You are the critic in a dark factory.

## Your Identity
Read .serf/serfs/critic.md — that is who you are. Adopt that persona.

## Your Memory
Read these before evaluating:
- .serf/board/in-progress/${card.id}-plan.md — the actor's plan (if it exists). Check if they followed it.
- .serf/workspaces/actor/.serf/last-state.md — what the actor did last (transparency — understand their reasoning)
- .serf/workspaces/actor/.serf/context.md — the actor's working context (why they made choices)
- .serf/knowledge/failures/ — past failures. Don't repeat the leniency that caused them.
- .serf/knowledge/patterns/ — curiosity points from previous evaluations.
- .serf/knowledge/references/ — research findings from past curiosities.
- .serf/events/ — recent critic verdicts. Are you drifting lenient or harsh?

## Your Workspace
Your private state is at .serf/workspaces/critic/.serf/. Write your verdicts and calibration there:
- last-state.md — what you evaluated last
- calibration.md — your self-assessment history
- verdicts/ — your verdict log

## Your Job
Evaluate the actor's output against the task and its acceptance criteria. Explore adversarially — search for divergences between what was requested and what was delivered. But also explore curiously — notice where you are uncertain, where criteria are close to satisfied, where you can't tell.

If you are uncertain about something, say so explicitly. Uncertainty is information — it tells the system where to focus attention. If a criterion is almost satisfied but not quite, name the gap. If you see a recurring pattern across evaluations, name it — that's a system-level signal.

If you need more information to make a judgment, say what you need. You can ask the actor a question directly — they will respond, and that helps you converge.

## Your Output
Reason freely. Explore the output thoroughly. Then end with your verdict in this format:

VERDICT: pass | fail | uncertain
CONFIDENCE: 0.0 to 1.0
CURIOSITY: [list criteria or areas where you are uncertain — these become curiosity points]
REASONING: [your overall judgment in 1-2 sentences]

"uncertain" means you cannot converge — the output is borderline and you need either the actor to clarify or the user to decide. Use it sparingly.

---

TASK:
${card.task}

ACCEPTANCE CRITERIA:
${card.acceptance.map((a, i) => `${i + 1}. ${a}`).join("\n")}

OUTPUT TO EVALUATE:
${output}`;
}

export function buildCriticFollowupPrompt(criticQuestion: string): string {
  return `The critic has a question about your work. Answer it directly and honestly. If you need to show evidence from your output, quote it. If you made a mistake, say so.

CRITIC'S QUESTION:
${criticQuestion}

Respond with your answer. Do not redo the entire task — just address the question.`;
}

export function buildCriticResolvePrompt(actorResponse: string): string {
  return `The actor responded to your question. Read their response and give your final verdict.

ACTOR'S RESPONSE:
${actorResponse}

Now give your final verdict:

VERDICT: pass | fail | uncertain
CONFIDENCE: 0.0 to 1.0
CURIOSITY: [remaining uncertainties, if any]
REASONING: [your judgment in 1-2 sentences]`;
}

export async function spawnAgent(
  prompt: string,
  opts: { serf?: SerfIdentity; cwd?: string; timeoutMs?: number; agent?: string; terminal?: string; model?: string },
): Promise<ExecResult> {
  const config = loadConfig();
  const agentName = opts.agent ?? config?.agent ?? "claude";
  const terminal = opts.terminal ?? config?.terminal ?? "ghostty";
  const cwd = opts.cwd ?? process.cwd();
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const model = opts.model ?? opts.serf?.model ?? config?.model;

  const spec = AGENTS[agentName];
  if (!spec) {
    return { output: "", ok: false, warnings: [`unknown agent: ${agentName}`], agent: agentName };
  }

  const promptFile = join(tmpdir(), `serf-prompt-${Date.now()}.md`);
  const outputFile = join(tmpdir(), `serf-output-${Date.now()}.md`);
  writeFileSync(promptFile, prompt);

  const warnings: string[] = [];

  if (spec.headless) {
    const result = await runHeadless(spec, promptFile, outputFile, cwd, terminal, timeoutMs, model);
    try { unlinkSync(promptFile); } catch {}
    try { unlinkSync(outputFile); } catch {}
    return { ...result, agent: agentName };
  } else {
    const result = await runInteractive(spec, promptFile, outputFile, cwd, terminal, timeoutMs);
    try { unlinkSync(promptFile); } catch {}
    try { unlinkSync(outputFile); } catch {}
    return { ...result, agent: agentName };
  }
}

function buildAgentArgs(spec: AgentSpec, promptFile: string, model?: string): string {
  const modelFlag = model ? `--model ${model}` : "";
  switch (spec.name) {
    case "claude":
      return `--print "$(cat '${promptFile}')" ${modelFlag}`;
    case "opencode":
      return `run "$(cat '${promptFile}')" ${modelFlag ? `-m ${model}` : ""}`;
    case "aider":
      return `--message "$(cat '${promptFile}')" --yes-always ${modelFlag}`;
    case "pi":
      return `--print "$(cat '${promptFile}')" ${modelFlag}`;
    case "hermes":
      return `chat -q "$(cat '${promptFile}')" -Q ${model ? `-m ${model}` : ""}`;
    case "codex":
      return `--print "$(cat '${promptFile}')" ${modelFlag}`;
    default:
      return spec.args(promptFile, "").join(" ");
  }
}

async function runHeadless(
  spec: AgentSpec,
  promptFile: string,
  outputFile: string,
  cwd: string,
  terminal: string,
  timeoutMs: number,
  model?: string,
): Promise<ExecResult> {
  const warnings: string[] = [];
  const wrapperScript = join(tmpdir(), `serf-exec-${Date.now()}.sh`);
  const promptContent = readFileSync(promptFile, "utf-8");
  const escapedPrompt = promptContent.replace(/'/g, "'\\''");

  // Build agent args based on the spec — read prompt from file at runtime
  const agentArgs = buildAgentArgs(spec, promptFile, model);
  const script = `#!/bin/zsh
cd "${cwd}"
${spec.command} ${agentArgs} 2>&1 | tee '${outputFile}'
echo "SERF_DONE_EXIT_CODE=$?" >> '${outputFile}'
`;

  writeFileSync(wrapperScript, script);
  execSync(`chmod +x '${wrapperScript}'`);

  // Launch in a visible terminal window
  const child = launchInTerminal(terminal, wrapperScript);

  if (!child) {
    warnings.push(`failed to launch terminal: ${terminal}`);
    return { output: "", ok: false, warnings };
  }

  const output = await waitForOutputFile(outputFile, timeoutMs);

  try { unlinkSync(wrapperScript); } catch {}

  if (!output) {
    warnings.push("no output produced (timeout or agent failed to start)");
    return { output: "", ok: false, warnings };
  }

  const exitMatch = output.match(/SERF_DONE_EXIT_CODE=(\d+)/);
  const exitCode = exitMatch ? parseInt(exitMatch[1]) : 0;
  const cleanOutput = output.replace(/SERF_DONE_EXIT_CODE=\d+\s*$/, "").trim();

  if (exitCode !== 0) warnings.push(`agent exited with code ${exitCode}`);

  return { output: cleanOutput, ok: cleanOutput.length > 0, warnings };
}

async function runInteractive(
  spec: AgentSpec,
  promptFile: string,
  outputFile: string,
  cwd: string,
  terminal: string,
  timeoutMs: number,
): Promise<ExecResult> {
  const warnings: string[] = [];
  const wrapperScript = join(tmpdir(), `serf-exec-${Date.now()}.sh`);

  // For interactive agents (cursor, code), launch the editor with a setup that
  // writes a sentinel file when the user closes it
  const script = `#!/bin/zsh
cd "${cwd}"
echo "SERF: Launching ${spec.command} for task..."
echo "SERF: Read the task prompt at: ${promptFile}"
echo ""
${spec.command} ${spec.args(promptFile, cwd).join(" ")} 2>&1
echo "SERF_AGENT_CLOSED=$?" >> '${outputFile}'
echo "SERF_DONE" >> '${outputFile}'
`;

  writeFileSync(wrapperScript, script);
  execSync(`chmod +x '${wrapperScript}'`);

  const child = launchInTerminal(terminal, wrapperScript);

  if (!child) {
    warnings.push(`failed to launch terminal: ${terminal}`);
    return { output: "", ok: false, warnings };
  }

  // For interactive agents, wait for the sentinel file
  const output = await waitForOutputFile(outputFile, timeoutMs, "SERF_DONE");

  try { unlinkSync(wrapperScript); } catch {}

  if (!output) {
    warnings.push("interactive agent session ended without completion marker");
    // Try to read the prompt file as the "output" — the user may have done work in the editor
    return { output: `Interactive ${spec.name} session completed. Check the project directory for changes.`, ok: true, warnings };
  }

  return { output: `Interactive ${spec.name} session completed.`, ok: true, warnings };
}

function launchInTerminal(terminal: string, scriptPath: string): ChildProcess | null {
  if (terminal === "ghostty") {
    return spawn("open", ["-na", "Ghostty.app", "--args", "-e", scriptPath], {
      detached: true,
      stdio: "ignore",
    });
  }

  if (terminal === "terminal" || terminal === "apple_terminal") {
    return spawn("open", ["-a", "Terminal", scriptPath], {
      detached: true,
      stdio: "ignore",
    });
  }

  if (terminal === "iterm" || terminal === "iterm2") {
    const script = `tell application "iTerm"
      create window with default profile
      tell current session of current window
        write text "zsh '${scriptPath}'"
      end tell
    end tell`;
    return spawn("osascript", ["-e", script], {
      detached: true,
      stdio: "ignore",
    });
  }

  if (terminal === "tmux") {
    return spawn("tmux", ["new-window", `bash ${scriptPath}`], {
      detached: true,
      stdio: "ignore",
    });
  }

  // Fallback: run in background
  return spawn("bash", [scriptPath], {
    detached: true,
    stdio: "ignore",
  });
}

async function waitForOutputFile(
  outputFile: string,
  timeoutMs: number,
  doneMarker?: string,
): Promise<string> {
  const start = Date.now();
  let lastSize = 0;
  let stableCount = 0;

  while (Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 2000));

    if (!existsSync(outputFile)) continue;

    const content = readFileSync(outputFile, "utf-8");

    if (doneMarker && content.includes(doneMarker)) {
      return content;
    }

    if (content.includes("SERF_DONE_EXIT_CODE=")) {
      return content;
    }

    // Stability check — file stopped growing for 10s
    if (content.length === lastSize && content.length > 0) {
      stableCount++;
      if (stableCount >= 5) {
        return content;
      }
    } else {
      stableCount = 0;
      lastSize = content.length;
    }
  }

  if (existsSync(outputFile)) {
    return readFileSync(outputFile, "utf-8");
  }

  return "";
}