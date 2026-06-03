import { useWorkflow } from "../../api/queries";
import type { WorkflowState } from "../../api/types";

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

type ArtifactStatus = "missing" | "draft" | "pending" | "finalized";

const ARTIFACT_STATUS_COLORS: Record<ArtifactStatus, string> = {
  missing: "text-text-muted",
  draft: "text-warning",
  pending: "text-text-muted",
  finalized: "text-success",
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
  researching: "Researching",
  research_consolidation: "Research consolidation",
  quick_analysis: "Quick analysis",
  quick_patch: "Quick patch",
  quick_verify: "Quick verification",
};

function getArtifactStatus(
  wf: WorkflowState,
  kind: ArtifactKind,
): ArtifactStatus {
  const value = wf.artifacts?.[kind];
  if (!value) return "pending";
  const finalizationStages: Record<ArtifactKind, string[]> = {
    PRD: [
      "critic_prd_review",
      "spec_drafting",
      "critic_spec_review",
      "awaiting_user_approval",
      "foreman_executing",
      "final_review",
    ],
    SPEC: [
      "critic_spec_review",
      "awaiting_user_approval",
      "foreman_executing",
      "final_review",
    ],
    TASKS: ["foreman_executing", "final_review"],
  };
  const stage = wf.stage ?? "idle";
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
  depth,
  status,
}: {
  name: string;
  agentType: AgentType;
  depth: number;
  status: string;
}) {
  const colorClass = AGENT_COLORS[agentType] ?? "text-text-secondary";
  const isActive = status === "working" || status === "running" || status === "researching";
  return (
    <div className="flex items-center justify-between py-1 text-xs border-t border-border-subtle first:border-t-0">
      <span className={`font-medium ${colorClass}`}>{name}</span>
      <span className={isActive ? "text-success" : "text-text-muted"}>
        {`depth ${depth} · ${status}`}
      </span>
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

  const stage = wf ? (wf.stage ?? "idle") : "idle";
  const status = wf?.status ?? "unknown";
  const retryCount = wf?.retryCount ?? 0;
  const maxRetries = wf?.maxRetries ?? 3;
  const createdAt = wf?.createdAt;

  const agents = wf
    ? (() => {
        const result: Array<{
          name: string;
          type: AgentType;
          depth: number;
          status: string;
        }> = [];

        result.push({
          name: "Orchestrator",
          type: "orchestrator",
          depth: 0,
          status: stage === "idle" ? "waiting" : "working",
        });

        const sessionEntries = Object.entries(wf.sessionIds ?? {});
        for (const [stageName] of sessionEntries) {
          if (!isValidAgentType(stageName)) continue;
          const isCurrentStep = wf.stage === stageName;
          const stageCompleted =
            wf.status === "completed" ||
            (wf.stage &&
              AGENT_TYPES.indexOf(stageName as AgentType) <
                AGENT_TYPES.indexOf(wf.stage as AgentType));
          result.push({
            name: stageName.charAt(0).toUpperCase() + stageName.slice(1),
            type: stageName as AgentType,
            depth: 1,
            status: isCurrentStep
              ? "working"
              : stageCompleted
                ? "completed"
                : "pending",
          });
        }

        return result;
      })()
    : [];

  return (
    <div className="relative flex flex-col h-full overflow-y-auto p-3.5">
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
                depth={agent.depth}
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
            DISPLAY_ARTIFACTS.map((kind) => {
              const artifactStatus = getArtifactStatus(wf, kind);
              return (
                <StateRow
                  key={kind}
                  label={`${kind}.md`}
                  className={ARTIFACT_STATUS_COLORS[artifactStatus]}
                >
                  {artifactStatus}
                </StateRow>
              );
            })
          ) : (
            <div className="py-2 text-xs text-text-muted text-center">
              No artifacts
            </div>
          )}
        </StateCard>
      </div>
    </div>
  );
}
