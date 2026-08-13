import { SessionAgentsInspector } from "./SessionAgentsInspector";
import { SessionChangesInspector } from "./SessionChangesInspector";
import { SessionContextDetails } from "./SessionContextDetails";
import type { SessionInspectorProjection } from "./session-inspector-projection";

export type SessionInspectorTab = "agents" | "changes" | "context";

export function SessionInspector({ activeTab, projection }: { activeTab: SessionInspectorTab; projection: SessionInspectorProjection }) {
  if (activeTab === "agents") return <SessionAgentsInspector projection={projection.agents} />;
  if (activeTab === "changes") return <SessionChangesInspector projection={projection.changes} />;
  return <SessionContextDetails />;
}
