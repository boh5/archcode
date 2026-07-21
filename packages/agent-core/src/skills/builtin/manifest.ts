import gitMaster from "./git-master/SKILL.md" with { type: "text" };
import safeRefactor from "./safe-refactor/SKILL.md" with { type: "text" };
import codemap from "./codemap/SKILL.md" with { type: "text" };
import reviewWork from "./review-work/SKILL.md" with { type: "text" };
import researchDocs from "./research-docs/SKILL.md" with { type: "text" };
import automationCreate from "./automation-create/SKILL.md" with { type: "text" };
import orchestrateWork from "./orchestrate-work/SKILL.md" with { type: "text" };
import planWork from "./plan-work/SKILL.md" with { type: "text" };
import runGoal from "./run-goal/SKILL.md" with { type: "text" };
import shapeTodo from "./shape-todo/SKILL.md" with { type: "text" };
import goalReview from "./goal-review/SKILL.md" with { type: "text" };
import analyzeWork from "./analyze-work/SKILL.md" with { type: "text" };
import reviewChange from "./review-change/SKILL.md" with { type: "text" };

export const BUILTIN_SKILL_BODIES = {
  "git-master": gitMaster,
  "safe-refactor": safeRefactor,
  codemap,
  "review-work": reviewWork,
  "research-docs": researchDocs,
  "automation-create": automationCreate,
  "orchestrate-work": orchestrateWork,
  "plan-work": planWork,
  "run-goal": runGoal,
  "shape-todo": shapeTodo,
  "goal-review": goalReview,
  "analyze-work": analyzeWork,
  "review-change": reviewChange,
} as const;

export type BuiltinSkillName = keyof typeof BUILTIN_SKILL_BODIES;
