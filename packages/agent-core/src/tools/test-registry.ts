import { mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HitlBoundaryCodec } from "../hitl/boundary-codec";
import { ToolOutputArtifactStore } from "../tool-output/artifact-store";
import { ToolOutputFinalizer } from "../tool-output/finalizer";
import { createScopeBoundToolOutputAccess, type ToolOutputAccessService } from "../tool-output/access-service";
import type { Logger } from "../logger";
import { silentLogger } from "../logger";
import { SecretRedactionPolicy } from "../security";
import { createRegistry, type ToolRegistry } from "./registry";
import type { AnyToolDescriptor } from "./types";

export interface TestToolRegistryFixture {
  readonly registry: ToolRegistry;
  readonly artifactStore: ToolOutputArtifactStore;
  readonly finalizer: ToolOutputFinalizer;
  readonly redactionPolicy: SecretRedactionPolicy;
  readonly hitlCodec: HitlBoundaryCodec;
  createToolOutputAccess(workspaceRoot: string, rootSessionId: string): ToolOutputAccessService;
  dispose(): Promise<void>;
}

/** Required real Output Plane fixture for Registry consumers. */
export function createTestToolRegistryFixture(options: {
  readonly descriptors?: AnyToolDescriptor[];
  readonly secretLiterals?: readonly string[];
  readonly logger?: Logger;
} = {}): TestToolRegistryFixture {
  const rootDir = join(tmpdir(), `archcode-tool-registry-${crypto.randomUUID()}`);
  const artifactStore = new ToolOutputArtifactStore({ rootDir });
  const redactionPolicy = new SecretRedactionPolicy(options.secretLiterals ?? []);
  const hitlCodec = new HitlBoundaryCodec(redactionPolicy);
  const finalizer = new ToolOutputFinalizer({ artifactStore, redactionPolicy });
  const registry = createRegistry(
    { finalizer, hitlCodec, logger: options.logger ?? silentLogger },
    options.descriptors ?? [],
  );
  return {
    registry,
    artifactStore,
    finalizer,
    redactionPolicy,
    hitlCodec,
    createToolOutputAccess(workspaceRoot, rootSessionId) {
      mkdirSync(workspaceRoot, { recursive: true });
      return createScopeBoundToolOutputAccess(artifactStore, { workspaceRoot, rootSessionId });
    },
    async dispose() {
      await artifactStore.dispose();
      await rm(rootDir, { recursive: true, force: true });
    },
  };
}
