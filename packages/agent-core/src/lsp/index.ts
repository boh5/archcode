// ─── Types ───
export type {
  LspDiagnosticSeverity,
  LspDiagnostic,
  LspLocation,
  LspSymbol,
  LspDiagnosticsInput,
  LspGotoDefinitionInput,
  LspFindReferencesInput,
  LspSymbolsInput,
} from "./types";
export {
  LspDiagnosticsInputSchema,
  LspGotoDefinitionInputSchema,
  LspFindReferencesInputSchema,
  LspSymbolsInputSchema,
} from "./types";

// ─── Transport ───
export type {
  LspTransport,
  RALReadable,
  RALWritable,
  LspTransportTimeouts,
  StdioLspTransportOptions,
  LspTransportFactory,
} from "./transport";
export {
  DEFAULT_LSP_TRANSPORT_TIMEOUTS,
  setLspTransportForTest,
  createLspTransport,
  adaptReader,
  adaptWriter,
  StdioLspTransport,
} from "./transport";

// ─── Client ───
export type {
  LspClientOptions,
  LspClientTimeouts,
  LspClientFactory,
  LspInitializeOptions,
  OpenTextDocumentOptions,
  TextDocumentHandle,
  DiagnosticsSnapshot,
} from "./client";
export {
  DEFAULT_LSP_CLIENT_TIMEOUTS,
  CONTENT_MODIFIED_CODE,
  LspError,
  setLspClientForTest,
  createLspClient,
  LspClient,
} from "./client";

// ─── Client Pool ───
export type {
  PoolKey,
  LspClientPoolOptions,
  PoolEntry,
  TimerFns,
  LspClientPoolAcquireOptions,
} from "./client-pool";
export {
  setTimerFnsForTest,
  setLspClientPoolForTest,
  getLspClientPool,
  createLspClientPool,
  LspClientPool,
  configureDefaultLspClientPoolLogger,
} from "./client-pool";

// ─── Server Definitions ───
export type { LspServerDefinition } from "./server-definitions";
export {
  BUILTIN_SERVER_DEFINITIONS,
  getServerDefinitionById,
  getServerDefinitionsForLanguage,
} from "./server-definitions";

// ─── Language Mapping ───
export {
  getLanguageIdFromExtension,
  getLanguageIdFromFilename,
  EXTENSION_TO_LANGUAGE_ID,
} from "./language-mapping";

// ─── URI Utils ───
export {
  pathToFileUri,
  fileUriToPath,
  normalizeFilePath,
} from "./uri-utils";

// ─── Installer ───
export type { ExecCommandResult, ExecCommand, ExecCommandOptions } from "./installer";
export { LspInstallerError, setInstallerProcessRunnerForTest, resolveServerBinary } from "./installer";
