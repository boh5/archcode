import type { StoreApi } from "zustand";
import type { CircuitBreaker } from "../compact/circuit-breaker";
import type { ModelCallOptions } from "../config/provider";
import type { ModelInfo } from "../provider/model";
import type { SkillService } from "../skills/service";
import type { SessionStoreState } from "../store/types";
import type { Logger } from "../logger";

export interface CommandContext {
  store: StoreApi<SessionStoreState>;
  modelInfo: ModelInfo;
  logger?: Logger;
  modelOptions?: ModelCallOptions;
  circuitBreaker?: CircuitBreaker;
  abort?: AbortSignal;
  cwd?: string;
  agentName?: string;
  agentSkills?: readonly string[];
  skillService?: SkillService;
}

export interface SlashCommandResult {
  success: boolean;
  message: string;
  continueAsMessage?: string;
}

/** @deprecated Use SlashCommandResult for agent slash-command execution results. */
export type CommandResult = SlashCommandResult;

export type CommandHandler = (ctx: CommandContext, args?: string) => Promise<SlashCommandResult>;

export interface CommandDescriptor {
  name: string;
  description: string;
  handler: CommandHandler;
}

export interface ParsedCommand {
  command: string;
  args: string;
}
