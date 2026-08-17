import type { ReactNode } from "react";
import { X } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import type { InspectorKind } from "../../lib/workbench-layout";
import { SessionInspector, type SessionInspectorTab } from "./context-inspector/SessionInspector";
import { useSessionInspectorProjection, type SessionInspectorProjection } from "./context-inspector/session-inspector-projection";

type InspectorCount = number | "loading" | "unavailable";

interface InspectorTab<T extends string> {
  id: T;
  label: string;
  count?: InspectorCount;
}

export function sessionInspectorTabs(projection: SessionInspectorProjection): [InspectorTab<SessionInspectorTab>, ...InspectorTab<SessionInspectorTab>[]] {
  const count = (value: { isLoading: boolean; error: unknown }, length: number): InspectorCount => (
    value.isLoading ? "loading" : value.error ? "unavailable" : length
  );
  return [
    { id: "agents", label: "Agents", count: count(projection.agents, projection.agents.items.length) },
    { id: "changes", label: "Changes", count: count(projection.changes, projection.changes.files?.length ?? 0) },
    { id: "context", label: "Context" },
  ];
}

export function ContextInspector({
  kind,
  id = "context-inspector",
  onClose,
}: {
  kind: InspectorKind;
  id?: string;
  onClose?: () => void;
}) {
  const projection = useSessionInspectorProjection();
  const tabs = sessionInspectorTabs(projection);
  return <InspectorShell key="session" id={id} kind={kind} tabs={tabs} onClose={onClose} renderPanel={(activeTab) => <SessionInspector activeTab={activeTab} projection={projection} />} />;
}

export function InspectorShell<T extends string>({
  kind,
  id,
  tabs,
  onClose,
  renderPanel,
}: {
  kind: InspectorKind;
  id: string;
  tabs: readonly [InspectorTab<T>, ...InspectorTab<T>[]];
  onClose?: () => void;
  renderPanel: (activeTab: T) => ReactNode;
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get("inspector");
  const activeTab = tabs.find((tab) => tab.id === requestedTab)?.id ?? tabs[0].id;
  const setActiveTab = (tabId: T) => {
    const next = new URLSearchParams(searchParams);
    if (tabId === tabs[0].id) next.delete("inspector");
    else next.set("inspector", tabId);
    setSearchParams(next, { replace: true });
  };
  const selectTab = (index: number) => {
    const tab = tabs[(index + tabs.length) % tabs.length];
    setActiveTab(tab.id);
    document.getElementById(`${id}-tab-${tab.id}`)?.focus();
  };

  return (
    <aside id={id} className="flex h-full w-full min-w-0 flex-col bg-bg-surface" aria-label="Context inspector">
      <div className="flex h-[58px] shrink-0 items-center gap-[3px] border-b border-border-subtle px-2" role="tablist" aria-label={`${kind} context sections`}>
        {tabs.map((tab, index) => (
          <button
            key={tab.id}
            id={`${id}-tab-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            aria-controls={`${id}-panel`}
            tabIndex={activeTab === tab.id ? 0 : -1}
            className={`relative inline-flex h-[30px] min-w-0 flex-1 items-center justify-center gap-[5px] px-1.5 text-[11px] font-semibold transition-colors duration-[var(--motion-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand ${activeTab === tab.id ? "text-text-primary after:absolute after:-bottom-[7px] after:left-[7px] after:right-[7px] after:h-0.5 after:rounded-sm after:bg-brand" : "text-text-tertiary hover:text-text-secondary"}`}
            onClick={() => setActiveTab(tab.id)}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight") { event.preventDefault(); selectTab(index + 1); }
              if (event.key === "ArrowLeft") { event.preventDefault(); selectTab(index - 1); }
              if (event.key === "Home") { event.preventDefault(); selectTab(0); }
              if (event.key === "End") { event.preventDefault(); selectTab(tabs.length - 1); }
            }}
          >
            <span>{tab.label}</span>
            {tab.count !== undefined ? (
              <span
                className={`min-w-4 rounded-full bg-bg-muted px-[5px] font-mono text-[10px] font-semibold leading-4 tabular-nums text-text-tertiary ${activeTab === tab.id ? "bg-[color:color-mix(in_srgb,var(--brand)_14%,var(--bg-muted))] text-text-secondary" : ""}`}
                data-testid={`inspector-count-${tab.id}`}
                aria-label={`${tab.label} count ${tab.count === "loading" ? "loading" : tab.count === "unavailable" ? "unavailable" : tab.count}`}
              >
                {tab.count === "loading" ? "…" : tab.count === "unavailable" ? "—" : tab.count}
              </span>
            ) : null}
          </button>
        ))}
        {onClose ? <button type="button" aria-label="Close context inspector" aria-controls={id} onClick={onClose} className="grid h-[34px] w-[30px] flex-none place-items-center rounded-[var(--shape-control)] text-text-secondary transition-colors duration-[var(--motion-fast)] hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:[box-shadow:var(--focus)] [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"><X size={16} aria-hidden="true" /></button> : null}
      </div>
      <div
        id={`${id}-panel`}
        role="tabpanel"
        aria-labelledby={`${id}-tab-${activeTab}`}
        className="min-h-0 flex-1 overflow-y-auto px-3 pb-8 pt-[13px]"
      >
        {renderPanel(activeTab)}
      </div>
    </aside>
  );
}
