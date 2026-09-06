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
    // The actor pane is owned and reused by HerdrTransport. This layer only
    // tracks the workspace so the transport can target the right tab.
    return { workspaceId: workspaceId ?? "", actorPaneId: "", helperTabId: this.serfTabId };
  }

  async onTaskEnd(_handle: PaneHandle, _result: ActorRunResult): Promise<void> {}
}