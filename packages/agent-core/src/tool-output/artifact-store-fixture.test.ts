import type { CreateArtifactInput, CreatedArtifact } from "./artifact-types";
import type { ToolOutputArtifactStore } from "./artifact-store";

/** Builds low-level store fixtures without exposing raw canonical creation in production APIs. */
export function createTestArtifact(
  store: ToolOutputArtifactStore,
  input: CreateArtifactInput,
): Promise<CreatedArtifact> {
  const fixtureStore = store as unknown as {
    createFixtureArtifact(value: CreateArtifactInput): Promise<CreatedArtifact>;
  };
  return fixtureStore.createFixtureArtifact(input);
}
