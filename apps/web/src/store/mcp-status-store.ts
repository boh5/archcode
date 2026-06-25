import { create } from "zustand";
import type { McpServerStatus } from "@archcode/protocol";

export type McpServerStatusMap = Record<string, McpServerStatus>;

interface McpStatusState {
  servers: McpServerStatusMap;
  setServers: (servers: McpServerStatusMap) => void;
  updateServer: (name: string, status: McpServerStatus) => void;
  clear: () => void;
}

export const useMcpStatusStore = create<McpStatusState>((set) => ({
  servers: {},
  setServers: (servers) => set({ servers }),
  updateServer: (name, status) =>
    set((state) => ({ servers: { ...state.servers, [name]: status } })),
  clear: () => set({ servers: {} }),
}));