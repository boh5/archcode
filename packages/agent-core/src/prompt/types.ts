import type { MemoryRoots } from "../memory";
import type { ResolvedSkill, SkillIndexEntry } from "../skills/types";
import type { SessionRole } from "../store/types";

/**
 * Context provided to the system prompt builder.
 * All fields required except `agentsMd` (absent when no AGENTS.md found).
 */
export interface PromptContext {
  /** Ordered list of tool names the agent is allowed to use this session */
  readonly allowedTools: readonly string[];

  /** Identifier for the prompt profile used by the current role (e.g. "default", "test") */
  readonly promptProfileId: string;

  /** Role-specific prompt content from the agent definition; absent when definition has no rolePrompt */
  readonly rolePrompt?: string;

  /** Loaded AGENTS.md content; undefined when file not found or unreadable */
  readonly agentsMd?: string;

  /** Environment details injected into the prompt */
  readonly env: PromptEnv;

  /** Resolved filesystem roots for project and user memory directories */
  readonly memoryRoots?: MemoryRoots;

  /** Current Goal id for Goal-scoped prompt context, when this session belongs to a Goal. */
  readonly goalId?: string;

  /** Current session role; Goal memory is injected only for Plan/Build/Review roles. */
  readonly sessionRole?: SessionRole;

  /** Index of skills available to this agent (name, description, when_to_use, source, allowed_tools) */
  readonly availableSkills?: readonly SkillIndexEntry[];

  /** Fully resolved active skills with full body content */
  readonly activeSkills?: readonly ResolvedSkill[];

}

export interface PromptEnv {
  /** process.platform value: "darwin" | "linux" | "win32" etc. */
  readonly platform: string;

  /** IANA timezone identifier (e.g. "America/Los_Angeles") */
  readonly timezone: string;

  /** BCP-47 locale string (e.g. "en-US") */
  readonly locale: string;

  /** Canonical project root that owns Session, Goal, Loop, HITL, and memory state. */
  readonly projectRoot: string;

  /** Current working directory */
  readonly cwd: string;

  /** ISO 8601 date string (e.g. "2025-01-15") */
  readonly date: string;
}
