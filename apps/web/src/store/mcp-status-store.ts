import { create } from "zustand";
import type { McpServerStatus } from "@archcode/protocol";

export type McpServerStatusMap = Record<string, McpServerStatus>;

interface McpStatusState {
  servers: McpServerStatusMap;
  setServers: (servers: McpServerStatusMap) => void;
  mergeServerSnapshot: (servers: McpServerStatusMap) => void;
  updateServer: (name: string, status: McpServerStatus) => void;
  clear: () => void;
}

export const useMcpStatusStore = create<McpStatusState>((set) => ({
  servers: {},
  setServers: (servers) => set({ servers }),
  mergeServerSnapshot: (servers) => set((state) => ({
    servers: Object.fromEntries(Object.entries(servers).map(([name, status]) => {
      const current = state.servers[name];
      return [name, current !== undefined && statusTimestamp(current) > statusTimestamp(status)
        ? current
        : status];
    })),
  })),
  updateServer: (name, status) =>
    set((state) => ({ servers: { ...state.servers, [name]: status } })),
  clear: () => set({ servers: {} }),
}));

function statusTimestamp(status: McpServerStatus): number {
  switch (status.state) {
    case "disabled": return status.updatedAt;
    case "connecting": return status.startedAt;
    case "ready": return status.connectedAt;
    case "failed": return status.failedAt;
  }
}
