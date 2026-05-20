import { useState } from "react";
import { useParams } from "react-router-dom";
import { DiffTab } from "./DiffTab";
import { StateTab } from "./StateTab";
import { TodoTab } from "./TodoTab";

type TabId = "diff" | "state" | "todo";

interface TabDef {
  id: TabId;
  label: string;
}

const TABS: TabDef[] = [
  { id: "diff", label: "Diff" },
  { id: "state", label: "State" },
  { id: "todo", label: "Todo" },
];

export function DetailPanel() {
  const [activeTab, setActiveTab] = useState<TabId>("diff");
  const { slug = "", sessionId = "" } = useParams<{ slug: string; sessionId: string }>();

  return (
    <div className="flex h-full flex-col border-l border-border-subtle bg-bg-surface">
      <div className="flex h-10 shrink-0 border-b border-border-subtle">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            className={`flex-1 text-[11px] font-semibold uppercase tracking-wider transition-colors duration-150 ${
              activeTab === tab.id
                ? "text-accent border-b-2 border-accent"
                : "text-text-muted hover:text-text-secondary"
            }`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="min-w-0 flex-1 overflow-hidden">
        {activeTab === "diff" && <DiffTab slug={slug} />}
        {activeTab === "state" && <StateTab slug={slug} sessionId={sessionId} />}
        {activeTab === "todo" && <TodoTab slug={slug} sessionId={sessionId} />}
      </div>
    </div>
  );
}
