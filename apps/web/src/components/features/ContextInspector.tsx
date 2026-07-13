import { useState, type ReactNode } from "react";
import { PanelRightClose } from "lucide-react";
import type { InspectorKind } from "../../lib/workbench-layout";
import { GoalInspector, type GoalInspectorTab } from "./context-inspector/GoalInspector";
import { SessionInspector, type SessionInspectorTab } from "./context-inspector/SessionInspector";

interface InspectorTab<T extends string> {
  id: T;
  label: string;
}

const SESSION_TABS = [
  { id: "agents", label: "Agents" },
  { id: "changes", label: "Changes" },
  { id: "context", label: "Context" },
] satisfies [InspectorTab<SessionInspectorTab>, ...InspectorTab<SessionInspectorTab>[]];

const GOAL_TABS = [
  { id: "overview", label: "Criteria" },
  { id: "evidence", label: "Evidence" },
  { id: "sessions", label: "Sessions" },
] satisfies [InspectorTab<GoalInspectorTab>, ...InspectorTab<GoalInspectorTab>[]];

export function ContextInspector({
  kind,
  id = "context-inspector",
  onCollapse,
}: {
  kind: InspectorKind;
  id?: string;
  onCollapse?: () => void;
}) {
  if (kind === "goal") {
    return <InspectorShell key="goal" id={id} kind={kind} tabs={GOAL_TABS} onCollapse={onCollapse} renderPanel={(activeTab) => <GoalInspector activeTab={activeTab} />} />;
  }
  if (kind === "session") {
    return <InspectorShell key="session" id={id} kind={kind} tabs={SESSION_TABS} onCollapse={onCollapse} renderPanel={(activeTab) => <SessionInspector activeTab={activeTab} />} />;
  }
  return assertNever(kind);
}

function assertNever(value: never): never {
  throw new Error(`Unsupported inspector kind: ${String(value)}`);
}

function InspectorShell<T extends string>({
  kind,
  id,
  tabs,
  onCollapse,
  renderPanel,
}: {
  kind: InspectorKind;
  id: string;
  tabs: readonly [InspectorTab<T>, ...InspectorTab<T>[]];
  onCollapse?: () => void;
  renderPanel: (activeTab: T) => ReactNode;
}) {
  const [activeTab, setActiveTab] = useState(tabs[0].id);
  const selectTab = (index: number) => {
    const tab = tabs[(index + tabs.length) % tabs.length];
    setActiveTab(tab.id);
    document.getElementById(`${id}-tab-${tab.id}`)?.focus();
  };

  return (
    <aside id={id} className="flex h-full min-w-0 flex-col bg-bg-surface" aria-label="Context inspector">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border-subtle px-3 max-[799px]:pl-12">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">Context Inspector</div>
          <div className="text-xs capitalize text-text-secondary">{kind}</div>
        </div>
        {onCollapse && (
          <button
            type="button"
            aria-label="Collapse context inspector from overlay"
            aria-controls={id}
            aria-expanded="true"
            title="Collapse context inspector"
            className="hidden h-7 w-7 shrink-0 items-center justify-center rounded-sm text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary min-[800px]:flex min-[1280px]:hidden"
            onClick={onCollapse}
          >
            <PanelRightClose size={15} aria-hidden="true" />
          </button>
        )}
      </header>
      <div className="flex shrink-0 border-b border-border-subtle px-2" role="tablist" aria-label={`${kind} context sections`}>
        {tabs.map((tab, index) => (
          <button
            key={tab.id}
            id={`${id}-tab-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            aria-controls={`${id}-panel`}
            tabIndex={activeTab === tab.id ? 0 : -1}
            className={`min-w-0 flex-1 border-b-2 px-1 py-2 text-[11px] font-medium transition-colors ${activeTab === tab.id ? "border-accent text-text-primary" : "border-transparent text-text-muted hover:text-text-secondary"}`}
            onClick={() => setActiveTab(tab.id)}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight") { event.preventDefault(); selectTab(index + 1); }
              if (event.key === "ArrowLeft") { event.preventDefault(); selectTab(index - 1); }
              if (event.key === "Home") { event.preventDefault(); selectTab(0); }
              if (event.key === "End") { event.preventDefault(); selectTab(tabs.length - 1); }
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div
        id={`${id}-panel`}
        role="tabpanel"
        aria-labelledby={`${id}-tab-${activeTab}`}
        className="min-h-0 flex-1 overflow-y-auto p-3"
      >
        {renderPanel(activeTab)}
      </div>
    </aside>
  );
}
