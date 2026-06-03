import { useSession, useWorkflow } from "../../api/queries";
import type { WorkflowState } from "../../api/types";

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

const WORKFLOW_TYPE_LABELS: Record<string, string> = {
  research_only: "Research only",
  quick_fix: "Quick fix",
  full_feature: "Full feature",
};

const CORE_ARTIFACTS = ["RESEARCH", "PRD", "SPEC", "TASKS", "HANDOFF_SUMMARY", "INTERACTIONS", "FINAL_REPORT"] as const;
const SUPPORTING_DIRS = ["CRITIC_REPORT", "EVIDENCE"] as const;
const SUPPORTING_DIR_LABELS: Record<string, string> = {
  CRITIC_REPORT: "Critic reports",
  EVIDENCE: "Evidence",
};

type CoreArtifactKind = (typeof CORE_ARTIFACTS)[number];

type ArtifactStatus = "missing" | "draft" | "finalized";

const ARTIFACT_STATUS_COLORS: Record<ArtifactStatus, string> = {
  missing: "text-text-muted",
  draft: "text-warning",
  finalized: "text-success",
};

const FINALIZATION_STAGES: Record<CoreArtifactKind, string[]> = {
  RESEARCH: [
    "research_consolidation",
    "quick_analysis",
    "quick_patch",
    "quick_verify",
    "critic_prd_review",
    "spec_drafting",
    "critic_spec_review",
    "awaiting_user_approval",
    "foreman_executing",
    "final_review",
  ],
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
  HANDOFF_SUMMARY: [],
  INTERACTIONS: [],
  FINAL_REPORT: ["final_review"],
};

function getArtifactStatus(
  wf: WorkflowState,
  kind: CoreArtifactKind,
): ArtifactStatus {
  const value = wf.artifacts?.[kind];
  if (!value) return "missing";
  const stage = wf.stage ?? "idle";
  const finalStages = FINALIZATION_STAGES[kind];
  if (finalStages.length > 0 && finalStages.includes(stage)) return "finalized";
  if (wf.status === "completed") return "finalized";
  return "draft";
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

interface StateTabProps {
  slug: string;
  sessionId: string;
}

export function StateTab({ slug, sessionId }: StateTabProps) {
  const { data: session } = useSession(slug, sessionId);
  const { data: workflow } = useWorkflow(slug, session?.workflowId ?? "");
  const wf = workflow as WorkflowState | null | undefined;

  const stage = wf ? (wf.stage ?? "idle") : "idle";
  const status = wf?.status ?? "unknown";
  const wfType = wf?.type ?? "";
  const retryCount = wf?.retryCount ?? 0;
  const maxRetries = wf?.maxRetries ?? 3;
  const createdAt = wf?.createdAt;
  const derivedFrom = wf?.derivedFrom ?? null;
  const derivedWorkflows = wf?.derivedWorkflows ?? [];
  const sessionIds = wf?.sessionIds ?? {};

  // No workflow — show minimal state
  if (!wf) {
    return (
      <div className="relative flex flex-col h-full overflow-y-auto p-3.5">
        <div className="mb-3.5">
          <SectionLabel>Workflow</SectionLabel>
          <StateCard>
            <div className="py-2 text-xs text-text-muted text-center">
              No workflow active
            </div>
          </StateCard>
        </div>
      </div>
    );
  }

  const sessionEntries = Object.entries(sessionIds);

  return (
    <div className="relative flex flex-col h-full overflow-y-auto p-3.5">
      <div className="mb-3.5">
        <SectionLabel>Workflow</SectionLabel>
        <StateCard>
          <StateRow label="ID">
            <span className="font-mono text-[11px]">
              {wf.id.length > 16 ? `${wf.id.slice(0, 16)}…` : wf.id}
            </span>
          </StateRow>
          <StateRow label="Type">
            <span className="text-text-secondary">
              {WORKFLOW_TYPE_LABELS[wfType] ?? wfType}
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
          {derivedFrom && (
            <StateRow label="Derived From">
              <span className="text-[11px] font-mono">
                {derivedFrom.workflowId.length > 16
                  ? `${derivedFrom.workflowId.slice(0, 16)}…`
                  : derivedFrom.workflowId}
              </span>
            </StateRow>
          )}
          {derivedWorkflows.length > 0 && (
            <StateRow label="Derived">
              <span className="text-[11px]">{derivedWorkflows.length} workflow{derivedWorkflows.length > 1 ? "s" : ""}</span>
            </StateRow>
          )}
        </StateCard>
      </div>

      {sessionEntries.length > 0 && (
        <div className="mb-3.5">
          <SectionLabel>Participants</SectionLabel>
          <StateCard>
            {sessionEntries.map(([role, sid]) => (
              <StateRow key={role} label={role}>
                <span className="font-mono text-[11px]">
                  {sid.length > 12 ? `${sid.slice(0, 12)}…` : sid}
                </span>
              </StateRow>
            ))}
          </StateCard>
        </div>
      )}

      <div className="mb-3.5">
        <SectionLabel>Artifacts</SectionLabel>
        <StateCard>
          {CORE_ARTIFACTS.map((kind) => {
            const value = wf.artifacts?.[kind];
            if (!value) return null;
            const artifactStatus = getArtifactStatus(wf, kind);
            return (
              <StateRow
                key={kind}
                label={kind}
                className={ARTIFACT_STATUS_COLORS[artifactStatus]}
              >
                {artifactStatus}
              </StateRow>
            );
          })}
          {SUPPORTING_DIRS.map((dir) => {
            const value = wf.artifacts?.[dir];
            if (!value) return null;
            return (
              <StateRow key={dir} label={SUPPORTING_DIR_LABELS[dir] ?? dir} className="text-text-tertiary">
                {Array.isArray(value) ? `${value.length} files` : "present"}
              </StateRow>
            );
          })}
          {Object.keys(wf.artifacts ?? {}).length === 0 && (
            <div className="py-2 text-xs text-text-muted text-center">
              No artifacts yet
            </div>
          )}
        </StateCard>
      </div>
    </div>
  );
}
