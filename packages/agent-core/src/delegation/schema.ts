import { z } from "zod/v4";
import {
  DIRECT_CHILD_AGENT_PROFILES,
  DELEGATED_AGENT_NAMES,
  MAX_DELEGATED_SESSION_TITLE_LENGTH,
  delegatedSessionTitleCapacityViolation,
} from "@archcode/protocol";
import { SKILL_NAME_REGEX } from "../skills/schema";

const NON_EMPTY = z.string().trim().min(1);
const DELEGATION_AGENT_TYPE = z.enum(DELEGATED_AGENT_NAMES).describe(
  "Delegated child Agent identity value. Current parent/depth capability admission determines whether the selected target is authorized.",
);
const DELEGATION_PROFILE = z.enum(DIRECT_CHILD_AGENT_PROFILES).describe(
  "Delegated model-resource Profile value. Current parent/depth capability admission determines whether the selected Agent/Profile pair is authorized.",
);
export const DelegatedSessionTitleSchema = z.string().superRefine((value, ctx) => {
  const violation = delegatedSessionTitleCapacityViolation(value);
  if (violation !== undefined) ctx.addIssue({ code: "custom", message: violation });
}).describe(
  `Short user-facing title for the child Session, at most ${MAX_DELEGATED_SESSION_TITLE_LENGTH} Unicode code points.`,
);
const DELEGATION_OBJECTIVE = NON_EMPTY.describe(
  "Self-contained task-specific handoff for the fresh child, stating what it must accomplish or answer and what it must return.",
);
const SKILL_NAME_MESSAGE = `Skill name must match pattern ${SKILL_NAME_REGEX.source}`;
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
  title: DelegatedSessionTitleSchema,
  objective: DELEGATION_OBJECTIVE,
  skills: DELEGATION_SKILLS,
  background: DELEGATION_BACKGROUND,
});

export type DelegationRequestInput = z.input<typeof DelegationRequestSchema>;
export type ParsedDelegationRequest = z.output<typeof DelegationRequestSchema>;
