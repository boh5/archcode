import {
  SkillNotFoundError,
  SkillPathError,
  SkillValidationError,
} from "../skills/service";
import type { CommandDescriptor } from "./types";

const SYNTAX = "Usage: /skill use <name> <request...>";
const DEFAULT_REQUEST = "Apply this Skill to the current task.";

export interface NormalizedSkillActivation {
  readonly skillName: string;
  readonly content: string;
}

export function normalizeSkillUseArgs(args: string | undefined): NormalizedSkillActivation | null {
  const tokens = parseArgs(args);
  if (tokens[0] !== "use" || tokens[1] === undefined) return null;
  return Object.freeze({
    skillName: tokens[1],
    content: tokens.slice(2).join(" ").trim() || DEFAULT_REQUEST,
  });
}

export async function validateSkillActivation(input: {
  readonly skillService: import("../skills/service").SkillService;
  readonly cwd: string;
  readonly agentName: string;
  readonly agentSkills: readonly string[];
  readonly activation: NormalizedSkillActivation;
}): Promise<{ readonly success: true } | { readonly success: false; readonly message: string }> {
  const { skillName } = input.activation;
  try {
    const skill = await input.skillService.snapshotForAgent(input.cwd, skillName, input.agentSkills);
    if (skill === null) return unavailable(skillName, input.agentName);
  } catch (error) {
    if (error instanceof SkillNotFoundError) return unavailable(skillName, input.agentName);
    if (error instanceof SkillValidationError || error instanceof SkillPathError) {
      return {
        success: false,
        message: `Skill "${skillName}" is invalid: ${error.message}`,
      };
    }
    throw error;
  }
  return { success: true };
}

export function createSkillCommand(): CommandDescriptor {
  return {
    name: "skill",
    description: "Use an allowed Skill for the next request.",
    handler: async (ctx, args) => {
      const tokens = parseArgs(args);
      const subcommand = tokens[0];

      if (subcommand !== "use") {
        return {
          success: false,
          message: `Unsupported /skill command. ${SYNTAX}`,
        };
      }

      const name = tokens[1];
      if (!name) {
        return {
          success: false,
          message: `Missing skill name. ${SYNTAX}`,
        };
      }

      const activation = normalizeSkillUseArgs(args)!;
      const validation = await validateSkillActivation({
        skillService: ctx.skillService,
        cwd: ctx.cwd,
        agentName: ctx.agentName,
        agentSkills: ctx.agentSkills,
        activation,
      });
      if (!validation.success) return validation;

      return {
        success: true,
        message: `Activating skill "${name}"...`,
        pendingMessage: {
          content: activation.content,
          executionSkillNames: [activation.skillName],
        },
      };
    },
  };
}

function parseArgs(args: string | undefined): string[] {
  return (args ?? "").trim().split(/\s+/).filter(Boolean);
}

function unavailable(name: string, agentName: string) {
  return {
    success: false,
    message: `Skill "${name}" is not available for current agent "${agentName}". ${SYNTAX}`,
  };
}
