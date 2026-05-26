// ─── Test-only exports for LSP testing ───
// Intentionally NOT exported from lsp/index.ts to maintain production barrel boundary.

export { FakeLspServer } from "./fake-server";
export type { FakeLspServerConfig } from "./fake-server";
export { DEFAULT_INITIALIZE_RESULT } from "./fake-server";
