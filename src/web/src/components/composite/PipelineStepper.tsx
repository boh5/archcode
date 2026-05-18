import { useWorkflow } from "../../api/queries";
import type { WorkflowState } from "../../api/types";

const PIPELINE_STEPS = [
  { icon: "P", label: "product" },
  { icon: "C", label: "critic" },
  { icon: "S", label: "spec" },
  { icon: "C", label: "critic" },
  { icon: "F", label: "foreman" },
  { icon: "✓", label: "done" },
] as const;

type StepStatus = "completed" | "current" | "pending";

export function getStepStatuses(stage: string): StepStatus[] {
  const statuses: StepStatus[] = [
    "pending",
    "pending",
    "pending",
    "pending",
    "pending",
    "pending",
  ];

  const currentStepIndex: Record<string, number> = {
    idle: -1,
    product_drafting: 0,
    critic_prd_review: 1,
    spec_drafting: 2,
    critic_spec_review: 3,
    awaiting_user_approval: 4,
    foreman_executing: 4,
    final_review: 5,
    complete: 6,
    failed: 6,
  };

  const idx = currentStepIndex[stage] ?? -1;

  for (let i = 0; i < 6; i++) {
    if (i < idx) {
      statuses[i] = "completed";
    } else if (i === idx) {
      statuses[i] = "current";
    } else {
      statuses[i] = "pending";
    }
  }

  return statuses;
}

const STEP_ICON_CLASSES: Record<StepStatus, string> = {
  completed: "bg-success text-white",
  current: "bg-accent text-white shadow-[0_0_0_3px_var(--accent-muted)] animate-[pulse-ring_2s_ease-in-out_infinite]",
  pending: "bg-bg-active text-text-muted border-[1.5px] border-border-strong",
};

const STEP_LABEL_CLASSES: Record<StepStatus, string> = {
  completed: "text-text-tertiary",
  current: "text-text-primary font-medium",
  pending: "text-text-muted",
};

interface PipelineStepperProps {
  slug: string;
  sessionId: string;
}

export function PipelineStepper({ slug, sessionId }: PipelineStepperProps) {
  const { data: workflow } = useWorkflow(slug, sessionId);
  const wf = workflow as WorkflowState | null | undefined;
  const stage = wf ? (wf.currentStep ?? wf.stage ?? "idle") : "idle";

  const statuses = getStepStatuses(stage);
  const isFailed = stage === "failed";

  return (
    <div className="flex items-center gap-0 px-5 py-2.5 bg-bg-surface border-b border-border-subtle shrink-0 overflow-x-auto">
      {PIPELINE_STEPS.map((step, i) => {
        const status = statuses[i];
        const isLast = i === PIPELINE_STEPS.length - 1;
        const displayIcon = isLast && isFailed ? "✗" : step.icon;
        const displayLabel = isLast && isFailed ? "failed" : step.label;

        return (
          <div className="flex items-center gap-1.5 shrink-0" key={i}>
            <div className={`w-[22px] h-[22px] rounded-full flex items-center justify-center text-[10px] font-semibold shrink-0 ${STEP_ICON_CLASSES[status]}`}>
              {displayIcon}
            </div>
            <span className={`text-xs whitespace-nowrap ${STEP_LABEL_CLASSES[status]}`}>
              {displayLabel}
            </span>
            {!isLast && (
              <div className={`w-7 h-0.5 shrink-0 mx-1 ${statuses[i] === "completed" ? "bg-success" : "bg-border-default"}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}