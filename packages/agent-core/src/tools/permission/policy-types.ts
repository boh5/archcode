export type BashApprovalAccess = {
  operation: "read" | "write" | "delete" | "execute";
  path: string;
};

export type PermissionApprovalScope =
  | { kind: "tool-operation"; toolName: string; operation: string; target?: string }
  | {
      kind: "file-path";
      operation: "read" | "write" | "edit" | "delete";
      path: string;
      pathMode: "exact" | "subtree";
    }
  | { kind: "bash-exact"; command: string; cwd: string; accesses: BashApprovalAccess[] }
  | { kind: "web-origin"; origin: string };

export interface PermissionApprovalRequest {
  eligible: boolean;
  scope?: PermissionApprovalScope;
  /** Exact-scope identity for an ineligible request whose raw scope must not leave memory. */
  fingerprint?: string;
  display: string;
  reason: string;
}
