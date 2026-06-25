import { connect } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";

const DEFAULT_SOCKET = join(homedir(), ".config", "herdr", "herdr.sock");

export type AgentState = "idle" | "working" | "blocked" | "done" | "unknown";

export interface PaneInfo {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  focused: boolean;
  agent_status: AgentState;
  agent?: string;
  cwd?: string;
  label?: string;
}

export interface WorkspaceInfo {
  workspace_id: string;
  label: string;
  cwd: string;
  tabs: { tab_id: string; label: string }[];
}

let requestId = 0;

export function getSocketPath(): string {
  return process.env.HERDR_SOCKET_PATH || DEFAULT_SOCKET;
}

export function isHerdrRunning(): boolean {
  return existsSync(getSocketPath());
}

export async function send(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<any> {
  const socketPath = getSocketPath();
  if (!existsSync(socketPath)) {
    throw new Error(`herdr socket not found at ${socketPath}. Is herdr running?`);
  }

  const id = `serf-${++requestId}`;
  const message = JSON.stringify({ id, method, params }) + "\n";
  const timeout = timeoutMs ?? (method === "agent.start" ? 60_000 : 30_000);

  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let buffer = "";

    socket.on("connect", () => {
      socket.write(message);
    });

    socket.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const response = JSON.parse(line);
          // herdr returns id: "" on errors, so match on error OR our id
          if (response.error) {
            socket.destroy();
            reject(new Error(response.error.message || "herdr error"));
            return;
          }
          if (response.id === id) {
            socket.destroy();
            resolve(response.result);
            return;
          }
        } catch {}
      }
    });

    socket.on("error", (err) => {
      reject(new Error(`herdr socket error: ${err.message}`));
    });

    setTimeout(() => {
      socket.destroy();
      reject(new Error(`herdr socket timeout for ${method}`));
    }, timeout);
  });
}

export async function ping(): Promise<boolean> {
  try {
    await send("ping");
    return true;
  } catch {
    return false;
  }
}

export async function createWorkspace(label: string, cwd?: string): Promise<WorkspaceInfo> {
  const result = await send("workspace.create", { label, cwd: cwd ?? process.cwd() });
  return result.workspace;
}

export async function listWorkspaces(): Promise<WorkspaceInfo[]> {
  const result = await send("workspace.list");
  return result.workspaces || [];
}

export async function closeWorkspace(workspaceId: string): Promise<boolean> {
  await send("workspace.close", { workspace_id: workspaceId });
  return true;
}

export async function splitPane(workspaceId: string, direction: "right" | "down" = "right"): Promise<PaneInfo> {
  const result = await send("pane.split", { workspace_id: workspaceId, direction });
  return result.pane;
}

export async function sendInput(paneId: string, text: string): Promise<boolean> {
  // Type text into the pane, then press Enter separately
  // TUI apps (opencode, claude) need a real keypress, not \n in the text
  await send("pane.send_text", { pane_id: paneId, text });
  await send("pane.send_keys", { pane_id: paneId, keys: ["enter"] });
  return true;
}

export async function typeText(paneId: string, text: string): Promise<boolean> {
  // Type text into the pane WITHOUT pressing enter — user reviews and presses enter themselves
  await send("pane.send_text", { pane_id: paneId, text });
  return true;
}

export async function sendCommand(paneId: string, command: string): Promise<boolean> {
  // Type a shell command and press Enter
  await send("pane.send_text", { pane_id: paneId, text: command });
  await send("pane.send_keys", { pane_id: paneId, keys: ["enter"] });
  return true;
}

export async function sendPrompt(paneId: string, prompt: string): Promise<boolean> {
  // Send a multi-line prompt to an interactive process (like ollama)
  // Type the text, then press Enter to submit
  await send("pane.send_text", { pane_id: paneId, text: prompt });
  await send("pane.send_keys", { pane_id: paneId, keys: ["enter"] });
  return true;
}

export async function sendKeys(paneId: string, keys: string[]): Promise<boolean> {
  await send("pane.send_keys", { pane_id: paneId, keys });
  return true;
}

export async function readPane(paneId: string, lines = 100): Promise<string> {
  const result = await send("pane.read", { pane_id: paneId, source: "recent", lines });
  return result.text || result.content || "";
}

export async function getPane(paneId: string): Promise<PaneInfo> {
  const result = await send("pane.get", { pane_id: paneId });
  return result.pane;
}

export async function listPanes(workspaceId?: string): Promise<PaneInfo[]> {
  const params = workspaceId ? { workspace_id: workspaceId } : {};
  const result = await send("pane.list", params);
  return result.panes || [];
}

export async function closePane(paneId: string): Promise<boolean> {
  await send("pane.close", { pane_id: paneId });
  return true;
}

export async function getAgentState(paneId: string): Promise<AgentState> {
  const pane = await getPane(paneId);
  return pane.agent_status || "unknown";
}

export async function waitForState(paneId: string, targetState: AgentState, timeoutMs = 180_000): Promise<AgentState> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const state = await getAgentState(paneId);
    if (state === targetState) return state;
    if (state === "blocked") return "blocked";
    await new Promise(r => setTimeout(r, 2000));
  }

  return "unknown";
}

export async function reportAgentState(paneId: string, agent: string, state: AgentState, message?: string): Promise<boolean> {
  await send("pane.report_agent", { pane_id: paneId, source: "serf", agent, state, message });
  return true;
}

export async function createWorktree(workspaceId: string, branch: string): Promise<any> {
  const result = await send("worktree.create", { workspace_id: workspaceId, branch });
  return result;
}

export function spawnAgent(paneId: string, command: string, args: string[] = []): Promise<void> {
  return sendInput(paneId, `${command} ${args.join(" ")}\n`);
}

export async function startAgent(name: string, command: string, args: string[], options?: {
  workspaceId?: string;
  cwd?: string;
}): Promise<PaneInfo> {
  const params: Record<string, unknown> = {
    name,
    argv: [command, ...args],
  };
  if (options?.workspaceId) params.workspace_id = options.workspaceId;
  if (options?.cwd) params.cwd = options.cwd;

  const result = await send("agent.start", params);
  return result.pane || result.agent;
}

export function ensureHerdr(): boolean {
  if (isHerdrRunning()) return true;

  const child = spawn("herdr", ["server", "start"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  for (let i = 0; i < 10; i++) {
    if (isHerdrRunning()) return true;
    const start = Date.now();
    while (Date.now() - start < 500) {}
  }

  return isHerdrRunning();
}

// ── HERDR AGENT ──

export function buildAgentCmd(name: string, model?: string): string {
  const m = model ? ` --model ${model}` : "";
  if (name === "opencode") return model ? `opencode -m ${model}` : "opencode";
  if (name === "aider") return `aider${m} --yes-always`;
  if (name === "hermes") return model ? `hermes chat -m ${model}` : "hermes chat";
  return name === "claude" || name === "pi" || name === "codex"
    ? `${name}${m}`
    : name;
}

export class HerdrAgent {
  paneId: string;
  role: string;
  agentName: string;
  model?: string;
  ready = false;

  private constructor(paneId: string, role: string, agentName: string, model?: string) {
    this.paneId = paneId;
    this.role = role;
    this.agentName = agentName;
    this.model = model;
  }

  static async create(
    workspaceId: string,
    role: string,
    agentName: string,
    model?: string,
    direction: "right" | "down" = "right",
  ): Promise<HerdrAgent> {
    const pane = await splitPane(workspaceId, direction);
    const agent = new HerdrAgent(pane.pane_id, role, agentName, model);

    await sendCommand(agent.paneId, `echo "╔══ SERF ${role.toUpperCase()} (${agentName}) ══╗"`);
    await sendCommand(agent.paneId, buildAgentCmd(agentName, model));
    await new Promise(r => setTimeout(r, 5000));
    agent.ready = true;

    return agent;
  }

  static fromExisting(paneId: string, role: string, agentName: string, model?: string): HerdrAgent {
    const agent = new HerdrAgent(paneId, role, agentName, model);
    agent.ready = true;
    return agent;
  }

  async send(prompt: string): Promise<void> {
    await sendInput(this.paneId, prompt);
  }

  async waitForDone(timeoutMs = 600_000): Promise<string> {
    const start = Date.now();
    let lastContent = "";
    let stableCount = 0;

    while (Date.now() - start < timeoutMs) {
      await new Promise(r => setTimeout(r, 3000));

      let content = "";
      try { content = await readPane(this.paneId, 200); }
      catch { return lastContent; }

      try {
        const pane = await getPane(this.paneId);
        if (pane.agent_status === "idle" && content.length > 50) {
          return content;
        }
      } catch {}

      if (content === lastContent && content.length > 50) {
        stableCount++;
        if (stableCount >= 5) return content;
      } else {
        stableCount = 0;
        lastContent = content;
      }
    }

    return lastContent;
  }

  async ask(question: string, timeoutMs = 300_000): Promise<string> {
    await this.send(question);
    return this.waitForDone(timeoutMs);
  }

  async close(): Promise<void> {
    try { await closePane(this.paneId); } catch {}
  }
}