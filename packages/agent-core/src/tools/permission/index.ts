export { combinePermissionDecisions } from "./decision";
export { deriveApprovalScope } from "./scopes";
export type { FileApprovalDecisionContext, FileApprovalOperation } from "./scopes";
export type {
  NormalizedShellInvocation,
  NormalizedShellRequest,
  PermissionApprovalRequest,
  PermissionApprovalScope,
  ShellEffect,
  ShellEffectKind,
  ShellPathReference,
  ShellRedirection,
  ShellUncertainty,
} from "./policy-types";
export { createPermissionErrorResult } from "./errors";
export { createWorkspacePermission } from "./workspace";
export type { WorkspacePermissionOptions } from "./workspace";
export { createSensitiveFilePermission, isSensitiveFile, SENSITIVE_PATTERNS } from "./sensitive-file";
export { createMemoryIndexPermission } from "./memory-index";
export { createProtectedPathPermission, isProtectedProjectPath as isProtectedProjectPath } from "./protected-path";
export { createReadBeforeEditPermission } from "./read-before-edit";
export { createFileExistsPermission } from "./file-exists";
export { createBashPermission } from "./bash";
export { createGoalBootstrapPermission } from "./goal-bootstrap";
export { createMcpDestructivePermission } from "./mcp";
export {
  PermissionApprovalFileSchema,
  PermissionApprovalScopeSchema,
  ProjectApprovalManager,
} from "./project-approvals";
export type { PermissionApprovalFile, ProjectApproval, ProjectApprovalMetadata } from "./project-approvals";
