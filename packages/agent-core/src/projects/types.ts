import { z } from "zod/v4";
import type { GoalArtifactManager } from "../goals/artifacts";
import type { GoalMemoryManager } from "../goals/goal-memory";
import type { GoalStateManager } from "../goals/state";
import type { HitlService } from "../hitl/service";
import type { LoopStateManager } from "../loops/state";
import type { MemoryFileManager } from "../memory/file-manager";
import type { ProjectApprovalManager } from "../tools/permission/project-approvals";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A registered project entry — pure JSON shape persisted to projects index */
export interface ProjectInfo {
  slug: string;
  name: string;
  workspaceRoot: string;
  addedAt: string;       // ISO 8601 timestamp
  lastOpenedAt?: string; // ISO 8601 timestamp, optional
}

/** Runtime context injected into tool execution — contains live Manager instances */
export interface ProjectContext {
  project: ProjectInfo;
  goalState: GoalStateManager;
  goalArtifacts: GoalArtifactManager;
  goalMemory: GoalMemoryManager;
  loopState: LoopStateManager;
  hitl: HitlService;
  memory: MemoryFileManager;
  approvals: ProjectApprovalManager;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/** Zod schema for ProjectInfo — validates persisted project entries */
export const ProjectInfoSchema: z.ZodType<ProjectInfo> = z.strictObject({
  slug: z.string(),
  name: z.string(),
  workspaceRoot: z.string(),
  addedAt: z.string(),
  lastOpenedAt: z.string().optional(),
});
