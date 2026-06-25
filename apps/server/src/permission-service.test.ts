import { describe, expect, mock, test } from "bun:test";
import type { AgentRuntime, ToolConfirmationRequest } from "@archcode/agent-core";
import { PermissionService } from "./permission-service";

const request: ToolConfirmationRequest = {
  toolName: "bash",
  toolCallId: "call-1",
  input: { command: "pwd" },
  description: "Run command",
};

function createRuntime() {
  return {
    requestPermission: mock(async () => "approve_once" as const),
    respondPermission: mock(() => true),
    cleanupDeferredSession: mock(() => undefined),
  } as unknown as AgentRuntime;
}

describe("PermissionService", () => {
  test("request delegates to runtime permission boundary", async () => {
    const runtime = createRuntime();
    const service = new PermissionService(runtime);
    const abortController = new AbortController();

    await expect(service.request("session-1", "/tmp/workspace", request, abortController.signal)).resolves.toBe("approve_once");

    expect(runtime.requestPermission).toHaveBeenCalledWith(
      "/tmp/workspace",
      "session-1",
      request,
      abortController.signal,
    );
  });

  test("respond delegates to runtime response boundary", () => {
    const runtime = createRuntime();
    const service = new PermissionService(runtime);

    expect(service.respond("permission-1", "deny")).toBe(true);
    expect(runtime.respondPermission).toHaveBeenCalledWith("permission-1", "deny");
  });

  test("cleanup delegates scoped session cleanup when both identifiers are present", () => {
    const runtime = createRuntime();
    const service = new PermissionService(runtime);

    service.cleanup("session-1", "/tmp/workspace");
    service.cleanup("session-1");

    expect(runtime.cleanupDeferredSession).toHaveBeenCalledTimes(1);
    expect(runtime.cleanupDeferredSession).toHaveBeenCalledWith("/tmp/workspace", "session-1");
  });
});
