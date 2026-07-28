import { hitlStore } from "./hitl-store";
import { sessionRuntimeStore } from "./session-runtime-store";

export function removeProjectControlPlane(projectSlug: string): void {
  sessionRuntimeStore.getState().removeProject(projectSlug);
  hitlStore.getState().removeProject(projectSlug);
}

export function removeSessionControlPlane(
  projectSlug: string,
  rootSessionId: string,
): void {
  sessionRuntimeStore.getState().removeFamily(projectSlug, rootSessionId);
  hitlStore.getState().removeSessionFamily(projectSlug, rootSessionId);
}

export function invalidateControlPlaneReadiness(): void {
  sessionRuntimeStore.getState().invalidateSnapshots();
  hitlStore.getState().invalidateSnapshots();
}
