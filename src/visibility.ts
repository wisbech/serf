import type { Card } from "./board";
import type { ActorRunResult } from "./transport";

export interface PaneHandle {
  workspaceId: string;
  actorPaneId: string;
  criticPaneId?: string;
  helperTabId?: string;
}

export interface VisibilityLayer {
  onTaskStart(card: Card, cwd: string, workspaceId?: string, masterPaneId?: string): Promise<PaneHandle>;
  onTaskEnd(handle: PaneHandle, result: ActorRunResult): Promise<void>;
}

export class NoopVisibility implements VisibilityLayer {
  async onTaskStart(_card: Card, _cwd: string): Promise<PaneHandle> {
    return { workspaceId: "", actorPaneId: "" };
  }

  async onTaskEnd(_handle: PaneHandle, _result: ActorRunResult): Promise<void> {}
}

export class HerdrVisibility implements VisibilityLayer {
  constructor(private serfTabId?: string) {}

  async onTaskStart(card: Card, cwd: string, workspaceId?: string, _masterPaneId?: string): Promise<PaneHandle> {
    const herdr = await import("./herdr-client");
    const label = card.title.slice(0, 30);

    let wsId = workspaceId;
    let actorPaneId: string;

    if (!wsId) {
      const ws = await herdr.createWorkspace(label, cwd);
      wsId = ws.workspace_id;
      actorPaneId = ws.workspace_id + ":p1";
      await herdr.labelPane(actorPaneId, `actor: ${label}`);
    } else {
      const actorPane = await herdr.splitPane(wsId, "right", `actor: ${label}`);
      actorPaneId = actorPane.pane_id;
    }

    let criticPaneId: string | undefined;
    try {
      const criticPane = await herdr.splitPane(wsId, "right", `critic: ${label}`);
      criticPaneId = criticPane.pane_id;
    } catch {}

    let helperTabId = this.serfTabId;
    if (!helperTabId && wsId) {
      try {
        const helperTab = await herdr.createTab(wsId, `serfs: ${label}`, cwd);
        helperTabId = helperTab.tab_id;
      } catch {}
    }

    return { workspaceId: wsId, actorPaneId, criticPaneId, helperTabId };
  }

  async onTaskEnd(handle: PaneHandle, _result: ActorRunResult): Promise<void> {
    const herdr = await import("./herdr-client");
    if (handle.criticPaneId) {
      try { await herdr.closePane(handle.criticPaneId); } catch {}
    }
    if (handle.actorPaneId) {
      try { await herdr.closePane(handle.actorPaneId); } catch {}
    }
  }
}