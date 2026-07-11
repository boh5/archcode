import {
  SkillNotFoundError,
  SkillPathError,
  SkillValidationError,
} from "../skills/service";
import type { CommandDescriptor } from "./types";

const SYNTAX = "Usage: /skill use <name> <request...>";
const DEFAULT_REQUEST = "Apply this Skill to the current task.";

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

      try {
        const skill = await ctx.skillService.readForAgent(ctx.cwd, name, ctx.agentSkills);
        if (skill === null) {
          return unavailable(name, ctx.agentName);
        }
      } catch (error) {
        if (error instanceof SkillNotFoundError) {
          return unavailable(name, ctx.agentName);
        }

        if (error instanceof SkillValidationError || error instanceof SkillPathError) {
          return {
            success: false,
            message: `Skill "${name}" is invalid: ${error.message}`,
          };
        }

        throw error;
      }

      const request = tokens.slice(2).join(" ").trim() || DEFAULT_REQUEST;
      const skillReadInput = JSON.stringify({ name });
      const continueAsMessage = `Use Skill "${name}" for this request. First call skill_read with ${skillReadInput}; after reading it, answer/act on: ${request}`;

      return {
        success: true,
        message: `Activating skill "${name}"...`,
        continueAsMessage,
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
