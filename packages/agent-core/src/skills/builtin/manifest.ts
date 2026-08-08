import analyzeWork from "./analyze-work/SKILL.md" with { type: "text" };
import analyzeWorkDiagnosis from "./analyze-work/references/diagnosis-method.md" with { type: "text" };
import automationCreate from "./automation-create/SKILL.md" with { type: "text" };
import automationScheduleExamples from "./automation-create/references/schedule-examples.md" with { type: "text" };
import codemap from "./codemap/SKILL.md" with { type: "text" };
import codemapEvidenceMap from "./codemap/references/evidence-map-example.md" with { type: "text" };
import executePlan from "./execute-plan/SKILL.md" with { type: "text" };
import executePlanCheckpoints from "./execute-plan/references/execution-checkpoints.md" with { type: "text" };
import gitMaster from "./git-master/SKILL.md" with { type: "text" };
import gitMasterSafety from "./git-master/references/operation-safety.md" with { type: "text" };
import goalReview from "./goal-review/SKILL.md" with { type: "text" };
import goalReviewMatrix from "./goal-review/references/evidence-matrix-example.md" with { type: "text" };
import orchestrateWork from "./orchestrate-work/SKILL.md" with { type: "text" };
import orchestrateDelegationPacket from "./orchestrate-work/references/delegation-packet.md" with { type: "text" };
import planWork from "./plan-work/SKILL.md" with { type: "text" };
import planWorkTemplate from "./plan-work/assets/plan-template.md" with { type: "text" };
import researchDocs from "./research-docs/SKILL.md" with { type: "text" };
import researchSourceEvaluation from "./research-docs/references/source-evaluation.md" with { type: "text" };
import reviewChange from "./review-change/SKILL.md" with { type: "text" };
import reviewChangeLenses from "./review-change/references/review-lenses.md" with { type: "text" };
import reviewWork from "./review-work/SKILL.md" with { type: "text" };
import reviewWorkPacket from "./review-work/references/review-packet.md" with { type: "text" };
import runGoal from "./run-goal/SKILL.md" with { type: "text" };
import safeRefactor from "./safe-refactor/SKILL.md" with { type: "text" };
import safeRefactorVerification from "./safe-refactor/references/boundary-verification.md" with { type: "text" };
import shapeTodo from "./shape-todo/SKILL.md" with { type: "text" };
import shapeTodoTemplate from "./shape-todo/references/todo-shaping-template.md" with { type: "text" };
import type { BuiltinSkillPackage } from "../types";

export const BUILTIN_SKILL_PACKAGES = {
  "analyze-work": packageOf(analyzeWork, {
    "references/diagnosis-method.md": analyzeWorkDiagnosis,
  }),
  "automation-create": packageOf(automationCreate, {
    "references/schedule-examples.md": automationScheduleExamples,
  }),
  codemap: packageOf(codemap, {
    "references/evidence-map-example.md": codemapEvidenceMap,
  }),
  "execute-plan": packageOf(executePlan, {
    "references/execution-checkpoints.md": executePlanCheckpoints,
  }),
  "git-master": packageOf(gitMaster, {
    "references/operation-safety.md": gitMasterSafety,
  }),
  "goal-review": packageOf(goalReview, {
    "references/evidence-matrix-example.md": goalReviewMatrix,
  }),
  "orchestrate-work": packageOf(orchestrateWork, {
    "references/delegation-packet.md": orchestrateDelegationPacket,
  }),
  "plan-work": packageOf(planWork, {
    "assets/plan-template.md": planWorkTemplate,
  }),
  "research-docs": packageOf(researchDocs, {
    "references/source-evaluation.md": researchSourceEvaluation,
  }),
  "review-change": packageOf(reviewChange, {
    "references/review-lenses.md": reviewChangeLenses,
  }),
  "review-work": packageOf(reviewWork, {
    "references/review-packet.md": reviewWorkPacket,
  }),
  "run-goal": packageOf(runGoal),
  "safe-refactor": packageOf(safeRefactor, {
    "references/boundary-verification.md": safeRefactorVerification,
  }),
  "shape-todo": packageOf(shapeTodo, {
    "references/todo-shaping-template.md": shapeTodoTemplate,
  }),
} as const satisfies Readonly<Record<string, BuiltinSkillPackage>>;

export type BuiltinSkillName = keyof typeof BUILTIN_SKILL_PACKAGES;

function packageOf(
  entry: string,
  resources: Readonly<Record<string, string | Uint8Array>> = {},
): BuiltinSkillPackage {
  return Object.freeze({ entry, resources: Object.freeze(resources) });
}
