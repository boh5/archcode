import { hitlStore } from "./hitl-store";
import { sessionRuntimeStore } from "./session-runtime-store";

export function removeProjectControlPlane(projectSlug: string): void {
  sessionRuntimeStore.getState().removeProject(projectSlug);
  hitlStore.getState().removeProject(projectSlug);
}

export function invalidateControlPlaneReadiness(): void {
  sessionRuntimeStore.getState().invalidateSnapshots();
  hitlStore.getState().invalidateSnapshots();
}
