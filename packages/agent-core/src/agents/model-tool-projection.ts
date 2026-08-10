import { z } from "zod/v4";
import { TOOL_DELEGATE, TOOL_SKILL_LIST } from "../tools/names";
import type { AnyToolDescriptor } from "../tools/types";
import type { DelegationCapabilitySnapshot } from "./factory-types";

export function projectModelToolDescriptors(
  descriptors: readonly AnyToolDescriptor[],
  capabilities: DelegationCapabilitySnapshot,
): readonly AnyToolDescriptor[] {
  return descriptors.map((descriptor) => {
    if (descriptor.name === TOOL_DELEGATE) {
      return projectDelegateDescriptor(descriptor, capabilities);
    }
    if (descriptor.name === TOOL_SKILL_LIST) {
      return projectSkillListDescriptor(descriptor, capabilities);
    }
    return descriptor;
  });
}

function projectDelegateDescriptor(
  descriptor: AnyToolDescriptor,
  capabilities: DelegationCapabilitySnapshot,
): AnyToolDescriptor {
  if (capabilities.targets.length === 0) {
    throw new Error(
      `delegate is model-visible for ${capabilities.parentAgentName} at depth ${capabilities.depth} without an allowed target`,
    );
  }
  const targetNames = capabilities.targets.map((target) => target.agentName);
  const profiles = unique(capabilities.targets.flatMap((target) => target.profiles));
  const profileMapping = capabilities.targets
    .map((target) => `${target.agentName}=${target.profiles.join("|")}`)
    .join(", ");

  return {
    ...descriptor,
    description: [
      "Create one direct child Session using the current role/depth delegation authority.",
      `Allowed target-to-Profile mapping: ${profileMapping}.`,
      "Discover target Skills with skill_list({ agent_type }), then copy only exact returned names into skills. An empty skills array is valid; invented, stale, missing, invalid, or unauthorized names are rejected before child creation.",
      "The objective must be a self-contained handoff because the child does not inherit the parent conversation.",
    ].join("\n"),
    aiInputSchema: z.strictObject({
      agent_type: z.enum(asNonEmptyEnum(targetNames)).describe(
        "Allowed direct child Agent identity at the current delegation depth.",
      ),
      profile: z.enum(asNonEmptyEnum(profiles)).describe(
        `Allowed Profile union for visible targets. Exact target mapping: ${profileMapping}.`,
      ),
      title: z.string().min(1).describe("Short user-facing title for the child Session."),
      objective: z.string().min(1).describe("Self-contained task-specific handoff for the fresh child."),
      skills: z.array(z.string()).describe(
        "Exact target Skill names copied from skill_list({ agent_type }); use [] when no workflow Skill is needed.",
      ),
      background: z.boolean().describe(
        "False waits for the child final output; true returns its Session ID for later retrieval.",
      ),
    }),
  };
}

function projectSkillListDescriptor(
  descriptor: AnyToolDescriptor,
  capabilities: DelegationCapabilitySnapshot,
): AnyToolDescriptor {
  const shared = {
    cursor: z.string().min(1).optional().describe(
      "Opaque cursor from a previous page; omit for the first current catalog page.",
    ),
  };
  const aiInputSchema = capabilities.targets.length === 0
    ? z.strictObject(shared)
    : z.strictObject({
        ...shared,
        agent_type: z.enum(asNonEmptyEnum(capabilities.targets.map((target) => target.agentName)))
          .optional()
          .describe(
            "Optional allowed direct child target. Omit for the current Agent catalog; provide a target only to discover exact names for delegate.skills.",
          ),
      });

  return {
    ...descriptor,
    description: [
      "List one bounded, digest-bound page of current Skill metadata.",
      "Call skill_list({}) for the current Agent; those exact names may be opened with skill_read.",
      ...(capabilities.targets.length === 0
        ? []
        : ["Call skill_list({ agent_type }) for an allowed direct child only when selecting names for delegate.skills. A target page grants no parent read access."]),
    ].join("\n"),
    aiInputSchema,
  };
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function asNonEmptyEnum<T extends string>(
  values: readonly T[],
): [T, ...T[]] {
  if (values.length === 0) throw new Error("Model Tool enum must not be empty");
  return [...values] as [T, ...T[]];
}
