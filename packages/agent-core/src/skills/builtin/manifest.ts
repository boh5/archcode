import gitMaster from "./git-master/SKILL.md" with { type: "text" };
import safeRefactor from "./safe-refactor/SKILL.md" with { type: "text" };
import codemap from "./codemap/SKILL.md" with { type: "text" };
import reviewWork from "./review-work/SKILL.md" with { type: "text" };
import researchDocs from "./research-docs/SKILL.md" with { type: "text" };
import goalCreate from "./goal-create/SKILL.md" with { type: "text" };
import automationCreate from "./automation-create/SKILL.md" with { type: "text" };

export const BUILTIN_SKILL_BODIES = {
  "git-master": gitMaster,
  "safe-refactor": safeRefactor,
  codemap,
  "review-work": reviewWork,
  "research-docs": researchDocs,
  "goal-create": goalCreate,
  "automation-create": automationCreate,
} as const;

export type BuiltinSkillName = keyof typeof BUILTIN_SKILL_BODIES;
