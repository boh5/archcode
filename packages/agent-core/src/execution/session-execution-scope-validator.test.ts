import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  SessionExecutionScopeConflictError,
  SessionExecutionScopeValidator,
} from "./session-execution-scope-validator";

const TMP_ROOT = join(import.meta.dir, "__test_tmp__", "session-execution-scope-validator", crypto.randomUUID());

beforeEach(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
  await mkdir(TMP_ROOT, { recursive: true });
});

afterAll(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
});

describe("SessionExecutionScopeValidator", () => {
  test("accepts a Session whose execution directory is the canonical project root", async () => {
    const projectRoot = join(TMP_ROOT, "project");
    await mkdir(projectRoot, { recursive: true });
    const validator = new SessionExecutionScopeValidator();

    await expect(validator.validate({
      projectRoot,
      subject: {
        sessionId: "session-1",
        rootSessionId: "session-1",
        cwd: projectRoot,
        agentName: "lead",
      },
    })).resolves.toBeUndefined();
  });

  test("rejects a Session whose execution directory is outside the project", async () => {
    const projectRoot = join(TMP_ROOT, "project");
    await mkdir(projectRoot, { recursive: true });
    const validator = new SessionExecutionScopeValidator();

    try {
      await validator.validate({
        projectRoot,
        subject: {
          sessionId: "session-1",
          rootSessionId: "session-1",
          cwd: join(TMP_ROOT, "outside"),
          agentName: "lead",
        },
      });
    } catch (error) {
      expect(error).toBeInstanceOf(SessionExecutionScopeConflictError);
      expect((error as SessionExecutionScopeConflictError).code).toBe("SESSION_CWD_INVALID");
      return;
    }
    throw new Error("Expected SESSION_CWD_INVALID");
  });
});
