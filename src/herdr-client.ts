import { connect } from "node:net";
import { existsSync } from "node:fs";
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

export async function isHerdrResponding(): Promise<boolean> {
  try {
    await send("ping", {}, 2000);
    return true;
  } catch {
    return false;
  }
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

export async function renamePane(paneId: string, label: string, retries = 3): Promise<boolean> {
  for (let i = 0; i < retries; i++) {
    try {
      await send("pane.rename", { pane_id: paneId, label });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return false;
}

export async function setPaneTitle(paneId: string, title: string, retries = 3): Promise<boolean> {
  for (let i = 0; i < retries; i++) {
    try {
      await send("pane.report_metadata", { pane_id: paneId, source: "serf", title });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return false;
}

export async function labelPane(paneId: string, text: string): Promise<boolean> {
  const renamed = await renamePane(paneId, text);
  const titled = await setPaneTitle(paneId, text);
  try {
    await send("pane.report_metadata", { pane_id: paneId, source: "serf", display_agent: text });
  } catch {}
  if (!renamed && !titled) return false;
  return true;
}

export async function splitPane(workspaceId: string, direction: "right" | "down" = "right", label?: string): Promise<PaneInfo> {
  const result = await send("pane.split", { workspace_id: workspaceId, direction });
  if (label && result.pane?.pane_id) {
    await labelPane(result.pane.pane_id, label).catch(() => {});
  }
  return result.pane;
}

export async function createTab(workspaceId: string, label?: string, cwd?: string): Promise<{ tab_id: string; workspace_id: string; label?: string }> {
  const result = await send("tab.create", { workspace_id: workspaceId, label, cwd: cwd ?? process.cwd() });
  return result.tab ?? result;
}

export async function splitPaneInTab(tabId: string, direction: "right" | "down" = "right", label?: string): Promise<PaneInfo> {
  const result = await send("pane.split", { tab_id: tabId, direction });
  if (label && result.pane?.pane_id) {
    await labelPane(result.pane.pane_id, label).catch(() => {});
  }
  return result.pane;
}

export async function sendCommand(paneId: string, command: string): Promise<boolean> {
  await send("pane.send_text", { pane_id: paneId, text: command });
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

export async function reportAgentState(paneId: string, agent: string, state: AgentState, message?: string): Promise<boolean> {
  await send("pane.report_agent", { pane_id: paneId, source: "serf", agent, state, message });
  return true;
}

export function ensureHerdr(): boolean {
  if (isHerdrRunning()) return true;
  const child = spawn("herdr", ["server", "start"], { detached: true, stdio: "ignore" });
  child.unref();
  for (let i = 0; i < 10; i++) {
    if (isHerdrRunning()) return true;
    const start = Date.now();
    while (Date.now() - start < 500) {}
  }
  return isHerdrRunning();
}

export async function isAgentAlive(paneId: string): Promise<boolean> {
  try {
    const procInfo = await send("pane.process_info", { pane_id: paneId }, 5000);
    const procs = procInfo?.process_info?.foreground_processes ?? [];
    return procs.some((p: any) => {
      const name = (p.name || "").toLowerCase();
      return name !== "zsh" && name !== "bash" && name !== "sh" && name !== "fish";
    });
  } catch {
    return false;
  }
}

export async function waitForAgentExit(paneId: string, _timeoutMs = 600_000): Promise<AgentState> {
  const { join } = await import("node:path");
  const { getSerfDir, ensureDir } = await import("./paths");
  const { appendEvent } = await import("./events");

  const tmpDir = join(getSerfDir(), "tmp");
  ensureDir(tmpDir);
  const receiptFile = join(tmpDir, `${paneId}-done`);

  return new Promise<AgentState>((resolve) => {
    let resolved = false;

    function checkReceipt(): boolean {
      if (existsSync(receiptFile)) {
        if (!resolved) { resolved = true; resolve("done"); }
        return true;
      }
      return false;
    }

    if (checkReceipt()) return;

    try {
      const watcher = watch(tmpDir, (_eventType, filename) => {
        if (filename && filename === `${paneId}-done`) {
          checkReceipt();
        }
      });
      watcher.on("error", () => { if (!resolved) { resolved = true; resolve("unknown"); } });
    } catch {}

    const interval = setInterval(async () => {
      if (resolved) { clearInterval(interval); return; }
      if (checkReceipt()) { clearInterval(interval); return; }

      try {
        const pane = await getPane(paneId);
        if (pane.agent_status === "done" || pane.agent_status === "idle") {
          if (!resolved) { resolved = true; resolve(pane.agent_status); clearInterval(interval); }
          return;
        }
      } catch {
        if (!resolved) { resolved = true; resolve("done"); clearInterval(interval); }
      }
    }, 60_000);
  });
}