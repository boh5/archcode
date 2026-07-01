import { z } from "zod/v4";
import type { GoalStateManager } from "../goals/state.ts";
import type { HitlService } from "../hitl/service.ts";
import type { MemoryFileManager } from "../memory/file-manager.ts";
import type { ProjectApprovalManager } from "../tools/permission/project-approvals.ts";

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
