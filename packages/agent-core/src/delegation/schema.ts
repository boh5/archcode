import { z } from "zod/v4";
import { SKILL_NAME_REGEX } from "../skills/schema";

const NON_EMPTY = z.string().trim().min(1);
const SKILL_NAME_MESSAGE = "Skill name must match pattern ^[a-z0-9][a-z0-9-]*$";

export const ScopeRefSchema = z.strictObject({
  kind: z.enum(["file", "tree"]),
  path: NON_EMPTY,
});

export const DelegationRequestSchema = z.strictObject({
  agent_type: z.enum(["plan", "build", "reviewer", "explore", "librarian"]),
  title: NON_EMPTY,
  objective: NON_EMPTY,
  owned_scope: z.array(ScopeRefSchema),
  skills: z.array(z.string().regex(SKILL_NAME_REGEX, SKILL_NAME_MESSAGE)),
  background: z.boolean(),
}).superRefine((request, ctx) => {
  if (request.agent_type === "build" && request.owned_scope.length === 0) {
    ctx.addIssue({
      code: "custom",
      path: ["owned_scope"],
      message: "Build delegation requires at least one owned_scope entry",
    });
  }
  if (request.agent_type !== "build" && request.owned_scope.length !== 0) {
    ctx.addIssue({
      code: "custom",
      path: ["owned_scope"],
      message: "Only Build delegation may own source scope",
    });
  }
});

export type DelegationRequestInput = z.input<typeof DelegationRequestSchema>;
export type ParsedDelegationRequest = z.output<typeof DelegationRequestSchema>;
