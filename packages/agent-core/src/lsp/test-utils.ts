// ─── Test-only exports for LSP testing ───
// Intentionally NOT exported from lsp/index.ts to maintain production barrel boundary.

import { LspClient } from "./client";
import { setLspClientPoolForTest, type LspClientPool, type PoolKey } from "./client-pool";
import { FakeLspServer } from "./fake-server";
import type { StdioLspTransportOptions } from "./transport";

export { FakeLspServer } from "./fake-server";
export type { FakeLspServerConfig } from "./fake-server";
export { DEFAULT_INITIALIZE_RESULT } from "./fake-server";

export async function installFakeLspServerPool(
  server: FakeLspServer,
  workspaceRoot: string,
): Promise<RecordingLspClientPool> {
  const transport = await server.start();
  const client = new LspClient({ transport, workspaceRoot });
  await client.initialize(workspaceRoot);
  const pool = new RecordingLspClientPool(client);
  setLspClientPoolForTest(pool as unknown as LspClientPool);
  return pool;
}

export class RecordingLspClientPool {
  readonly acquireOptions: StdioLspTransportOptions[] = [];
  readonly releaseKeys: PoolKey[] = [];

  constructor(private readonly client: LspClient) {}

  async acquire(_key: PoolKey, serverOptions: StdioLspTransportOptions): Promise<LspClient> {
    this.acquireOptions.push(serverOptions);
    return this.client;
  }

  release(key: PoolKey): void {
    this.releaseKeys.push(key);
  }
}
