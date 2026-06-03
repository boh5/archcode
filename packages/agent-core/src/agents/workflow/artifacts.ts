import { resolve } from "node:path";

import { z } from "zod/v4";

import { formatFrontmatter, parseFrontmatter } from "../../utils/frontmatter";
import {
  atomicWrite,
  resolveContainedPath,
  SafePathError,
} from "../../utils/safe-file";
import {
  WorkflowArtifactKindSchema,
  WorkflowStateManager,
  type WorkflowState,
} from "./state";

const SINGLE_FILE_ARTIFACT_PATHS = {
  RESEARCH: "RESEARCH.md",
  PRD: "PRD.md",
  SPEC: "SPEC.md",
  TASKS: "TASKS.md",
  HANDOFF_SUMMARY: "HANDOFF_SUMMARY.md",
  INTERACTIONS: "INTERACTIONS.md",
  FINAL_REPORT: "FINAL_REPORT.md",
} as const;

export const WorkflowArtifactWriteInputSchema = z.strictObject({
  workflowId: z.string().min(1),
  kind: WorkflowArtifactKindSchema,
  path: z.string().min(1),
  content: z.string(),
  frontmatter: z.record(z.string(), z.string()).optional(),
});

export type WorkflowArtifactWriteInput = z.infer<
  typeof WorkflowArtifactWriteInputSchema
>;

export interface WorkflowArtifactWriteResult {
  path: string;
  absolutePath: string;
  state: WorkflowState;
}

export interface WorkflowArtifactReadResult {
  path: string;
  absolutePath: string;
  content: string;
  frontmatter: Record<string, string>;
  body: string;
}

export class ArtifactPathError extends Error {
  constructor(
    public readonly workflowId: string,
    public readonly artifactPath: string,
  ) {
    super(`Invalid artifact path for workflow ${workflowId}: ${artifactPath}`);
    this.name = "ArtifactPathError";
  }
}

export class WorkflowArtifactManager {
  constructor(
    private readonly workspaceRoot: string,
    private readonly stateManager = new WorkflowStateManager(workspaceRoot),
  ) {}

  async write(
    input: WorkflowArtifactWriteInput,
  ): Promise<WorkflowArtifactWriteResult> {
    const parsed = WorkflowArtifactWriteInputSchema.parse(input);
    const absolutePath = await this.artifactPath(parsed.workflowId, parsed.path);
    this.assertAllowedArtifactPath(parsed.workflowId, parsed.kind, parsed.path);

    const content = parsed.frontmatter
      ? formatFrontmatter(parsed.frontmatter, parsed.content)
      : parsed.content;
    await atomicWrite(absolutePath, content);

    const state = await this.stateManager.read(parsed.workflowId);
    const updated = await this.stateManager.updateArtifacts(
      parsed.workflowId,
      this.updateArtifacts(state.artifacts, parsed.kind, parsed.path),
    );

    return { path: parsed.path, absolutePath, state: updated };
  }

  async read(
    workflowId: string,
    artifactPath: string,
  ): Promise<WorkflowArtifactReadResult> {
    const absolutePath = await this.artifactPath(workflowId, artifactPath);
    const content = await Bun.file(absolutePath).text();
    const parsed = parseFrontmatter(content);
    return { path: artifactPath, absolutePath, content, ...parsed };
  }

  private updateArtifacts(
    artifacts: WorkflowState["artifacts"],
    kind: WorkflowArtifactWriteInput["kind"],
    artifactPath: string,
  ): WorkflowState["artifacts"] {
    if (kind === "CRITIC_REPORT" || kind === "EVIDENCE") {
      const existing = artifacts[kind];
      const paths = Array.isArray(existing) ? existing : existing ? [existing] : [];
      return { ...artifacts, [kind]: [...new Set([...paths, artifactPath])] };
    }

    return { ...artifacts, [kind]: artifactPath };
  }

  private assertAllowedArtifactPath(
    workflowId: string,
    kind: WorkflowArtifactWriteInput["kind"],
    artifactPath: string,
  ): void {
    if (kind in SINGLE_FILE_ARTIFACT_PATHS) {
      if (
        artifactPath !==
        SINGLE_FILE_ARTIFACT_PATHS[
          kind as keyof typeof SINGLE_FILE_ARTIFACT_PATHS
        ]
      ) {
        throw new ArtifactPathError(workflowId, artifactPath);
      }
      return;
    }

    if (kind === "CRITIC_REPORT" && /^critic-reports\/.+\.md$/.test(artifactPath)) {
      return;
    }

    if (kind === "EVIDENCE" && artifactPath.startsWith("evidence/")) {
      return;
    }

    throw new ArtifactPathError(workflowId, artifactPath);
  }

  private async artifactPath(
    workflowId: string,
    artifactPath: string,
  ): Promise<string> {
    const workflowRoot = resolve(
      this.workspaceRoot,
      ".specra",
      "workflows",
      workflowId,
    );
    try {
      return await resolveContainedPath(artifactPath, workflowRoot);
    } catch (error) {
      if (error instanceof SafePathError) {
        throw new ArtifactPathError(workflowId, artifactPath);
      }
      throw error;
    }
  }

}
