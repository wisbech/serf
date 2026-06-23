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

export async function send(method: string, params: Record<string, unknown> = {}): Promise<any> {
  const socketPath = getSocketPath();
  if (!existsSync(socketPath)) {
    throw new Error(`herdr socket not found at ${socketPath}. Is herdr running?`);
  }

  const id = `serf-${++requestId}`;
  const message = JSON.stringify({ id, method, params }) + "\n";

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
          if (response.id === id) {
            socket.destroy();
            if (response.error) {
              reject(new Error(response.error.message || "herdr error"));
            } else {
              resolve(response.result);
            }
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
    }, 30_000);
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
  await send("pane.send_text", { pane_id: paneId, text });
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
  split?: "right" | "down";
}): Promise<PaneInfo> {
  const params: Record<string, unknown> = {
    name,
    command: [command, ...args],
  };
  if (options?.workspaceId) params.workspace_id = options.workspaceId;
  if (options?.cwd) params.cwd = options.cwd;
  if (options?.split) params.split = options.split;

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