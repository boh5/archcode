import { isAbsolute } from "node:path";
import { z } from "zod/v4";
import type { GoalStateManager } from "../goals/state";
import type { GoalState } from "@archcode/protocol";
import type { GoalCancellationCapability } from "../goals/cancellation";
import type { HitlService } from "../hitl/service";
import type { ResumeCoordinator } from "../hitl/resume-coordinator";
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
  goalCancellation: GoalCancellationCapability;
  hitl: HitlService;
  hitlResumeCoordinator: ResumeCoordinator;
  memory: MemoryFileManager;
  approvals: ProjectApprovalManager;
  /** Runtime notification used by model-facing Goal creation to refresh resource consumers. */
  onGoalCreated?: (goal: GoalState) => void;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/** Zod schema for ProjectInfo — validates persisted project entries */
export const ProjectInfoSchema: z.ZodType<ProjectInfo> = z.strictObject({
  slug: z.string().refine((value) => value.trim().length > 0, "Project slug must not be empty"),
  name: z.string().refine((value) => value.trim().length > 0, "Project name must not be empty"),
  workspaceRoot: z.string().refine(isAbsolute, "Project workspaceRoot must be absolute"),
  addedAt: z.iso.datetime(),
  lastOpenedAt: z.iso.datetime().optional(),
});
