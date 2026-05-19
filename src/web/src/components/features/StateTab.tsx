import { useState, useCallback } from "react";
import { useWorkflow } from "../../api/queries";
import { useArtifactContent } from "../../hooks/use-artifact-content";
import type { WorkflowState } from "../../api/types";
import { PipelineStepper } from "../composite/PipelineStepper";

const AGENT_TYPES = [
  "orchestrator",
  "product",
  "spec",
  "critic",
  "foreman",
  "builder",
  "reviewer",
  "librarian",
  "explorer",
] as const;

type AgentType = (typeof AGENT_TYPES)[number];

const AGENT_COLORS: Record<AgentType, string> = {
  orchestrator: "text-agent-orchestrator",
  product: "text-agent-product",
  spec: "text-agent-spec",
  critic: "text-agent-critic",
  foreman: "text-agent-foreman",
  builder: "text-agent-builder",
  reviewer: "text-agent-reviewer",
  librarian: "text-agent-librarian",
  explorer: "text-agent-explorer",
};

const DISPLAY_ARTIFACTS = ["PRD", "SPEC", "TASKS"] as const;

type ArtifactKind = (typeof DISPLAY_ARTIFACTS)[number];

type ArtifactStatus = "missing" | "draft" | "finalized";

const STATUS_CLASSES: Record<ArtifactStatus, string> = {
  missing: "bg-bg-active text-text-muted",
  draft: "bg-warning-muted text-warning",
  finalized: "bg-success-muted text-success",
};

const STAGE_LABELS: Record<string, string> = {
  idle: "Idle",
  product_drafting: "Product Agent working",
  critic_prd_review: "Critic reviewing PRD",
  spec_drafting: "Spec Agent working",
  critic_spec_review: "Critic reviewing SPEC",
  awaiting_user_approval: "Awaiting approval",
  foreman_executing: "Foreman executing",
  final_review: "Final review",
  complete: "Complete",
  failed: "Failed",
};

function getArtifactStatus(
  wf: WorkflowState,
  kind: ArtifactKind,
): ArtifactStatus {
  const value = wf.artifacts?.[kind];
  if (!value) return "missing";
  const finalizationStages: Record<ArtifactKind, string[]> = {
    PRD: [
      "critic_prd_review",
      "spec_drafting",
      "critic_spec_review",
      "awaiting_user_approval",
      "foreman_executing",
      "final_review",
      "complete",
    ],
    SPEC: [
      "critic_spec_review",
      "awaiting_user_approval",
      "foreman_executing",
      "final_review",
      "complete",
    ],
    TASKS: ["foreman_executing", "final_review", "complete"],
  };
  const stage = wf.stage ?? wf.currentStep ?? "idle";
  if (finalizationStages[kind].includes(stage)) return "finalized";
  return "draft";
}

function isValidAgentType(type: string): type is AgentType {
  return AGENT_TYPES.includes(type as AgentType);
}

function formatTime(isoString: string): string {
  try {
    const date = new Date(isoString);
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return isoString;
  }
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px] font-semibold text-text-muted uppercase tracking-wider mb-1.5">
      {children}
    </div>
  );
}

function StateCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="p-2.5 bg-bg-elevated border border-border-default rounded-md">
      {children}
    </div>
  );
}

function StateRow({
  label,
  children,
  className = "",
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className="flex items-center justify-between py-1 text-xs first:border-t-0 border-t border-border-subtle">
      <span className="text-text-muted">{label}</span>
      <span className={`text-text-primary font-medium ${className}`}>
        {children}
      </span>
    </div>
  );
}

function AgentRow({
  name,
  agentType,
  status,
}: {
  name: string;
  agentType: AgentType;
  status: string;
}) {
  const colorClass = AGENT_COLORS[agentType] ?? "text-text-secondary";
  return (
    <div className="flex items-center justify-between py-1 text-xs border-t border-border-subtle first:border-t-0">
      <span className={`font-medium ${colorClass}`}>{name}</span>
      <span
        className={
          status === "working" || status === "running"
            ? "text-success"
            : "text-text-muted"
        }
      >
        {status}
      </span>
    </div>
  );
}

function ArtifactRow({
  name,
  status,
  onClick,
}: {
  name: string;
  status: ArtifactStatus;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center justify-between w-full py-1 text-xs border-t border-border-subtle first:border-t-0 cursor-pointer hover:bg-bg-hover transition-colors duration-150 rounded-none"
    >
      <span className="text-text-primary font-mono">{name}</span>
      <span
        className={`px-2 py-0.5 rounded-sm text-[10.5px] font-semibold ${STATUS_CLASSES[status]}`}
      >
        {status}
      </span>
    </button>
  );
}

function ArtifactDrawer({
  title,
  content,
  isLoading,
  error,
  onClose,
}: {
  title: string;
  content: string | null;
  isLoading: boolean;
  error: string | null;
  onClose: () => void;
}) {
  return (
    <div className="absolute inset-0 z-10 flex bg-bg-surface">
      <div className="flex flex-col w-full h-full">
        <div className="flex items-center justify-between px-3 h-10 border-b border-border-subtle shrink-0">
          <span className="text-xs font-semibold text-text-primary font-mono">
            {title}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="w-6 h-6 flex items-center justify-center text-text-muted hover:text-text-primary transition-colors cursor-pointer"
          >
            ✕
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-3">
          {isLoading && (
            <div className="flex items-center justify-center py-8 text-text-muted text-xs">
              Loading...
            </div>
          )}
          {error && (
            <div className="text-error text-xs py-4">{error}</div>
          )}
          {content && (
            <pre className="whitespace-pre-wrap break-words text-xs text-text-primary font-mono leading-relaxed">
              {content}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

interface StateTabProps {
  slug: string;
  sessionId: string;
}

export function StateTab({ slug, sessionId }: StateTabProps) {
  const { data: workflow } = useWorkflow(slug, sessionId);
  const wf = workflow as WorkflowState | null | undefined;

  const [selectedArtifact, setSelectedArtifact] = useState<ArtifactKind | null>(
    null,
  );

  const { data: artifactContent, isLoading: artifactLoading, error: artifactError } =
    useArtifactContent(slug, wf?.id, selectedArtifact ?? "");

  const handleArtifactClick = useCallback((kind: ArtifactKind) => {
    setSelectedArtifact(kind);
  }, []);

  const handleCloseDrawer = useCallback(() => {
    setSelectedArtifact(null);
  }, []);

  const stage = wf ? (wf.currentStep ?? wf.stage ?? "idle") : "idle";
  const status = wf?.status ?? "unknown";
  const retryCount = wf?.retryCount ?? 0;
  const maxRetries = wf?.maxRetries ?? 3;
  const createdAt = wf?.createdAt;

  const agents = wf
    ? (() => {
        const result: Array<{
          name: string;
          type: AgentType;
          status: string;
        }> = [];

        result.push({
          name: "Orchestrator",
          type: "orchestrator",
          status: stage === "idle" ? "waiting" : "working",
        });

        const sessionEntries = Object.entries(wf.sessionIds ?? {});
        for (const [stageName] of sessionEntries) {
          if (!isValidAgentType(stageName)) continue;
          const isCurrentStep = wf.currentStep === stageName;
          const stageCompleted =
            wf.status === "completed" ||
            (wf.currentStep &&
              AGENT_TYPES.indexOf(stageName as AgentType) <
                AGENT_TYPES.indexOf(wf.currentStep as AgentType));
          result.push({
            name: stageName.charAt(0).toUpperCase() + stageName.slice(1),
            type: stageName as AgentType,
            status: isCurrentStep
              ? "working"
              : stageCompleted
                ? "completed"
                : "pending",
          });
        }

        const taskEntries = Object.entries(wf.taskSessionIds ?? {});
        for (const [taskName] of taskEntries) {
          if (!isValidAgentType(taskName)) continue;
          result.push({
            name: taskName.charAt(0).toUpperCase() + taskName.slice(1),
            type: taskName as AgentType,
            status: "pending",
          });
        }

        return result;
      })()
    : [];

  return (
    <div className="relative flex flex-col h-full overflow-y-auto p-3.5">
      <div className="mb-3.5">
        <PipelineStepper slug={slug} sessionId={sessionId} />
      </div>

      <div className="mb-3.5">
        <SectionLabel>Workflow</SectionLabel>
        <StateCard>
          {wf ? (
            <>
              <StateRow label="ID">
                <span className="font-mono text-[11px]">
                  {wf.id.length > 16 ? `${wf.id.slice(0, 16)}…` : wf.id}
                </span>
              </StateRow>
              <StateRow label="Status">
                <span
                  className={
                    status === "active"
                      ? "text-success"
                      : status === "failed"
                        ? "text-error"
                        : status === "completed"
                          ? "text-text-primary"
                          : "text-warning"
                  }
                >
                  {status}
                </span>
              </StateRow>
              <StateRow label="Stage">
                <span className="text-success">
                  {STAGE_LABELS[stage] ?? stage}
                </span>
              </StateRow>
              {retryCount > 0 && (
                <StateRow label="Attempt">
                  {retryCount}/{maxRetries}
                </StateRow>
              )}
              {createdAt && (
                <StateRow label="Created">
                  <span className="text-[11px]">{formatTime(createdAt)}</span>
                </StateRow>
              )}
            </>
          ) : (
            <div className="py-2 text-xs text-text-muted text-center">
              No workflow active
            </div>
          )}
        </StateCard>
      </div>

      {agents.length > 0 && (
        <div className="mb-3.5">
          <SectionLabel>Active Agents</SectionLabel>
          <StateCard>
            {agents.map((agent, i) => (
              <AgentRow
                key={`${agent.type}-${i}`}
                name={agent.name}
                agentType={agent.type}
                status={agent.status}
              />
            ))}
          </StateCard>
        </div>
      )}

      <div className="mb-3.5">
        <SectionLabel>Artifacts</SectionLabel>
        <StateCard>
          {wf ? (
            DISPLAY_ARTIFACTS.map((kind) => (
              <ArtifactRow
                key={kind}
                name={`${kind}.md`}
                status={getArtifactStatus(wf, kind)}
                onClick={() => handleArtifactClick(kind)}
              />
            ))
          ) : (
            <div className="py-2 text-xs text-text-muted text-center">
              No artifacts
            </div>
          )}
        </StateCard>
      </div>

      {selectedArtifact && (
        <ArtifactDrawer
          title={`${selectedArtifact}.md`}
          content={artifactContent ?? null}
          isLoading={artifactLoading}
          error={artifactError?.message ?? null}
          onClose={handleCloseDrawer}
        />
      )}
    </div>
  );
}