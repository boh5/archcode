import { z } from "zod/v4";
import { SKILL_NAME_REGEX } from "../skills/schema";

const NON_EMPTY = z.string().trim().min(1);
const DELEGATION_AGENT_TYPE = z.enum(["analyst", "build", "explore", "librarian"]).describe(
  "Delegated child Agent identity value. Current parent/depth capability admission determines whether the selected target is authorized.",
);
const DELEGATION_PROFILE = z.enum(["deep", "fast"]).describe(
  "Delegated model-resource Profile value. Current parent/depth capability admission determines whether the selected Agent/Profile pair is authorized.",
);
const DELEGATION_TITLE = NON_EMPTY.describe(
  "Short user-facing title for the child Session.",
);
const DELEGATION_OBJECTIVE = NON_EMPTY.describe(
  "Self-contained task-specific handoff for the fresh child, stating what it must accomplish or answer and what it must return.",
);
const SKILL_NAME_MESSAGE = "Skill name must match pattern ^[a-z0-9][a-z0-9-]*$";
const DELEGATION_SKILLS = z.array(
  z.string().regex(SKILL_NAME_REGEX, SKILL_NAME_MESSAGE),
).describe(
  "Workflow Skill names to load for the child; include only Skills needed for this task.",
);
const DELEGATION_BACKGROUND = z.boolean().describe(
  "Whether to run the child asynchronously: false waits for its final output; true returns its Session ID for later completion retrieval.",
);

export const DelegationRequestSchema = z.strictObject({
  agent_type: DELEGATION_AGENT_TYPE,
  profile: DELEGATION_PROFILE,
  title: DELEGATION_TITLE,
  objective: DELEGATION_OBJECTIVE,
  skills: DELEGATION_SKILLS,
  background: DELEGATION_BACKGROUND,
});

export type DelegationRequestInput = z.input<typeof DelegationRequestSchema>;
export type ParsedDelegationRequest = z.output<typeof DelegationRequestSchema>;
