import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_TEMP_PARENT = join(tmpdir(), "archcode-agent-core-tests");

export interface TestTempRoot {
  readonly path: string;
  cleanup(): Promise<void>;
}

/** Creates a unique, package-private root that a test run exclusively owns. */
export function createTestTempRoot(label: string): TestTempRoot {
  const safeLabel = label.replace(/[^a-zA-Z0-9_-]+/g, "-");
  const path = join(TEST_TEMP_PARENT, `${safeLabel}-${crypto.randomUUID()}`);

  return {
    path,
    async cleanup(): Promise<void> {
      await rm(path, { recursive: true, force: true });
    },
  };
}
