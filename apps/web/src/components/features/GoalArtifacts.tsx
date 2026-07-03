import { useState } from "react";
import { FileText } from "lucide-react";
import type { GoalArtifactName } from "../../api/types";
import { useGoalArtifact, useGoalArtifacts } from "../../api/queries";
import { MarkdownContent } from "../primitives/MarkdownContent";

interface GoalArtifactsProps {
  slug: string;
  goalId: string;
}

const CANONICAL_ARTIFACTS: { name: GoalArtifactName; label: string; testId: string }[] = [
  { name: "plan.md", label: "Plan", testId: "artifact-tab-plan" },
  { name: "build.md", label: "Build", testId: "artifact-tab-build" },
  { name: "review.md", label: "Review", testId: "artifact-tab-review" },
  { name: "spec-compliance.md", label: "Spec Compliance", testId: "artifact-tab-spec-compliance" },
  { name: "budget.md", label: "Budget", testId: "artifact-tab-budget" },
  { name: "approvals.md", label: "Approvals", testId: "artifact-tab-approvals" },
  { name: "retry-log.md", label: "Retry Log", testId: "artifact-tab-retry-log" },
  { name: "final-report.md", label: "Final Report", testId: "artifact-tab-final-report" },
];

export function GoalArtifacts({ slug, goalId }: GoalArtifactsProps) {
  const { data: artifacts, isLoading: listLoading } = useGoalArtifacts(slug, goalId);
  const [selected, setSelected] = useState<GoalArtifactName>("plan.md");

  const presentNames = new Set((artifacts ?? []).map((file) => file.name));
  const { data: artifactRead, isLoading: contentLoading, error: readError } = useGoalArtifact(
    slug,
    goalId,
    selected,
  );

  return (
    <div data-testid="goal-tab-artifacts" className="flex h-full flex-col">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border-subtle shrink-0">
        <span className="text-[12.5px] text-text-secondary">
          {listLoading ? "Loading artifacts…" : `${presentNames.size} artifact${presentNames.size === 1 ? "" : "s"} present`}
        </span>
      </div>
      <div className="flex-1 overflow-hidden flex">
        <nav
          className="w-48 shrink-0 border-r border-border-subtle overflow-y-auto py-2"
          aria-label="Goal artifacts"
        >
          {CANONICAL_ARTIFACTS.map((entry) => {
            const present = presentNames.has(entry.name);
            const active = selected === entry.name;
            return (
              <button
                key={entry.name}
                type="button"
                data-testid={entry.testId}
                aria-pressed={active}
                onClick={() => setSelected(entry.name)}
                className={`flex w-full items-center gap-2 px-3 py-2 text-left text-[12.5px] transition-colors duration-150 cursor-pointer border-l-2 ${
                  active
                    ? "bg-bg-elevated text-text-primary border-accent"
                    : "text-text-tertiary border-transparent hover:bg-bg-hover hover:text-text-secondary"
                }`}
              >
                <FileText size={13} className={present ? "text-accent shrink-0" : "text-text-muted shrink-0"} />
                <span className="flex-1 truncate">{entry.label}</span>
                {present ? (
                  <span className="text-[10px] text-success">●</span>
                ) : (
                  <span className="text-[10px] text-text-muted">○</span>
                )}
              </button>
            );
          })}
        </nav>
        <div className="flex-1 overflow-y-auto p-5 max-w-3xl mx-auto w-full">
          {contentLoading ? (
            <div className="flex items-center justify-center gap-2 text-text-secondary text-sm">
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-text-muted border-t-transparent" />
              Loading artifact…
            </div>
          ) : readError || !artifactRead || !artifactRead.content ? (
            <div
              data-testid="artifact-markdown-viewer"
              className="flex items-center justify-center text-text-tertiary text-sm py-12"
            >
              No artifact available
            </div>
          ) : (
            <div data-testid="artifact-markdown-viewer" className="text-[13px] text-text-primary">
              <MarkdownContent>{artifactRead.content}</MarkdownContent>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}