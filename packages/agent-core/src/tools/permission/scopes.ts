import type { PermissionApprovalScope } from "./policy-types";
import { isSensitiveFile } from "./sensitive-file";
import { PathValidator } from "../security/path-validator";
import path from "node:path";

export type FileApprovalOperation = "read" | "write" | "edit" | "delete";

export interface FileApprovalDecisionContext {
  operation: FileApprovalOperation;
  path: string;
  workspaceRoot: string;
  reason?: string;
}

function exactFileScope(operation: FileApprovalOperation, filePath: string): PermissionApprovalScope {
  return {
    kind: "file-path",
    operation,
    path: filePath,
    pathMode: "exact",
  };
}

function mentionsOutsideWorkspace(reason: string | undefined): boolean {
  return reason?.includes("TOOL_FILE_OUTSIDE_WORKSPACE") || reason?.toLowerCase().includes("outside workspace") || false;
}

function mentionsSensitiveFile(reason: string | undefined): boolean {
  return reason?.toLowerCase().includes("sensitive") || false;
}

function isSensitiveApprovalPath(filePath: string): boolean {
  const basename = path.basename(filePath);
  if (basename === ".env.example") return false;
  return isSensitiveFile(basename);
}

export function deriveApprovalScope(decisionContext: FileApprovalDecisionContext): PermissionApprovalScope | undefined {
  const validator = new PathValidator(decisionContext.workspaceRoot);
  const validation = validator.validate(decisionContext.path);

  if (!validation.ok || mentionsOutsideWorkspace(decisionContext.reason)) {
    return exactFileScope(decisionContext.operation, validation.resolvedPath);
  }

  if (decisionContext.operation === "read" && (isSensitiveApprovalPath(decisionContext.path) || mentionsSensitiveFile(decisionContext.reason))) {
    return exactFileScope("read", validation.resolvedPath);
  }

  return undefined;
}
