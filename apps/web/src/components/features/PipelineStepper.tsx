import { Check } from "lucide-react";
import { useWorkflow } from "../../api/queries";
import type { WorkflowState } from "../../api/types";

// Frontend display map matching backend WORKFLOW_TYPE_REGISTRY exactly
const WORKFLOW_STAGES: Record<string, readonly { key: string; label: string; icon: string }[]> = {
  research_only: [
    { key: "idle", label: "Idle", icon: "○" },
    { key: "researching", label: "Research", icon: "R" },
    { key: "research_consolidation", label: "Consolidate", icon: "C" },
  ],
  quick_fix: [
    { key: "idle", label: "Idle", icon: "○" },
    { key: "quick_analysis", label: "Analyze", icon: "A" },
    { key: "quick_patch", label: "Patch", icon: "P" },
    { key: "quick_verify", label: "Verify", icon: "V" },
  ],
  full_feature: [
    { key: "idle", label: "Idle", icon: "○" },
    { key: "product_drafting", label: "Product", icon: "P" },
    { key: "critic_prd_review", label: "Critic", icon: "C" },
    { key: "spec_drafting", label: "Spec", icon: "S" },
    { key: "critic_spec_review", label: "Critic", icon: "C" },
    { key: "awaiting_user_approval", label: "Approval", icon: "!" },
    { key: "foreman_executing", label: "Foreman", icon: "F" },
    { key: "final_review", label: "Review", icon: "R" },
  ],
};

type StepState = "completed" | "current" | "pending";

function getStepState(
  workflow: WorkflowState,
  stepKey: string,
): StepState {
  const currentStage = workflow.stage;
  if (!currentStage) return "pending";

  const stages = WORKFLOW_STAGES[workflow.type];
  if (!stages) return "pending";

  const stageKeys = stages.map((s) => s.key);
  const currentIndex = stageKeys.indexOf(currentStage);
  const stepIndex = stageKeys.indexOf(stepKey);

  if (workflow.status === "completed") return "completed";
  if (stepIndex < 0 || currentIndex < 0) return "pending";
  if (stepIndex < currentIndex) return "completed";
  if (stepIndex === currentIndex) return "current";
  return "pending";
}

function StepIcon({
  state,
  icon,
}: {
  state: StepState;
  icon: string;
}) {
  if (state === "completed") {
    return (
      <div className="w-[22px] h-[22px] rounded-full flex items-center justify-center text-[10px] font-semibold bg-success text-white shrink-0">
        <Check size={12} />
      </div>
    );
  }
  if (state === "current") {
    return (
      <div className="w-[22px] h-[22px] rounded-full flex items-center justify-center text-[10px] font-semibold bg-accent text-white shadow-[0_0_0_3px_var(--accent-muted)] animate-pulse shrink-0">
        {icon}
      </div>
    );
  }
  return (
    <div className="w-[22px] h-[22px] rounded-full flex items-center justify-center text-[10px] font-semibold bg-bg-active text-text-muted border-[1.5px] border-border-strong shrink-0">
      {icon}
    </div>
  );
}

function Connector({ completed }: { completed: boolean }) {
  return (
    <div
      className={`w-7 h-0.5 shrink-0 mx-1 ${
        completed ? "bg-success" : "bg-border-default"
      }`}
    />
  );
}

const WORKFLOW_TYPE_LABELS: Record<string, string> = {
  research_only: "Research",
  quick_fix: "Quick Fix",
  full_feature: "Full Feature",
};

interface PipelineStepperProps {
  slug: string;
  workflowId?: string;
}

export function PipelineStepper({ slug, workflowId = "" }: PipelineStepperProps) {
  const { data: workflow } = useWorkflow(slug, workflowId);

  if (!workflow) return null;

  const wf = workflow as WorkflowState;
  const isDone = wf.status === "completed";
  const stages = WORKFLOW_STAGES[wf.type];

  // Unknown workflow type — don't render pipeline
  if (!stages) return null;

  return (
    <div className="flex items-center gap-0 px-5 py-2.5 bg-bg-surface border-b border-border-subtle shrink-0 overflow-x-auto">
      <span className="text-[10px] font-semibold text-text-muted uppercase tracking-wider mr-3 shrink-0">
        {WORKFLOW_TYPE_LABELS[wf.type] ?? wf.type}
      </span>
      {stages.map((step, index) => {
        // Skip idle step visually — show it as implicit start
        if (step.key === "idle") return null;
        const state = isDone
          ? "completed"
          : getStepState(wf, step.key);
        const labelClass =
          state === "completed"
            ? "text-text-tertiary"
            : state === "current"
              ? "text-text-primary font-medium"
              : "text-text-muted";

        // Find previous non-idle step for connector
        const prevNonIdle = index > 0
          ? stages.slice(0, index).reverse().find((s) => s.key !== "idle")
          : undefined;

        return (
          <div key={step.key} className="flex items-center gap-0">
            {prevNonIdle && (
              <Connector
                completed={
                  isDone || getStepState(wf, prevNonIdle.key) === "completed"
                }
              />
            )}
            <div className="flex items-center gap-1.5 shrink-0">
              <StepIcon state={state} icon={step.icon} />
              <span className={`text-xs whitespace-nowrap ${labelClass}`}>
                {step.label}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}