import { isAbsolute } from "node:path";
import { z } from "zod/v4";
import type { Automation, AutomationAction, AutomationTrigger } from "@archcode/protocol";
import type { ProjectHitlQueue } from "../hitl";
import type { MemoryFileManager } from "../memory/file-manager";
import type { ProjectApprovalManager } from "../tools/permission/project-approvals";
import type { ProjectTodoService } from "../todos";

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
  createAutomation(input: {
    readonly name: string;
    readonly trigger: AutomationTrigger;
    readonly action: AutomationAction;
    readonly createdFromSessionId: string;
  }): Promise<Automation>;
  todos: ProjectTodoService;
  hitl: ProjectHitlQueue;
  memory: MemoryFileManager;
  approvals: ProjectApprovalManager;
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
