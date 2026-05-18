import { useWorkflow } from "../../api/queries";
import type { WorkflowState } from "../../api/types";

/** The 6 visible steps in the pipeline stepper. */
const PIPELINE_STEPS = [
  { icon: "P", label: "product" },
  { icon: "C", label: "critic" },
  { icon: "S", label: "spec" },
  { icon: "C", label: "critic" },
  { icon: "F", label: "foreman" },
  { icon: "✓", label: "done" },
] as const;

type StepStatus = "completed" | "current" | "pending";

/**
 * Map a WorkflowStage to an array of step statuses for the 6 pipeline steps.
 *
 * Steps: P(product) → C(critic) → S(spec) → C(critic) → F(foreman) → ✓(done)
 */
export function getStepStatuses(stage: string): StepStatus[] {
  const statuses: StepStatus[] = [
    "pending",
    "pending",
    "pending",
    "pending",
    "pending",
    "pending",
  ];

  // Index at which each step becomes "current" (0-based).
  // All steps before that index are "completed".
  const currentStepIndex: Record<string, number> = {
    idle: -1,
    product_drafting: 0,
    critic_prd_review: 1,
    spec_drafting: 2,
    critic_spec_review: 3,
    awaiting_user_approval: 4,
    foreman_executing: 4,
    final_review: 5,
    complete: 6, // past last index → all completed
    failed: 6, // past last index → all completed (with ✗ override)
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
    <div className="pipeline-stepper">
      {PIPELINE_STEPS.map((step, i) => {
        const status = statuses[i];
        const isLast = i === PIPELINE_STEPS.length - 1;
        // Override last step icon for failed state
        const displayIcon = isLast && isFailed ? "✗" : step.icon;
        const displayLabel = isLast && isFailed ? "failed" : step.label;

        return (
          <div className="pipeline-step" key={i}>
            <div className={`pipeline-step-icon ${status}`}>{displayIcon}</div>
            <span className={`pipeline-step-label ${status}`}>{displayLabel}</span>
            {!isLast && (
              <div className={`pipeline-connector ${statuses[i] === "completed" ? "completed" : ""}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}