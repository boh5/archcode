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
      context7: { state: "ready", toolCount: 3 },
      grep: { state: "pending" },
    };
    useMcpStatusStore.getState().setServers(servers);

    expect(useMcpStatusStore.getState().servers).toEqual(servers);
  });

  test("setServers replaces previous entries entirely", () => {
    useMcpStatusStore.getState().setServers({
      old: { state: "ready", toolCount: 1 },
    });
    useMcpStatusStore.getState().setServers({
      new: { state: "pending" },
    });

    const servers = useMcpStatusStore.getState().servers;
    expect(servers).not.toHaveProperty("old");
    expect(servers).toEqual({ new: { state: "pending" } });
  });

  test("updateServer merges a single server status into existing map", () => {
    useMcpStatusStore.getState().setServers({
      context7: { state: "pending" },
    });

    useMcpStatusStore.getState().updateServer("context7", { state: "ready", toolCount: 5 });
    useMcpStatusStore.getState().updateServer("exa", { state: "failed", error: "boom" });

    expect(useMcpStatusStore.getState().servers).toEqual({
      context7: { state: "ready", toolCount: 5 },
      exa: { state: "failed", error: "boom" },
    });
  });

  test("updateServer overwrites existing server status", () => {
    useMcpStatusStore.getState().setServers({
      context7: { state: "ready", toolCount: 3 },
    });

    useMcpStatusStore.getState().updateServer("context7", { state: "disabled" });

    expect(useMcpStatusStore.getState().servers).toEqual({
      context7: { state: "disabled" },
    });
  });

  test("clear empties the servers map", () => {
    useMcpStatusStore.getState().setServers({
      context7: { state: "ready", toolCount: 3 },
      grep: { state: "pending" },
    });

    useMcpStatusStore.getState().clear();

    expect(useMcpStatusStore.getState().servers).toEqual({});
  });
});