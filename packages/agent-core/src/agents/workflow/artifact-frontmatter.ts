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
    "specra.schema": frontmatterScalar("specra.schema", "1"),
    "specra.workflowId": frontmatterScalar("specra.workflowId", state.id),
    "specra.workflowType": frontmatterScalar("specra.workflowType", state.type),
    "specra.artifactKind": frontmatterScalar("specra.artifactKind", input.kind ?? "NOTE"),
    "specra.artifactPath": frontmatterScalar("specra.artifactPath", input.path),
    "specra.workflowStage": frontmatterScalar("specra.workflowStage", state.stage),
    "specra.writerAgent": frontmatterScalar("specra.writerAgent", provenance.writerAgent ?? "system"),
    "specra.writerSessionId": frontmatterScalar("specra.writerSessionId", provenance.writerSessionId ?? "unknown"),
    "specra.toolCallId": frontmatterScalar("specra.toolCallId", provenance.toolCallId ?? "direct"),
    "specra.writtenAt": frontmatterScalar("specra.writtenAt", provenance.writtenAt ?? new Date().toISOString()),
  };
}

function frontmatterScalar(key: string, value: string): string {
  if (WORKFLOW_ARTIFACT_FRONTMATTER_CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new WorkflowArtifactFrontmatterValueError(key, value);
  }
  return value;
}
