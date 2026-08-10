import { beforeEach, describe, expect, test } from "bun:test";
import type { McpServerStatus } from "@archcode/protocol";
import { useMcpStatusStore } from "./mcp-status-store";

describe("McpStatusStore", () => {
  beforeEach(() => {
    useMcpStatusStore.getState().clear();
  });

  test("initial state is empty servers object", () => {
    const state = useMcpStatusStore.getState();
    expect(state.servers).toEqual({});
  });

  test("setServers replaces all servers", () => {
    const servers: Record<string, McpServerStatus> = {
      context7: { state: "ready", toolCount: 3, warningCount: 0, connectedAt: 1 },
      grep: { state: "connecting", startedAt: 1 },
    };
    useMcpStatusStore.getState().setServers(servers);

    expect(useMcpStatusStore.getState().servers).toEqual(servers);
  });

  test("setServers replaces previous entries entirely", () => {
    useMcpStatusStore.getState().setServers({
      old: { state: "ready", toolCount: 1, warningCount: 0, connectedAt: 1 },
    });
    useMcpStatusStore.getState().setServers({
      new: { state: "connecting", startedAt: 1 },
    });

    const servers = useMcpStatusStore.getState().servers;
    expect(servers).not.toHaveProperty("old");
    expect(servers).toEqual({ new: { state: "connecting", startedAt: 1 } });
  });

  test("mergeServerSnapshot keeps newer SSE state while removing absent servers", () => {
    useMcpStatusStore.getState().setServers({
      docs: { state: "ready", toolCount: 2, warningCount: 0, connectedAt: 20 },
      removed: { state: "failed", error: "old", failedAt: 10 },
    });

    useMcpStatusStore.getState().mergeServerSnapshot({
      docs: { state: "connecting", startedAt: 15 },
      added: { state: "ready", toolCount: 1, warningCount: 0, connectedAt: 15 },
    });

    expect(useMcpStatusStore.getState().servers).toEqual({
      docs: { state: "ready", toolCount: 2, warningCount: 0, connectedAt: 20 },
      added: { state: "ready", toolCount: 1, warningCount: 0, connectedAt: 15 },
    });
  });

  test("mergeServerSnapshot accepts equal or newer save responses", () => {
    useMcpStatusStore.getState().setServers({
      docs: { state: "connecting", startedAt: 10 },
    });

    useMcpStatusStore.getState().mergeServerSnapshot({
      docs: { state: "failed", error: "latest", failedAt: 10 },
    });

    expect(useMcpStatusStore.getState().servers.docs).toEqual({
      state: "failed",
      error: "latest",
      failedAt: 10,
    });
  });

  test("updateServer merges a single server status into existing map", () => {
    useMcpStatusStore.getState().setServers({
      context7: { state: "connecting", startedAt: 1 },
    });

    useMcpStatusStore.getState().updateServer("context7", { state: "ready", toolCount: 5, warningCount: 2, connectedAt: 1 });
    useMcpStatusStore.getState().updateServer("exa", { state: "failed", error: "boom", failedAt: 1 });

    expect(useMcpStatusStore.getState().servers).toEqual({
      context7: { state: "ready", toolCount: 5, warningCount: 2, connectedAt: 1 },
      exa: { state: "failed", error: "boom", failedAt: 1 },
    });
  });

  test("updateServer overwrites existing server status", () => {
    useMcpStatusStore.getState().setServers({
      context7: { state: "ready", toolCount: 3, warningCount: 0, connectedAt: 1 },
    });

    useMcpStatusStore.getState().updateServer("context7", { state: "disabled", updatedAt: 1 });

    expect(useMcpStatusStore.getState().servers).toEqual({
      context7: { state: "disabled", updatedAt: 1 },
    });
  });

  test("clear empties the servers map", () => {
    useMcpStatusStore.getState().setServers({
      context7: { state: "ready", toolCount: 3, warningCount: 0, connectedAt: 1 },
      grep: { state: "connecting", startedAt: 1 },
    });

    useMcpStatusStore.getState().clear();

    expect(useMcpStatusStore.getState().servers).toEqual({});
  });
});
