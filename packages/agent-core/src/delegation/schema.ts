import { z } from "zod/v4";
import { SKILL_NAME_REGEX } from "../skills/schema";

const NON_EMPTY = z.string().trim().min(1);
const SKILL_NAME_MESSAGE = "Skill name must match pattern ^[a-z0-9][a-z0-9-]*$";

export const DelegationRequestSchema = z.strictObject({
  agent_type: z.enum(["analyst", "build", "explore", "librarian"]),
  profile: z.enum(["deep", "fast"]),
  title: NON_EMPTY,
  objective: NON_EMPTY,
  skills: z.array(z.string().regex(SKILL_NAME_REGEX, SKILL_NAME_MESSAGE)),
  background: z.boolean(),
}).superRefine((request, ctx) => {
  const requiredProfile = request.agent_type === "analyst"
    ? "deep"
    : request.agent_type === "explore" || request.agent_type === "librarian"
      ? "fast"
      : undefined;
  if (requiredProfile !== undefined && request.profile !== requiredProfile) {
    ctx.addIssue({
      code: "custom",
      path: ["profile"],
      message: `${request.agent_type} delegation requires the ${requiredProfile} Profile`,
    });
  }
});

export type DelegationRequestInput = z.input<typeof DelegationRequestSchema>;
export type ParsedDelegationRequest = z.output<typeof DelegationRequestSchema>;
