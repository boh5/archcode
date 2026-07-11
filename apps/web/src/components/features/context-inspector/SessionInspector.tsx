import { SessionAgentsInspector } from "./SessionAgentsInspector";
import { SessionChangesInspector } from "./SessionChangesInspector";
import { SessionContextDetails } from "./SessionContextDetails";

export type SessionInspectorTab = "agents" | "changes" | "context";

export function SessionInspector({ activeTab }: { activeTab: SessionInspectorTab }) {
  if (activeTab === "agents") return <SessionAgentsInspector />;
  if (activeTab === "changes") return <SessionChangesInspector />;
  return <SessionContextDetails />;
}
