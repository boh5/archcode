import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../api/client";

/**
 * Fetches artifact (PRD, SPEC, TASKS) content for a workflow.
 * Returns the raw body string of the artifact.
 */
export function useArtifactContent(
  slug: string,
  workflowId: string | undefined,
  artifactName: string,
) {
  return useQuery({
    queryKey: [
      "projects",
      slug,
      "workflows",
      workflowId,
      "artifacts",
      artifactName,
    ],
    queryFn: async () => {
      const result = await apiFetch<{ body: string }>(
        `/api/projects/${encodeURIComponent(slug)}/workflows/${encodeURIComponent(workflowId!)}/artifacts/${artifactName}`,
      );
      return result.body;
    },
    enabled: !!workflowId,
  });
}
