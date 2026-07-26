export type UpdatePhase =
  | "idle"
  | "checking"
  | "downloading"
  | "verifying"
  | "installing"
  | "restart_pending"
  | "error";

export interface UpdateReleaseView {
  version: string;
  releaseUrl: string;
}

export interface UpdateProgress {
  phase: Extract<UpdatePhase, "downloading" | "verifying" | "installing">;
  downloadedBytes?: number;
  totalBytes?: number;
}

export interface UpdateErrorView {
  code: string;
  message: string;
}

/**
 * Complete process-level update projection. The server owns this state; Web
 * clients only trigger transitions and render the resulting projection.
 */
export interface UpdateStatus {
  currentVersion: string;
  phase: UpdatePhase;
  managed: boolean;
  restartSupported: boolean;
  updateAvailable: boolean;
  restartRequired: boolean;
  latest?: UpdateReleaseView;
  lastCheckedAt?: number;
  progress?: UpdateProgress;
  error?: UpdateErrorView;
}

export interface GlobalSSEUpdateChangedEvent {
  type: "update.changed";
  status: UpdateStatus;
  createdAt: number;
}
