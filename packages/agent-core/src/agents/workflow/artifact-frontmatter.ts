import type { WorkflowArtifactKind, WorkflowState } from "./state";

export interface WorkflowArtifactFrontmatterInput {
  kind?: WorkflowArtifactKind;
  path: string;
}

export interface WorkflowArtifactWriteProvenance {
  writerAgent?: string;
  writerSessionId?: string;
  toolCallId?: string;
  writtenAt?: string;
}

const WORKFLOW_ARTIFACT_FRONTMATTER_CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

export class WorkflowArtifactFrontmatterValueError extends Error {
  constructor(
    public readonly key: string,
    public readonly value: string,
  ) {
    super(`Invalid workflow artifact frontmatter value for ${key}`);
    this.name = "WorkflowArtifactFrontmatterValueError";
  }
}

export function buildWorkflowArtifactFrontmatter(
  input: WorkflowArtifactFrontmatterInput,
  state: WorkflowState,
  provenance: WorkflowArtifactWriteProvenance = {},
): Record<string, string> {
  return {
    "archcode.schema": frontmatterScalar("archcode.schema", "1"),
    "archcode.workflowId": frontmatterScalar("archcode.workflowId", state.id),
    "archcode.workflowType": frontmatterScalar("archcode.workflowType", state.type),
    "archcode.artifactKind": frontmatterScalar("archcode.artifactKind", input.kind ?? "NOTE"),
    "archcode.artifactPath": frontmatterScalar("archcode.artifactPath", input.path),
    "archcode.workflowStage": frontmatterScalar("archcode.workflowStage", state.stage),
    "archcode.writerAgent": frontmatterScalar("archcode.writerAgent", provenance.writerAgent ?? "system"),
    "archcode.writerSessionId": frontmatterScalar("archcode.writerSessionId", provenance.writerSessionId ?? "unknown"),
    "archcode.toolCallId": frontmatterScalar("archcode.toolCallId", provenance.toolCallId ?? "direct"),
    "archcode.writtenAt": frontmatterScalar("archcode.writtenAt", provenance.writtenAt ?? new Date().toISOString()),
  };
}

function frontmatterScalar(key: string, value: string): string {
  if (WORKFLOW_ARTIFACT_FRONTMATTER_CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new WorkflowArtifactFrontmatterValueError(key, value);
  }
  return value;
}
