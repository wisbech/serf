import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, unlinkSync, createWriteStream, watch, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { buildInvocation, buildInteractiveInvocation } from "./agent-command";
import type { SandboxProfile } from "./sandbox";
import { loadConfig } from "./state";
import { getSerfDir, ensureDir } from "./paths";
import * as herdr from "./herdr-client";

export interface RunOpts {
  cwd: string;
  timeoutMs: number;
  outputFile: string;
  profile?: SandboxProfile;
  label?: string;
}

export interface ActorRunResult {
  output: string;
  tokensUsed: number;
  ok: boolean;
}

export interface Transport {
  run(prompt: string, opts: RunOpts): Promise<ActorRunResult>;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function serfTmp(): string {
  const dir = join(getSerfDir(), "tmp");
  ensureDir(dir);
  return dir;
}

function buildWrapperScript(
  command: string,
  args: string[],
  promptViaStdin: boolean,
  prompt: string,
  cwd: string,
  outputFile: string,
): string {
  const escapedPrompt = prompt.replace(/'/g, "'\\''");
  const argStr = args.map((a) => JSON.stringify(a)).join(" ");

  if (promptViaStdin) {
    return `#!/bin/bash
cd "${cwd}"
${JSON.stringify(command)} ${argStr} <<'PROMPT' 2>&1 | tee "${outputFile}"
${escapedPrompt}
PROMPT
echo "SERF_DONE_EXIT_CODE=$?" >> "${outputFile}"
`;
  }

  const promptContent = readFileSync;
  return `#!/bin/zsh
cd "${cwd}"
${JSON.stringify(command)} ${argStr} 2>&1 | tee "${outputFile}"
echo "SERF_DONE_EXIT_CODE=$?" >> "${outputFile}"
`;
}

function buildPromptArg(prompt: string): string {
  return prompt.replace(/'/g, "'\\''");
}

function buildScriptWithInlinePrompt(
  command: string,
  args: string[],
  prompt: string,
  cwd: string,
  outputFile: string,
): string {
  const escapedPrompt = buildPromptArg(prompt);
  const argStr = args.map((a) => JSON.stringify(a)).join(" ");
  return `#!/bin/zsh
cd "${cwd}"
${JSON.stringify(command)} ${argStr} '${escapedPrompt}' 2>&1 | tee "${outputFile}"
echo "SERF_DONE_EXIT_CODE=$?" >> "${outputFile}"
`;
}

async function waitForOutputFile(
  outputFile: string,
  _timeoutMs: number,
  doneMarker = "SERF_DONE_EXIT_CODE",
  paneId?: string,
): Promise<string> {
  const markers = [doneMarker, "SERF_TASK_DONE", "SERF_DONE_EXIT_CODE"];
  let lastSize = 0;
  let lastChange = Date.now();
  const STALE_THRESHOLD_MS = 300_000;
  const CHECK_INTERVAL_MS = 10_000;

  return new Promise<string>((resolve) => {
    let resolved = false;
    let watcher: any = null;

    function finish(content: string) {
      if (resolved) return;
      resolved = true;
      if (watcher) watcher.close();
      clearInterval(interval);
      resolve(content);
    }

    function checkContent(): boolean {
      if (!existsSync(outputFile)) return false;
      const content = readFileSync(outputFile, "utf-8");
      if (markers.some((m) => content.includes(m))) {
        finish(content);
        return true;
      }
      if (content.length !== lastSize) {
        lastSize = content.length;
        lastChange = Date.now();
      }
      return false;
    }

    if (checkContent()) return;

    try {
      watcher = watch(dirname(outputFile), (eventType, filename) => {
        const baseName = outputFile.split("/").pop();
        if (!filename || !baseName || filename.includes(baseName) || baseName.includes(filename)) {
          checkContent();
        }
      });
      watcher.on("error", () => {
        finish(existsSync(outputFile) ? readFileSync(outputFile, "utf-8") : "");
      });
    } catch {}

    const interval = setInterval(async () => {
      if (resolved) { clearInterval(interval); return; }

      if (checkContent()) {
        clearInterval(interval);
        return;
      }

      if (paneId && Date.now() - lastChange > 30_000) {
        try {
          const { send } = await import("./herdr-client");
          const procInfo = await send("pane.process_info", { pane_id: paneId }, 5000);
          const procs = procInfo?.process_info?.foreground_processes ?? [];
          const hasAgent = procs.some((p: any) => {
            const name = (p.name || "").toLowerCase();
            return name !== "zsh" && name !== "bash" && name !== "sh" && name !== "fish";
          });
          if (!hasAgent) {
            console.log(`  → Agent process exited. Checking output...`);
            if (existsSync(outputFile)) {
              const content = readFileSync(outputFile, "utf-8");
              if (markers.some((m) => content.includes(m))) {
                finish(content);
              } else {
                finish(content + "\nSERF_TASK_DONE");
              }
            } else {
              finish("");
            }
            clearInterval(interval);
            return;
          }
        } catch {}
      }

      if (Date.now() - lastChange > STALE_THRESHOLD_MS) {
        if (existsSync(outputFile)) {
          finish(readFileSync(outputFile, "utf-8"));
        } else {
          finish("");
        }
      }
    }, CHECK_INTERVAL_MS);
  });
}

function parseOutput(raw: string): { output: string; ok: boolean } {
  const exitMatch = raw.match(/SERF_DONE_EXIT_CODE=(\d+)/);
  const exitCode = exitMatch ? parseInt(exitMatch[1]) : 0;
  const cleanOutput = raw.replace(/SERF_DONE_EXIT_CODE=\d+\s*$/, "").trim();
  return { output: cleanOutput, ok: cleanOutput.length > 0 && exitCode === 0 };
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

  const logFile = `${scriptPath}.log`;
  const child = spawn("bash", [scriptPath], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = createWriteStream(logFile);
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  child.unref();
  return child;
}

export class HeadlessTransport implements Transport {
  constructor(
    private terminal: string = "auto",
    private agentOverride?: string,
    private modelOverride?: string,
  ) {}

  async run(prompt: string, opts: RunOpts): Promise<ActorRunResult> {
    const config = loadConfig();
    const agentName = this.agentOverride ?? config?.actorAgent ?? config?.agent ?? "claude";
    const model = this.modelOverride ?? config?.actorModel ?? config?.model;
    const terminal = this.terminal === "auto" ? "fallback" : this.terminal;

    const invocation = buildInvocation(agentName, model);

    const wrapperScript = invocation.promptViaStdin
      ? buildWrapperScript(invocation.command, invocation.args, true, prompt, opts.cwd, opts.outputFile)
      : buildScriptWithInlinePrompt(invocation.command, invocation.args, prompt, opts.cwd, opts.outputFile);

    const scriptPath = join(serfTmp(), `serf-exec-${Date.now()}.sh`);
    writeFileSync(scriptPath, wrapperScript);
    try {
      // bun:execSync is sync; use chmod via spawn
      spawn("chmod", ["+x", scriptPath], { stdio: "ignore" });
    } catch {}

    const child = launchInTerminal(terminal, scriptPath);
    if (!child) {
      try { unlinkSync(scriptPath); } catch {}
      return { output: "", tokensUsed: 0, ok: false };
    }

    const raw = await waitForOutputFile(opts.outputFile, opts.timeoutMs);

    try { unlinkSync(scriptPath); } catch {}

    const { output, ok } = parseOutput(raw);
    return { output, tokensUsed: estimateTokens(output), ok };
  }
}

export class HerdrTransport implements Transport {
  private paneId: string | null = null;

  constructor(
    private workspaceId: string,
    private serfTabId?: string,
    private agentOverride?: string,
    private modelOverride?: string,
  ) {}

  async run(prompt: string, opts: RunOpts): Promise<ActorRunResult> {
    const config = loadConfig();
    const agentName = this.agentOverride ?? config?.actorAgent ?? config?.agent ?? "claude";
    const model = this.modelOverride ?? config?.actorModel ?? config?.model;

    const invocation = buildInteractiveInvocation(agentName, model);

    if (!this.paneId) {
      if (this.serfTabId) {
        const label = opts.label ?? "serf";
        const pane = await herdr.splitPaneInTab(this.serfTabId, "right", label);
        this.paneId = pane.pane_id;
      } else {
        const label = opts.label ?? "serf";
        const pane = await herdr.splitPane(this.workspaceId, "right", label);
        this.paneId = pane.pane_id;
      }
    }

    const promptFile = join(serfTmp(), `prompt-${Date.now()}.md`);
    writeFileSync(promptFile, prompt);

    let argStr = invocation.args.map((a) => JSON.stringify(a)).join(" ");
    if (agentName === "opencode" && model && config?.provider) {
      const providerModel = model.includes("/") ? model : `${config.provider}/${model}`;
      const fixedInv = buildInteractiveInvocation(agentName, providerModel);
      argStr = fixedInv.args.map((a) => JSON.stringify(a)).join(" ");
    }
    await herdr.sendCommand(this.paneId, `cd "${opts.cwd}" && ${agentName} ${argStr}`);
    await herdr.reportAgentState(this.paneId, agentName, "working", opts.label).catch(() => {});

    await new Promise((r) => setTimeout(r, 10_000));

    await herdr.sendCommand(this.paneId, `Read ${promptFile} and follow the instructions. Write your output to ${opts.outputFile} and end with SERF_TASK_DONE.`);

    const raw = await waitForOutputFile(opts.outputFile, opts.timeoutMs, "SERF_TASK_DONE", this.paneId);

    try { unlinkSync(promptFile); } catch {}

    const { output, ok } = parseOutput(raw);
    return { output, tokensUsed: estimateTokens(output), ok };
  }
}

export class FakeTransport implements Transport {
  public calls: Array<{ prompt: string; opts: RunOpts }> = [];
  public response: string = "Fake agent output.\nSERF_DONE_EXIT_CODE=0";

  async run(prompt: string, opts: RunOpts): Promise<ActorRunResult> {
    this.calls.push({ prompt, opts });
    return {
      output: this.response,
      tokensUsed: estimateTokens(this.response),
      ok: true,
    };
  }
}

// ── MASTER + CRITIC CONVERSATION ──

export interface ConversationResult {
  ok: boolean;
  cardsWritten: number;
  output: string;
}

/**
 * Tracks the mtime of master-proposal.md and reports whether it has been
 * written/updated since the last check. Used to kick the critic to review a
 * fresh proposal, since the critic is an interactive agent that only acts on
 * terminal input and does not watch the filesystem.
 */
export function makeProposalKicker(proposalFile: string) {
  let lastMtime = 0;
  try { lastMtime = existsSync(proposalFile) ? statSync(proposalFile).mtimeMs : 0; } catch {}
  return function shouldKick(): boolean {
    let mtime = 0;
    try { mtime = existsSync(proposalFile) ? statSync(proposalFile).mtimeMs : 0; } catch {}
    if (mtime > 0 && mtime !== lastMtime) {
      lastMtime = mtime;
      return true;
    }
    return false;
  };
}

export async function launchInteractiveMasterConversation(
  masterPrompt: string,
  criticPrompt: string,
  opts: { cwd: string; workspaceId?: string; rootPaneId?: string; serfTabId?: string; model?: string },
): Promise<ConversationResult> {
  const config = loadConfig();
  const masterAgent = config?.masterAgent ?? config?.agent ?? "claude";
  const criticAgent = config?.criticAgent ?? config?.agent ?? "claude";
  const masterModel = opts.model ?? config?.masterModel ?? config?.model;
  const criticModel = config?.criticModel ?? config?.model;

  const masterInv = buildInteractiveInvocation(masterAgent, masterModel);
  const criticInv = buildInteractiveInvocation(criticAgent, criticModel);

  const masterPromptFile = join(serfTmp(), "master-prompt.md");
  const criticPromptFile = join(serfTmp(), "critic-prompt.md");
  writeFileSync(masterPromptFile, masterPrompt);
  writeFileSync(criticPromptFile, criticPrompt);

  let masterArgStr = masterInv.args.map((a) => JSON.stringify(a)).join(" ");
  let criticArgStr = criticInv.args.map((a) => JSON.stringify(a)).join(" ");

  if (masterAgent === "opencode" && masterModel && config?.provider) {
    const providerModel = masterModel.includes("/") ? masterModel : `${config.provider}/${masterModel}`;
    const fixedInv = buildInteractiveInvocation(masterAgent, providerModel);
    masterArgStr = fixedInv.args.map((a) => JSON.stringify(a)).join(" ");
  }
  if (criticAgent === "opencode" && criticModel && config?.provider) {
    const providerModel = criticModel.includes("/") ? criticModel : `${config.provider}/${criticModel}`;
    const fixedInv = buildInteractiveInvocation(criticAgent, providerModel);
    criticArgStr = fixedInv.args.map((a) => JSON.stringify(a)).join(" ");
  }

  if (opts.workspaceId && opts.rootPaneId) {
    await herdr.labelPane(opts.rootPaneId, "master");

    const criticPane = await herdr.splitPane(opts.workspaceId, "right", "critic");
    const criticPaneId = criticPane.pane_id;

    await herdr.sendCommand(opts.rootPaneId, `cd "${opts.cwd}" && ${masterInv.command} ${masterArgStr}`);
    await herdr.sendCommand(criticPaneId, `cd "${opts.cwd}" && ${criticInv.command} ${criticArgStr}`);

    await new Promise((r) => setTimeout(r, 10_000));

    await herdr.sendCommand(opts.rootPaneId, `Read ${masterPromptFile} and follow those instructions. When you're ready, write tasks to the board. Keep running — the harness will pick up cards as you write them.`);
    await herdr.sendCommand(criticPaneId, `Read ${criticPromptFile} and follow those instructions.`);

    console.log(`  → Master launched in left pane, critic in right pane.`);
    console.log(`  → Master writes cards, harness picks them up immediately.`);
    console.log(`  → Talk to either pane. Exit both agents when done.\n`);

    const { listCards } = await import("./board");
    let cardsAtStart = listCards("backlog").length;

    const backlogDir = join(getSerfDir(), "board", "backlog");
    const proposalFile = join(serfTmp(), "master-proposal.md");
    const shouldKickCritic = makeProposalKicker(proposalFile);

    await new Promise<void>((resolve) => {
      let done = false;

      function checkAndResolve(): boolean {
        const currentCards = listCards("backlog");
        if (currentCards.length > cardsAtStart) {
          const newCards = currentCards.slice(cardsAtStart);
          console.log(`  → ${newCards.length} new card(s) on board: ${newCards.map(c => c.title).join(", ")}`);
          cardsAtStart = currentCards.length;
          done = true;
          resolve();
          return true;
        }
        return false;
      }

      // Kick the critic to review whenever the master writes/updates master-proposal.md.
      // The critic is an interactive agent that only acts on terminal input; it does not
      // watch the filesystem. Without this, a fresh proposal leaves critique.md stale.
      function kickCriticOnProposal(): void {
        if (shouldKickCritic()) {
          console.log(`  → master-proposal.md updated. Kicking critic to review...`);
          herdr.sendCommand(
            criticPaneId,
            `Read ${proposalFile} and write your evaluation to ${join(serfTmp(), "critique.md")}. Be adversarial.`,
          ).catch(() => {});
        }
      }

      if (checkAndResolve()) return;

      try {
        const watcher = watch(backlogDir, (_eventType, filename) => {
          if (filename && filename.endsWith(".md")) {
            setTimeout(() => checkAndResolve(), 500);
          }
        });
        watcher.on("error", () => { if (!done) { done = true; resolve(); } });
      } catch {}

      // Watch the tmp dir for master-proposal.md writes/updates and kick the critic.
      try {
        const proposalWatcher = watch(serfTmp(), (_eventType, filename) => {
          if (filename === "master-proposal.md") {
            setTimeout(kickCriticOnProposal, 500);
          }
        });
        proposalWatcher.on("error", () => {});
      } catch {}

      const interval = setInterval(() => {
        if (done) { clearInterval(interval); return; }

        if (checkAndResolve()) {
          clearInterval(interval);
          return;
        }

        kickCriticOnProposal();

        try {
          const masterPane = herdr.getPane(opts.rootPaneId!);
          const criticPaneInfo = herdr.getPane(criticPaneId);
          Promise.all([masterPane, criticPaneInfo]).then(([mp, cp]) => {
            const masterDead = !mp?.agent_status || mp.agent_status === "done" || mp.agent_status === "idle";
            const criticDead = !cp?.agent_status || cp.agent_status === "done" || cp.agent_status === "idle";
            if (masterDead && criticDead) {
              console.log(`  → Both agents exited.`);
              done = true;
              clearInterval(interval);
              resolve();
            }
          }).catch(() => {
            done = true;
            clearInterval(interval);
            resolve();
          });
        } catch {
          done = true;
          clearInterval(interval);
          resolve();
        }
      }, 60_000);
    });

    const finalCards = listCards("backlog");
    return { ok: true, cardsWritten: finalCards.length, output: `Conversation ended. ${finalCards.length} cards on board.` };
  } else {
    console.log(`  → Direct mode: launching ${masterAgent} interactively in your terminal.`);
    console.log(`  → Talk to it, then when you're done it will return here and we'll check for new board cards.\n`);

    const shellCommand = `cd "${opts.cwd}" && ${masterInv.command} ${masterArgStr}`;
    await new Promise<void>((resolve) => {
      const child = spawn(process.platform === "win32" ? "cmd.exe" : "zsh", ["-c", shellCommand], {
        stdio: "inherit",
        cwd: opts.cwd,
      });
      child.on("exit", () => resolve());
      child.on("error", () => resolve());
    });
  }

  const { listCards } = await import("./board");
  const cards = listCards("backlog");

  return { ok: true, cardsWritten: cards.length, output: `Conversation ended. ${cards.length} cards on board.` };
}