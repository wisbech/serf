import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, unlinkSync, createWriteStream, watch, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { buildInvocation, buildInteractiveInvocation, qualifyModel } from "./agent-command";
import type { SandboxProfile } from "./sandbox";
import { loadConfig } from "./state";
import { getSerfDir, ensureDir } from "./paths";
import * as herdr from "./herdr-client";
import { listSerfs, type SerfIdentity } from "./serf";
import { buildPartnerPrompt } from "./prompts";
import { parseVerdict } from "./critic";

export interface RunOpts {
  cwd: string;
  timeoutMs: number;
  outputFile: string;
  profile?: SandboxProfile;
  label?: string;
  model?: string;
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

export async function waitForOutputFile(
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
    let interval: any = null;

    function finish(content: string) {
      if (resolved) return;
      resolved = true;
      if (watcher) watcher.close();
      if (interval) clearInterval(interval);
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

    interval = setInterval(async () => {
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

async function waitForPaneIdle(paneId: string, outputFile: string, timeoutMs: number): Promise<string> {
  const markers = ["SERF_TASK_DONE", "SERF_DONE_EXIT_CODE", "FAILURE_REASON"];
  const startTime = Date.now();
  const IDLE_THRESHOLD_MS = 15_000;
  const POLL_INTERVAL_MS = 5_000;

  let lastWorkingTime = Date.now();
  let wasWorking = false;

  while (Date.now() - startTime < timeoutMs) {
    if (existsSync(outputFile)) {
      const content = readFileSync(outputFile, "utf-8");
      if (markers.some((m) => content.includes(m))) {
        return content;
      }
    }

    try {
      const pane = await herdr.getPane(paneId);
      const state = pane?.agent_status ?? "unknown";

      if (state === "working") {
        wasWorking = true;
        lastWorkingTime = Date.now();
      } else if (state === "idle" || state === "done") {
        if (wasWorking && Date.now() - lastWorkingTime > IDLE_THRESHOLD_MS) {
          console.log(`  → Agent went idle. Reading pane content...`);
          const content = await herdr.readPane(paneId, 200);
          if (content && content.length > 0) {
            if (existsSync(outputFile)) {
              const fileContent = readFileSync(outputFile, "utf-8");
              if (fileContent.length > 0) return fileContent;
            }
            return content;
          }
          if (existsSync(outputFile)) {
            return readFileSync(outputFile, "utf-8");
          }
          return content || "";
        }
      }
    } catch {}

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  if (existsSync(outputFile)) {
    return readFileSync(outputFile, "utf-8");
  }

  try {
    const content = await herdr.readPane(paneId, 200);
    return content || "";
  } catch {
    return "";
  }
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
    const model = opts.model ?? this.modelOverride ?? config?.actorModel ?? config?.model;
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
    const model = opts.model ?? this.modelOverride ?? config?.actorModel ?? config?.model;

    const invocation = buildInteractiveInvocation(agentName, model);

    if (!this.paneId) {
      const label = opts.label ?? "serf";
      let pane: any;
      if (this.serfTabId) {
        pane = await herdr.splitPaneInTab(this.serfTabId, "right", label);
      } else {
        const tabs = await herdr.send("tab.list", { workspace_id: this.workspaceId }).catch(() => null);
        const serfsTab = tabs?.tabs?.find((t: any) => t.label === "serfs");
        if (serfsTab) {
          pane = await herdr.splitPaneInTab(serfsTab.tab_id, "right", label);
        } else {
          const newTab = await herdr.createTab(this.workspaceId, "serfs", opts.cwd);
          pane = await herdr.splitPaneInTab(newTab.tab_id, "right", label);
        }
      }
      this.paneId = pane.pane_id;
    } else if (opts.label) {
      await herdr.labelPane(this.paneId, opts.label).catch(() => {});
    }

    const promptFile = join(serfTmp(), `prompt-${Date.now()}.md`);
    writeFileSync(promptFile, prompt);

    let argStr = invocation.args.map((a) => JSON.stringify(a)).join(" ");
    if (agentName === "opencode" && model) {
      const providerModel = qualifyModel(model, config?.provider);
      const fixedInv = buildInteractiveInvocation(agentName, providerModel);
      argStr = fixedInv.args.map((a) => JSON.stringify(a)).join(" ");
    }
    await herdr.sendCommand(this.paneId, `cd "${opts.cwd}" && ${agentName} ${argStr}`);
    await herdr.reportAgentState(this.paneId, agentName, "working", opts.label).catch(() => {});

    await new Promise((r) => setTimeout(r, 10_000));

    await herdr.sendCommand(this.paneId, `Read ${promptFile} and follow the instructions. Write your output to ${opts.outputFile} and end with SERF_TASK_DONE.`);

    const raw = await waitForPaneIdle(this.paneId, opts.outputFile, opts.timeoutMs);

    try { unlinkSync(promptFile); } catch {}

    const { output, ok } = parseOutput(raw);
    await herdr.reportAgentState(this.paneId, agentName, ok ? "done" : "blocked", opts.label).catch(() => {});
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

  if (masterAgent === "opencode" && masterModel) {
    const providerModel = qualifyModel(masterModel, config?.provider);
    const fixedInv = buildInteractiveInvocation(masterAgent, providerModel);
    masterArgStr = fixedInv.args.map((a) => JSON.stringify(a)).join(" ");
  }
  if (criticAgent === "opencode" && criticModel) {
    const providerModel = qualifyModel(criticModel, config?.provider);
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

    await herdr.sendCommand(opts.rootPaneId, `Read ${masterPromptFile} and follow those instructions. When you write or update .serf/tmp/master-proposal.md, the harness will automatically notify the critic. Keep running — the harness will pick up cards as you write them.`);
    await herdr.sendCommand(criticPaneId, `Read ${criticPromptFile} and follow those instructions. The harness will send you proposals when they are ready.`);

    console.log(`  → Master launched in left pane, critic in right pane.`);
    console.log(`  → Trajectory-driven dispatcher: agents emit via 'serf emit' → harness routes by subscriptions.`);
    console.log(`  → Talk to either pane. Exit both agents when done.\n`);

    const { listCards } = await import("./board");
    const { subscribeToTrajectory, loadSubscriptions } = await import("./events");
    let cardsAtStart = listCards("backlog").length;

    const proposalFile = join(serfTmp(), "master-proposal.md");
    const critiqueFile = join(serfTmp(), "critique.md");

    const paneForRole: Record<string, string> = {
      master: opts.rootPaneId!,
      critic: criticPaneId,
    };

    const routeToPane = (role: string, command: string) => {
      const paneId = paneForRole[role];
      if (paneId) {
        console.log(`  → routing to ${role} (${paneId}): ${command.slice(0, 80)}...`);
        herdr.sendCommand(paneId, command).catch(() => {});
      }
    };

    const allSubs: { role: string; types: string[]; trigger_self: boolean }[] = [];
    for (const role of ["master", "critic"]) {
      const subs = loadSubscriptions(role);
      for (const sub of subs) {
        allSubs.push({ role, types: sub.types, trigger_self: sub.trigger_self });
      }
    }

    console.log(`  → Loaded ${allSubs.length} subscription(s): ${allSubs.map(s => `${s.role}←[${s.types.join(",")}]`).join("  ")}`);

    const unsubTrajectory = subscribeToTrajectory("*", (step) => {
      for (const sub of allSubs) {
        if (!sub.types.includes(step.type)) continue;
        if (step.source === sub.role && !sub.trigger_self) continue;

        if (step.type === "proposal" && sub.role === "critic") {
          routeToPane("critic", `Read ${proposalFile} and write your evaluation to ${critiqueFile}. Be adversarial. When done, run: serf emit critique.written file=.serf/tmp/critique.md --source critic`);
        } else if (step.type === "critique" && sub.role === "master") {
          routeToPane("master", `Read ${critiqueFile}. The critic has reviewed your proposal. Revise if needed (then run serf emit proposal.written --source master again), or write a card to .serf/board/backlog/ if you agree (then run serf emit card.written --source master).`);
        } else if (step.type === "work" && sub.role === "critic") {
          const output = step.payload?.outputFile ? `Read ${step.payload.outputFile} and evaluate the actor's work.` : `Evaluate the work output.`;
          routeToPane("critic", `${output} Write your verdict and run: serf emit verdict card=${step.payload?.cardId ?? ""} --source critic`);
        } else if (step.type === "verdict" && sub.role === "master") {
          routeToPane("master", `The critic has verdicted: ${JSON.stringify(step.payload)}. Update the board accordingly.`);
        } else if (step.type === "serf.completed" && sub.role === "master") {
          routeToPane("master", `Serf completed task: ${JSON.stringify(step.payload)}. Check the board and proceed.`);
        }
      }
    });

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

      try {
        const backlogDir = join(getSerfDir(), "board", "backlog");
        const watcher = watch(backlogDir, (_eventType, filename) => {
          if (filename && filename.endsWith(".md")) {
            setTimeout(() => { if (!done) checkAndResolve(); }, 500);
          }
        });
        watcher.on("error", () => { if (!done) { done = true; resolve(); } });
      } catch {}

      const exitInterval = setInterval(async () => {
        if (done) { clearInterval(exitInterval); return; }

        if (checkAndResolve()) {
          clearInterval(exitInterval);
          return;
        }

        try {
          const masterPane = herdr.getPane(opts.rootPaneId!);
          const criticPaneInfo = herdr.getPane(criticPaneId);
          Promise.all([masterPane, criticPaneInfo]).then(([mp, cp]) => {
            const masterDead = !mp?.agent_status || mp.agent_status === "done" || mp.agent_status === "idle";
            const criticDead = !cp?.agent_status || cp.agent_status === "done" || cp.agent_status === "idle";
            if (masterDead && criticDead) {
              console.log(`  → Both agents exited.`);
              done = true;
              clearInterval(exitInterval);
              resolve();
            }
          }).catch(() => {
            done = true;
            clearInterval(exitInterval);
            resolve();
          });
        } catch {
          done = true;
          clearInterval(exitInterval);
          resolve();
        }
      }, 60_000);
    });

    unsubTrajectory();

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

// ── COUNCIL: MASTER + N SPARRING PARTNERS ──

export interface CouncilOptions {
  cwd: string;
  workspaceId?: string;
  rootPaneId?: string;
  serfTabId?: string;
  model?: string;
  maxRounds?: number;
}

export async function launchCouncil(
  masterPrompt: string,
  opts: CouncilOptions,
): Promise<ConversationResult> {
  const config = loadConfig();
  const masterAgent = config?.masterAgent ?? config?.agent ?? "claude";
  const masterModel = opts.model ?? config?.masterModel ?? config?.model;
  const maxRounds = opts.maxRounds ?? config?.maxRounds ?? 3;

  const { loadSubscriptions } = await import("./events");
  const partners: SerfIdentity[] = [];
  for (const serf of listSerfs()) {
    if (serf.name === "master") continue;
    const subs = loadSubscriptions(serf.name);
    if (subs.some((s) => s.types.includes("proposal"))) {
      partners.push(serf);
    }
  }

  if (partners.length === 0) {
    partners.push({ name: "critic", mission: "evaluate the master's proposals adversarially", persona: "adversarial but constructive", lever: [], measurement: [], fate: "" });
  }

  const masterInv = buildInteractiveInvocation(masterAgent, masterModel);
  const masterPromptFile = join(serfTmp(), "master-prompt.md");
  writeFileSync(masterPromptFile, masterPrompt);

  let masterArgStr = masterInv.args.map((a) => JSON.stringify(a)).join(" ");
  if (masterAgent === "opencode" && masterModel) {
    const providerModel = qualifyModel(masterModel, config?.provider);
    const fixedInv = buildInteractiveInvocation(masterAgent, providerModel);
    masterArgStr = fixedInv.args.map((a) => JSON.stringify(a)).join(" ");
  }

  if (!opts.workspaceId || !opts.rootPaneId) {
    return runHeadlessCouncil(masterPrompt, partners, opts, config, masterAgent, masterModel, maxRounds);
  }

  await herdr.labelPane(opts.rootPaneId, "master");

  const partnerPanes: Record<string, string> = {};
  for (const p of partners) {
    const pane = await herdr.splitPane(opts.workspaceId, "right", p.name);
    partnerPanes[p.name] = pane.pane_id;
    const partnerAgent = config?.criticAgent ?? config?.agent ?? "claude";
    const partnerModel = p.model ?? config?.criticModel ?? config?.model;
    const inv = buildInteractiveInvocation(partnerAgent, partnerModel);
    let argStr = inv.args.map((a) => JSON.stringify(a)).join(" ");
    if (partnerAgent === "opencode" && partnerModel) {
      const providerModel = qualifyModel(partnerModel, config?.provider);
      const fixedInv = buildInteractiveInvocation(partnerAgent, providerModel);
      argStr = fixedInv.args.map((a) => JSON.stringify(a)).join(" ");
    }
    const promptFile = join(serfTmp(), `${p.name}-prompt.md`);
    writeFileSync(promptFile, buildPartnerPrompt(p));
    await herdr.sendCommand(pane.pane_id, `cd "${opts.cwd}" && ${inv.command} ${argStr}`);
    await new Promise((r) => setTimeout(r, 3_000));
    await herdr.sendCommand(pane.pane_id, `Read ${promptFile} and follow those instructions. The harness will send you proposals when they are ready.`);
  }

  await herdr.sendCommand(opts.rootPaneId, `cd "${opts.cwd}" && ${masterInv.command} ${masterArgStr}`);
  await new Promise((r) => setTimeout(r, 10_000));
  await herdr.sendCommand(opts.rootPaneId, `Read ${masterPromptFile} and follow those instructions. When you write or update .serf/tmp/master-proposal.md, the harness will automatically notify your sparring partners. Keep running — the harness will pick up cards as you write them.`);

  console.log(`  → Master launched with ${partners.length} sparring partner(s): ${partners.map((p) => p.name).join(", ")}`);
  console.log(`  → Blocking: ${partners.filter((p) => !p.advisory).map((p) => p.name).join(", ") || "(none)"} | Advisory: ${partners.filter((p) => p.advisory).map((p) => p.name).join(", ") || "(none)"}`);
  console.log(`  → Max rounds: ${maxRounds}. Lack of convergence escalates back to master.\n`);

  const { listCards } = await import("./board");
  const { subscribeToTrajectory } = await import("./events");
  let cardsAtStart = listCards("backlog").length;

  const proposalFile = join(serfTmp(), "master-proposal.md");
  const paneForRole: Record<string, string> = { master: opts.rootPaneId!, ...partnerPanes };

  const routeToPane = (role: string, command: string) => {
    const paneId = paneForRole[role];
    if (paneId) {
      console.log(`  → routing to ${role}: ${command.slice(0, 80)}...`);
      herdr.sendCommand(paneId, command).catch(() => {});
    }
  };

  const unsubTrajectory = subscribeToTrajectory("*", (step) => {
    if (step.type === "proposal") {
      for (const p of partners) {
        routeToPane(p.name, `Read ${proposalFile} and write your evaluation to .serf/tmp/critique-${p.name}.md. Be adversarial through your lens. When done, run: serf emit critique.written file=.serf/tmp/critique-${p.name}.md --source ${p.name}`);
      }
    } else if (step.type === "critique") {
      const source = step.source;
      if (source && source !== "master") {
        routeToPane("master", `Read .serf/tmp/critique-${source}.md. ${source} has reviewed your proposal. Revise if needed (then run serf emit proposal.written --source master again), or write a card to .serf/board/backlog/ if you agree (then run serf emit card.written --source master).`);
      }
    }
  });

  await new Promise<void>((resolve) => {
    let done = false;
    const checkAndResolve = (): boolean => {
      const currentCards = listCards("backlog");
      if (currentCards.length > cardsAtStart) {
        console.log(`  → ${currentCards.length - cardsAtStart} new card(s) on board.`);
        done = true;
        resolve();
        return true;
      }
      return false;
    };

    try {
      const backlogDir = join(getSerfDir(), "board", "backlog");
      const watcher = watch(backlogDir, (_e, filename) => {
        if (filename && filename.endsWith(".md")) setTimeout(() => { if (!done) checkAndResolve(); }, 500);
      });
      watcher.on("error", () => { if (!done) { done = true; resolve(); } });
    } catch {}

    const exitInterval = setInterval(async () => {
      if (done) { clearInterval(exitInterval); return; }
      if (checkAndResolve()) { clearInterval(exitInterval); return; }
      try {
        const panes = await Promise.all([opts.rootPaneId!, ...Object.values(partnerPanes)].map((id) => herdr.getPane(id)));
        const allIdle = panes.every((p) => !p?.agent_status || p.agent_status === "done" || p.agent_status === "idle");
        if (allIdle) {
          console.log(`  → All agents exited.`);
          done = true;
          clearInterval(exitInterval);
          resolve();
        }
      } catch {
        done = true;
        clearInterval(exitInterval);
        resolve();
      }
    }, 60_000);
  });

  unsubTrajectory();

  const finalCards = listCards("backlog");
  return { ok: true, cardsWritten: finalCards.length, output: `Council ended. ${finalCards.length} cards on board.` };
}

// ── HEADLESS COUNCIL ──

async function runHeadlessCouncil(
  masterPrompt: string,
  partners: SerfIdentity[],
  opts: CouncilOptions,
  config: any,
  masterAgent: string,
  masterModel: string,
  maxRounds: number,
): Promise<ConversationResult> {
  const { listCards } = await import("./board");
  const proposalFile = join(serfTmp(), "master-proposal.md");
  const masterTransport = new HeadlessTransport("fallback", masterAgent, masterModel);

  console.log(`  → Headless council: master + ${partners.length} partner(s), max ${maxRounds} rounds.\n`);

  let proposalPrompt = `${masterPrompt}\n\nWrite your proposal to ${proposalFile}. End your response with SERF_TASK_DONE.`;

  for (let round = 1; round <= maxRounds; round++) {
    console.log(`  → Round ${round}/${maxRounds}: master proposing...`);
    await masterTransport.run(proposalPrompt, {
      cwd: opts.cwd,
      timeoutMs: 600_000,
      outputFile: join(serfTmp(), `master-round-${round}.md`),
      label: "master",
    });

    const cardsNow = listCards("backlog");
    if (cardsNow.length > 0) {
      return { ok: true, cardsWritten: cardsNow.length, output: `Master wrote ${cardsNow.length} card(s) directly.` };
    }

    const critiques: { name: string; verdict: ReturnType<typeof parseVerdict>; advisory: boolean }[] = [];
    for (const p of partners) {
      console.log(`  → ${p.name} critiquing...`);
      const partnerAgent = config?.criticAgent ?? config?.agent ?? "claude";
      const partnerModel = p.model ?? config?.criticModel ?? config?.model;
      const pTransport = new HeadlessTransport("fallback", partnerAgent, partnerModel);
      const critiquePrompt = `${buildPartnerPrompt(p)}\n\nRead the proposal at ${proposalFile}. Evaluate it through your lens. Respond with EXACTLY:\nVERDICT: pass | fail | uncertain\nCONFIDENCE: 0.0 to 1.0\nREASONING: [one sentence]\n\nEnd with SERF_TASK_DONE.`;
      const critResult = await pTransport.run(critiquePrompt, {
        cwd: opts.cwd,
        timeoutMs: 300_000,
        outputFile: join(serfTmp(), `critique-${p.name}-round-${round}.md`),
        label: p.name,
      });
      const verdict = parseVerdict(critResult.output);
      critiques.push({ name: p.name, verdict, advisory: p.advisory ?? false });
      console.log(`    ${p.name}: ${verdict.verdict} (${(verdict.confidence * 100).toFixed(0)}%)`);
    }

    const blockingFails = critiques.filter((c) => !c.advisory && c.verdict.verdict === "fail" && c.verdict.confidence > 0.7);

    if (blockingFails.length === 0) {
      console.log(`  → Converged. Asking master to write card...`);
      await masterTransport.run(
        `All sparring partners have approved your proposal. Write a card to .serf/board/backlog/ now. End with SERF_TASK_DONE.`,
        { cwd: opts.cwd, timeoutMs: 300_000, outputFile: join(serfTmp(), "master-final.md"), label: "master" },
      );
      const finalCards = listCards("backlog");
      return { ok: true, cardsWritten: finalCards.length, output: `Council converged. ${finalCards.length} card(s) on board.` };
    }

    const feedback = critiques
      .map((c) => `${c.name} (${c.advisory ? "advisory" : "blocking"}): ${c.verdict.verdict} (${(c.verdict.confidence * 100).toFixed(0)}%) — ${c.verdict.reasoning}`)
      .join("\n");
    proposalPrompt = `${masterPrompt}\n\nYour sparring partners reviewed your proposal:\n${feedback}\n\nRevise the proposal to address the blocking concerns. Write the updated proposal to ${proposalFile}. End with SERF_TASK_DONE.`;
  }

  console.log(`  → No convergence after ${maxRounds} rounds. Escalating back to master.`);
  const finalCards = listCards("backlog");
  return { ok: false, cardsWritten: finalCards.length, output: `Council did not converge after ${maxRounds} rounds.` };
}