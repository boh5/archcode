import type { RuntimeStatus } from "./bootstrap";

export type RuntimeDataIssueReason =
  | "invalid_json"
  | "invalid_current_schema"
  | "inspection_limit"
  | "unreadable";

export interface RuntimeDataSchemaIssue {
  readonly path: Array<string | number>;
  readonly message: string;
}

export interface RuntimeDataIssue {
  readonly relativePath: string;
  readonly reason: RuntimeDataIssueReason;
  readonly schemaIssues?: RuntimeDataSchemaIssue[];
}

export interface RuntimeDataStats {
  readonly fileCount: number;
  readonly totalBytes: number;
}

export interface RuntimeDataProjectInspection {
  readonly projectSlug: string;
  readonly name: string;
  readonly workspace: string;
  readonly runtimePath: string;
  readonly stats: RuntimeDataStats;
  readonly issues: RuntimeDataIssue[];
}

export interface RuntimeDataInspectionResponse {
  readonly projects: RuntimeDataProjectInspection[];
}

export interface RuntimeDataDeleteRequest {
  readonly projectSlugs: string[];
}

export interface RuntimeDataDeleteError {
  readonly code: "delete_failed";
  readonly message: string;
}

export type RuntimeDataProjectDeleteResult =
  | {
    readonly projectSlug: string;
    readonly status: "deleted";
  }
  | {
    readonly projectSlug: string;
    readonly status: "error";
    readonly error: RuntimeDataDeleteError;
  };

export interface RuntimeDataDeleteResult {
  readonly results: RuntimeDataProjectDeleteResult[];
}

export interface RuntimeDataDeleteResponse extends RuntimeDataDeleteResult {
  readonly runtime: RuntimeStatus;
}
