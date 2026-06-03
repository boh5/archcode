import { useWorkflow } from "../../api/queries";
import type { WorkflowState } from "../../api/types";

const PIPELINE_STEPS = [
  { key: "product", label: "Product", icon: "P" },
  { key: "critic", label: "Critic", icon: "C" },
  { key: "spec", label: "Spec", icon: "S" },
  { key: "critic2", label: "Critic", icon: "C" },
  { key: "foreman", label: "Foreman", icon: "F" },
] as const;

const STEP_ORDER = ["product", "critic", "spec", "critic2", "foreman"];

type StepState = "completed" | "current" | "pending";

function getStepState(
  workflow: WorkflowState,
  stepKey: string,
): StepState {
  const currentStep = workflow.stage;
  if (!currentStep) return "pending";

  // Map workflow step names to pipeline step keys
  const currentKey = mapWorkflowStepToKey(currentStep);
  const currentIndex = STEP_ORDER.indexOf(currentKey);
  const stepIndex = STEP_ORDER.indexOf(stepKey);

  if (workflow.status === "completed") return "completed";
  if (stepIndex < currentIndex) return "completed";
  if (stepIndex === currentIndex) return "current";
  return "pending";
}

function mapWorkflowStepToKey(step: string): string {
  const lower = step.toLowerCase();
  if (lower === "product") return "product";
  if (lower === "critic") return "critic";
  if (lower === "spec" || lower === "specification") return "spec";
  if (lower === "foreman") return "foreman";
  // Second critic pass
  if (lower === "critic2" || lower === "spec_critic") return "critic2";
  return lower;
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
        ✓
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

interface PipelineStepperProps {
  slug: string;
  workflowId?: string;
}

export function PipelineStepper({ slug, workflowId = "" }: PipelineStepperProps) {
  const { data: workflow } = useWorkflow(slug, workflowId);

  if (!workflow) return null;

  const wf = workflow as WorkflowState;
  const isDone = wf.status === "completed";

  return (
    <div className="flex items-center gap-0 px-5 py-2.5 bg-bg-surface border-b border-border-subtle shrink-0 overflow-x-auto">
      {PIPELINE_STEPS.map((step, index) => {
        const state = isDone
          ? "completed"
          : getStepState(wf, step.key);
        const labelClass =
          state === "completed"
            ? "text-text-tertiary"
            : state === "current"
              ? "text-text-primary font-medium"
              : "text-text-muted";

        return (
          <div key={step.key} className="flex items-center gap-0">
            {index > 0 && (
              <Connector
                completed={
                  isDone || getStepState(wf, PIPELINE_STEPS[index - 1].key) === "completed"
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

      <Connector completed={isDone} />
      <div className="flex items-center gap-1.5 shrink-0">
        <div
          className={`w-[22px] h-[22px] rounded-full flex items-center justify-center text-[10px] font-semibold shrink-0 ${
            isDone
              ? "bg-success text-white"
              : "bg-bg-active text-text-muted border-[1.5px] border-border-strong"
          }`}
        >
          {isDone ? "✓" : "★"}
        </div>
        <span
          className={`text-xs whitespace-nowrap ${
            isDone ? "text-text-tertiary" : "text-text-muted"
          }`}
        >
          Done
        </span>
      </div>
    </div>
  );
}
